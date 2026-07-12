// Shop Bot — handler completo (UI minimalista)
import {
  sendMessage,
  sendPhotoMultipart,
  sendDocumentMultipart,
  getFile,
  downloadFile,
  answerCallbackQuery,
  editMessageText,
  getAdminChatId,
  tg,
} from "./api.server";

import {
  type BotUser,
  getOrCreateUser,
  updateUser,
  getState,
  setState,
  patchContext,
  checkRateLimit,
  isBlocked,
  autoBlock,
  getActiveMessage,
  setActiveMessage,
  sb,
} from "./db.server";
import { silentDelete } from "./ui.server";
import { applyRankDiscount, nextRankProgress, rankLabel, rankBadge, RANK_INFO, normalizeRank } from "./ranks.server";
import { keepTelegramPromiseAlive } from "./webhook-runner.server";

const forceNewScreenFor = new Set<number>();
const activeMessageHints = new Map<number, { chat_id: number; message_id: number }>();
const blockCache = new Map<number, { value: boolean; expiresAt: number }>();

async function isBlockedFast(telegram_id: number): Promise<boolean> {
  const cached = blockCache.get(telegram_id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await isBlocked(telegram_id);
  blockCache.set(telegram_id, { value, expiresAt: Date.now() + 15_000 });
  return value;
}

/**
 * Pantalla de navegación: edita el mensaje activo del usuario si existe
 * (evita amontonar mensajes mientras navega dentro de un mismo flujo).
 * Si no hay mensaje activo o la edición falla, envía uno nuevo.
 *
 * `final: true` => el mensaje queda en el historial y NO será editado
 * por la próxima pantalla (p. ej. entrega de keys, confirmaciones).
 */
async function screen(
  telegram_id: number,
  chat_id: number,
  text: string,
  keyboard?: Array<Array<{ text: string; callback_data?: string; copy_text?: { text: string }; switch_inline_query?: string }>>,
  opts?: { final?: boolean },
) {
  const reply_markup = keyboard ? { inline_keyboard: keyboard } : undefined;
  const hinted = activeMessageHints.get(telegram_id) ?? null;
  const active = forceNewScreenFor.has(telegram_id)
    ? null
    : hinted ?? (await getActiveMessage(telegram_id));
  if (active && active.chat_id === chat_id && active.message_id > 0 && !opts?.final) {
    const edited = await editMessageText("shop", chat_id, active.message_id, text, { reply_markup });
    if (edited.ok) {
      setActiveMessage(telegram_id, chat_id, active.message_id).catch(() => {});
      return active.message_id;
    }
  }
  const sent = await sendMessage("shop", chat_id, text, { reply_markup });
  if (sent.ok && sent.result) {
    if (opts?.final) {
      // Limpiamos el mensaje activo para que el próximo flujo abra uno nuevo
      // y este quede preservado en el historial del chat.
      activeMessageHints.set(telegram_id, { chat_id, message_id: 0 });
      setActiveMessage(telegram_id, chat_id, 0).catch(() => {});
    } else {
      activeMessageHints.set(telegram_id, { chat_id, message_id: sent.result.message_id });
      setActiveMessage(telegram_id, chat_id, sent.result.message_id).catch(() => {});
    }
    return sent.result.message_id;
  }
  return null;
}
import { getVisibleCatalog, invalidateCatalogCache } from "./catalog.server";

// Mínimo de recarga: se lee desde telegram_bot_settings.min_recharge_usd con
// caché de 30s para no consultar la DB en cada interacción.
let _minRechargeCache: { value: number; at: number } | null = null;
async function getMinRecharge(): Promise<number> {
  const now = Date.now();
  if (_minRechargeCache && now - _minRechargeCache.at < 30_000) return _minRechargeCache.value;
  const { data } = await sb
    .from("telegram_bot_settings")
    .select("min_recharge_usd")
    .eq("singleton", true)
    .maybeSingle();
  const n = Number((data as { min_recharge_usd?: number } | null)?.min_recharge_usd ?? 4);
  const value = Number.isFinite(n) && n > 0 ? n : 4;
  _minRechargeCache = { value, at: now };
  return value;
}
export function invalidateMinRechargeCache() {
  _minRechargeCache = null;
}
function tpId(createdAt: string | Date) {
  const t = typeof createdAt === "string" ? new Date(createdAt).getTime() : createdAt.getTime();
  return `TP${t}`;
}

// ===== Precios personalizados por usuario =====
async function getUserPriceOverrides(telegram_id: number): Promise<Map<string, number>> {
  const { data } = await sb
    .from("user_price_overrides")
    .select("price_id, price_usd")
    .eq("telegram_id", telegram_id);
  const m = new Map<string, number>();
  for (const r of data ?? []) m.set(r.price_id as string, Number(r.price_usd));
  return m;
}

async function getUserRank(telegram_id: number): Promise<string> {
  const { data } = await sb
    .from("bot_users")
    .select("rank")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  return (data?.rank as string) ?? "gold";
}

async function getUserPriceForId(telegram_id: number, price_id: string, fallback: number): Promise<number> {
  const { data } = await sb
    .from("user_price_overrides")
    .select("price_usd")
    .eq("telegram_id", telegram_id)
    .eq("price_id", price_id)
    .maybeSingle();
  const base = data ? Number(data.price_usd) : fallback;
  // Aplicar descuento por rango sobre el precio base (u override)
  const rank = await getUserRank(telegram_id);
  return applyRankDiscount(base, normalizeRank(rank));
}




interface Update {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}
interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number };
  text?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
}
interface TgCallback {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: TgMessage;
  data?: string;
}

const RANK_LABEL: Record<string, string> = {
  gold: "🏆 Gold",
  platinum: "💠 Platinum",
  diamond: "💎 Diamond",
  elite: "👑 Elite",
  // legacy
  normal: "🏆 Gold",
  pro: "💠 Platinum",
  leyenda: "💎 Diamond",
};

const SUPPORT_USERNAME = "@ravevq";

function adminReceiptKeyboard(order_id: string, telegram_id: number) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Aceptar", callback_data: `adm:approve:${order_id}` },
        { text: "❌ Rechazar", callback_data: `adm:reject:${order_id}` },
      ],
      [{ text: "⛔ Bloquear", callback_data: `adm:block:${telegram_id}` }],
    ],
  };
}

function newestTelegramPhotoFileId(result?: { photo?: Array<{ file_id: string }> }) {
  return result?.photo?.[result.photo.length - 1]?.file_id ?? null;
}

function receiptFilename(filePath: string | undefined, fallback: string) {
  const clean = filePath?.split("/").pop()?.trim();
  return clean || fallback;
}

// Menú inferior fijo (ReplyKeyboardMarkup) — siempre visible
const BOTTOM_MENU = {
  products: "🛒 Productos",
  recharge: "💰 Recargar Saldo",
  buy: "💳 Comprar",
  profile: "👤 Mi Perfil",
  more: "📋 Todo",
  // Opciones extras (solo accesibles vía "Todo" como inline buttons)
  status: "📦 Estado",
  keys: "🔑 Mis Keys",
  announcements: "Anuncios",
  share: "Compartir Bot",
  support: "💬 Soporte",
  download_panel: "📥 Descargar Panel",
};

const BOTTOM_MENU_ALIASES: Record<string, keyof typeof BOTTOM_MENU> = {
  "🛒 Productos": "products",
  "💰 Recargar": "recharge",
  "💰 Recargar saldo": "recharge",
  "💰 Recargar Saldo": "recharge",
  "💳 Comprar": "buy",
  "🛍 Comprar": "buy",
  "🛒 Comprar": "buy",
  "👤 Cuenta": "profile",
  "👤 Perfil": "profile",
  "👤 Mi perfil": "profile",
  "👤 Mi Perfil": "profile",
  "📋 Todo": "more",
  "📋 Más": "more",
};

const DOWNLOAD_PANEL_URL = "https://keymarkethnx7.vercel.app/";

function isBottomMenuText(text: string) {
  return text in BOTTOM_MENU_ALIASES || Object.values(BOTTOM_MENU).includes(text as (typeof BOTTOM_MENU)[keyof typeof BOTTOM_MENU]);
}

function bottomKeyboard() {
  return {
    keyboard: [
      [{ text: BOTTOM_MENU.products }, { text: BOTTOM_MENU.recharge }],
      [{ text: BOTTOM_MENU.buy }, { text: BOTTOM_MENU.profile }],
      [{ text: BOTTOM_MENU.more }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

async function showMoreOptions(_telegram_id: number, chat_id: number) {
  await sendMessage("shop", chat_id, `📋 <b>Más opciones</b>`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: BOTTOM_MENU.status, callback_data: "more:status" },
          { text: BOTTOM_MENU.keys, callback_data: "more:keys" },
        ],
        [
          { text: BOTTOM_MENU.announcements, callback_data: "more:ann" },
          { text: BOTTOM_MENU.share, callback_data: "more:share" },
        ],
        [
          { text: BOTTOM_MENU.support, callback_data: "more:support" },
          { text: BOTTOM_MENU.download_panel, callback_data: "more:panel" },
        ],
      ],
    },
  });
}

const BACK_BUTTON = [{ text: "↩️ Volver", callback_data: "menu:main" }];

// Cache del username del bot para los links de referidos
let _shopBotUsername: string | null = null;
async function getShopBotUsername(): Promise<string | null> {
  if (_shopBotUsername) return _shopBotUsername;
  const env = process.env.TELEGRAM_SHOP_BOT_USERNAME;
  if (env) {
    _shopBotUsername = env.replace(/^@/, "");
    return _shopBotUsername;
  }
  const res = await tg<{ username: string }>("shop", "getMe");
  if (res.ok && res.result?.username) {
    _shopBotUsername = res.result.username;
    return _shopBotUsername;
  }
  return null;
}

const REFERRAL_GOAL = 30;
const REFERRAL_DISCOUNT_USD = 1;

async function showMainMenu(telegram_id: number, chat_id: number) {
  await setState(telegram_id, "menu", {});
  // El próximo flujo debe abrir un mensaje NUEVO (no editar uno viejo).
  await setActiveMessage(telegram_id, chat_id, 0);
  // Reenviamos la barra inferior (ReplyKeyboard persistente). Es la única
  // forma de garantizar que el teclado esté visible tras el /start.
  await sendMessage(
    "shop",
    chat_id,
    `🏠 <b>Inicio</b>`,
    { reply_markup: bottomKeyboard() },
  );
}

async function deliverBottomKeyboard(chat_id: number, text: string) {
  await sendMessage("shop", chat_id, text, { reply_markup: bottomKeyboard() });
}

