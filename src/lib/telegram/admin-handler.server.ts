// Admin Bot — handler (UI limpia, barra inferior persistente)
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  getAdminChatId,
  getFile,
  downloadFile,
  sendPhotoMultipart,
} from "./api.server";
import { sb, checkRateLimit } from "./db.server";
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
  reply_to_message?: { message_id: number; text?: string; caption?: string };
}
interface TgCallback {
  id: string;
  from: { id: number };
  message?: { chat: { id: number }; message_id: number; caption?: string };
  data?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isAdmin(telegram_id: number) {
  return String(telegram_id) === String(getAdminChatId());
}

function shortId(id: string) {
  return id.slice(0, 8);
}

// ===== Barra inferior persistente del admin =====
const ADMIN_BOTTOM = {
  pendientes: "Pendientes",
  stock: "Stock",
  usuarios: "Usuarios",
  addkeys: "Agregar Keys",
  precios: "Precios",
  anuncio: "Anuncio",
  panel: "Panel",
};

function adminBottomKeyboard() {
  return {
    keyboard: [
      [{ text: ADMIN_BOTTOM.pendientes }, { text: ADMIN_BOTTOM.stock }],
      [{ text: ADMIN_BOTTOM.usuarios }, { text: ADMIN_BOTTOM.addkeys }],
      [{ text: ADMIN_BOTTOM.precios }, { text: ADMIN_BOTTOM.anuncio }],
      [{ text: ADMIN_BOTTOM.panel }],
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

export async function handleAdminUpdate(update: Update): Promise<void> {
  if (update.message) await handleMessage(update.message);
  else if (update.callback_query) await handleCallback(update.callback_query);
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
        [{ text: "Anuncio", callback_data: "akp:anuncio" }],
      ],
    },
  });
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

async function adminPendientes(chat_id: number) {
  const { data: orders } = await sb
    .from("orders")
    .select("id, telegram_id, total_usd, order_type, products(name)")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: false })
    .limit(20);
  if (!orders || orders.length === 0) {
    await sendMessage("admin", chat_id, `No hay órdenes pendientes.`);
    return;
  }
  const lines = orders
    .map((o) => {
      const label =
        o.order_type === "recharge"
          ? "Recarga"
          : (o as { products: { name: string } | null }).products?.name ?? "—";
      return `<code>${o.id.slice(0, 8)}</code>  ·  TG <code>${o.telegram_id}</code>  ·  $${Number(
        o.total_usd,
      ).toFixed(2)}  ·  ${label}`;
    })
    .join("\n");
  await sendMessage(
    "admin",
    chat_id,
    `<b>Pendientes (${orders.length})</b>\n\n${lines}\n\nUsá los botones en cada comprobante para aprobar.`,
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
    await sendMessage("admin", chat_id, `<b>Usuarios</b>  ·  Total ${total}\n\nNo hay usuarios en esta página.`);
    return;
  }

  const lines = users.map((u, i) => {
    const idx = from + i + 1;
    const uname = u.username ? `@${u.username}` : "(sin username)";
    return (
      `${idx}.  <b>${escapeHtml(u.display_name ?? "—")}</b>  ·  ${uname}\n` +
      `    ID <code>${u.telegram_id}</code>  ·  Saldo $${Number(u.balance).toFixed(2)}  ·  Rec $${Number(u.total_recharged).toFixed(2)}  ·  ${u.rank}`
    );
  });

  const kb: Array<Array<{ text: string; callback_data?: string; url?: string }>> = users.map((u) => [
    { text: `Ver  ${u.display_name ?? u.telegram_id}`, callback_data: `akusr:${u.telegram_id}` },
  ]);

  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) nav.push({ text: "Anterior", callback_data: `akusrp:${page - 1}` });
  if (to + 1 < total) nav.push({ text: "Siguiente", callback_data: `akusrp:${page + 1}` });
  if (nav.length > 0) kb.push(nav);

  await sendMessage(
    "admin",
    chat_id,
    `<b>Usuarios</b>  ·  Total ${total}\nPágina ${page + 1} de ${Math.max(1, Math.ceil(total / USERS_PAGE_SIZE))}\n\n${lines.join("\n\n")}`,
    { reply_markup: { inline_keyboard: kb } },
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
  await sendMessage(
    "admin",
    chat_id,
    `<b>BROADCAST_ANUNCIO</b>\n\nRespondé a este mensaje con el texto o la imagen que querés enviar como anuncio a todos los usuarios.`,
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

// ===== Anuncio (broadcast) =====
async function handleBroadcast(msg: TgMessage) {
  const { data: users } = await sb.from("bot_users").select("chat_id");
  const chatIds = [...new Set((users ?? []).map((u) => u.chat_id).filter(Boolean))] as number[];
  if (chatIds.length === 0) {
    await sendMessage("admin", msg.chat.id, `No hay usuarios para enviar el anuncio.`);
    return;
  }

  let ok = 0;
  let fail = 0;

  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    const fileInfo = await getFile("admin", photo.file_id);
    if (!fileInfo.ok || !fileInfo.result) {
      await sendMessage("admin", msg.chat.id, `No pude procesar la imagen del anuncio.`);
      return;
    }
    const bytes = await downloadFile("admin", fileInfo.result.file_path);
    if (!bytes) {
      await sendMessage("admin", msg.chat.id, `No pude descargar la imagen del anuncio.`);
      return;
    }
    const caption = (msg.caption ?? "").trim();
    await sendMessage("admin", msg.chat.id, `Enviando anuncio con imagen a ${chatIds.length} usuarios...`);
    for (const cid of chatIds) {
      const r = await sendPhotoMultipart("shop", cid, bytes, "anuncio.jpg", caption);
      if (r.ok) ok++;
      else fail++;
      await sleep(35);
    }
  } else {
    const body = (msg.text ?? "").trim();
    if (!body) {
      await sendMessage("admin", msg.chat.id, `El anuncio está vacío.`);
      return;
    }
    await sendMessage("admin", msg.chat.id, `Enviando anuncio a ${chatIds.length} usuarios...`);
    for (const cid of chatIds) {
      const r = await sendMessage("shop", cid, `<b>Anuncio</b>\n\n${escapeHtml(body)}`);
      if (r.ok) ok++;
      else fail++;
      await sleep(35);
    }
  }

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

  // ===== respuestas (reply) =====
  if (msg.reply_to_message) {
    const replySource = `${msg.reply_to_message.text ?? ""}\n${msg.reply_to_message.caption ?? ""}`;

    if (replySource.includes("BROADCAST_ANUNCIO")) {
      await handleBroadcast(msg);
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
      const { data: u } = await sb
        .from("bot_users")
        .select("chat_id")
        .eq("id", ord.user_id)
        .single();
      if (u) await notifyUserKey({ chat_id: u.chat_id, key_value: text });
      await sendMessage("admin", msg.chat.id, `Key enviada al usuario.`);
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
    case ADMIN_BOTTOM.panel:
      await showAdminPanel(msg.chat.id);
      return;
  }

  if (text === "/start" || text === "/help" || text === "/panel") {
    // Mostrar la barra inferior + panel + ayuda
    await sendMessage(
      "admin",
      msg.chat.id,
      `<b>Panel Admin</b>\n\nUsá la barra inferior para acceder rápido a las funciones más usadas.`,
      { reply_markup: adminBottomKeyboard() },
    );
    await showAdminPanel(msg.chat.id);
    await sendMessage(
      "admin",
      msg.chat.id,
      `<b>Comandos disponibles</b>\n\n` +
        `/pendientes  órdenes esperando aprobación\n` +
        `/stock       stock por producto y duración\n` +
        `/precios     catálogo con IDs cortos, precios y stock\n` +
        `/setprecio &lt;priceId&gt; &lt;usd&gt;   editar precio sin reinicio\n` +
        `/addkeys &lt;priceId&gt;             responder con 1 key por línea\n` +
        `/ocultar_sin_stock on|off       mostrar u ocultar variantes sin stock\n` +
        `/usuarios    total usuarios\n\n` +
        `Los comprobantes y recargas llegan automáticamente con botones.`,
    );
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
    if (!order || order.status !== "pending_approval") return;
    if (order.order_type === "recharge" && Number(order.total_usd) <= 0) {
      await answerCallbackQuery(
        "admin",
        cb.id,
        "Respondé al comprobante con el monto en USD a acreditar.",
        true,
      );
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
    });

    if (cb.message) {
      await editMessageText(
        "admin",
        cb.message.chat.id,
        cb.message.message_id,
        (cb.message.caption ?? "") + `\n\n<b>APROBADO</b>  ·  $${amount.toFixed(2)} acreditado`,
        {},
      );
    }
    return;
  }

  if (action === "reject") {
    const { data: order } = await sb
      .from("orders")
      .select("*, bot_users(telegram_id, chat_id)")
      .eq("id", target)
      .single();
    if (!order) return;
    await Promise.all([
      sb.from("orders").update({ status: "rejected" }).eq("id", target),
      sb.from("receipts").update({ status: "rejected" }).eq("order_id", target),
      sb.from("admin_logs").insert({
        admin_telegram_id: cb.from.id,
        action: "reject_order",
        target_type: "order",
        target_id: target,
      }),
    ]);
    const u = (order as { bot_users: { telegram_id: number; chat_id: number } }).bot_users;
    await notifyUserRejected({ telegram_id: u.telegram_id, chat_id: u.chat_id });
    if (cb.message) {
      await editMessageText(
        "admin",
        cb.message.chat.id,
        cb.message.message_id,
        (cb.message.caption ?? "") + `\n\n<b>RECHAZADO</b>`,
        {},
      );
    }
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
