// Admin Bot — handler
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  ADMIN_CHAT_ID,
} from "./api.server";
import { sb, checkRateLimit } from "./db.server";
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
  reply_to_message?: { message_id: number };
}
interface TgCallback {
  id: string;
  from: { id: number };
  message?: { chat: { id: number }; message_id: number; caption?: string };
  data?: string;
}

function isAdmin(telegram_id: number) {
  return String(telegram_id) === String(ADMIN_CHAT_ID);
}

export async function handleAdminUpdate(update: Update): Promise<void> {
  if (update.message) await handleMessage(update.message);
  else if (update.callback_query) await handleCallback(update.callback_query);
}

async function handleMessage(msg: TgMessage) {
  if (!msg.from) return;
  if (!isAdmin(msg.from.id)) {
    await sendMessage("admin", msg.chat.id, `🚫 No autorizado.`);
    return;
  }
  if (!(await checkRateLimit(msg.from.id, "admin_msg", 30, 10))) return;

  const text = (msg.text ?? "").trim();

  // texto para enviar key manual (responde a la tarjeta del comprobante)
  if (msg.reply_to_message) {
    const { data: ord } = await sb
      .from("orders")
      .select("id, telegram_id, user_id, product_id, price_id, keys_qty")
      .eq("admin_message_id", msg.reply_to_message.message_id)
      .maybeSingle();
    if (ord && text.length > 0) {
      // tratar el texto como una key manual
      await sb.from("order_keys").insert({
        order_id: ord.id,
        user_id: ord.user_id,
        key_value: text,
      });
      await sb.from("orders").update({ status: "delivered" }).eq("id", ord.id);
      const { data: u } = await sb
        .from("bot_users")
        .select("chat_id")
        .eq("id", ord.user_id)
        .single();
      if (u) await notifyUserKey({ chat_id: u.chat_id, key_value: text });
      await sendMessage("admin", msg.chat.id, `✅ Key enviada al usuario.`);
      return;
    }
  }

  if (text === "/start" || text === "/help") {
    await sendMessage(
      "admin",
      msg.chat.id,
      `<b>🛠 Panel Admin</b>\n\n` +
        `/pendientes — órdenes esperando aprobación\n` +
        `/stock — stock de keys disponibles\n` +
        `/addkeys productId priceId — cargar keys (responder al mensaje con 1 key por línea)\n` +
        `/usuarios — total usuarios\n\n` +
        `Los comprobantes llegan automáticamente con botones Aprobar/Rechazar/Bloquear/Key Manual.`,
    );
    return;
  }

  if (text === "/pendientes") {
    const { data: orders } = await sb
      .from("orders")
      .select("id, telegram_id, total_usd, products(name)")
      .eq("status", "pending_approval")
      .order("created_at", { ascending: false })
      .limit(20);
    if (!orders || orders.length === 0) {
      await sendMessage("admin", msg.chat.id, `✅ No hay órdenes pendientes.`);
      return;
    }
    const lines = orders
      .map(
        (o) =>
          `• <code>${o.id.slice(0, 8)}</code> — TG <code>${o.telegram_id}</code> — $${Number(
            o.total_usd,
          ).toFixed(2)} — ${(o as { products: { name: string } }).products.name}`,
      )
      .join("\n");
    await sendMessage(
      "admin",
      msg.chat.id,
      `<b>⏳ Pendientes (${orders.length}):</b>\n\n${lines}\n\nUsá los botones en cada comprobante para aprobar.`,
    );
    return;
  }

  if (text === "/stock") {
    const { data } = await sb
      .from("product_stock_keys")
      .select("product_id, products(name), used")
      .eq("used", false);
    const map = new Map<string, number>();
    for (const r of data ?? []) {
      const name = (r as { products: { name: string } }).products.name;
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    const lines = [...map.entries()].map(([n, c]) => `• ${n}: ${c}`).join("\n") || "Sin stock.";
    await sendMessage("admin", msg.chat.id, `<b>📦 Stock disponible:</b>\n${lines}`);
    return;
  }

  if (text === "/usuarios") {
    const { count } = await sb.from("bot_users").select("id", { count: "exact", head: true });
    await sendMessage("admin", msg.chat.id, `👥 Total usuarios: <b>${count ?? 0}</b>`);
    return;
  }
}

async function handleCallback(cb: TgCallback) {
  if (!isAdmin(cb.from.id)) {
    await answerCallbackQuery("admin", cb.id, "No autorizado", true);
    return;
  }
  const data = cb.data ?? "";
  const [, action, target] = data.split(":");

  if (action === "approve") {
    const { data: order } = await sb
      .from("orders")
      .select("*, bot_users(id, telegram_id, chat_id, balance, total_recharged)")
      .eq("id", target)
      .single();
    if (!order || order.status !== "pending_approval") {
      await answerCallbackQuery("admin", cb.id, "Orden no pendiente", true);
      return;
    }
    const u = (order as { bot_users: { id: string; telegram_id: number; chat_id: number; balance: number; total_recharged: number } }).bot_users;
    const amount = Number(order.total_usd);
    const newBalance = Number(u.balance) + amount;
    const newRecharged = Number(u.total_recharged) + amount;
    let rank: "normal" | "pro" | "leyenda" = "normal";
    if (newRecharged >= 200) rank = "leyenda";
    else if (newRecharged >= 50) rank = "pro";

    await sb
      .from("bot_users")
      .update({ balance: newBalance, total_recharged: newRecharged, rank })
      .eq("id", u.id);
    await sb.from("orders").update({ status: "approved" }).eq("id", target);
    await sb.from("receipts").update({ status: "approved" }).eq("order_id", target);
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "approve_order",
      target_type: "order",
      target_id: target,
      details: { amount_usd: amount } as never,
    });

    await notifyUserApproved({
      telegram_id: u.telegram_id,
      chat_id: u.chat_id,
      amount_usd: amount,
      new_balance: newBalance,
    });

    if (cb.message) {
      await editMessageText(
        "admin",
        cb.message.chat.id,
        cb.message.message_id,
        (cb.message.caption ?? "") + `\n\n✅ <b>APROBADO</b> — $${amount.toFixed(2)} acreditado`,
        {},
      );
    }
    await answerCallbackQuery("admin", cb.id, "Aprobado ✅");
    return;
  }

  if (action === "reject") {
    const { data: order } = await sb
      .from("orders")
      .select("*, bot_users(telegram_id, chat_id)")
      .eq("id", target)
      .single();
    if (!order) {
      await answerCallbackQuery("admin", cb.id, "No encontrada", true);
      return;
    }
    await sb.from("orders").update({ status: "rejected" }).eq("id", target);
    await sb.from("receipts").update({ status: "rejected" }).eq("order_id", target);
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "reject_order",
      target_type: "order",
      target_id: target,
    });
    const u = (order as { bot_users: { telegram_id: number; chat_id: number } }).bot_users;
    await notifyUserRejected({ telegram_id: u.telegram_id, chat_id: u.chat_id });
    if (cb.message) {
      await editMessageText(
        "admin",
        cb.message.chat.id,
        cb.message.message_id,
        (cb.message.caption ?? "") + `\n\n❌ <b>RECHAZADO</b>`,
        {},
      );
    }
    await answerCallbackQuery("admin", cb.id, "Rechazado");
    return;
  }

  if (action === "block") {
    const tgId = parseInt(target, 10);
    await sb.from("blocked_users").upsert({ telegram_id: tgId, reason: "admin_block" });
    await sb.from("admin_logs").insert({
      admin_telegram_id: cb.from.id,
      action: "block_user",
      target_type: "telegram_id",
      target_id: target,
    });
    await answerCallbackQuery("admin", cb.id, `Usuario ${tgId} bloqueado 🚫`, true);
    return;
  }

  if (action === "sendkey") {
    await answerCallbackQuery(
      "admin",
      cb.id,
      "Respondé a este mensaje con el valor de la key.",
      true,
    );
    return;
  }
}