// Notificación con botón inline "🏠 Menú Principal" para que el usuario
// siempre tenga forma de volver al inicio desde cualquier mensaje del bot.
async function notifyUser(chat_id: number, text: string) {
  await sendMessage("shop", chat_id, text, {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Menú Principal", callback_data: "menu:main" }]],
    },
  });
}

async function showShareBot(telegram_id: number, chat_id: number) {
  const username = await getShopBotUsername();
  if (!username) {
    await screen(telegram_id, chat_id, `No se pudo generar el link. Intentá más tarde.`, [BACK_BUTTON]);
    return;
  }
  const { data: u } = await sb
    .from("bot_users")
    .select("shares_count")
    .eq("telegram_id", telegram_id)
    .single();
  const shares = Number(u?.shares_count ?? 0);
  const link = `https://t.me/${username}?start=ref${telegram_id}`;
  const remaining = Math.max(0, REFERRAL_GOAL - shares);
  const status =
    shares >= REFERRAL_GOAL
      ? `<b>Descuento activo:</b> $${REFERRAL_DISCOUNT_USD.toFixed(2)} USD menos por cada key.`
      : `Te faltan <b>${remaining}</b> invitados para activar <b>$${REFERRAL_DISCOUNT_USD.toFixed(2)} USD</b> de descuento por cada key.`;
  const text =
    `<b>Compartir Bot</b>\n\n` +
    `Tu link personal:\n<code>${link}</code>\n\n` +
    `Invitados: <b>${shares}</b> / ${REFERRAL_GOAL}\n` +
    `${status}`;
  await screen(telegram_id, chat_id, text, [
    [{ text: "Copiar link", copy_text: { text: link } } as any, { text: "Compartir ahora", switch_inline_query: `Probá este bot ${link}` } as any],
    [{ text: "Mostrar link", callback_data: `shlink:${telegram_id}` }],
    BACK_BUTTON,
  ]);
}

async function showSupport(telegram_id: number, chat_id: number) {
  await screen(
    telegram_id,
    chat_id,
    `💬 <b>Soporte</b>\n\nEscribinos por Telegram a <b>${SUPPORT_USERNAME}</b>.\nTe respondemos a la brevedad.`,
    [BACK_BUTTON],
  );
}

function categoryButtons(grouped: Awaited<ReturnType<typeof getVisibleCatalog>>["grouped"]) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const section of grouped) {
    rows.push([{ text: section.category, callback_data: `cat:${section.category}` }]);
  }
  return rows;
}

async function showBuyWithBalance(telegram_id: number, chat_id: number) {
  await showProducts(telegram_id, chat_id);
}

