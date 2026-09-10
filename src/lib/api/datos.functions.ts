import { createServerFn } from "@tanstack/react-start";

/** Usuario de prueba: su saldo y movimientos no se contabilizan. */
export const EXCLUDED_TELEGRAM_IDS = ["8844591762"];

export type DatosPayload = {
  generatedAt: string;
  excluded: string[];
  users: {
    total: number;
    new24h: number;
    new7d: number;
    new30d: number;
    withBalance: number;
    blocked: number;
    balanceTotal: number;
    rechargedTotal: number;
    activeToday: number;
    active7d: number;
    buyers: number;
    repeatBuyers: number;
    byRank: { label: string; count: number }[];
    byLang: { label: string; count: number }[];
  };
  sales: {
    orders: number;
    delivered: number;
    pending: number;
    cancelled: number;
    ordersToday: number;
    orders7d: number;
    orders30d: number;
    revenueTotal: number;
    revenueToday: number;
    revenueYesterday: number;
    revenue7d: number;
    revenuePrev7d: number;
    revenue30d: number;
    keysDelivered: number;
    keysToday: number;
    avgTicket: number;
    avgPerDay30d: number;
    bestDay: { date: string; total: number };
    growth7d: number;
  };
  receipts: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    today: number;
    approvalRate: number;
  };
  catalog: {
    products: number;
    activeProducts: number;
    prices: number;
    stockKeys: number;
    paymentMethods: number;
    outOfStock: number;
  };
  daily: { date: string; total: number; orders: number }[];
  hourly: { hour: number; orders: number; total: number }[];
  weekday: { label: string; orders: number; total: number }[];
  topProducts: { name: string; orders: number; total: number; keys: number }[];
  topUsers: { name: string; telegramId: string; total: number; orders: number }[];
  topCountries: { country: string; methods: number }[];
  recentOrders: {
    id: string;
    telegramId: string;
    product: string;
    duration: string;
    total: number;
    status: string;
    qty: number;
    createdAt: string;
  }[];
  recentUsers: {
    telegramId: string;
    name: string;
    balance: number;
    recharged: number;
    createdAt: string;
  }[];
  movements: {
    id: string;
    kind: "Compra" | "Comprobante" | "Registro";
    title: string;
    detail: string;
    amount: string;
    createdAt: string;
  }[];
  stockByProduct: { name: string; duration: string; keys: number }[];
  lowStock: { name: string; duration: string; keys: number }[];
  paymentMethods: { country: string; method: string; currency: string; active: boolean }[];
};

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const dayKey = (iso: string) => iso.slice(0, 10);
const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

