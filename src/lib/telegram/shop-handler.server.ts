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
  autoBlock,
  getActiveMessage,
  setActiveMessage,
  sb,
} from "./db.server";
import { renderScreen, silentDelete } from "./ui.server";
import { getVisibleCatalog, invalidateCatalogCache } from "./catalog.server";

const MIN_RECHARGE_USD = 5;
function tpId(createdAt: string | Date) {
  const t = typeof createdAt === "string" ? new Date(createdAt).getTime() : createdAt.getTime();
  return `TP${t}`;
}

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

function categoryButtons(grouped: Awaited<ReturnType<typeof getVisibleCatalog>>["grouped"]) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const section of grouped) {
    rows.push([{ text: section.category, callback_data: `cat:${section.category}` }]);
  }
  return rows;
}

async function showBuyWithBalance(telegram_id: number, chat_id: number) {
  await showProducts(telegram_id, chat_id);
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
  const { grouped } = await getVisibleCatalog();
  if (grouped.length === 0) {
    await renderScreen("shop", telegram_id, chat_id, `No hay productos disponibles.`, [BACK_BUTTON]);
    return;
  }
  await setState(telegram_id, "choose_category", {});
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Productos</b>\n\nElegí una categoría:`,
    [...categoryButtons(grouped), BACK_BUTTON],
  );
}

async function showCategory(telegram_id: number, chat_id: number, category: string) {
  const { grouped } = await getVisibleCatalog();
  const section = grouped.find((s) => s.category === category);
  if (!section || section.products.length === 0) {
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      `No hay productos disponibles en ${category}.`,
      [[{ text: "Volver", callback_data: "menu:products" }]],
    );
    return;
  }
  await setState(telegram_id, "choose_product", { category });
  const rows = section.products.map((p) => [
    { text: p.name, callback_data: `prod:${p.id}` },
  ]);
  rows.push([{ text: "Volver", callback_data: "menu:products" }]);
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>${category}</b>\n\nElegí un producto:`,
    rows,
  );
}

async function showDurations(telegram_id: number, chat_id: number, product_id: string) {
  const [{ data: u }, catalog] = await Promise.all([
    sb.from("bot_users").select("balance").eq("telegram_id", telegram_id).single(),
    getVisibleCatalog(),
  ]);
  const balance = Number(u?.balance ?? 0);
  const product = catalog.grouped.flatMap((s) => s.products).find((p) => p.id === product_id);
  if (!product) {
    await renderScreen("shop", telegram_id, chat_id, `Producto no disponible.`, [
      [{ text: "Volver", callback_data: "menu:products" }],
    ]);
    return;
  }
  const prices = product.prices ?? [];
  if (prices.length === 0) {
    await renderScreen("shop", telegram_id, chat_id, `Sin duraciones disponibles.`, [
      [{ text: "Volver", callback_data: "menu:products" }],
    ]);
    return;
  }
  if (balance <= 0) {
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      `<b>Saldo insuficiente</b>\n\nNo tenés saldo para comprar.\nSaldo actual: <b>$0.00 USD</b>\n\nUsá <b>Recargar</b> para agregar saldo.`,
      [[{ text: "Recargar", callback_data: "menu:recharge" }], BACK_BUTTON],
    );
    return;
  }
  const minPrice = Math.min(...prices.map((p) => Number(p.price_usd)));
  if (balance < minPrice) {
    await renderScreen(
      "shop",
      telegram_id,
      chat_id,
      `<b>Saldo insuficiente</b>\n\nSaldo actual: <b>$${balance.toFixed(2)} USD</b>\nMínimo requerido: <b>$${minPrice.toFixed(2)} USD</b>\n\nUsá <b>Recargar</b> para agregar saldo.`,
      [[{ text: "Recargar", callback_data: "menu:recharge" }], BACK_BUTTON],
    );
    return;
  }
  await patchContext(telegram_id, { product_id });
  const rows = prices.map((p) => {
    const affordable = balance >= Number(p.price_usd);
    return [
      {
        text: `${p.duration_label}  ·  $${Number(p.price_usd).toFixed(2)}${affordable ? "" : "  ·  sin saldo"}`,
        callback_data: affordable ? `dur:${p.id}` : "noop",
      },
    ];
  });
  rows.push([{ text: "Volver", callback_data: `cat:${product.category}` }]);
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>${product.name}</b>\n\nSaldo disponible: <b>$${balance.toFixed(2)} USD</b>\n\nElegí la duración:`,
    rows,
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

// ===== Recarga: país → monto → método → instrucciones =====
async function startRecharge(telegram_id: number, chat_id: number) {
  await setState(telegram_id, "recharge_country", {});
  const { data: methods } = await sb
    .from("payment_methods")
    .select("country_code, country_name")
    .eq("active", true)
    .order("country_name");
  const seen = new Set<string>();
  const countries: Array<{ country_code: string; country_name: string }> = [];
  for (const m of methods ?? []) {
    if (!seen.has(m.country_code)) {
      seen.add(m.country_code);
      countries.push(m);
    }
  }
  if (countries.length === 0) {
    await renderScreen("shop", telegram_id, chat_id, `No hay métodos de pago disponibles.`, [BACK_BUTTON]);
    return;
  }
  const kb: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < countries.length; i += 2) {
    const row = [{ text: countries[i].country_name, callback_data: `rcc:${countries[i].country_code}` }];
    if (countries[i + 1]) row.push({ text: countries[i + 1].country_name, callback_data: `rcc:${countries[i + 1].country_code}` });
    kb.push(row);
  }
  kb.push(BACK_BUTTON);
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Recargar Saldo</b>\n\nElegí tu país:`,
    kb,
  );
}