async function showProfile(telegram_id: number, chat_id: number) {
  const { data: u } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .single();
  if (!u) return;
  const rank = normalizeRank(u.rank);
  const info = RANK_INFO[rank];
  const total = Number(u.total_recharged);
  const balance = Number(u.balance);
  const progress = nextRankProgress(total);
  const fmtDate = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleDateString("es", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

  const benefitBlock =
    rank === "elite"
      ? `\n🎁 <b>Beneficio Elite</b>\nProductos de $30.00 → <b>$25.00 USD</b>\n`
      : info.discountPct > 0
        ? `\n🎁 <b>Beneficio ${info.label}</b>\nDescuento automático del <b>${info.discountPct}%</b> en todas las compras\n`
        : `\n🎁 <b>Beneficio</b>\nSin descuento activo (rango inicial)\n`;

  const progressBlock = progress
    ? `\n🚀 <b>Próximo Rango:</b> ${RANK_INFO[progress.next].badge} ${RANK_INFO[progress.next].label}\n💵 <b>Monto Restante:</b> $${progress.missing.toFixed(2)} USD`
    : `\n🏅 <i>Has alcanzado el rango máximo</i>`;

  const text =
    `👤 <b>Mi Perfil</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🪪 <b>Nombre:</b> ${u.display_name ?? "—"}\n` +
    `💬 <b>Usuario:</b> @${u.username ?? "—"}\n` +
    `🆔 <b>ID:</b> <code>${u.telegram_id}</code>\n\n` +
    `💼 <b>Saldo Actual:</b> $${balance.toFixed(2)} USD\n` +
    `🛍 <b>Total Comprado:</b> $${total.toFixed(2)} USD\n` +
    `📅 <b>Fecha de Registro:</b> ${fmtDate(u.registered_at)}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `${info.badge} <b>Rango Actual:</b> ${info.label}\n` +
    `📆 <b>Activo Desde:</b> ${fmtDate(u.rank_assigned_at)}\n` +
    benefitBlock +
    progressBlock;

  await screen(telegram_id, chat_id, text, [BACK_BUTTON]);
}

async function showProducts(telegram_id: number, chat_id: number) {
  const { grouped } = await getVisibleCatalog();
  if (grouped.length === 0) {
    await screen(telegram_id, chat_id, `No hay productos disponibles.`, [BACK_BUTTON]);
    return;
  }
  await setState(telegram_id, "choose_category", {});
  await screen(
    telegram_id,
    chat_id,
    `🛒 <b>Productos</b>\n\nElegí una categoría:`,
    [...categoryButtons(grouped), BACK_BUTTON],
  );
}

async function showCategory(telegram_id: number, chat_id: number, category: string) {
  const { grouped } = await getVisibleCatalog();
  const section = grouped.find((s) => s.category.toLowerCase() === category.toLowerCase());
  if (!section || section.products.length === 0) {
    await screen(
    telegram_id,
      chat_id,
      `No hay productos disponibles en ${category}.`,
      [[{ text: "Volver", callback_data: "menu:products" }]],
    );
    return;
  }
  await setState(telegram_id, "choose_product", { category: section.category });
  const rows = section.products.map((p) => [
    { text: p.name, callback_data: `prod:${p.id}` },
  ]);
  rows.push([{ text: "Volver", callback_data: "menu:products" }]);
  await screen(
    telegram_id,
    chat_id,
    `<b>${category}</b>\n\nElegí un producto:`,
    rows,
  );
}

async function showDurations(telegram_id: number, chat_id: number, product_id: string) {
  const [{ data: u }, catalog, overrides] = await Promise.all([
    sb.from("bot_users").select("balance, rank").eq("telegram_id", telegram_id).single(),
    getVisibleCatalog(),
    getUserPriceOverrides(telegram_id),
  ]);
  const balance = Number(u?.balance ?? 0);
  const product = catalog.grouped.flatMap((s) => s.products).find((p) => p.id === product_id);
  if (!product) {
    await screen(telegram_id, chat_id, `Producto no disponible.`, [
      [{ text: "Volver", callback_data: "menu:products" }],
    ]);
    return;
  }
  const rawPrices = product.prices ?? [];
  if (rawPrices.length === 0) {
    await screen(telegram_id, chat_id, `Sin duraciones disponibles.`, [
      [{ text: "Volver", callback_data: "menu:products" }],
    ]);
    return;
  }
  // Aplicar precios personalizados por usuario (si existen) + descuento por rango
  const rank = normalizeRank((u as { rank?: string } | null)?.rank ?? "gold");
  const prices = rawPrices.map((p) => {
    const base = overrides.has(p.id) ? overrides.get(p.id)! : Number(p.price_usd);
    const price_usd = applyRankDiscount(base, rank);
    return { ...p, price_usd, has_override: overrides.has(p.id), rank_discounted: price_usd < base };
  });
  // Mostramos SIEMPRE los precios. Aunque no tenga saldo, puede elegir país
  // y pagar por un método externo; si tiene saldo también verá pago con saldo.
  const minPrice = Math.min(...prices.map((p) => Number(p.price_usd)));
  const lowBalance = balance < minPrice;

  await patchContext(telegram_id, { product_id });
  const rows = prices.map((p) => {
    const tag = p.has_override ? "  🎁" : p.rank_discounted ? `  ${RANK_INFO[rank].badge}` : "";
    const stockLabel = p.available_stock > 0 ? `📦 ${p.available_stock}` : `❌ Agotado`;
    return [
      {
        text: `⏳ ${p.duration_label}  ·  $${Number(p.price_usd).toFixed(2)}  ·  ${stockLabel}${tag}`,
        callback_data: `dur:${p.id}`,
      },
    ];
  });

  if (lowBalance) {
    rows.push([{ text: "💰 Recargar", callback_data: "menu:recharge" }]);
  }
  rows.push([{ text: "Volver", callback_data: `cat:${product.category}` }]);

  const rankNote = rank === "gold" ? "" : `\n<i>${RANK_INFO[rank].badge} ${RANK_INFO[rank].label}${rank === "elite" ? " — productos de $30 a $25" : ` · -${RANK_INFO[rank].discountPct}% aplicado`}</i>`;

  const stockLines = prices
    .map((p) => `⏳ ${p.duration_label}   ${p.available_stock > 0 ? `📦 Stock: ${p.available_stock}` : `❌ Sin stock`}`)
    .join("\n");
  const stockBlock = `\n\n<b>Disponibilidad</b>\n${stockLines}\n\n<i>Si un producto está agotado, podés pedirlo en modo manual y un admin te enviará la key.</i>`;

  const header = lowBalance
    ? `<b>${product.name}</b>\n\n💸 <b>Saldo insuficiente</b>\nSaldo actual: <b>$${balance.toFixed(2)} USD</b>\nMínimo requerido: <b>$${minPrice.toFixed(2)} USD</b>${rankNote}${stockBlock}\n\nPodés ver los precios. Recargá saldo para comprar:`
    : `<b>${product.name}</b>${rankNote}\n\nSaldo disponible: <b>$${balance.toFixed(2)} USD</b>${stockBlock}\n\nElegí la duración:`;

  await screen(telegram_id, chat_id, header, rows);
}

async function showQty(telegram_id: number, chat_id: number, price_id: string) {
  await patchContext(telegram_id, { price_id });
  await screen(
    telegram_id,
    chat_id,
    `🔢 <b>Cantidad de keys</b>\n\n¿Cuántas necesitás?`,
    [
      [
        { text: "1", callback_data: "qty:1" },
        { text: "2", callback_data: "qty:2" },
        { text: "5", callback_data: "qty:5" },
      ],
      [{ text: "Volver", callback_data: "menu:products" }],
    ],
  );
}

async function showCountries(telegram_id: number, chat_id: number, qty: number) {
  await patchContext(telegram_id, { qty });
  const ctx = (await getState(telegram_id))?.context as Record<string, string | number>;
  const [{ data: price }, { data: u }] = await Promise.all([
    sb.from("product_prices").select("*").eq("id", ctx.price_id as string).single(),
    sb.from("bot_users").select("balance").eq("telegram_id", telegram_id).single(),
  ]);
  if (!price) return;
  const unit_usd = await getUserPriceForId(telegram_id, ctx.price_id as string, Number(price.price_usd));
  const total_usd = unit_usd * qty;
  const balance = Number(u?.balance ?? 0);

  // Saldo insuficiente → mensaje simple, sin lista de métodos ni notas de stock.
  if (balance < total_usd) {
    await screen(
      telegram_id,
      chat_id,
      `💸 <b>Tu saldo es insuficiente.</b>\n\nRecarga saldo para poder realizar la compra.`,
      [
        [{ text: "💰 Recargar Saldo", callback_data: "menu:recharge" }],
        BACK_BUTTON,
      ],
    );
    return;
  }

  // Con saldo suficiente: pago directo con saldo (sin mostrar el stock).
  await screen(
    telegram_id,
    chat_id,
    `💳 <b>Confirmar compra</b>\n\nTotal  <b>$${total_usd.toFixed(2)} USD</b>\nSaldo  $${balance.toFixed(2)}`,
    [
      [{ text: `✅ Pagar con saldo  ·  $${total_usd.toFixed(2)}`, callback_data: "pay:balance" }],
      [{ text: "Volver", callback_data: "menu:products" }],
    ],
  );
}

async function showPaymentInstructions(
  telegram_id: number,
  chat_id: number,
  payment_method_id: string,
) {
  const ctx = (await getState(telegram_id))?.context as Record<string, string | number>;
  const [{ data: pm }, { data: price }] = await Promise.all([
    sb.from("payment_methods").select("*").eq("id", payment_method_id).single(),
    sb.from("product_prices").select("*, products(name)").eq("id", ctx.price_id as string).single(),
  ]);
  if (!pm || !price) return;
  const qty = Number(ctx.qty ?? 1);
  const unit_usd = await getUserPriceForId(telegram_id, ctx.price_id as string, Number(price.price_usd));
  const total_usd = unit_usd * qty;

  const total_local = total_usd * Number(pm.usd_rate);
  const { count: availableCount } = await sb
    .from("product_stock_keys")
    .select("id", { count: "exact", head: true })
    .eq("product_id", ctx.product_id as string)
    .eq("price_id", ctx.price_id as string)
    .eq("used", false);
  const manualNote =
    (availableCount ?? 0) < qty
      ? `\n<i>Sin stock automático. La key será entregada manualmente por el admin.</i>`
      : "";

  const { data: user } = await sb
    .from("bot_users")
    .select("id")
    .eq("telegram_id", telegram_id)
    .single();
  const { count: activeOrders } = await sb
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user!.id)
    .in("status", ["pending_receipt", "pending_approval"]);
  if ((activeOrders ?? 0) >= 3) {
    await screen(
    telegram_id,
      chat_id,
      `Ya tenés <b>3 órdenes activas</b>. Esperá que alguna sea aprobada para crear otra.`,
      [BACK_BUTTON],
    );
    return;
  }

  const { data: order, error } = await sb
    .from("orders")
    .insert({
      user_id: user!.id,
      telegram_id,
      product_id: ctx.product_id as string,
      price_id: ctx.price_id as string,
      payment_method_id: pm.id,
      keys_qty: qty,
      total_usd,
      total_local,
      currency: pm.currency,
      status: "pending_receipt",
    })
    .select()
    .single();
  if (error || !order) {
    console.error("Error creando orden:", error);
    return;
  }

  await setState(telegram_id, "awaiting_receipt", { order_id: order.id });

  const text =
    `📋 <b>Instrucciones de pago</b>\n\n` +
    `Producto   <b>${(price as { products: { name: string } }).products.name}</b>\n` +
    `Duración   ${price.duration_label}\n` +
    `Cantidad   ${qty}\n` +
    `Total      <b>$${total_usd.toFixed(2)} USD</b>\n` +
    `Local      ${total_local.toFixed(2)} ${pm.currency} <i>(referencial)</i>\n\n` +
    `<b>${pm.country_name}  ·  ${pm.method_name}</b>\n` +
    `Titular  <code>${pm.holder_name}</code>\n` +
    `Cuenta   ${pm.account_info}\n` +
    `${pm.extra_info ? `Nota     ${pm.extra_info}\n` : ""}` +
    `${manualNote}\n` +
    `\nEnviá la foto del comprobante a este chat.\n` +
    `<i>Solo fotos. Imágenes duplicadas serán rechazadas.</i>`;
  await screen(telegram_id, chat_id, text, [
    [{ text: "✖️ Cancelar", callback_data: "menu:main" }],
  ]);
}

// ===== Recarga: país → monto → método → instrucciones =====
async function startRecharge(telegram_id: number, chat_id: number) {
  await setState(telegram_id, "recharge_country", {});
  const { data: methods } = await sb
    .from("payment_methods")
    .select("country_code, country_name")
    .eq("active", true)
    .order("country_name");
  const seen = new Set<string>();
  const countries: Array<{ country_code: string; country_name: string }> = [];
  for (const m of methods ?? []) {
    if (!seen.has(m.country_code)) {
      seen.add(m.country_code);
      countries.push(m);
    }
  }
  if (countries.length === 0) {
    await screen(telegram_id, chat_id, `No hay métodos de pago disponibles.`, [BACK_BUTTON]);
    return;
  }
  const kb: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < countries.length; i += 2) {
    const row = [{ text: countries[i].country_name, callback_data: `rcc:${countries[i].country_code}` }];
    if (countries[i + 1]) row.push({ text: countries[i + 1].country_name, callback_data: `rcc:${countries[i + 1].country_code}` });
    kb.push(row);
  }
  kb.push(BACK_BUTTON);
  await screen(
    telegram_id,
    chat_id,
    `💰 <b>Recargar Saldo</b>\n\nElegí tu país:`,
    kb,
  );
}

const COUNTRY_NAMES: Record<string, string> = {
  NI: "Nicaragua", HN: "Honduras", SV: "El Salvador", GT: "Guatemala",
  CR: "Costa Rica", PA: "Panamá", MX: "México", CO: "Colombia",
  VE: "Venezuela", PE: "Perú", AR: "Argentina", CL: "Chile",
  EC: "Ecuador", BO: "Bolivia", PY: "Paraguay", UY: "Uruguay",
  DO: "República Dominicana", CU: "Cuba", US: "Estados Unidos", ES: "España",
};

async function askRechargeAmount(telegram_id: number, chat_id: number, country_code: string) {
  const cc = country_code.toUpperCase();
  const countryName = COUNTRY_NAMES[cc] ?? cc;
  // Este estado es crítico para la siguiente respuesta del usuario; debe quedar
  // persistido antes de devolver 200 al webhook.
  await setState(telegram_id, "recharge_amount", { country_code: cc });
  const min = await getMinRecharge();
  await screen(
    telegram_id,
    chat_id,
    `💰 <b>Recargar Saldo Desde ${countryName}</b>\n\n` +
      `Recarga Mínima: <b>${min.toFixed(2)} USD</b>\n\n` +
      `¿Cuánto deseas recargar?\n\n` +
      `Ejemplo:\n<code>10</code>\n\n` +
      `Escribí el monto en USD.`,
    [[{ text: "Volver", callback_data: "menu:recharge" }]],
  );
}

// Reemplaza los valores dinámicos de la plantilla pegada por el admin
// manteniendo intactos banco, titular, alias, notas, emojis y estructura.
// Sólo tocamos las líneas cuyo prefijo identifica un valor variable.
function renderPaymentTemplate(
  raw: string,
  method: { country_name: string; currency: string; usd_rate: number | string; method_name?: string | null },
  dyn: {
    countryName: string;
    flag: string;
    rechargeId: string;
    amountUsd: number;
    localTotal: number;
    currency: string;
    fmtLocal: (n: number) => string;
  },
): string {
  const usdStr = `${dyn.amountUsd.toFixed(2)} USD`;
  const methodLocal = dyn.amountUsd * Number(method.usd_rate || dyn.localTotal / dyn.amountUsd || 1);
  const methodLocalStr = `${dyn.fmtLocal(methodLocal)} ${method.currency || dyn.currency}`;
  const pagasStr = `${dyn.fmtLocal(dyn.localTotal)} ${dyn.currency}`;

  return raw
    .split(/\r?\n/)
    .map((line) => {
      // Header: "💳 ... Métodos De Pago ..."
      if (/💳[\s\S]*M[eé]todos\s*De\s*Pago/i.test(line)) {
        return `💳 <b>Métodos De Pago - ${dyn.countryName}</b> ${dyn.flag}`.trim();
      }
      // ID de recarga
      if (/^\s*🆔\s*Recarga/i.test(line)) {
        return `🆔 Recarga: <code>${dyn.rechargeId}</code>`;
      }
      // Monto USD ingresado por el usuario
      if (/^\s*💰\s*Monto/i.test(line)) {
        return `💰 Monto: <b>${usdStr}</b>`;
      }
      // Conversión "Pagas" (usa la tasa del método principal del país)
      if (/^\s*🧾\s*Pagas/i.test(line)) {
        return `🧾 Pagas: <b>${pagasStr}</b>`;
      }
      // Total por método (usa la tasa del método específico)
      if (/^\s*💵\s*Total/i.test(line)) {
        return `💵 Total: <b>${methodLocalStr}</b>`;
      }
      return line;
    })
    .join("\n");
}


async function showRechargeMethods(
  telegram_id: number,
  chat_id: number,
  country_code: string,
  amount: number,
) {
  const { data: methods } = await sb
    .from("payment_methods")
    .select("*")
    .eq("country_code", country_code)
    .eq("active", true)
    .order("sort_order");
  if (!methods || methods.length === 0) {
    await screen(telegram_id, chat_id, `No hay métodos disponibles para este país.`, [BACK_BUTTON]);
    return;
  }
  const { data: user } = await sb.from("bot_users").select("id").eq("telegram_id", telegram_id).single();
  if (!user) return;

  // Crear orden de recarga única
  const { data: order, error } = await sb
    .from("orders")
    .insert({
      user_id: user.id,
      telegram_id,
      order_type: "recharge",
      payment_method_id: methods[0].id,
      keys_qty: 0,
      total_usd: amount,
      currency: methods[0].currency,
      status: "pending_receipt",
    })
    .select()
    .single();
  if (error || !order) {
    console.error("Error creando recarga:", error);
    return;
  }

  await setState(telegram_id, "recharge_ready", { order_id: order.id, country_code, amount });

  const pid = tpId(order.created_at);
  const flag = countryFlag(country_code);
  const localTotal = amount * Number(methods[0].usd_rate);
  const currency = methods[0].currency;
  const fmtLocal = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const dyn = {
    countryName: methods[0].country_name,
    flag,
    rechargeId: pid,
    amountUsd: amount,
    localTotal,
    currency,
    fmtLocal,
  };

  const lines: string[] = [];
  let anyTemplate = false;
  for (const m of methods) {
    const raw = (m as { body_raw?: string | null }).body_raw;
    if (raw && raw.trim().length > 0) {
      // El admin pegó una plantilla. Reemplazamos los valores dinámicos
      // (país, ID de recarga, monto USD, conversión local y total) pero
      // mantenemos exactamente la estructura, banco, titular, alias, etc.
      lines.push(renderPaymentTemplate(raw, m, dyn));
      anyTemplate = true;
    } else {
      const local = amount * Number(m.usd_rate);
      lines.push(`🏦 <b>${m.method_name}</b>`);
      if (m.holder_name) lines.push(`🪪 Nombre: <code>${m.holder_name}</code>`);
      if (m.account_info) lines.push(`📋 Número: <code>${m.account_info}</code>`);
      if (m.extra_info) lines.push(`📝 Nota: ${m.extra_info}`);
      lines.push(`💵 Total: <b>${fmtLocal(local)} ${m.currency}</b>`);
    }
    lines.push(``);
  }

  // Si NO hay plantilla, prepend el header dinámico. Si sí hay plantilla,
  // la plantilla ya contiene su propio header — evitamos duplicarlo.
  if (!anyTemplate) {
    lines.unshift(
      `💳 <b>Métodos De Pago - ${methods[0].country_name}</b> ${flag}`,
      ``,
      `🆔 Recarga: <code>${pid}</code>`,
      `💰 Monto: <b>${amount.toFixed(2)} USD</b>`,
      `🧾 Pagas: <b>${fmtLocal(localTotal)} ${currency}</b>`,
      ``,
    );
  }


  await screen(telegram_id, chat_id, lines.join("\n"), [
    [{ text: "✅ Ya Pagué", callback_data: `rcpay:${order.id}` }],
    [{ text: "🏠 Menú Principal", callback_data: "menu:main" }],
  ]);
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return "";
  const cc = code.toUpperCase();
  const A = 0x1f1e6;
  return String.fromCodePoint(A + cc.charCodeAt(0) - 65, A + cc.charCodeAt(1) - 65);
}

async function startRechargeReceipt(telegram_id: number, chat_id: number, order_id: string) {
  await setState(telegram_id, "awaiting_recharge_receipt", { order_id });
  const { data: order } = await sb
    .from("orders")
    .select("created_at")
    .eq("id", order_id)
    .single();
  const pid = order ? tpId(order.created_at) : "";
  await screen(
    telegram_id,
    chat_id,
    `📸 <b>Envía El Comprobante De Pago</b>\n\n` +
      `🆔 Recarga: <code>${pid}</code>\n\n` +
      `⏳ Apenas Lo Envíes, Lo Revisaremos.`,
    [[{ text: "✖️ Cancelar", callback_data: "menu:main" }]],
  );
}


async function showDownloadPanel(telegram_id: number, chat_id: number) {
  forceNewScreenFor.add(telegram_id);
  try {
    await sendMessage(
      "shop",
      chat_id,
      `📥 <b>Descargar Panel</b>\n\nAccedé al panel desde el siguiente enlace:\n${DOWNLOAD_PANEL_URL}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📥 Abrir Panel", url: DOWNLOAD_PANEL_URL }],
            [{ text: "🏠 Menú Principal", callback_data: "menu:main" }],
          ],
        },
        disable_web_page_preview: false,
      },
    );
  } finally {
    forceNewScreenFor.delete(telegram_id);
  }
}

