// Admin Bot — handler (UI limpia, barra inferior persistente)
import {
  sendMessage as _rawSendMessage,
  editMessageReplyMarkup,
  deleteMessage,
  answerCallbackQuery,
  getAdminChatId,
  getFile,
  downloadFile,
  sendPhoto,
  sendPhotoMultipart,
  copyMessage,
} from "./api.server";
import {
  sb,
  checkRateLimit,
  blockUserPermanent,
  getState,
  patchContext,
} from "./db.server";
import {
  getHideOutOfStockSetting,
  getStockByPriceId,
  getVisibleCatalog,
  invalidateCatalogCache,
} from "./catalog.server";
import {
  notifyUserApproved,
  notifyUserRejected,
  notifyUserKey,
  recordAnnouncementDelivery,
} from "./shop-handler.server";

interface Update {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}
interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}
interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: { file_id: string; file_name?: string; mime_type?: string };
  video?: { file_id: string };
  audio?: { file_id: string };
  voice?: { file_id: string };
  forward_from?: unknown;
  forward_from_chat?: unknown;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
}
interface TgCallback {
  id: string;
  from: { id: number };
  message?: { chat: { id: number }; message_id: number; caption?: string };
  data?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Admin actualmente activo (para tracking de mensajes a limpiar)
let _currentAdminId: number | null = null;

async function sendMessage(
  bot: "shop" | "admin",
  chat_id: number | string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  const r = await _rawSendMessage(bot, chat_id, text, extra);
  if (bot === "admin" && r.ok && r.result && _currentAdminId) {
    trashPush(_currentAdminId, r.result.message_id).catch(() => {});
  }
  return r;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isAdmin(telegram_id: number) {
  return String(telegram_id) === String(getAdminChatId());
}

function shortId(id: string) {
  return id.slice(0, 8);
}
function tpId(createdAt: string) {
  return `TP${new Date(createdAt).getTime()}`;
}

// ===== Barra inferior persistente del admin =====
const ADMIN_BOTTOM = {
  pendientes: "📥 Pendientes",
  stock: "📦 Stock",
  usuarios: "👥 Usuarios",
  addkeys: "➕ Agregar Keys",
  precios: "💲 Precios",
  anuncio: "📣 Anuncio",
  metodos: "💳 Métodos",
  borrar: "🗑 Borrar",
};

function adminBottomKeyboard() {
  return {
    keyboard: [
      [{ text: ADMIN_BOTTOM.pendientes }, { text: ADMIN_BOTTOM.stock }],
      [{ text: ADMIN_BOTTOM.usuarios }, { text: ADMIN_BOTTOM.addkeys }],
      [{ text: ADMIN_BOTTOM.precios }, { text: ADMIN_BOTTOM.anuncio }],
      [{ text: ADMIN_BOTTOM.metodos }, { text: ADMIN_BOTTOM.borrar }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

async function resolvePriceId(rawId: string) {
  const normalized = rawId.trim();
  if (!normalized) return null;
  if (normalized.length === 36) return normalized;

  const { data } = await sb.from("product_prices").select("id").limit(200);
  const matches = (data ?? []).filter((row) => row.id.startsWith(normalized));
  if (matches.length !== 1) return null;
  return matches[0].id;
}

// Si el admin estuvo ausente más de este umbral, al volver se borran todos
// los mensajes de la sesión anterior. Los comprobantes pendientes nunca se
// tocan; los comprobantes ya revisados (aprobados/rechazados/key enviada)
// también se eliminan junto con el resto.
const ADMIN_IDLE_PURGE_MS = 90_000;

export async function handleAdminUpdate(update: Update): Promise<void> {
  const admin_id =
    (update.message?.from && isAdmin(update.message.from.id) && update.message.from.id) ||
    (update.callback_query?.from && isAdmin(update.callback_query.from.id) && update.callback_query.from.id) ||
    null;
  const chat_id =
    update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;

  if (admin_id && chat_id) {
    _currentAdminId = admin_id;
    // Si el admin "se salió" del chat (sin actividad por un rato), borramos
    // todo lo anterior antes de continuar. Si todavía está activo no tocamos
    // nada para no romper su navegación.
    const idleMs = await getIdleMs(admin_id);
    if (idleMs >= ADMIN_IDLE_PURGE_MS) {
      await purgeAdminTrash(chat_id, admin_id).catch(() => {});
      await purgeReviewedReceipts(chat_id).catch(() => {});
    }
    await touchAdminSeen(admin_id).catch(() => {});
    await ensureAdminBar(chat_id, admin_id).catch(() => {});
  }

  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } finally {
    _currentAdminId = null;
  }
}

async function getIdleMs(admin_id: number): Promise<number> {
  const st = await getState(admin_id);
  const ctx = (st?.context ?? {}) as Record<string, unknown>;
  const last = Number(ctx.last_seen_ms ?? 0);
  if (!last) return Number.POSITIVE_INFINITY;
  return Date.now() - last;
}

async function touchAdminSeen(admin_id: number) {
  await patchContext(admin_id, { last_seen_ms: Date.now() });
}

async function purgeReviewedReceipts(chat_id: number) {
  // Borrar comprobantes ya revisados (no pendientes) del chat del admin.
  const { data } = await sb
    .from("receipts")
    .select("admin_message_id, status")
    .neq("status", "pending")
    .not("admin_message_id", "is", null)
    .limit(200);
  if (!data || data.length === 0) return;
  await Promise.all(
    data.map((r) =>
      deleteMessage("admin", chat_id, r.admin_message_id as number).catch(() => {}),
    ),
  );
  // Limpiar referencias para no volver a intentar borrarlos.
  await sb
    .from("receipts")
    .update({ admin_message_id: null })
    .neq("status", "pending")
    .not("admin_message_id", "is", null);
}

// ===== Panel admin (inline) =====
async function showAdminPanel(chat_id: number) {
  await sendMessage("admin", chat_id, `<b>Panel Admin</b>\n\nElegí una opción:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Agregar Keys", callback_data: "akp:add" }],
        [{ text: "Ver Stock", callback_data: "akp:stock" }],
        [
          { text: "Pendientes", callback_data: "akp:pend" },
          { text: "Usuarios", callback_data: "akp:users" },
        ],
        [{ text: "Buscar Usuario", callback_data: "akp:finduser" }],
        [{ text: "Métodos de Pago", callback_data: "akp:pm" }],
        [{ text: "Anuncio", callback_data: "akp:anuncio" }],
      ],
    },
  });
}

// ===== Helpers de UX admin =====
async function ensureAdminBar(chat_id: number, admin_id: number) {
  const st = await getState(admin_id);
  const ctx = (st?.context ?? {}) as Record<string, unknown>;
  if (ctx.bar_shown) return;
  // Adjuntar la barra inferior sin mostrar texto visible
  const sent = await sendMessage("admin", chat_id, "\u2063", {
    reply_markup: adminBottomKeyboard(),
  });
  if (sent.ok && sent.result) {
    deleteMessage("admin", chat_id, sent.result.message_id).catch(() => {});
  }
  await patchContext(admin_id, { bar_shown: true });
}

// Limpieza de mensajes del admin (todo menos los comprobantes)
async function purgeAdminTrash(chat_id: number, admin_id: number) {
  const st = await getState(admin_id);
  const ctx = (st?.context ?? {}) as Record<string, unknown>;
  const trash = (ctx.trash_ids ?? []) as number[];
  if (trash.length === 0) return;
  await Promise.all(
    trash.map((mid) => deleteMessage("admin", chat_id, mid).catch(() => {})),
  );
  await patchContext(admin_id, { trash_ids: [] });
}

async function trashPush(admin_id: number, message_id: number) {
  const st = await getState(admin_id);
  const ctx = (st?.context ?? {}) as Record<string, unknown>;
  const trash = ((ctx.trash_ids ?? []) as number[]).slice(-200);
  trash.push(message_id);
  await patchContext(admin_id, { trash_ids: trash });
}

async function replaceAdminList(
  chat_id: number,
  admin_id: number,
  listKey: string,
  text: string,
  kb?: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
) {
  const st = await getState(admin_id);
  const ctx = (st?.context ?? {}) as Record<string, unknown>;
  const ids = (ctx.list_msgs ?? {}) as Record<string, number>;
  const prev = ids[listKey];
  if (prev) {
    deleteMessage("admin", chat_id, prev).catch(() => {});
  }
  const sent = await sendMessage("admin", chat_id, text, kb ? { reply_markup: { inline_keyboard: kb } } : {});
  if (sent.ok && sent.result) {
    ids[listKey] = sent.result.message_id;
    await patchContext(admin_id, { list_msgs: ids });
  }
}

async function markReceiptStatus(
  bot_chat_id: number,
  message_id: number,
  badge: string,
  detail?: string,
) {
  await editMessageReplyMarkup("admin", bot_chat_id, message_id, { inline_keyboard: [] }).catch(() => {});
  await sendMessage("admin", bot_chat_id, `${badge}${detail ? `  ·  ${detail}` : ""}`, {
    reply_to_message_id: message_id,
    allow_sending_without_reply: true,
  });
}



// ===== Gestión de métodos de pago =====
async function pmMenu(chat_id: number) {
  await sendMessage("admin", chat_id, `<b>Gestión de Métodos de Pago</b>`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Agregar Método", callback_data: "pm:add" }],
        [{ text: "Editar Método", callback_data: "pm:editlist" }],
        [{ text: "Eliminar Método", callback_data: "pm:dellist" }],
        [{ text: "Países Disponibles", callback_data: "pm:countries" }],
      ],
    },
  });
}

async function pmListAll(chat_id: number, mode: "edit" | "del") {
  const { data: methods } = await sb
    .from("payment_methods")
    .select("id, country_code, country_name, method_name, active")
    .order("country_name");
  if (!methods || methods.length === 0) {
    await sendMessage("admin", chat_id, `No hay métodos cargados.`);
    return;
  }
  const kb = methods.map((m) => [
    {
      text: `${m.country_name} · ${m.method_name}${m.active ? "" : " (off)"}`,
      callback_data: `pm:${mode === "edit" ? "edit" : "del"}:${m.id}`,
    },
  ]);
  await sendMessage(
    "admin",
    chat_id,
    `<b>${mode === "edit" ? "Editar" : "Eliminar"} Método</b>\n\nElegí uno:`,
    { reply_markup: { inline_keyboard: kb } },
  );
}

async function pmCountriesView(chat_id: number) {
  const { data: methods } = await sb
    .from("payment_methods")
    .select("country_code, country_name, active");
  const map = new Map<string, { name: string; on: number; off: number }>();
  for (const m of methods ?? []) {
    const cur = map.get(m.country_code) ?? { name: m.country_name, on: 0, off: 0 };
    if (m.active) cur.on++;
    else cur.off++;
    map.set(m.country_code, cur);
  }
  const lines = [...map.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([code, v]) => `${v.name} (${code})  ·  activos ${v.on}  ·  inactivos ${v.off}`)
    .join("\n");
  await sendMessage("admin", chat_id, `<b>Países disponibles</b>\n\n${lines || "Sin datos."}`);
}

async function pmEditMenu(chat_id: number, pm_id: string) {
  const { data: m } = await sb.from("payment_methods").select("*").eq("id", pm_id).maybeSingle();
  if (!m) {
    await sendMessage("admin", chat_id, `Método no encontrado.`);
    return;
  }
  const text =
    `<b>${m.country_name} · ${m.method_name}</b>\n` +
    `Titular  <code>${m.holder_name}</code>\n` +
    `Cuenta   <code>${m.account_info}</code>\n` +
    `Nota     ${m.extra_info ?? "—"}\n` +
    `Moneda   ${m.currency}\n` +
    `Rate USD ${Number(m.usd_rate)}\n` +
    `Estado   ${m.active ? "Activo" : "Inactivo"}\n`;
  await sendMessage("admin", chat_id, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Método", callback_data: `pmf:method_name:${pm_id}` },
          { text: "Titular", callback_data: `pmf:holder_name:${pm_id}` },
        ],
        [
          { text: "Cuenta", callback_data: `pmf:account_info:${pm_id}` },
          { text: "Nota", callback_data: `pmf:extra_info:${pm_id}` },
        ],
        [
          { text: "País (nombre)", callback_data: `pmf:country_name:${pm_id}` },
          { text: "País (código)", callback_data: `pmf:country_code:${pm_id}` },
        ],
        [
          { text: "Moneda", callback_data: `pmf:currency:${pm_id}` },
          { text: "Rate USD", callback_data: `pmf:usd_rate:${pm_id}` },
        ],
        [
          { text: m.active ? "Desactivar" : "Activar", callback_data: `pmtog:${pm_id}` },
        ],
        [{ text: "Volver", callback_data: "pm:editlist" }],
      ],
    },
  });
}

async function pmPromptField(chat_id: number, pm_id: string, field: string) {
  await sendMessage(
    "admin",
    chat_id,
    `<b>PMEDIT:${pm_id}:${field}</b>\n\nRespondé a este mensaje con el nuevo valor para <b>${field}</b>.`,
    { reply_markup: { force_reply: true, selective: true } },
  );
}

async function pmPromptAdd(chat_id: number) {
  await sendMessage(
    "admin",
    chat_id,
    `<b>PMADD</b>\n\nRespondé a este mensaje con los datos del nuevo método, una línea por campo en este orden:\n\n` +
      `<code>country_code\ncountry_name\nmethod_name\nholder_name\naccount_info\nextra_info (opcional)\ncurrency (default USD)\nusd_rate (default 1)</code>`,
    { reply_markup: { force_reply: true, selective: true } },
  );
}

async function pmConfirmDelete(chat_id: number, pm_id: string) {
  const { data: m } = await sb.from("payment_methods").select("country_name, method_name").eq("id", pm_id).maybeSingle();
  if (!m) {
    await sendMessage("admin", chat_id, `Método no encontrado.`);
    return;
  }
  await sendMessage(
    "admin",
    chat_id,
    `¿Eliminar <b>${m.country_name} · ${m.method_name}</b>?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Confirmar eliminación", callback_data: `pmdel:${pm_id}` },
            { text: "Cancelar", callback_data: "pm:dellist" },
          ],
        ],
      },
    },
  );
}


async function adminListProducts(chat_id: number) {
  const { data: products } = await sb
    .from("products")
    .select("id, name, category")
    .eq("active", true)
    .order("sort_order");
  if (!products || products.length === 0) {
    await sendMessage("admin", chat_id, `No hay productos cargados.`);
    return;
  }
  const kb = products.map((p) => [
    { text: `${p.name}  ·  ${p.category}`, callback_data: `akprod:${p.id}` },
  ]);
  await sendMessage("admin", chat_id, `<b>Agregar Keys</b>\n\nElegí el producto:`, {
    reply_markup: { inline_keyboard: kb },
  });
}

async function adminListDurations(chat_id: number, product_id: string) {
  const { data: prices } = await sb
    .from("product_prices")
    .select("id, duration_label, products(name)")
    .eq("product_id", product_id)
    .eq("active", true)
    .order("sort_order");
  if (!prices || prices.length === 0) {
    await sendMessage("admin", chat_id, `Ese producto no tiene duraciones cargadas.`);
    return;
  }
  const name = (prices[0] as { products: { name: string } }).products.name;
  const kb = prices.map((p) => [
    { text: `${p.duration_label}`, callback_data: `akdur:${p.id}` },
  ]);
  await sendMessage("admin", chat_id, `<b>${name}</b>\n\nElegí la duración:`, {
    reply_markup: { inline_keyboard: kb },
  });
}

async function adminPromptKeys(chat_id: number, price_id: string) {
  const { data: price } = await sb
    .from("product_prices")
    .select("id, duration_label, products(name)")
    .eq("id", price_id)
    .maybeSingle();
  if (!price) {
    await sendMessage("admin", chat_id, `Variante no encontrada.`);
    return;
  }
  await sendMessage(
    "admin",
    chat_id,
    `<b>ADDKEYS:${price_id}</b>\n${(price as { products: { name: string } }).products.name}  ·  ${price.duration_label}\n\n` +
      `Respondé a este mensaje pegando las keys (una por línea). Podés pegar muchas a la vez.`,
  );
}

async function adminStockView(chat_id: number) {
  const [productsRes, pricesRes] = await Promise.all([
    sb.from("products").select("id, name, category").eq("active", true).order("sort_order"),
    sb
      .from("product_prices")
      .select("id, product_id, duration_label")
      .eq("active", true)
      .order("sort_order"),
  ]);
  const products = productsRes.data ?? [];
  const prices = pricesRes.data ?? [];
  const stock = await getStockByPriceId();

  if (products.length === 0) {
    await sendMessage("admin", chat_id, `No hay productos cargados.`);
    return;
  }

  const lines: string[] = [];
  let grandTotal = 0;
  for (const product of products) {
    const productPrices = prices.filter((p) => p.product_id === product.id);
    const productTotal = productPrices.reduce((sum, p) => sum + (stock.get(p.id) ?? 0), 0);
    grandTotal += productTotal;
    lines.push(`\n<b>${product.name}</b>  ·  total ${productTotal}`);
    for (const p of productPrices) {
      lines.push(`   ${p.duration_label}   ${stock.get(p.id) ?? 0}`);
    }
  }

  await sendMessage(
    "admin",
    chat_id,
    `<b>Stock disponible</b>\nTotal general  <b>${grandTotal}</b>\n${lines.join("\n")}`,
  );
}

function adminId() {
  return Number(getAdminChatId() ?? 0);
}

async function adminPendientes(chat_id: number) {
  const { data: orders } = await sb
    .from("orders")
    .select("id, telegram_id, total_usd, order_type, created_at, products(name)")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: false })
    .limit(20);
  if (!orders || orders.length === 0) {
    await replaceAdminList(chat_id, adminId(), "pendientes", `<b>Pendientes</b>\n\nNo hay órdenes pendientes.`);
    return;
  }
  const lines: string[] = [];
  const kb: Array<Array<{ text: string; callback_data?: string }>> = [];
  orders.forEach((o, i) => {
    const label =
      o.order_type === "recharge"
        ? "Recarga"
        : (o as { products: { name: string } | null }).products?.name ?? "—";
    const n = i + 1;
    lines.push(
      `<b>${n}.</b> <code>${o.id.slice(0, 8)}</code> · <code>${o.telegram_id}</code> · $${Number(o.total_usd).toFixed(2)} · ${label}`,
    );
    kb.push([
      { text: `${n} Aprobar`, callback_data: `ord:approve:${o.id}` },
      { text: `${n} Rechazar`, callback_data: `ord:reject:${o.id}` },
    ]);
  });
  await replaceAdminList(
    chat_id,
    adminId(),
    "pendientes",
    `<b>Pendientes (${orders.length})</b>\n\n${lines.join("\n")}`,
    kb,
  );
}

