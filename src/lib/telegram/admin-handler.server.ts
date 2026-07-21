// Admin Bot — SOLO bandeja de comprobantes y solicitudes de key.
// Barra inferior persistente: 📥 Pendientes · 🚫 Bloqueos.
// Los comprobantes NO se borran automáticamente.
import {
  sendMessage as _rawSendMessage,
  editMessageReplyMarkup,
  editMessageCaption,
  editMessageText,
  deleteMessage,
  answerCallbackQuery,
  getAdminChatId,
  sendPhotoMultipart,
  getFile,
  downloadFile,
} from "./api.server";
import {
  sb,
  checkRateLimit,
  blockUserPermanent,
  getState,
  setState,
  patchContext,
  isBlocked,
} from "./db.server";
import {
  notifyUserApproved,
  notifyUserRejected,
  notifyUserKey,
} from "./shop-handler.server";
import { rankFromRecharged, normalizeRank, RANK_INFO, RANKS, assignRank, rankLabel, type Rank } from "./ranks.server";


interface Update {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}
interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number };
  text?: string;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
}
interface TgCallback {
  id: string;
  from: { id: number };
  message?: { chat: { id: number }; message_id: number; caption?: string };
  data?: string;
}

async function sendMessage(
  chat_id: number | string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return _rawSendMessage("admin", chat_id, text, extra);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const EXTRA_AUTHORIZED_IDS = new Set(["8844591762"]);
function isAdmin(telegram_id: number) {
  const id = String(telegram_id);
  return id === String(getAdminChatId()) || EXTRA_AUTHORIZED_IDS.has(id);
}

function tpId(createdAt: string) {
  return `TP${new Date(createdAt).getTime()}`;
}

// ===== Barra inferior persistente del admin =====
const ADMIN_BOTTOM = {
  pendientes: "📥 Pendientes",
  bloqueos: "🚫 Bloqueos",
  usuario: "🔍 Usuario",
  rol: "🏆 ROL",
};

function adminBottomKeyboard() {
  return {
    keyboard: [
      [{ text: ADMIN_BOTTOM.pendientes }, { text: ADMIN_BOTTOM.bloqueos }],
      [{ text: ADMIN_BOTTOM.rol }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}


export async function handleAdminUpdate(update: Update): Promise<void> {
  const admin_id =
    (update.message?.from && isAdmin(update.message.from.id) && update.message.from.id) ||
    (update.callback_query?.from && isAdmin(update.callback_query.from.id) && update.callback_query.from.id) ||
    null;
  const chat_id =
    update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;

  if (admin_id && chat_id && update.message) {
    // Solo en mensajes de texto adjuntamos la barra. En callbacks NUNCA
    // bloqueamos: el botón debe responder al instante.
    ensureAdminBar(chat_id, admin_id).catch(() => {});
  }

  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error("[admin handler] fatal", err);
    const cb = update.callback_query;
    const fallbackChat = chat_id ?? cb?.from.id ?? null;
    if (cb?.id) {
      answerCallbackQuery("admin", cb.id, "Error temporal. Toca de nuevo.", true).catch(() => {});
    }
    if (fallbackChat) {
      await sendMessage(
        fallbackChat,
        `El bot admin está activo. Esa acción tuvo un error temporal; intenta nuevamente.`,
        { reply_markup: adminBottomKeyboard() },
      ).catch(() => {});
    }
  }
}

async function ensureAdminBar(chat_id: number, admin_id: number) {
  const st = await getState(admin_id);
  const ctx = (st?.context ?? {}) as Record<string, unknown>;
  if (ctx.admin_bar_shown) return;
  const sent = await sendMessage(chat_id, "\u2063", { reply_markup: adminBottomKeyboard() });
  if (sent.ok && sent.result) {
    deleteMessage("admin", chat_id, sent.result.message_id).catch(() => {});
  }
  await patchContext(admin_id, { admin_bar_shown: true });
}

async function markReceiptStatus(
  bot_chat_id: number,
  message_id: number,
  badge: string,
  detail?: string,
) {
  await editMessageReplyMarkup("admin", bot_chat_id, message_id, { inline_keyboard: [] }).catch(() => {});
  await sendMessage(bot_chat_id, `${badge}${detail ? `  ·  ${detail}` : ""}`, {
    reply_to_message_id: message_id,
    allow_sending_without_reply: true,
  });
}

// Edita el mensaje del comprobante conservando la foto original y quitando
// SOLO los botones inline. Ningún comprobante se elimina jamás.
async function finalizeReceiptCaption(opts: {
  cb: TgCallback;
  order_id: string;
  status: "APROBADO" | "RECHAZADO" | "BLOQUEADO";
  headerIcon: string;
  headerText: string;
  statusIcon: string;
  extraBalanceUsd?: number | null; // saldo final para mostrar (post-aprobación)
}) {
  const { cb, order_id, status, headerIcon, headerText, statusIcon, extraBalanceUsd } = opts;
  const chat_id = cb.message?.chat.id;
  const message_id = cb.message?.message_id;

  const { data: order } = await sb
    .from("orders")
    .select("id, telegram_id, total_usd, created_at, admin_message_id, payment_methods(country_name, method_name), bot_users(balance, username, display_name)")
    .eq("id", order_id)
    .maybeSingle();
  if (!order) return;
  const o = order as {
    telegram_id: number;
    total_usd: number;
    created_at: string;
    admin_message_id: number | null;
    payment_methods: { country_name: string; method_name: string } | null;
    bot_users: { balance: number; username: string | null; display_name: string | null } | null;
  };
  const bal = extraBalanceUsd != null ? extraBalanceUsd : Number(o.bot_users?.balance ?? 0);
  const userTag = o.bot_users?.username ? `@${o.bot_users.username}` : (o.bot_users?.display_name ?? "—");
  const pid = tpId(o.created_at);
  const country = o.payment_methods?.country_name ?? "—";

  const newCaption =
    `${headerIcon} <b>${headerText}</b>\n\n` +
    `👤 <b>Usuario:</b> ${userTag} · <code>${o.telegram_id}</code>\n` +
    `🆔 <b>Pending:</b> <code>${pid}</code>\n` +
    `💰 <b>Monto:</b> $${Number(o.total_usd).toFixed(2)} USD\n` +
    `💳 <b>Saldo:</b> $${bal.toFixed(2)} USD\n` +
    `🌎 <b>País:</b> ${country}\n\n` +
    `${statusIcon} <b>Estado:</b> ${status}`;

  const target_mid = o.admin_message_id ?? message_id;
  if (!chat_id || !target_mid) return;
  // Intentamos editar el caption (foto). Si el mensaje es de texto (fallback),
  // caemos a editMessageText. En cualquier caso removemos los botones para
  // garantizar idempotencia: una vez ejecutada la acción, no hay más botones.
  const capRes = await editMessageCaption("admin", chat_id, target_mid, newCaption, {
    reply_markup: { inline_keyboard: [] },
  });
  if (!capRes.ok) {
    const { editMessageText } = await import("./api.server");
    const txtRes = await editMessageText("admin", chat_id, target_mid, newCaption, {
      reply_markup: { inline_keyboard: [] },
    });
    if (!txtRes.ok) {
      await editMessageReplyMarkup("admin", chat_id, target_mid, { inline_keyboard: [] }).catch(() => {});
    }
  }
}

// ===== Pendientes =====
async function adminPendientes(chat_id: number) {
  const { data: orders } = await sb
    .from("orders")
    .select("id, telegram_id, total_usd, order_type, created_at, products(name)")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: false })
    .limit(20);
  if (!orders || orders.length === 0) {
    await sendMessage(chat_id, `<b>📥 Pendientes</b>\n\nNo hay órdenes pendientes.`);
    return;
  }

  const orderIds = orders.map((o) => o.id);
  const { data: receipts } = await sb
    .from("receipts")
    .select("order_id, file_id, admin_message_id")
    .in("order_id", orderIds)
    .eq("status", "pending");
  const byOrder = new Map((receipts ?? []).map((r) => [r.order_id, r]));

  await sendMessage(chat_id, `<b>📥 Pendientes (${orders.length})</b>`);
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const r = byOrder.get(o.id);
    const label =
      o.order_type === "recharge"
        ? "Recarga"
        : (o as { products: { name: string } | null }).products?.name ?? "—";
    const caption =
      `<b>${i + 1}. Comprobante</b>\n` +
      `Usuario  <code>${o.telegram_id}</code>\n` +
      `Monto    $${Number(o.total_usd).toFixed(2)}\n` +
      `Tipo     ${label}\n` +
      `Orden    <code>${o.id.slice(0, 8)}</code>`;
    const kb = {
      inline_keyboard: [
        [
          { text: "✅ Aprobar", callback_data: `ord:approve:${o.id}` },
          { text: "❌ Rechazar", callback_data: `ord:reject:${o.id}` },
        ],
        [
          { text: "🚫 Bloquear", callback_data: `ord:block:${o.telegram_id}` },
        ],
      ],
    };

    // Re-subimos la imagen al bot admin usando bytes (los file_id son
    // específicos por bot: el file_id del shop bot NO sirve para el admin bot).
    let sentMid: number | null = null;
    if (r?.file_id) {
      try {
        const info = await getFile("shop", r.file_id);
        if (info.ok && info.result?.file_path) {
          const bytes = await downloadFile("shop", info.result.file_path);
          if (bytes) {
            const sent = await sendPhotoMultipart("admin", chat_id, bytes, "comprobante.jpg", caption, {
              reply_markup: kb,
            });
            if (sent.ok && sent.result) sentMid = sent.result.message_id;
            const adminFileId = sent.result?.photo?.[sent.result.photo.length - 1]?.file_id ?? null;
            if (adminFileId) {
              await sb.from("receipts").update({ admin_file_id: adminFileId }).eq("order_id", o.id);
            }
          }
        }
      } catch (err) {
        console.error("[adminPendientes] re-upload failed", err);
      }
    }
    if (sentMid == null) {
      const sent = await sendMessage(chat_id, caption, { reply_markup: kb });
      if (sent.ok && sent.result) sentMid = sent.result.message_id;
    }
    if (sentMid != null) {
      await Promise.all([
        sb.from("receipts").update({ admin_message_id: sentMid }).eq("order_id", o.id),
        sb.from("orders").update({ admin_message_id: sentMid }).eq("id", o.id),
      ]);
    }
  }
}

