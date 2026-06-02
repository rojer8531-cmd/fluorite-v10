// Admin Bot — handler
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  ADMIN_CHAT_ID,
} from "./api.server";
import { sb, checkRateLimit } from "./db.server";
import { getHideOutOfStockSetting, getStockByPriceId, getVisibleCatalog } from "./catalog.server";
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

function isAdmin(telegram_id: number) {
  return String(telegram_id) === String(ADMIN_CHAT_ID);
}

function shortId(id: string) {
  return id.slice(0, 8);
}

async function resolvePriceId(rawId: string) {
  const normalized = rawId.trim();
  if (!normalized) return null;
  if (normalized.length === 36) return normalized;

  const { data } = await sb
    .from("product_prices")
    .select("id")
    .ilike("id", `${normalized}%`)
    .limit(2);

  if (!data || data.length !== 1) return null;
  return data[0].id;
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

    const replySource = `${msg.reply_to_message.text ?? ""}\n${msg.reply_to_message.caption ?? ""}`;
    const addKeysMatch = replySource.match(/ADDKEYS:([a-f0-9-]{36})/i);
    if (addKeysMatch && text.length > 0) {
      const priceId = addKeysMatch[1];
      const { data: price } = await sb
        .from("product_prices")
        .select("id, product_id, duration_label, products(name)")
        .eq("id", priceId)
        .single();
      if (!price) {
        await sendMessage("admin", msg.chat.id, `❌ Variante no encontrada.`);
        return;
      }

      const parsedKeys = [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
      if (parsedKeys.length === 0) {
        await sendMessage("admin", msg.chat.id, `❌ No detecté keys válidas.`);
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
      }

      await sendMessage(
        "admin",
        msg.chat.id,
        `✅ Keys cargadas para ${(price as { products: { name: string } }).products.name} / ${price.duration_label}.\nNuevas: ${newKeys.length}\nDuplicadas omitidas: ${parsedKeys.length - newKeys.length}`,
      );
      return;
    }
  }

  if (text === "/start" || text === "/help") {
    await sendMessage(
      "admin",
      msg.chat.id,
      `<b>🛠 Panel Admin</b>\n\n` +
        `/pendientes — órdenes esperando aprobación\n` +
        `/stock — stock por producto y duración\n` +
        `/precios — catálogo real con IDs cortos, precios y stock\n` +
        `/setprecio <priceId> <usd> — editar precio sin reinicio\n` +
        `/addkeys <priceId> — responder con 1 key por línea\n` +
        `/ocultar_sin_stock on|off — mostrar u ocultar variantes sin stock\n` +
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
    const { grouped } = await getVisibleCatalog();
    const stockByPriceId = await getStockByPriceId();
    const lines = grouped
      .flatMap((section) => [
        `${section.category}:`,
        ...section.products.flatMap((product) =>
          product.prices.map((price) =>
            `• ${product.name} / ${price.duration_label}: ${stockByPriceId.get(price.id) ?? 0}`,
          ),
        ),
      ])
      .join("\n");
    await sendMessage("admin", msg.chat.id, `<b>📦 Stock disponible</b>\n\n${lines || "Sin stock."}`);
    return;
  }

  if (text === "/precios") {
    const hideOutOfStock = await getHideOutOfStockSetting();
    const { grouped } = await getVisibleCatalog();
    const lines = grouped
      .flatMap((section) => [
        `${section.category}:`,
        ...section.products.flatMap((product) =>
          product.prices.map(
            (price) =>
              `• ${product.name} / ${price.duration_label} — $${Number(price.price_usd).toFixed(2)} — stock ${price.available_stock} — <code>${shortId(price.id)}</code>`,
          ),
        ),
      ])
      .join("\n");
    await sendMessage(
      "admin",
      msg.chat.id,
      `<b>📋 Catálogo</b>\nOcultar sin stock: <b>${hideOutOfStock ? "ON" : "OFF"}</b>\n\n${lines || "Sin variantes cargadas."}`,
    );
    return;
  }

  if (text.startsWith("/setprecio ")) {
    const [, rawPriceId, rawUsd] = text.split(/\s+/);
    const newValue = Number(rawUsd);
    if (!rawPriceId || !rawUsd || !Number.isFinite(newValue) || newValue <= 0) {
      await sendMessage("admin", msg.chat.id, `Uso: /setprecio <priceId> <usd>`);
      return;
    }
    const priceId = await resolvePriceId(rawPriceId);
    if (!priceId) {
      await sendMessage("admin", msg.chat.id, `❌ ID de variante inválido o ambiguo. Usá /precios.`);
      return;
    }
    const { data: updated } = await sb
      .from("product_prices")
      .update({ price_usd: newValue })
      .eq("id", priceId)
      .select("id, duration_label, products(name)")
      .maybeSingle();
    if (!updated) {
      await sendMessage("admin", msg.chat.id, `❌ No encontré esa variante. Usá /precios.`);
      return;
    }
    await sendMessage(
      "admin",
      msg.chat.id,
      `✅ Precio actualizado: ${(updated as { products: { name: string } }).products.name} / ${updated.duration_label} → $${newValue.toFixed(2)}`,
    );
    return;
  }

  if (text.startsWith("/addkeys ")) {
    const [, priceId] = text.split(/\s+/);
    const resolvedPriceId = await resolvePriceId(priceId ?? "");
    if (!resolvedPriceId) {
      await sendMessage("admin", msg.chat.id, `Uso: /addkeys <priceId>`);
      return;
    }
    const { data: price } = await sb
      .from("product_prices")
      .select("id, duration_label, products(name)")
      .eq("id", resolvedPriceId)
      .maybeSingle();
    if (!price) {
      await sendMessage("admin", msg.chat.id, `❌ No encontré esa variante. Usá /precios.`);
      return;
    }
    await sendMessage(
      "admin",
      msg.chat.id,
      `<b>ADDKEYS:${resolvedPriceId}</b>\n${(price as { products: { name: string } }).products.name} / ${price.duration_label}\n\nRespondé a este mensaje con 1 key por línea.`,
    );
    return;
  }

  if (text.startsWith("/ocultar_sin_stock ")) {
    const [, mode] = text.split(/\s+/);
    if (!["on", "off"].includes(mode)) {
      await sendMessage("admin", msg.chat.id, `Uso: /ocultar_sin_stock on|off`);
      return;
    }
    await sb.from("telegram_bot_settings").upsert({ singleton: true, hide_out_of_stock: mode === "on" });
    await sendMessage("admin", msg.chat.id, `✅ Ocultar sin stock: <b>${mode.toUpperCase()}</b>`);
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