// Enrutado del menú inferior fijo. Devuelve true si manejó el texto.
async function routeBottomMenu(
  text: string,
  telegram_id: number,
  chat_id: number,
  message_id: number,
): Promise<boolean> {
  const map: Record<keyof typeof BOTTOM_MENU, (tid: number, cid: number) => Promise<unknown>> = {
    products: showProducts,
    recharge: startRecharge,
    buy: showBuyWithBalance,
    profile: showProfile,
    more: showMoreOptions,
    status: showOrderStatus,
    keys: showMyKeys,
    announcements: showAnnouncements,
    share: showShareBot,
    support: showSupport,
    download_panel: showDownloadPanel,
  };
  const key = BOTTOM_MENU_ALIASES[text] ?? (Object.entries(BOTTOM_MENU).find(([, label]) => label === text)?.[0] as keyof typeof BOTTOM_MENU | undefined);
  const action = key ? map[key] : undefined;
  if (!action) return false;
  // Forzar mensaje NUEVO debajo del tap del usuario (no editar arriba).
  forceNewScreenFor.add(telegram_id);
  try {
    await action(telegram_id, chat_id);
  } finally {
    forceNewScreenFor.delete(telegram_id);
  }
  return true;
}


// ===== Pago con saldo =====
// 1) Si hay stock automático: entrega inmediata (key eliminada del inventario).
// 2) Si NO hay stock: pide confirmación "Stock no disponible, pedir key manual?"
//    Aceptar → cobra saldo, crea orden pendiente y avisa al bot Almacén.
async function payWithBalance(telegram_id: number, chat_id: number) {
  const ctx = (await getState(telegram_id))?.context as Record<string, string | number>;
  const qty = Number(ctx.qty ?? 1);
  if (!ctx.price_id) {
    await screen(telegram_id, chat_id, `Esa compra expiró. Elegí el producto nuevamente.`, [BACK_BUTTON]);
    return;
  }
  if (qty !== 1) {
    await screen(telegram_id, chat_id, `Por estabilidad, comprá las keys de una en una.`, [BACK_BUTTON]);
    return;
  }

  // Precheck de stock: si no hay, ofrecemos entrega manual.
  const { count: stockCount } = await sb
    .from("product_stock_keys")
    .select("id", { count: "exact", head: true })
    .eq("price_id", ctx.price_id as string)
    .eq("used", false);
  if ((stockCount ?? 0) < 1) {
    await screen(
      telegram_id,
      chat_id,
      `⚠️ <b>Stock no disponible</b>\n\n¿Querés pedir la key en modo manual? Un administrador te la enviará apenas esté lista.`,
      [
        [{ text: "✅ Aceptar", callback_data: "manukey:accept" }],
        [{ text: "❌ Rechazar", callback_data: "menu:main" }],
      ],
    );
    return;
  }

  await deliverAutomaticKey(telegram_id, chat_id, ctx.price_id as string);
}

async function deliverAutomaticKey(telegram_id: number, chat_id: number, price_id: string) {
  const { data: result, error } = await sb.rpc("purchase_key_atomic", {
    _telegram_id: telegram_id,
    _price_id: price_id,
  });
  if (error) {
    console.error("[payWithBalance] atomic purchase", error);
    await screen(telegram_id, chat_id, `No se pudo completar la compra. Tocá de nuevo en unos segundos.`, [BACK_BUTTON]);
    return;
  }
  const purchase = result as {
    ok?: boolean;
    reason?: string;
    order_id?: string;
    key_value?: string;
    unit_usd?: number;
    new_balance?: number;
    product_name?: string;
    duration_label?: string;
  } | null;

  if (!purchase?.ok) {
    if (purchase?.reason === "out_of_stock") {
      // Cambió el stock entre el precheck y la RPC: reintentar en modo manual.
      await confirmManualPurchase(telegram_id, chat_id, price_id);
      return;
    }
    const text = purchase?.reason === "insufficient_balance"
      ? `💸 Tu saldo es insuficiente. Recarga saldo para poder realizar la compra.`
      : `Producto no disponible. Elegí otro producto.`;
    await screen(telegram_id, chat_id, text, [BACK_BUTTON]);
    return;
  }

  invalidateCatalogCache();

  const productName = String(purchase.product_name ?? "Producto");
  const duration = String(purchase.duration_label ?? "");
  const total = Number(purchase.unit_usd ?? 0);
  const balanceLeft = Number(purchase.new_balance ?? 0);
  const orderId = String(purchase.order_id ?? "").replace(/-/g, "").slice(0, 13) || `${Date.now()}`;
  const keyVal = String(purchase.key_value ?? "");

  const text =
    `✅ <b>Compra Realizada</b>\n\n` +
    `📦 <b>Producto:</b> ${escapeHtml(productName)}\n` +
    `⏳ <b>Duración:</b> ${escapeHtml(duration)}\n` +
    `💵 <b>Total:</b> ${total.toFixed(2)} USD\n\n` +
    `🔑 <b>Tu Key</b>\n<code>${escapeHtml(keyVal)}</code>\n\n` +
    `🧾 <b>Orden:</b> ${escapeHtml(orderId)}\n` +
    `💼 <b>Saldo Disponible:</b> ${balanceLeft.toFixed(2)} USD\n\n` +
    `📂 <b>Descargar Archivo:</b> ${DOWNLOAD_PANEL_URL}\n\n` +
    `¡Gracias por tu compra! Disfruta tu producto.`;

  await screen(telegram_id, chat_id, text, [[{ text: "🏠 Menú", callback_data: "menu:main" }]], { final: true });
}

async function confirmManualPurchase(telegram_id: number, chat_id: number, price_id: string) {
  await patchContext(telegram_id, { price_id });
  await screen(
    telegram_id,
    chat_id,
    `⚠️ <b>Stock no disponible</b>\n\n¿Querés pedir la key en modo manual? Un administrador te la enviará apenas esté lista.`,
    [
      [{ text: "✅ Aceptar", callback_data: "manukey:accept" }],
      [{ text: "❌ Rechazar", callback_data: "menu:main" }],
    ],
  );
}

