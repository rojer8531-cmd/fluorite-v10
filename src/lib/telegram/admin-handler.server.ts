// Admin Bot — SOLO bandeja de comprobantes y solicitudes de key.
// Barra inferior persistente: 📥 Pendientes · 🚫 Bloqueos.
// Los comprobantes NO se borran automáticamente.
import {
  sendMessage as _rawSendMessage,
  editMessageReplyMarkup,
  deleteMessage,
  answerCallbackQuery,
  getAdminChatId,
  sendPhoto,
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

function isAdmin(telegram_id: number) {
  return String(telegram_id) === String(getAdminChatId());
}

function tpId(createdAt: string) {
  return `TP${new Date(createdAt).getTime()}`;
}

// ===== Barra inferior persistente del admin =====
const ADMIN_BOTTOM = {
  pendientes: "📥 Pendientes",
  bloqueos: "🚫 Bloqueos",
  usuario: "🔍 Usuario",
};

function adminBottomKeyboard() {
  return {
    keyboard: [
      [{ text: ADMIN_BOTTOM.pendientes }, { text: ADMIN_BOTTOM.bloqueos }],
      [{ text: ADMIN_BOTTOM.usuario }],
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

  if (admin_id && chat_id) {
    await ensureAdminBar(chat_id, admin_id).catch(() => {});
  }

  if (update.message) await handleMessage(update.message);
  else if (update.callback_query) await handleCallback(update.callback_query);
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
    if (r?.file_id) {
      const sent = await sendPhoto("admin", chat_id, r.file_id, caption, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Aprobar", callback_data: `ord:approve:${o.id}` },
              { text: "❌ Rechazar", callback_data: `ord:reject:${o.id}` },
            ],
            [
              { text: "🚫 Bloquear", callback_data: `ord:block:${o.telegram_id}` },
              { text: "🔑 Enviar key", callback_data: `ord:sendkey:${o.id}` },
            ],
          ],
        },
      });
      if (sent.ok && sent.result) {
        await sb
          .from("receipts")
          .update({ admin_message_id: sent.result.message_id })
          .eq("order_id", o.id);
      }
    } else {
      await sendMessage(chat_id, caption, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Aprobar", callback_data: `ord:approve:${o.id}` },
              { text: "❌ Rechazar", callback_data: `ord:reject:${o.id}` },
            ],
            [
              { text: "🚫 Bloquear", callback_data: `ord:block:${o.telegram_id}` },
              { text: "🔑 Enviar key", callback_data: `ord:sendkey:${o.id}` },
            ],
          ],
        },
      });
    }
  }
}

// ===== Bloqueos =====
async function adminBloqueos(chat_id: number) {
  const { data } = await sb
    .from("blocked_users")
    .select("telegram_id, reason, blocked_until, infraction_count")
    .order("telegram_id")
    .limit(50);
  if (!data || data.length === 0) {
    await sendMessage(chat_id, `<b>🚫 Bloqueos</b>\n\nNo hay usuarios bloqueados.`);
    return;
  }
  const lines = data.map((b, i) => {
    const until = b.blocked_until
      ? `hasta ${new Date(b.blocked_until).toLocaleString("es")}`
      : `permanente`;
    return `${i + 1}. <code>${b.telegram_id}</code> · ${escapeHtml(b.reason ?? "—")} · ${until}`;
  });
  const kb = data.map((b) => [
    { text: `Desbloquear ${b.telegram_id}`, callback_data: `admunblock:${b.telegram_id}` },
  ]);
  await sendMessage(chat_id, `<b>🚫 Bloqueos (${data.length})</b>\n\n${lines.join("\n")}`, {
    reply_markup: { inline_keyboard: kb },
  });
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
    .select("id, telegram_id, chat_id, balance, total_recharged")
    .eq("id", order.user_id)
    .single();
  if (!u) {
    await sendMessage(chat_id, `Usuario no encontrado.`);
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
  if (!(await checkRateLimit(msg.from.id, "admin_msg", 30, 10))) return;

  const text = (msg.text ?? "").trim();

  // ===== flujo de búsqueda / mensaje directo a usuario =====
  const adminState = await getState(msg.from.id);
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
  }


  if (text === "/start" || text === "/help" || text === "/panel") {
    await patchContext(msg.from.id, { admin_bar_shown: false });
    await sendMessage(
      msg.chat.id,
      `<b>Panel Admin ✅</b>\nUsá la barra inferior para todas las funciones.`,
      { reply_markup: adminBottomKeyboard() },
    );
    await patchContext(msg.from.id, { admin_bar_shown: true });
    return;
  }

  if (text === "/pendientes") return adminPendientes(msg.chat.id);
  if (text === "/bloqueos") return adminBloqueos(msg.chat.id);
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

    await notifyUserApproved({
      telegram_id: u.telegram_id,
      chat_id: u.chat_id,
      amount_usd: amount,
      new_balance: newBalance,
      pending: tpId(order.created_at),
    });

    const { data: rcpt } = await sb
      .from("receipts")
      .select("admin_message_id")
      .eq("order_id", target)
      .maybeSingle();
    const photoMid = rcpt?.admin_message_id ?? cb.message?.message_id ?? 0;
    if (photoMid && cb.message) {
      await deleteMessage("admin", cb.message.chat.id, photoMid).catch(() => {});
    }
    await answerCallbackQuery("admin", cb.id, `✅ Aprobado · $${amount.toFixed(2)}`, true);
    return;
  }

  if (action === "reject") {
    if (!chat_id) return;
    const { data: rcpt } = await sb
      .from("receipts")
      .select("admin_message_id")
      .eq("order_id", target)
      .maybeSingle();
    const photoMid = rcpt?.admin_message_id ?? cb.message?.message_id ?? 0;
    const sent = await sendMessage(
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
      await markReceiptStatus(cb.message.chat.id, cb.message.message_id, `🚫 BLOQUEADO`, String(tgId));
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
      await sendMessage(chat_id, `Orden no encontrada.`);
      return;
    }
    const name = (ord as { products: { name: string } | null }).products?.name ?? "—";
    const dur = (ord as { product_prices: { duration_label: string } | null }).product_prices?.duration_label ?? "—";
    const sent = await sendMessage(
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