// ===== Bloqueos =====
type BlockedRow = { telegram_id: number; reason: string | null; blocked_until: string | null };

async function loadBlockedList(): Promise<BlockedRow[]> {
  const { data } = await sb
    .from("blocked_users")
    .select("telegram_id, reason, blocked_until")
    .order("telegram_id")
    .limit(200);
  return (data as BlockedRow[] | null) ?? [];
}

function bloqueoText(b: BlockedRow): string {
  const status = b.blocked_until
    ? `⏳ Hasta ${new Date(b.blocked_until).toLocaleString("es")}`
    : `✖️ Permanente`;
  return `<b>🚫 Bloqueos</b>\n\n🔒 Usuario\n\n<code>${b.telegram_id}</code>\n\n${status}`;
}

function bloqueoKb(b: BlockedRow, idx: number, total: number) {
  const prev = (idx - 1 + total) % total;
  const next = (idx + 1) % total;
  return {
    inline_keyboard: [
      [{ text: "🔓 Desbloquear", callback_data: `admbl:unblock:${b.telegram_id}:${idx}` }],
      [
        { text: "🔚", callback_data: `admbl:page:${prev}` },
        { text: `${idx + 1}/${total}`, callback_data: "noop" },
        { text: "🔜", callback_data: `admbl:page:${next}` },
      ],
    ],
  };
}