const USERS_PAGE_SIZE = 8;

async function adminUsuarios(chat_id: number, page = 0) {
  const { count } = await sb.from("bot_users").select("id", { count: "exact", head: true });
  const total = count ?? 0;
  const from = page * USERS_PAGE_SIZE;
  const to = from + USERS_PAGE_SIZE - 1;
  const { data: users } = await sb
    .from("bot_users")
    .select("telegram_id, username, display_name, balance, total_recharged, rank, last_seen_at")
    .order("last_seen_at", { ascending: false })
    .range(from, to);

  if (!users || users.length === 0) {
    await replaceAdminList(chat_id, adminId(), "usuarios", `<b>Usuarios</b>  ·  Total ${total}\n\nSin usuarios.`);
    return;
  }

  const lines = users.map((u, i) => {
    const idx = from + i + 1;
    const name = escapeHtml(u.display_name ?? u.username ?? "—");
    return `${idx}. <b>${name}</b>\n<code>${u.telegram_id}</code>`;
  });

  const kb: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
  for (let i = 0; i < users.length; i += 2) {
    const row = [{ text: `${from + i + 1}`, callback_data: `akusr:${users[i].telegram_id}` }];
    if (users[i + 1]) row.push({ text: `${from + i + 2}`, callback_data: `akusr:${users[i + 1].telegram_id}` });
    kb.push(row);
  }
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) nav.push({ text: "◀", callback_data: `akusrp:${page - 1}` });
  if (to + 1 < total) nav.push({ text: "▶", callback_data: `akusrp:${page + 1}` });
  if (nav.length > 0) kb.push(nav);
  kb.push([{ text: "Buscar por ID", callback_data: "akp:finduser" }]);

  await replaceAdminList(
    chat_id,
    adminId(),
    "usuarios",
    `<b>Usuarios</b>  ·  ${total}  ·  pág ${page + 1}/${Math.max(1, Math.ceil(total / USERS_PAGE_SIZE))}\n\n${lines.join("\n\n")}`,
    kb,
  );
}

