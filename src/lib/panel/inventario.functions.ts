import { createServerFn } from "@tanstack/react-start";
import { requirePanelUnlocked } from "./gate.functions";

async function sb() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function invalidateCatalog() {
  const mod = await import("@/lib/telegram/catalog.server");
  mod.invalidateCatalogCache();
}

async function log(action: string, entity?: string, entity_id?: string, metadata: Record<string, unknown> = {}) {
  const db = await sb();
  await db.from("panel_action_logs").insert({ action, entity: entity ?? null, entity_id: entity_id ?? null, metadata: metadata as never });
}

// ============ LECTURA GENERAL ============

export const getInventarioOverview = createServerFn({ method: "GET" }).handler(async () => {
  await requirePanelUnlocked();
  const db = await sb();
  const [cats, prods, prices, stockRows, methods] = await Promise.all([
    db.from("product_categories").select("*").order("sort_order"),
    db.from("products").select("*").order("sort_order"),
    db.from("product_prices").select("*").order("sort_order"),
    db.from("product_stock_keys").select("price_id, used"),
    db.from("payment_methods").select("*").order("country_code").order("sort_order"),
  ]);
  const stockByPrice = new Map<string, number>();
  for (const row of stockRows.data ?? []) {
    if (!row.used) stockByPrice.set(row.price_id, (stockByPrice.get(row.price_id) ?? 0) + 1);
  }
  return {
    categories: cats.data ?? [],
    products: prods.data ?? [],
    prices: (prices.data ?? []).map((p) => ({ ...p, stock: stockByPrice.get(p.id) ?? 0 })),
    methods: methods.data ?? [],
  };
});

// ============ KEYS ============

export const listKeys = createServerFn({ method: "GET" })
  .inputValidator((d: { price_id?: string; product_id?: string; only_available?: boolean; search?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    let q = db.from("product_stock_keys").select("*").order("created_at", { ascending: false }).limit(data.limit ?? 500);
    if (data.price_id) q = q.eq("price_id", data.price_id);
    if (data.product_id) q = q.eq("product_id", data.product_id);
    if (data.only_available) q = q.eq("used", false);
    if (data.search) q = q.ilike("key_value", `%${data.search}%`);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export const addKeys = createServerFn({ method: "POST" })
  .inputValidator((d: { product_id: string; price_id: string; keys: string[] }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const clean = Array.from(new Set(data.keys.map((k) => k.trim()).filter(Boolean)));
    if (clean.length === 0) return { inserted: 0, duplicates: 0 };
    // filtrar duplicados existentes en esta duración
    const { data: existing } = await db
      .from("product_stock_keys")
      .select("key_value")
      .eq("price_id", data.price_id)
      .in("key_value", clean);
    const existingSet = new Set((existing ?? []).map((r) => r.key_value));
    const rows = clean
      .filter((k) => !existingSet.has(k))
      .map((k) => ({ product_id: data.product_id, price_id: data.price_id, key_value: k }));
    if (rows.length > 0) {
      const { error } = await db.from("product_stock_keys").insert(rows);
      if (error) throw error;
    }
    await invalidateCatalog();
    await log("keys.add", "price", data.price_id, { inserted: rows.length, duplicates: existingSet.size });
    return { inserted: rows.length, duplicates: existingSet.size };
  });

export const deleteKeys = createServerFn({ method: "POST" })
  .inputValidator((d: { ids: string[] }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { error } = await db.from("product_stock_keys").delete().in("id", data.ids).eq("used", false);
    if (error) throw error;
    await invalidateCatalog();
    await log("keys.delete", "keys", null as never, { count: data.ids.length });
    return { deleted: data.ids.length };
  });

export const exportKeys = createServerFn({ method: "GET" })
  .inputValidator((d: { price_id?: string; only_available?: boolean }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    let q = db.from("product_stock_keys").select("key_value, used, price_id, product_id, created_at");
    if (data.price_id) q = q.eq("price_id", data.price_id);
    if (data.only_available) q = q.eq("used", false);
    const { data: rows } = await q;
    return rows ?? [];
  });

// ============ PRECIOS ============

export const updatePrice = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; price_usd?: number; sale_price_usd?: number | null; sale_ends_at?: string | null; active?: boolean; sort_order?: number; duration_label?: string; duration_days?: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    // guardar original si es primera edición de precio_usd
    if (typeof data.price_usd === "number") {
      const { data: cur } = await db.from("product_prices").select("original_price_usd, price_usd").eq("id", data.id).single();
      if (cur && cur.original_price_usd == null) {
        await db.from("product_prices").update({ original_price_usd: cur.price_usd }).eq("id", data.id);
      }
    }
    const patch: Record<string, unknown> = {};
    for (const k of ["price_usd", "sale_price_usd", "sale_ends_at", "active", "sort_order", "duration_label", "duration_days"] as const) {
      if ((data as Record<string, unknown>)[k] !== undefined) patch[k] = (data as Record<string, unknown>)[k];
    }
    const { error } = await db.from("product_prices").update(patch as never).eq("id", data.id);
    if (error) throw error;
    await invalidateCatalog();
    await log("price.update", "price", data.id, patch);
    return { ok: true };
  });

export const createPrice = createServerFn({ method: "POST" })
  .inputValidator((d: { product_id: string; duration_label: string; duration_days: number; price_usd: number; sort_order?: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { data: row, error } = await db.from("product_prices").insert({
      product_id: data.product_id,
      duration_label: data.duration_label,
      duration_days: data.duration_days,
      price_usd: data.price_usd,
      original_price_usd: data.price_usd,
      sort_order: data.sort_order ?? 0,
    }).select().single();
    if (error) throw error;
    await invalidateCatalog();
    await log("price.create", "price", row.id, { ...data });
    return row;
  });

export const deletePrice = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { error } = await db.from("product_prices").delete().eq("id", data.id);
    if (error) throw error;
    await invalidateCatalog();
    await log("price.delete", "price", data.id);
    return { ok: true };
  });