async function adminBloqueos(chat_id: number) {
  const list = await loadBlockedList();
  if (list.length === 0) {
    await sendMessage(chat_id, `<b>🚫 Bloqueos</b>\n\nNo hay usuarios bloqueados.`);
    return;
  }
  await sendMessage(chat_id, bloqueoText(list[0]), {
    reply_markup: bloqueoKb(list[0], 0, list.length),
  });
}

async function bloqueosEditPage(chat_id: number, message_id: number, idx: number) {
  const list = await loadBlockedList();
  if (list.length === 0) {
    await editMessageText("admin", chat_id, message_id, `<b>🚫 Bloqueos</b>\n\nNo hay usuarios bloqueados.`, {
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
    return;
  }
  const safeIdx = ((idx % list.length) + list.length) % list.length;
  await editMessageText("admin", chat_id, message_id, bloqueoText(list[safeIdx]), {
    reply_markup: bloqueoKb(list[safeIdx], safeIdx, list.length),
  }).catch(() => {});
}


// ===== Acreditar recarga (cuando el admin responde con monto) =====
async function creditRecharge(
  order: { id: string; user_id: string; status: string; created_at: string },
  amount: number,
  adminId: number,
  chat_id: number,
) {
  if (order.status === "approved") {
    await sendMessage(chat_id, `Esa recarga ya fue aprobada.`);
    return;
  }
  const { data: u } = await sb
    .from("bot_users")
    .select("id, telegram_id, chat_id, balance, total_recharged, rank")
    .eq("id", order.user_id)
    .single();
  if (!u) {
    await sendMessage(chat_id, `Usuario no encontrado.`);
    return;
  }
  const newBalance = Number(u.balance) + amount;
  const newRecharged = Number(u.total_recharged) + amount;
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
    pending: tpId(order.created_at),
  });

  await sendMessage(
    chat_id,
    `<b>Recarga aprobada</b>  ·  $${amount.toFixed(2)} USD acreditados.\nNuevo saldo  $${newBalance.toFixed(2)}`,
  );
}

// ===== Buscar usuario =====
async function startUserLookup(admin_id: number, chat_id: number) {
  await setState(admin_id, "admin_lookup", {});
  await sendMessage(
    chat_id,
    `<b>🔍 Buscar usuario</b>\n\nEnviá el ID de Telegram del usuario (solo números).`,
  );
}

async function showUserCard(chat_id: number, telegram_id: number) {
  const [{ data: u }, blocked] = await Promise.all([
    sb
      .from("bot_users")
      .select("telegram_id, username, display_name, balance, total_recharged, rank, registered_at, chat_id")
      .eq("telegram_id", telegram_id)
      .maybeSingle(),
    isBlocked(telegram_id),
  ]);
  if (!u) {
    await sendMessage(chat_id, `No encontré ningún usuario con ID <code>${telegram_id}</code>.`);
    return;
  }
  const text =
    `<b>👤 Usuario</b>\n\n` +
    `Nombre   ${escapeHtml(u.display_name ?? "—")}\n` +
    `Usuario  @${escapeHtml(u.username ?? "—")}\n` +
    `ID       <code>${u.telegram_id}</code>\n` +
    `Saldo    $${Number(u.balance).toFixed(2)} USD\n` +
    `Recargado $${Number(u.total_recharged).toFixed(2)} USD\n` +
    `Rango    ${u.rank}\n` +
    `Registro ${new Date(u.registered_at).toLocaleDateString("es")}\n` +
    `Estado   ${blocked ? "🚫 BLOQUEADO" : "✅ Activo"}`;
  const kb: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: "💬 Enviar mensaje", callback_data: `usr:msg:${telegram_id}` }],
  ];
  if (blocked) {
    kb.push([{ text: "🔓 Desbloquear", callback_data: `usr:unblock:${telegram_id}` }]);
  } else {
    kb.push([{ text: "🚫 Bloquear", callback_data: `usr:block:${telegram_id}` }]);
  }
  await sendMessage(chat_id, text, { reply_markup: { inline_keyboard: kb } });
}

