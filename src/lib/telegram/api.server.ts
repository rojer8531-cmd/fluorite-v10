// Telegram Bot API client con retry exponencial y cola simple
// SERVER-ONLY. No importar desde código cliente.

export type BotKind = "shop" | "admin" | "warehouse";

function tokenFor(bot: BotKind) {
  if (bot === "shop") return process.env.TELEGRAM_SHOP_BOT_TOKEN;
  if (bot === "warehouse") return process.env.TELEGRAM_WAREHOUSE_BOT_TOKEN;
  return process.env.TELEGRAM_ADMIN_BOT_TOKEN;
}

export function getAdminChatId() {
  return process.env.TELEGRAM_ADMIN_CHAT_ID;
}

export function getWarehouseChatId() {
  return process.env.TELEGRAM_WAREHOUSE_CHAT_ID;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TgResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

// Timeout por request a Telegram. 5s es más que suficiente y evita que
// una llamada colgada bloquee todo el handler.
const TG_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SEC = 10;

// Errores que indican usuario inalcanzable: NO reintentar.
function isUnreachableUserError(desc?: string, code?: number): boolean {
  if (code === 403) return true; // bot blocked / kicked / deactivated
  if (!desc) return false;
  const d = desc.toLowerCase();
  return (
    d.includes("bot was blocked") ||
    d.includes("user is deactivated") ||
    d.includes("chat not found") ||
    d.includes("bot can't initiate conversation") ||
    d.includes("user is deleted")
  );
}

// Errores de payload: NO reintentar.
function isClientPayloadError(code?: number): boolean {
  return code === 400 || code === 401 || code === 404;
}

async function logTelegramError(
  bot: BotKind,
  method: string,
  data: TgResult<unknown>,
  attempts: number,
) {
  try {
    const mod = await import("./db.server");
    const sb = mod.sb;

    await sb.from("admin_logs").insert({
      admin_telegram_id: 0,
      action: "tg_error",
      target_type: "telegram_api",
      target_id: `${bot}/${method}`,
      details: {
        code: data.error_code,
        description: data.description,
        attempts,
        retry_after: data.parameters?.retry_after,
      } as never,
    });
  } catch {
    /* swallow: logging nunca debe romper el flujo */
  }
}

export async function tg<T = unknown>(
  bot: BotKind,
  method: string,
  payload?: Record<string, unknown> | FormData,
  attempt = 0,
): Promise<TgResult<T>> {
  const token = tokenFor(bot);
  if (!token) {
    return { ok: false, description: `Missing token for ${bot}` };
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TG_TIMEOUT_MS);
  try {
    const init: RequestInit = { method: "POST", signal: ac.signal };
    if (payload instanceof FormData) {
      init.body = payload;
    } else if (payload) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(payload);
    }
    const res = await fetch(url, init);
    const data = (await res.json()) as TgResult<T>;
    if (!data.ok) {
      // 429: respeta retry_after si es razonable
      if (data.error_code === 429) {
        const ra = data.parameters?.retry_after ?? 1;
        if (ra <= MAX_RETRY_AFTER_SEC && attempt < MAX_ATTEMPTS - 1) {
          await sleep((ra + 1) * 1000);
          return tg<T>(bot, method, payload, attempt + 1);
        }
        void logTelegramError(bot, method, data, attempt + 1);
        return data;
      }
      // Usuario inalcanzable: no reintentes, sólo loggea suave
      if (isUnreachableUserError(data.description, data.error_code)) {
        return data;
      }
      // Errores de payload: no reintentar
      if (isClientPayloadError(data.error_code)) {
        console.error(`[tg ${bot}/${method}] ${data.error_code}`, data.description);
        void logTelegramError(bot, method, data, attempt + 1);
        return data;
      }
      // 5xx u otros: exponential backoff
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = Math.min(3000, 250 * Math.pow(2, attempt));
        await sleep(delay);
        return tg<T>(bot, method, payload, attempt + 1);
      }
      console.error(`[tg ${bot}/${method}]`, data.description);
      void logTelegramError(bot, method, data, attempt + 1);
    }
    return data;
  } catch (err) {
    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = Math.min(3000, 250 * Math.pow(2, attempt));
      await sleep(delay);
      return tg<T>(bot, method, payload, attempt + 1);
    }
    console.error(`[tg ${bot}/${method}] fetch error`, err);
    const data: TgResult<T> = { ok: false, description: String(err) };
    void logTelegramError(bot, method, data, attempt + 1);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function getMe(bot: BotKind) {
  return tg<{ id: number; username: string; is_bot: boolean }>(bot, "getMe");
}