export const restoreOriginalPrice = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { data: cur } = await db.from("product_prices").select("original_price_usd").eq("id", data.id).single();
    if (!cur?.original_price_usd) return { ok: false, reason: "sin original" };
    const { error } = await db.from("product_prices").update({ price_usd: cur.original_price_usd, sale_price_usd: null, sale_ends_at: null }).eq("id", data.id);
    if (error) throw error;
    await invalidateCatalog();
    await log("price.restore", "price", data.id);
    return { ok: true };
  });

export const copyPricesBetweenProducts = createServerFn({ method: "POST" })
  .inputValidator((d: { source_product_id: string; target_product_id: string; overwrite?: boolean }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { data: source } = await db.from("product_prices").select("*").eq("product_id", data.source_product_id);
    if (!source?.length) return { copied: 0 };
    let copied = 0;
    for (const p of source) {
      const { data: existing } = await db.from("product_prices").select("id").eq("product_id", data.target_product_id).eq("duration_days", p.duration_days).maybeSingle();
      if (existing && !data.overwrite) continue;
      if (existing && data.overwrite) {
        await db.from("product_prices").update({ price_usd: p.price_usd, duration_label: p.duration_label, sort_order: p.sort_order }).eq("id", existing.id);
      } else {
        await db.from("product_prices").insert({
          product_id: data.target_product_id,
          duration_label: p.duration_label,
          duration_days: p.duration_days,
          price_usd: p.price_usd,
          original_price_usd: p.price_usd,
          sort_order: p.sort_order,
        });
      }
      copied++;
    }
    await invalidateCatalog();
    await log("price.copy", "product", data.target_product_id, { from: data.source_product_id, copied });
    return { copied };
  });

// ============ PRODUCTOS ============

export const createProduct = createServerFn({ method: "POST" })
  .inputValidator((d: { name: string; category: string; description?: string; sort_order?: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { data: row, error } = await db.from("products").insert({
      name: data.name,
      category: data.category as never,
      description: data.description ?? null,
      sort_order: data.sort_order ?? 0,
    }).select().single();
    if (error) throw error;
    await invalidateCatalog();
    await log("product.create", "product", row.id, data);
    return row;
  });

export const updateProduct = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; name?: string; description?: string | null; category?: string; active?: boolean; sort_order?: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "description", "category", "active", "sort_order"] as const) {
      if ((data as Record<string, unknown>)[k] !== undefined) patch[k] = (data as Record<string, unknown>)[k];
    }
    const { error } = await db.from("products").update(patch as never).eq("id", data.id);
    if (error) throw error;
    await invalidateCatalog();
    await log("product.update", "product", data.id, patch);
    return { ok: true };
  });

export const deleteProduct = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { error } = await db.from("products").delete().eq("id", data.id);
    if (error) throw error;
    await invalidateCatalog();
    await log("product.delete", "product", data.id);
    return { ok: true };
  });

export const reorderProducts = createServerFn({ method: "POST" })
  .inputValidator((d: { order: { id: string; sort_order: number }[] }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    await Promise.all(data.order.map((o) => db.from("products").update({ sort_order: o.sort_order }).eq("id", o.id)));
    await invalidateCatalog();
    await log("product.reorder", "products", null as never, { count: data.order.length });
    return { ok: true };
  });

// ============ CATEGORÍAS ============

export const createCategory = createServerFn({ method: "POST" })
  .inputValidator((d: { name: string; sort_order?: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { data: row, error } = await db.from("product_categories").insert({ name: data.name, sort_order: data.sort_order ?? 99 }).select().single();
    if (error) throw error;
    await log("category.create", "category", row.id, data);
    return row;
  });

export const deleteCategory = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    await db.from("product_categories").delete().eq("id", data.id);
    await log("category.delete", "category", data.id);
    return { ok: true };
  });

// ============ MÉTODOS DE PAGO ============

export const createPaymentMethod = createServerFn({ method: "POST" })
  .inputValidator((d: { country_code: string; country_name: string; method_name: string; holder_name: string; account_info: string; extra_info?: string; currency?: string; usd_rate?: number; sort_order?: number }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { data: row, error } = await db.from("payment_methods").insert({
      country_code: data.country_code,
      country_name: data.country_name,
      method_name: data.method_name,
      holder_name: data.holder_name,
      account_info: data.account_info,
      extra_info: data.extra_info ?? null,
      currency: data.currency ?? "USD",
      usd_rate: data.usd_rate ?? 1,
      sort_order: data.sort_order ?? 0,
    }).select().single();
    if (error) throw error;
    await log("payment.create", "payment_method", row.id, data);
    return row;
  });

export const updatePaymentMethod = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string } & Record<string, unknown>) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const patch: Record<string, unknown> = {};
    for (const k of ["country_code", "country_name", "method_name", "holder_name", "account_info", "extra_info", "currency", "usd_rate", "active", "sort_order"]) {
      if (data[k] !== undefined) patch[k] = data[k];
    }
    const { error } = await db.from("payment_methods").update(patch as never).eq("id", data.id);
    if (error) throw error;
    await log("payment.update", "payment_method", data.id, patch);
    return { ok: true };
  });

export const deletePaymentMethod = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    await requirePanelUnlocked();
    const db = await sb();
    const { error } = await db.from("payment_methods").delete().eq("id", data.id);
    if (error) throw error;
    await log("payment.delete", "payment_method", data.id);
    return { ok: true };
  });