// ===== Mensajes =====
async function handleMessage(msg: TgMessage) {
  if (!msg.from) return;
  if (!isAdmin(msg.from.id)) return;
  const text = (msg.text ?? "").trim();

  if (text === "/start" || text === "/help" || text === "/panel") {
    const sent = await sendMessage(
      msg.chat.id,
      `<b>Panel Admin ✅</b>\nUsá la barra inferior para todas las funciones.`,
      { reply_markup: adminBottomKeyboard() },
    );
    patchContext(msg.from.id, { admin_bar_shown: true }).catch((err) => console.error("[admin /start] state", err));
    if (!sent.ok) console.error("[admin /start] immediate send failed", sent.description);
    return;
  }

  if (!(await checkRateLimit(msg.from.id, "admin_msg", 30, 10))) return;

  // ===== flujo de búsqueda / mensaje directo a usuario =====
  const adminState = await getState(msg.from.id);

  // Confirmación de limpieza total
  if (adminState?.state === "admin_confirm_wipe" && text && !text.startsWith("/")) {
    await setState(msg.from.id, "menu", {});
    if (text.trim() !== "1010") {
      await sendMessage(msg.chat.id, `❌ Contraseña incorrecta. Operación cancelada.`);
      return;
    }
    await sendMessage(msg.chat.id, `⏳ Limpiando datos de usuarios...`);
    try {
      await wipeAllUserData();
      await sendMessage(
        msg.chat.id,
        `✅ <b>Limpieza completada</b>\n\nSe borraron todos los datos de usuarios.\nEl sistema sigue funcionando — /start abrirá un bot limpio para cualquier usuario.`,
      );
    } catch (e) {
      console.error("[wipe] error", e);
      await sendMessage(msg.chat.id, `❌ Error durante la limpieza: ${String((e as Error).message ?? e)}`);
    }
    return;
  }

  if (adminState?.state === "admin_lookup" && text && !text.startsWith("/")) {
    const tgId = parseInt(text.replace(/\D+/g, ""), 10);
    await setState(msg.from.id, "menu", {});
    if (!Number.isFinite(tgId) || tgId <= 0) {
      await sendMessage(msg.chat.id, `ID inválido.`);
      return;
    }
    await showUserCard(msg.chat.id, tgId);
    return;
  }

  if (adminState?.state === "admin_dm" && text && !text.startsWith("/")) {
    const ctx = (adminState.context ?? {}) as { target_tg?: number };
    const targetTg = Number(ctx.target_tg);
    await setState(msg.from.id, "menu", {});
    if (!Number.isFinite(targetTg) || targetTg <= 0) {
      await sendMessage(msg.chat.id, `Sesión expirada.`);
      return;
    }
    const { data: u } = await sb
      .from("bot_users")
      .select("chat_id")
      .eq("telegram_id", targetTg)
      .maybeSingle();
    const targetChat = Number(u?.chat_id ?? targetTg);
    const sent = await _rawSendMessage("shop", targetChat, `📩 <b>Mensaje del soporte</b>\n\n${escapeHtml(text)}`);
    if (sent.ok) {
      await sendMessage(msg.chat.id, `✅ Mensaje enviado a <code>${targetTg}</code>.`);
    } else {
      await sendMessage(msg.chat.id, `❌ No se pudo enviar el mensaje (el usuario quizá no haya iniciado el bot).`);
    }
    return;
  }


  // ===== respuestas (reply) =====
  if (msg.reply_to_message) {
    const replySource = `${msg.reply_to_message.text ?? ""}\n${msg.reply_to_message.caption ?? ""}`;

    // Rechazo con motivo
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
        await sendMessage(msg.chat.id, `Orden no encontrada.`);
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
      deleteMessage("admin", msg.chat.id, msg.reply_to_message.message_id).catch(() => {});
      deleteMessage("admin", msg.chat.id, msg.message_id).catch(() => {});
      if (photoMid > 0) {
        await deleteMessage("admin", msg.chat.id, photoMid).catch(() => {});
      }
      await sendMessage(msg.chat.id, `❌ Rechazado · ${escapeHtml(note).slice(0, 80)}`);
      return;
    }

    // Recarga (responder al comprobante con un monto) o envío de key
    const { data: ord } = await sb
      .from("orders")
      .select("id, telegram_id, user_id, product_id, price_id, order_type, total_usd, status, created_at")
      .eq("admin_message_id", msg.reply_to_message.message_id)
      .maybeSingle();

    if (ord && ord.order_type === "recharge") {
      const amount = Number(text.replace(",", "."));
      if (!Number.isFinite(amount) || amount <= 0) {
        await sendMessage(msg.chat.id, `Monto inválido. Respondé con un número en USD, ej: 10`);
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
      deleteMessage("admin", msg.chat.id, msg.message_id).catch(() => {});
      if (msg.reply_to_message) {
        deleteMessage("admin", msg.chat.id, msg.reply_to_message.message_id).catch(() => {});
      }
      const { data: receipt } = await sb
        .from("receipts")
        .select("admin_message_id")
        .eq("order_id", ord.id)
        .maybeSingle();
      if (receipt?.admin_message_id) {
        await markReceiptStatus(msg.chat.id, receipt.admin_message_id, `KEY ENVIADA`, String(u?.telegram_id ?? ord.telegram_id));
      } else {
        await sendMessage(msg.chat.id, `Key enviada a <code>${u?.telegram_id ?? ord.telegram_id}</code>.`);
      }
      return;
    }
  }

  // ===== barra inferior =====
  switch (text) {
    case ADMIN_BOTTOM.pendientes:
      await adminPendientes(msg.chat.id);
      return;
    case ADMIN_BOTTOM.bloqueos:
      await adminBloqueos(msg.chat.id);
      return;
    case ADMIN_BOTTOM.usuario:
      await startUserLookup(msg.from.id, msg.chat.id);
      return;
    case ADMIN_BOTTOM.rol:
      await rolMenu(msg.chat.id);
      return;
  }

  // Búsqueda dentro del flujo ROL
  if (adminState?.state === "rol_lookup" && text && !text.startsWith("/")) {
    const tgId = parseInt(text.replace(/\D+/g, ""), 10);
    await setState(msg.from.id, "menu", {});
    if (!Number.isFinite(tgId) || tgId <= 0) {
      await sendMessage(msg.chat.id, `ID inválido.`);
      return;
    }
    await rolShowUser(msg.chat.id, tgId);
    return;
  }


  if (text === "/pendientes") return adminPendientes(msg.chat.id);
  if (text === "/bloqueos") return adminBloqueos(msg.chat.id);

  if (text === "/limpiar") {
    await setState(msg.from.id, "admin_confirm_wipe", {});
    await sendMessage(
      msg.chat.id,
      `⚠️ <b>Limpieza total de datos de usuarios</b>\n\nEsto borrará: usuarios, estados, órdenes, comprobantes, keys entregadas, bloqueos, mensajes activos, anuncios entregados y descuentos personalizados.\n\n<b>NO</b> se tocará: productos, precios, métodos de pago, stock ni configuración del sistema.\n\nEscribí la contraseña para confirmar.`,
    );
    return;
  }
}