async function adminPromptFindUser(chat_id: number) {
  await sendMessage(
    "admin",
    chat_id,
    `<b>Buscar usuario</b>\n\nRespondé a este mensaje con el ID de Telegram del usuario.`,
    { reply_markup: { force_reply: true, selective: true } },
  );
}

async function adminUserDetail(chat_id: number, telegram_id: number) {
  const { data: u } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  if (!u) {
    await sendMessage("admin", chat_id, `Usuario no encontrado.`);
    return;
  }
  const [{ count: ordersCount }, { count: deliveredCount }, { data: lastOrders }, { data: blocked }] = await Promise.all([
    sb.from("orders").select("id", { count: "exact", head: true }).eq("telegram_id", telegram_id),
    sb
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("telegram_id", telegram_id)
      .eq("status", "delivered"),
    sb
      .from("orders")
      .select("id, status, total_usd, created_at, products(name)")
      .eq("telegram_id", telegram_id)
      .order("created_at", { ascending: false })
      .limit(5),
    sb
      .from("blocked_users")
      .select("blocked_until, reason")
      .eq("telegram_id", telegram_id)
      .maybeSingle(),
  ]);

  const blockedTxt = blocked
    ? blocked.blocked_until
      ? `Bloqueado hasta ${new Date(blocked.blocked_until).toLocaleString("es")}`
      : `Bloqueado permanente`
    : `Activo`;

  const ordersLines =
    (lastOrders ?? [])
      .map((o) => {
        const name = (o as { products: { name: string } | null }).products?.name ?? "—";
        return `${o.status}  ·  $${Number(o.total_usd).toFixed(2)}  ·  ${name}  ·  ${new Date(o.created_at).toLocaleDateString("es")}`;
      })
      .join("\n") || "Sin órdenes.";

  const usernameLine = u.username
    ? `Username  <a href="https://t.me/${u.username}">@${escapeHtml(u.username)}</a>`
    : `Username  <i>no disponible</i>`;

  const text =
    `<b>Detalle de usuario</b>\n\n` +
    `Nombre    <b>${escapeHtml(u.display_name ?? "—")}</b>\n` +
    `${usernameLine}\n` +
    `Telegram  <code>${u.telegram_id}</code>\n` +
    `Chat      <code>${u.chat_id}</code>\n` +
    `Saldo     <b>$${Number(u.balance).toFixed(2)} USD</b>\n` +
    `Recargado $${Number(u.total_recharged).toFixed(2)} USD\n` +
    `Rango     ${u.rank}\n` +
    `Órdenes   ${ordersCount ?? 0}  ·  Entregadas ${deliveredCount ?? 0}\n` +
    `Registro  ${new Date(u.registered_at).toLocaleString("es")}\n` +
    `Visto     ${new Date(u.last_seen_at).toLocaleString("es")}\n` +
    `Estado    ${blockedTxt}\n\n` +
    `<b>Últimas órdenes</b>\n${ordersLines}`;

  const buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
  if (u.username) {
    buttons.push([{ text: `Escribir a @${u.username}`, url: `https://t.me/${u.username}` }]);
  }
  buttons.push([
    { text: "Enviar mensaje directo", callback_data: `akusrmsg:${u.telegram_id}` },
  ]);
  buttons.push(
    blocked
      ? [{ text: "Desbloquear", callback_data: `akusrunblock:${u.telegram_id}` }]
      : [{ text: "Bloquear", callback_data: `adm:block:${u.telegram_id}` }],
  );
  buttons.push([{ text: "Volver", callback_data: "akp:users" }]);

  await sendMessage("admin", chat_id, text, {
    reply_markup: { inline_keyboard: buttons },
    disable_web_page_preview: true,
  });
}

