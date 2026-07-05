import { createServerFn } from "@tanstack/react-start";
import { requirePanelUnlocked } from "./gate.functions";

async function sb() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}
async function log(action: string, entity_id?: string, metadata: Record<string, unknown> = {}) {
  const db = await sb();
  await db.from("panel_action_logs").insert({ action, entity: "user", entity_id: entity_id ?? null, metadata: metadata as never });
}

export const listUsers = createServerFn({ method: "GET" })
  .inputValidator((d: { search?: string; rank?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    let q = db.from("bot_users").select("*").order("total_recharged", { ascending: false }).limit(data.limit ?? 500);
    if (data.rank) q = q.eq("rank", data.rank as never);
    if (data.search) {
      const s = data.search.trim();
      const asNum = Number(s);
      if (!Number.isNaN(asNum) && s !== "") q = q.or(`telegram_id.eq.${asNum},username.ilike.%${s}%,display_name.ilike.%${s}%`);
      else q = q.or(`username.ilike.%${s}%,display_name.ilike.%${s}%`);
    }
    const { data: users, error } = await q;
    if (error) throw error;
    // añadir blocked_until join manual
    const ids = (users ?? []).map((u) => u.telegram_id);
    const { data: blocks } = ids.length
      ? await db.from("blocked_users").select("telegram_id, blocked_until").in("telegram_id", ids)
      : { data: [] as { telegram_id: number; blocked_until: string | null }[] };
    const bmap = new Map((blocks ?? []).map((b) => [b.telegram_id, b.blocked_until]));
    return (users ?? []).map((u) => ({ ...u, blocked_until: bmap.get(u.telegram_id) ?? null }));
  });

export const updateUserRank = createServerFn({ method: "POST" })
  .inputValidator((d: { telegram_id: number; new_rank: string }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    await db.from("bot_users").update({ rank: data.new_rank as never, rank_assigned_at: new Date().toISOString() }).eq("telegram_id", data.telegram_id);
    await db.from("rank_history").insert({ telegram_id: data.telegram_id, new_rank: data.new_rank as never, changed_by: "panel", reason: "panel web" });
    await log("user.rank", String(data.telegram_id), { new_rank: data.new_rank });
    return { ok: true };
  });

export const updateUserBalance = createServerFn({ method: "POST" })
  .inputValidator((d: { telegram_id: number; balance: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    await db.from("bot_users").update({ balance: data.balance }).eq("telegram_id", data.telegram_id);
    await log("user.balance", String(data.telegram_id), { balance: data.balance });
    return { ok: true };
  });

export const blockUser24h = createServerFn({ method: "POST" })
  .inputValidator((d: { telegram_id: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const until = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await db.from("blocked_users").upsert({ telegram_id: data.telegram_id, reason: "panel_24h", blocked_until: until, infraction_count: 1 }, { onConflict: "telegram_id" });
    await log("user.block24h", String(data.telegram_id));
    return { ok: true };
  });

export const blockUserPermanent = createServerFn({ method: "POST" })
  .inputValidator((d: { telegram_id: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    await db.from("blocked_users").upsert({ telegram_id: data.telegram_id, reason: "panel_perm", blocked_until: null, infraction_count: 99 }, { onConflict: "telegram_id" });
    await log("user.blockPerm", String(data.telegram_id));
    return { ok: true };
  });

export const unblockUser = createServerFn({ method: "POST" })
  .inputValidator((d: { telegram_id: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    await db.from("blocked_users").delete().eq("telegram_id", data.telegram_id);
    await log("user.unblock", String(data.telegram_id));
    return { ok: true };
  });

export const setUserPriceOverride = createServerFn({ method: "POST" })
  .inputValidator((d: { telegram_id: number; price_id: string; price_usd: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    await db.from("user_price_overrides").upsert({ telegram_id: data.telegram_id, price_id: data.price_id, price_usd: data.price_usd }, { onConflict: "telegram_id,price_id" });
    await log("user.priceOverride", String(data.telegram_id), { price_id: data.price_id, price_usd: data.price_usd });
    return { ok: true };
  });

export const removeUserPriceOverride = createServerFn({ method: "POST" })
  .inputValidator((d: { telegram_id: number; price_id: string }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    await db.from("user_price_overrides").delete().eq("telegram_id", data.telegram_id).eq("price_id", data.price_id);
    await log("user.priceOverride.delete", String(data.telegram_id), { price_id: data.price_id });
    return { ok: true };
  });
