// Shop Bot — handler completo (UI minimalista)
import {
  sendMessage,
  sendPhotoMultipart,
  getFile,
  downloadFile,
  answerCallbackQuery,
  editMessageText,
  getAdminChatId,
  tg,
} from "./api.server";
import {
  getOrCreateUser,
  updateUser,
  getState,
  setState,
  patchContext,
  tryAcquireStartLock,
  checkRateLimit,
  isBlocked,
  autoBlock,
  getActiveMessage,
  setActiveMessage,
  sb,
} from "./db.server";
import { silentDelete } from "./ui.server";

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
  const active = await getActiveMessage(telegram_id);
  if (active && active.chat_id === chat_id && active.message_id > 0 && !opts?.final) {
    const edited = await editMessageText("shop", chat_id, active.message_id, text, { reply_markup });
    if (edited.ok) return active.message_id;
  }
  const sent = await sendMessage("shop", chat_id, text, { reply_markup });
  if (sent.ok && sent.result) {
    if (opts?.final) {
      // Limpiamos el mensaje activo para que el próximo flujo abra uno nuevo
      // y este quede preservado en el historial del chat.
      await setActiveMessage(telegram_id, chat_id, 0);
    } else {
      await setActiveMessage(telegram_id, chat_id, sent.result.message_id);
    }
    return sent.result.message_id;
  }
  return null;
}
import { getVisibleCatalog, invalidateCatalogCache } from "./catalog.server";
import { ocrReceipt, formatOcrSummary } from "./ocr.server";

const MIN_RECHARGE_USD = 5;
function tpId(createdAt: string | Date) {
  const t = typeof createdAt === "string" ? new Date(createdAt).getTime() : createdAt.getTime();
  return `TP${t}`;
}

/** Normaliza string para comparación: minúsculas, sin acentos, sin signos. */
function normTxt(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿El destinatario detectado por la IA coincide con el titular o la cuenta del método?
 * Tolerante: basta con que UN token significativo (>=3 chars) coincida,
 * o que la cuenta/alias aparezca como substring del recipient.
 */
function recipientMatches(recipient: string, holder: string, account: string | null): boolean {
  const r = normTxt(recipient);
  if (!r) return true; // sin datos: no bloquear
  const h = normTxt(holder);
  if (h && r.includes(h)) return true;
  if (h) {
    const tokens = h.split(" ").filter((t) => t.length >= 3);
    let hits = 0;
    for (const t of tokens) if (r.includes(t)) hits++;
    if (hits >= 1) return true;
  }
  if (account) {
    const a = normTxt(account);
    if (a && a.length >= 4 && r.includes(a)) return true;
    // si el alias/cuenta tiene tokens largos, también permitir
    if (a) {
      const at = a.split(" ").filter((t) => t.length >= 4);
      for (const t of at) if (r.includes(t)) return true;
    }
  }
  return false;
}

const ACCESS_PASSWORD = "117";

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
  normal: "Normal",
  pro: "Pro",
  leyenda: "Leyenda",
};

const SUPPORT_USERNAME = "@smallffx7";

// Menú inferior fijo (ReplyKeyboardMarkup) — siempre visible
const BOTTOM_MENU = {
  products: "🛒 Productos",
  buy: "💳 Comprar",
  status: "📦 Estado",
  profile: "👤 Perfil",
  keys: "🔑 Mis Keys",
  recharge: "💰 Recargar",
  announcements: "📣 Anuncios",
  share: "🤝 Compartir Bot",
  support: "💬 Soporte",
};

