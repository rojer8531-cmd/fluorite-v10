// Shop Bot — handler completo (UI minimalista)
import {
  sendMessage,
  sendPhotoMultipart,
  getFile,
  downloadFile,
  answerCallbackQuery,
  getAdminChatId,
} from "./api.server";
import {
  getOrCreateUser,
  updateUser,
  getState,
  setState,
  patchContext,
  tryAcquireStartLock,
  checkRateLimit,
  isBlocked,
  getActiveMessage,
  setActiveMessage,
  sb,
} from "./db.server";
import { renderScreen, silentDelete } from "./ui.server";
import { getVisibleCatalog, invalidateCatalogCache } from "./catalog.server";

const ACCESS_PASSWORD = "117";

interface Update {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}
interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number };
  text?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  document?: unknown;
}
interface TgCallback {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: TgMessage;
  data?: string;
}

const RANK_LABEL: Record<string, string> = {
  normal: "Normal",
  pro: "Pro",
  leyenda: "Leyenda",
};

const SUPPORT_USERNAME = "@smallffx7";

// Menú inferior fijo (ReplyKeyboardMarkup) — siempre visible
const BOTTOM_MENU = {
  products: "Productos",
  buy: "Comprar",
  status: "Estado",
  profile: "Perfil",
  keys: "Mis Keys",
  recharge: "Recargar",
  support: "Soporte",
};