async function acceptManualKey(telegram_id: number, chat_id: number) {
  const ctx = (await getState(telegram_id))?.context as Record<string, string | number>;
  if (!ctx?.price_id) {
    await screen(telegram_id, chat_id, `Esa compra expiró. Elegí el producto nuevamente.`, [BACK_BUTTON]);
    return;
  }
  const { data: result, error } = await sb.rpc("purchase_manual_atomic", {
    _telegram_id: telegram_id,
    _price_id: ctx.price_id as string,
  });
  if (error) {
    console.error("[acceptManualKey] atomic", error);
    await screen(telegram_id, chat_id, `No se pudo completar la compra. Tocá de nuevo en unos segundos.`, [BACK_BUTTON]);
    return;
  }
  const purchase = result as {
    ok?: boolean; reason?: string; order_id?: string; unit_usd?: number;
    new_balance?: number; product_name?: string; duration_label?: string;
  } | null;

  if (!purchase?.ok) {
    const text = purchase?.reason === "insufficient_balance"
      ? `💸 Tu saldo es insuficiente. Recarga saldo para poder realizar la compra.`
      : `Producto no disponible. Elegí otro producto.`;
    await screen(telegram_id, chat_id, text, [BACK_BUTTON]);
    return;
  }

  // Notificamos al chat de almacén y al chat de admin para entrega manual.
  const { data: user } = await sb.from("bot_users").select("username, display_name").eq("telegram_id", telegram_id).single();
  const userTag = user?.username ? `@${user.username}` : (user?.display_name ?? "—");
  const productName = String(purchase.product_name ?? "Producto");
  const duration = String(purchase.duration_label ?? "");
  const total = Number(purchase.unit_usd ?? 0);
  const orderId = String(purchase.order_id ?? "");

  const notify =
    `🛠 <b>Entrega manual pendiente</b>\n\n` +
    `📦 ${escapeHtml(productName)}  ·  ${escapeHtml(duration)}\n` +
    `💵 ${total.toFixed(2)} USD (pagado con saldo)\n` +
    `👤 ${userTag} · <code>${telegram_id}</code>\n` +
    `🧾 Orden: <code>${orderId.slice(0, 8)}</code>`;
  const kb = { inline_keyboard: [[{ text: "🔑 Enviar key", callback_data: `alm:sendkey:${orderId}` }]] };

  // Los pedidos manuales de key SOLO deben llegar al Bot Almacén — nunca al Admin.
  const { getWarehouseChatId } = await import("./api.server");
  const wh = getWarehouseChatId();
  if (wh) {
    sendMessage("warehouse", wh, notify, { reply_markup: kb }).catch(() => {});
  }

  const balanceLeft = Number(purchase.new_balance ?? 0);
  const shortId = orderId.replace(/-/g, "").slice(0, 13) || `${Date.now()}`;
  const text =
    `✅ <b>Compra Realizada</b>\n\n` +
    `📦 <b>Producto:</b> ${escapeHtml(productName)}\n` +
    `⏳ <b>Duración:</b> ${escapeHtml(duration)}\n` +
    `💵 <b>Total:</b> ${total.toFixed(2)} USD\n\n` +
    `⏳ Tu key será enviada por un administrador en unos minutos.\n\n` +
    `🧾 <b>Orden:</b> ${escapeHtml(shortId)}\n` +
    `💼 <b>Saldo Disponible:</b> ${balanceLeft.toFixed(2)} USD\n\n` +
    `📂 <b>Descargar Archivo:</b> ${DOWNLOAD_PANEL_URL}\n\n` +
    `¡Gracias por tu compra!`;
  await screen(telegram_id, chat_id, text, [[{ text: "🏠 Menú", callback_data: "menu:main" }]], { final: true });
}

// ===== Comprobante (foto) =====
async function handleReceiptPhoto(msg: TgMessage) {
  const telegram_id = msg.from!.id;
  const chat_id = msg.chat.id;

  // Conservamos la foto del usuario en el chat.

  if (!msg.photo || msg.photo.length === 0) return;

  const photo = msg.photo[msg.photo.length - 1];
  if (!photo.file_id || !photo.file_unique_id) {
    await notifyUser(chat_id, `⚠️ Comprobante inválido.`);
    return;
  }
  if (photo.width < 200 || photo.height < 200) {
    await notifyUser(chat_id, `⚠️ Imagen demasiado pequeña. Enviá el comprobante completo.`);
    return;
  }

  // (Sin límite diario de comprobantes — los usuarios pueden enviar los que necesiten.)


  // Anti-spoofing: si ALGÚN otro usuario ya envió este comprobante (en cualquier
  // momento), lo rechazamos. Para el mismo usuario, máximo 3 reenvíos en 24h.
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: anyDup } = await sb
    .from("receipt_fingerprints")
    .select("telegram_id")
    .eq("file_unique_id", photo.file_unique_id)
    .neq("telegram_id", telegram_id)
    .limit(1);
  if (anyDup && anyDup.length > 0) {
    await notifyUser(chat_id, `⚠️ Este comprobante pertenece a otro usuario y no puede ser usado.`);
    return;
  }
  const { data: sameRows } = await sb
    .from("receipt_fingerprints")
    .select("telegram_id")
    .eq("file_unique_id", photo.file_unique_id)
    .eq("telegram_id", telegram_id)
    .gte("created_at", cutoff);
  if ((sameRows?.length ?? 0) >= 1) {
    // Comprobante duplicado: avisamos pero NO bloqueamos al primer intento.
    await notifyUser(
      chat_id,
      `📌 <b>Este comprobante ya fue enviado anteriormente.</b>\n\n` +
        `Por favor espera la revisión del comprobante actual.\n\n` +
        `Si continúas enviando el mismo comprobante tu cuenta podrá ser bloqueada y podrías perder tu pago.\n\n` +
        `Gracias por tu paciencia.`,
    );
    return;
  }

  const st = await getState(telegram_id);
  const validReceiptStates = ["awaiting_receipt", "awaiting_recharge_receipt"];
  if (!st || !validReceiptStates.includes(st.state) || !st.context?.order_id) {
    await notifyUser(chat_id, `⚠️ No tenés una orden pendiente. Iniciá una compra o recarga primero.`);
    return;
  }
  const isRecharge = st.state === "awaiting_recharge_receipt";
  const order_id = st.context.order_id as string;

  const { data: user } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .single();
  if (!user) return;

  await sb.from("receipt_fingerprints").insert({
    file_unique_id: photo.file_unique_id,
    file_id: photo.file_id,
    telegram_id,
  });

  const { data: receipt } = await sb
    .from("receipts")
    .insert({
      user_id: user.id,
      telegram_id,
      order_id,
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
      width: photo.width,
      height: photo.height,
      file_size: photo.file_size ?? null,
      status: "pending",
    })
    .select()
    .single();

  await sb
    .from("orders")
    .update({ status: "pending_approval", receipt_id: receipt?.id })
    .eq("id", order_id);

  await setState(telegram_id, "menu", {});
  await screen(
    telegram_id,
    chat_id,
    `⏳ <b>Comprobante en revisión</b>\n\nTu comprobante está siendo verificado.\n\n⚠️ No lo envíes nuevamente. Los comprobantes duplicados pueden ser rechazados.\n\n🔴 Tiempo estimado: <b>4 o 5 HORAS</b>\n🔴 En alta demanda: <b>HASTA 24 HORAS</b>\n\nNo seas estúpido. Recuerda que tenemos demasiados comprobantes en revisión, así que solo espera y no pierdas tu pago por estar exigiendo.\n\nGracias por tu paciencia.`,
    [[{ text: "🏠 Menú", callback_data: "menu:main" }]],
    { final: true },
  );

  const reviewPromise = processReceiptPhotoReview({
    telegram_id,
    chat_id,
    photo,
    receipt_id: receipt!.id,
    order_id,
    isRecharge,
    user,
  }).catch((err) => console.error("[receipt photo background]", err));
  if (!keepTelegramPromiseAlive(reviewPromise)) await reviewPromise;
  return;
}

async function processReceiptPhotoReview(opts: {
  telegram_id: number;
  chat_id: number;
  photo: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number };
  receipt_id: string;
  order_id: string;
  isRecharge: boolean;
  user: BotUser;
}) {
  const { telegram_id, chat_id, photo, receipt_id, order_id, isRecharge, user } = opts;

  const fileInfo = await getFile("shop", photo.file_id);
  if (!fileInfo.ok || !fileInfo.result) {
    await notifyUser(chat_id, `⚠️ Error procesando imagen. Intentá enviar el comprobante nuevamente.`);
    await sb.from("orders").update({ status: "pending_receipt" }).eq("id", order_id);
    await sb.from("receipts").delete().eq("id", receipt_id);
    await sb.from("receipt_fingerprints").delete().eq("file_unique_id", photo.file_unique_id);
    return;
  }
  const bytes = await downloadFile("shop", fileInfo.result.file_path);
  if (!bytes) {
    await notifyUser(chat_id, `⚠️ Error descargando imagen. Intentá enviar el comprobante nuevamente.`);
    await sb.from("orders").update({ status: "pending_receipt" }).eq("id", order_id);
    await sb.from("receipts").delete().eq("id", receipt_id);
    await sb.from("receipt_fingerprints").delete().eq("file_unique_id", photo.file_unique_id);
    return;
  }

  const { data: order } = await sb
    .from("orders")
    .select("*, products(name), product_prices(duration_label), payment_methods(country_name, method_name, holder_name, account_info, usd_rate, currency)")
    .eq("id", order_id)
    .single();

  const o = order as {
    id: string;
    created_at: string;
    total_usd: number;
    total_local: number | null;
    currency: string | null;
    keys_qty: number;
    products: { name: string } | null;
    product_prices: { duration_label: string } | null;
    payment_methods: { country_name: string; method_name: string; holder_name: string | null; account_info: string | null; usd_rate: number | string | null; currency: string | null } | null;
  };
  const pid = tpId(o.created_at);

  // Sin análisis de IA: reenviamos el comprobante directamente al admin
  // para que él haga la verificación 100% manual.
  const userTag = escapeHtml(user.username ? `@${user.username}` : (user.display_name ?? "—"));
  const country = escapeHtml(o.payment_methods?.country_name ?? "—");
  const method = escapeHtml(o.payment_methods?.method_name ?? "—");
  const productName = escapeHtml(o.products?.name ?? "—");
  const duration = o.product_prices?.duration_label ? ` · ${escapeHtml(o.product_prices.duration_label)}` : "";
  const kind = isRecharge ? "Recarga" : `Compra · ${productName}${duration}`;

  const caption =
    `📩 <b>Nuevo Comprobante</b>\n\n` +
    `👤 <b>Usuario:</b> ${userTag} · <code>${telegram_id}</code>\n` +
    `🆔 <b>Pending:</b> <code>${pid}</code>\n` +
    `💰 <b>Monto:</b> $${Number(o.total_usd).toFixed(2)} USD\n` +
    `💳 <b>Saldo actual:</b> $${Number(user.balance).toFixed(2)} USD\n` +
    `🌎 <b>País:</b> ${country}\n` +
    `🏦 <b>Método:</b> ${method}\n` +
    `📦 <b>Tipo:</b> ${kind}`;

  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    await notifyUser(chat_id, `⚠️ Admin no configurado. Avisá a soporte.`);
    return;
  }

  const sent = await sendPhotoMultipart(
    "admin",
    adminChatId,
    bytes,
    receiptFilename(fileInfo.result.file_path, "comprobante.jpg"),
    caption,
    {
      reply_markup: adminReceiptKeyboard(order_id, telegram_id),
    },
  );

  if (sent.ok && sent.result) {
    const adminFileId = newestTelegramPhotoFileId(sent.result);
    await Promise.all([
      sb.from("receipts").update({
        admin_message_id: sent.result.message_id,
        ...(adminFileId ? { admin_file_id: adminFileId } : {}),
      }).eq("id", receipt_id),
      sb.from("orders").update({ admin_message_id: sent.result.message_id }).eq("id", order_id),
    ]);
  } else {
    console.error("[receipt admin upload] sendPhotoMultipart failed", sent.description);
    // Fallback seguro: si Telegram no acepta la foto como imagen, enviamos
    // los mismos bytes como documento. Nunca reutilizamos el file_id del shop bot.
    const fallback = await sendDocumentMultipart(
      "admin",
      adminChatId,
      bytes,
      receiptFilename(fileInfo.result.file_path, "comprobante.jpg"),
      caption,
      { reply_markup: adminReceiptKeyboard(order_id, telegram_id) },
    );
    if (fallback.ok && fallback.result) {
      await Promise.all([
        sb.from("receipts").update({
          admin_message_id: fallback.result.message_id,
          ...(fallback.result.document?.file_id ? { admin_file_id: fallback.result.document.file_id } : {}),
        }).eq("id", receipt_id),
        sb.from("orders").update({ admin_message_id: fallback.result.message_id }).eq("id", order_id),
      ]);
    } else {
      console.error("[receipt admin upload] sendDocumentMultipart failed", fallback.description);
    }
  }
}