function bottomKeyboard() {
  return {
    keyboard: [
      [{ text: BOTTOM_MENU.products }, { text: BOTTOM_MENU.buy }],
      [{ text: BOTTOM_MENU.status }, { text: BOTTOM_MENU.profile }],
      [{ text: BOTTOM_MENU.keys }, { text: BOTTOM_MENU.recharge }],
      [{ text: BOTTOM_MENU.announcements }, { text: BOTTOM_MENU.share }],
      [{ text: BOTTOM_MENU.support }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
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
  // Limpiamos el "mensaje activo" para que el próximo flujo abra un mensaje
  // nuevo (en lugar de editar uno antiguo de otra sección).
  await setActiveMessage(telegram_id, chat_id, 0);
  // Reenviamos la barra inferior (ReplyKeyboard persistente) en cada vuelta
  // al menú, sin borrarla, así nunca desaparece para el usuario.
  await sendMessage(
    "shop",
    chat_id,
    `🏠 <b>Inicio</b>\n\nElegí una opción desde la barra inferior.`,
    { reply_markup: bottomKeyboard() },
  );
}

async function deliverBottomKeyboard(chat_id: number, text: string) {
  await sendMessage("shop", chat_id, text, { reply_markup: bottomKeyboard() });
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
    `🤝 <b>Compartir Bot</b>\n\n` +
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
  const text =
    `👤 <b>Mi Perfil</b>\n\n` +
    `Nombre   <b>${u.display_name ?? "—"}</b>\n` +
    `Usuario  @${u.username ?? "—"}\n` +
    `ID       <code>${u.telegram_id}</code>\n` +
    `Saldo    <b>$${Number(u.balance).toFixed(2)} USD</b>\n` +
    `Recargado $${Number(u.total_recharged).toFixed(2)} USD\n` +
    `Rango    ${RANK_LABEL[u.rank] ?? u.rank}\n` +
    `Registro ${new Date(u.registered_at).toLocaleDateString("es")}`;
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
  const section = grouped.find((s) => s.category === category);
  if (!section || section.products.length === 0) {
    await screen(
    telegram_id,
      chat_id,
      `No hay productos disponibles en ${category}.`,
      [[{ text: "Volver", callback_data: "menu:products" }]],
    );
    return;
  }
  await setState(telegram_id, "choose_product", { category });
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
  const [{ data: u }, catalog] = await Promise.all([
    sb.from("bot_users").select("balance").eq("telegram_id", telegram_id).single(),
    getVisibleCatalog(),
  ]);
  const balance = Number(u?.balance ?? 0);
  const product = catalog.grouped.flatMap((s) => s.products).find((p) => p.id === product_id);
  if (!product) {
    await screen(telegram_id, chat_id, `Producto no disponible.`, [
      [{ text: "Volver", callback_data: "menu:products" }],
    ]);
    return;
  }
  const prices = product.prices ?? [];
  if (prices.length === 0) {
    await screen(telegram_id, chat_id, `Sin duraciones disponibles.`, [
      [{ text: "Volver", callback_data: "menu:products" }],
    ]);
    return;
  }
  if (balance <= 0) {
    await screen(
    telegram_id,
      chat_id,
      `💸 <b>Saldo insuficiente</b>\n\nNo tenés saldo para comprar.\nSaldo actual: <b>$0.00 USD</b>\n\nUsá <b>Recargar</b> para agregar saldo.`,
      [[{ text: "💰 Recargar", callback_data: "menu:recharge" }], BACK_BUTTON],
    );
    return;
  }
  const minPrice = Math.min(...prices.map((p) => Number(p.price_usd)));
  if (balance < minPrice) {
    await screen(
    telegram_id,
      chat_id,
      `💸 <b>Saldo insuficiente</b>\n\nSaldo actual: <b>$${balance.toFixed(2)} USD</b>\nMínimo requerido: <b>$${minPrice.toFixed(2)} USD</b>\n\nUsá <b>Recargar</b> para agregar saldo.`,
      [[{ text: "💰 Recargar", callback_data: "menu:recharge" }], BACK_BUTTON],
    );
    return;
  }
  await patchContext(telegram_id, { product_id });
  const rows = prices.map((p) => {
    const affordable = balance >= Number(p.price_usd);
    return [
      {
        text: `${p.duration_label}  ·  $${Number(p.price_usd).toFixed(2)}${affordable ? "" : "  ·  sin saldo"}`,
        callback_data: affordable ? `dur:${p.id}` : "noop",
      },
    ];
  });
  rows.push([{ text: "Volver", callback_data: `cat:${product.category}` }]);
  await screen(
    telegram_id,
    chat_id,
    `<b>${product.name}</b>\n\nSaldo disponible: <b>$${balance.toFixed(2)} USD</b>\n\nElegí la duración:`,
    rows,
  );
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
  const [{ data: price }, { count: availableCount }, { data: u }, { data: countries }] =
    await Promise.all([
      sb.from("product_prices").select("*").eq("id", ctx.price_id as string).single(),
      sb
        .from("product_stock_keys")
        .select("id", { count: "exact", head: true })
        .eq("product_id", ctx.product_id as string)
        .eq("price_id", ctx.price_id as string)
        .eq("used", false),
      sb.from("bot_users").select("balance").eq("telegram_id", telegram_id).single(),
      sb
        .from("payment_methods")
        .select("id, country_code, country_name, method_name")
        .eq("active", true)
        .order("sort_order"),
    ]);
  if (!price) return;
  const total_usd = Number(price.price_usd) * qty;
  const stockNote =
    (availableCount ?? 0) < qty
      ? `\n<i>Stock automático ${availableCount ?? 0}. Tu compra quedará en entrega manual por el admin.</i>`
      : "";
  const balance = Number(u?.balance ?? 0);

  const kb: Array<Array<{ text: string; callback_data: string }>> = [];
  if (balance >= total_usd) {
    kb.push([{ text: `Pagar con saldo  ·  $${total_usd.toFixed(2)}`, callback_data: "pay:balance" }]);
  }
  for (const c of countries ?? []) {
    kb.push([{ text: `${c.country_name}  ·  ${c.method_name}`, callback_data: `pm:${c.id}` }]);
  }
  kb.push([{ text: "Volver", callback_data: "menu:products" }]);
  await screen(
    telegram_id,
    chat_id,
    `💳 <b>Método de pago</b>\n\nTotal  <b>$${total_usd.toFixed(2)} USD</b>\nSaldo  $${balance.toFixed(2)}${stockNote}`,
    kb,
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
  const total_usd = Number(price.price_usd) * qty;
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

async function askRechargeAmount(telegram_id: number, chat_id: number, country_code: string) {
  const { data: pmRow } = await sb
    .from("payment_methods")
    .select("country_name")
    .eq("country_code", country_code)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (!pmRow) {
    await screen(telegram_id, chat_id, `País no disponible.`, [BACK_BUTTON]);
    return;
  }
  await setState(telegram_id, "recharge_amount", { country_code });
  await screen(
    telegram_id,
    chat_id,
    `💰 <b>Recargar Saldo Desde ${pmRow.country_name}</b>\n\n` +
      `Recarga Mínima: <b>${MIN_RECHARGE_USD.toFixed(2)} USD</b>\n\n` +
      `¿Cuánto deseas recargar?\n\n` +
      `Ejemplo:\n<code>10</code>\n\n` +
      `Escribí el monto en USD.`,
    [[{ text: "Volver", callback_data: "menu:recharge" }]],
  );
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
  const lines: string[] = [
    `💳 <b>Métodos De Pago - ${methods[0].country_name}</b>`,
    ``,
    `ID De Recarga: <code>${pid}</code>`,
    `Monto: <b>${amount.toFixed(2)} USD</b>`,
    `Total A Pagar: <b>${amount.toFixed(2)} USD</b>`,
    ``,
  ];
  for (const m of methods) {
    const local = amount * Number(m.usd_rate);
    lines.push(`💳 <b>Método De Pago</b>`);
    lines.push(`Nombre: <b>${m.method_name}</b>`);
    lines.push(`Titular: <code>${m.holder_name}</code>`);
    lines.push(`Cuenta: <code>${m.account_info}</code>`);
    if (m.extra_info) lines.push(`Nota: ${m.extra_info}`);
    if (Number(m.usd_rate) !== 1) {
      lines.push(`Total: <b>${local.toFixed(2)} ${m.currency}</b>`);
    } else {
      lines.push(`Total: <b>${amount.toFixed(2)} ${m.currency}</b>`);
    }
    lines.push(``);
  }

  await screen(telegram_id, chat_id, lines.join("\n"), [
    [{ text: "✅ Ya Pagué", callback_data: `rcpay:${order.id}` }],
    [{ text: "🏠 Menú Principal", callback_data: "menu:main" }],
  ]);
}

async function startRechargeReceipt(telegram_id: number, chat_id: number, order_id: string) {
  await setState(telegram_id, "awaiting_recharge_receipt", { order_id });
  await screen(
    telegram_id,
    chat_id,
    `📤 <b>Envía tu comprobante de pago</b>\n\nAceptamos imágenes, capturas o documentos.`,
    [[{ text: "✖️ Cancelar", callback_data: "menu:main" }]],
  );
}


// Enrutado del menú inferior fijo. Devuelve true si manejó el texto.
async function routeBottomMenu(
  text: string,
  telegram_id: number,
  chat_id: number,
  message_id: number,
): Promise<boolean> {
  const map: Record<string, (tid: number, cid: number) => Promise<unknown>> = {
    [BOTTOM_MENU.products]: showProducts,
    [BOTTOM_MENU.buy]: showBuyWithBalance,
    [BOTTOM_MENU.status]: showOrderStatus,
    [BOTTOM_MENU.profile]: showProfile,
    [BOTTOM_MENU.keys]: showMyKeys,
    [BOTTOM_MENU.recharge]: startRecharge,
    [BOTTOM_MENU.announcements]: showAnnouncements,
    [BOTTOM_MENU.share]: showShareBot,
    [BOTTOM_MENU.support]: showSupport,
  };
  const action = map[text];
  if (!action) return false;
  // No borramos nada: cada acción envía una nueva pantalla y se conserva
  // el historial. Solo silenciamos el "tap" del menú del usuario? NO —
  // tampoco se borra, para que quede todo en el chat.
  await action(telegram_id, chat_id);
  return true;
}

// ===== Pago con saldo (entrega automática si hay stock) =====
async function payWithBalance(telegram_id: number, chat_id: number) {
  const ctx = (await getState(telegram_id))?.context as Record<string, string | number>;
  const { data: price } = await sb
    .from("product_prices")
    .select("*, products(name)")
    .eq("id", ctx.price_id as string)
    .single();
  if (!price) return;
  const qty = Number(ctx.qty ?? 1);
  const { data: shareU } = await sb
    .from("bot_users")
    .select("shares_count")
    .eq("telegram_id", telegram_id)
    .single();
  const hasReferralDiscount = Number(shareU?.shares_count ?? 0) >= REFERRAL_GOAL;
  const unit_price = Math.max(
    0,
    Number(price.price_usd) - (hasReferralDiscount ? REFERRAL_DISCOUNT_USD : 0),
  );
  const total_usd = unit_price * qty;

  const { data: user } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .single();
  if (!user || Number(user.balance) < total_usd) {
    await screen(telegram_id, chat_id, `Saldo insuficiente.`, [BACK_BUTTON]);
    return;
  }

  const { data: avail } = await sb
    .from("product_stock_keys")
    .select("*")
    .eq("product_id", ctx.product_id as string)
    .eq("price_id", ctx.price_id as string)
    .eq("used", false)
    .limit(qty);

  const hasStock = (avail?.length ?? 0) >= qty;

  const { data: order } = await sb
    .from("orders")
    .insert({
      user_id: user.id,
      telegram_id,
      product_id: ctx.product_id as string,
      price_id: ctx.price_id as string,
      keys_qty: qty,
      total_usd,
      status: hasStock ? "delivered" : "pending_approval",
      paid_with_balance: true,
    })
    .select()
    .single();
  if (!order) return;

  await sb
    .from("bot_users")
    .update({ balance: Number(user.balance) - total_usd })
    .eq("id", user.id);

  if (hasStock && avail) {
    await Promise.all([
      sb
        .from("product_stock_keys")
        .update({
          used: true,
          used_at: new Date().toISOString(),
          used_by_user_id: user.id,
          used_by_order_id: order.id,
        })
        .in("id", avail.map((k) => k.id)),
      sb.from("order_keys").insert(
        avail.map((k) => ({
          order_id: order.id,
          user_id: user.id,
          key_value: k.key_value,
        })),
      ),
    ]);
    invalidateCatalogCache();

    const keysText = avail.map((k) => `<code>${k.key_value}</code>`).join("\n");
    await screen(
    telegram_id,
      chat_id,
      `✅ <b>Compra completada</b>\n\nProducto  ${(price as { products: { name: string } }).products.name}\nDuración  ${price.duration_label}\nCantidad  ${qty}\n\n<b>Tus keys</b>\n${keysText}`,
      [[{ text: "🏠 Menú", callback_data: "menu:main" }]],
      { final: true },
    );
    return;
  }

  // Sin stock → entrega manual: notificar al admin con botón "Enviar Key"
  const adminChat = getAdminChatId();
  if (adminChat) {
    const sentAdmin = await sendMessage(
      "admin",
      adminChat,
      `<b>Nueva compra · entrega manual</b>\n\n` +
        `Producto  ${(price as { products: { name: string } }).products.name}\n` +
        `Duración  ${price.duration_label}\n` +
        `Cantidad  ${qty}\n` +
        `Cobrado   <b>$${total_usd.toFixed(2)} USD</b>\n` +
        `Usuario   <code>${telegram_id}</code>\n` +
        `Orden     <code>${order.id.slice(0, 8)}</code>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Enviar Key", callback_data: `adm:sendkey:${order.id}` }],
          ],
        },
      },
    );
    if (sentAdmin.ok && sentAdmin.result) {
      await sb
        .from("orders")
        .update({ admin_message_id: sentAdmin.result.message_id })
        .eq("id", order.id);
    }
  }

  await screen(
    telegram_id,
    chat_id,
    `✅ <b>Pago con saldo recibido</b>\n\n` +
      `Producto  ${(price as { products: { name: string } }).products.name}\n` +
      `Duración  ${price.duration_label}\n` +
      `Cantidad  ${qty}\n\n` +
      `Sin stock automático. El admin entregará la key en breve.`,
    [[{ text: "🏠 Menú", callback_data: "menu:main" }]],
    { final: true },
  );
}

// ===== Comprobante (foto) =====
async function handleReceiptPhoto(msg: TgMessage) {
  const telegram_id = msg.from!.id;
  const chat_id = msg.chat.id;

  // Conservamos la foto del usuario en el chat.

  if (!msg.photo || msg.photo.length === 0) return;

  const photo = msg.photo[msg.photo.length - 1];
  if (!photo.file_id || !photo.file_unique_id) {
    await sendMessage("shop", chat_id, `Comprobante inválido.`);
    return;
  }
  if (photo.width < 200 || photo.height < 200) {
    await sendMessage("shop", chat_id, `Imagen demasiado pequeña. Enviá el comprobante completo.`);
    return;
  }

  // Límite diario de comprobantes: 10 por día
  if (!(await checkRateLimit(telegram_id, "receipt_day", 10, 86400))) {
    await sendMessage(
      "shop",
      chat_id,
      `Alcanzaste el límite de 10 comprobantes por día. Probá mañana o esperá una respuesta del admin.`,
    );
    return;
  }

  // Anti duplicado 24h: el mismo usuario puede reenviar hasta 3 veces el mismo comprobante.
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: dupRows } = await sb
    .from("receipt_fingerprints")
    .select("telegram_id")
    .eq("file_unique_id", photo.file_unique_id)
    .gte("created_at", cutoff);
  const dupList = dupRows ?? [];
  const otherUser = dupList.some((r) => r.telegram_id !== telegram_id);
  const sameUserCount = dupList.filter((r) => r.telegram_id === telegram_id).length;
  if (otherUser) {
    await sendMessage("shop", chat_id, `Este comprobante ya fue enviado antes.`);
    return;
  }
  if (sameUserCount >= 3) {
    await sendMessage(
      "shop",
      chat_id,
      `Ya reenviaste este comprobante 3 veces. Esperá la revisión del admin.`,
    );
    return;
  }

  const st = await getState(telegram_id);
  const validReceiptStates = ["awaiting_receipt", "awaiting_recharge_receipt"];
  if (!st || !validReceiptStates.includes(st.state) || !st.context?.order_id) {
    await sendMessage(
      "shop",
      chat_id,
      `No tenés una orden pendiente. Iniciá una compra o recarga primero.`,
    );
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

  const fileInfo = await getFile("shop", photo.file_id);
  if (!fileInfo.ok || !fileInfo.result) {
    await sendMessage("shop", chat_id, `Error procesando imagen. Intentá de nuevo.`);
    return;
  }
  const bytes = await downloadFile("shop", fileInfo.result.file_path);
  if (!bytes) {
    await sendMessage("shop", chat_id, `Error descargando imagen.`);
    return;
  }

  const { data: order } = await sb
    .from("orders")
    .select("*, products(name), product_prices(duration_label), payment_methods(country_name, method_name, holder_name, account_info)")
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
    payment_methods: { country_name: string; method_name: string; holder_name: string | null; account_info: string | null } | null;
  };
  const pid = tpId(o.created_at);

  // OCR (best-effort, no bloquea)
  const ocr = await ocrReceipt(bytes).catch(() => null);
  const ocrSummary = formatOcrSummary(
    ocr,
    Number(o.total_usd),
    o.total_local ? Number(o.total_local) : null,
  );

  // IA: si la imagen no parece un pago, avisar al usuario y NO enviar al admin
  if (ocr?.is_payment === false) {
    await sendMessage(
      "shop",
      chat_id,
      `Lo que enviaste no parece un comprobante de pago. Reenviá la imagen del comprobante completo y que vaya al destinatario correcto.`,
    );
    await sb.from("orders").update({ status: "pending_receipt" }).eq("id", order_id);
    await sb.from("receipts").delete().eq("id", receipt!.id);
    return;
  }

  // IA: verificar destinatario contra titular/cuenta del método de pago
  if (ocr?.recipient && o.payment_methods?.holder_name) {
    if (!recipientMatches(ocr.recipient, o.payment_methods.holder_name, o.payment_methods.account_info)) {
      await sendMessage(
        "shop",
        chat_id,
        `<b>Tu comprobante no es compatible con el método de pago.</b>\n\n` +
          `Por favor, envía el dinero a los datos correctos:\n\n` +
          `Titular  <code>${o.payment_methods.holder_name}</code>\n` +
          `Cuenta   ${o.payment_methods.account_info ?? "—"}`,
      );
      await sb.from("orders").update({ status: "pending_receipt" }).eq("id", order_id);
      await sb.from("receipts").delete().eq("id", receipt!.id);
      return;
    }
  }



  let caption: string;
  if (isRecharge) {
    caption =
      `🧾 <b>Comprobante De Recarga</b>\n\n` +
      `Pending: <code>${pid}</code>\n` +
      `Usuario: @${user.username ?? "—"}\n` +
      `ID: <code>${telegram_id}</code>\n` +
      `Monto: <b>${Number(o.total_usd).toFixed(2)} USD</b>\n` +
      `País: ${o.payment_methods?.country_name ?? "—"}\n` +
      `Total: <b>${Number(o.total_usd).toFixed(2)} USD</b>` +
      ocrSummary;
  } else {
    caption =
      `🧾 <b>Nuevo comprobante</b>\n\n` +
      `Usuario   ${user.display_name ?? "—"} (@${user.username ?? "—"})\n` +
      `ID        <code>${telegram_id}</code>\n` +
      `Producto  ${o.products?.name ?? "—"}\n` +
      `Duración  ${o.product_prices?.duration_label ?? "—"}\n` +
      `Cantidad  ${o.keys_qty}\n` +
      `Total     $${Number(o.total_usd).toFixed(2)} USD` +
      (o.total_local ? ` (${Number(o.total_local).toFixed(2)} ${o.currency})` : "") +
      `\nMétodo    ${o.payment_methods?.country_name ?? "—"} ${o.payment_methods?.method_name ?? ""}\n` +
      `Orden     <code>${o.id}</code>` +
      ocrSummary;
  }

  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    await sendMessage("shop", chat_id, `Admin no configurado. Avisá a soporte.`);
    return;
  }

  const sent = await sendPhotoMultipart(
    "admin",
    adminChatId,
    bytes,
    "comprobante.jpg",
    caption,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Aprobar", callback_data: `adm:approve:${order_id}` },
            { text: "Rechazar", callback_data: `adm:reject:${order_id}` },
          ],
          [
            { text: "Enviar key manual", callback_data: `adm:sendkey:${order_id}` },
            { text: "Bloquear", callback_data: `adm:block:${telegram_id}` },
          ],
        ],
      },
    },
  );

  if (sent.ok && sent.result) {
    await Promise.all([
      sb.from("receipts").update({ admin_message_id: sent.result.message_id }).eq("id", receipt!.id),
      sb.from("orders").update({ admin_message_id: sent.result.message_id }).eq("id", order_id),
    ]);
  }

  await setState(telegram_id, "menu", {});
  const reviewText =
    `⏳ <b>Comprobante En Revisión</b>\n\n` +
    (isRecharge ? `Pending: <code>${pid}</code>\n\n` : "") +
    `Si Subes El Comprobante Varias Veces Tu Recarga Será Rechazada Sin Lugar A Reclamo.\n\n` +
    `Se Paciente Y Espera.`;
  await screen(
    telegram_id,
    chat_id,
    reviewText,
    [[{ text: "🏠 Menú", callback_data: "menu:main" }]],
    { final: true },
  );
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
    await sendMessage("shop", chat_id, `No tenés una recarga pendiente.`);
    return;
  }
  const isRecharge = st.state === "awaiting_recharge_receipt";
  const order_id = st.context.order_id as string;

  // Anti duplicado 24h: el mismo usuario puede reenviar hasta 3 veces el mismo comprobante.
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: dupRows } = await sb
    .from("receipt_fingerprints")
    .select("telegram_id")
    .eq("file_unique_id", doc.file_unique_id)
    .gte("created_at", cutoff);
  const dupList = dupRows ?? [];
  const otherUser = dupList.some((r) => r.telegram_id !== telegram_id);
  const sameUserCount = dupList.filter((r) => r.telegram_id === telegram_id).length;
  if (otherUser) {
    await sendMessage("shop", chat_id, `Este comprobante ya fue enviado antes.`);
    return;
  }
  if (sameUserCount >= 3) {
    await sendMessage("shop", chat_id, `Ya reenviaste este comprobante 3 veces. Esperá la revisión del admin.`);
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
    .select("*, payment_methods(country_name, method_name)")
    .eq("id", order_id)
    .single();
  const o = order as { id: string; created_at: string; total_usd: number; payment_methods: { country_name: string; method_name: string } | null };
  const pid = tpId(o.created_at);

  const caption = isRecharge
    ? `🧾 <b>Comprobante De Recarga</b>\n\n` +
      `Pending: <code>${pid}</code>\n` +
      `Usuario: @${user.username ?? "—"}\n` +
      `ID: <code>${telegram_id}</code>\n` +
      `Monto: <b>${Number(o.total_usd).toFixed(2)} USD</b>\n` +
      `País: ${o.payment_methods?.country_name ?? "—"}\n` +
      `Total: <b>${Number(o.total_usd).toFixed(2)} USD</b>`
    : `🧾 <b>Comprobante</b>\n\nOrden <code>${o.id}</code>`;

  const adminChatId = getAdminChatId();
  if (!adminChatId) return;

  // Reenviar el documento al admin con botones
  const { tg } = await import("./api.server");
  const sent = await tg<{ message_id: number }>("admin", "sendDocument", {
    chat_id: adminChatId,
    document: doc.file_id,
    caption,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Aprobar", callback_data: `adm:approve:${order_id}` },
          { text: "Rechazar", callback_data: `adm:reject:${order_id}` },
        ],
        [{ text: "Bloquear", callback_data: `adm:block:${telegram_id}` }],
      ],
    },
  });
  if (sent.ok && sent.result) {
    await Promise.all([
      sb.from("receipts").update({ admin_message_id: sent.result.message_id }).eq("id", receipt!.id),
      sb.from("orders").update({ admin_message_id: sent.result.message_id }).eq("id", order_id),
    ]);
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

async function askPassword(telegram_id: number, chat_id: number, name: string) {
  await setState(telegram_id, "login_password", { display_name: name });
  await screen(
    telegram_id,
    chat_id,
    `Hola <b>${name}</b>.\n\nIngresá la contraseña de acceso:`,
  );
}

// ===== Handler principal =====
export async function handleShopUpdate(update: Update): Promise<void> {
  if (update.message) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
}

async function handleMessage(msg: TgMessage) {
  if (!msg.from) return;
  const telegram_id = msg.from.id;
  const chat_id = msg.chat.id;

  // Bloqueo total — borrar cualquier mensaje entrante para que no se acumule
  if (await isBlocked(telegram_id)) {
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
      await sendMessage("shop", chat_id, `Para enviar comprobante iniciá una recarga primero.`);
    }
    return;
  }

  const text = (msg.text ?? "").trim();

  // Atajo: si el usuario ya está autenticado y tocó la barra inferior,
  // enrutar primero para responder al primer toque sin queries extra.
  if (
    botUser.is_authenticated &&
    (await routeBottomMenu(text, telegram_id, chat_id, msg.message_id))
  ) {
    return;
  }

  if (text === "/start" || text.startsWith("/start ")) {
    if (!(await tryAcquireStartLock(telegram_id))) return;
    const rawParam = text.startsWith("/start ") ? text.slice(7).trim() : "";
    const refMatch = rawParam.match(/ref(\d+)/i);
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
    return;
  }

  const st = await getState(telegram_id);
  // Solo borramos el mensaje del usuario si está ingresando la contraseña,
  // para no dejar credenciales visibles en el chat.
  if (st?.state === "login_password") {
    silentDelete("shop", chat_id, msg.message_id).catch(() => {});
  }

  if (st?.state === "login_name") {
    if (text.length < 2 || text.length > 40) {
      await screen(telegram_id, chat_id, `Nombre inválido. Ingresá entre 2 y 40 caracteres.`);
      return;
    }
    await askPassword(telegram_id, chat_id, text);
    return;
  }
  if (st?.state === "login_password") {
    if (text !== ACCESS_PASSWORD) {
      await screen(telegram_id, chat_id, `Contraseña incorrecta. Intentá de nuevo:`);
      return;
    }
    const name = (st.context?.display_name as string) ?? "Usuario";
    await updateUser(telegram_id, {
      is_authenticated: true,
      display_name: name,
    });
    await deliverBottomKeyboard(chat_id, `✨ Listo, <b>${name}</b>.`);
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
    if (n < MIN_RECHARGE_USD) {
      await screen(
    telegram_id,
        chat_id,
        `El monto mínimo es <b>${MIN_RECHARGE_USD.toFixed(2)} USD</b>. Probá de nuevo.`,
        [[{ text: "Volver", callback_data: "menu:recharge" }]],
      );
      return;
    }
    const cc = (st.context?.country_code as string) ?? "";
    await showRechargeMethods(telegram_id, chat_id, cc, Math.round(n * 100) / 100);
    return;
  }

  await showMainMenu(telegram_id, chat_id);
}


async function handleCallback(cb: TgCallback) {
  const telegram_id = cb.from.id;
  const chat_id = cb.message?.chat.id ?? telegram_id;
  if (await isBlocked(telegram_id)) {
    await answerCallbackQuery("shop", cb.id, "Bloqueado", true);
    return;
  }
  if (!(await checkRateLimit(telegram_id, "cb", 30, 10))) {
    await autoBlock(telegram_id, "spam_cb");
    await answerCallbackQuery("shop", cb.id);
    return;
  }
  const data = cb.data ?? "";

  if (data.startsWith("shlink:")) {
    const uname = await getShopBotUsername();
    const link = uname ? `https://t.me/${uname}?start=ref${telegram_id}` : "";
    answerCallbackQuery("shop", cb.id, link || "No disponible", true).catch(() => {});
    return;
  }
  // No esperamos al ACK del callback para responder más rápido
  answerCallbackQuery("shop", cb.id).catch(() => {});

  if (data === "menu:main") return showMainMenu(telegram_id, chat_id);
  if (data === "noop") return;
  if (data === "menu:profile") return showProfile(telegram_id, chat_id);
  if (data === "menu:products") return showProducts(telegram_id, chat_id);
  if (data === "menu:status") return showOrderStatus(telegram_id, chat_id);
  if (data === "menu:keys") return showMyKeys(telegram_id, chat_id);
  if (data === "menu:buy") return showBuyWithBalance(telegram_id, chat_id);
  if (data === "menu:recharge") return startRecharge(telegram_id, chat_id);
  if (data === "menu:support") return showSupport(telegram_id, chat_id);
  if (data === "menu:announcements") return showAnnouncements(telegram_id, chat_id);
  if (data.startsWith("anvw:")) return openAnnouncement(telegram_id, chat_id, data.slice(5));

  if (data.startsWith("cat:")) return showCategory(telegram_id, chat_id, data.slice(4));
  if (data.startsWith("prod:")) return showDurations(telegram_id, chat_id, data.slice(5));
  if (data.startsWith("dur:")) {
    await patchContext(telegram_id, { price_id: data.slice(4), qty: 1 });
    return payWithBalance(telegram_id, chat_id);
  }
  if (data.startsWith("rcc:")) return askRechargeAmount(telegram_id, chat_id, data.slice(4));
  if (data.startsWith("rcpay:")) return startRechargeReceipt(telegram_id, chat_id, data.slice(6));
}

async function showOrderStatus(telegram_id: number, chat_id: number) {
  const { data: orders } = await sb
    .from("orders")
    .select("id, status, total_usd, created_at, products(name), product_prices(duration_label)")
    .eq("telegram_id", telegram_id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (!orders || orders.length === 0) {
    return screen(telegram_id, chat_id, `No tenés órdenes.`, [BACK_BUTTON]);
  }
  const statusLabel: Record<string, string> = {
    delivered: "Entregado",
    pending_approval: "En revisión",
    pending_receipt: "Esperando comprobante",
    rejected: "Rechazado",
    approved: "Aprobado",
    pending: "Pendiente",
  };
  const blocks = orders.map((o) => {
    const p = (o as { products: { name: string } | null }).products;
    const pr = (o as { product_prices: { duration_label: string } | null }).product_prices;
    const date = new Date(o.created_at).toLocaleDateString("es");
    const name = p?.name ?? "—";
    const dur = pr?.duration_label ? ` ${pr.duration_label}` : "";
    const st = statusLabel[o.status] ?? o.status;
    return `<b>${escapeHtml(name)}${escapeHtml(dur)}</b>\n${st}\n$${Number(o.total_usd).toFixed(2)}\n${date}`;
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
  const blocks = keys.map((k) => {
    const ord = (k as { orders: { products: { name: string } | null; product_prices: { duration_label: string } | null } | null }).orders;
    const name = ord?.products?.name ?? "Producto";
    const dur = ord?.product_prices?.duration_label ? ` ${ord.product_prices.duration_label}` : "";
    return `<b>${escapeHtml(name)}${escapeHtml(dur)}</b>\n<code>${escapeHtml(k.key_value)}</code>`;
  });
  return screen(telegram_id, chat_id, `🔑 <b>Mis keys</b>\n\n${blocks.join("\n\n")}`, [BACK_BUTTON]);
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
  return screen(telegram_id, chat_id, `📣 <b>Anuncios</b>\n\n${blocks.join("\n\n")}`, kb);
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
    `<b>Recarga Aprobada</b>\n\n` +
      (pid ? `Pending: <code>${pid}</code>\n` : "") +
      `Monto Aprobado: <b>${opts.amount_usd.toFixed(2)} USD</b>\n` +
      `Saldo Agregado: <b>${opts.amount_usd.toFixed(2)} USD</b>\n` +
      `Saldo Disponible: <b>${opts.new_balance.toFixed(2)} USD</b>\n\n` +
      `Ya puedes utilizar tu saldo para realizar compras dentro del bot.`,
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
    `<b>Recarga Rechazada</b>\n\n` +
      (pid ? `Pending: <code>${pid}</code>\n` : "") +
      `Motivo: ${opts.note ?? "Sin especificar"}\n\n` +
      `Tu comprobante fue rechazado. Puedes enviar uno nuevo.`,
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