function bottomKeyboard() {
  return {
    keyboard: [
      [{ text: BOTTOM_MENU.products }, { text: BOTTOM_MENU.buy }],
      [{ text: BOTTOM_MENU.status }, { text: BOTTOM_MENU.profile }],
      [{ text: BOTTOM_MENU.keys }, { text: BOTTOM_MENU.recharge }],
      [{ text: BOTTOM_MENU.support }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

const BACK_BUTTON = [{ text: "Volver", callback_data: "menu:main" }];

async function showMainMenu(telegram_id: number, chat_id: number) {
  await setState(telegram_id, "menu", {});
  const active = await getActiveMessage(telegram_id);
  if (active && active.chat_id === chat_id) {
    silentDelete("shop", chat_id, active.message_id).catch(() => {});
  }
  const sent = await sendMessage(
    "shop",
    chat_id,
    `<b>Tienda Principal</b>\n\nUsá el menú inferior para navegar.`,
    { reply_markup: bottomKeyboard() },
  );
  if (sent.ok && sent.result) {
    await setActiveMessage(telegram_id, chat_id, sent.result.message_id);
  }
}

async function showSupport(telegram_id: number, chat_id: number) {
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Soporte</b>\n\nEscribinos por Telegram a <b>${SUPPORT_USERNAME}</b>.\nTe respondemos a la brevedad.`,
    [BACK_BUTTON],
  );
}

// Construye lista plana de botones de productos, agrupados por categoría
// sin botones-separador decorativos. Usa una línea de texto en el mensaje.
function buildProductButtons(grouped: Awaited<ReturnType<typeof getVisibleCatalog>>["grouped"]) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const section of grouped) {
    for (const p of section.products) {
      rows.push([
        { text: `${p.name}  ·  ${p.total_stock}`, callback_data: `prod:${p.id}` },
      ]);
    }
  }
  return rows;
}

function catalogSummary(grouped: Awaited<ReturnType<typeof getVisibleCatalog>>["grouped"]) {
  return grouped.map((s) => `<b>${s.category}</b>: ${s.products.map((p) => p.name).join(", ")}`).join("\n");
}

async function showBuyWithBalance(telegram_id: number, chat_id: number) {
  const { data: u } = await sb
    .from("bot_users")
    .select("balance")
    .eq("telegram_id", telegram_id)
    .single();
  const balance = Number(u?.balance ?? 0);
  if (balance <= 0) {
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      `<b>Comprar con saldo</b>\n\nNo tenés saldo disponible.\nSaldo actual: <b>$0.00 USD</b>\n\nRecargá desde el menú para empezar a comprar.`,
      [BACK_BUTTON],
    );
    return;
  }
  const { grouped } = await getVisibleCatalog();
  if (grouped.length === 0) {
    await renderScreen("shop", telegram_id, chat_id, `No hay productos disponibles.`, [BACK_BUTTON]);
    return;
  }
  await setState(telegram_id, "choose_product", {});
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Comprar con saldo</b>\n\nSaldo disponible: <b>$${balance.toFixed(2)} USD</b>\n\n${catalogSummary(grouped)}\n\nElegí un producto:`,
    [...buildProductButtons(grouped), BACK_BUTTON],
  );
}

async function showProfile(telegram_id: number, chat_id: number) {
  const { data: u } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .single();
  if (!u) return;
  const text =
    `<b>Mi Perfil</b>\n\n` +
    `Nombre   <b>${u.display_name ?? "—"}</b>\n` +
    `Usuario  @${u.username ?? "—"}\n` +
    `ID       <code>${u.telegram_id}</code>\n` +
    `Saldo    <b>$${Number(u.balance).toFixed(2)} USD</b>\n` +
    `Recargado $${Number(u.total_recharged).toFixed(2)} USD\n` +
    `Rango    ${RANK_LABEL[u.rank] ?? u.rank}\n` +
    `Registro ${new Date(u.registered_at).toLocaleDateString("es")}`;
  await renderScreen("shop", telegram_id, chat_id, text, [BACK_BUTTON]);
}

async function showProducts(telegram_id: number, chat_id: number) {
  const { grouped, hideOutOfStock } = await getVisibleCatalog();
  if (grouped.length === 0) {
    await renderScreen("shop", telegram_id, chat_id, `No hay productos disponibles.`, [BACK_BUTTON]);
    return;
  }
  await setState(telegram_id, "choose_product", {});
  const text =
    `<b>Productos</b>\n\n${catalogSummary(grouped)}\n\nElegí un producto:` +
    (hideOutOfStock ? `\n<i>Solo se muestran variantes con stock.</i>` : "");
  await renderScreen("shop", telegram_id, chat_id, text, [
    ...buildProductButtons(grouped),
    BACK_BUTTON,
  ]);
}

async function showDurations(telegram_id: number, chat_id: number, product_id: string) {
  const { grouped, stockByPriceId, hideOutOfStock } = await getVisibleCatalog();
  const product = grouped.flatMap((s) => s.products).find((p) => p.id === product_id);
  const prices = product?.prices ?? [];
  if (prices.length === 0) {
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      hideOutOfStock ? `No hay duraciones con stock disponible.` : `No hay precios cargados.`,
      [[{ text: "Volver", callback_data: "menu:products" }]],
    );
    return;
  }
  await patchContext(telegram_id, { product_id });
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>${product?.name}</b>\n\nElegí la duración:`,
    [
      ...prices.map((p) => [
        {
          text: `${p.duration_label}  ·  $${Number(p.price_usd).toFixed(2)}  ·  Stock ${stockByPriceId.get(p.id) ?? 0}`,
          callback_data: `dur:${p.id}`,
        },
      ]),
      [{ text: "Volver", callback_data: "menu:products" }],
    ],
  );
}

async function showQty(telegram_id: number, chat_id: number, price_id: string) {
  await patchContext(telegram_id, { price_id });
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Cantidad de keys</b>\n\n¿Cuántas necesitás?`,
    [
      [
        { text: "1", callback_data: "qty:1" },
        { text: "2", callback_data: "qty:2" },
        { text: "5", callback_data: "qty:5" },
      ],
      [{ text: "Volver", callback_data: "menu:products" }],
    ],
  );
}

async function showCountries(telegram_id: number, chat_id: number, qty: number) {
  await patchContext(telegram_id, { qty });
  const ctx = (await getState(telegram_id))?.context as Record<string, string | number>;
  const [{ data: price }, { count: availableCount }, { data: u }, { data: countries }] =
    await Promise.all([
      sb.from("product_prices").select("*").eq("id", ctx.price_id as string).single(),
      sb
        .from("product_stock_keys")
        .select("id", { count: "exact", head: true })
        .eq("product_id", ctx.product_id as string)
        .eq("price_id", ctx.price_id as string)
        .eq("used", false),
      sb.from("bot_users").select("balance").eq("telegram_id", telegram_id).single(),
      sb
        .from("payment_methods")
        .select("id, country_code, country_name, method_name")
        .eq("active", true)
        .order("sort_order"),
    ]);
  if (!price) return;
  const total_usd = Number(price.price_usd) * qty;
  const stockNote =
    (availableCount ?? 0) < qty
      ? `\n<i>Stock automático ${availableCount ?? 0}. Tu compra quedará en entrega manual por el admin.</i>`
      : "";
  const balance = Number(u?.balance ?? 0);

  const kb: Array<Array<{ text: string; callback_data: string }>> = [];
  if (balance >= total_usd) {
    kb.push([{ text: `Pagar con saldo  ·  $${total_usd.toFixed(2)}`, callback_data: "pay:balance" }]);
  }
  for (const c of countries ?? []) {
    kb.push([{ text: `${c.country_name}  ·  ${c.method_name}`, callback_data: `pm:${c.id}` }]);
  }
  kb.push([{ text: "Volver", callback_data: "menu:products" }]);
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Método de pago</b>\n\nTotal  <b>$${total_usd.toFixed(2)} USD</b>\nSaldo  $${balance.toFixed(2)}${stockNote}`,
    kb,
  );
}

async function showPaymentInstructions(
  telegram_id: number,
  chat_id: number,
  payment_method_id: string,
) {
  const ctx = (await getState(telegram_id))?.context as Record<string, string | number>;
  const [{ data: pm }, { data: price }] = await Promise.all([
    sb.from("payment_methods").select("*").eq("id", payment_method_id).single(),
    sb.from("product_prices").select("*, products(name)").eq("id", ctx.price_id as string).single(),
  ]);
  if (!pm || !price) return;
  const qty = Number(ctx.qty ?? 1);
  const total_usd = Number(price.price_usd) * qty;
  const total_local = total_usd * Number(pm.usd_rate);
  const { count: availableCount } = await sb
    .from("product_stock_keys")
    .select("id", { count: "exact", head: true })
    .eq("product_id", ctx.product_id as string)
    .eq("price_id", ctx.price_id as string)
    .eq("used", false);
  const manualNote =
    (availableCount ?? 0) < qty
      ? `\n<i>Sin stock automático. La key será entregada manualmente por el admin.</i>`
      : "";

  const { data: user } = await sb
    .from("bot_users")
    .select("id")
    .eq("telegram_id", telegram_id)
    .single();
  const { count: activeOrders } = await sb
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user!.id)
    .in("status", ["pending_receipt", "pending_approval"]);
  if ((activeOrders ?? 0) >= 3) {
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      `Ya tenés <b>3 órdenes activas</b>. Esperá que alguna sea aprobada para crear otra.`,
      [BACK_BUTTON],
    );
    return;
  }

  const { data: order, error } = await sb
    .from("orders")
    .insert({
      user_id: user!.id,
      telegram_id,
      product_id: ctx.product_id as string,
      price_id: ctx.price_id as string,
      payment_method_id: pm.id,
      keys_qty: qty,
      total_usd,
      total_local,
      currency: pm.currency,
      status: "pending_receipt",
    })
    .select()
    .single();
  if (error || !order) {
    console.error("Error creando orden:", error);
    return;
  }

  await setState(telegram_id, "awaiting_receipt", { order_id: order.id });

  const text =
    `<b>Instrucciones de pago</b>\n\n` +
    `Producto   <b>${(price as { products: { name: string } }).products.name}</b>\n` +
    `Duración   ${price.duration_label}\n` +
    `Cantidad   ${qty}\n` +
    `Total      <b>$${total_usd.toFixed(2)} USD</b>\n` +
    `Local      ${total_local.toFixed(2)} ${pm.currency} <i>(referencial)</i>\n\n` +
    `<b>${pm.country_name}  ·  ${pm.method_name}</b>\n` +
    `Titular  <code>${pm.holder_name}</code>\n` +
    `Cuenta   ${pm.account_info}\n` +
    `${pm.extra_info ? `Nota     ${pm.extra_info}\n` : ""}` +
    `${manualNote}\n` +
    `\nEnviá la foto del comprobante a este chat.\n` +
    `<i>Solo fotos. Imágenes duplicadas serán rechazadas.</i>`;
  await renderScreen("shop", telegram_id, chat_id, text, [
    [{ text: "Cancelar", callback_data: "menu:main" }],
  ]);
}

// ===== Recarga =====
async function startRecharge(telegram_id: number, chat_id: number) {
  await setState(telegram_id, "recharge_country", {});
  const { data: countries } = await sb
    .from("payment_methods")
    .select("id, country_name, method_name")
    .eq("active", true)
    .order("sort_order");
  if (!countries || countries.length === 0) {
    await renderScreen("shop", telegram_id, chat_id, `No hay métodos de pago disponibles.`, [BACK_BUTTON]);
    return;
  }
  const kb: Array<Array<{ text: string; callback_data: string }>> = countries.map((c) => [
    { text: `${c.country_name}  ·  ${c.method_name}`, callback_data: `rc:${c.id}` },
  ]);
  kb.push(BACK_BUTTON);
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Recargar saldo</b>\n\nElegí tu país y método de pago:`,
    kb,
  );
}