// ===== Comprobante (documento) =====
async function handleReceiptDocument(msg: TgMessage) {
  const telegram_id = msg.from!.id;
  const chat_id = msg.chat.id;
  // Conservamos el documento del usuario en el chat.
  const doc = msg.document!;
  if (!doc.file_id || !doc.file_unique_id) return;

  const st = await getState(telegram_id);
  if (!st || !["awaiting_receipt", "awaiting_recharge_receipt"].includes(st.state) || !st.context?.order_id) {
    await notifyUser(chat_id, `⚠️ No tenés una recarga pendiente.`);
    return;
  }
  const isRecharge = st.state === "awaiting_recharge_receipt";
  const order_id = st.context.order_id as string;

  // Anti-spoofing: si ALGÚN otro usuario ya envió este comprobante (en cualquier
  // momento), lo rechazamos. Para el mismo usuario, máximo 3 reenvíos en 24h.
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: anyDup } = await sb
    .from("receipt_fingerprints")
    .select("telegram_id")
    .eq("file_unique_id", doc.file_unique_id)
    .neq("telegram_id", telegram_id)
    .limit(1);
  if (anyDup && anyDup.length > 0) {
    await sendMessage("shop", chat_id, `⚠️ Este comprobante pertenece a otro usuario y no puede ser usado.`);
    return;
  }
  const { data: sameRows } = await sb
    .from("receipt_fingerprints")
    .select("telegram_id")
    .eq("file_unique_id", doc.file_unique_id)
    .eq("telegram_id", telegram_id)
    .gte("created_at", cutoff);
  if ((sameRows?.length ?? 0) >= 1) {
    await sendMessage(
      "shop",
      chat_id,
      `📌 <b>Este comprobante ya fue enviado anteriormente.</b>\n\n` +
        `Por favor espera la revisión del comprobante actual.\n\n` +
        `Si continúas enviando el mismo comprobante tu cuenta podrá ser bloqueada y podrías perder tu pago.\n\n` +
        `Gracias por tu paciencia.`,
    );
    return;
  }

  const { data: user } = await sb.from("bot_users").select("*").eq("telegram_id", telegram_id).single();
  if (!user) return;

  await sb.from("receipt_fingerprints").insert({
    file_unique_id: doc.file_unique_id,
    file_id: doc.file_id,
    telegram_id,
  });
  const { data: receipt } = await sb
    .from("receipts")
    .insert({
      user_id: user.id,
      telegram_id,
      order_id,
      file_id: doc.file_id,
      file_unique_id: doc.file_unique_id,
      file_size: doc.file_size ?? null,
      status: "pending",
    })
    .select()
    .single();

  await sb.from("orders").update({ status: "pending_approval", receipt_id: receipt?.id }).eq("id", order_id);

  const { data: order } = await sb
    .from("orders")
    .select("*, payment_methods(country_name, method_name, holder_name, account_info)")
    .eq("id", order_id)
    .single();
  const o = order as { id: string; created_at: string; total_usd: number; payment_methods: { country_name: string; method_name: string; holder_name: string | null; account_info: string | null } | null };
  const pid = tpId(o.created_at);

  const userTag2 = escapeHtml(user.username ? `@${user.username}` : (user.display_name ?? "—"));
  const pm2 = o.payment_methods;
  const pmInfo2 = pm2
    ? `\n💳 ${escapeHtml(pm2.country_name)} · ${escapeHtml(pm2.method_name)}` +
      (pm2.holder_name ? `\n🪪 ${escapeHtml(pm2.holder_name)}` : "") +
      (pm2.account_info ? `\n📋 <code>${escapeHtml(pm2.account_info)}</code>` : "")
    : "";
  const balLine2 = `\n💼 Saldo actual: $${Number(user.balance).toFixed(2)} USD`;
  const caption = isRecharge
    ? `💰 <b>Recarga · $${Number(o.total_usd).toFixed(2)}</b>\n${userTag2} · <code>${telegram_id}</code>${pmInfo2}${balLine2}\n<i>(documento)</i>`
    : `🛒 <b>Comprobante</b>\n${userTag2} · <code>${telegram_id}</code>${pmInfo2}${balLine2}\n<i>(documento)</i>`;

  const adminChatId = getAdminChatId();
  if (!adminChatId) return;

  const fileInfo = await getFile("shop", doc.file_id);
  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    await notifyUser(chat_id, `⚠️ Error procesando documento. Intentá enviar el comprobante nuevamente.`);
    await sb.from("orders").update({ status: "pending_receipt" }).eq("id", order_id);
    await sb.from("receipts").delete().eq("id", receipt!.id);
    await sb.from("receipt_fingerprints").delete().eq("file_unique_id", doc.file_unique_id);
    return;
  }
  const bytes = await downloadFile("shop", fileInfo.result.file_path);
  if (!bytes) {
    await notifyUser(chat_id, `⚠️ Error descargando documento. Intentá enviar el comprobante nuevamente.`);
    await sb.from("orders").update({ status: "pending_receipt" }).eq("id", order_id);
    await sb.from("receipts").delete().eq("id", receipt!.id);
    await sb.from("receipt_fingerprints").delete().eq("file_unique_id", doc.file_unique_id);
    return;
  }

  // Re-subimos el archivo físico al bot admin. Nunca usamos el file_id del
  // shop bot porque Telegram lo considera inválido para otros bots.
  const sent = await sendDocumentMultipart(
    "admin",
    adminChatId,
    bytes,
    doc.file_name || receiptFilename(fileInfo.result.file_path, "comprobante.pdf"),
    caption,
    { reply_markup: adminReceiptKeyboard(order_id, telegram_id) },
  );
  if (sent.ok && sent.result) {
    await Promise.all([
      sb.from("receipts").update({
        admin_message_id: sent.result.message_id,
        ...(sent.result.document?.file_id ? { admin_file_id: sent.result.document.file_id } : {}),
      }).eq("id", receipt!.id),
      sb.from("orders").update({ admin_message_id: sent.result.message_id }).eq("id", order_id),
    ]);
  } else {
    console.error("[receipt admin upload] sendDocumentMultipart failed", sent.description);
  }

  await setState(telegram_id, "menu", {});
  await screen(
    telegram_id,
    chat_id,
    `⏳ <b>Comprobante En Revisión</b>\n\n` +
      `Pending: <code>${pid}</code>\n\n` +
      `Si Subes El Comprobante Varias Veces Tu Recarga Será Rechazada Sin Lugar A Reclamo.\n\n` +
      `Se Paciente Y Espera.`,
    [[{ text: "🏠 Menú", callback_data: "menu:main" }]],
    { final: true },
  );
}

// ===== Login =====
async function askName(telegram_id: number, chat_id: number) {
  await setState(telegram_id, "login_name", {});
  await screen(
    telegram_id,
    chat_id,
    `👋 <b>Bienvenido</b>\n\n¿Cuál es tu nombre?`,
  );
}




// ===== Handler principal =====
export async function handleShopUpdate(update: Update): Promise<void> {
  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (err) {
    console.error("[shop handler] fatal", err);
    const cb = update.callback_query;
    const chat_id = update.message?.chat.id ?? cb?.message?.chat.id ?? cb?.from.id;
    if (chat_id) {
      await sendMessage(
        "shop",
        chat_id,
        `El bot está activo. No se pudo completar esa acción en este intento; vuelve a tocar la opción.`,
        { reply_markup: bottomKeyboard() },
      ).catch(() => {});
    }
  }
}

// Oferta promocional: martes (2) y viernes (5), 1 vez cada 24h por usuario.
// Oferta promocional: máximo 2 veces por semana por usuario, de forma
// aleatoria (no repetitiva) y SOLO para usuarios desconectados hace días
// o que no han recargado saldo hace mucho tiempo.
async function maybeSendWeeklyOffer(telegram_id: number, chat_id: number) {
  // 25% de probabilidad → evita spam cuando el usuario está muy activo.
  if (Math.random() > 0.25) return;
  // Máximo 2 envíos cada 7 días por usuario.
  const okWeekly = await checkRateLimit(telegram_id, "weekly_offer", 2, 7 * 86400);
  if (!okWeekly) return;
  // No dispararlo más de una vez cada 24h para dar aire.
  const okDay = await checkRateLimit(telegram_id, "weekly_offer_day", 1, 86400);
  if (!okDay) return;

  // Filtrar destinatarios: desconectado hace ≥3 días O sin recargar hace mucho.
  const { data: u } = await sb
    .from("bot_users")
    .select("last_seen_at, total_recharged, registered_at")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  if (!u) return;
  const now = Date.now();
  const lastSeen = u.last_seen_at ? new Date(u.last_seen_at).getTime() : now;
  const registeredAt = u.registered_at ? new Date(u.registered_at).getTime() : now;
  const daysSinceSeen = (now - lastSeen) / 86_400_000;
  const daysSinceReg = (now - registeredAt) / 86_400_000;
  const isDisconnected = daysSinceSeen >= 3;
  const noRecentRecharge = Number(u.total_recharged ?? 0) === 0 && daysSinceReg >= 7;
  if (!isDisconnected && !noRecentRecharge) return;

  await sendMessage(
    "shop",
    chat_id,
    `🔥 <b>¡APROVECHA LA OFERTA!</b> 🔥\n\n` +
      `Las contraseñas para tus paneles están en <b>descuento por tiempo limitado</b>.\n\n` +
      `✅ Mejor precio\n` +
      `✅ Activación rápida\n` +
      `✅ Oferta limitada\n\n` +
      `Contáctanos ahora y aprovecha el descuento.`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: "💳 Recargar Saldo", callback_data: "menu:recharge" }]],
      },
    },
  );
}


