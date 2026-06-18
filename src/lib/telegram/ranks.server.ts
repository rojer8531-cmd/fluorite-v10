// Sistema de rangos — Gold / Platinum / Diamond / Elite
import { sb } from "./db.server";

export type Rank = "gold" | "platinum" | "diamond" | "elite";

export const RANKS: Rank[] = ["gold", "platinum", "diamond", "elite"];

export interface RankInfo {
  key: Rank;
  label: string;       // nombre largo
  badge: string;       // insignia discreta junto al nombre
  emoji: string;
  discountPct: number; // % aplicable a precios normales
  threshold: number;   // USD acumulados para alcanzar
}

export const RANK_INFO: Record<Rank, RankInfo> = {
  gold:     { key: "gold",     label: "Gold",     badge: "🏆", emoji: "🏆", discountPct: 0,   threshold: 0 },
  platinum: { key: "platinum", label: "Platinum", badge: "💠", emoji: "💠", discountPct: 0.5, threshold: 100 },
  diamond:  { key: "diamond",  label: "Diamond",  badge: "💎", emoji: "💎", discountPct: 1,   threshold: 180 },
  elite:    { key: "elite",    label: "Elite",    badge: "👑", emoji: "👑", discountPct: 1,   threshold: 400 },
};

/** Devuelve el rango correspondiente a un total acumulado en USD. */
export function rankFromRecharged(total: number): Rank {
  if (total >= RANK_INFO.elite.threshold) return "elite";
  if (total >= RANK_INFO.diamond.threshold) return "diamond";
  if (total >= RANK_INFO.platinum.threshold) return "platinum";
  return "gold";
}

/** Normaliza valores antiguos (normal/pro/leyenda) a nuevos. */
export function normalizeRank(raw: string | null | undefined): Rank {
  switch (raw) {
    case "elite":
    case "diamond":
    case "platinum":
    case "gold":
      return raw;
    case "leyenda":
      return "diamond";
    case "pro":
      return "platinum";
    default:
      return "gold";
  }
}

/**
 * Aplica el descuento por rango al precio unitario.
 * - Elite: si el precio == 30 USD → fijo 25 USD. Si no, aplica 1% (igual que diamond).
 * - Diamond: -1%
 * - Platinum: -0.5%
 * - Gold: sin descuento
 */
export function applyRankDiscount(unit_usd: number, rank: Rank): number {
  const r = normalizeRank(rank);
  if (r === "elite") {
    if (Math.abs(unit_usd - 30) < 0.005) return 25;
    return round2(unit_usd * (1 - RANK_INFO.elite.discountPct / 100));
  }
  const pct = RANK_INFO[r].discountPct;
  if (pct <= 0) return round2(unit_usd);
  return round2(unit_usd * (1 - pct / 100));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Próximo rango y cuánto falta. null si ya es el máximo. */
export function nextRankProgress(total: number): { next: Rank; missing: number } | null {
  if (total < RANK_INFO.platinum.threshold) return { next: "platinum", missing: round2(RANK_INFO.platinum.threshold - total) };
  if (total < RANK_INFO.diamond.threshold)  return { next: "diamond",  missing: round2(RANK_INFO.diamond.threshold - total) };
  if (total < RANK_INFO.elite.threshold)    return { next: "elite",    missing: round2(RANK_INFO.elite.threshold - total) };
  return null;
}

/** Auto-asigna rango según total acumulado y registra cambio si aplica. */
export async function autoPromote(telegram_id: number, newRecharged: number, current: string | null | undefined): Promise<Rank> {
  const target = rankFromRecharged(newRecharged);
  const old = normalizeRank(current);
  if (target !== old) {
    await sb
      .from("bot_users")
      .update({ rank: target, rank_assigned_at: new Date().toISOString() })
      .eq("telegram_id", telegram_id);
    await sb.from("rank_history").insert({
      telegram_id,
      old_rank: old as never,
      new_rank: target as never,
      changed_by: "system",
      reason: `auto · total $${newRecharged.toFixed(2)}`,
    });
  }
  return target;
}

/** Asignación manual por el admin. */
export async function assignRank(opts: {
  telegram_id: number;
  new_rank: Rank;
  admin_telegram_id: number;
  reason?: string;
}): Promise<void> {
  const { data: u } = await sb
    .from("bot_users")
    .select("rank")
    .eq("telegram_id", opts.telegram_id)
    .maybeSingle();
  const old = normalizeRank(u?.rank);
  await sb
    .from("bot_users")
    .update({ rank: opts.new_rank, rank_assigned_at: new Date().toISOString() })
    .eq("telegram_id", opts.telegram_id);
  await sb.from("rank_history").insert({
    telegram_id: opts.telegram_id,
    old_rank: old as never,
    new_rank: opts.new_rank as never,
    changed_by: "admin",
    admin_telegram_id: opts.admin_telegram_id,
    reason: opts.reason ?? null,
  });
}

export function rankBadge(rank: string | null | undefined): string {
  return RANK_INFO[normalizeRank(rank)].badge;
}

export function rankLabel(rank: string | null | undefined): string {
  const r = RANK_INFO[normalizeRank(rank)];
  return `${r.badge} ${r.label}`;
}