async function showRechargeInstructions(
  telegram_id: number,
  chat_id: number,
  payment_method_id: string,
) {
  const { data: pm } = await sb
    .from("payment_methods")
    .select("*")
    .eq("id", payment_method_id)
    .single();
  if (!pm) return;
  const { data: user } = await sb
    .from("bot_users")
    .select("id")
    .eq("telegram_id", telegram_id)
    .single();
  if (!user) return;

  const { count: activeOrders } = await sb
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .in("status", ["pending_receipt", "pending_approval"]);
  if ((activeOrders ?? 0) >= 3) {
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      `Ya tenés <b>3 solicitudes activas</b>. Esperá a que se aprueben antes de crear otra.`,
      [BACK_BUTTON],
    );
    return;
  }

  const { data: order, error } = await sb
    .from("orders")
    .insert({
      user_id: user.id,
      telegram_id,
      order_type: "recharge",
      payment_method_id: pm.id,
      keys_qty: 0,
      total_usd: 0,
      currency: pm.currency,
      status: "pending_receipt",
    })
    .select()
    .single();
  if (error || !order) {
    console.error("Error creando recarga:", error);
    return;
  }

  await setState(telegram_id, "awaiting_recharge_receipt", { order_id: order.id });

  const rate = Number(pm.usd_rate);
  const conv =
    rate === 1
      ? `Pago en <b>${pm.currency}</b> (mismo valor que USD).`
      : `Tipo de cambio referencial  <b>1 USD ≈ ${rate.toFixed(2)} ${pm.currency}</b>\n` +
        `Ejemplos  $5 ≈ ${(5 * rate).toFixed(2)}  ·  $20 ≈ ${(20 * rate).toFixed(2)}  ·  $30 ≈ ${(30 * rate).toFixed(2)} ${pm.currency}`;

  const text =
    `<b>Recarga de saldo</b>\n\n` +
    `<b>${pm.country_name}  ·  ${pm.method_name}</b>\n` +
    `Titular  <code>${pm.holder_name}</code>\n` +
    `Cuenta   ${pm.account_info}\n` +
    `${pm.extra_info ? `Nota     ${pm.extra_info}\n` : ""}` +
    `\n${conv}\n` +
    `\n1. Realizá el pago por el monto exacto en USD que quieras recargar.\n` +
    `2. Enviá la foto del comprobante a este chat.\n\n` +
    `<i>Solo fotos. Imágenes duplicadas serán rechazadas.</i>`;
  await renderScreen("shop", telegram_id, chat_id, text, [
    [{ text: "Cancelar", callback_data: "menu:main" }],
  ]);
}

