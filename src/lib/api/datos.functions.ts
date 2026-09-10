import { createServerFn } from "@tanstack/react-start";

export type DatosPayload = {
  generatedAt: string;
  users: {
    total: number;
    new7d: number;
    new30d: number;
    withBalance: number;
    blocked: number;
    balanceTotal: number;
    rechargedTotal: number;
  };
  sales: {
    orders: number;
    delivered: number;
    pending: number;
    revenueTotal: number;
    revenueToday: number;
    revenue7d: number;
    revenue30d: number;
    keysDelivered: number;
  };
  receipts: { total: number; pending: number; approved: number; rejected: number };
  catalog: {
    products: number;
    activeProducts: number;
    prices: number;
    stockKeys: number;
    paymentMethods: number;
  };
  daily: { date: string; total: number; orders: number }[];
  topProducts: { name: string; orders: number; total: number }[];
  topUsers: { name: string; telegramId: string; total: number; orders: number }[];
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
  stockByProduct: { name: string; duration: string; keys: number }[];
};

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const dayKey = (iso: string) => iso.slice(0, 10);

export const getDatos = createServerFn({ method: "GET" }).handler(async (): Promise<DatosPayload> => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as never as {
    from: (t: string) => any;
  };

  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const d7 = iso(new Date(now.getTime() - 7 * 864e5));
  const d30 = iso(new Date(now.getTime() - 30 * 864e5));
  const todayKey = dayKey(iso(now));

  const [usersRes, ordersRes, receiptsRes, productsRes, pricesRes, stockRes, methodsRes, blockedRes] =
    await Promise.all([
      db
        .from("bot_users")
        .select("telegram_id, display_name, username, balance, total_recharged, created_at")
        .order("created_at", { ascending: false })
        .limit(5000),
      db
        .from("orders")
        .select(
          "id, telegram_id, product_id, price_id, keys_qty, total_usd, status, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(5000),
      db.from("receipts").select("status").limit(5000),
      db.from("products").select("id, name, active").limit(1000),
      db.from("product_prices").select("id, product_id, duration_label").limit(2000),
      db.from("product_stock_keys").select("product_id, price_id").limit(20000),
      db.from("payment_methods").select("id, active").limit(500),
      db.from("blocked_users").select("telegram_id").limit(5000),
    ]);

  const usersRows: any[] = usersRes.data ?? [];
  const orders: any[] = ordersRes.data ?? [];
  const receipts: any[] = receiptsRes.data ?? [];
  const products: any[] = productsRes.data ?? [];
  const prices: any[] = pricesRes.data ?? [];
  const stock: any[] = stockRes.data ?? [];
  const methods: any[] = methodsRes.data ?? [];
  const blocked: any[] = blockedRes.data ?? [];

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
  const byProduct = new Map<string, { orders: number; total: number }>();
  const byUser = new Map<string, { orders: number; total: number }>();

  let revenueTotal = 0;
  let revenueToday = 0;
  let revenue7d = 0;
  let revenue30d = 0;
  let keysDelivered = 0;

  for (const o of paid) {
    const amount = num(o.total_usd);
    revenueTotal += amount;
    keysDelivered += num(o.keys_qty);
    const created = String(o.created_at ?? "");
    if (dayKey(created) === todayKey) revenueToday += amount;
    if (created >= d7) revenue7d += amount;
    if (created >= d30) revenue30d += amount;

    const bucket = dailyMap.get(dayKey(created));
    if (bucket) {
      bucket.total += amount;
      bucket.orders += 1;
    }

    const pname = productName.get(o.product_id) ?? "Sin producto";
    const pAgg = byProduct.get(pname) ?? { orders: 0, total: 0 };
    pAgg.orders += 1;
    pAgg.total += amount;
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

  return {
    generatedAt: iso(now),
    users: {
      total: usersRows.length,
      new7d: usersRows.filter((u) => String(u.created_at ?? "") >= d7).length,
      new30d: usersRows.filter((u) => String(u.created_at ?? "") >= d30).length,
      withBalance: usersRows.filter((u) => num(u.balance) > 0).length,
      blocked: blocked.length,
      balanceTotal: usersRows.reduce((s, u) => s + num(u.balance), 0),
      rechargedTotal: usersRows.reduce((s, u) => s + num(u.total_recharged), 0),
    },
    sales: {
      orders: orders.length,
      delivered: orders.filter((o) => o.status === "delivered").length,
      pending: orders.filter((o) => String(o.status ?? "").startsWith("pending")).length,
      revenueTotal,
      revenueToday,
      revenue7d,
      revenue30d,
      keysDelivered,
    },
    receipts: {
      total: receipts.length,
      pending: receipts.filter((r) => r.status === "pending").length,
      approved: receipts.filter((r) => r.status === "approved").length,
      rejected: receipts.filter((r) => r.status === "rejected").length,
    },
    catalog: {
      products: products.length,
      activeProducts: products.filter((p) => p.active).length,
      prices: prices.length,
      stockKeys: stock.length,
      paymentMethods: methods.filter((m) => m.active).length,
    },
    daily: [...dailyMap.entries()].map(([date, v]) => ({ date, ...v })),
    topProducts: [...byProduct.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6),
    topUsers: [...byUser.entries()]
      .map(([telegramId, v]) => ({
        telegramId,
        name: userName.get(telegramId) ?? telegramId,
        ...v,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6),
    recentOrders: orders.slice(0, 25).map((o) => {
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
    recentUsers: usersRows.slice(0, 12).map((u) => ({
      telegramId: String(u.telegram_id),
      name: (u.display_name || u.username || String(u.telegram_id)) as string,
      balance: num(u.balance),
      recharged: num(u.total_recharged),
      createdAt: String(u.created_at ?? ""),
    })),
    stockByProduct: [...stockByProductMap.entries()]
      .map(([key, keys]) => {
        const [name, duration] = key.split("||");
        return { name, duration, keys };
      })
      .sort((a, b) => b.keys - a.keys)
      .slice(0, 12),
  };
});