async function wipeAllUserData() {
  // Borrar en orden seguro (hijos antes que padres por FKs).
  // Tablas con PK uuid → usar neq id != UUID nulo (siempre verdadero).
  const uuidPkTables = [
    "order_keys",
    "receipts",
    "receipt_fingerprints",
    "announcement_deliveries",
    "user_price_overrides",
    "admin_trash",
    "admin_logs",
    "orders",
    "bot_users",
  ];
  // Tablas con PK basada en telegram_id → usar gte 0.
  const bigintTgTables = ["active_messages", "user_state", "rate_limits", "blocked_users"];

  for (const t of uuidPkTables) {
    const { error } = await sb
      .from(t as never)
      .delete()
      .neq("id" as never, "00000000-0000-0000-0000-000000000000");
    if (error) throw new Error(`No se pudo limpiar ${t}: ${error.message}`);
  }
  for (const t of bigintTgTables) {
    const { error } = await sb
      .from(t as never)
      .delete()
      .gte("telegram_id" as never, 0);
    if (error) throw new Error(`No se pudo limpiar ${t}: ${error.message}`);
  }
}



// ===== Callbacks =====
async function handleCallback(cb: TgCallback) {
  if (!isAdmin(cb.from.id)) {
    await answerCallbackQuery("admin", cb.id, "No autorizado", true);
    return;
  }
  answerCallbackQuery("admin", cb.id).catch(() => {});
  const data = cb.data ?? "";
  const chat_id = cb.message?.chat.id;

  if (data === "noop") return;

  if (data.startsWith("admbl:page:") && chat_id && cb.message) {
    const idx = parseInt(data.slice("admbl:page:".length), 10) || 0;
    await bloqueosEditPage(chat_id, cb.message.message_id, idx);
    return;
  }
  if (data.startsWith("admbl:unblock:") && chat_id && cb.message) {
    const parts = data.slice("admbl:unblock:".length).split(":");
    const tgId = parseInt(parts[0], 10);
    const idx = parseInt(parts[1] ?? "0", 10) || 0;
    await sb.from("blocked_users").delete().eq("telegram_id", tgId);
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "unblock_user",
      target_type: "telegram_id",
      target_id: String(tgId),
    });
    await answerCallbackQuery("admin", cb.id, `Desbloqueado ${tgId}.`, true);
    await bloqueosEditPage(chat_id, cb.message.message_id, idx);
    return;
  }


  if (data.startsWith("admunblock:")) {
    const tgId = parseInt(data.slice(11), 10);
    await sb.from("blocked_users").delete().eq("telegram_id", tgId);
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "unblock_user",
      target_type: "telegram_id",
      target_id: String(tgId),
    });
    await answerCallbackQuery("admin", cb.id, `Desbloqueado ${tgId}.`, true);
    // Borrar el mensaje de la lista para que no se vayan amontonando.
    if (chat_id && cb.message) {
      deleteMessage("admin", chat_id, cb.message.message_id).catch(() => {});
    }
    return;
  }

  // ===== Sistema de Rangos =====
  if (data === "rol:menu") {
    if (chat_id) await rolMenu(chat_id);
    return;
  }
  if (data === "rol:lookup") {
    await setState(cb.from.id, "rol_lookup", {});
    if (chat_id) await sendMessage(chat_id, `<b>🔍 Buscar usuario</b>\n\nEnviá el ID de Telegram (solo números).`);
    return;
  }
  if (data.startsWith("rol:filter:")) {
    const r = data.slice("rol:filter:".length) as Rank;
    if (chat_id) await rolFilter(chat_id, r);
    return;
  }
  if (data === "rol:filters") {
    if (chat_id) await rolFiltersMenu(chat_id);
    return;
  }
  if (data.startsWith("rol:history:")) {
    const tgId = parseInt(data.slice("rol:history:".length), 10);
    if (chat_id && Number.isFinite(tgId)) await rolHistory(chat_id, tgId);
    return;
  }
  if (data.startsWith("rol:user:")) {
    const tgId = parseInt(data.slice("rol:user:".length), 10);
    if (chat_id && Number.isFinite(tgId)) await rolShowUser(chat_id, tgId);
    return;
  }
  if (data.startsWith("rol:set:")) {
    const [, , idStr, r] = data.split(":");
    const tgId = parseInt(idStr, 10);
    if (!Number.isFinite(tgId) || !RANKS.includes(r as Rank)) {
      await answerCallbackQuery("admin", cb.id, "Datos inválidos", true);
      return;
    }
    await assignRank({
      telegram_id: tgId,
      new_rank: r as Rank,
      admin_telegram_id: cb.from.id,
      reason: "asignación manual desde panel admin",
    });
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "assign_rank",
      target_type: "telegram_id",
      target_id: String(tgId),
      details: { new_rank: r } as never,
    });
    await answerCallbackQuery("admin", cb.id, `${RANK_INFO[r as Rank].badge} ${RANK_INFO[r as Rank].label} asignado.`, true);
    if (chat_id) await rolShowUser(chat_id, tgId);
    return;
  }
  if (data.startsWith("rol:reset:")) {
    const tgId = parseInt(data.slice("rol:reset:".length), 10);
    if (!Number.isFinite(tgId)) return;
    await assignRank({
      telegram_id: tgId,
      new_rank: "gold",
      admin_telegram_id: cb.from.id,
      reason: "rango removido (reset a Gold)",
    });
    await answerCallbackQuery("admin", cb.id, `Rango removido. Vuelve a 🏆 Gold.`, true);
    if (chat_id) await rolShowUser(chat_id, tgId);
    return;
  }

  if (data.startsWith("usr:")) {
    const [, action, idStr] = data.split(":");
    const tgId = parseInt(idStr, 10);
    if (!Number.isFinite(tgId)) {
      await answerCallbackQuery("admin", cb.id, "ID inválido", true);
      return;
    }
    if (action === "msg") {
      await setState(cb.from.id, "admin_dm", { target_tg: tgId });
      if (chat_id) {
        await sendMessage(
          chat_id,
          `✍️ Escribí el mensaje que querés enviar a <code>${tgId}</code>.\nSe enviará a través del bot de compras.`,
        );
      }
      return;
    }
    if (action === "block") {
      await blockUserPermanent(tgId, "admin_block");
      await sb.from("admin_logs").insert({
        admin_telegram_id: cb.from.id,
        action: "block_user",
        target_type: "telegram_id",
        target_id: String(tgId),
      });
      await answerCallbackQuery("admin", cb.id, `Usuario bloqueado.`, true);
      if (chat_id) await showUserCard(chat_id, tgId);
      return;
    }
    if (action === "unblock") {
      await sb.from("blocked_users").delete().eq("telegram_id", tgId);
      await sb.from("admin_logs").insert({
        admin_telegram_id: cb.from.id,
        action: "unblock_user",
        target_type: "telegram_id",
        target_id: String(tgId),
      });
      await answerCallbackQuery("admin", cb.id, `Desbloqueado ${tgId}.`, true);
      if (chat_id) await showUserCard(chat_id, tgId);
      return;
    }
    return;
  }

  // Acciones sobre comprobantes
  const [, action, target] = data.split(":");


  if (action === "approve") {
    const { data: order } = await sb
      .from("orders")
      .select("*, bot_users(id, telegram_id, chat_id, balance, total_recharged, rank)")
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
    const u = (order as { bot_users: { id: string; telegram_id: number; chat_id: number; balance: number; total_recharged: number; rank: string } }).bot_users;
    const amount = Number(order.total_usd);
    const newBalance = Number(u.balance) + amount;
    const newRecharged = Number(u.total_recharged) + amount;
    const newRank = rankFromRecharged(newRecharged);
    const oldRank = normalizeRank(u.rank);
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
      pending: tpId(order.created_at),
    });

    await finalizeReceiptCaption({
      cb,
      order_id: target,
      status: "APROBADO",
      headerIcon: "✅",
      headerText: "COMPROBANTE APROBADO",
      statusIcon: "✅",
      extraBalanceUsd: newBalance,
    });
    await answerCallbackQuery("admin", cb.id, `✅ Aprobado · $${amount.toFixed(2)}`, true);
    return;
  }

  if (action === "reject") {
    if (!chat_id) return;
    const note = "El comprobante es falso";
    const { data: order } = await sb
      .from("orders")
      .select("*, bot_users(telegram_id, chat_id)")
      .eq("id", target)
      .single();
    if (!order) {
      await answerCallbackQuery("admin", cb.id, "Orden no encontrada", true);
      return;
    }
    if (order.status !== "pending_approval") {
      await answerCallbackQuery("admin", cb.id, "Ya procesada.", true);
      return;
    }
    await Promise.all([
      sb.from("orders").update({ status: "rejected", admin_note: note }).eq("id", target),
      sb.from("receipts").update({ status: "rejected" }).eq("order_id", target),
      sb.from("admin_logs").insert({
        admin_telegram_id: cb.from.id,
        action: "reject_order",
        target_type: "order",
        target_id: target,
        details: { note } as never,
      }),
    ]);
    const u = (order as { bot_users: { telegram_id: number; chat_id: number } }).bot_users;
    await notifyUserRejected({ telegram_id: u.telegram_id, chat_id: u.chat_id, note, pending: tpId(order.created_at) });
    await finalizeReceiptCaption({
      cb,
      order_id: target,
      status: "RECHAZADO",
      headerIcon: "❌",
      headerText: "COMPROBANTE RECHAZADO",
      statusIcon: "❌",
    });
    await answerCallbackQuery("admin", cb.id, "❌ Rechazado", true);
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
    // Buscar la orden asociada al mensaje (por admin_message_id) para editar
    // el caption sin perder la imagen del comprobante.
    if (cb.message) {
      const { data: linkedOrder } = await sb
        .from("orders")
        .select("id, status")
        .eq("admin_message_id", cb.message.message_id)
        .maybeSingle();
      if (linkedOrder) {
        if (linkedOrder.status === "pending_approval") {
          await sb.from("orders").update({ status: "rejected", admin_note: "Bloqueado" }).eq("id", linkedOrder.id);
          await sb.from("receipts").update({ status: "rejected" }).eq("order_id", linkedOrder.id);
        }
        await finalizeReceiptCaption({
          cb,
          order_id: linkedOrder.id,
          status: "BLOQUEADO",
          headerIcon: "⛔",
          headerText: "USUARIO BLOQUEADO",
          statusIcon: "⛔",
        });
      } else {
        // Sin orden asociada: al menos quitar los botones y dejar aviso.
        await editMessageReplyMarkup("admin", cb.message.chat.id, cb.message.message_id, { inline_keyboard: [] }).catch(() => {});
      }
    }
    await answerCallbackQuery("admin", cb.id, "Usuario bloqueado.", true);
    return;
  }

  if (action === "sendkey") {
    // El envío de keys se hace desde el Bot Almacén, no desde el admin.
    await answerCallbackQuery("admin", cb.id, "El envío de keys se hace desde el Bot Almacén.", true);
    return;
  }


  if (chat_id) {
    await sendMessage(chat_id, `Esa opción ya no está disponible. Usa la barra inferior para continuar.`, {
      reply_markup: adminBottomKeyboard(),
    });
  }
}

