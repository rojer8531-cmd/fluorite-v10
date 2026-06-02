// UI helpers — 1 mensaje activo por usuario (editMessageText pattern)
import {
  sendMessage,
  editMessageText,
  deleteMessage,
  type BotKind,
} from "./api.server";
import { getActiveMessage, setActiveMessage } from "./db.server";

/** Edita el mensaje activo del usuario o crea uno nuevo si no existe / no es editable. */
export async function renderScreen(
  bot: BotKind,
  telegram_id: number,
  chat_id: number,
  text: string,
  keyboard?: Array<Array<{ text: string; callback_data?: string }>>,
) {
  const reply_markup = keyboard ? { inline_keyboard: keyboard } : undefined;
  const active = await getActiveMessage(telegram_id);
  if (active && active.chat_id === chat_id) {
    const edited = await editMessageText(bot, chat_id, active.message_id, text, {
      reply_markup,
    });
    if (edited.ok) return active.message_id;
  }
  // Fallback: enviar nuevo
  const sent = await sendMessage(bot, chat_id, text, { reply_markup });
  if (sent.ok && sent.result) {
    await setActiveMessage(telegram_id, chat_id, sent.result.message_id);
    return sent.result.message_id;
  }
  return null;
}

/** Borra silenciosamente un mensaje (p.ej. el del usuario tras enviar comprobante). */
export async function silentDelete(
  bot: BotKind,
  chat_id: number,
  message_id: number,
) {
  await deleteMessage(bot, chat_id, message_id).catch(() => {});
}