async function handleMessage(msg: TgMessage) {
  if (!msg.from) return;
  const telegram_id = msg.from.id;
  const chat_id = msg.chat.id;
  const text = (msg.text ?? "").trim();

  if (text === "/start" || text.startsWith("/start ")) {
    const rawParam = text.startsWith("/start ") ? text.slice(7).trim() : "";
    const refMatch = rawParam.match(/ref(\d+)/i);
    const starter = await sendMessage(
      "shop",
      chat_id,
      `⚡ <b>Bot activo</b>\n\nCargando tu menú...`,
      { reply_markup: bottomKeyboard() },
    );

    try {
      const botUser = await getOrCreateUser({ telegram_id, chat_id, username: msg.from.username });
      if (refMatch) {
        const refId = Number(refMatch[1]);
        if (Number.isFinite(refId) && refId > 0 && refId !== telegram_id) {
          try {
            const { data: rpcRes, error: rpcErr } = await sb.rpc("apply_referral", {
              _new_user: telegram_id,
              _referrer: refId,
            });
            if (rpcErr) {
              console.error("[referral] rpc error", rpcErr);
            } else if (rpcRes && (rpcRes as any).ok) {
              const prev = Number((rpcRes as any).prev ?? 0);
              const next = Number((rpcRes as any).next ?? 0);
              if (prev < REFERRAL_GOAL && next >= REFERRAL_GOAL) {
                sendMessage("shop", refId, `🎉 <b>Felicidades, descuento aplicado</b>\n\nDesde ahora cada key te cuesta $${REFERRAL_DISCOUNT_USD.toFixed(2)} USD menos.`).catch(() => {});
              }
            } else {
              console.log("[referral] skipped", { telegram_id, refId, reason: (rpcRes as any)?.reason });
            }
          } catch (e) {
            console.error("[referral] exception", e);
          }
        }
      }
      if (botUser.is_authenticated) {
        await showMainMenu(telegram_id, chat_id);
      } else {
        await askName(telegram_id, chat_id);
      }
    } catch (err) {
      console.error("[shop /start] recovery", err);
      await sendMessage(
        "shop",
        chat_id,
        `✅ <b>Estoy en línea.</b>\n\nToca /start nuevamente en unos segundos si el menú no termina de cargar.`,
        { reply_markup: bottomKeyboard() },
      ).catch(() => {});
    }

    if (!starter.ok) {
      console.error("[shop /start] immediate send failed", starter.description);
    }
    return;
  }

  // Oferta semanal (martes y viernes, 1 vez cada 24h por usuario)
  maybeSendWeeklyOffer(telegram_id, chat_id).catch(() => {});


  // La barra inferior debe sentirse instantánea: evitamos writes/checks lentos
  // antes de enviar la nueva pantalla. El anti-spam corre en segundo plano.
  if (isBottomMenuText(text)) {
    const cachedBlock = blockCache.get(telegram_id);
    if (cachedBlock?.value && cachedBlock.expiresAt > Date.now()) {
      silentDelete("shop", chat_id, msg.message_id).catch(() => {});
      return;
    }
    await getOrCreateUser({ telegram_id, chat_id, username: msg.from.username });
    isBlockedFast(telegram_id).then((blocked) => {
      if (blocked) silentDelete("shop", chat_id, msg.message_id).catch(() => {});
    }).catch(() => {});
    checkRateLimit(telegram_id, "msg", 20, 10).then((ok) => {
      if (!ok) autoBlock(telegram_id, "spam_msg").catch(() => {});
    }).catch(() => {});
    await routeBottomMenu(text, telegram_id, chat_id, msg.message_id);
    return;
  }

  // Atajo SUPER rápido: si el usuario está en flujo de recarga (monto) y
  // mandó solo dígitos, procesar al instante sin awaits previos.
  if (/^\d+([.,]\d+)?$/.test(text)) {
    const st0 = await getState(telegram_id);
    if (st0?.state === "recharge_amount") {
      const n = Number(text.replace(",", "."));
      if (Number.isFinite(n) && n >= (await getMinRecharge())) {
        const cc = (st0.context?.country_code as string) ?? "";
        silentDelete("shop", chat_id, msg.message_id).catch(() => {});
        // Anti-spam en background — no bloquea la UX.
        checkRateLimit(telegram_id, "msg", 20, 10).catch(() => {});
        await showRechargeMethods(telegram_id, chat_id, cc, Math.round(n * 100) / 100);
        return;
      }
    }
  }

  // Bloqueo total — borrar cualquier mensaje entrante para que no se acumule
  if (await isBlockedFast(telegram_id)) {
    silentDelete("shop", chat_id, msg.message_id).catch(() => {});
    return;
  }
  if (!(await checkRateLimit(telegram_id, "msg", 20, 10))) {
    silentDelete("shop", chat_id, msg.message_id).catch(() => {});
    await autoBlock(telegram_id, "spam_msg");
    return;
  }


  const botUser = await getOrCreateUser({
    telegram_id,
    chat_id,
    username: msg.from.username,
  });

  if (msg.photo && msg.photo.length > 0) {
    await handleReceiptPhoto(msg);
    return;
  }

  if (msg.document) {
    const st0 = await getState(telegram_id);
    if (st0?.state === "awaiting_recharge_receipt" || st0?.state === "awaiting_receipt") {
      await handleReceiptDocument(msg);
    } else {
      await notifyUser(chat_id, `⚠️ Para enviar comprobante iniciá una recarga primero.`);
    }
    return;
  }

  // Atajo: si el usuario ya está autenticado y tocó la barra inferior,
  // enrutar primero para responder al primer toque sin queries extra.
  if (
    botUser.is_authenticated &&
    (await routeBottomMenu(text, telegram_id, chat_id, msg.message_id))
  ) {
    return;
  }

  const st = await getState(telegram_id);

  if (st?.state === "login_name") {
    if (text.length < 2 || text.length > 40) {
      await screen(telegram_id, chat_id, `Nombre inválido. Ingresá entre 2 y 40 caracteres.`);
      return;
    }
    await updateUser(telegram_id, {
      is_authenticated: true,
      display_name: text,
    });
    await showMainMenu(telegram_id, chat_id);
    return;
  }


  if (st?.state === "recharge_amount") {
    const n = Number(text.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) {
      await screen(telegram_id, chat_id, `Monto inválido. Escribí solo números, ej: <code>10</code>.`, [
        [{ text: "Volver", callback_data: "menu:recharge" }],
      ]);
      return;
    }
    const min = await getMinRecharge();
    if (n < min) {
      await screen(
        telegram_id,
        chat_id,
        `El monto mínimo es <b>${min.toFixed(2)} USD</b>. Probá de nuevo.`,
        [[{ text: "Volver", callback_data: "menu:recharge" }]],
      );
      return;
    }
    const cc = (st.context?.country_code as string) ?? "";
    await silentDelete("shop", chat_id, msg.message_id).catch(() => {});
    await showRechargeMethods(telegram_id, chat_id, cc, Math.round(n * 100) / 100);
    return;
  }

  await showMainMenu(telegram_id, chat_id);
}


async function handleCallback(cb: TgCallback) {
  const telegram_id = cb.from.id;
  const chat_id = cb.message?.chat.id ?? telegram_id;
  const data = cb.data ?? "";

  // ACK INMEDIATO — primero de todo, para apagar el spinner "actualizando"
  // de Telegram al instante. No esperamos ni a checks de bloqueo/rate-limit.
  if (data.startsWith("shlink:")) {
    const uname = _shopBotUsername ?? process.env.TELEGRAM_SHOP_BOT_USERNAME?.replace(/^@/, "") ?? null;
    if (!uname) getShopBotUsername().catch(() => null);
    const link = uname ? `https://t.me/${uname}?start=ref${telegram_id}` : "";
    answerCallbackQuery("shop", cb.id, link || "No disponible", true).catch(() => {});
    return;
  }

  // No bloqueamos la navegación con queries de seguridad; corren en segundo plano.
  const cachedBlock = blockCache.get(telegram_id);
  if (cachedBlock?.value && cachedBlock.expiresAt > Date.now()) return;
  isBlockedFast(telegram_id).catch(() => false);
  checkRateLimit(telegram_id, "cb", 30, 10).then((ok) => {
    if (!ok) autoBlock(telegram_id, "spam_cb").catch(() => {});
  }).catch(() => {});

  await getOrCreateUser({ telegram_id, chat_id, username: cb.from.username });

  if (data === "menu:main") return showMainMenu(telegram_id, chat_id);
  if (data === "noop") return;
  if (data.startsWith("nob:")) {
    await notifyUser(chat_id, `💸 <b>Saldo insuficiente</b>\n\nNecesitás más saldo para comprar esta key. Usá <b>Recargar</b> para agregar saldo.`);
    return;
  }
  if (data === "menu:profile") return showProfile(telegram_id, chat_id);
  if (data === "menu:products") return showProducts(telegram_id, chat_id);
  if (data === "menu:status") return showOrderStatus(telegram_id, chat_id);
  if (data === "menu:keys") return showMyKeys(telegram_id, chat_id);
  if (data === "menu:buy") return showBuyWithBalance(telegram_id, chat_id);
  if (data === "menu:recharge") return startRecharge(telegram_id, chat_id);
  if (data === "menu:support") return showSupport(telegram_id, chat_id);
  if (data === "menu:announcements") return showAnnouncements(telegram_id, chat_id);
  if (data === "more:status") return showOrderStatus(telegram_id, chat_id);
  if (data === "more:keys") return showMyKeys(telegram_id, chat_id);
  if (data === "more:ann") return showAnnouncements(telegram_id, chat_id);
  if (data === "more:share") return showShareBot(telegram_id, chat_id);
  if (data === "more:support") return showSupport(telegram_id, chat_id);
  if (data === "more:panel") return showDownloadPanel(telegram_id, chat_id);
  if (data.startsWith("anvw:")) return openAnnouncement(telegram_id, chat_id, data.slice(5));

  if (data.startsWith("cat:")) return showCategory(telegram_id, chat_id, data.slice(4));
  if (data.startsWith("prod:")) return showDurations(telegram_id, chat_id, data.slice(5));
  if (data.startsWith("dur:")) {
    await patchContext(telegram_id, { price_id: data.slice(4), qty: 1 });
    return showCountries(telegram_id, chat_id, 1);
  }
  if (data.startsWith("qty:")) return showCountries(telegram_id, chat_id, Number(data.slice(4)) || 1);
  if (data === "pay:balance") return payWithBalance(telegram_id, chat_id);
  if (data === "manukey:accept") return acceptManualKey(telegram_id, chat_id);
  if (data.startsWith("pm:")) return showPaymentInstructions(telegram_id, chat_id, data.slice(3));
  if (data.startsWith("rcc:")) return askRechargeAmount(telegram_id, chat_id, data.slice(4));
  if (data.startsWith("rcpay:")) return startRechargeReceipt(telegram_id, chat_id, data.slice(6));

  await sendMessage("shop", chat_id, `Esa opción ya no está disponible. Volví al menú principal.`, {
    reply_markup: bottomKeyboard(),
  }).catch(() => {});
}