// =====================================================================
// Sistema de Rangos — Menú ROL 🏆
// =====================================================================
async function rolMenu(chat_id: number) {
  const counts: Record<string, number> = {};
  for (const r of RANKS) {
    const { count } = await sb
      .from("bot_users")
      .select("telegram_id", { count: "exact", head: true })
      .eq("rank", r);
    counts[r] = count ?? 0;
  }
  const text =
    `<b>🏆 ROL · Sistema de Rangos</b>\n\n` +
    `🏆 <b>Gold</b>     · 0% descuento · ${counts.gold ?? 0} usuarios\n` +
    `💠 <b>Platinum</b> · 0.5% descuento · ${counts.platinum ?? 0} usuarios\n` +
    `💎 <b>Diamond</b>  · 1% descuento · ${counts.diamond ?? 0} usuarios\n` +
    `👑 <b>Elite</b>    · productos $30 → $25 · ${counts.elite ?? 0} usuarios\n\n` +
    `<b>Ascensos automáticos</b>\n` +
    `• $100 → Platinum\n• $180 → Diamond\n• $400 → Elite`;
  await sendMessage(chat_id, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔍 Buscar usuario por ID", callback_data: "rol:lookup" }],
        [{ text: "📋 Filtrar por rango", callback_data: "rol:filters" }],
      ],
    },
  });
}