async function adminPromptAnuncio(chat_id: number) {
  // Activar estado "esperando anuncio" — el admin puede salir del bot y reenviar
  // cualquier mensaje (texto, foto, documento, video…) y el siguiente que llegue
  // será enviado a todos los usuarios.
  await patchContext(Number(adminId()), { awaiting_broadcast: Date.now() });
  await sendMessage(
    "admin",
    chat_id,
    `<b>Anuncio</b>\n\nEnviá o reenviá ahora cualquier mensaje (texto, foto, documento, video…) y se transmitirá a todos los usuarios.\n\nTenés 10 minutos. Para cancelar escribí /cancelar.`,
  );
}

async function adminListaPrecios(chat_id: number) {
  const hideOutOfStock = await getHideOutOfStockSetting();
  const { grouped } = await getVisibleCatalog();
  const lines = grouped
    .flatMap((section) => [
      `${section.category}`,
      ...section.products.flatMap((product) =>
        product.prices.map(
          (price) =>
            `   ${product.name} / ${price.duration_label}  ·  $${Number(price.price_usd).toFixed(2)}  ·  stock ${price.available_stock}  ·  <code>${shortId(price.id)}</code>`,
        ),
      ),
    ])
    .join("\n");
  await sendMessage(
    "admin",
    chat_id,
    `<b>Catálogo</b>\nOcultar sin stock  <b>${hideOutOfStock ? "ON" : "OFF"}</b>\n\n${lines || "Sin variantes cargadas."}`,
  );
}

// ===== Acreditar recarga =====
async function creditRecharge(
  order: { id: string; user_id: string; status: string },
  amount: number,
  adminId: number,
  chat_id: number,
) {
  if (order.status === "approved") {
    await sendMessage("admin", chat_id, `Esa recarga ya fue aprobada.`);
    return;
  }
  const { data: u } = await sb
    .from("bot_users")
    .select("id, telegram_id, chat_id, balance, total_recharged")
    .eq("id", order.user_id)
    .single();
  if (!u) {
    await sendMessage("admin", chat_id, `Usuario no encontrado.`);
    return;
  }
  const newBalance = Number(u.balance) + amount;
  const newRecharged = Number(u.total_recharged) + amount;
  let rank: "normal" | "pro" | "leyenda" = "normal";
  if (newRecharged >= 200) rank = "leyenda";
  else if (newRecharged >= 50) rank = "pro";

  await Promise.all([
    sb
      .from("bot_users")
      .update({ balance: newBalance, total_recharged: newRecharged, rank })
      .eq("id", u.id),
    sb.from("orders").update({ status: "approved", total_usd: amount }).eq("id", order.id),
    sb.from("receipts").update({ status: "approved" }).eq("order_id", order.id),
    sb.from("admin_logs").insert({
      admin_telegram_id: adminId,
      action: "approve_recharge",
      target_type: "order",
      target_id: order.id,
      details: { amount_usd: amount } as never,
    }),
  ]);

  await notifyUserApproved({
    telegram_id: u.telegram_id,
    chat_id: u.chat_id,
    amount_usd: amount,
    new_balance: newBalance,
  });

  await sendMessage(
    "admin",
    chat_id,
    `<b>Recarga aprobada</b>  ·  $${amount.toFixed(2)} USD acreditados.\nNuevo saldo del usuario  $${newBalance.toFixed(2)}`,
  );
}

