// Telegram Bot API client con retry exponencial y cola simple
// SERVER-ONLY. No importar desde código cliente.

export type BotKind = "shop" | "admin";

function tokenFor(bot: BotKind) {
  return bot === "shop"
    ? process.env.TELEGRAM_SHOP_BOT_TOKEN
    : process.env.TELEGRAM_ADMIN_BOT_TOKEN;
}

export function getAdminChatId() {
  return process.env.TELEGRAM_ADMIN_CHAT_ID;
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
  try {
    const init: RequestInit = { method: "POST" };
    if (payload instanceof FormData) {
      init.body = payload;
    } else if (payload) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(payload);
    }
    const res = await fetch(url, init);
    const data = (await res.json()) as TgResult<T>;
    if (!data.ok) {
      // Rate limit
      if (data.error_code === 429 && data.parameters?.retry_after && attempt < 3) {
        await sleep((data.parameters.retry_after + 1) * 1000);
        return tg<T>(bot, method, payload, attempt + 1);
      }
      console.error(`[tg ${bot}/${method}]`, data.description);
    }
    return data;
  } catch (err) {
    console.error(`[tg ${bot}/${method}] fetch error`, err);
    if (attempt < 2) {
      await sleep(500 * 2 ** attempt);
      return tg<T>(bot, method, payload, attempt + 1);
    }
    return { ok: false, description: String(err) };
  }
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
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.arrayBuffer();
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