async function rolFiltersMenu(chat_id: number) {
  await sendMessage(chat_id, `<b>📋 Filtrar usuarios por rango</b>`, {
    reply_markup: {
      inline_keyboard: RANKS.map((r) => [
        { text: `${RANK_INFO[r].badge} ${RANK_INFO[r].label}`, callback_data: `rol:filter:${r}` },
      ]),
    },
  });
}

async function rolFilter(chat_id: number, rank: Rank) {
  const { data } = await sb
    .from("bot_users")
    .select("telegram_id, username, display_name, total_recharged, rank_assigned_at")
    .eq("rank", rank)
    .order("total_recharged", { ascending: false })
    .limit(30);
  if (!data || data.length === 0) {
    await sendMessage(chat_id, `<b>${RANK_INFO[rank].badge} ${RANK_INFO[rank].label}</b>\n\nSin usuarios.`);
    return;
  }
  const lines = data.map((u, i) => {
    const name = u.display_name ? escapeHtml(String(u.display_name)) : (u.username ? `@${escapeHtml(String(u.username))}` : "—");
    return `${i + 1}. ${name} · <code>${u.telegram_id}</code> · $${Number(u.total_recharged).toFixed(2)}`;
  });
  const kb = data.slice(0, 10).map((u) => [
    { text: `Ver ${u.telegram_id}`, callback_data: `rol:user:${u.telegram_id}` },
  ]);
  await sendMessage(
    chat_id,
    `<b>${RANK_INFO[rank].badge} ${RANK_INFO[rank].label} (${data.length})</b>\n\n${lines.join("\n")}`,
    { reply_markup: { inline_keyboard: kb } },
  );
}