export const getDatos = createServerFn({ method: "GET" }).handler(async (): Promise<DatosPayload> => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as never as { from: (t: string) => any };

  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const d1 = iso(new Date(now.getTime() - 864e5));
  const d7 = iso(new Date(now.getTime() - 7 * 864e5));
  const d14 = iso(new Date(now.getTime() - 14 * 864e5));
  const d30 = iso(new Date(now.getTime() - 30 * 864e5));
  const todayKey = dayKey(iso(now));
  const yesterdayKey = dayKey(iso(new Date(now.getTime() - 864e5)));

  const [usersRes, ordersRes, receiptsRes, productsRes, pricesRes, stockRes, methodsRes, blockedRes] =
    await Promise.all([
      db
        .from("bot_users")
        .select(
          "telegram_id, display_name, username, balance, total_recharged, created_at, last_seen_at, rank, lang",
        )
        .order("created_at", { ascending: false })
        .limit(5000),
      db
        .from("orders")
        .select("id, telegram_id, product_id, price_id, keys_qty, total_usd, status, created_at, order_type")
        .order("created_at", { ascending: false })
        .limit(5000),
      db
        .from("receipts")
        .select("id, telegram_id, status, created_at")
        .order("created_at", { ascending: false })
        .limit(5000),
      db.from("products").select("id, name, active").limit(1000),
      db.from("product_prices").select("id, product_id, duration_label, price_usd, active").limit(2000),
      db.from("product_stock_keys").select("product_id, price_id").limit(20000),
      db.from("payment_methods").select("id, active, country_name, method_name, currency").limit(500),
      db.from("blocked_users").select("telegram_id").limit(5000),
    ]);

  const skip = new Set(EXCLUDED_TELEGRAM_IDS);
  const usersRows: any[] = (usersRes.data ?? []).filter((u: any) => !skip.has(String(u.telegram_id)));
  const orders: any[] = (ordersRes.data ?? []).filter((o: any) => !skip.has(String(o.telegram_id)));
  const receipts: any[] = (receiptsRes.data ?? []).filter((r: any) => !skip.has(String(r.telegram_id)));
  const products: any[] = productsRes.data ?? [];
  const prices: any[] = pricesRes.data ?? [];
  const stock: any[] = stockRes.data ?? [];
  const methods: any[] = methodsRes.data ?? [];
  const blocked: any[] = (blockedRes.data ?? []).filter((b: any) => !skip.has(String(b.telegram_id)));

  const productName = new Map<string, string>(products.map((p) => [p.id, p.name as string]));
  const priceInfo = new Map<string, { product_id: string; duration_label: string }>(
    prices.map((p) => [p.id, { product_id: p.product_id, duration_label: p.duration_label }]),
  );
  const userName = new Map<string, string>(
    usersRows.map((u) => [
      String(u.telegram_id),
      (u.display_name || u.username || String(u.telegram_id)) as string,
    ]),
  );

  const paid = orders.filter((o) => o.status === "delivered" || o.status === "approved");

  const dailyMap = new Map<string, { total: number; orders: number }>();
  for (let i = 13; i >= 0; i--) {
    dailyMap.set(dayKey(iso(new Date(now.getTime() - i * 864e5))), { total: 0, orders: 0 });
  }
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, total: 0 }));
  const weekday = WEEKDAYS.map((label) => ({ label, orders: 0, total: 0 }));
  const byProduct = new Map<string, { orders: number; total: number; keys: number }>();
  const byUser = new Map<string, { orders: number; total: number }>();
  const bestDayMap = new Map<string, number>();

  let revenueTotal = 0;
  let revenueToday = 0;
  let revenueYesterday = 0;
  let revenue7d = 0;
  let revenuePrev7d = 0;
  let revenue30d = 0;
  let keysDelivered = 0;
  let keysToday = 0;

  for (const o of paid) {
    const amount = num(o.total_usd);
    const qty = num(o.keys_qty);
    const created = String(o.created_at ?? "");
    const key = dayKey(created);
    revenueTotal += amount;
    keysDelivered += qty;
    if (key === todayKey) {
      revenueToday += amount;
      keysToday += qty;
    }
    if (key === yesterdayKey) revenueYesterday += amount;
    if (created >= d7) revenue7d += amount;
    else if (created >= d14) revenuePrev7d += amount;
    if (created >= d30) revenue30d += amount;

    bestDayMap.set(key, (bestDayMap.get(key) ?? 0) + amount);
    const bucket = dailyMap.get(key);
    if (bucket) {
      bucket.total += amount;
      bucket.orders += 1;
    }

    if (created) {
      const dt = new Date(created);
      const h = hourly[dt.getUTCHours()];
      if (h) {
        h.orders += 1;
        h.total += amount;
      }
      const w = weekday[dt.getUTCDay()];
      if (w) {
        w.orders += 1;
        w.total += amount;
      }
    }

    const pname = productName.get(o.product_id) ?? "Sin producto";
    const pAgg = byProduct.get(pname) ?? { orders: 0, total: 0, keys: 0 };
    pAgg.orders += 1;
    pAgg.total += amount;
    pAgg.keys += qty;
    byProduct.set(pname, pAgg);

    const uid = String(o.telegram_id);
    const uAgg = byUser.get(uid) ?? { orders: 0, total: 0 };
    uAgg.orders += 1;
    uAgg.total += amount;
    byUser.set(uid, uAgg);
  }

  const stockByProductMap = new Map<string, number>();
  for (const k of stock) {
    const info = priceInfo.get(k.price_id);
    const key = `${productName.get(k.product_id) ?? "Sin producto"}||${info?.duration_label ?? "-"}`;
    stockByProductMap.set(key, (stockByProductMap.get(key) ?? 0) + 1);
  }
  const stockList = [...stockByProductMap.entries()].map(([key, keys]) => {
    const [name, duration] = key.split("||");
    return { name, duration, keys };
  });

  const allCombos = prices
    .filter((p) => p.active !== false)
    .map((p) => ({
      name: productName.get(p.product_id) ?? "Sin producto",
      duration: String(p.duration_label ?? "-"),
      keys: stockByProductMap.get(`${productName.get(p.product_id) ?? "Sin producto"}||${p.duration_label}`) ?? 0,
    }));

  const countByField = (rows: any[], field: string) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const v = String(r[field] ?? "-");
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  };

  const countries = new Map<string, number>();
  for (const m of methods.filter((m) => m.active)) {
    const c = String(m.country_name ?? "-");
    countries.set(c, (countries.get(c) ?? 0) + 1);
  }

  const bestDayEntry = [...bestDayMap.entries()].sort((a, b) => b[1] - a[1])[0];

  const movements = [
    ...orders.slice(0, 40).map((o) => ({
      id: `o-${o.id}`,
      kind: "Compra" as const,
      title: productName.get(o.product_id) ?? "Compra",
      detail: `ID ${o.telegram_id} · ${priceInfo.get(o.price_id)?.duration_label ?? "-"} · ${o.status}`,
      amount: `${num(o.total_usd).toFixed(2)} USD`,
      createdAt: String(o.created_at ?? ""),
    })),
    ...receipts.slice(0, 40).map((r) => ({
      id: `r-${r.id}`,
      kind: "Comprobante" as const,
      title: "Comprobante de recarga",
      detail: `ID ${r.telegram_id} · ${r.status}`,
      amount: String(r.status ?? ""),
      createdAt: String(r.created_at ?? ""),
    })),
    ...usersRows.slice(0, 25).map((u) => ({
      id: `u-${u.telegram_id}`,
      kind: "Registro" as const,
      title: (u.display_name || u.username || String(u.telegram_id)) as string,
      detail: `Nuevo usuario · ID ${u.telegram_id}`,
      amount: `${num(u.balance).toFixed(2)} USD`,
      createdAt: String(u.created_at ?? ""),
    })),
  ]
    .filter((m) => m.createdAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 60);

  const buyers = byUser.size;
  const repeatBuyers = [...byUser.values()].filter((v) => v.orders > 1).length;
  const approvedReceipts = receipts.filter((r) => r.status === "approved").length;

  return {
    generatedAt: iso(now),
    excluded: EXCLUDED_TELEGRAM_IDS,
    users: {
      total: usersRows.length,
      new24h: usersRows.filter((u) => String(u.created_at ?? "") >= d1).length,
      new7d: usersRows.filter((u) => String(u.created_at ?? "") >= d7).length,
      new30d: usersRows.filter((u) => String(u.created_at ?? "") >= d30).length,
      withBalance: usersRows.filter((u) => num(u.balance) > 0).length,
      blocked: blocked.length,
      balanceTotal: usersRows.reduce((s, u) => s + num(u.balance), 0),
      rechargedTotal: usersRows.reduce((s, u) => s + num(u.total_recharged), 0),
      activeToday: usersRows.filter((u) => String(u.last_seen_at ?? "") >= d1).length,
      active7d: usersRows.filter((u) => String(u.last_seen_at ?? "") >= d7).length,
      buyers,
      repeatBuyers,
      byRank: countByField(usersRows, "rank"),
      byLang: countByField(usersRows, "lang"),
    },
    sales: {
      orders: orders.length,
      delivered: orders.filter((o) => o.status === "delivered").length,
      pending: orders.filter((o) => String(o.status ?? "").startsWith("pending")).length,
      cancelled: orders.filter((o) => o.status === "cancelled" || o.status === "rejected").length,
      ordersToday: paid.filter((o) => dayKey(String(o.created_at ?? "")) === todayKey).length,
      orders7d: paid.filter((o) => String(o.created_at ?? "") >= d7).length,
      orders30d: paid.filter((o) => String(o.created_at ?? "") >= d30).length,
      revenueTotal,
      revenueToday,
      revenueYesterday,
      revenue7d,
      revenuePrev7d,
      revenue30d,
      keysDelivered,
      keysToday,
      avgTicket: paid.length ? revenueTotal / paid.length : 0,
      avgPerDay30d: revenue30d / 30,
      bestDay: { date: bestDayEntry?.[0] ?? "-", total: bestDayEntry?.[1] ?? 0 },
      growth7d: revenuePrev7d > 0 ? ((revenue7d - revenuePrev7d) / revenuePrev7d) * 100 : 0,
    },
    receipts: {
      total: receipts.length,
      pending: receipts.filter((r) => r.status === "pending").length,
      approved: approvedReceipts,
      rejected: receipts.filter((r) => r.status === "rejected").length,
      today: receipts.filter((r) => dayKey(String(r.created_at ?? "")) === todayKey).length,
      approvalRate: receipts.length ? (approvedReceipts / receipts.length) * 100 : 0,
    },
    catalog: {
      products: products.length,
      activeProducts: products.filter((p) => p.active).length,
      prices: prices.length,
      stockKeys: stock.length,
      paymentMethods: methods.filter((m) => m.active).length,
      outOfStock: allCombos.filter((c) => c.keys === 0).length,
    },
    daily: [...dailyMap.entries()].map(([date, v]) => ({ date, ...v })),
    hourly,
    weekday,
    topProducts: [...byProduct.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8),
    topUsers: [...byUser.entries()]
      .map(([telegramId, v]) => ({ telegramId, name: userName.get(telegramId) ?? telegramId, ...v }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8),
    topCountries: [...countries.entries()]
      .map(([country, methods]) => ({ country, methods }))
      .sort((a, b) => b.methods - a.methods)
      .slice(0, 10),
    recentOrders: orders.slice(0, 30).map((o) => {
      const info = priceInfo.get(o.price_id);
      return {
        id: String(o.id),
        telegramId: String(o.telegram_id),
        product: productName.get(o.product_id) ?? "Sin producto",
        duration: info?.duration_label ?? "-",
        total: num(o.total_usd),
        status: String(o.status ?? ""),
        qty: num(o.keys_qty),
        createdAt: String(o.created_at ?? ""),
      };
    }),
    recentUsers: usersRows.slice(0, 15).map((u) => ({
      telegramId: String(u.telegram_id),
      name: (u.display_name || u.username || String(u.telegram_id)) as string,
      balance: num(u.balance),
      recharged: num(u.total_recharged),
      createdAt: String(u.created_at ?? ""),
    })),
    movements,
    stockByProduct: stockList.sort((a, b) => b.keys - a.keys).slice(0, 15),
    lowStock: allCombos.filter((c) => c.keys <= 3).sort((a, b) => a.keys - b.keys).slice(0, 15),
    paymentMethods: methods
      .filter((m) => m.active)
      .map((m) => ({
        country: String(m.country_name ?? "-"),
        method: String(m.method_name ?? "-"),
        currency: String(m.currency ?? "USD"),
        active: Boolean(m.active),
      }))
      .slice(0, 30),
  };
});