// Enrutado del menú inferior fijo. Devuelve true si manejó el texto.
async function routeBottomMenu(
  text: string,
  telegram_id: number,
  chat_id: number,
  message_id: number,
): Promise<boolean> {
  const map: Record<string, (tid: number, cid: number) => Promise<void>> = {
    [BOTTOM_MENU.products]: showProducts,
    [BOTTOM_MENU.buy]: showBuyWithBalance,
    [BOTTOM_MENU.status]: showOrderStatus,
    [BOTTOM_MENU.profile]: showProfile,
    [BOTTOM_MENU.keys]: showMyKeys,
    [BOTTOM_MENU.recharge]: startRecharge,
    [BOTTOM_MENU.support]: showSupport,
  };
  const action = map[text];
  if (!action) return false;
  // borrar y procesar en paralelo
  silentDelete("shop", chat_id, message_id).catch(() => {});
  await action(telegram_id, chat_id);
  return true;
}

// ===== Pago con saldo (entrega automática si hay stock) =====
async function payWithBalance(telegram_id: number, chat_id: number) {
  const ctx = (await getState(telegram_id))?.context as Record<string, string | number>;
  const { data: price } = await sb
    .from("product_prices")
    .select("*, products(name)")
    .eq("id", ctx.price_id as string)
    .single();
  if (!price) return;
  const qty = Number(ctx.qty ?? 1);
  const total_usd = Number(price.price_usd) * qty;

  const { data: user } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .single();
  if (!user || Number(user.balance) < total_usd) {
    await renderScreen("shop", telegram_id, chat_id, `Saldo insuficiente.`, [BACK_BUTTON]);
    return;
  }

  const { data: avail } = await sb
    .from("product_stock_keys")
    .select("*")
    .eq("product_id", ctx.product_id as string)
    .eq("price_id", ctx.price_id as string)
    .eq("used", false)
    .limit(qty);

  const hasStock = (avail?.length ?? 0) >= qty;

  const { data: order } = await sb
    .from("orders")
    .insert({
      user_id: user.id,
      telegram_id,
      product_id: ctx.product_id as string,
      price_id: ctx.price_id as string,
      keys_qty: qty,
      total_usd,
      status: hasStock ? "delivered" : "pending_approval",
      paid_with_balance: true,
    })
    .select()
    .single();
  if (!order) return;

  await sb
    .from("bot_users")
    .update({ balance: Number(user.balance) - total_usd })
    .eq("id", user.id);

  if (hasStock && avail) {
    await Promise.all([
      sb
        .from("product_stock_keys")
        .update({
          used: true,
          used_at: new Date().toISOString(),
          used_by_user_id: user.id,
          used_by_order_id: order.id,
        })
        .in("id", avail.map((k) => k.id)),
      sb.from("order_keys").insert(
        avail.map((k) => ({
          order_id: order.id,
          user_id: user.id,
          key_value: k.key_value,
        })),
      ),
    ]);
    invalidateCatalogCache();

    const keysText = avail.map((k) => `<code>${k.key_value}</code>`).join("\n");
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      `<b>Compra completada</b>\n\nProducto  ${(price as { products: { name: string } }).products.name}\nDuración  ${price.duration_label}\nCantidad  ${qty}\n\n<b>Tus keys</b>\n${keysText}`,
      [[{ text: "Menú", callback_data: "menu:main" }]],
    );
    return;
  }

  // Sin stock → entrega manual: notificar al admin
  const adminChat = getAdminChatId();
  if (adminChat) {
    await sendMessage(
      "admin",
      adminChat,
      `<b>Entrega manual pendiente</b>\n\n` +
        `Producto  ${(price as { products: { name: string } }).products.name}\n` +
        `Duración  ${price.duration_label}\n` +
        `Cantidad  ${qty}\n` +
        `Cobrado   <b>$${total_usd.toFixed(2)} USD</b>\n` +
        `Usuario   <code>${telegram_id}</code>\n` +
        `Orden     <code>${order.id}</code>\n\n` +
        `Respondé con las ${qty} keys (una por línea) para entregarlas.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "Ver pendientes", callback_data: "akp:pend" }]],
        },
      },
    );
  }

  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Pago con saldo recibido</b>\n\n` +
      `Producto  ${(price as { products: { name: string } }).products.name}\n` +
      `Duración  ${price.duration_label}\n` +
      `Cantidad  ${qty}\n\n` +
      `Sin stock automático. El admin entregará la key en breve.`,
    [[{ text: "Menú", callback_data: "menu:main" }]],
  );
}