// ===== Anuncio (broadcast usando copyMessage, soporta cualquier tipo) =====
async function handleBroadcast(msg: TgMessage) {
  const { data: users } = await sb.from("bot_users").select("telegram_id, chat_id");
  const targets = (users ?? []).filter((u) => u.chat_id);
  if (targets.length === 0) {
    await sendMessage("admin", msg.chat.id, `No hay usuarios para enviar el anuncio.`);
    return;
  }

  // Preview corto: texto, caption, o nombre de archivo.
  const preview =
    (msg.text ?? "").trim() ||
    (msg.caption ?? "").trim() ||
    (msg.document?.file_name ? `Archivo: ${msg.document.file_name}` : "") ||
    (msg.photo ? "Imagen" : "") ||
    (msg.video ? "Video" : "") ||
    (msg.voice || msg.audio ? "Audio" : "") ||
    "Anuncio";

  const { data: ann } = await sb
    .from("announcements")
    .insert({
      preview: preview.slice(0, 200),
      source_chat_id: msg.chat.id,
      source_message_id: msg.message_id,
    })
    .select()
    .single();
  if (!ann) {
    await sendMessage("admin", msg.chat.id, `No pude registrar el anuncio.`);
    return;
  }

  await sendMessage("admin", msg.chat.id, `Enviando anuncio a ${targets.length} usuarios…`);

  let ok = 0;
  let fail = 0;
  for (const u of targets) {
    const r = await copyMessage("shop", u.chat_id, msg.chat.id, msg.message_id);
    if (r.ok && r.result) {
      ok++;
      await recordAnnouncementDelivery({
        announcement_id: ann.id,
        telegram_id: u.telegram_id,
        chat_id: u.chat_id,
        message_id: r.result.message_id,
      });
    } else {
      fail++;
    }
    await sleep(35);
  }

  await sb
    .from("announcements")
    .update({ total_sent: ok, total_failed: fail })
    .eq("id", ann.id);

  await sendMessage(
    "admin",
    msg.chat.id,
    `<b>Anuncio finalizado</b>\nEntregados  <b>${ok}</b>\nFallidos    <b>${fail}</b>`,
  );
}

