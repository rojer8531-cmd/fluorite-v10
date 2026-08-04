// Admin Bot — handler (UI limpia, barra inferior persistente)
import {
  sendMessage as _rawSendMessage,
  editMessageReplyMarkup as _rawEditMessageReplyMarkup,
  editMessageText as _rawEditMessageText,
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

/** El botón "🏠 Inicio" vuelve a estar activo: no se filtra nada. */
function stripInicio<T extends Record<string, unknown>>(extra: T): T {
  return extra;
}

async function editMessageText(
  bot: "shop" | "warehouse",
  chat_id: number | string,
  message_id: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return _rawEditMessageText(bot, chat_id, message_id, text, bot === "warehouse" ? stripInicio(extra) : extra);
}

async function editMessageReplyMarkup(
  bot: "shop" | "warehouse",
  chat_id: number | string,
  message_id: number,
  reply_markup: unknown,
) {
  const rm =
    bot === "warehouse"
      ? (stripInicio({ reply_markup } as Record<string, unknown>).reply_markup as unknown)
      : reply_markup;
  return _rawEditMessageReplyMarkup(bot, chat_id, message_id, rm as never);
}

async function sendMessage(
  bot: "shop" | "warehouse",
  chat_id: number | string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  if (bot === "warehouse") extra = stripInicio(extra);
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

const EXTRA_AUTHORIZED_IDS = new Set(["8844591762"]);
function isAdmin(telegram_id: number) {
  const id = String(telegram_id);
  return id === String(getWarehouseChatId()) || EXTRA_AUTHORIZED_IDS.has(id);
}





// ===== Barra inferior persistente del almacén =====
const ADMIN_BOTTOM = {
  inicio: "🏠 Inicio",
  addkeys: "➕ Agregar Keys",
  productos: "📦 Productos",
  precios: "💰 Precios",
  metodos: "💳 Métodos",
  todo: "❇️ Todo",
};

// Opciones agrupadas dentro del menú "Todo"
const ADMIN_TODO = {
  stock: "Stock",
  minrecharge: "Recarga Mínima",
  usuarios: "Usuarios",
  borrar: "Borrar",
};

function adminBottomKeyboard() {
  return {
    keyboard: [
      [{ text: ADMIN_BOTTOM.addkeys }, { text: ADMIN_BOTTOM.productos }],
      [{ text: ADMIN_BOTTOM.precios }, { text: ADMIN_BOTTOM.metodos }],
      [{ text: `👥 ${ADMIN_TODO.usuarios}` }, { text: ADMIN_BOTTOM.todo }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

// ===== Barra inferior permanente =====
const ADMIN_BACK_LABEL = "⬅️ Atrás";

/**
 * La barra inferior principal nunca desaparece: al entrar a cualquier módulo
 * simplemente se asegura que siga visible (no se reemplaza por "⬅️ Atrás").
 */
async function showBackBar(chat_id: number, admin_id: number) {
  await ensureAdminBar(chat_id, admin_id).catch(() => {});
}

/** Muestra el menú principal y garantiza la barra inferior. Nunca borra mensajes. */
async function restoreMainBar(
  chat_id: number,
  admin_id: number,
  _message_id?: number,
) {
  const MAIN_TEXT = `<b>🏠 Menú Principal</b>\n\nSelecciona una opción.`;
  await sendMessage("warehouse", chat_id, MAIN_TEXT, {
    reply_markup: adminBottomKeyboard(),
  });
  await patchContext(admin_id, { bar_shown: true }).catch(() => {});
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
          [{ text: ADMIN_TODO.minrecharge, callback_data: "akp:minrec" }, { text: ADMIN_TODO.borrar, callback_data: "akp:borrar" }],
          [{ text: "🏠 Inicio", callback_data: "akp:inicio" }],
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
      // Ya no se purgan mensajes anteriores: la navegación es por edición.
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
  // Adjuntar la barra inferior sin borrar ningún mensaje
  await sendMessage("warehouse", chat_id, "\u2063", {
    reply_markup: adminBottomKeyboard(),
  });
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
    // Editar el mensaje anterior en lugar de borrarlo
    const edited = await editMessageText("warehouse", chat_id, prev, text, {
      reply_markup: kb ? { inline_keyboard: kb } : undefined,
    }).catch(() => ({ ok: false }) as { ok: boolean });
    if (edited.ok) return;
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
  await sendMessage("warehouse", chat_id, `<b>💳 Métodos de Pago</b>\n\nSeleccioná una opción:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Agregar método", callback_data: "pm:add" }],
        [{ text: "✏️ Editar método", callback_data: "pm:editlist" }],
        [{ text: "🗑️ Eliminar método", callback_data: "pm:dellist" }],
        [{ text: "📋 Ver métodos", callback_data: "pm:countries" }],
        [{ text: "⬅️ Volver", callback_data: "akp:inicio" }],
      ],
    },
  });
}


async function pmListAll(chat_id: number, mode: "edit" | "del") {
  const { data: methods } = await sb
    .from("payment_methods")
    .select("id, country_code, country_name, method_name, active")
    .eq("active", true)
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

  // Mostrar solo países que tengan al menos un método registrado.
  const seenDel = new Set<string>();
  const countriesDel: Array<{ code: string; name: string }> = [];
  for (const m of methods) {
    if (seenDel.has(m.country_code)) continue;
    seenDel.add(m.country_code);
    countriesDel.push({ code: m.country_code, name: m.country_name });
  }
  const kb = countriesDel.map((c) => [
    { text: `${flagFromCC(c.code)} ${c.name}`, callback_data: `pm:delc:${c.code}` },
  ]);
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>🗑️ Eliminar Método</b>\n\nElegí un país:`,
    { reply_markup: { inline_keyboard: kb } },
  );
}

function flagFromCC(cc: string): string {
  const code = (cc || "").toUpperCase();
  if (code.length !== 2 || !/^[A-Z]{2}$/.test(code)) return "🌐";
  const A = 0x1f1e6;
  return String.fromCodePoint(A + code.charCodeAt(0) - 65, A + code.charCodeAt(1) - 65);
}

async function pmConfirmDeleteCountry(chat_id: number, country_code: string) {
  const { data: m } = await sb
    .from("payment_methods")
    .select("country_name")
    .eq("country_code", country_code)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (!m) {
    await sendMessage("warehouse", chat_id, `No hay método para ese país.`);
    return;
  }
  const label = `${flagFromCC(country_code)} ${m.country_name}`;
  await sendMessage(
    "warehouse",
    chat_id,
    `¿Eliminar <b>${label}</b>?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "☑️ Eliminar", callback_data: `pm:delcgo:${country_code}` }],
        ],
      },
    },
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

function deriveCountryCode(name: string): string {
  const key = name.trim().toLowerCase();
  if (COUNTRY_MAP[key]) return COUNTRY_MAP[key];
  const clean = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
  return (clean.slice(0, 2) || "XX").toUpperCase();
}

async function pmPromptAddStep1(chat_id: number) {
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>PMADD1</b>\n\n🌎 ¿Para qué país deseas agregar un método de pago?\n\nRespondé a este mensaje con el nombre del país.\nEjemplo: <code>Argentina</code>`,
    { reply_markup: { force_reply: true, selective: true } },
  );
}

async function pmPromptAddStep2(chat_id: number, cc: string, country_name: string) {
  await sendMessage(
    "warehouse",
    chat_id,
    `<b>PMADD2:${cc}|${country_name}</b>\n\n📋 Ahora pegá el método de pago completo para <b>${escapeHtml(country_name)}</b>.\n\nSe guardará exactamente como lo envíes, respetando emojis, saltos de línea y formato.`,
    { reply_markup: { force_reply: true, selective: true } },
  );
}

async function pmConfirmReplaceExisting(chat_id: number, cc: string, country_name: string) {
  await patchContext(Number(adminId()), { pm_pending: { cc, name: country_name } });
  await sendMessage(
    "warehouse",
    chat_id,
    `⚠️ Ya existe un método para <b>${escapeHtml(country_name)}</b>. ¿Deseas reemplazarlo?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Reemplazar", callback_data: "pmadd:replace" },
            { text: "❌ Cancelar", callback_data: "pmadd:cancel" },
          ],
        ],
      },
    },
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

// ===== Módulo "Métodos de pago" (un solo mensaje, siempre editado) =====
interface PmFlow {
  chat_id: number;
  message_id: number;
  step?: "country" | "body";
  country?: string;
  cc?: string;
  body?: string;
  currency?: string;
  rate?: number;
}

/**
 * Deduce la moneda y la tasa (moneda local por 1 USD) desde la plantilla que
 * pegó el admin, usando las líneas dinámicas 💰 Monto / 🧾 Pagas / 💵 Total.
 * Ej: "💰 Monto: 1 USD" + "💵 Total: 40 NIO" => { currency: "NIO", rate: 40 }.
 */
function parsePmRate(raw: string): { currency: string; rate: number } {
  const num = (s: string) => {
    const clean = s.replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const m = clean.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  };
  let usd = NaN;
  let local = NaN;
  let currency = "";
  for (const line of raw.split(/\r?\n/)) {
    const mMonto = line.match(/💰\s*Monto\s*:\s*(.+)/i);
    if (mMonto && !Number.isFinite(usd)) usd = num(mMonto[1]);
    const mLocal = line.match(/(?:💵\s*Total|🧾\s*Pagas)\s*:\s*(.+)/i);
    if (mLocal && !Number.isFinite(local)) {
      local = num(mLocal[1]);
      const cur = mLocal[1].replace(/<[^>]+>/g, "").match(/([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,10})\s*$/);
      if (cur) currency = cur[1].toUpperCase();
    }
  }
  if (!Number.isFinite(usd) || usd <= 0) usd = 1;
  const rate = Number.isFinite(local) && local > 0 ? local / usd : 1;
  return { currency: currency || "USD", rate };
}

const PM_HOME_BTN = { text: "🏠 Inicio", callback_data: "akp:inicio" };

async function getPmFlow(uid: number): Promise<PmFlow | null> {
  const st = await getState(uid);
  const flow = (st?.context as Record<string, unknown> | undefined)?.pm_flow as PmFlow | undefined;
  return flow && flow.message_id ? flow : null;
}

async function setPmFlow(uid: number, flow: PmFlow | null) {
  await patchContext(uid, { pm_flow: flow });
}

async function pmRender(
  chat_id: number,
  uid: number,
  text: string,
  keyboard: AkKeyboard,
  message_id?: number,
  extra: Partial<PmFlow> = {},
) {
  let anchor = message_id ?? null;
  if (anchor) {
    const edited = await editMessageText("warehouse", chat_id, anchor, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    if (!edited.ok) anchor = null;
  }
  if (!anchor) {
    const sent = await _rawSendMessage("warehouse", chat_id, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
    if (sent.ok && sent.result) {
      anchor = sent.result.message_id;
      sb.from("admin_trash")
        .insert({ chat_id, message_id: anchor })
        .then(() => {}, () => {});
    }
  }
  if (anchor) await setPmFlow(uid, { chat_id, message_id: anchor, ...extra });
  return anchor;
}

/** Limpia los valores dinámicos (Recarga, Monto, Pagas, Total) dejando la plantilla. */
function pmCleanTemplate(raw: string): string {
  const dyn = /^(\s*(?:🆔\s*Recarga|💰\s*Monto|🧾\s*Pagas|💵\s*Total)\s*:).*$/i;
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(dyn);
      return m ? `${m[1]}` : line;
    })
    .join("\n")
    .trim();
}

async function pmStartFresh(chat_id: number, uid: number) {
  const prev = await getPmFlow(uid);
  const anchor = prev && prev.chat_id === chat_id ? prev.message_id : undefined;
  await pmMenuFlow(chat_id, uid, anchor);
}

async function pmMenuFlow(chat_id: number, uid: number, message_id?: number, header?: string) {
  const head = header ? `${header}\n\n` : "";
  await pmRender(
    chat_id,
    uid,
    `${head}❇️ <b>Administrar métodos de pago</b>`,
    [
      [{ text: "➕ Agregar método", callback_data: "pmf:add" }],
      [{ text: "➖ Eliminar método", callback_data: "pmf:dellist" }],
      [{ text: "📦 Todos los disponibles", callback_data: "pmf:all" }],
      [PM_HOME_BTN],
    ],
    message_id,
  );
}

async function pmAskCountry(chat_id: number, uid: number, message_id?: number) {
  await pmRender(
    chat_id,
    uid,
    `❇️ <b>Envía el nombre del país.</b>\n\nEjemplo:\n<code>Nicaragua</code>`,
    [[{ text: "🔚 Atrás", callback_data: "pmf:menu" }, PM_HOME_BTN]],
    message_id,
    { step: "country" },
  );
}

async function pmAskBody(chat_id: number, uid: number, country: string, cc: string, message_id?: number) {
  await pmRender(
    chat_id,
    uid,
    `❇️ <b>Envía los datos del nuevo método.</b>\n\n🌎 ${flagFromCC(cc)} ${escapeHtml(country)}`,
    [[{ text: "🔚 Atrás", callback_data: "pmf:add" }, PM_HOME_BTN]],
    message_id,
    { step: "body", country, cc },
  );
}

async function pmPreview(
  chat_id: number,
  uid: number,
  flow: PmFlow,
  body: string,
  currency: string,
  rate: number,
) {
  const rateLine =
    rate && rate !== 1
      ? `\n\n💱 Tasa detectada: <b>1 USD = ${rate.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${escapeHtml(currency)}</b>`
      : `\n\n💱 Tasa detectada: <b>1 USD = 1 ${escapeHtml(currency)}</b>`;
  await pmRender(
    chat_id,
    uid,
    `❇️ <b>Todo listo.</b>\n\n⭕️ <b>Nuevo método</b>\n\n${escapeHtml(body)}${rateLine}`,
    [
      [
        { text: "🔘 Guardar", callback_data: "pmf:save" },
        { text: "🔚 Atrás", callback_data: "pmf:menu" },
      ],
    ],
    flow.message_id,
    { country: flow.country, cc: flow.cc, body, currency, rate },
  );
}

async function pmSaveFlow(chat_id: number, uid: number, flow: PmFlow) {
  if (!flow.cc || !flow.country || !flow.body) {
    await pmMenuFlow(chat_id, uid, flow.message_id, `⭕️ <b>No hay datos para guardar.</b>`);
    return;
  }
  const meta = extractPmMetadata(flow.body);
  const currency = flow.currency || "USD";
  const rate = Number.isFinite(flow.rate) && (flow.rate as number) > 0 ? (flow.rate as number) : 1;
  // Desactivamos los anteriores (no se borran por integridad con órdenes previas)
  await sb.from("payment_methods").update({ active: false }).eq("country_code", flow.cc);
  const { error } = await sb.from("payment_methods").insert({
    country_code: flow.cc,
    country_name: flow.country,
    method_name: meta.method_name ?? "Pago",
    holder_name: meta.holder_name,
    account_info: meta.account_info,
    extra_info: null,
    currency,
    usd_rate: rate,
    body_raw: flow.body,
    active: true,
  } as never);
  if (error) {
    await pmMenuFlow(chat_id, uid, flow.message_id, `⭕️ <b>Error:</b> ${escapeHtml(error.message)}`);
    return;
  }
  await pmRender(
    chat_id,
    uid,
    `✅ <b>${escapeHtml(flow.country)} guardado correctamente.</b>`,
    [[{ text: "🔚 Atrás", callback_data: "pmf:menu" }, PM_HOME_BTN]],
    flow.message_id,
  );
}

async function pmCountriesList(): Promise<Array<{ code: string; name: string }>> {
  const { data } = await sb
    .from("payment_methods")
    .select("country_code, country_name")
    .eq("active", true)
    .order("country_name");
  const seen = new Set<string>();
  const out: Array<{ code: string; name: string }> = [];
  for (const m of data ?? []) {
    if (seen.has(m.country_code)) continue;
    seen.add(m.country_code);
    out.push({ code: m.country_code, name: m.country_name });
  }
  return out;
}

async function pmDelListFlow(chat_id: number, uid: number, message_id?: number) {
  const countries = await pmCountriesList();
  if (countries.length === 0) {
    await pmMenuFlow(chat_id, uid, message_id, `⭕️ <b>No hay métodos registrados.</b>`);
    return;
  }
  const kb: AkKeyboard = [];
  for (let i = 0; i < countries.length; i += 2) {
    const row = [{ text: countries[i].name, callback_data: `pmf:delc:${countries[i].code}` }];
    if (countries[i + 1]) row.push({ text: countries[i + 1].name, callback_data: `pmf:delc:${countries[i + 1].code}` });
    kb.push(row);
  }
  kb.push([{ text: "🔚 Atrás", callback_data: "pmf:menu" }, PM_HOME_BTN]);
  await pmRender(chat_id, uid, `❇️ <b>Métodos disponibles</b>`, kb, message_id);
}

async function pmDelConfirmFlow(chat_id: number, uid: number, cc: string, message_id?: number) {
  const { data: m } = await sb
    .from("payment_methods")
    .select("country_name")
    .eq("country_code", cc)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (!m) {
    await pmDelListFlow(chat_id, uid, message_id);
    return;
  }
  await pmRender(
    chat_id,
    uid,
    `❇️ <b>Método de pago</b>\n\n${flagFromCC(cc)} ${escapeHtml(m.country_name)}`,
    [
      [
        { text: "🗑️ Eliminar", callback_data: `pmf:delgo:${cc}` },
        { text: "🔏 Cancelar", callback_data: "pmf:dellist" },
      ],
      [{ text: "🔚 Atrás", callback_data: "pmf:dellist" }, PM_HOME_BTN],
    ],
    message_id,
  );
}

async function pmDelGoFlow(chat_id: number, uid: number, cc: string, message_id?: number) {
  const { data: m } = await sb
    .from("payment_methods")
    .select("country_name")
    .eq("country_code", cc)
    .limit(1)
    .maybeSingle();
  const name = m?.country_name ?? cc;
  // Desactivar SIEMPRE primero (funciona aunque existan órdenes que referencian el método)
  const { error: offErr } = await sb
    .from("payment_methods")
    .update({ active: false })
    .eq("country_code", cc);
  // Intento de borrado físico; si hay órdenes ligadas, queda sólo desactivado.
  await sb.from("payment_methods").delete().eq("country_code", cc).eq("active", false);
  if (offErr) {
    await pmDelListFlow(chat_id, uid, message_id);
    return;
  }
  await pmRender(
    chat_id,
    uid,
    `❇️ <b>${escapeHtml(name)} eliminado correctamente.</b>`,
    [[{ text: "🔚 Atrás", callback_data: "pmf:dellist" }, PM_HOME_BTN]],
    message_id,
  );
}

async function pmAllFlow(chat_id: number, uid: number, message_id?: number) {
  const countries = await pmCountriesList();
  const list = countries.length
    ? countries.map((c) => `${flagFromCC(c.code)} ${escapeHtml(c.name)}`).join("\n")
    : "Sin métodos registrados.";
  await pmRender(
    chat_id,
    uid,
    `❇️ <b>Métodos disponibles</b>\n\n${list}`,
    [[{ text: "🔚 Atrás", callback_data: "pmf:menu" }, PM_HOME_BTN]],
    message_id,
  );
}

/** Texto enviado durante el flujo de Métodos. */
async function pmSubmitText(msg: TgMessage, flow: PmFlow, rawText: string) {
  const uid = msg.from!.id;
  const chat_id = flow.chat_id;
  // no borrar mensajes del chat almacén

  if (flow.step === "country") {
    const country = rawText.trim().replace(/\s+/g, " ");
    if (country.length < 2 || country.length > 40) {
      await pmAskCountry(chat_id, uid, flow.message_id);
      return;
    }
    await pmAskBody(chat_id, uid, country, deriveCountryCode(country), flow.message_id);
    return;
  }

  if (flow.step === "body" && flow.cc && flow.country) {
    const { currency, rate } = parsePmRate(rawText);
    const body = pmCleanTemplate(rawText);
    if (!body) {
      await pmAskBody(chat_id, uid, flow.country, flow.cc, flow.message_id);
      return;
    }
    await pmPreview(chat_id, uid, flow, body, currency, rate);
    return;
  }

  await pmMenuFlow(chat_id, uid, flow.message_id);
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


// ===== Wizard "Agregar Keys" (un solo mensaje, siempre editado) =====
interface AkFlow {
  chat_id: number;
  message_id: number;
  product_id?: string;
  price_id?: string;
}

async function getAkFlow(uid: number): Promise<AkFlow | null> {
  const st = await getState(uid);
  const flow = (st?.context as Record<string, unknown> | undefined)?.ak_flow as AkFlow | undefined;
  return flow && flow.message_id ? flow : null;
}

async function setAkFlow(uid: number, flow: AkFlow | null) {
  await patchContext(uid, { ak_flow: flow });
}

type AkKeyboard = Array<Array<{ text: string; callback_data: string }>>;

/** Edita el mensaje ancla del wizard; si no se puede, crea uno nuevo. */
async function akRender(
  chat_id: number,
  uid: number,
  text: string,
  keyboard: AkKeyboard,
  message_id?: number,
  extra: Partial<AkFlow> = {},
) {
  let anchor = message_id ?? null;
  if (anchor) {
    const edited = await editMessageText("warehouse", chat_id, anchor, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    if (!edited.ok) anchor = null;
  }
  if (!anchor) {
    const sent = await _rawSendMessage("warehouse", chat_id, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
    if (sent.ok && sent.result) {
      anchor = sent.result.message_id;
      sb.from("admin_trash")
        .insert({ chat_id, message_id: anchor })
        .then(() => {}, () => {});
    }
  }
  if (anchor) {
    await setAkFlow(uid, { chat_id, message_id: anchor, ...extra });
  }
  return anchor;
}

const AK_HOME_BTN = { text: "🏠 Inicio", callback_data: "akp:inicio" };

/** Abre el wizard desde la barra inferior: borra el ancla previa y crea una nueva. */
async function akStartFresh(chat_id: number, uid: number) {
  const prev = await getAkFlow(uid);
  const anchor = prev && prev.chat_id === chat_id ? prev.message_id : undefined;
  await adminListProducts(chat_id, uid, anchor);
}

async function adminListProducts(chat_id: number, uid: number, message_id?: number) {
  const { data: products } = await sb
    .from("products")
    .select("id, name, category")
    .eq("active", true)
    .order("sort_order");
  if (!products || products.length === 0) {
    await akRender(chat_id, uid, `<b>Agregar Keys</b>\n\nNo hay productos cargados.`, [[AK_HOME_BTN]], message_id);
    return;
  }
  const kb: AkKeyboard = products.map((p) => [
    { text: `${p.name}  ·  ${p.category}`, callback_data: `akprod:${p.id}` },
  ]);
  kb.push([AK_HOME_BTN]);
  await akRender(chat_id, uid, `<b>Agregar Keys</b>\n\nElegí el producto:`, kb, message_id);
}

async function adminListDurations(chat_id: number, uid: number, product_id: string, message_id?: number) {
  const { data: prices } = await sb
    .from("product_prices")
    .select("id, duration_label, products(name)")
    .eq("product_id", product_id)
    .eq("active", true)
    .order("sort_order");
  if (!prices || prices.length === 0) {
    await akRender(
      chat_id,
      uid,
      `Ese producto no tiene duraciones cargadas.`,
      [[{ text: "🔙 Atrás", callback_data: "akp:add" }, AK_HOME_BTN]],
      message_id,
      { product_id },
    );
    return;
  }
  const name = (prices[0] as { products: { name: string } }).products.name;
  const kb: AkKeyboard = prices.map((p) => [
    { text: `${p.duration_label}`, callback_data: `akdur:${p.id}` },
  ]);
  kb.push([{ text: "🔙 Atrás", callback_data: "akp:add" }, AK_HOME_BTN]);
  await akRender(
    chat_id,
    uid,
    `📦 <b>Producto:</b> ${escapeHtml(name)}\n\nElegí la duración:`,
    kb,
    message_id,
    { product_id },
  );
}

async function adminPromptKeys(chat_id: number, uid: number, price_id: string, message_id?: number) {
  const { data: price } = await sb
    .from("product_prices")
    .select("id, product_id, duration_label, products(name)")
    .eq("id", price_id)
    .maybeSingle();
  if (!price) {
    await akRender(chat_id, uid, `Variante no encontrada.`, [[{ text: "🔙 Atrás", callback_data: "akp:add" }, AK_HOME_BTN]], message_id);
    return;
  }
  const name = (price as { products: { name: string } }).products.name;
  await akRender(
    chat_id,
    uid,
    `📦 <b>Producto:</b> ${escapeHtml(name)}\n⏳ <b>Duración:</b> ${escapeHtml(price.duration_label)}\n\nEnviá las keys (una por línea).`,
    [[{ text: "🔙 Atrás", callback_data: `akback:${price.product_id}` }, AK_HOME_BTN]],
    message_id,
    { product_id: price.product_id, price_id },
  );
}

/** Procesa las keys enviadas por el admin y edita el mismo mensaje del wizard. */
async function akSubmitKeys(msg: TgMessage, flow: AkFlow, rawText: string) {
  const uid = msg.from!.id;
  // no borrar mensajes del chat almacén

  const { data: price } = await sb
    .from("product_prices")
    .select("id, product_id, duration_label, products(name)")
    .eq("id", flow.price_id!)
    .maybeSingle();
  if (!price) {
    await adminListProducts(flow.chat_id, uid, flow.message_id);
    return;
  }
  const name = (price as { products: { name: string } }).products.name;

  const parsedKeys = [...new Set(rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
  const backKb: AkKeyboard = [[{ text: "🔙 Atrás", callback_data: `akback:${price.product_id}` }, AK_HOME_BTN]];

  if (parsedKeys.length === 0) {
    await akRender(
      flow.chat_id,
      uid,
      `📦 <b>Producto:</b> ${escapeHtml(name)}\n⏳ <b>Duración:</b> ${escapeHtml(price.duration_label)}\n\n⚠️ No detecté keys válidas. Enviá las keys (una por línea).`,
      backKb,
      flow.message_id,
      { product_id: price.product_id, price_id: price.id },
    );
    return;
  }

  const { data: existing } = await sb
    .from("product_stock_keys")
    .select("key_value")
    .in("key_value", parsedKeys);
  const existingSet = new Set((existing ?? []).map((r) => r.key_value));
  const newKeys = parsedKeys.filter((v) => !existingSet.has(v));

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

  const dup = parsedKeys.length - newKeys.length;
  const text =
    `✅ <b>Stock Agregado Correctamente</b>\n\n` +
    `📦 <b>Producto:</b> ${escapeHtml(name)}\n` +
    `⏳ <b>Duración:</b> ${escapeHtml(price.duration_label)}\n` +
    `➕ <b>Agregadas:</b> ${newKeys.length}` +
    (dup > 0 ? `\n♻️ <b>Duplicadas:</b> ${dup}` : "");

  await akRender(flow.chat_id, uid, text, backKb, flow.message_id, {
    product_id: price.product_id,
  });
}


const ST_HOME_BTN = { text: "🏠 Inicio", callback_data: "akp:inicio" };

async function stRender(
  chat_id: number,
  text: string,
  keyboard: AkKeyboard,
  message_id?: number,
) {
  if (message_id) {
    const edited = await editMessageText("warehouse", chat_id, message_id, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    if (edited.ok) return;
  }
  const sent = await _rawSendMessage("warehouse", chat_id, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
  if (sent.ok && sent.result) {
    sb.from("admin_trash")
      .insert({ chat_id, message_id: sent.result.message_id })
      .then(() => {}, () => {});
  }
}

async function adminStockView(chat_id: number, message_id?: number) {
  const kb: AkKeyboard = [
    [
      { text: "🎟️ iOS", callback_data: "stcat:0" },
      { text: "🎟️ Android", callback_data: "stcat:1" },
    ],
    [{ text: "🎟️ Auxilio de Famosos", callback_data: "stcat:2" }],
    [ST_HOME_BTN],
  ];
  await stRender(chat_id, `🛍️ <b>Categorías</b>`, kb, message_id);
}

async function adminStockCategory(
  chat_id: number,
  category: string,
  message_id?: number,
) {
  const [productsRes, pricesRes] = await Promise.all([
    sb
      .from("products")
      .select("id, name")
      .eq("active", true)
      .eq("category", category as never)
      .order("sort_order"),
    sb
      .from("product_prices")
      .select("id, product_id, duration_label")
      .eq("active", true)
      .order("sort_order"),
  ]);
  const products = productsRes.data ?? [];
  const prices = pricesRes.data ?? [];
  const stock = await getStockByPriceId();

  const kb: AkKeyboard = [[{ text: "🔚 Atrás", callback_data: "akp:stock" }, ST_HOME_BTN]];

  if (products.length === 0) {
    await stRender(chat_id, `❇️ <b>Stock disponible</b>\n\nNo hay productos en esta categoría.`, kb, message_id);
    return;
  }

  const blocks: string[] = [];
  for (const product of products) {
    const lines = [`🔘 <b>${escapeHtml(product.name)}</b>`];
    for (const p of prices.filter((x) => x.product_id === product.id)) {
      lines.push(`💲 ${escapeHtml(p.duration_label)} 🟰 ${stock.get(p.id) ?? 0}`);
    }
    blocks.push(lines.join("\n"));
  }

  await stRender(chat_id, `❇️ <b>Stock disponible</b>\n\n${blocks.join("\n\n")}`, kb, message_id);
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
  const [{ count: deliveredCount }, { data: blocked }] = await Promise.all([
    sb
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("telegram_id", telegram_id)
      .eq("status", "delivered"),
    sb
      .from("blocked_users")
      .select("blocked_until")
      .eq("telegram_id", telegram_id)
      .maybeSingle(),
  ]);

  const { normalizeRank, RANK_INFO } = await import("./ranks.server");
  const rankInfo = RANK_INFO[normalizeRank(u.rank)];

  const relDate = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diffDays <= 0) return "Hoy";
    if (diffDays === 1) return "Ayer";
    if (diffDays < 30) return `Hace ${diffDays} días`;
    const months = Math.floor(diffDays / 30);
    return months === 1 ? "Hace 1 mes" : `Hace ${months} meses`;
  };

  const isBlocked = !!blocked;
  const statusLine = isBlocked ? "🔴 Estado: Bloqueado" : "🟢 Estado: Activo";
  const displayName = u.display_name ?? u.username ?? "Sin nombre";

  const text =
    `👤 <b>${escapeHtml(displayName)}</b>\n` +
    `🆔 <code>${u.telegram_id}</code>\n\n` +
    `${statusLine}\n` +
    `⌛️ Rango: ${escapeHtml(rankInfo.label)}\n\n` +
    `💰 Saldo: $${Number(u.balance).toFixed(2)} USD\n` +
    `📦 Ventas totales: ${deliveredCount ?? 0}\n\n` +
    `🗓️ Registro: ${relDate(u.registered_at)}\n` +
    `🕘 Última conexión: ${relDate(u.last_seen_at)}`;

  const msgBtn: { text: string; callback_data?: string; url?: string } = u.username
    ? { text: "💬 Mensaje", url: `https://t.me/${u.username}` }
    : { text: "💬 Mensaje", callback_data: `akusrmsg:${u.telegram_id}` };

  const blockBtn = isBlocked
    ? { text: "🔓 Desbloquear", callback_data: `akusrunblock:${u.telegram_id}` }
    : { text: "🚫 Bloquear", callback_data: `adm:block:${u.telegram_id}` };

  const buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [msgBtn, blockBtn],
    [
      { text: "🎁 Descuento", callback_data: `akusrdisc:${u.telegram_id}` },
      { text: "🪬 Directo", callback_data: `akusrmsg:${u.telegram_id}` },
    ],
    [
      { text: "🏠 Inicio", callback_data: "akp:inicio" },
      { text: "↩️ Volver", callback_data: "akp:users" },
    ],
  ];

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

// ===== Módulo "Precios" (un solo mensaje, siempre editado) =====
interface PrFlow {
  chat_id: number;
  message_id: number;
  product_id?: string;
  price_id?: string;
}

async function getPrFlow(uid: number): Promise<PrFlow | null> {
  const st = await getState(uid);
  const flow = (st?.context as Record<string, unknown> | undefined)?.pr_flow as PrFlow | undefined;
  return flow && flow.message_id ? flow : null;
}

async function setPrFlow(uid: number, flow: PrFlow | null) {
  await patchContext(uid, { pr_flow: flow });
}

const PR_HOME_BTN = { text: "🏠 Inicio", callback_data: "akp:inicio" };

async function prRender(
  chat_id: number,
  uid: number,
  text: string,
  keyboard: AkKeyboard,
  message_id?: number,
  extra: Partial<PrFlow> = {},
) {
  let anchor = message_id ?? null;
  if (anchor) {
    const edited = await editMessageText("warehouse", chat_id, anchor, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    if (!edited.ok) anchor = null;
  }
  if (!anchor) {
    const sent = await _rawSendMessage("warehouse", chat_id, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
    if (sent.ok && sent.result) {
      anchor = sent.result.message_id;
      sb.from("admin_trash")
        .insert({ chat_id, message_id: anchor })
        .then(() => {}, () => {});
    }
  }
  if (anchor) {
    await setPrFlow(uid, { chat_id, message_id: anchor, ...extra });
  }
  return anchor;
}

async function adminListaPrecios(chat_id: number, uid: number, message_id?: number) {
  const { data: products } = await sb
    .from("products")
    .select("id, name, category")
    .eq("active", true)
    .order("sort_order");
  if (!products || products.length === 0) {
    await prRender(chat_id, uid, `💲 <b>Editar Precios</b>\n\n📦 No hay productos cargados.`, [[PR_HOME_BTN]], message_id);
    return;
  }
  const kb: AkKeyboard = products.map((p) => [
    { text: `${p.name}`, callback_data: `prprod:${p.id}` },
  ]);
  kb.push([PR_HOME_BTN]);
  await prRender(chat_id, uid, `💲 <b>Editar Precios</b>\n\n📦 Elegí el producto:`, kb, message_id);
}

async function prStartFresh(chat_id: number, uid: number) {
  const prev = await getPrFlow(uid);
  const anchor = prev && prev.chat_id === chat_id ? prev.message_id : undefined;
  await adminListaPrecios(chat_id, uid, anchor);
}

async function adminPriceDurations(chat_id: number, uid: number, product_id: string, message_id?: number) {
  const { data: prices } = await sb
    .from("product_prices")
    .select("id, duration_label, price_usd, products(name)")
    .eq("product_id", product_id)
    .eq("active", true)
    .order("sort_order");
  if (!prices || prices.length === 0) {
    await prRender(
      chat_id,
      uid,
      `💲 <b>Editar Precios</b>\n\n📦 Ese producto no tiene duraciones cargadas.`,
      [[{ text: "🔚 Atrás", callback_data: "akp:prlist" }, PR_HOME_BTN]],
      message_id,
    );
    return;
  }
  const name = (prices[0] as { products: { name: string } }).products.name;
  const kb: AkKeyboard = prices.map((p) => [
    { text: `${p.duration_label}`, callback_data: `pred:${p.id}` },
  ]);
  kb.push([{ text: "🔚 Atrás", callback_data: "akp:prlist" }, PR_HOME_BTN]);
  await prRender(
    chat_id,
    uid,
    `💲 <b>Editar Precios</b>\n\n📦 ${escapeHtml(name)}\n\nElegí la duración:`,
    kb,
    message_id,
    { product_id },
  );
}

async function adminPromptNewPrice(chat_id: number, uid: number, price_id: string, message_id?: number) {
  const { data: p } = await sb
    .from("product_prices")
    .select("product_id, duration_label, price_usd, products(name)")
    .eq("id", price_id)
    .maybeSingle();
  if (!p) {
    await prRender(chat_id, uid, `💲 <b>Editar Precio</b>\n\n📦 Variante no encontrada.`, [[PR_HOME_BTN]], message_id);
    return;
  }
  const name = (p as { products: { name: string } }).products.name;
  await prRender(
    chat_id,
    uid,
    `💲 <b>Editar Precio</b>\n\n📦 ${escapeHtml(name)}\n🛍️ ${escapeHtml(p.duration_label)}\n💰 $${Number(p.price_usd).toFixed(2)} USD\n\nEnviá el nuevo precio.\nEjemplo: <code>4.50</code>`,
    [[{ text: "🔚 Atrás", callback_data: `prback:${p.product_id}` }, PR_HOME_BTN]],
    message_id,
    { product_id: p.product_id, price_id },
  );
}

async function prSubmitPrice(msg: TgMessage, flow: PrFlow, rawText: string) {
  const uid = msg.from!.id;
  // no borrar mensajes del chat almacén

  const { data: p } = await sb
    .from("product_prices")
    .select("product_id, duration_label, price_usd, products(name)")
    .eq("id", flow.price_id!)
    .maybeSingle();
  if (!p) {
    await adminListaPrecios(flow.chat_id, uid, flow.message_id);
    return;
  }
  const name = (p as { products: { name: string } }).products.name;
  const n = Number(rawText.trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) {
    await prRender(
      flow.chat_id,
      uid,
      `💲 <b>Editar Precio</b>\n\n📦 ${escapeHtml(name)}\n🛍️ ${escapeHtml(p.duration_label)}\n💰 $${Number(p.price_usd).toFixed(2)} USD\n\nPrecio inválido. Enviá el nuevo precio.\nEjemplo: <code>4.50</code>`,
      [[{ text: "🔚 Atrás", callback_data: `prback:${p.product_id}` }, PR_HOME_BTN]],
      flow.message_id,
      { product_id: p.product_id, price_id: flow.price_id },
    );
    return;
  }

  await sb.from("product_prices").update({ price_usd: n }).eq("id", flow.price_id!);
  invalidateCatalogCache();

  await prRender(
    flow.chat_id,
    uid,
    `✅ <b>Precio actualizado.</b>\n\n📦 ${escapeHtml(name)}\n🛍️ ${escapeHtml(p.duration_label)}\n💰 $${n.toFixed(2)} USD`,
    [[{ text: "🔚 Atrás", callback_data: `prback:${p.product_id}` }, PR_HOME_BTN]],
    flow.message_id,
    { product_id: p.product_id },
  );
}



// ===== Módulo "Productos" (un solo mensaje, siempre editado) =====
type PdCategory = "iOS" | "Android" | "Auxiliar de Famosos";
const PD_CATEGORIES: PdCategory[] = ["iOS", "Android", "Auxiliar de Famosos"];

interface PdDraft {
  name?: string;
  p1?: number;
  p7?: number;
  p30?: number;
}

interface PdFlow {
  chat_id: number;
  message_id: number;
  category?: PdCategory;
  product_id?: string;
  step?: "rename" | "addname" | "addprice";
  which?: "1" | "7" | "30";
  draft?: PdDraft;
}

async function getPdFlow(uid: number): Promise<PdFlow | null> {
  const st = await getState(uid);
  const flow = (st?.context as Record<string, unknown> | undefined)?.pd_flow as PdFlow | undefined;
  return flow && flow.message_id ? flow : null;
}

async function setPdFlow(uid: number, flow: PdFlow | null) {
  await patchContext(uid, { pd_flow: flow });
}

const PD_HOME_BTN = { text: "🏠 Inicio", callback_data: "akp:inicio" };

async function pdRender(
  chat_id: number,
  uid: number,
  text: string,
  keyboard: AkKeyboard,
  message_id?: number,
  extra: Partial<PdFlow> = {},
) {
  let anchor = message_id ?? null;
  if (anchor) {
    const edited = await editMessageText("warehouse", chat_id, anchor, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    if (!edited.ok) anchor = null;
  }
  if (!anchor) {
    const sent = await _rawSendMessage("warehouse", chat_id, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
    if (sent.ok && sent.result) {
      anchor = sent.result.message_id;
      sb.from("admin_trash")
        .insert({ chat_id, message_id: anchor })
        .then(() => {}, () => {});
    }
  }
  if (anchor) {
    await setPdFlow(uid, { chat_id, message_id: anchor, ...extra });
  }
  return anchor;
}

async function pdCategories(chat_id: number, uid: number, message_id?: number) {
  const kb: AkKeyboard = [
    [
      { text: "🏷️ iOS", callback_data: "pdcat:0" },
      { text: "🏷️ Android", callback_data: "pdcat:1" },
    ],
    [{ text: "🏷️ Auxiliar de Famosos", callback_data: "pdcat:2" }],
    [PD_HOME_BTN],
  ];
  await pdRender(chat_id, uid, `🛍️ <b>Categorías</b>`, kb, message_id, {});
}

async function pdStartFresh(chat_id: number, uid: number) {
  const prev = await getPdFlow(uid);
  const anchor = prev && prev.chat_id === chat_id ? prev.message_id : undefined;
  await pdCategories(chat_id, uid, anchor);
}

async function pdList(chat_id: number, uid: number, category: PdCategory, message_id?: number) {
  const { data: products } = await sb
    .from("products")
    .select("id, name, active")
    .eq("category", category)
    .order("sort_order");
  const kb: AkKeyboard = (products ?? []).map((p) => [
    { text: `${p.active ? "🔜" : "⏸️"} ${p.name}`, callback_data: `pdp:${p.id}` },
  ]);
  kb.push([{ text: "➕ Agregar producto", callback_data: "pdadd" }]);
  kb.push([{ text: "🔚 Atrás", callback_data: "pdcats" }, PD_HOME_BTN]);
  await pdRender(
    chat_id,
    uid,
    `❇️ <b>Lista de productos</b>\n\n🏷️ ${escapeHtml(category)}`,
    kb,
    message_id,
    { category },
  );
}

async function pdProductMenu(chat_id: number, uid: number, product_id: string, message_id?: number) {
  const { data: p } = await sb
    .from("products")
    .select("id, name, category, active")
    .eq("id", product_id)
    .maybeSingle();
  if (!p) {
    await pdCategories(chat_id, uid, message_id);
    return;
  }
  const category = p.category as PdCategory;
  const kb: AkKeyboard = [
    [{ text: "🔏 Renombrar", callback_data: `pdren:${p.id}` }],
    [
      {
        text: p.active ? "🔏 Desactivar" : "🔏 Activar",
        callback_data: `pdtog:${p.id}`,
      },
    ],
    [{ text: "🗑️ Eliminar definitivamente", callback_data: `pddel:${p.id}` }],
    [{ text: "🔚 Atrás", callback_data: "pdback" }, PD_HOME_BTN],
  ];
  await pdRender(
    chat_id,
    uid,
    `${p.active ? "✅" : "⏸️"} <b>${escapeHtml(p.name)}</b> ${p.active ? "activo" : "desactivado"}`,
    kb,
    message_id,
    { category, product_id: p.id },
  );
}

async function pdPromptRename(chat_id: number, uid: number, product_id: string, message_id?: number) {
  const { data: p } = await sb.from("products").select("name, category").eq("id", product_id).maybeSingle();
  if (!p) return pdCategories(chat_id, uid, message_id);
  await pdRender(
    chat_id,
    uid,
    `🔏 <b>Renombrar</b>\n\n📦 Producto: ${escapeHtml(p.name)}\n\n❇️ Envía el nuevo nombre del producto.`,
    [[{ text: "🔚 Atrás", callback_data: `pdp:${product_id}` }, PD_HOME_BTN]],
    message_id,
    { category: p.category as PdCategory, product_id, step: "rename" },
  );
}

async function pdConfirmDeactivate(chat_id: number, uid: number, product_id: string, message_id?: number) {
  const { data: p } = await sb.from("products").select("name, category, active").eq("id", product_id).maybeSingle();
  if (!p) return pdCategories(chat_id, uid, message_id);
  await pdRender(
    chat_id,
    uid,
    `🚨 <b>${p.active ? "Desactivar" : "Activar"} ${escapeHtml(p.name)}</b>`,
    [
      [
        { text: "☑️ Yes", callback_data: `pdtogok:${product_id}` },
        { text: "☑️ No", callback_data: `pdp:${product_id}` },
      ],
      [{ text: "🔚 Atrás", callback_data: `pdp:${product_id}` }, PD_HOME_BTN],
    ],
    message_id,
    { category: p.category as PdCategory, product_id },
  );
}

async function pdApplyToggle(chat_id: number, uid: number, product_id: string, message_id?: number) {
  const { data: p } = await sb.from("products").select("name, category, active").eq("id", product_id).maybeSingle();
  if (!p) return pdCategories(chat_id, uid, message_id);
  const next = !p.active;
  await sb.from("products").update({ active: next }).eq("id", product_id);
  invalidateCatalogCache();
  sb.from("admin_logs")
    .insert({
      admin_telegram_id: uid,
      action: "product_toggle",
      target_type: "product",
      target_id: product_id,
      details: { active: next } as never,
    })
    .then(() => {}, () => {});
  await pdRender(
    chat_id,
    uid,
    `✅ <b>${next ? "Activado" : "Desactivado"} correctamente.</b>\n\n📦 Producto: ${escapeHtml(p.name)}\n📌 Estado: ${next ? "Activo" : "Desactivado"}`,
    [[{ text: "🔚 Atrás", callback_data: `pdp:${product_id}` }, PD_HOME_BTN]],
    message_id,
    { category: p.category as PdCategory, product_id },
  );
}

async function pdConfirmDelete(chat_id: number, uid: number, product_id: string, message_id?: number) {
  const { data: p } = await sb.from("products").select("name, category").eq("id", product_id).maybeSingle();
  if (!p) return pdCategories(chat_id, uid, message_id);
  await pdRender(
    chat_id,
    uid,
    `⭕️ <b>Eliminar ${escapeHtml(p.name)}</b>`,
    [
      [
        { text: "☑️ Yes", callback_data: `pddelok:${product_id}` },
        { text: "☑️ Cancelar", callback_data: `pdp:${product_id}` },
      ],
      [{ text: "🔚 Atrás", callback_data: `pdp:${product_id}` }, PD_HOME_BTN],
    ],
    message_id,
    { category: p.category as PdCategory, product_id },
  );
}

async function pdApplyDelete(chat_id: number, uid: number, product_id: string, message_id?: number) {
  const { data: p } = await sb.from("products").select("name, category").eq("id", product_id).maybeSingle();
  if (!p) return pdCategories(chat_id, uid, message_id);
  await sb.from("product_stock_keys").delete().eq("product_id", product_id);
  await sb.from("product_prices").delete().eq("product_id", product_id);
  const { error } = await sb.from("products").delete().eq("id", product_id);
  if (error) {
    await pdProductMenu(chat_id, uid, product_id, message_id);
    return;
  }
  invalidateCatalogCache();
  sb.from("admin_logs")
    .insert({
      admin_telegram_id: uid,
      action: "product_delete",
      target_type: "product",
      target_id: product_id,
    })
    .then(() => {}, () => {});
  await pdRender(
    chat_id,
    uid,
    `✅ <b>Eliminado correctamente.</b>\n\n📦 Producto: ${escapeHtml(p.name)}\n📌 Eliminado: ${escapeHtml(p.name)}`,
    [[{ text: "🔚 Atrás", callback_data: "pdback" }, PD_HOME_BTN]],
    message_id,
    { category: p.category as PdCategory },
  );
}

// ----- Agregar producto -----
function pdFmtPrice(n?: number) {
  if (n == null) return "—";
  return Number.isInteger(n) ? `$${n} USD` : `$${n.toFixed(2)} USD`;
}

async function pdPromptAddName(chat_id: number, uid: number, category: PdCategory, message_id?: number) {
  await pdRender(
    chat_id,
    uid,
    `❇️ <b>Envía el nombre del producto.</b>`,
    [[{ text: "🔚 Atrás", callback_data: "pdback" }, PD_HOME_BTN]],
    message_id,
    { category, step: "addname", draft: {} },
  );
}

async function pdPricesMenu(chat_id: number, uid: number, flow: PdFlow, message_id?: number) {
  const d = flow.draft ?? {};
  if (d.p1 != null && d.p7 != null && d.p30 != null) {
    await pdRender(
      chat_id,
      uid,
      `❇️ <b>Todo listo para agregar.</b>\n\n📦 Producto: ${escapeHtml(d.name ?? "")}\n💲 1 día: ${pdFmtPrice(d.p1)}\n💲 7 días: ${pdFmtPrice(d.p7)}\n💲 30 días: ${pdFmtPrice(d.p30)}`,
      [
        [
          { text: "☑️ Yes", callback_data: "pdsave" },
          { text: "☑️ Cancelar", callback_data: "pdback" },
        ],
        [{ text: "🔚 Atrás", callback_data: "pdprices" }, PD_HOME_BTN],
      ],
      message_id,
      { category: flow.category, draft: d, step: undefined },
    );
    return;
  }
  await pdRender(
    chat_id,
    uid,
    `🛍️ <b>Precios del producto</b>\n\n📦 Producto: ${escapeHtml(d.name ?? "")}`,
    [
      [{ text: `💲 1 día  ${pdFmtPrice(d.p1)}`, callback_data: "pdprset:1" }],
      [{ text: `💲 7 días  ${pdFmtPrice(d.p7)}`, callback_data: "pdprset:7" }],
      [{ text: `💲 30 días  ${pdFmtPrice(d.p30)}`, callback_data: "pdprset:30" }],
      [{ text: "🔚 Atrás", callback_data: "pdback" }, PD_HOME_BTN],
    ],
    message_id,
    { category: flow.category, draft: d, step: undefined },
  );
}

async function pdPromptAddPrice(
  chat_id: number,
  uid: number,
  flow: PdFlow,
  which: "1" | "7" | "30",
  message_id?: number,
) {
  await pdRender(
    chat_id,
    uid,
    `➕ <b>Envía el precio del producto.</b>\n\n📦 Producto: ${escapeHtml(flow.draft?.name ?? "")}\n💲 ${which} ${which === "1" ? "día" : "días"}`,
    [[{ text: "🔚 Atrás", callback_data: "pdprices" }, PD_HOME_BTN]],
    message_id,
    { category: flow.category, draft: flow.draft ?? {}, step: "addprice", which },
  );
}

async function pdSaveProduct(chat_id: number, uid: number, flow: PdFlow) {
  const d = flow.draft ?? {};
  const category = flow.category;
  if (!category || !d.name || d.p1 == null || d.p7 == null || d.p30 == null) {
    await pdCategories(chat_id, uid, flow.message_id);
    return;
  }
  const { data: maxRow } = await sb
    .from("products")
    .select("sort_order")
    .eq("category", category)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = ((maxRow?.sort_order as number | undefined) ?? 0) + 1;
  const { data: prod, error } = await sb
    .from("products")
    .insert({ name: d.name, category, active: true, sort_order: nextSort } as never)
    .select("id")
    .single();
  if (error || !prod) {
    await pdRender(
      chat_id,
      uid,
      `⭕️ No se pudo crear el producto.`,
      [[{ text: "🔚 Atrás", callback_data: "pdback" }, PD_HOME_BTN]],
      flow.message_id,
      { category, draft: d },
    );
    return;
  }
  const pid = (prod as { id: string }).id;
  const priceRows = [
    { product_id: pid, duration_label: "1 Día", duration_days: 1, price_usd: d.p1, active: true, sort_order: 1 },
    { product_id: pid, duration_label: "7 Días", duration_days: 7, price_usd: d.p7, active: true, sort_order: 2 },
    { product_id: pid, duration_label: "30 Días", duration_days: 30, price_usd: d.p30, active: true, sort_order: 3 },
  ];
  const { error: prErr } = await sb.from("product_prices").insert(priceRows as never);
  if (prErr) {
    await sb.from("products").delete().eq("id", pid);
    await pdRender(
      chat_id,
      uid,
      `⭕️ No se pudieron crear los precios.`,
      [[{ text: "🔚 Atrás", callback_data: "pdback" }, PD_HOME_BTN]],
      flow.message_id,
      { category, draft: d },
    );
    return;
  }
  invalidateCatalogCache();
  sb.from("admin_logs")
    .insert({
      admin_telegram_id: uid,
      action: "product_add",
      target_type: "product",
      target_id: pid,
      details: { name: d.name, category, p1: d.p1, p7: d.p7, p30: d.p30 } as never,
    })
    .then(() => {}, () => {});
  await pdRender(
    chat_id,
    uid,
    `✅ <b>Aplicado correctamente.</b>\n\n📦 Producto: ${escapeHtml(d.name)}\n🏷️ ${escapeHtml(category)}\n💲 1 día: ${pdFmtPrice(d.p1)}\n💲 7 días: ${pdFmtPrice(d.p7)}\n💲 30 días: ${pdFmtPrice(d.p30)}`,
    [[{ text: "🔚 Atrás", callback_data: "pdback" }, PD_HOME_BTN]],
    flow.message_id,
    { category, product_id: pid },
  );
}

/** Texto enviado durante el flujo de Productos. */
async function pdSubmitText(msg: TgMessage, flow: PdFlow, rawText: string) {
  const uid = msg.from!.id;
  const chat_id = flow.chat_id;
  // no borrar mensajes del chat almacén
  const text = rawText.trim().replace(/\s+/g, " ");

  if (flow.step === "rename" && flow.product_id) {
    const { data: p } = await sb.from("products").select("name, category").eq("id", flow.product_id).maybeSingle();
    if (!p) return pdCategories(chat_id, uid, flow.message_id);
    if (text.length < 2 || text.length > 60) {
      await pdPromptRename(chat_id, uid, flow.product_id, flow.message_id);
      return;
    }
    await sb.from("products").update({ name: text }).eq("id", flow.product_id);
    invalidateCatalogCache();
    sb.from("admin_logs")
      .insert({
        admin_telegram_id: uid,
        action: "product_rename",
        target_type: "product",
        target_id: flow.product_id,
        details: { name: text } as never,
      })
      .then(() => {}, () => {});
    await pdRender(
      chat_id,
      uid,
      `✅ <b>Aplicado correctamente.</b>\n\n📦 Producto: ${escapeHtml(p.name)}\n✏️ Nuevo nombre: ${escapeHtml(text)}`,
      [[{ text: "🔚 Atrás", callback_data: `pdp:${flow.product_id}` }, PD_HOME_BTN]],
      flow.message_id,
      { category: p.category as PdCategory, product_id: flow.product_id },
    );
    return;
  }

  if (flow.step === "addname") {
    if (text.length < 2 || text.length > 60) {
      await pdPromptAddName(chat_id, uid, flow.category!, flow.message_id);
      return;
    }
    const next: PdFlow = { ...flow, draft: { ...(flow.draft ?? {}), name: text }, step: undefined };
    await pdPricesMenu(chat_id, uid, next, flow.message_id);
    return;
  }

  if (flow.step === "addprice" && flow.which) {
    const n = Number(text.replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      await pdPromptAddPrice(chat_id, uid, flow, flow.which, flow.message_id);
      return;
    }
    const key = flow.which === "1" ? "p1" : flow.which === "7" ? "p7" : "p30";
    const draft = { ...(flow.draft ?? {}), [key]: n } as PdDraft;
    const next: PdFlow = { ...flow, draft, step: undefined, which: undefined };
    if (draft.p1 != null && draft.p7 != null && draft.p30 != null) {
      await pdPricesMenu(chat_id, uid, next, flow.message_id);
      return;
    }
    await pdRender(
      chat_id,
      uid,
      `✅ <b>Aplicado correctamente.</b>\n\n📦 Producto: ${escapeHtml(draft.name ?? "")}\n💲 ${flow.which} ${flow.which === "1" ? "día" : "días"}: ${pdFmtPrice(n)}`,
      [[{ text: "🔚 Atrás", callback_data: "pdprices" }, PD_HOME_BTN]],
      flow.message_id,
      { category: flow.category, draft },
    );
    return;
  }
}


// ===== Módulo "Usuarios" (un solo mensaje, siempre editado) =====
interface UsFlow {
  chat_id: number;
  message_id: number;
  page?: number;
  tg?: number;
  product_id?: string;
  price_id?: string;
  step?: "find" | "msg" | "disc";
}

const US_PAGE_SIZE = 6;
const US_HOME_BTN = { text: "🏠 Inicio", callback_data: "akp:inicio" };

async function getUsFlow(uid: number): Promise<UsFlow | null> {
  const st = await getState(uid);
  const flow = (st?.context as Record<string, unknown> | undefined)?.us_flow as UsFlow | undefined;
  return flow && flow.message_id ? flow : null;
}

async function setUsFlow(uid: number, flow: UsFlow | null) {
  await patchContext(uid, { us_flow: flow });
}

async function usRender(
  chat_id: number,
  uid: number,
  text: string,
  keyboard: AkKeyboard,
  message_id?: number,
  extra: Partial<UsFlow> = {},
) {
  let anchor = message_id ?? null;
  if (anchor) {
    const edited = await editMessageText("warehouse", chat_id, anchor, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    if (!edited.ok) anchor = null;
  }
  if (!anchor) {
    const sent = await _rawSendMessage("warehouse", chat_id, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
    if (sent.ok && sent.result) {
      anchor = sent.result.message_id;
      sb.from("admin_trash")
        .insert({ chat_id, message_id: anchor })
        .then(() => {}, () => {});
    }
  }
  if (anchor) await setUsFlow(uid, { chat_id, message_id: anchor, ...extra });
  return anchor;
}

function usLabel(u: { display_name: string | null; username: string | null }) {
  const name = u.display_name ?? u.username ?? "";
  return name ? `🔘 ${name}` : "⭕️ Usuario";
}

async function usList(chat_id: number, uid: number, page = 0, message_id?: number) {
  const { count } = await sb.from("bot_users").select("id", { count: "exact", head: true });
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / US_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const from = p * US_PAGE_SIZE;
  const { data: users } = await sb
    .from("bot_users")
    .select("telegram_id, username, display_name")
    .order("last_seen_at", { ascending: false })
    .range(from, from + US_PAGE_SIZE - 1);

  const kb: AkKeyboard = [];
  const list = users ?? [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [{ text: usLabel(list[i]), callback_data: `usu:${list[i].telegram_id}` }];
    if (list[i + 1]) row.push({ text: usLabel(list[i + 1]), callback_data: `usu:${list[i + 1].telegram_id}` });
    kb.push(row);
  }
  kb.push([
    { text: "🔚", callback_data: `usp:${p > 0 ? p - 1 : totalPages - 1}` },
    { text: `${p + 1}/${totalPages}`, callback_data: "noop" },
    { text: "🔜", callback_data: `usp:${p + 1 < totalPages ? p + 1 : 0}` },
  ]);
  kb.push([{ text: "🔏 Buscar ID", callback_data: "usfind" }]);
  kb.push([US_HOME_BTN]);

  await usRender(chat_id, uid, `❇️ <b>Lista de usuarios disponibles</b>`, kb, message_id, { page: p });
}

async function usStartFresh(chat_id: number, uid: number) {
  const prev = await getUsFlow(uid);
  const anchor = prev && prev.chat_id === chat_id ? prev.message_id : undefined;
  await usList(chat_id, uid, 0, anchor);
}

async function usPromptFind(chat_id: number, uid: number, message_id?: number) {
  const flow = await getUsFlow(uid);
  await usRender(
    chat_id,
    uid,
    `❇️ <b>Envía el ID.</b>`,
    [[{ text: "🔚 Atrás", callback_data: "usback" }, US_HOME_BTN]],
    message_id,
    { page: flow?.page ?? 0, step: "find" },
  );
}

async function usDetail(
  chat_id: number,
  uid: number,
  telegram_id: number,
  message_id?: number,
  found = false,
) {
  const { data: u } = await sb
    .from("bot_users")
    .select("telegram_id, username, display_name, balance")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  const flow = await getUsFlow(uid);
  if (!u) {
    await usRender(
      chat_id,
      uid,
      `⭕️ <b>Usuario no encontrado.</b>`,
      [[{ text: "🔚 Atrás", callback_data: "usback" }, US_HOME_BTN]],
      message_id,
      { page: flow?.page ?? 0 },
    );
    return;
  }
  const name = u.display_name ?? u.username ?? "Usuario";
  const head = found
    ? `🔏 <b>Usuario encontrado</b>\n\n⭕️ ${escapeHtml(name)}\n🆔 <code>${u.telegram_id}</code>\n💲 Saldo: ${Number(u.balance).toFixed(2)} USD`
    : `⭕️ <b>${escapeHtml(name)}</b>\n\n🆔 <code>${u.telegram_id}</code>\n💲 Saldo: ${Number(u.balance).toFixed(2)} USD`;
  await usRender(
    chat_id,
    uid,
    head,
    [
      [
        { text: "🔜 Mensaje", callback_data: "usmsg" },
        { text: "🔜 Bloquear", callback_data: "usblock" },
      ],
      [{ text: "🔜 Descuento", callback_data: "usdisc" }],
      [{ text: "🔚 Atrás", callback_data: "usback" }, US_HOME_BTN],
    ],
    message_id,
    { page: flow?.page ?? 0, tg: u.telegram_id },
  );
}

async function usPromptMessage(chat_id: number, uid: number, flow: UsFlow, message_id?: number) {
  await usRender(
    chat_id,
    uid,
    `❇️ <b>Envía el mensaje.</b>`,
    [[{ text: "🔚 Atrás", callback_data: "usu:back" }, US_HOME_BTN]],
    message_id,
    { page: flow.page, tg: flow.tg, step: "msg" },
  );
}

async function usConfirmBlock(chat_id: number, uid: number, flow: UsFlow, message_id?: number) {
  const { data: u } = await sb
    .from("bot_users")
    .select("display_name, username, telegram_id")
    .eq("telegram_id", flow.tg!)
    .maybeSingle();
  if (!u) return usList(chat_id, uid, flow.page ?? 0, message_id);
  const name = u.display_name ?? u.username ?? "Usuario";
  await usRender(
    chat_id,
    uid,
    `⛔️ <b>¿Quieres bloquear al usuario?</b>\n\n⭕️ ${escapeHtml(name)}\n🆔 <code>${u.telegram_id}</code>`,
    [
      [
        { text: "🔘 Yes", callback_data: "usblockok" },
        { text: "🔘 Nop", callback_data: "usu:back" },
      ],
      [{ text: "🔚 Atrás", callback_data: "usu:back" }, US_HOME_BTN],
    ],
    message_id,
    { page: flow.page, tg: flow.tg },
  );
}

async function usApplyBlock(chat_id: number, uid: number, flow: UsFlow, message_id?: number) {
  const { data: u } = await sb
    .from("bot_users")
    .select("display_name, username")
    .eq("telegram_id", flow.tg!)
    .maybeSingle();
  const name = u?.display_name ?? u?.username ?? "Usuario";
  await blockUserPermanent(flow.tg!, "admin_block");
  sb.from("admin_logs")
    .insert({
      admin_telegram_id: uid,
      action: "block_user",
      target_type: "telegram_id",
      target_id: String(flow.tg),
    })
    .then(() => {}, () => {});
  await usRender(
    chat_id,
    uid,
    `✅ <b>Bloqueado correctamente.</b>\n\n📦 Usuario: ${escapeHtml(name)}\n🔴 Duración: Permanente`,
    [[{ text: "🔚 Atrás", callback_data: "usu:back" }, US_HOME_BTN]],
    message_id,
    { page: flow.page, tg: flow.tg },
  );
}

async function usDiscountProducts(chat_id: number, uid: number, flow: UsFlow, message_id?: number) {
  const { data: products } = await sb
    .from("products")
    .select("id, name")
    .eq("active", true)
    .order("sort_order");
  const kb: AkKeyboard = (products ?? []).map((p) => [
    { text: p.name, callback_data: `usdp:${p.id}` },
  ]);
  kb.push([{ text: "🔚 Atrás", callback_data: "usu:back" }, US_HOME_BTN]);
  await usRender(chat_id, uid, `❇️ <b>Lista de productos disponibles</b>`, kb, message_id, {
    page: flow.page,
    tg: flow.tg,
  });
}

async function usDiscountDurations(
  chat_id: number,
  uid: number,
  flow: UsFlow,
  product_id: string,
  message_id?: number,
) {
  const [{ data: prod }, { data: prices }] = await Promise.all([
    sb.from("products").select("name").eq("id", product_id).maybeSingle(),
    sb
      .from("product_prices")
      .select("id, duration_label, price_usd")
      .eq("product_id", product_id)
      .eq("active", true)
      .order("sort_order"),
  ]);
  const kb: AkKeyboard = (prices ?? []).map((p) => [
    { text: `💲 ${p.duration_label}`, callback_data: `usde:${p.id}` },
  ]);
  kb.push([{ text: "🔚 Atrás", callback_data: "usdisc" }, US_HOME_BTN]);
  await usRender(
    chat_id,
    uid,
    `⭕️ <b>Descuento personal</b>\n\n🔏 ${escapeHtml(prod?.name ?? "")}`,
    kb,
    message_id,
    { page: flow.page, tg: flow.tg, product_id },
  );
}

async function usPromptDiscount(
  chat_id: number,
  uid: number,
  flow: UsFlow,
  price_id: string,
  message_id?: number,
) {
  await usRender(
    chat_id,
    uid,
    `➕ <b>Envía el descuento del producto.</b>`,
    [[{ text: "🔚 Atrás", callback_data: `usdp:${flow.product_id}` }, US_HOME_BTN]],
    message_id,
    { page: flow.page, tg: flow.tg, product_id: flow.product_id, price_id, step: "disc" },
  );
}

/** Texto enviado durante el flujo de Usuarios. */
async function usSubmitText(msg: TgMessage, flow: UsFlow, rawText: string) {
  const uid = msg.from!.id;
  const chat_id = flow.chat_id;
  // no borrar mensajes del chat almacén
  const text = rawText.trim();

  if (flow.step === "find") {
    const id = parseInt(text.replace(/\D/g, ""), 10);
    if (!Number.isFinite(id) || id <= 0) {
      await usRender(
        chat_id,
        uid,
        `⭕️ <b>Usuario no encontrado.</b>`,
        [[{ text: "🔚 Atrás", callback_data: "usback" }, US_HOME_BTN]],
        flow.message_id,
        { page: flow.page ?? 0 },
      );
      return;
    }
    await usDetail(chat_id, uid, id, flow.message_id, true);
    return;
  }

  if (flow.step === "msg" && flow.tg) {
    const { data: target } = await sb
      .from("bot_users")
      .select("chat_id, display_name, username")
      .eq("telegram_id", flow.tg)
      .maybeSingle();
    if (!target) {
      await usList(chat_id, uid, flow.page ?? 0, flow.message_id);
      return;
    }
    const name = target.display_name ?? target.username ?? "Usuario";
    await sendMessage("shop", target.chat_id, `<b>Mensaje del Admin</b>\n\n${escapeHtml(text)}`);
    await usRender(
      chat_id,
      uid,
      `✅ <b>Enviado correctamente.</b>\n\nEl mensaje fue enviado únicamente al usuario.\n\n⭕️ ${escapeHtml(name)}: Enviado`,
      [[{ text: "🔚 Atrás", callback_data: "usu:back" }, US_HOME_BTN]],
      flow.message_id,
      { page: flow.page, tg: flow.tg },
    );
    return;
  }

  if (flow.step === "disc" && flow.tg && flow.price_id) {
    const n = Number(text.replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      await usPromptDiscount(chat_id, uid, flow, flow.price_id, flow.message_id);
      return;
    }
    await sb.from("user_price_overrides").upsert(
      { telegram_id: flow.tg, price_id: flow.price_id, price_usd: n },
      { onConflict: "telegram_id,price_id" },
    );
    const { data: p } = await sb
      .from("product_prices")
      .select("duration_label, products(name)")
      .eq("id", flow.price_id)
      .maybeSingle();
    const pname = (p as { products?: { name: string } } | null)?.products?.name ?? "";
    await usRender(
      chat_id,
      uid,
      `✅ <b>Aplicado correctamente.</b>\n\n📦 Producto: ${escapeHtml(pname)}\n💲 ${escapeHtml(p?.duration_label ?? "")}: $${n.toFixed(2)} USD`,
      [[{ text: "🔚 Atrás", callback_data: "usdisc" }, US_HOME_BTN]],
      flow.message_id,
      { page: flow.page, tg: flow.tg, product_id: flow.product_id },
    );
    return;
  }
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

  // Borra el mensaje temporal que envía el admin (dato solicitado por el bot).
  const dropAdminInput = () =>
    deleteMessage("warehouse", msg.chat.id, msg.message_id).catch(() => {});

  // ===== Wizard Agregar Keys: captura de keys (edita el mismo mensaje) =====
  if (!msg.reply_to_message && text.length > 0 && !text.startsWith("/")) {
    const labels = [...Object.values(ADMIN_BOTTOM), ...Object.values(ADMIN_TODO), ADMIN_BACK_LABEL, `👥 ${ADMIN_TODO.usuarios}`];
    if (!labels.includes(text)) {
      const pmFlow = await getPmFlow(msg.from.id);
      if (pmFlow?.step) {
        await pmSubmitText(msg, pmFlow, text);
        await dropAdminInput();
        return;
      }
      const usFlow = await getUsFlow(msg.from.id);
      if (usFlow?.step) {
        await usSubmitText(msg, usFlow, text);
        await dropAdminInput();
        return;
      }

      const pdFlow = await getPdFlow(msg.from.id);

      if (pdFlow?.step) {
        await pdSubmitText(msg, pdFlow, text);
        await dropAdminInput();
        return;
      }
      const prFlow = await getPrFlow(msg.from.id);
      if (prFlow?.price_id) {
        await prSubmitPrice(msg, prFlow, text);
        await dropAdminInput();
        return;
      }
      const akFlow = await getAkFlow(msg.from.id);
      if (akFlow?.price_id) {
        await akSubmitKeys(msg, akFlow, text);
        await dropAdminInput();
        return;
      }
    }
  }

  // ===== respuestas (reply) =====
  if (msg.reply_to_message) {
    void dropAdminInput();
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
      // no borrar mensajes del chat almacén
      // no borrar mensajes del chat almacén
      await sendMessage(
        "warehouse",
        msg.chat.id,
        `✅ Key enviada a <code>${u?.telegram_id ?? ord.telegram_id}</code>.`,
      );
      return;
    }




    // ===== Agregar método (paso 1: pedir nombre del país) =====
    if (replySource.includes("PMADD1")) {
      const country_name = text.trim().replace(/\s+/g, " ");
      if (country_name.length < 2 || country_name.length > 40) {
        await sendMessage("warehouse", msg.chat.id, `Nombre de país inválido.`);
        return;
      }
      const cc = deriveCountryCode(country_name);
      const { data: existing } = await sb
        .from("payment_methods")
        .select("id")
        .eq("country_code", cc)
        .limit(1)
        .maybeSingle();
      if (existing) {
        await pmConfirmReplaceExisting(msg.chat.id, cc, country_name);
        return;
      }
      await pmPromptAddStep2(msg.chat.id, cc, country_name);
      return;
    }

    // ===== Agregar método (paso 2: guardar contenido verbatim) =====
    const pmAdd2Match = replySource.match(/PMADD2:([A-Za-z0-9_-]+)\|([^\n]+)/);
    if (pmAdd2Match) {
      const cc = pmAdd2Match[1].toUpperCase();
      const country_name = pmAdd2Match[2].trim();
      const body = text;
      if (!body.trim()) {
        await sendMessage("warehouse", msg.chat.id, `El contenido está vacío.`);
        return;
      }
      const meta = extractPmMetadata(body);
      await sb.from("payment_methods").delete().eq("country_code", cc);
      const { data: inserted, error } = await sb.from("payment_methods").insert({
        country_code: cc,
        country_name,
        method_name: meta.method_name ?? "Pago",
        holder_name: meta.holder_name,
        account_info: meta.account_info,
        extra_info: null,
        currency: "USD",
        usd_rate: 1,
        body_raw: body,
        active: true,
      } as never).select().single();
      if (error || !inserted) {
        await sendMessage("warehouse", msg.chat.id, `Error guardando: ${error?.message ?? "desconocido"}`);
        return;
      }
      await sb.from("admin_logs").insert({
        admin_telegram_id: msg.from.id,
        action: "pm_add_simple",
        target_type: "payment_method",
        target_id: (inserted as { id: string }).id,
        details: { country_code: cc } as never,
      });
      await sendMessage(
        "warehouse",
        msg.chat.id,
        `✅ Método de pago guardado correctamente.\n\n🌎 País: <b>${escapeHtml(country_name)}</b>\n\n${body}`,
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
    case ADMIN_BACK_LABEL:
      // no borrar mensajes del chat almacén
      await restoreMainBar(msg.chat.id, msg.from.id);
      return;
    case ADMIN_BOTTOM.inicio:
      await patchContext(msg.from.id, { bar_shown: false });
      await restoreMainBar(msg.chat.id, msg.from.id);
      return;
    case ADMIN_TODO.stock:
      await showBackBar(msg.chat.id, msg.from.id);
      await adminStockView(msg.chat.id);
      return;
    case `👥 ${ADMIN_TODO.usuarios}`:
    case ADMIN_TODO.usuarios:
      await showBackBar(msg.chat.id, msg.from.id);
      await usStartFresh(msg.chat.id, msg.from.id);
      return;
    case ADMIN_BOTTOM.addkeys:
      await showBackBar(msg.chat.id, msg.from.id);
      await akStartFresh(msg.chat.id, msg.from.id);
      return;
    case ADMIN_BOTTOM.precios:
      await showBackBar(msg.chat.id, msg.from.id);
      await prStartFresh(msg.chat.id, msg.from.id);
      return;
    case ADMIN_BOTTOM.productos:
      await showBackBar(msg.chat.id, msg.from.id);
      await pdStartFresh(msg.chat.id, msg.from.id);
      return;
    case ADMIN_TODO.minrecharge:
      await showBackBar(msg.chat.id, msg.from.id);
      await adminPromptMinRecharge(msg.chat.id);
      return;
    case ADMIN_BOTTOM.metodos:
      await showBackBar(msg.chat.id, msg.from.id);
      await pmStartFresh(msg.chat.id, msg.from.id);
      return;

    case ADMIN_TODO.borrar:
      await cleanAdminChat(msg.chat.id, msg.from.id);
      return;
    case ADMIN_BOTTOM.todo:
      await showBackBar(msg.chat.id, msg.from.id);
      await showTodoMenu(msg.chat.id);
      return;
  }

  if (text === "/delete" || text === "/borrar") {
    await cleanAdminChat(msg.chat.id, msg.from.id);
    return;
  }

  if (text === "/stock") return adminStockView(msg.chat.id);
  if (text === "/precios") return prStartFresh(msg.chat.id, msg.from.id);

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
    await adminPromptKeys(msg.chat.id, msg.from.id, resolvedPriceId);
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

  if (text === "/usuarios") return usStartFresh(msg.chat.id, msg.from.id);
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
      // Cerrar flujos sin borrar mensajes: el mensaje actual se edita.
      if (await getAkFlow(cb.from.id)) await setAkFlow(cb.from.id, null);
      if (await getPrFlow(cb.from.id)) await setPrFlow(cb.from.id, null);
      if (await getPdFlow(cb.from.id)) await setPdFlow(cb.from.id, null);
      if (await getUsFlow(cb.from.id)) await setUsFlow(cb.from.id, null);
      if (await getPmFlow(cb.from.id)) await setPmFlow(cb.from.id, null);

      await patchContext(cb.from.id, { bar_shown: false });
      await restoreMainBar(chat_id, cb.from.id, cb.message?.message_id);
    }
    return;
  }
  if (data === "akp:add") {
    if (chat_id) await adminListProducts(chat_id, cb.from.id, cb.message?.message_id);
    return;
  }
  if (data === "akp:finduser") {
    if (chat_id) await adminPromptFindUser(chat_id);
    return;
  }
  if (data === "akp:stock") {
    if (chat_id) await adminStockView(chat_id, cb.message?.message_id);
    return;
  }
  if (data.startsWith("stcat:")) {
    const idx = Number(data.split(":")[1]);
    const cat = PD_CATEGORIES[idx];
    if (chat_id && cat) await adminStockCategory(chat_id, cat, cb.message?.message_id);
    return;
  }
  if (data === "akp:pend") {
    if (chat_id) await sendMessage("warehouse", chat_id, `Los comprobantes pendientes se gestionan desde el bot admin principal.`);
    return;
  }
  if (data === "akp:users") {
    if (chat_id) await usStartFresh(chat_id, cb.from.id);
    return;
  }
  if (data === "akp:pm" || data === "pmf:menu") {
    if (chat_id) {
      const f = await getPmFlow(cb.from.id);
      await pmMenuFlow(chat_id, cb.from.id, cb.message?.message_id ?? f?.message_id);
    }
    return;
  }
  if (data === "pmf:add") { if (chat_id) await pmAskCountry(chat_id, cb.from.id, cb.message?.message_id); return; }
  if (data === "pmf:dellist") { if (chat_id) await pmDelListFlow(chat_id, cb.from.id, cb.message?.message_id); return; }
  if (data === "pmf:all") { if (chat_id) await pmAllFlow(chat_id, cb.from.id, cb.message?.message_id); return; }
  if (data.startsWith("pmf:delc:")) { if (chat_id) await pmDelConfirmFlow(chat_id, cb.from.id, data.slice("pmf:delc:".length), cb.message?.message_id); return; }
  if (data.startsWith("pmf:delgo:")) { if (chat_id) await pmDelGoFlow(chat_id, cb.from.id, data.slice("pmf:delgo:".length), cb.message?.message_id); return; }
  if (data === "pmf:save") {
    if (chat_id) {
      const f = await getPmFlow(cb.from.id);
      if (f) await pmSaveFlow(chat_id, cb.from.id, { ...f, message_id: cb.message?.message_id ?? f.message_id });
    }
    return;
  }

  if (data === "pm:addnew") { if (chat_id) await pmPromptAddCountry(chat_id); return; }
  if (data === "pm:add") { if (chat_id) await pmPromptAddStep1(chat_id); return; }
  if (data === "pmadd:cancel") {
    await patchContext(Number(adminId()), { pm_pending: null });
    if (chat_id) await sendMessage("warehouse", chat_id, `❌ Cancelado.`);
    return;
  }
  if (data === "pmadd:replace") {
    if (!chat_id) return;
    const st = await getState(Number(adminId()));
    const pending = (st?.context as { pm_pending?: { cc: string; name: string } } | undefined)?.pm_pending;
    if (!pending) {
      await sendMessage("warehouse", chat_id, `Sesión expirada. Volvé a intentarlo.`);
      return;
    }
    await patchContext(Number(adminId()), { pm_pending: null });
    await pmPromptAddStep2(chat_id, pending.cc, pending.name);
    return;
  }
  if (data === "pm:editlist") { if (chat_id) await pmListAll(chat_id, "edit"); return; }
  if (data === "pm:dellist") { if (chat_id) await pmListAll(chat_id, "del"); return; }
  if (data === "pm:countries") { if (chat_id) await pmCountriesView(chat_id); return; }
  if (data.startsWith("pmec:")) { if (chat_id) await pmPromptCountryReplace(chat_id, data.slice(5)); return; }
  if (data.startsWith("pm:delc:")) { if (chat_id) await pmConfirmDeleteCountry(chat_id, data.slice("pm:delc:".length)); return; }
  if (data.startsWith("pm:delcgo:")) {
    const cc = data.slice("pm:delcgo:".length);
    const { data: m } = await sb.from("payment_methods").select("country_name").eq("country_code", cc).eq("active", true).limit(1).maybeSingle();
    const label = m ? `${flagFromCC(cc)} ${m.country_name}` : `${flagFromCC(cc)} ${cc}`;
    // Soft-delete: desactivamos para no romper FKs de órdenes existentes.
    // El bot de compras filtra por active=true, así desaparece inmediatamente.
    await sb.from("payment_methods").update({ active: false }).eq("country_code", cc);
    await sb.from("admin_logs").insert({ admin_telegram_id: cb.from.id, action: "pm_delete_country", target_type: "payment_method", target_id: cc });
    if (chat_id) await sendMessage("warehouse", chat_id, `${label} eliminado correctamente ✅`);
    return;
  }
  if (data.startsWith("pm:del:")) { if (chat_id) await pmConfirmDelete(chat_id, data.slice(7)); return; }
  if (data.startsWith("pmdel:")) {
    const pmId = data.slice(6);
    await sb.from("payment_methods").update({ active: false }).eq("id", pmId);
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
    if (chat_id) await adminListDurations(chat_id, cb.from.id, data.slice(7), cb.message?.message_id);
    return;
  }
  if (data.startsWith("akback:")) {
    if (chat_id) await adminListDurations(chat_id, cb.from.id, data.slice(7), cb.message?.message_id);
    return;
  }
  if (data.startsWith("akdur:")) {
    if (chat_id) await adminPromptKeys(chat_id, cb.from.id, data.slice(6), cb.message?.message_id);
    return;
  }
  if (data.startsWith("akusrp:")) {
    if (chat_id) await usList(chat_id, cb.from.id, parseInt(data.slice(7), 10) || 0, cb.message?.message_id);
    return;
  }
  if (data.startsWith("akusr:")) {
    if (chat_id) await usDetail(chat_id, cb.from.id, parseInt(data.slice(6), 10), cb.message?.message_id);
    return;
  }
  // ===== Usuarios (un solo mensaje) =====
  if (data === "noop") return;
  if (data === "usback") {
    const flow = await getUsFlow(cb.from.id);
    if (chat_id) await usList(chat_id, cb.from.id, flow?.page ?? 0, cb.message?.message_id);
    return;
  }
  if (data.startsWith("usp:")) {
    if (chat_id) await usList(chat_id, cb.from.id, parseInt(data.slice(4), 10) || 0, cb.message?.message_id);
    return;
  }
  if (data === "usfind") {
    if (chat_id) await usPromptFind(chat_id, cb.from.id, cb.message?.message_id);
    return;
  }
  if (data === "usu:back") {
    const flow = await getUsFlow(cb.from.id);
    if (chat_id && flow?.tg) await usDetail(chat_id, cb.from.id, flow.tg, cb.message?.message_id);
    else if (chat_id) await usList(chat_id, cb.from.id, flow?.page ?? 0, cb.message?.message_id);
    return;
  }
  if (data.startsWith("usu:")) {
    if (chat_id) await usDetail(chat_id, cb.from.id, parseInt(data.slice(4), 10), cb.message?.message_id);
    return;
  }
  if (data === "usmsg") {
    const flow = await getUsFlow(cb.from.id);
    if (chat_id && flow?.tg) await usPromptMessage(chat_id, cb.from.id, flow, cb.message?.message_id);
    return;
  }
  if (data === "usblock") {
    const flow = await getUsFlow(cb.from.id);
    if (chat_id && flow?.tg) await usConfirmBlock(chat_id, cb.from.id, flow, cb.message?.message_id);
    return;
  }
  if (data === "usblockok") {
    const flow = await getUsFlow(cb.from.id);
    if (chat_id && flow?.tg) await usApplyBlock(chat_id, cb.from.id, flow, cb.message?.message_id);
    return;
  }
  if (data === "usdisc") {
    const flow = await getUsFlow(cb.from.id);
    if (chat_id && flow?.tg) await usDiscountProducts(chat_id, cb.from.id, flow, cb.message?.message_id);
    return;
  }
  if (data.startsWith("usdp:")) {
    const flow = await getUsFlow(cb.from.id);
    if (chat_id && flow?.tg) await usDiscountDurations(chat_id, cb.from.id, flow, data.slice(5), cb.message?.message_id);
    return;
  }
  if (data.startsWith("usde:")) {
    const flow = await getUsFlow(cb.from.id);
    if (chat_id && flow?.tg) await usPromptDiscount(chat_id, cb.from.id, flow, data.slice(5), cb.message?.message_id);
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
    if (chat_id) await adminListaPrecios(chat_id, cb.from.id, cb.message?.message_id);
    return;
  }
  if (data.startsWith("prprod:")) {
    if (chat_id) await adminPriceDurations(chat_id, cb.from.id, data.slice(7), cb.message?.message_id);
    return;
  }
  if (data.startsWith("prback:")) {
    if (chat_id) await adminPriceDurations(chat_id, cb.from.id, data.slice(7), cb.message?.message_id);
    return;
  }
  if (data.startsWith("pred:")) {
    if (chat_id) await adminPromptNewPrice(chat_id, cb.from.id, data.slice(5), cb.message?.message_id);
    return;
  }

  // ===== Productos: gestión (un solo mensaje) =====
  if (data === "akp:prodlist" || data === "pdcats") {
    if (chat_id) await pdCategories(chat_id, cb.from.id, cb.message?.message_id);
    return;
  }
  if (data.startsWith("pdcat:")) {
    const idx = Number(data.slice(6));
    const cat = PD_CATEGORIES[idx] ?? PD_CATEGORIES[0];
    if (chat_id) await pdList(chat_id, cb.from.id, cat, cb.message?.message_id);
    return;
  }
  if (data === "pdback") {
    const flow = await getPdFlow(cb.from.id);
    if (chat_id) {
      if (flow?.category) await pdList(chat_id, cb.from.id, flow.category, cb.message?.message_id);
      else await pdCategories(chat_id, cb.from.id, cb.message?.message_id);
    }
    return;
  }
  if (data.startsWith("pdp:")) {
    if (chat_id) await pdProductMenu(chat_id, cb.from.id, data.slice(4), cb.message?.message_id);
    return;
  }
  if (data.startsWith("pdren:")) {
    if (chat_id) await pdPromptRename(chat_id, cb.from.id, data.slice(6), cb.message?.message_id);
    return;
  }
  if (data.startsWith("pdtogok:")) {
    if (chat_id) await pdApplyToggle(chat_id, cb.from.id, data.slice(8), cb.message?.message_id);
    return;
  }
  if (data.startsWith("pdtog:")) {
    if (chat_id) await pdConfirmDeactivate(chat_id, cb.from.id, data.slice(6), cb.message?.message_id);
    return;
  }
  if (data.startsWith("pddelok:")) {
    if (chat_id) await pdApplyDelete(chat_id, cb.from.id, data.slice(8), cb.message?.message_id);
    return;
  }
  if (data.startsWith("pddel:")) {
    if (chat_id) await pdConfirmDelete(chat_id, cb.from.id, data.slice(6), cb.message?.message_id);
    return;
  }
  if (data === "pdadd") {
    const flow = await getPdFlow(cb.from.id);
    if (chat_id) await pdPromptAddName(chat_id, cb.from.id, flow?.category ?? PD_CATEGORIES[0], cb.message?.message_id);
    return;
  }
  if (data === "pdprices") {
    const flow = await getPdFlow(cb.from.id);
    if (chat_id && flow) await pdPricesMenu(chat_id, cb.from.id, { ...flow, step: undefined }, cb.message?.message_id);
    return;
  }
  if (data.startsWith("pdprset:")) {
    const which = data.slice(8) as "1" | "7" | "30";
    const flow = await getPdFlow(cb.from.id);
    if (chat_id && flow) await pdPromptAddPrice(chat_id, cb.from.id, flow, which, cb.message?.message_id);
    return;
  }
  if (data === "pdsave") {
    const flow = await getPdFlow(cb.from.id);
    if (chat_id && flow) await pdSaveProduct(chat_id, cb.from.id, { ...flow, message_id: cb.message?.message_id ?? flow.message_id });
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
