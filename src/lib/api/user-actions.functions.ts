import { createServerFn } from "@tanstack/react-start";

type Db = { from: (t: string) => any };
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

async function db(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as never as Db;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type ActionResult = { ok: boolean; message: string };

/** Envía un mensaje directo al chat del usuario en el bot de compras. */
export const sendUserMessage = createServerFn({ method: "POST" })
  .inputValidator((data: { telegramId: string; text: string }) => data)
  .handler(async ({ data }): Promise<ActionResult> => {
    const text = data.text.trim();
    if (!text) return { ok: false, message: "Escribe un mensaje." };
    if (text.length > 3500) return { ok: false, message: "El mensaje es demasiado largo." };
    const sb = await db();
    const { data: u } = await sb
      .from("bot_users")
      .select("chat_id")
      .eq("telegram_id", Number(data.telegramId))
      .maybeSingle();
    if (!u) return { ok: false, message: "Usuario no encontrado." };
    const { sendMessage } = await import("@/lib/telegram/api.server");
    await sendMessage("shop", u.chat_id, `<b>Mensaje del Admin</b>\n\n${escapeHtml(text)}`);
    return { ok: true, message: "Mensaje enviado al usuario." };
  });

/** Bloquea o desbloquea al usuario. */
export const setUserBlock = createServerFn({ method: "POST" })
  .inputValidator((data: { telegramId: string; blocked: boolean; reason?: string }) => data)
  .handler(async ({ data }): Promise<ActionResult> => {
    const sb = await db();
    const tid = Number(data.telegramId);
    if (data.blocked) {
      await sb.from("blocked_users").upsert(
        {
          telegram_id: tid,
          reason: (data.reason ?? "").trim() || "admin_block",
          blocked_until: null,
          infraction_count: 99,
        },
        { onConflict: "telegram_id" },
      );
    } else {
      await sb.from("blocked_users").delete().eq("telegram_id", tid);
    }
    await sb.from("admin_logs").insert({
      admin_telegram_id: 0,
      action: data.blocked ? "block_user" : "unblock_user",
      target_type: "telegram_id",
      target_id: String(tid),
      details: { source: "panel" },
    });
    return { ok: true, message: data.blocked ? "Usuario bloqueado." : "Usuario desbloqueado." };
  });

/** Suma o resta saldo al usuario. */
export const adjustUserBalance = createServerFn({ method: "POST" })
  .inputValidator((data: { telegramId: string; amount: number; mode: "add" | "sub" }) => data)
  .handler(async ({ data }): Promise<ActionResult> => {
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)
      return { ok: false, message: "Cantidad inválida." };
    const sb = await db();
    const tid = Number(data.telegramId);
    const { data: u } = await sb
      .from("bot_users")
      .select("balance, total_recharged")
      .eq("telegram_id", tid)
      .maybeSingle();
    if (!u) return { ok: false, message: "Usuario no encontrado." };
    const cur = num(u.balance);
    if (data.mode === "sub" && amount > cur)
      return { ok: false, message: `Saldo insuficiente. Actual ${cur.toFixed(2)} USD.` };
    const next = data.mode === "sub" ? cur - amount : cur + amount;
    await sb.from("bot_users").update({ balance: next }).eq("telegram_id", tid);
    await sb.from("admin_logs").insert({
      admin_telegram_id: 0,
      action: data.mode === "sub" ? "balance_subtract" : "balance_add",
      target_type: "telegram_id",
      target_id: String(tid),
      details: { amount, balance: next, source: "panel" },
    });
    return {
      ok: true,
      message: `${data.mode === "sub" ? "Descontado" : "Agregado"} ${amount.toFixed(2)} USD · Saldo ${next.toFixed(2)} USD`,
    };
  });

/** Cambia el rango del usuario. */
export const setUserRank = createServerFn({ method: "POST" })
  .inputValidator((data: { telegramId: string; rank: string }) => data)
  .handler(async ({ data }): Promise<ActionResult> => {
    const allowed = ["normal", "pro", "leyenda", "gold", "platinum", "diamond", "elite"];
    if (!allowed.includes(data.rank)) return { ok: false, message: "Rango inválido." };
    const sb = await db();
    const tid = Number(data.telegramId);
    const { data: u } = await sb.from("bot_users").select("rank").eq("telegram_id", tid).maybeSingle();
    if (!u) return { ok: false, message: "Usuario no encontrado." };
    await sb
      .from("bot_users")
      .update({ rank: data.rank, rank_assigned_at: new Date().toISOString() })
      .eq("telegram_id", tid);
    await sb.from("rank_history").insert({
      telegram_id: tid,
      old_rank: u.rank ?? null,
      new_rank: data.rank,
      changed_by: "panel",
      reason: "panel",
    });
    return { ok: true, message: `Rango actualizado a ${data.rank}.` };
  });

export type CatalogPrice = {
  priceId: string;
  duration: string;
  price: number;
  override: number | null;
};
export type CatalogProduct = {
  productId: string;
  name: string;
  category: string;
  prices: CatalogPrice[];
};

/** Catálogo con los precios personalizados del usuario. */
export const getUserCatalog = createServerFn({ method: "GET" })
  .inputValidator((data: { telegramId: string }) => data)
  .handler(async ({ data }): Promise<CatalogProduct[]> => {
    const sb = await db();
    const tid = Number(data.telegramId);
    const [prodRes, priceRes, ovRes] = await Promise.all([
      sb.from("products").select("id, name, category").eq("active", true).order("sort_order"),
      sb
        .from("product_prices")
        .select("id, product_id, duration_label, price_usd")
        .eq("active", true)
        .order("sort_order"),
      sb.from("user_price_overrides").select("price_id, price_usd").eq("telegram_id", tid),
    ]);
    const ov = new Map<string, number>(
      (ovRes.data ?? []).map((o: any) => [o.price_id as string, num(o.price_usd)]),
    );
    return (prodRes.data ?? []).map((p: any) => ({
      productId: p.id,
      name: p.name,
      category: p.category,
      prices: (priceRes.data ?? [])
        .filter((pr: any) => pr.product_id === p.id)
        .map((pr: any) => ({
          priceId: pr.id,
          duration: pr.duration_label,
          price: num(pr.price_usd),
          override: ov.has(pr.id) ? ov.get(pr.id)! : null,
        })),
    }));
  });

/** Crea, actualiza o elimina un precio personalizado. */
export const setUserPriceOverride = createServerFn({ method: "POST" })
  .inputValidator((data: { telegramId: string; priceId: string; price: number | null }) => data)
  .handler(async ({ data }): Promise<ActionResult> => {
    const sb = await db();
    const tid = Number(data.telegramId);
    if (data.price === null) {
      await sb
        .from("user_price_overrides")
        .delete()
        .eq("telegram_id", tid)
        .eq("price_id", data.priceId);
      return { ok: true, message: "Precio personalizado eliminado." };
    }
    const price = Number(data.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000)
      return { ok: false, message: "Precio inválido." };
    await sb.from("user_price_overrides").upsert(
      { telegram_id: tid, price_id: data.priceId, price_usd: price },
      { onConflict: "telegram_id,price_id" },
    );
    return { ok: true, message: `Precio personalizado: ${price.toFixed(2)} USD` };
  });