// ===== Mensajes =====
async function handleMessage(msg: TgMessage) {
  if (!msg.from) return;
  if (!isAdmin(msg.from.id)) {
    await sendMessage("admin", msg.chat.id, `No autorizado.`);
    return;
  }
  if (!(await checkRateLimit(msg.from.id, "admin_msg", 30, 10))) return;

  const text = (msg.text ?? "").trim();

  // ===== Cancelar broadcast en espera =====
  if (text === "/cancelar") {
    await patchContext(msg.from.id, { awaiting_broadcast: 0 });
    await sendMessage("admin", msg.chat.id, `Cancelado.`);
    return;
  }

  // ===== Modo broadcast activo: capturar el siguiente mensaje y enviarlo =====
  const st = await getState(msg.from.id);
  const awaiting = Number(((st?.context as Record<string, unknown>)?.awaiting_broadcast as number) ?? 0);
  if (awaiting && Date.now() - awaiting < 10 * 60 * 1000) {
    // Ignorar pulsaciones de la barra inferior mientras se espera contenido
    const bottomLabels = Object.values(ADMIN_BOTTOM);
    if (!bottomLabels.includes(text)) {
      await patchContext(msg.from.id, { awaiting_broadcast: 0 });
      await handleBroadcast(msg);
      return;
    }
  }

  // ===== respuestas (reply) =====
  if (msg.reply_to_message) {
    const replySource = `${msg.reply_to_message.text ?? ""}\n${msg.reply_to_message.caption ?? ""}`;



    // ===== Rechazo con motivo =====
    const rejectMatch = replySource.match(/REJECT:([a-f0-9-]{36})(?::(\d+))?/);
    if (rejectMatch) {
      const orderId = rejectMatch[1];
      const photoMid = rejectMatch[2] ? parseInt(rejectMatch[2], 10) : 0;
      const note = text || "Sin motivo";
      const { data: order } = await sb
        .from("orders")
        .select("*, bot_users(telegram_id, chat_id)")
        .eq("id", orderId)
        .single();
      if (!order) {
        await sendMessage("admin", msg.chat.id, `Orden no encontrada.`);
        return;
      }
      await Promise.all([
        sb.from("orders").update({ status: "rejected", admin_note: note }).eq("id", orderId),
        sb.from("receipts").update({ status: "rejected" }).eq("order_id", orderId),
        sb.from("admin_logs").insert({
          admin_telegram_id: msg.from.id,
          action: "reject_order",
          target_type: "order",
          target_id: orderId,
          details: { note } as never,
        }),
      ]);
      const u = (order as { bot_users: { telegram_id: number; chat_id: number } }).bot_users;
      await notifyUserRejected({ telegram_id: u.telegram_id, chat_id: u.chat_id, note, pending: tpId(order.created_at) });
      // Limpiar el prompt y marcar el comprobante visualmente
      deleteMessage("admin", msg.chat.id, msg.reply_to_message.message_id).catch(() => {});
      deleteMessage("admin", msg.chat.id, msg.message_id).catch(() => {});
      if (photoMid > 0) {
        await markReceiptStatus(msg.chat.id, photoMid, `❌ RECHAZADO`, note.slice(0, 60));
      } else {
        await sendMessage("admin", msg.chat.id, `❌ Rechazado · ${escapeHtml(note)}`);
      }
      await adminPendientes(msg.chat.id);
      return;
    }


    // ===== Editar método de pago =====
    const pmEditMatch = replySource.match(/PMEDIT:([a-f0-9-]{36}):(\w+)/);
    if (pmEditMatch) {
      const [, pmId, field] = pmEditMatch;
      const allowed = ["country_code", "country_name", "method_name", "holder_name", "account_info", "extra_info", "currency", "usd_rate"];
      if (!allowed.includes(field)) {
        await sendMessage("admin", msg.chat.id, `Campo no permitido.`);
        return;
      }
      let value: string | number = text;
      if (field === "usd_rate") {
        const n = Number(text.replace(",", "."));
        if (!Number.isFinite(n) || n <= 0) { await sendMessage("admin", msg.chat.id, `Rate inválido.`); return; }
        value = n;
      }
      const patch: Record<string, string | number | null> = { [field]: field === "extra_info" && !text ? null : value };
      const { error } = await sb.from("payment_methods").update(patch as never).eq("id", pmId);
      if (error) { await sendMessage("admin", msg.chat.id, `Error: ${error.message}`); return; }
      await sb.from("admin_logs").insert({ admin_telegram_id: msg.from.id, action: "pm_edit", target_type: "payment_method", target_id: pmId, details: { field, value } as never });
      await sendMessage("admin", msg.chat.id, `Campo <b>${field}</b> actualizado.`);
      await pmEditMenu(msg.chat.id, pmId);
      return;
    }

    // ===== Agregar método de pago =====
    if (replySource.includes("PMADD")) {
      const lines = text.split(/\r?\n/).map((l) => l.trim());
      if (lines.length < 5) {
        await sendMessage("admin", msg.chat.id, `Faltan campos. Mínimo 5 líneas.`);
        return;
      }
      const [country_code, country_name, method_name, holder_name, account_info, extra_info, currency, usd_rate] = lines;
      const rate = Number((usd_rate ?? "1").replace(",", "."));
      const { data, error } = await sb.from("payment_methods").insert({
        country_code,
        country_name,
        method_name,
        holder_name,
        account_info,
        extra_info: extra_info || null,
        currency: currency || "USD",
        usd_rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
        active: true,
      }).select().single();
      if (error || !data) { await sendMessage("admin", msg.chat.id, `Error: ${error?.message ?? "desconocido"}`); return; }
      await sb.from("admin_logs").insert({ admin_telegram_id: msg.from.id, action: "pm_add", target_type: "payment_method", target_id: data.id });
      await sendMessage("admin", msg.chat.id, `Método agregado para ${country_name}.`);
      return;
    }

    // ===== Buscar usuario por ID =====
    if (replySource.includes("FINDUSER")) {
      const id = parseInt(text.replace(/\D/g, ""), 10);
      if (!Number.isFinite(id) || id <= 0) {
        await sendMessage("admin", msg.chat.id, `ID inválido.`);
        return;
      }
      await adminUserDetail(msg.chat.id, id);
      return;
    }




    const msgUserMatch = replySource.match(/MSGUSER:(\d+)/);
    if (msgUserMatch) {
      const tgId = parseInt(msgUserMatch[1], 10);
      const { data: target } = await sb
        .from("bot_users")
        .select("chat_id, display_name, username")
        .eq("telegram_id", tgId)
        .maybeSingle();
      if (!target) {
        await sendMessage("admin", msg.chat.id, `Usuario no encontrado.`);
        return;
      }
      const body = (msg.text ?? msg.caption ?? "").trim();
      if (msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        const fileInfo = await getFile("admin", photo.file_id);
        if (!fileInfo.ok || !fileInfo.result) {
          await sendMessage("admin", msg.chat.id, `No pude procesar la imagen.`);
          return;
        }
        const bytes = await downloadFile("admin", fileInfo.result.file_path);
        if (!bytes) {
          await sendMessage("admin", msg.chat.id, `No pude descargar la imagen.`);
          return;
        }
        const caption = body ? `<b>Mensaje del Admin</b>\n\n${escapeHtml(body)}` : `<b>Mensaje del Admin</b>`;
        const r = await sendPhotoMultipart("shop", target.chat_id, bytes, "admin.jpg", caption);
        await sendMessage(
          "admin",
          msg.chat.id,
          r.ok ? `Imagen enviada a ${target.display_name ?? tgId}.` : `No se pudo enviar.`,
        );
      } else {
        if (!body) {
          await sendMessage("admin", msg.chat.id, `Mensaje vacío.`);
          return;
        }
        const r = await sendMessage(
          "shop",
          target.chat_id,
          `<b>Mensaje del Admin</b>\n\n${escapeHtml(body)}`,
        );
        await sendMessage(
          "admin",
          msg.chat.id,
          r.ok ? `Mensaje enviado a ${target.display_name ?? tgId}.` : `No se pudo enviar.`,
        );
      }
      await sb.from("admin_logs").insert({
        admin_telegram_id: msg.from.id,
        action: "dm_user",
        target_type: "telegram_id",
        target_id: String(tgId),
        details: { preview: body.slice(0, 200) } as never,
      });
      return;
    }

    const { data: ord } = await sb
      .from("orders")
      .select("id, telegram_id, user_id, product_id, price_id, keys_qty, order_type, total_usd, status")
      .eq("admin_message_id", msg.reply_to_message.message_id)
      .maybeSingle();

    if (ord && ord.order_type === "recharge") {
      const amount = Number(text.replace(",", "."));
      if (!Number.isFinite(amount) || amount <= 0) {
        await sendMessage("admin", msg.chat.id, `Monto inválido. Respondé con un número en USD, ej: 10`);
        return;
      }
      await creditRecharge(ord, amount, msg.from.id, msg.chat.id);
      return;
    }

    if (ord && text.length > 0) {
      await Promise.all([
        sb.from("order_keys").insert({
          order_id: ord.id,
          user_id: ord.user_id,
          key_value: text,
        }),
        sb.from("orders").update({ status: "delivered" }).eq("id", ord.id),
      ]);
      const [{ data: u }, { data: prod }, { data: pr }] = await Promise.all([
        sb.from("bot_users").select("telegram_id, chat_id").eq("id", ord.user_id).single(),
        ord.product_id
          ? sb.from("products").select("name").eq("id", ord.product_id).maybeSingle()
          : Promise.resolve({ data: null }),
        ord.price_id
          ? sb.from("product_prices").select("duration_label").eq("id", ord.price_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      if (u) {
        await notifyUserKey({
          telegram_id: u.telegram_id,
          chat_id: u.chat_id,
          key_value: text,
          product_name: (prod as { name: string } | null)?.name,
          duration_label: (pr as { duration_label: string } | null)?.duration_label,
        });
      }
      // Limpieza visual
      deleteMessage("admin", msg.chat.id, msg.message_id).catch(() => {});
      if (msg.reply_to_message) {
        deleteMessage("admin", msg.chat.id, msg.reply_to_message.message_id).catch(() => {});
      }
      // Marcar el comprobante original (si existe vía receipts)
      const { data: receipt } = await sb
        .from("receipts")
        .select("admin_message_id")
        .eq("order_id", ord.id)
        .maybeSingle();
      if (receipt?.admin_message_id) {
        await markReceiptStatus(msg.chat.id, receipt.admin_message_id, `KEY ENVIADA`, String(u?.telegram_id ?? ord.telegram_id));
      } else {
        await sendMessage("admin", msg.chat.id, `Key enviada a <code>${u?.telegram_id ?? ord.telegram_id}</code>.`);
      }
      return;
    }


    const addKeysMatch = replySource.match(/ADDKEYS:([a-f0-9-]{36})/i);
    if (addKeysMatch && text.length > 0) {
      const priceId = addKeysMatch[1];
      const { data: price } = await sb
        .from("product_prices")
        .select("id, product_id, duration_label, products(name)")
        .eq("id", priceId)
        .single();
      if (!price) {
        await sendMessage("admin", msg.chat.id, `Variante no encontrada.`);
        return;
      }

      const parsedKeys = [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
      if (parsedKeys.length === 0) {
        await sendMessage("admin", msg.chat.id, `No detecté keys válidas.`);
        return;
      }

      const { data: existing } = await sb
        .from("product_stock_keys")
        .select("key_value")
        .in("key_value", parsedKeys);
      const existingSet = new Set((existing ?? []).map((row) => row.key_value));
      const newKeys = parsedKeys.filter((value) => !existingSet.has(value));

      if (newKeys.length > 0) {
        await sb.from("product_stock_keys").insert(
          newKeys.map((key_value) => ({
            product_id: price.product_id,
            price_id: price.id,
            key_value,
          })),
        );
        invalidateCatalogCache();
      }

      await sendMessage(
        "admin",
        msg.chat.id,
        `<b>Keys cargadas</b>  ·  ${(price as { products: { name: string } }).products.name} / ${price.duration_label}\nNuevas  ${newKeys.length}\nDuplicadas omitidas  ${parsedKeys.length - newKeys.length}`,
      );
      return;
    }
  }

  // ===== barra inferior persistente =====
  switch (text) {
    case ADMIN_BOTTOM.pendientes:
      await adminPendientes(msg.chat.id);
      return;
    case ADMIN_BOTTOM.stock:
      await adminStockView(msg.chat.id);
      return;
    case ADMIN_BOTTOM.usuarios:
      await adminUsuarios(msg.chat.id);
      return;
    case ADMIN_BOTTOM.addkeys:
      await adminListProducts(msg.chat.id);
      return;
    case ADMIN_BOTTOM.precios:
      await adminListaPrecios(msg.chat.id);
      return;
    case ADMIN_BOTTOM.anuncio:
      await adminPromptAnuncio(msg.chat.id);
      return;
    case ADMIN_BOTTOM.metodos:
      await pmMenu(msg.chat.id);
      return;
  }

  if (text === "/start" || text === "/help" || text === "/panel") {
    // Solo mostrar la barra inferior, sin panel ni listas de comandos.
    await sendMessage(
      "admin",
      msg.chat.id,
      `Listo. Usá la barra inferior.`,
      { reply_markup: adminBottomKeyboard() },
    );
    await patchContext(msg.from.id, { bar_shown: true });
    return;
  }

  if (text === "/pendientes") return adminPendientes(msg.chat.id);
  if (text === "/stock") return adminStockView(msg.chat.id);
  if (text === "/precios") return adminListaPrecios(msg.chat.id);

  if (text.startsWith("/setprecio ")) {
    const [, rawPriceId, rawUsd] = text.split(/\s+/);
    const newValue = Number(rawUsd);
    if (!rawPriceId || !rawUsd || !Number.isFinite(newValue) || newValue <= 0) {
      await sendMessage("admin", msg.chat.id, `Uso: /setprecio &lt;priceId&gt; &lt;usd&gt;`);
      return;
    }
    const priceId = await resolvePriceId(rawPriceId);
    if (!priceId) {
      await sendMessage("admin", msg.chat.id, `ID de variante inválido o ambiguo. Usá /precios.`);
      return;
    }
    const { data: updated } = await sb
      .from("product_prices")
      .update({ price_usd: newValue })
      .eq("id", priceId)
      .select("id, duration_label, products(name)")
      .maybeSingle();
    if (!updated) {
      await sendMessage("admin", msg.chat.id, `No encontré esa variante. Usá /precios.`);
      return;
    }
    invalidateCatalogCache();
    await sendMessage(
      "admin",
      msg.chat.id,
      `<b>Precio actualizado</b>  ·  ${(updated as { products: { name: string } }).products.name} / ${updated.duration_label}  →  $${newValue.toFixed(2)}`,
    );
    return;
  }

  if (text.startsWith("/addkeys ")) {
    const [, priceId] = text.split(/\s+/);
    const resolvedPriceId = await resolvePriceId(priceId ?? "");
    if (!resolvedPriceId) {
      await sendMessage("admin", msg.chat.id, `Uso: /addkeys &lt;priceId&gt;`);
      return;
    }
    await adminPromptKeys(msg.chat.id, resolvedPriceId);
    return;
  }

  if (text.startsWith("/ocultar_sin_stock ")) {
    const [, mode] = text.split(/\s+/);
    if (!["on", "off"].includes(mode)) {
      await sendMessage("admin", msg.chat.id, `Uso: /ocultar_sin_stock on|off`);
      return;
    }
    await sb.from("telegram_bot_settings").upsert({ singleton: true, hide_out_of_stock: mode === "on" });
    invalidateCatalogCache();
    await sendMessage("admin", msg.chat.id, `Ocultar sin stock  <b>${mode.toUpperCase()}</b>`);
    return;
  }

  if (text === "/usuarios") return adminUsuarios(msg.chat.id);
}

// ===== Callbacks =====
async function handleCallback(cb: TgCallback) {
  if (!isAdmin(cb.from.id)) {
    await answerCallbackQuery("admin", cb.id, "No autorizado", true);
    return;
  }
  // ACK en paralelo
  answerCallbackQuery("admin", cb.id).catch(() => {});
  const data = cb.data ?? "";
  const chat_id = cb.message?.chat.id;

  if (data === "akp:add") {
    if (chat_id) await adminListProducts(chat_id);
    return;
  }
  if (data === "akp:finduser") {
    if (chat_id) await adminPromptFindUser(chat_id);
    return;
  }
  if (data === "akp:stock") {
    if (chat_id) await adminStockView(chat_id);
    return;
  }
  if (data === "akp:pend") {
    if (chat_id) await adminPendientes(chat_id);
    return;
  }
  if (data === "akp:users") {
    if (chat_id) await adminUsuarios(chat_id);
    return;
  }
  if (data === "akp:anuncio") {
    if (chat_id) await adminPromptAnuncio(chat_id);
    return;
  }
  if (data === "akp:pm") { if (chat_id) await pmMenu(chat_id); return; }
  if (data === "pm:add") { if (chat_id) await pmPromptAdd(chat_id); return; }
  if (data === "pm:editlist") { if (chat_id) await pmListAll(chat_id, "edit"); return; }
  if (data === "pm:dellist") { if (chat_id) await pmListAll(chat_id, "del"); return; }
  if (data === "pm:countries") { if (chat_id) await pmCountriesView(chat_id); return; }
  if (data.startsWith("pm:edit:")) { if (chat_id) await pmEditMenu(chat_id, data.slice(8)); return; }
  if (data.startsWith("pm:del:")) { if (chat_id) await pmConfirmDelete(chat_id, data.slice(7)); return; }
  if (data.startsWith("pmf:")) {
    const [, field, pmId] = data.split(":");
    if (chat_id) await pmPromptField(chat_id, pmId, field);
    return;
  }
  if (data.startsWith("pmtog:")) {
    const pmId = data.slice(6);
    const { data: m } = await sb.from("payment_methods").select("active").eq("id", pmId).maybeSingle();
    if (m) {
      await sb.from("payment_methods").update({ active: !m.active }).eq("id", pmId);
      await sb.from("admin_logs").insert({ admin_telegram_id: cb.from.id, action: "pm_toggle", target_type: "payment_method", target_id: pmId, details: { active: !m.active } as never });
    }
    if (chat_id) await pmEditMenu(chat_id, pmId);
    return;
  }
  if (data.startsWith("pmdel:")) {
    const pmId = data.slice(6);
    await sb.from("payment_methods").delete().eq("id", pmId);
    await sb.from("admin_logs").insert({ admin_telegram_id: cb.from.id, action: "pm_delete", target_type: "payment_method", target_id: pmId });
    if (chat_id) await sendMessage("admin", chat_id, `Método eliminado.`);
    return;
  }

  if (data.startsWith("akprod:")) {
    if (chat_id) await adminListDurations(chat_id, data.slice(7));
    return;
  }
  if (data.startsWith("akdur:")) {
    if (chat_id) await adminPromptKeys(chat_id, data.slice(6));
    return;
  }
  if (data.startsWith("akusrp:")) {
    if (chat_id) await adminUsuarios(chat_id, parseInt(data.slice(7), 10) || 0);
    return;
  }
  if (data.startsWith("akusr:")) {
    if (chat_id) await adminUserDetail(chat_id, parseInt(data.slice(6), 10));
    return;
  }
  if (data.startsWith("akusrmsg:")) {
    if (chat_id) {
      const tgId = parseInt(data.slice(9), 10);
      await sendMessage(
        "admin",
        chat_id,
        `<b>MSGUSER:${tgId}</b>\n\nRespondé a este mensaje con el texto que querés enviarle al usuario <code>${tgId}</code>.`,
      );
    }
    return;
  }
  if (data.startsWith("akusrunblock:")) {
    const tgId = parseInt(data.slice(13), 10);
    await sb.from("blocked_users").delete().eq("telegram_id", tgId);
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "unblock_user",
      target_type: "telegram_id",
      target_id: String(tgId),
    });
    if (chat_id) await adminUserDetail(chat_id, tgId);
    return;
  }

  // ===== acciones sobre comprobantes =====
  const [, action, target] = data.split(":");

  if (action === "approve") {
    const { data: order } = await sb
      .from("orders")
      .select("*, bot_users(id, telegram_id, chat_id, balance, total_recharged)")
      .eq("id", target)
      .single();
    if (!order || order.status !== "pending_approval") {
      await answerCallbackQuery("admin", cb.id, "Ya procesada.", true);
      return;
    }
    if (order.order_type === "recharge" && Number(order.total_usd) <= 0) {
      await answerCallbackQuery("admin", cb.id, "Monto inválido en la orden.", true);
      return;
    }
    const u = (order as { bot_users: { id: string; telegram_id: number; chat_id: number; balance: number; total_recharged: number } }).bot_users;
    const amount = Number(order.total_usd);
    const newBalance = Number(u.balance) + amount;
    const newRecharged = Number(u.total_recharged) + amount;
    let rank: "normal" | "pro" | "leyenda" = "normal";
    if (newRecharged >= 200) rank = "leyenda";
    else if (newRecharged >= 50) rank = "pro";

    await Promise.all([
      sb
        .from("bot_users")
        .update({ balance: newBalance, total_recharged: newRecharged, rank })
        .eq("id", u.id),
      sb.from("orders").update({ status: "approved" }).eq("id", target),
      sb.from("receipts").update({ status: "approved" }).eq("order_id", target),
      sb.from("admin_logs").insert({
        admin_telegram_id: cb.from.id,
        action: "approve_order",
        target_type: "order",
        target_id: target,
        details: { amount_usd: amount } as never,
      }),
    ]);

    const pending = tpId(order.created_at);
    await notifyUserApproved({
      telegram_id: u.telegram_id,
      chat_id: u.chat_id,
      amount_usd: amount,
      new_balance: newBalance,
      pending,
    });

    // Marcar el comprobante real (si existe) y, si no, el mensaje del callback
    const { data: rcpt } = await sb
      .from("receipts")
      .select("admin_message_id")
      .eq("order_id", target)
      .maybeSingle();
    const photoMid = rcpt?.admin_message_id ?? cb.message?.message_id ?? 0;
    if (photoMid && cb.message) {
      await markReceiptStatus(cb.message.chat.id, photoMid, `✅ APROBADO`, `$${amount.toFixed(2)}`);
    }
    await answerCallbackQuery("admin", cb.id, `✅ Aprobado · $${amount.toFixed(2)}`, true);
    if (cb.message) await adminPendientes(cb.message.chat.id);
    return;
  }

  if (action === "reject") {
    if (!chat_id) return;
    // Preferir el msg_id real del comprobante (si lo conocemos) sobre el del panel.
    const { data: rcpt } = await sb
      .from("receipts")
      .select("admin_message_id")
      .eq("order_id", target)
      .maybeSingle();
    const photoMid = rcpt?.admin_message_id ?? cb.message?.message_id ?? 0;
    const sent = await sendMessage(
      "admin",
      chat_id,
      `<b>REJECT:${target}:${photoMid}</b>\n\nRespondé a este mensaje con el motivo del rechazo.`,
      { reply_markup: { force_reply: true, selective: true } },
    );
    if (sent.ok && sent.result) {
      await sb.from("orders").update({ admin_message_id: sent.result.message_id }).eq("id", target);
    }
    await answerCallbackQuery("admin", cb.id, "Esperando motivo…");
    return;
  }

  if (action === "block") {
    const tgId = parseInt(target, 10);
    await blockUserPermanent(tgId, "admin_block");
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "block_user",
      target_type: "telegram_id",
      target_id: target,
    });
    if (cb.message) {
      await markReceiptStatus(cb.message.chat.id, cb.message.message_id, `BLOQUEADO`, String(tgId));
    }
    await answerCallbackQuery("admin", cb.id, "Usuario bloqueado.", true);
    return;
  }




  if (action === "sendkey") {
    if (!chat_id) return;
    const order_id = target;
    const { data: ord } = await sb
      .from("orders")
      .select("id, telegram_id, products(name), product_prices(duration_label)")
      .eq("id", order_id)
      .maybeSingle();
    if (!ord) {
      await sendMessage("admin", chat_id, `Orden no encontrada.`);
      return;
    }
    const name = (ord as { products: { name: string } | null }).products?.name ?? "—";
    const dur = (ord as { product_prices: { duration_label: string } | null }).product_prices?.duration_label ?? "—";
    const sent = await sendMessage(
      "admin",
      chat_id,
      `<b>Enviar key</b>\n\n` +
        `Producto  ${name}\n` +
        `Duración  ${dur}\n` +
        `Usuario   <code>${ord.telegram_id}</code>\n` +
        `Orden     <code>${order_id.slice(0, 8)}</code>\n\n` +
        `Respondé a este mensaje pegando la key. Se enviará solo a este usuario.`,
      { reply_markup: { force_reply: true, selective: true } },
    );
    if (sent.ok && sent.result) {
      await sb
        .from("orders")
        .update({ admin_message_id: sent.result.message_id })
        .eq("id", order_id);
    }
    return;
  }
}