// ===== Comprobante (foto) =====
async function handleReceiptPhoto(msg: TgMessage) {
  const telegram_id = msg.from!.id;
  const chat_id = msg.chat.id;

  silentDelete("shop", chat_id, msg.message_id).catch(() => {});

  if (!msg.photo || msg.photo.length === 0) return;

  const photo = msg.photo[msg.photo.length - 1];
  if (!photo.file_id || !photo.file_unique_id) {
    await sendMessage("shop", chat_id, `Comprobante inválido.`);
    return;
  }
  if (photo.width < 200 || photo.height < 200) {
    await sendMessage("shop", chat_id, `Imagen demasiado pequeña. Enviá el comprobante completo.`);
    return;
  }

  // Anti duplicado 24h
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: dup } = await sb
    .from("receipt_fingerprints")
    .select("*")
    .eq("file_unique_id", photo.file_unique_id)
    .gte("created_at", cutoff)
    .maybeSingle();
  if (dup) {
    await sendMessage(
      "shop",
      chat_id,
      `Este comprobante ya fue enviado antes. Bloqueado por 24h.`,
    );
    return;
  }

  const st = await getState(telegram_id);
  const validReceiptStates = ["awaiting_receipt", "awaiting_recharge_receipt"];
  if (!st || !validReceiptStates.includes(st.state) || !st.context?.order_id) {
    await sendMessage(
      "shop",
      chat_id,
      `No tenés una orden pendiente. Iniciá una compra o recarga primero.`,
    );
    return;
  }
  const isRecharge = st.state === "awaiting_recharge_receipt";
  const order_id = st.context.order_id as string;

  const { data: user } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .single();
  if (!user) return;

  await sb.from("receipt_fingerprints").insert({
    file_unique_id: photo.file_unique_id,
    file_id: photo.file_id,
    telegram_id,
  });

  const { data: receipt } = await sb
    .from("receipts")
    .insert({
      user_id: user.id,
      telegram_id,
      order_id,
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
      width: photo.width,
      height: photo.height,
      file_size: photo.file_size ?? null,
      status: "pending",
    })
    .select()
    .single();

  await sb
    .from("orders")
    .update({ status: "pending_approval", receipt_id: receipt?.id })
    .eq("id", order_id);

  const fileInfo = await getFile("shop", photo.file_id);
  if (!fileInfo.ok || !fileInfo.result) {
    await sendMessage("shop", chat_id, `Error procesando imagen. Intentá de nuevo.`);
    return;
  }
  const bytes = await downloadFile("shop", fileInfo.result.file_path);
  if (!bytes) {
    await sendMessage("shop", chat_id, `Error descargando imagen.`);
    return;
  }

  const { data: order } = await sb
    .from("orders")
    .select("*, products(name), product_prices(duration_label), payment_methods(country_name, method_name)")
    .eq("id", order_id)
    .single();

  const o = order as {
    id: string;
    total_usd: number;
    total_local: number | null;
    currency: string | null;
    keys_qty: number;
    products: { name: string } | null;
    product_prices: { duration_label: string } | null;
    payment_methods: { country_name: string; method_name: string } | null;
  };

  let caption: string;
  if (isRecharge) {
    caption =
      `<b>Nueva recarga</b>\n\n` +
      `Usuario  ${user.display_name ?? "—"} (@${user.username ?? "—"})\n` +
      `ID       <code>${telegram_id}</code>\n` +
      `Método   ${o.payment_methods?.country_name ?? "—"} ${o.payment_methods?.method_name ?? ""}\n` +
      `Orden    <code>${o.id}</code>\n\n` +
      `Respondé con el monto en USD a acreditar (ej: 10).`;
  } else {
    caption =
      `<b>Nuevo comprobante</b>\n\n` +
      `Usuario   ${user.display_name ?? "—"} (@${user.username ?? "—"})\n` +
      `ID        <code>${telegram_id}</code>\n` +
      `Producto  ${o.products?.name ?? "—"}\n` +
      `Duración  ${o.product_prices?.duration_label ?? "—"}\n` +
      `Cantidad  ${o.keys_qty}\n` +
      `Total     $${Number(o.total_usd).toFixed(2)} USD` +
      (o.total_local ? ` (${Number(o.total_local).toFixed(2)} ${o.currency})` : "") +
      `\nMétodo    ${o.payment_methods?.country_name ?? "—"} ${o.payment_methods?.method_name ?? ""}\n` +
      `Orden     <code>${o.id}</code>`;
  }

  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    await sendMessage("shop", chat_id, `Admin no configurado. Avisá a soporte.`);
    return;
  }

  const sent = await sendPhotoMultipart(
    "admin",
    adminChatId,
    bytes,
    "comprobante.jpg",
    caption,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Aprobar", callback_data: `adm:approve:${order_id}` },
            { text: "Rechazar", callback_data: `adm:reject:${order_id}` },
          ],
          [
            { text: "Enviar key manual", callback_data: `adm:sendkey:${order_id}` },
            { text: "Bloquear", callback_data: `adm:block:${telegram_id}` },
          ],
        ],
      },
    },
  );

  if (sent.ok && sent.result) {
    await Promise.all([
      sb.from("receipts").update({ admin_message_id: sent.result.message_id }).eq("id", receipt!.id),
      sb.from("orders").update({ admin_message_id: sent.result.message_id }).eq("id", order_id),
    ]);
  }

  await setState(telegram_id, "menu", {});
  if (isRecharge) {
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      `<b>Comprobante en revisión</b>\n\nSi lo subís varias veces, tu recarga será rechazada sin lugar a reclamo.\n\nSé paciente y esperá.`,
      [[{ text: "Menú", callback_data: "menu:main" }]],
    );
  } else {
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      `<b>Comprobante recibido</b>\n\nTu pago está siendo verificado. Te avisamos cuando se acredite el saldo o la key.`,
      [[{ text: "Menú", callback_data: "menu:main" }]],
    );
  }
}

