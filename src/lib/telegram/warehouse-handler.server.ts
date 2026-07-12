// Admin Bot — handler (UI limpia, barra inferior persistente)
import {
  sendMessage as _rawSendMessage,
  editMessageReplyMarkup,
  deleteMessage,
  answerCallbackQuery,
  getWarehouseChatId,
  getFile,
  downloadFile,
  
  sendPhotoMultipart,
  tg,
} from "./api.server";
import {
  sb,
  checkRateLimit,
  blockUserPermanent,
  getState,
  patchContext,
} from "./db.server";
import {
  getStockByPriceId,
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
  bot: "shop" | "warehouse",
  chat_id: number | string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  // Para mensajes del almacén con teclado inline, anexamos el botón
  // "🏠 Inicio" para que el admin siempre tenga forma de volver a la barra.
  if (bot === "warehouse") {
    const rm = extra.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } | undefined;
    if (rm && Array.isArray(rm.inline_keyboard)) {
      const last = rm.inline_keyboard[rm.inline_keyboard.length - 1];
      const alreadyHasInicio = Array.isArray(last) && last.some((b) => b?.callback_data === "akp:inicio");
      if (!alreadyHasInicio) {
        rm.inline_keyboard = [...rm.inline_keyboard, [{ text: "🏠 Inicio", callback_data: "akp:inicio" }]];
        extra = { ...extra, reply_markup: rm };
      }
    }
  }
  const r = await _rawSendMessage(bot, chat_id, text, extra);
  if (bot === "warehouse" && r.ok && r.result) {
    sb.from("admin_trash")
      .insert({ chat_id: Number(chat_id), message_id: r.result.message_id })
      .then(() => {}, () => {});
  }
  return r;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isAdmin(telegram_id: number) {
  return String(telegram_id) === String(getWarehouseChatId());
}





// ===== Barra inferior persistente del almacén =====
const ADMIN_BOTTOM = {
  inicio: "🏠 Inicio",
  addkeys: "Agregar Keys",
  productos: "📦 Productos",
  metodos: "💳 Métodos",
  todo: "⚙️ Todo",
};

// Opciones agrupadas dentro del menú "Todo"
const ADMIN_TODO = {
  stock: "Stock",
  anuncio: "Anuncio",
  minrecharge: "Recarga Mínima",
  usuarios: "Usuarios",
  precios: "Precios",
  borrar: "Borrar",
};

function adminBottomKeyboard() {
  return {
    keyboard: [
      [{ text: ADMIN_BOTTOM.inicio }],
      [{ text: ADMIN_BOTTOM.addkeys }, { text: ADMIN_BOTTOM.productos }],
      [{ text: ADMIN_BOTTOM.metodos }, { text: ADMIN_BOTTOM.todo }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

async function showTodoMenu(chat_id: number) {
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>Todo</b>\n\nElegí una opción:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: ADMIN_TODO.stock, callback_data: "akp:stock" }, { text: ADMIN_TODO.usuarios, callback_data: "akp:users" }],
          [{ text: ADMIN_TODO.precios, callback_data: "akp:prlist" }, { text: ADMIN_TODO.minrecharge, callback_data: "akp:minrec" }],
          [{ text: ADMIN_TODO.anuncio, callback_data: "akp:anuncio" }, { text: ADMIN_TODO.borrar, callback_data: "akp:borrar" }],
        ],
      },
    },
  );
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