async function showOrderStatus(telegram_id: number, chat_id: number) {
  const { data: orders } = await sb
    .from("orders")
    .select("id, status, total_usd, created_at, order_type, products(name), product_prices(duration_label)")
    .eq("telegram_id", telegram_id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (!orders || orders.length === 0) {
    return screen(telegram_id, chat_id, `No tenés órdenes.`, [BACK_BUTTON]);
  }
  const { data: userRow } = await sb
    .from("bot_users")
    .select("display_name, username")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  const displayName = userRow?.display_name ?? userRow?.username ?? "Usuario";
  const statusLabel: Record<string, { icon: string; text: string }> = {
    delivered: { icon: "🟢", text: "Aprobado" },
    approved: { icon: "🟢", text: "Aprobado" },
    pending_approval: { icon: "⏳", text: "En revisión" },
    pending_receipt: { icon: "⏳", text: "Esperando comprobante" },
    pending: { icon: "⏳", text: "Pendiente" },
    rejected: { icon: "❌", text: "Rechazado" },
  };
  const relDate = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diffDays <= 0) return "Hoy";
    if (diffDays === 1) return "Ayer";
    if (diffDays < 7) return `Hace ${diffDays} días`;
    return d.toLocaleDateString("es");
  };
  const blocks = orders.map((o) => {
    const p = (o as { products: { name: string } | null }).products;
    const pr = (o as { product_prices: { duration_label: string } | null }).product_prices;
    const st = statusLabel[o.status] ?? { icon: "•", text: o.status };
    const amount = `$${Number(o.total_usd).toFixed(2)}`;
    const isRecharge = (o as { order_type?: string | null }).order_type === "recharge" || !p;
    const title = isRecharge
      ? `<b>Recarga</b>`
      : `<b>${escapeHtml(displayName)} · ${escapeHtml(pr?.duration_label ?? "—")}</b>`;
    return `${title}\n${st.icon} ${st.text}\n📅 ${relDate(o.created_at)}\n💰 Enviado: ${amount}`;
  });
  return screen(telegram_id, chat_id, `📦 <b>Mis órdenes</b>\n\n${blocks.join("\n\n")}`, [BACK_BUTTON]);
}

async function showMyKeys(telegram_id: number, chat_id: number) {
  const { data: user } = await sb.from("bot_users").select("id").eq("telegram_id", telegram_id).single();
  if (!user) return;
  const { data: keys } = await sb
    .from("order_keys")
    .select("key_value, delivered_at, orders(products(name), product_prices(duration_label))")
    .eq("user_id", user.id)
    .order("delivered_at", { ascending: false })
    .limit(30);
  if (!keys || keys.length === 0) {
    return screen(telegram_id, chat_id, `Aún no tenés keys.`, [BACK_BUTTON]);
  }
  const DAYS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const blocks = keys.map((k) => {
    const ord = (k as { orders: { products: { name: string } | null; product_prices: { duration_label: string } | null } | null }).orders;
    const name = ord?.products?.name ?? "Producto";
    const dur = ord?.product_prices?.duration_label ?? "—";
    const d = new Date(k.delivered_at);
    const day = DAYS[d.getDay()];
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
    return (
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `📦 ${escapeHtml(name)}\n` +
      `⏳ Duración: ${escapeHtml(dur)}\n` +
      `🗓️ Día de compra: ${day}\n` +
      `🕒 Hora: ${time}\n` +
      `🔑 Key: <code>${escapeHtml(k.key_value)}</code>`
    );
  });
  return screen(
    telegram_id,
    chat_id,
    `🔑 <b>Mis Keys</b>\n\n${blocks.join("\n\n")}\n\n━━━━━━━━━━━━━━━━━━`,
    [BACK_BUTTON],
  );
}

async function showAnnouncements(telegram_id: number, chat_id: number) {
  const { data: deliveries } = await sb
    .from("announcement_deliveries")
    .select("id, message_id, read_at, announcement_id, announcements(preview, created_at)")
    .eq("telegram_id", telegram_id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (!deliveries || deliveries.length === 0) {
    return screen(telegram_id, chat_id, `No hay anuncios.`, [BACK_BUTTON]);
  }
  const blocks = deliveries.map((d, i) => {
    const a = (d as { announcements: { preview: string; created_at: string } | null }).announcements;
    const date = a ? new Date(a.created_at).toLocaleDateString("es") : "";
    const tag = d.read_at ? "" : " · NUEVO";
    const preview = a?.preview?.slice(0, 80) || "Anuncio";
    return `${i + 1}. <b>${escapeHtml(preview)}</b>\n${date}${tag}`;
  });
  const kb: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < deliveries.length; i += 2) {
    const row = [{ text: `Abrir ${i + 1}`, callback_data: `anvw:${deliveries[i].id}` }];
    if (deliveries[i + 1]) row.push({ text: `Abrir ${i + 2}`, callback_data: `anvw:${deliveries[i + 1].id}` });
    kb.push(row);
  }
  kb.push([{ text: "Volver", callback_data: "menu:main" }]);
  return screen(telegram_id, chat_id, `<b>Anuncios</b>\n\n${blocks.join("\n\n")}`, kb);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Llamado desde el admin bot tras aprobar el pago. */
export async function notifyUserApproved(opts: {
  telegram_id: number;
  chat_id: number;
  amount_usd: number;
  new_balance: number;
  pending?: string;
}) {
  const pid = opts.pending ?? "";
  await sendMessage(
    "shop",
    opts.chat_id,
    `✅ <b>Recarga Aprobada</b>\n\n` +
      (pid ? `🆔 Pending: <code>${pid}</code>\n` : "") +
      `💰 Monto Aprobado: <b>${opts.amount_usd.toFixed(2)} USD</b>\n` +
      `➕ Saldo Agregado: <b>${opts.amount_usd.toFixed(2)} USD</b>\n` +
      `💵 Saldo Disponible: <b>${opts.new_balance.toFixed(2)} USD</b>\n\n` +
      `Ya puedes utilizar tu saldo para realizar compras dentro del bot.`,
    { reply_markup: { inline_keyboard: [[{ text: "🏠 Menú Principal", callback_data: "menu:main" }]] } },
  );
}

export async function notifyUserRejected(opts: {
  telegram_id: number;
  chat_id: number;
  note?: string;
  pending?: string;
}) {
  const pid = opts.pending ?? "";
  await sendMessage(
    "shop",
    opts.chat_id,
    `❌ <b>Recarga Rechazada</b>\n\n` +
      (pid ? `🆔 Pending: <code>${pid}</code>\n` : "") +
      `📝 Motivo: ${opts.note ?? "Sin especificar"}\n\n` +
      `Tu comprobante fue rechazado. Puedes enviar uno nuevo.`,
    { reply_markup: { inline_keyboard: [[{ text: "🏠 Menú Principal", callback_data: "menu:main" }]] } },
  );
}

export async function notifyUserKey(opts: {
  telegram_id: number;
  chat_id: number;
  key_value: string;
  product_name?: string;
  duration_label?: string;
}) {
  const header = opts.product_name
    ? `🔑 <b>Key entregada</b>\n\n${opts.product_name}${opts.duration_label ? `  ·  ${opts.duration_label}` : ""}\n\n`
    : `🔑 <b>Key entregada</b>\n\n`;
  const sent = await sendMessage(
    "shop",
    opts.chat_id,
    `${header}<code>${opts.key_value}</code>`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 Menú", callback_data: "menu:main" }]],
      },
    },
  );
  if (sent.ok && sent.result) {
    await setActiveMessage(opts.telegram_id, opts.chat_id, sent.result.message_id);
  }
}

async function openAnnouncement(telegram_id: number, chat_id: number, deliveryId: string) {
  const { data: del } = await sb
    .from("announcement_deliveries")
    .select("id, message_id, read_at, announcement_id, announcements(source_chat_id, source_message_id)")
    .eq("id", deliveryId)
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  if (!del) return;
  const a = (del as { announcements: { source_chat_id: number; source_message_id: number } | null }).announcements;
  // Mostrar el anuncio (lo dejamos también en el historial — no borramos el original).
  if (a) {
    const { copyMessage } = await import("./api.server");
    await copyMessage("shop", chat_id, a.source_chat_id, a.source_message_id);
  }
  // Conservamos el aviso original del broadcast — no se borra.
  // Marcar leído
  if (!del.read_at) {
    await sb
      .from("announcement_deliveries")
      .update({ read_at: new Date().toISOString(), message_id: null })
      .eq("id", del.id);
  }
}

/** Llamado desde el admin tras enviar el anuncio. Registra entrega y message_id. */
export async function recordAnnouncementDelivery(opts: {
  announcement_id: string;
  telegram_id: number;
  chat_id: number;
  message_id: number | null;
}) {
  await sb.from("announcement_deliveries").insert({
    announcement_id: opts.announcement_id,
    telegram_id: opts.telegram_id,
    chat_id: opts.chat_id,
    message_id: opts.message_id,
  });
}