async function askRechargeAmount(telegram_id: number, chat_id: number, country_code: string) {
  const { data: pmRow } = await sb
    .from("payment_methods")
    .select("country_name")
    .eq("country_code", country_code)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (!pmRow) {
    await renderScreen("shop", telegram_id, chat_id, `País no disponible.`, [BACK_BUTTON]);
    return;
  }
  await setState(telegram_id, "recharge_amount", { country_code });
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Recargar Saldo Desde ${pmRow.country_name}</b>\n\n` +
      `Recarga Mínima: <b>${MIN_RECHARGE_USD.toFixed(2)} USD</b>\n\n` +
      `¿Cuánto deseas recargar?\n\n` +
      `Ejemplo:\n<code>10</code>\n\n` +
      `Escribí el monto en USD.`,
    [[{ text: "Volver", callback_data: "menu:recharge" }]],
  );
}

async function showRechargeMethods(
  telegram_id: number,
  chat_id: number,
  country_code: string,
  amount: number,
) {
  const { data: methods } = await sb
    .from("payment_methods")
    .select("*")
    .eq("country_code", country_code)
    .eq("active", true)
    .order("sort_order");
  if (!methods || methods.length === 0) {
    await renderScreen("shop", telegram_id, chat_id, `No hay métodos disponibles para este país.`, [BACK_BUTTON]);
    return;
  }
  const { data: user } = await sb.from("bot_users").select("id").eq("telegram_id", telegram_id).single();
  if (!user) return;

  // Crear orden de recarga única
  const { data: order, error } = await sb
    .from("orders")
    .insert({
      user_id: user.id,
      telegram_id,
      order_type: "recharge",
      payment_method_id: methods[0].id,
      keys_qty: 0,
      total_usd: amount,
      currency: methods[0].currency,
      status: "pending_receipt",
    })
    .select()
    .single();
  if (error || !order) {
    console.error("Error creando recarga:", error);
    return;
  }

  await setState(telegram_id, "recharge_ready", { order_id: order.id, country_code, amount });

  const pid = tpId(order.created_at);
  const lines: string[] = [
    `<b>Métodos De Pago - ${methods[0].country_name}</b>`,
    ``,
    `ID De Recarga: <code>${pid}</code>`,
    `Monto: <b>${amount.toFixed(2)} USD</b>`,
    `Total A Pagar: <b>${amount.toFixed(2)} USD</b>`,
    ``,
  ];
  for (const m of methods) {
    const local = amount * Number(m.usd_rate);
    lines.push(`<b>Método De Pago</b>`);
    lines.push(`Nombre: <b>${m.method_name}</b>`);
    lines.push(`Titular: <code>${m.holder_name}</code>`);
    lines.push(`Cuenta: <code>${m.account_info}</code>`);
    if (m.extra_info) lines.push(`Nota: ${m.extra_info}`);
    if (Number(m.usd_rate) !== 1) {
      lines.push(`Total: <b>${local.toFixed(2)} ${m.currency}</b>`);
    } else {
      lines.push(`Total: <b>${amount.toFixed(2)} ${m.currency}</b>`);
    }
    lines.push(``);
  }

  await renderScreen("shop", telegram_id, chat_id, lines.join("\n"), [
    [{ text: "Ya Pagué", callback_data: `rcpay:${order.id}` }],
    [{ text: "Menú Principal", callback_data: "menu:main" }],
  ]);
}

async function startRechargeReceipt(telegram_id: number, chat_id: number, order_id: string) {
  await setState(telegram_id, "awaiting_recharge_receipt", { order_id });
  await renderScreen(
    "shop",
    telegram_id,
    chat_id,
    `<b>Envía tu comprobante de pago</b>\n\nAceptamos imágenes, capturas o documentos.`,
    [[{ text: "Cancelar", callback_data: "menu:main" }]],
  );
}


// Enrutado del menú inferior fijo. Devuelve true si manejó el texto.
async function routeBottomMenu(
  text: string,
  telegram_id: number,
  chat_id: number,
  message_id: number,
): Promise<boolean> {
  const map: Record<string, (tid: number, cid: number) => Promise<unknown>> = {
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

  // Sin stock → entrega manual: notificar al admin con botón "Enviar Key"
  const adminChat = getAdminChatId();
  if (adminChat) {
    const sentAdmin = await sendMessage(
      "admin",
      adminChat,
      `<b>Nueva compra · entrega manual</b>\n\n` +
        `Producto  ${(price as { products: { name: string } }).products.name}\n` +
        `Duración  ${price.duration_label}\n` +
        `Cantidad  ${qty}\n` +
        `Cobrado   <b>$${total_usd.toFixed(2)} USD</b>\n` +
        `Usuario   <code>${telegram_id}</code>\n` +
        `Orden     <code>${order.id.slice(0, 8)}</code>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Enviar Key", callback_data: `adm:sendkey:${order.id}` }],
          ],
        },
      },
    );
    if (sentAdmin.ok && sentAdmin.result) {
      await sb
        .from("orders")
        .update({ admin_message_id: sentAdmin.result.message_id })
        .eq("id", order.id);
    }
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

  if (data.startsWith("cat:")) return showCategory(telegram_id, chat_id, data.slice(4));
  if (data.startsWith("prod:")) return showDurations(telegram_id, chat_id, data.slice(5));
  if (data.startsWith("dur:")) {
    await patchContext(telegram_id, { price_id: data.slice(4), qty: 1 });
    return payWithBalance(telegram_id, chat_id);
  }
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
  telegram_id: number;
  chat_id: number;
  key_value: string;
  product_name?: string;
  duration_label?: string;
}) {
  // Borrar el mensaje activo previo para que no se amontone
  const active = await getActiveMessage(opts.telegram_id);
  if (active && active.chat_id === opts.chat_id) {
    silentDelete("shop", opts.chat_id, active.message_id).catch(() => {});
  }
  const header = opts.product_name
    ? `<b>Key entregada</b>\n\n${opts.product_name}${opts.duration_label ? `  ·  ${opts.duration_label}` : ""}\n\n`
    : `<b>Key entregada</b>\n\n`;
  const sent = await sendMessage(
    "shop",
    opts.chat_id,
    `${header}<code>${opts.key_value}</code>`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: "Menú", callback_data: "menu:main" }]],
      },
    },
  );
  if (sent.ok && sent.result) {
    await setActiveMessage(opts.telegram_id, opts.chat_id, sent.result.message_id);
  }
}
