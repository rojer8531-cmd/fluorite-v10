import { createServerFn } from "@tanstack/react-start";
import { EXCLUDED_TELEGRAM_IDS } from "./datos.functions";

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

export type UserListItem = {
  telegramId: string;
  name: string;
  username: string | null;
  rank: string;
  lang: string;
  balance: number;
  recharged: number;
  spent: number;
  orders: number;
  blocked: boolean;
  createdAt: string;
  lastSeenAt: string;
};

export type UserDetail = {
  telegramId: string;
  name: string;
  username: string | null;
  rank: string;
  lang: string;
  balance: number;
  recharged: number;
  spent: number;
  orders: number;
  keys: number;
  pendingOrders: number;
  blocked: boolean;
  blockedReason: string | null;
  blockedUntil: string | null;
  authenticated: boolean;
  createdAt: string;
  lastSeenAt: string;
  lastOrderAt: string | null;
  sharesCount: number;
  referredBy: string | null;
  receipts: { total: number; approved: number; pending: number; rejected: number };
  recentOrders: {
    id: string;
    product: string;
    duration: string;
    qty: number;
    total: number;
    status: string;
    createdAt: string;
  }[];
  recentKeys: { value: string; deliveredAt: string }[];
  monthly: { label: string; total: number; orders: number }[];
};

export const listUsers = createServerFn({ method: "GET" }).handler(async (): Promise<UserListItem[]> => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as never as { from: (t: string) => any };

  const [usersRes, ordersRes, blockedRes] = await Promise.all([
    db
      .from("bot_users")
      .select("telegram_id, display_name, username, balance, total_recharged, rank, lang, created_at, last_seen_at")
      .order("last_seen_at", { ascending: false })
      .limit(5000),
    db.from("orders").select("telegram_id, total_usd, status").limit(20000),
    db.from("blocked_users").select("telegram_id").limit(5000),
  ]);

  const skip = new Set(EXCLUDED_TELEGRAM_IDS);
  const blocked = new Set<string>((blockedRes.data ?? []).map((b: any) => String(b.telegram_id)));
  const agg = new Map<string, { orders: number; spent: number }>();
  for (const o of ordersRes.data ?? []) {
    if (o.status === "rejected" || o.status === "cancelled") continue;
    const k = String(o.telegram_id);
    const cur = agg.get(k) ?? { orders: 0, spent: 0 };
    cur.orders += 1;
    cur.spent += num(o.total_usd);
    agg.set(k, cur);
  }

  return (usersRes.data ?? [])
    .filter((u: any) => !skip.has(String(u.telegram_id)))
    .map((u: any) => {
      const id = String(u.telegram_id);
      const a = agg.get(id) ?? { orders: 0, spent: 0 };
      return {
        telegramId: id,
        name: (u.display_name || u.username || id) as string,
        username: u.username ?? null,
        rank: u.rank ?? "normal",
        lang: u.lang ?? "es",
        balance: num(u.balance),
        recharged: num(u.total_recharged),
        spent: a.spent,
        orders: a.orders,
        blocked: blocked.has(id),
        createdAt: u.created_at ?? "",
        lastSeenAt: u.last_seen_at ?? "",
      };
    });
});

export const getUserDetail = createServerFn({ method: "GET" })
  .inputValidator((data: { telegramId: string }) => data)
  .handler(async ({ data }): Promise<UserDetail | null> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as never as { from: (t: string) => any };
    const tid = Number(data.telegramId);

    const { data: u } = await db.from("bot_users").select("*").eq("telegram_id", tid).maybeSingle();
    if (!u) return null;

    const [ordersRes, keysRes, receiptsRes, blockedRes, productsRes, pricesRes] = await Promise.all([
      db
        .from("orders")
        .select("id, product_id, price_id, keys_qty, total_usd, status, created_at")
        .eq("telegram_id", tid)
        .order("created_at", { ascending: false })
        .limit(500),
      db
        .from("order_keys")
        .select("key_value, delivered_at")
        .eq("user_id", u.id)
        .order("delivered_at", { ascending: false })
        .limit(20),
      db.from("receipts").select("status").eq("telegram_id", tid).limit(500),
      db.from("blocked_users").select("reason, blocked_until").eq("telegram_id", tid).maybeSingle(),
      db.from("products").select("id, name").limit(1000),
      db.from("product_prices").select("id, duration_label").limit(2000),
    ]);

    const productName = new Map<string, string>((productsRes.data ?? []).map((p: any) => [p.id, p.name]));
    const durationOf = new Map<string, string>((pricesRes.data ?? []).map((p: any) => [p.id, p.duration_label]));
    const orders: any[] = ordersRes.data ?? [];
    const valid = orders.filter((o) => o.status !== "rejected" && o.status !== "cancelled");

    const monthlyMap = new Map<string, { total: number; orders: number }>();
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthlyMap.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, { total: 0, orders: 0 });
    }
    for (const o of valid) {
      const key = String(o.created_at ?? "").slice(0, 7);
      const cur = monthlyMap.get(key);
      if (cur) {
        cur.total += num(o.total_usd);
        cur.orders += 1;
      }
    }

    const receipts = receiptsRes.data ?? [];
    const countBy = (s: string) => receipts.filter((r: any) => r.status === s).length;

    return {
      telegramId: String(u.telegram_id),
      name: (u.display_name || u.username || String(u.telegram_id)) as string,
      username: u.username ?? null,
      rank: u.rank ?? "normal",
      lang: u.lang ?? "es",
      balance: num(u.balance),
      recharged: num(u.total_recharged),
      spent: valid.reduce((s, o) => s + num(o.total_usd), 0),
      orders: valid.length,
      keys: valid.reduce((s, o) => s + num(o.keys_qty), 0),
      pendingOrders: orders.filter((o) => o.status === "pending_receipt" || o.status === "pending_approval").length,
      blocked: Boolean(blockedRes.data),
      blockedReason: blockedRes.data?.reason ?? null,
      blockedUntil: blockedRes.data?.blocked_until ?? null,
      authenticated: Boolean(u.is_authenticated),
      createdAt: u.created_at ?? "",
      lastSeenAt: u.last_seen_at ?? "",
      lastOrderAt: valid[0]?.created_at ?? null,
      sharesCount: num(u.shares_count),
      referredBy: u.referred_by_telegram_id ? String(u.referred_by_telegram_id) : null,
      receipts: {
        total: receipts.length,
        approved: countBy("approved"),
        pending: countBy("pending"),
        rejected: countBy("rejected"),
      },
      recentOrders: orders.slice(0, 12).map((o) => ({
        id: String(o.id).slice(0, 8),
        product: productName.get(o.product_id) ?? "—",
        duration: durationOf.get(o.price_id) ?? "—",
        qty: num(o.keys_qty),
        total: num(o.total_usd),
        status: o.status,
        createdAt: o.created_at ?? "",
      })),
      recentKeys: (keysRes.data ?? []).map((k: any) => ({
        value: k.key_value as string,
        deliveredAt: k.delivered_at ?? "",
      })),
      monthly: Array.from(monthlyMap.entries()).map(([key, v]) => ({
        label: key.slice(5),
        total: v.total,
        orders: v.orders,
      })),
    };
  });