async function rolShowUser(chat_id: number, telegram_id: number) {
  const { data: u } = await sb
    .from("bot_users")
    .select("telegram_id, username, display_name, balance, total_recharged, rank, rank_assigned_at, registered_at")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  if (!u) {
    await sendMessage(chat_id, `No encontré usuario con ID <code>${telegram_id}</code>.`);
    return;
  }
  const current = normalizeRank(u.rank);
  const info = RANK_INFO[current];
  const assigned = u.rank_assigned_at ? new Date(u.rank_assigned_at).toLocaleString("es") : "—";
  const text =
    `<b>${info.badge} ${info.label}</b>\n\n` +
    `Usuario   ${escapeHtml(u.display_name ?? "—")} ${info.badge}\n` +
    `@${escapeHtml(u.username ?? "—")} · <code>${u.telegram_id}</code>\n` +
    `Comprado  $${Number(u.total_recharged).toFixed(2)} USD\n` +
    `Saldo     $${Number(u.balance).toFixed(2)} USD\n` +
    `Descuento ${current === "elite" ? "productos $30 → $25" : `${info.discountPct}%`}\n` +
    `Rango desde ${assigned}`;
  const kb: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const r of RANKS) {
    if (r === current) continue;
    kb.push([{ text: `Asignar ${RANK_INFO[r].badge} ${RANK_INFO[r].label}`, callback_data: `rol:set:${telegram_id}:${r}` }]);
  }
  if (current !== "gold") {
    kb.push([{ text: "♻️ Quitar rango (→ Gold)", callback_data: `rol:reset:${telegram_id}` }]);
  }
  kb.push([{ text: "📜 Ver historial", callback_data: `rol:history:${telegram_id}` }]);
  await sendMessage(chat_id, text, { reply_markup: { inline_keyboard: kb } });
}

async function rolHistory(chat_id: number, telegram_id: number) {
  const { data } = await sb
    .from("rank_history")
    .select("old_rank, new_rank, changed_by, admin_telegram_id, reason, created_at")
    .eq("telegram_id", telegram_id)
    .order("created_at", { ascending: false })
    .limit(15);
  if (!data || data.length === 0) {
    await sendMessage(chat_id, `<b>📜 Historial</b> · <code>${telegram_id}</code>\n\nSin cambios registrados.`);
    return;
  }
  const lines = data.map((h) => {
    const from = h.old_rank ? `${RANK_INFO[normalizeRank(h.old_rank)].badge}` : "—";
    const to = `${RANK_INFO[normalizeRank(h.new_rank)].badge} ${RANK_INFO[normalizeRank(h.new_rank)].label}`;
    const who = h.changed_by === "admin" ? `admin ${h.admin_telegram_id ?? ""}` : "auto";
    const when = new Date(h.created_at).toLocaleString("es");
    return `${when} · ${from} → ${to} · <i>${escapeHtml(String(h.reason ?? who))}</i>`;
  });
  await sendMessage(chat_id, `<b>📜 Historial</b> · <code>${telegram_id}</code>\n\n${lines.join("\n")}`);
}