export async function handleWarehouseUpdate(update: Update): Promise<void> {
  const admin_id =
    (update.message?.from && isAdmin(update.message.from.id) && update.message.from.id) ||
    (update.callback_query?.from && isAdmin(update.callback_query.from.id) && update.callback_query.from.id) ||
    null;
  const chat_id =
    update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;

  // Comandos que muestran la barra por su cuenta. Saltamos ensureAdminBar
  // para evitar el flicker del mensaje invisible al tocar /start o "Inicio".
  const msgText = (update.message?.text ?? "").trim();
  const isStartLike =
    msgText === "/start" ||
    msgText === "/help" ||
    msgText === "/panel" ||
    msgText === ADMIN_BOTTOM.inicio;

  if (admin_id && chat_id) {
    _currentAdminId = admin_id;
    // Trackear los mensajes que el admin envía para poder borrarlos también
    if (update.message?.message_id) {
      sb.from("admin_trash")
        .insert({ chat_id: Number(chat_id), message_id: update.message.message_id })
        .then(() => {}, () => {});
    }
    // Solo limpieza/barra en mensajes de texto. En callbacks NO bloqueamos
    // la respuesta: el botón debe sentirse instantáneo.
    if (update.message) {
      const idleMs = await getIdleMs(admin_id);
      if (idleMs >= ADMIN_IDLE_PURGE_MS) {
        purgeAdminTrash(chat_id, admin_id).catch(() => {});
      }
      touchAdminSeen(admin_id).catch(() => {});
      if (!isStartLike) {
        ensureAdminBar(chat_id, admin_id).catch(() => {});
      }
    } else {
      touchAdminSeen(admin_id).catch(() => {});
    }
  }

  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error("[warehouse handler] fatal", err);
    const cb = update.callback_query;
    const fallbackChat = chat_id ?? cb?.from.id ?? null;
    if (cb?.id) {
      answerCallbackQuery("warehouse", cb.id, "Error temporal. Toca de nuevo.", true).catch(() => {});
    }
    if (fallbackChat) {
      await sendMessage(
        "warehouse",
        fallbackChat,
        `Almacén activo. Esa acción tuvo un error temporal; intenta nuevamente.`,
        { reply_markup: adminBottomKeyboard() },
      ).catch(() => {});
    }
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




// ===== Panel admin (inline) =====
async function showAdminPanel(chat_id: number) {
  await sendMessage("warehouse", chat_id, `<b>Panel Admin</b>\n\nElegí una opción:`, {
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
        [{ text: "🏠 Inicio", callback_data: "akp:inicio" }],
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
  const sent = await sendMessage("warehouse", chat_id, "\u2063", {
    reply_markup: adminBottomKeyboard(),
  });
  if (sent.ok && sent.result) {
    deleteMessage("warehouse", chat_id, sent.result.message_id).catch(() => {});
  }
  await patchContext(admin_id, { bar_shown: true });
}

// Limpieza de mensajes del admin (todo menos los comprobantes pendientes)
async function purgeAdminTrash(chat_id: number, _admin_id: number) {
  const { data } = await sb
    .from("admin_trash")
    .select("message_id")
    .eq("chat_id", chat_id)
    .limit(500);
  if (!data || data.length === 0) return;
  await Promise.all(
    data.map((row) =>
      deleteMessage("warehouse", chat_id, row.message_id as number).catch(() => {}),
    ),
  );
  await sb.from("admin_trash").delete().eq("chat_id", chat_id);
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
    deleteMessage("warehouse", chat_id, prev).catch(() => {});
  }
  const sent = await sendMessage("warehouse", chat_id, text, kb ? { reply_markup: { inline_keyboard: kb } } : {});
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
  await editMessageReplyMarkup("warehouse", bot_chat_id, message_id, { inline_keyboard: [] }).catch(() => {});
  await sendMessage("warehouse", bot_chat_id, `${badge}${detail ? `  ·  ${detail}` : ""}`, {
    reply_to_message_id: message_id,
    allow_sending_without_reply: true,
  });
}


// Mapa mínimo de países LATAM/comunes para deducir country_code desde el texto pegado.
const COUNTRY_MAP: Record<string, string> = {
  argentina: "AR", colombia: "CO", mexico: "MX", "méxico": "MX", peru: "PE", "perú": "PE",
  chile: "CL", venezuela: "VE", ecuador: "EC", bolivia: "BO", paraguay: "PY",
  uruguay: "UY", brasil: "BR", brazil: "BR", espana: "ES", "españa": "ES", spain: "ES",
  "estados unidos": "US", usa: "US", "eeuu": "US", "ee.uu": "US", "ee.uu.": "US",
  "republica dominicana": "DO", "república dominicana": "DO", panama: "PA", "panamá": "PA",
  "costa rica": "CR", guatemala: "GT", honduras: "HN", "el salvador": "SV",
  nicaragua: "NI", cuba: "CU", "puerto rico": "PR",
};

// (Parser antiguo eliminado — el flujo actual guarda el contenido verbatim.)


// ===== Gestión de métodos de pago =====

async function pmMenu(chat_id: number) {
  await sendMessage("warehouse", chat_id, `<b>Métodos de Pago</b>\n\nSeleccioná una opción:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Editar Método (Pegar Contenido)", callback_data: "pm:editlist" }],
        [{ text: "Agregar País Nuevo", callback_data: "pm:addnew" }],
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
    await sendMessage("warehouse", chat_id, `No hay métodos cargados.`);
    return;
  }

  if (mode === "edit") {
    // Uno por país. Al elegir, se pega el contenido y reemplaza TODO lo del país.
    const seen = new Set<string>();
    const countries: Array<{ code: string; name: string }> = [];
    for (const m of methods) {
      if (seen.has(m.country_code)) continue;
      seen.add(m.country_code);
      countries.push({ code: m.country_code, name: m.country_name });
    }
    const kb: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < countries.length; i += 2) {
      const row = [{ text: countries[i].name, callback_data: `pmec:${countries[i].code}` }];
      if (countries[i + 1]) row.push({ text: countries[i + 1].name, callback_data: `pmec:${countries[i + 1].code}` });
      kb.push(row);
    }
    await sendMessage(
      "warehouse",
      chat_id,
      `<b>Editar Método</b>\n\nElegí el país. Al pegar el contenido nuevo, el anterior se elimina y queda exactamente lo que pegues.`,
      { reply_markup: { inline_keyboard: kb } },
    );
    return;
  }

  const kb = methods.map((m) => [
    {
      text: `${m.country_name} · ${m.method_name}${m.active ? "" : " (off)"}`,
      callback_data: `pm:del:${m.id}`,
    },
  ]);
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>Eliminar Método</b>\n\nElegí uno:`,
    { reply_markup: { inline_keyboard: kb } },
  );
}

async function pmPromptCountryReplace(chat_id: number, country_code: string) {
  const { data: existing } = await sb
    .from("payment_methods")
    .select("country_name, body_raw")
    .eq("country_code", country_code)
    .limit(1)
    .maybeSingle();
  const cn = existing?.country_name ?? country_code;
  const current = existing?.body_raw
    ? `\n<b>Contenido actual:</b>\n<code>${escapeHtml(existing.body_raw)}</code>\n`
    : "";
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>PMBODY:${country_code}</b>\n\n` +
      `Respondé a este mensaje pegando el contenido nuevo para <b>${cn}</b>.\n` +
      `Se guarda tal cual lo pegues (respeta saltos de línea y formato) y reemplaza por completo lo anterior.\n` +
      current,
    { reply_markup: { force_reply: true, selective: true } },
  );
}

async function pmPromptAddCountry(chat_id: number) {
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>PMNEW</b>\n\nRespondé a este mensaje con el país en la primera línea y el contenido debajo.\n\n` +
      `<b>Primera línea:</b> <code>CÓDIGO | Nombre País | MONEDA | Tasa</code>\n` +
      `Ejemplo: <code>AR | Argentina | ARS | 1350</code>\n\n` +
      `Debajo pegá el contenido tal cual querés que lo vea el cliente.`,
    { reply_markup: { force_reply: true, selective: true } },
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
  await sendMessage("warehouse", chat_id, `<b>Países disponibles</b>\n\n${lines || "Sin datos."}`);
}

// Best-effort para extraer metadatos del texto pegado (para OCR y totales).
// Si no encuentra algo, deja null y no rompe nada.
function extractPmMetadata(raw: string): {
  method_name: string | null;
  holder_name: string | null;
  account_info: string | null;
} {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  let method_name: string | null = null;
  let holder_name: string | null = null;
  let account_info: string | null = null;
  for (const l of lines) {
    if (!method_name && l.includes("🏦")) {
      method_name = l.replace(/🏦|✅|❌/g, "").trim();
    }
    if (!holder_name) {
      const m = l.match(/🪪\s*(?:Nombre|Titular)\s*:\s*(.+)/i) ?? l.match(/(?:Nombre|Titular)\s*:\s*(.+)/i);
      if (m) holder_name = m[1].trim();
    }
    if (!account_info) {
      const m = l.match(/📋\s*[^:]*:\s*(.+)/) ?? l.match(/(?:Alias|CBU|CVU|Cuenta|N[uú]mero|Cta)\s*:\s*(.+)/i);
      if (m) account_info = m[1].trim();
    }
  }
  return { method_name, holder_name, account_info };
}


async function pmConfirmDelete(chat_id: number, pm_id: string) {
  const { data: m } = await sb.from("payment_methods").select("country_name, method_name").eq("id", pm_id).maybeSingle();
  if (!m) {
    await sendMessage("warehouse", chat_id, `Método no encontrado.`);
    return;
  }
  await sendMessage(
    "warehouse",
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
    await sendMessage("warehouse", chat_id, `No hay productos cargados.`);
    return;
  }
  const kb = products.map((p) => [
    { text: `${p.name}  ·  ${p.category}`, callback_data: `akprod:${p.id}` },
  ]);
  await sendMessage("warehouse", chat_id, `<b>Agregar Keys</b>\n\nElegí el producto:`, {
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
    await sendMessage("warehouse", chat_id, `Ese producto no tiene duraciones cargadas.`);
    return;
  }
  const name = (prices[0] as { products: { name: string } }).products.name;
  const kb = prices.map((p) => [
    { text: `${p.duration_label}`, callback_data: `akdur:${p.id}` },
  ]);
  await sendMessage("warehouse", chat_id, `<b>${name}</b>\n\nElegí la duración:`, {
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
    await sendMessage("warehouse", chat_id, `Variante no encontrada.`);
    return;
  }
  await sendMessage(
    "warehouse",
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
    await sendMessage("warehouse", chat_id, `No hay productos cargados.`);
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
    "warehouse",
    chat_id,
    `<b>Stock disponible</b>\nTotal general  <b>${grandTotal}</b>\n${lines.join("\n")}`,
  );
}

function adminId() {
  return Number(getWarehouseChatId() ?? 0);
}

/** Borra todos los mensajes del chat del almacén. */
async function cleanAdminChat(chat_id: number, admin_id: number) {
  await purgeAdminTrash(chat_id, admin_id).catch(() => {});
  await patchContext(admin_id, { list_msgs: {} });
  await sendMessage("warehouse", chat_id, `🗑 Chat limpio.`);
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

  const totalPages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

  const rows: string[] = [];
  for (let i = 0; i < users.length; i += 2) {
    const a = users[i];
    const b = users[i + 1];
    const nameA = a.display_name ?? a.username ?? "";
    const nameB = b ? (b.display_name ?? b.username ?? "") : "";
    const dotA = nameA ? "🟢" : "⚪";
    const dotB = b ? (nameB ? "🟢" : "⚪") : "";
    const labelA = nameA || "Sin nombre";
    const labelB = b ? (nameB || "Sin nombre") : "";
    const leftTop = pad(`${dotA} ${labelA}`, 22);
    const leftBot = pad(String(a.telegram_id), 22);
    rows.push(`${leftTop}${b ? `${dotB} ${labelB}` : ""}`);
    rows.push(`${leftBot}${b ? b.telegram_id : ""}`);
    rows.push("");
  }
  const body = `<pre>${escapeHtml(rows.join("\n").trimEnd())}</pre>`;

  const kb: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
  for (let i = 0; i < users.length; i += 2) {
    const a = users[i];
    const b = users[i + 1];
    const labelA = a.display_name ?? a.username ?? "Sin nombre";
    const row = [{ text: `${from + i + 1}. ${labelA}`, callback_data: `akusr:${a.telegram_id}` }];
    if (b) {
      const labelB = b.display_name ?? b.username ?? "Sin nombre";
      row.push({ text: `${from + i + 2}. ${labelB}`, callback_data: `akusr:${b.telegram_id}` });
    }
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
    `<b>Usuarios</b> · ${total} · ${page + 1}/${totalPages}\n\n${body}`,
    kb,
  );
}

async function adminPromptFindUser(chat_id: number) {
  await sendMessage(
    "warehouse",
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
    await sendMessage("warehouse", chat_id, `Usuario no encontrado.`);
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
  buttons.push([
    { text: "💵 Descuento personal", callback_data: `akusrdisc:${u.telegram_id}` },
  ]);

  buttons.push(
    blocked
      ? [{ text: "Desbloquear", callback_data: `akusrunblock:${u.telegram_id}` }]
      : [{ text: "Bloquear", callback_data: `adm:block:${u.telegram_id}` }],
  );
  buttons.push([{ text: "Volver", callback_data: "akp:users" }]);

  await sendMessage("warehouse", chat_id, text, {
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
    "warehouse",
    chat_id,
    `<b>Anuncio</b>\n\nEnviá o reenviá ahora cualquier mensaje (texto, foto, documento, video…) y se transmitirá a todos los usuarios.\n\nTenés 10 minutos. Para cancelar escribí /cancelar.`,
  );
}

async function adminListaPrecios(chat_id: number) {
  const { data: products } = await sb
    .from("products")
    .select("id, name, category")
    .eq("active", true)
    .order("sort_order");
  if (!products || products.length === 0) {
    await sendMessage("warehouse", chat_id, `No hay productos cargados.`);
    return;
  }
  const kb = products.map((p) => [
    { text: `${p.name}  ·  ${p.category}`, callback_data: `prprod:${p.id}` },
  ]);
  await sendMessage("warehouse", chat_id, `<b>Editar Precios</b>\n\nElegí el producto:`, {
    reply_markup: { inline_keyboard: kb },
  });
}

async function adminPriceDurations(chat_id: number, product_id: string) {
  const { data: prices } = await sb
    .from("product_prices")
    .select("id, duration_label, price_usd, products(name)")
    .eq("product_id", product_id)
    .eq("active", true)
    .order("sort_order");
  if (!prices || prices.length === 0) {
    await sendMessage("warehouse", chat_id, `Ese producto no tiene duraciones cargadas.`);
    return;
  }
  const name = (prices[0] as { products: { name: string } }).products.name;
  const kb = prices.map((p) => [
    {
      text: `${p.duration_label}  ·  $${Number(p.price_usd).toFixed(2)}`,
      callback_data: `pred:${p.id}`,
    },
  ]);
  kb.push([{ text: "Volver", callback_data: "akp:prlist" }]);
  await sendMessage("warehouse", chat_id, `<b>${name}</b>\n\nElegí la duración a editar:`, {
    reply_markup: { inline_keyboard: kb },
  });
}

async function adminPromptNewPrice(chat_id: number, price_id: string) {
  const { data: p } = await sb
    .from("product_prices")
    .select("duration_label, price_usd, products(name)")
    .eq("id", price_id)
    .maybeSingle();
  if (!p) {
    await sendMessage("warehouse", chat_id, `Variante no encontrada.`);
    return;
  }
  const name = (p as { products: { name: string } }).products.name;
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>PRICEEDIT:${price_id}</b>\n${name} · ${p.duration_label}\nPrecio actual: <b>$${Number(p.price_usd).toFixed(2)}</b>\n\nRespondé a este mensaje con el nuevo precio en USD (ej: <code>4.50</code>).`,
    { reply_markup: { force_reply: true, selective: true } },
  );
}

// ===== Gestión de productos (renombrar / borrar) =====
async function adminProductsList(chat_id: number) {
  const { data: products } = await sb
    .from("products")
    .select("id, name, category, active")
    .order("category")
    .order("sort_order");
  if (!products || products.length === 0) {
    await sendMessage("warehouse", chat_id, `No hay productos cargados.`);
    return;
  }
  const kb = products.map((p) => [
    {
      text: `${p.active ? "" : "⏸ "}${p.name}  ·  ${p.category}`,
      callback_data: `prodm:${p.id}`,
    },
  ]);
  await sendMessage("warehouse", chat_id, `<b>📦 Productos (iOS / Android)</b>\n\nElegí un producto para editar o borrar:`, {
    reply_markup: { inline_keyboard: kb },
  });
}

async function adminProductMenu(chat_id: number, product_id: string) {
  const { data: p } = await sb
    .from("products")
    .select("id, name, category, active")
    .eq("id", product_id)
    .maybeSingle();
  if (!p) {
    await sendMessage("warehouse", chat_id, `Producto no encontrado.`);
    return;
  }
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>${escapeHtml(p.name)}</b>  ·  ${p.category}\n${p.active ? "✅ Activo" : "⏸ Inactivo"}\n\n¿Qué querés hacer?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✏️ Renombrar", callback_data: `prodren:${p.id}` }],
          [{ text: p.active ? "⏸ Desactivar" : "▶️ Activar", callback_data: `prodtog:${p.id}` }],
          [{ text: "🗑 Borrar (definitivo)", callback_data: `proddel:${p.id}` }],
          [{ text: "Volver", callback_data: "akp:prodlist" }],
        ],
      },
    },
  );
}

async function adminPromptProductRename(chat_id: number, product_id: string) {
  const { data: p } = await sb
    .from("products")
    .select("name")
    .eq("id", product_id)
    .maybeSingle();
  if (!p) {
    await sendMessage("warehouse", chat_id, `Producto no encontrado.`);
    return;
  }
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>PRODRENAME:${product_id}</b>\nNombre actual: <b>${escapeHtml(p.name)}</b>\n\nRespondé a este mensaje con el nuevo nombre.`,
    { reply_markup: { force_reply: true, selective: true } },
  );
}

async function adminConfirmProductDelete(chat_id: number, product_id: string) {
  const { data: p } = await sb
    .from("products")
    .select("name")
    .eq("id", product_id)
    .maybeSingle();
  if (!p) return;
  await sendMessage(
    "warehouse",
    chat_id,
    `⚠️ <b>Borrar producto</b>\n\n<b>${escapeHtml(p.name)}</b>\n\nEsta acción elimina el producto, sus precios y sus keys disponibles. ¿Confirmás?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Confirmar borrado", callback_data: `proddelok:${product_id}` },
            { text: "Cancelar", callback_data: `prodm:${product_id}` },
          ],
        ],
      },
    },
  );
}

// ===== Edición de recarga mínima =====
async function adminPromptMinRecharge(chat_id: number) {
  const { data } = await sb
    .from("telegram_bot_settings")
    .select("min_recharge_usd")
    .eq("singleton", true)
    .maybeSingle();
  const cur = Number((data as { min_recharge_usd?: number } | null)?.min_recharge_usd ?? 4);
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>MINRECHARGE</b>\nRecarga mínima actual: <b>$${cur.toFixed(2)} USD</b>\n\nRespondé a este mensaje con el nuevo monto mínimo en USD (ej: <code>4</code>).`,
    { reply_markup: { force_reply: true, selective: true } },
  );
}


// ===== Descuento personal por usuario =====
const INICIO_ROW = [{ text: "🏠 Inicio", callback_data: "akp:inicio" }];

async function adminUserDiscountProducts(chat_id: number, telegram_id: number) {
  const { data: products } = await sb
    .from("products")
    .select("id, name, category")
    .eq("active", true)
    .order("sort_order");
  if (!products || products.length === 0) {
    await sendMessage("warehouse", chat_id, `No hay productos cargados.`);
    return;
  }
  const kb = products.map((p) => [
    { text: `${p.name}  ·  ${p.category}`, callback_data: `udprod:${telegram_id}:${p.id}` },
  ]);
  kb.push([{ text: "Volver", callback_data: `akusr:${telegram_id}` }]);
  kb.push(INICIO_ROW);
  await replaceAdminList(
    chat_id,
    _currentAdminId ?? chat_id,
    "udisc",
    `<b>Descuento personal</b>\nUsuario <code>${telegram_id}</code>\n\nElegí el producto:`,
    kb,
  );
}

async function adminUserDiscountDurations(chat_id: number, telegram_id: number, product_id: string) {
  const [{ data: prices }, { data: overrides }] = await Promise.all([
    sb
      .from("product_prices")
      .select("id, duration_label, price_usd, products(name)")
      .eq("product_id", product_id)
      .eq("active", true)
      .order("sort_order"),
    sb
      .from("user_price_overrides")
      .select("price_id, price_usd")
      .eq("telegram_id", telegram_id),
  ]);
  if (!prices || prices.length === 0) {
    await sendMessage("warehouse", chat_id, `Ese producto no tiene duraciones cargadas.`);
    return;
  }
  const ovMap = new Map<string, number>();
  for (const o of overrides ?? []) ovMap.set(o.price_id as string, Number(o.price_usd));
  const name = (prices[0] as { products: { name: string } }).products.name;
  const kb = prices.map((p) => {
    const ov = ovMap.get(p.id);
    const tag = ov != null ? `  🎁 $${ov.toFixed(2)}` : "";
    return [
      {
        text: `${p.duration_label}  ·  base $${Number(p.price_usd).toFixed(2)}${tag}`,
        callback_data: `upred:${telegram_id}:${p.id}`,
      },
    ];
  });
  kb.push([{ text: "Volver", callback_data: `akusrdisc:${telegram_id}` }]);
  kb.push(INICIO_ROW);
  await replaceAdminList(
    chat_id,
    _currentAdminId ?? chat_id,
    "udisc",
    `<b>${name}</b>\nUsuario <code>${telegram_id}</code>\n\nElegí la duración:`,
    kb,
  );
}

async function adminPromptUserPrice(chat_id: number, telegram_id: number, price_id: string) {
  const [{ data: p }, { data: ov }] = await Promise.all([
    sb
      .from("product_prices")
      .select("duration_label, price_usd, products(name)")
      .eq("id", price_id)
      .maybeSingle(),
    sb
      .from("user_price_overrides")
      .select("price_usd")
      .eq("telegram_id", telegram_id)
      .eq("price_id", price_id)
      .maybeSingle(),
  ]);
  if (!p) {
    await sendMessage("warehouse", chat_id, `Variante no encontrada.`);
    return;
  }
  const name = (p as { products: { name: string } }).products.name;
  const current = ov ? `$${Number(ov.price_usd).toFixed(2)} (personal)` : `$${Number(p.price_usd).toFixed(2)} (base)`;
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>UPRICEEDIT:${telegram_id}:${price_id}</b>\n${name} · ${p.duration_label}\nPrecio actual para este usuario: <b>${current}</b>\n\nRespondé con el nuevo precio en USD solo para este usuario.\nUsá <code>reset</code> para quitar el descuento personal.`,
    { reply_markup: { force_reply: true, selective: true } },
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
    await sendMessage("warehouse", chat_id, `Esa recarga ya fue aprobada.`);
    return;
  }
  const { data: u } = await sb
    .from("bot_users")
    .select("id, telegram_id, chat_id, balance, total_recharged, rank")
    .eq("id", order.user_id)
    .single();
  if (!u) {
    await sendMessage("warehouse", chat_id, `Usuario no encontrado.`);
    return;
  }
  const newBalance = Number(u.balance) + amount;
  const newRecharged = Number(u.total_recharged) + amount;
  const { rankFromRecharged, normalizeRank } = await import("./ranks.server");
  const newRank = rankFromRecharged(newRecharged);
  const oldRank = normalizeRank((u as { rank?: string }).rank);
  const rankChanged = newRank !== oldRank;

  await Promise.all([
    sb
      .from("bot_users")
      .update({
        balance: newBalance,
        total_recharged: newRecharged,
        rank: newRank,
        ...(rankChanged ? { rank_assigned_at: new Date().toISOString() } : {}),
      })
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

  if (rankChanged) {
    await sb.from("rank_history").insert({
      telegram_id: u.telegram_id,
      old_rank: oldRank as never,
      new_rank: newRank as never,
      changed_by: "system",
      reason: `auto · recarga $${amount.toFixed(2)} · total $${newRecharged.toFixed(2)}`,
    });
  }

  await notifyUserApproved({
    telegram_id: u.telegram_id,
    chat_id: u.chat_id,
    amount_usd: amount,
    new_balance: newBalance,
  });

  await sendMessage(
    "warehouse",
    chat_id,
    `<b>Recarga aprobada</b>  ·  $${amount.toFixed(2)} USD acreditados.\nNuevo saldo del usuario  $${newBalance.toFixed(2)}`,
  );
}

// ===== Anuncio (broadcast — soporta texto, foto, documento, video, audio, voice) =====
type MediaKind = "photo" | "document" | "video" | "audio" | "voice" | null;

async function uploadMedia(
  chatId: number,
  kind: MediaKind,
  bytes: ArrayBuffer,
  filename: string,
  caption: string,
): Promise<{ ok: boolean; result?: { message_id: number; photo?: TgPhotoSize[]; document?: { file_id: string }; video?: { file_id: string }; audio?: { file_id: string }; voice?: { file_id: string } } }> {
  if (!kind) return { ok: false };
  const method =
    kind === "photo" ? "sendPhoto" :
    kind === "document" ? "sendDocument" :
    kind === "video" ? "sendVideo" :
    kind === "audio" ? "sendAudio" : "sendVoice";
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) {
    fd.append("caption", caption);
    fd.append("parse_mode", "HTML");
  }
  fd.append(kind, new Blob([bytes]), filename);
  return tg("shop", method, fd);
}

async function sendByFileId(
  chatId: number,
  kind: MediaKind,
  fileId: string,
  caption: string,
): Promise<{ ok: boolean; result?: { message_id: number } }> {
  if (!kind) return { ok: false };
  const method =
    kind === "photo" ? "sendPhoto" :
    kind === "document" ? "sendDocument" :
    kind === "video" ? "sendVideo" :
    kind === "audio" ? "sendAudio" : "sendVoice";
  const payload: Record<string, unknown> = { chat_id: chatId, [kind]: fileId };
  if (caption) {
    payload.caption = caption;
    payload.parse_mode = "HTML";
  }
  return tg("shop", method, payload);
}

function extractShopFileId(
  kind: MediaKind,
  result?: { photo?: TgPhotoSize[]; document?: { file_id: string }; video?: { file_id: string }; audio?: { file_id: string }; voice?: { file_id: string } },
): string | null {
  if (!kind || !result) return null;
  if (kind === "photo") return result.photo?.[result.photo.length - 1]?.file_id ?? null;
  if (kind === "document") return result.document?.file_id ?? null;
  if (kind === "video") return result.video?.file_id ?? null;
  if (kind === "audio") return result.audio?.file_id ?? null;
  if (kind === "voice") return result.voice?.file_id ?? null;
  return null;
}

async function handleBroadcast(msg: TgMessage) {
  // Ack inmediato al admin para que sienta respuesta instantánea.
  void sendMessage("warehouse", msg.chat.id, `Procesando anuncio…`);

  // Determinar tipo de media y descargar UNA sola vez vía bot warehouse.
  let kind: MediaKind = null;
  let sourceFileId: string | null = null;
  let filename = "anuncio";
  if (msg.photo && msg.photo.length > 0) {
    kind = "photo";
    sourceFileId = msg.photo[msg.photo.length - 1].file_id;
    filename = "anuncio.jpg";
  } else if (msg.document) {
    kind = "document";
    sourceFileId = msg.document.file_id;
    filename = msg.document.file_name || "archivo";
  } else if (msg.video) {
    kind = "video";
    sourceFileId = msg.video.file_id;
    filename = "video.mp4";
  } else if (msg.audio) {
    kind = "audio";
    sourceFileId = msg.audio.file_id;
    filename = "audio.mp3";
  } else if (msg.voice) {
    kind = "voice";
    sourceFileId = msg.voice.file_id;
    filename = "voice.ogg";
  }

  const rawText = (msg.text ?? "").trim();
  const rawCaption = (msg.caption ?? "").trim();
  const highlight = (s: string) =>
    s
      ? `📣📣📣 <b>ANUNCIO IMPORTANTE</b> 📣📣📣\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<b>${escapeHtml(s)}</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━`
      : s;
  const textBody = highlight(rawText);
  const caption = highlight(rawCaption);

  // Descargar bytes en paralelo con consulta de usuarios.
  const usersPromise = sb.from("bot_users").select("telegram_id, chat_id");
  let mediaBytes: ArrayBuffer | null = null;
  if (kind && sourceFileId) {
    const f = await getFile("warehouse", sourceFileId);
    if (f.ok && f.result?.file_path) {
      mediaBytes = await downloadFile("warehouse", f.result.file_path);
      const parts = f.result.file_path.split("/");
      const baseName = parts[parts.length - 1];
      if (baseName && kind !== "document") filename = baseName;
    }
    if (!mediaBytes) {
      await sendMessage("warehouse", msg.chat.id, `No pude descargar el archivo. Reintentá.`);
      return;
    }
  }

  const { data: users } = await usersPromise;
  const targets = (users ?? []).filter((u) => u.chat_id);
  if (targets.length === 0) {
    await sendMessage("warehouse", msg.chat.id, `No hay usuarios para enviar el anuncio.`);
    return;
  }

  // Preview corto.
  const preview =
    textBody ||
    caption ||
    (msg.document?.file_name ? `Archivo: ${msg.document.file_name}` : "") ||
    (kind === "photo" ? "Imagen" : "") ||
    (kind === "video" ? "Video" : "") ||
    (kind === "audio" || kind === "voice" ? "Audio" : "") ||
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
    await sendMessage("warehouse", msg.chat.id, `No pude registrar el anuncio.`);
    return;
  }

  void sendMessage("warehouse", msg.chat.id, `Enviando a ${targets.length} usuarios…`);

  // Subir UNA vez al primer usuario y reutilizar file_id del shop bot.
  let shopFileId: string | null = null;
  const annId = ann.id;
  let ok = 0;
  let fail = 0;

  async function sendOne(u: { telegram_id: number; chat_id: number }) {
    let sent: { ok: boolean; result?: { message_id: number } } = { ok: false };
    if (kind && shopFileId) {
      sent = await sendByFileId(u.chat_id, kind, shopFileId, caption);
    } else if (kind && mediaBytes) {
      // Fallback: subir multipart (solo si la reutilización aún no está lista)
      sent = await uploadMedia(u.chat_id, kind, mediaBytes, filename, caption);
      const fid = extractShopFileId(kind, sent.result as never);
      if (fid && !shopFileId) shopFileId = fid;
    } else if (textBody) {
      sent = await _rawSendMessage("shop", u.chat_id, textBody);
    } else if (caption) {
      sent = await _rawSendMessage("shop", u.chat_id, caption);
    }
    if (sent.ok && sent.result) {
      ok++;
      void recordAnnouncementDelivery({
        announcement_id: annId,
        telegram_id: u.telegram_id,
        chat_id: u.chat_id,
        message_id: sent.result.message_id,
      }).catch(() => {});
    } else {
      fail++;
    }
  }

  // Primera entrega secuencial (para conseguir file_id reusable).
  if (kind && targets.length > 0) {
    await sendOne(targets[0]);
  }

  // Resto en alta concurrencia con file_id reutilizado.
  const rest = kind ? targets.slice(1) : targets;
  const CONCURRENCY = 50;
  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    const batch = rest.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((u) => sendOne(u)));
  }

  await sb
    .from("announcements")
    .update({ total_sent: ok, total_failed: fail })
    .eq("id", ann.id);

  await sendMessage(
    "warehouse",
    msg.chat.id,
    `<b>Anuncio finalizado</b>\nEntregados  <b>${ok}</b>\nFallidos    <b>${fail}</b>`,
  );
}





// ===== Mensajes =====
async function handleMessage(msg: TgMessage) {
  if (!msg.from) return;
  if (!isAdmin(msg.from.id)) {
    await sendMessage("warehouse", msg.chat.id, `No autorizado.`);
    return;
  }
  const text = (msg.text ?? "").trim();

  if (text === "/start" || text === "/help" || text === "/panel") {
    const sent = await sendMessage(
      "warehouse",
      msg.chat.id,
      `<b>Almacén listo ✅</b>\nUsá la barra inferior para todas las funciones.`,
      { reply_markup: adminBottomKeyboard() },
    );
    patchContext(msg.from.id, { bar_shown: true }).catch((err) => console.error("[warehouse /start] state", err));
    if (!sent.ok) console.error("[warehouse /start] immediate send failed", sent.description);
    return;
  }

  if (!(await checkRateLimit(msg.from.id, "admin_msg", 30, 10))) return;

  // ===== Cancelar broadcast en espera =====
  if (text === "/cancelar") {
    await patchContext(msg.from.id, { awaiting_broadcast: 0 });
    await sendMessage("warehouse", msg.chat.id, `Cancelado.`);
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




    // ===== Envío de key manual desde el almacén =====
    const almSendMatch = replySource.match(/ALMSENDKEY:([a-f0-9-]{36})/);
    if (almSendMatch && text.length > 0) {
      const orderId = almSendMatch[1];
      const { data: ord } = await sb
        .from("orders")
        .select("id, user_id, telegram_id, product_id, price_id, status")
        .eq("id", orderId)
        .maybeSingle();
      if (!ord) {
        await sendMessage("warehouse", msg.chat.id, `Orden no encontrada.`);
        return;
      }
      await Promise.all([
        sb.from("order_keys").insert({
          order_id: ord.id,
          user_id: ord.user_id,
          key_value: text,
        }),
        sb.from("orders").update({ status: "delivered" }).eq("id", ord.id),
        sb.from("admin_logs").insert({
          admin_telegram_id: msg.from.id,
          action: "manual_key_delivered",
          target_type: "order",
          target_id: ord.id,
        }),
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
      deleteMessage("warehouse", msg.chat.id, msg.message_id).catch(() => {});
      deleteMessage("warehouse", msg.chat.id, msg.reply_to_message.message_id).catch(() => {});
      await sendMessage(
        "warehouse",
        msg.chat.id,
        `✅ Key enviada a <code>${u?.telegram_id ?? ord.telegram_id}</code>.`,
      );
      return;
    }

    // ===== Editar método pegando contenido verbatim (por país) =====
    const pmBodyMatch = replySource.match(/PMBODY:([A-Za-z0-9_-]+)/);
    if (pmBodyMatch) {
      const cc = pmBodyMatch[1].toUpperCase();
      const body = text; // verbatim, incluye saltos de línea
      if (!body.trim()) {
        await sendMessage("warehouse", msg.chat.id, `El contenido está vacío.`);
        return;
      }
      const { data: prev } = await sb
        .from("payment_methods")
        .select("country_name, currency, usd_rate")
        .eq("country_code", cc)
        .limit(1)
        .maybeSingle();
      const meta = extractPmMetadata(body);
      // Borra TODO lo anterior del país (evita duplicados/mezclas)
      await sb.from("payment_methods").delete().eq("country_code", cc);
      const { data: inserted, error } = await sb.from("payment_methods").insert({
        country_code: cc,
        country_name: prev?.country_name ?? cc,
        method_name: meta.method_name ?? "Pago",
        holder_name: meta.holder_name,
        account_info: meta.account_info,
        extra_info: null,
        currency: prev?.currency ?? "USD",
        usd_rate: Number(prev?.usd_rate ?? 1),
        body_raw: body,
        active: true,
      } as never).select().single();
      if (error || !inserted) {
        await sendMessage("warehouse", msg.chat.id, `Error guardando: ${error?.message ?? "desconocido"}`);
        return;
      }
      await sb.from("admin_logs").insert({
        admin_telegram_id: msg.from.id,
        action: "pm_body_replace",
        target_type: "payment_method",
        target_id: (inserted as { id: string }).id,
        details: { country_code: cc } as never,
      });
      await sendMessage(
        "warehouse",
        msg.chat.id,
        `✅ Método de <b>${escapeHtml(prev?.country_name ?? cc)}</b> reemplazado.\n\n` +
          `Así lo verá el usuario:\n\n${body}`,
      );
      return;
    }

    // ===== Agregar país nuevo (primera línea = header, resto = body) =====
    if (replySource.includes("PMNEW")) {
      const allLines = text.split(/\r?\n/);
      const headerLine = allLines.shift() ?? "";
      const body = allLines.join("\n").trim();
      const parts = headerLine.split("|").map((s) => s.trim());
      if (parts.length < 2 || !parts[0] || !parts[1] || !body) {
        await sendMessage(
          "warehouse",
          msg.chat.id,
          `Formato inválido. Primera línea: <code>CÓDIGO | Nombre País | MONEDA | Tasa</code> y luego el contenido.`,
        );
        return;
      }
      const cc = parts[0].toUpperCase();
      const country_name = parts[1];
      const currency = (parts[2] || "USD").toUpperCase();
      const rate = Number((parts[3] ?? "1").replace(",", "."));
      const meta = extractPmMetadata(body);
      await sb.from("payment_methods").delete().eq("country_code", cc);
      const { data: inserted, error } = await sb.from("payment_methods").insert({
        country_code: cc,
        country_name,
        method_name: meta.method_name ?? "Pago",
        holder_name: meta.holder_name,
        account_info: meta.account_info,
        extra_info: null,
        currency,
        usd_rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
        body_raw: body,
        active: true,
      } as never).select().single();
      if (error || !inserted) {
        await sendMessage("warehouse", msg.chat.id, `Error guardando: ${error?.message ?? "desconocido"}`);
        return;
      }
      await sb.from("admin_logs").insert({
        admin_telegram_id: msg.from.id,
        action: "pm_new_country",
        target_type: "payment_method",
        target_id: (inserted as { id: string }).id,
        details: { country_code: cc } as never,
      });
      await sendMessage(
        "warehouse",
        msg.chat.id,
        `✅ País <b>${escapeHtml(country_name)}</b> agregado (moneda ${currency}, tasa ${Number.isFinite(rate) && rate > 0 ? rate : 1}).\n\n${body}`,
      );
      return;
    }


    // ===== Renombrar producto =====
    const prodRenameMatch = replySource.match(/PRODRENAME:([a-f0-9-]{36})/);
    if (prodRenameMatch) {
      const productId = prodRenameMatch[1];
      const newName = text.trim();
      if (newName.length < 2 || newName.length > 60) {
        await sendMessage("warehouse", msg.chat.id, `Nombre inválido (2-60 caracteres).`);
        return;
      }
      const { error } = await sb.from("products").update({ name: newName }).eq("id", productId);
      if (error) {
        await sendMessage("warehouse", msg.chat.id, `Error: ${error.message}`);
        return;
      }
      invalidateCatalogCache();
      await sb.from("admin_logs").insert({
        admin_telegram_id: msg.from.id,
        action: "product_rename",
        target_type: "product",
        target_id: productId,
        details: { name: newName } as never,
      });
      await sendMessage("warehouse", msg.chat.id, `✅ Producto renombrado a <b>${escapeHtml(newName)}</b>.`);
      await adminProductMenu(msg.chat.id, productId);
      return;
    }

    // ===== Cambiar recarga mínima =====
    if (replySource.includes("MINRECHARGE")) {
      const n = Number(text.replace(",", "."));
      if (!Number.isFinite(n) || n <= 0 || n > 10000) {
        await sendMessage("warehouse", msg.chat.id, `Monto inválido. Ejemplo: <code>4</code>`);
        return;
      }
      const { error } = await sb
        .from("telegram_bot_settings")
        .upsert({ singleton: true, min_recharge_usd: n });
      if (error) {
        await sendMessage("warehouse", msg.chat.id, `Error: ${error.message}`);
        return;
      }
      await sb.from("admin_logs").insert({
        admin_telegram_id: msg.from.id,
        action: "min_recharge_set",
        target_type: "settings",
        target_id: "singleton",
        details: { min_recharge_usd: n } as never,
      });
      await sendMessage(
        "warehouse",
        msg.chat.id,
        `✅ Recarga mínima actualizada a <b>$${n.toFixed(2)} USD</b>.`,
      );
      return;
    }


    // ===== Buscar usuario por ID =====
    if (replySource.includes("FINDUSER")) {
      const id = parseInt(text.replace(/\D/g, ""), 10);
      if (!Number.isFinite(id) || id <= 0) {
        await sendMessage("warehouse", msg.chat.id, `ID inválido.`);
        return;
      }
      await adminUserDetail(msg.chat.id, id);
      return;
    }

    // ===== Editar precio base =====
    const priceEditMatch = replySource.match(/PRICEEDIT:([a-f0-9-]{36})/);
    if (priceEditMatch) {
      const priceId = priceEditMatch[1];
      const n = Number(text.replace(",", "."));
      if (!Number.isFinite(n) || n <= 0) {
        await sendMessage("warehouse", msg.chat.id, `Precio inválido. Ejemplo: <code>4.50</code>`);
        return;
      }
      const { data: updated } = await sb
        .from("product_prices")
        .update({ price_usd: n })
        .eq("id", priceId)
        .select("duration_label, products(name)")
        .maybeSingle();
      if (!updated) {
        await sendMessage("warehouse", msg.chat.id, `Variante no encontrada.`);
        return;
      }
      invalidateCatalogCache();
      const name = (updated as { products: { name: string } }).products.name;
      await sendMessage(
        "warehouse",
        msg.chat.id,
        `✅ <b>Precio actualizado</b>\n${name} · ${updated.duration_label} → <b>$${n.toFixed(2)}</b>`,
      );
      return;
    }

    // ===== Editar precio personal por usuario =====
    const uPriceMatch = replySource.match(/UPRICEEDIT:(\d+):([a-f0-9-]{36})/);
    if (uPriceMatch) {
      const tgId = parseInt(uPriceMatch[1], 10);
      const priceId = uPriceMatch[2];
      if (/^reset$/i.test(text.trim())) {
        await sb.from("user_price_overrides").delete()
          .eq("telegram_id", tgId).eq("price_id", priceId);
        await sendMessage("warehouse", msg.chat.id, `🧹 Descuento personal eliminado para <code>${tgId}</code>.`);
        await adminUserDiscountProducts(msg.chat.id, tgId);
        return;
      }
      const n = Number(text.replace(",", "."));
      if (!Number.isFinite(n) || n < 0) {
        await sendMessage("warehouse", msg.chat.id, `Precio inválido. Ejemplo: <code>3.00</code> o <code>reset</code>.`);
        return;
      }
      const { error } = await sb.from("user_price_overrides").upsert(
        { telegram_id: tgId, price_id: priceId, price_usd: n },
        { onConflict: "telegram_id,price_id" },
      );
      if (error) {
        await sendMessage("warehouse", msg.chat.id, `Error: ${error.message}`);
        return;
      }
      const { data: p } = await sb
        .from("product_prices")
        .select("duration_label, products(name)")
        .eq("id", priceId)
        .maybeSingle();
      const name = (p as { products: { name: string } } | null)?.products.name ?? "—";
      await sendMessage(
        "warehouse",
        msg.chat.id,
        `🎁 <b>Descuento personal aplicado</b>\nUsuario <code>${tgId}</code>\n${name} · ${p?.duration_label ?? "—"} → <b>$${n.toFixed(2)}</b>`,
      );
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
        await sendMessage("warehouse", msg.chat.id, `Usuario no encontrado.`);
        return;
      }
      const body = (msg.text ?? msg.caption ?? "").trim();
      if (msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        const fileInfo = await getFile("warehouse", photo.file_id);
        if (!fileInfo.ok || !fileInfo.result) {
          await sendMessage("warehouse", msg.chat.id, `No pude procesar la imagen.`);
          return;
        }
        const bytes = await downloadFile("warehouse", fileInfo.result.file_path);
        if (!bytes) {
          await sendMessage("warehouse", msg.chat.id, `No pude descargar la imagen.`);
          return;
        }
        const caption = body ? `<b>Mensaje del Admin</b>\n\n${escapeHtml(body)}` : `<b>Mensaje del Admin</b>`;
        const r = await sendPhotoMultipart("shop", target.chat_id, bytes, "admin.jpg", caption);
        await sendMessage(
          "warehouse",
          msg.chat.id,
          r.ok ? `Imagen enviada a ${target.display_name ?? tgId}.` : `No se pudo enviar.`,
        );
      } else {
        if (!body) {
          await sendMessage("warehouse", msg.chat.id, `Mensaje vacío.`);
          return;
        }
        const r = await sendMessage(
          "shop",
          target.chat_id,
          `<b>Mensaje del Admin</b>\n\n${escapeHtml(body)}`,
        );
        await sendMessage(
          "warehouse",
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





    const addKeysMatch = replySource.match(/ADDKEYS:([a-f0-9-]{36})/i);
    if (addKeysMatch && text.length > 0) {
      const priceId = addKeysMatch[1];
      const { data: price } = await sb
        .from("product_prices")
        .select("id, product_id, duration_label, products(name)")
        .eq("id", priceId)
        .single();
      if (!price) {
        await sendMessage("warehouse", msg.chat.id, `Variante no encontrada.`);
        return;
      }

      const parsedKeys = [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
      if (parsedKeys.length === 0) {
        await sendMessage("warehouse", msg.chat.id, `No detecté keys válidas.`);
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
        "warehouse",
        msg.chat.id,
        `<b>Keys cargadas</b>  ·  ${(price as { products: { name: string } }).products.name} / ${price.duration_label}\nNuevas  ${newKeys.length}\nDuplicadas omitidas  ${parsedKeys.length - newKeys.length}`,
      );
      return;
    }
  }

  // ===== barra inferior persistente =====
  switch (text) {
    case ADMIN_BOTTOM.inicio:
      await patchContext(msg.from.id, { bar_shown: false });
      await sendMessage(
        "warehouse",
        msg.chat.id,
        `<b>Almacén listo ✅</b>\nUsá la barra inferior para todas las funciones.`,
        { reply_markup: adminBottomKeyboard() },
      );
      await patchContext(msg.from.id, { bar_shown: true });
      return;
    case ADMIN_TODO.stock:
      await adminStockView(msg.chat.id);
      return;
    case ADMIN_TODO.usuarios:
      await adminUsuarios(msg.chat.id);
      return;
    case ADMIN_BOTTOM.addkeys:
      await adminListProducts(msg.chat.id);
      return;
    case ADMIN_TODO.precios:
      await adminListaPrecios(msg.chat.id);
      return;
    case ADMIN_BOTTOM.productos:
      await adminProductsList(msg.chat.id);
      return;
    case ADMIN_TODO.minrecharge:
      await adminPromptMinRecharge(msg.chat.id);
      return;
    case ADMIN_TODO.anuncio:
      await adminPromptAnuncio(msg.chat.id);
      return;
    case ADMIN_BOTTOM.metodos:
      await pmMenu(msg.chat.id);
      return;
    case ADMIN_TODO.borrar:
      await cleanAdminChat(msg.chat.id, msg.from.id);
      return;
    case ADMIN_BOTTOM.todo:
      await showTodoMenu(msg.chat.id);
      return;
  }

  if (text === "/delete" || text === "/borrar") {
    await cleanAdminChat(msg.chat.id, msg.from.id);
    return;
  }

  if (text === "/stock") return adminStockView(msg.chat.id);
  if (text === "/precios") return adminListaPrecios(msg.chat.id);

  if (text.startsWith("/setprecio ")) {
    const [, rawPriceId, rawUsd] = text.split(/\s+/);
    const newValue = Number(rawUsd);
    if (!rawPriceId || !rawUsd || !Number.isFinite(newValue) || newValue <= 0) {
      await sendMessage("warehouse", msg.chat.id, `Uso: /setprecio &lt;priceId&gt; &lt;usd&gt;`);
      return;
    }
    const priceId = await resolvePriceId(rawPriceId);
    if (!priceId) {
      await sendMessage("warehouse", msg.chat.id, `ID de variante inválido o ambiguo. Usá /precios.`);
      return;
    }
    const { data: updated } = await sb
      .from("product_prices")
      .update({ price_usd: newValue })
      .eq("id", priceId)
      .select("id, duration_label, products(name)")
      .maybeSingle();
    if (!updated) {
      await sendMessage("warehouse", msg.chat.id, `No encontré esa variante. Usá /precios.`);
      return;
    }
    invalidateCatalogCache();
    await sendMessage(
      "warehouse",
      msg.chat.id,
      `<b>Precio actualizado</b>  ·  ${(updated as { products: { name: string } }).products.name} / ${updated.duration_label}  →  $${newValue.toFixed(2)}`,
    );
    return;
  }

  if (text.startsWith("/addkeys ")) {
    const [, priceId] = text.split(/\s+/);
    const resolvedPriceId = await resolvePriceId(priceId ?? "");
    if (!resolvedPriceId) {
      await sendMessage("warehouse", msg.chat.id, `Uso: /addkeys &lt;priceId&gt;`);
      return;
    }
    await adminPromptKeys(msg.chat.id, resolvedPriceId);
    return;
  }

  if (text.startsWith("/ocultar_sin_stock ")) {
    const [, mode] = text.split(/\s+/);
    if (!["on", "off"].includes(mode)) {
      await sendMessage("warehouse", msg.chat.id, `Uso: /ocultar_sin_stock on|off`);
      return;
    }
    await sb.from("telegram_bot_settings").upsert({ singleton: true, hide_out_of_stock: mode === "on" });
    invalidateCatalogCache();
    await sendMessage("warehouse", msg.chat.id, `Ocultar sin stock  <b>${mode.toUpperCase()}</b>`);
    return;
  }

  if (text === "/usuarios") return adminUsuarios(msg.chat.id);
}

// ===== Callbacks =====
async function handleCallback(cb: TgCallback) {
  if (!isAdmin(cb.from.id)) {
    await answerCallbackQuery("warehouse", cb.id, "No autorizado", true);
    return;
  }
  // ACK en paralelo
  answerCallbackQuery("warehouse", cb.id).catch(() => {});
  const data = cb.data ?? "";
  const chat_id = cb.message?.chat.id;

  if (data === "akp:inicio") {
    if (chat_id) {
      await patchContext(cb.from.id, { bar_shown: false });
      const sent = await sendMessage(
        "warehouse",
        chat_id,
        `<b>Almacén listo ✅</b>\nUsá la barra inferior para todas las funciones.`,
        { reply_markup: adminBottomKeyboard() },
      );
      if (sent.ok && sent.result) {
        await patchContext(cb.from.id, { bar_shown: true });
      }
    }
    return;
  }
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
    if (chat_id) await sendMessage("warehouse", chat_id, `Los comprobantes pendientes se gestionan desde el bot admin principal.`);
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
  if (data === "pm:addnew") { if (chat_id) await pmPromptAddCountry(chat_id); return; }
  if (data === "pm:editlist") { if (chat_id) await pmListAll(chat_id, "edit"); return; }
  if (data === "pm:dellist") { if (chat_id) await pmListAll(chat_id, "del"); return; }
  if (data === "pm:countries") { if (chat_id) await pmCountriesView(chat_id); return; }
  if (data.startsWith("pmec:")) { if (chat_id) await pmPromptCountryReplace(chat_id, data.slice(5)); return; }
  if (data.startsWith("pm:del:")) { if (chat_id) await pmConfirmDelete(chat_id, data.slice(7)); return; }
  if (data.startsWith("pmdel:")) {
    const pmId = data.slice(6);
    await sb.from("payment_methods").delete().eq("id", pmId);
    await sb.from("admin_logs").insert({ admin_telegram_id: cb.from.id, action: "pm_delete", target_type: "payment_method", target_id: pmId });
    if (chat_id) await sendMessage("warehouse", chat_id, `Método eliminado.`);
    return;
  }
  if (data === "akp:minrec") { if (chat_id) await adminPromptMinRecharge(chat_id); return; }
  if (data === "akp:borrar") { if (chat_id) await cleanAdminChat(chat_id, cb.from.id); return; }

  // ===== Envío de key manual (redirigido desde el shop cuando no hay stock) =====
  if (data.startsWith("alm:sendkey:")) {
    if (!chat_id) return;
    const order_id = data.slice("alm:sendkey:".length);
    const { data: ord } = await sb
      .from("orders")
      .select("id, telegram_id, products(name), product_prices(duration_label)")
      .eq("id", order_id)
      .maybeSingle();
    if (!ord) {
      await sendMessage("warehouse", chat_id, `Orden no encontrada.`);
      return;
    }
    const name = (ord as { products: { name: string } | null }).products?.name ?? "—";
    const dur = (ord as { product_prices: { duration_label: string } | null }).product_prices?.duration_label ?? "—";
    const sent = await sendMessage(
      "warehouse",
      chat_id,
      `<b>ALMSENDKEY:${order_id}</b>\n\n` +
        `Producto  ${name}\n` +
        `Duración  ${dur}\n` +
        `Usuario   <code>${ord.telegram_id}</code>\n\n` +
        `Respondé a este mensaje pegando la key. Se enviará solo a este usuario.`,
      { reply_markup: { force_reply: true, selective: true } },
    );
    if (sent.ok && sent.result) {
      await sb.from("orders").update({ admin_message_id: sent.result.message_id }).eq("id", order_id);
    }
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
        "warehouse",
        chat_id,
        `<b>MSGUSER:${tgId}</b>\n\nRespondé a este mensaje con el texto que querés enviarle al usuario <code>${tgId}</code>.`,
      );
    }
    return;
  }
  if (data.startsWith("akusrdisc:")) {
    if (chat_id) await adminUserDiscountProducts(chat_id, parseInt(data.slice(10), 10));
    return;
  }
  if (data.startsWith("udprod:")) {
    const [, tg, pid] = data.split(":");
    if (chat_id) await adminUserDiscountDurations(chat_id, parseInt(tg, 10), pid);
    return;
  }
  if (data.startsWith("upred:")) {
    const [, tg, prid] = data.split(":");
    if (chat_id) await adminPromptUserPrice(chat_id, parseInt(tg, 10), prid);
    return;
  }
  if (data === "akp:prlist") {
    if (chat_id) await adminListaPrecios(chat_id);
    return;
  }
  if (data.startsWith("prprod:")) {
    if (chat_id) await adminPriceDurations(chat_id, data.slice(7));
    return;
  }
  if (data.startsWith("pred:")) {
    if (chat_id) await adminPromptNewPrice(chat_id, data.slice(5));
    return;
  }

  // ===== Productos: gestión =====
  if (data === "akp:prodlist") {
    if (chat_id) await adminProductsList(chat_id);
    return;
  }
  if (data.startsWith("prodm:")) {
    if (chat_id) await adminProductMenu(chat_id, data.slice(6));
    return;
  }
  if (data.startsWith("prodren:")) {
    if (chat_id) await adminPromptProductRename(chat_id, data.slice(8));
    return;
  }
  if (data.startsWith("prodtog:")) {
    const pid = data.slice(8);
    const { data: p } = await sb.from("products").select("active").eq("id", pid).maybeSingle();
    if (p) {
      await sb.from("products").update({ active: !p.active }).eq("id", pid);
      invalidateCatalogCache();
      await sb.from("admin_logs").insert({
        admin_telegram_id: cb.from.id,
        action: "product_toggle",
        target_type: "product",
        target_id: pid,
        details: { active: !p.active } as never,
      });
    }
    if (chat_id) await adminProductMenu(chat_id, pid);
    return;
  }
  if (data.startsWith("proddel:")) {
    if (chat_id) await adminConfirmProductDelete(chat_id, data.slice(8));
    return;
  }
  if (data.startsWith("proddelok:")) {
    const pid = data.slice(10);
    // Borrar en cascada: keys, precios y producto
    await sb.from("product_stock_keys").delete().eq("product_id", pid);
    await sb.from("product_prices").delete().eq("product_id", pid);
    const { error } = await sb.from("products").delete().eq("id", pid);
    if (error) {
      if (chat_id) await sendMessage("warehouse", chat_id, `Error: ${error.message}`);
      return;
    }
    invalidateCatalogCache();
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "product_delete",
      target_type: "product",
      target_id: pid,
    });
    if (chat_id) {
      await sendMessage("warehouse", chat_id, `🗑 Producto eliminado.`);
      await adminProductsList(chat_id);
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

  // ===== bloquear desde detalle de usuario =====
  const [, action, target] = data.split(":");

  if (action === "block") {
    const tgId = parseInt(target, 10);
    await blockUserPermanent(tgId, "admin_block");
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "block_user",
      target_type: "telegram_id",
      target_id: target,
    });
    await answerCallbackQuery("warehouse", cb.id, "Usuario bloqueado.", true);
    if (chat_id) await adminUserDetail(chat_id, tgId);
    return;
  }

  if (chat_id) {
    await sendMessage("warehouse", chat_id, `Esa opción ya no está disponible. Usa la barra inferior para continuar.`, {
      reply_markup: adminBottomKeyboard(),
    });
  }
}