export async function sendMessage(
  bot: BotKind,
  chat_id: number | string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return tg<{ message_id: number; chat: { id: number } }>(bot, "sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

export async function editMessageText(
  bot: BotKind,
  chat_id: number | string,
  message_id: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return tg(bot, "editMessageText", {
    chat_id,
    message_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

export async function deleteMessage(
  bot: BotKind,
  chat_id: number | string,
  message_id: number,
) {
  return tg(bot, "deleteMessage", { chat_id, message_id });
}

export async function editMessageCaption(
  bot: BotKind,
  chat_id: number | string,
  message_id: number,
  caption: string,
  extra: Record<string, unknown> = {},
) {
  return tg(bot, "editMessageCaption", {
    chat_id,
    message_id,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

export async function editMessageReplyMarkup(
  bot: BotKind,
  chat_id: number | string,
  message_id: number,
  reply_markup: Record<string, unknown> | null,
) {
  return tg(bot, "editMessageReplyMarkup", {
    chat_id,
    message_id,
    reply_markup: reply_markup ?? { inline_keyboard: [] },
  });
}

export async function answerCallbackQuery(
  bot: BotKind,
  callback_query_id: string,
  text?: string,
  show_alert = false,
) {
  return tg(bot, "answerCallbackQuery", { callback_query_id, text, show_alert });
}

export async function sendPhoto(
  bot: BotKind,
  chat_id: number | string,
  photo: string,
  caption: string,
  extra: Record<string, unknown> = {},
) {
  return tg<{ message_id: number }>(bot, "sendPhoto", {
    chat_id,
    photo,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

export async function sendPhotoMultipart(
  bot: BotKind,
  chat_id: number | string,
  fileBytes: ArrayBuffer,
  filename: string,
  caption: string,
  extra: Record<string, unknown> = {},
) {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("caption", caption);
  fd.append("parse_mode", "HTML");
  for (const [k, v] of Object.entries(extra)) {
    fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  fd.append("photo", new Blob([fileBytes]), filename);
  return tg<{ message_id: number }>(bot, "sendPhoto", fd);
}

export async function copyMessage(
  bot: BotKind,
  chat_id: number | string,
  from_chat_id: number | string,
  message_id: number,
  extra: Record<string, unknown> = {},
) {
  return tg<{ message_id: number }>(bot, "copyMessage", {
    chat_id,
    from_chat_id,
    message_id,
    ...extra,
  });
}

export async function getFile(bot: BotKind, file_id: string) {
  return tg<{ file_id: string; file_path: string; file_size: number }>(
    bot,
    "getFile",
    { file_id },
  );
}

export async function downloadFile(
  bot: BotKind,
  file_path: string,
): Promise<ArrayBuffer | null> {
  const token = tokenFor(bot);
  if (!token) return null;
  const url = `https://api.telegram.org/file/bot${token}/${file_path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TG_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return res.arrayBuffer();
  } catch (err) {
    console.error(`[tg ${bot}/file] fetch error`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function setWebhook(bot: BotKind, url: string, secret_token: string) {
  return tg(bot, "setWebhook", {
    url,
    secret_token,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}

export async function getWebhookInfo(bot: BotKind) {
  return tg(bot, "getWebhookInfo");
}