// ===== Login =====
async function askName(telegram_id: number, chat_id: number) {
  await setState(telegram_id, "login_name", {});
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Bienvenido</b>\n\n¿Cuál es tu nombre?`,
  );
}

async function askPassword(telegram_id: number, chat_id: number, name: string) {
  await setState(telegram_id, "login_password", { display_name: name });
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `Hola <b>${name}</b>.\n\nIngresá la contraseña de acceso:`,
  );
}

// ===== Handler principal =====
export async function handleShopUpdate(update: Update): Promise<void> {
  if (update.message) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
}

async function handleMessage(msg: TgMessage) {
  if (!msg.from) return;
  const telegram_id = msg.from.id;
  const chat_id = msg.chat.id;

  if (await isBlocked(telegram_id)) return;
  if (!(await checkRateLimit(telegram_id, "msg", 20, 10))) return;

  await getOrCreateUser({
    telegram_id,
    chat_id,
    username: msg.from.username,
  });

  if (msg.photo && msg.photo.length > 0) {
    await handleReceiptPhoto(msg);
    return;
  }

  if (msg.document) {
    silentDelete("shop", chat_id, msg.message_id).catch(() => {});
    await sendMessage("shop", chat_id, `Solo aceptamos fotos como comprobante, no documentos.`);
    return;
  }

  const text = (msg.text ?? "").trim();

  if (text === "/start") {
    if (!(await tryAcquireStartLock(telegram_id))) return;
    const { data: u } = await sb
      .from("bot_users")
      .select("*")
      .eq("telegram_id", telegram_id)
      .single();
    if (u?.is_authenticated) {
      await showMainMenu(telegram_id, chat_id);
    } else {
      await askName(telegram_id, chat_id);
    }
    return;
  }

  const { data: authUser } = await sb
    .from("bot_users")
    .select("is_authenticated")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  if (
    authUser?.is_authenticated &&
    (await routeBottomMenu(text, telegram_id, chat_id, msg.message_id))
  ) {
    return;
  }

  const st = await getState(telegram_id);
  silentDelete("shop", chat_id, msg.message_id).catch(() => {});

  if (st?.state === "login_name") {
    if (text.length < 2 || text.length > 40) {
      await renderScreen("shop", telegram_id, chat_id, `Nombre inválido. Ingresá entre 2 y 40 caracteres.`);
      return;
    }
    await askPassword(telegram_id, chat_id, text);
    return;
  }
  if (st?.state === "login_password") {
    if (text !== ACCESS_PASSWORD) {
      await renderScreen("shop", telegram_id, chat_id, `Contraseña incorrecta. Intentá de nuevo:`);
      return;
    }
    const name = (st.context?.display_name as string) ?? "Usuario";
    await updateUser(telegram_id, {
      is_authenticated: true,
      display_name: name,
    });
    await showMainMenu(telegram_id, chat_id);
    return;
  }

  await showMainMenu(telegram_id, chat_id);
}

async function handleCallback(cb: TgCallback) {
  const telegram_id = cb.from.id;
  const chat_id = cb.message?.chat.id ?? telegram_id;
  if (await isBlocked(telegram_id)) {
    await answerCallbackQuery("shop", cb.id);
    return;
  }
  if (!(await checkRateLimit(telegram_id, "cb", 30, 10))) {
    await answerCallbackQuery("shop", cb.id);
    return;
  }
  // No esperamos al ACK del callback para responder más rápido
  answerCallbackQuery("shop", cb.id).catch(() => {});
  const data = cb.data ?? "";

  if (data === "menu:main") return showMainMenu(telegram_id, chat_id);
  if (data === "noop") return;
  if (data === "menu:profile") return showProfile(telegram_id, chat_id);
  if (data === "menu:products") return showProducts(telegram_id, chat_id);
  if (data === "menu:status") return showOrderStatus(telegram_id, chat_id);
  if (data === "menu:keys") return showMyKeys(telegram_id, chat_id);
  if (data === "menu:buy") return showBuyWithBalance(telegram_id, chat_id);
  if (data === "menu:recharge") return startRecharge(telegram_id, chat_id);
  if (data === "menu:support") return showSupport(telegram_id, chat_id);

  if (data.startsWith("prod:")) return showDurations(telegram_id, chat_id, data.slice(5));
  if (data.startsWith("dur:")) return showQty(telegram_id, chat_id, data.slice(4));
  if (data.startsWith("qty:")) return showCountries(telegram_id, chat_id, parseInt(data.slice(4), 10));
  if (data === "pay:balance") return payWithBalance(telegram_id, chat_id);
  if (data.startsWith("pm:")) return showPaymentInstructions(telegram_id, chat_id, data.slice(3));
  if (data.startsWith("rc:")) return showRechargeInstructions(telegram_id, chat_id, data.slice(3));
}

async function showOrderStatus(telegram_id: number, chat_id: number) {
  const { data: orders } = await sb
    .from("orders")
    .select("id, status, total_usd, created_at, products(name)")
    .eq("telegram_id", telegram_id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (!orders || orders.length === 0) {
    return renderScreen("shop", telegram_id, chat_id, `No tenés órdenes.`, [BACK_BUTTON]);
  }
  const lines = orders
    .map((o) => {
      const p = (o as { products: { name: string } }).products;
      const mark =
        o.status === "delivered"
          ? "[OK]"
          : o.status === "pending_approval"
            ? "[…]"
            : o.status === "rejected"
              ? "[X]"
              : "[·]";
      return `${mark}  ${p?.name ?? "—"}  ·  $${Number(o.total_usd).toFixed(2)}  ·  <i>${o.status}</i>`;
    })
    .join("\n");
  return renderScreen("shop", telegram_id, chat_id, `<b>Mis órdenes</b>\n\n${lines}`, [BACK_BUTTON]);
}

async function showMyKeys(telegram_id: number, chat_id: number) {
  const { data: user } = await sb.from("bot_users").select("id").eq("telegram_id", telegram_id).single();
  if (!user) return;
  const { data: keys } = await sb
    .from("order_keys")
    .select("key_value, delivered_at")
    .eq("user_id", user.id)
    .order("delivered_at", { ascending: false })
    .limit(20);
  if (!keys || keys.length === 0) {
    return renderScreen("shop", telegram_id, chat_id, `No tenés keys aún.`, [BACK_BUTTON]);
  }
  const text = keys.map((k) => `<code>${k.key_value}</code>`).join("\n");
  return renderScreen("shop", telegram_id, chat_id, `<b>Mis keys (últimas ${keys.length})</b>\n\n${text}`, [
    BACK_BUTTON,
  ]);
}

/** Llamado desde el admin bot tras aprobar el pago. */
export async function notifyUserApproved(opts: {
  telegram_id: number;
  chat_id: number;
  amount_usd: number;
  new_balance: number;
}) {
  await sendMessage(
    "shop",
    opts.chat_id,
    `<b>Pago aprobado</b>\n\nAcreditados <b>$${opts.amount_usd.toFixed(2)} USD</b> a tu saldo.\nSaldo actual <b>$${opts.new_balance.toFixed(2)} USD</b>\n\nUsá /start para volver al menú.`,
  );
}

export async function notifyUserRejected(opts: {
  telegram_id: number;
  chat_id: number;
  note?: string;
}) {
  await sendMessage(
    "shop",
    opts.chat_id,
    `<b>Pago rechazado</b>\n\n${opts.note ?? "Tu comprobante no fue aceptado."}\n\nPodés intentar nuevamente con /start.`,
  );
}

export async function notifyUserKey(opts: {
  chat_id: number;
  key_value: string;
}) {
  await sendMessage(
    "shop",
    opts.chat_id,
    `<b>Key entregada</b>\n\n<code>${opts.key_value}</code>`,
  );
}
