import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = supabaseAdmin;

const USER_CACHE_TTL_MS = 45_000;
const LAST_SEEN_WRITE_MS = 60_000;
const STATE_CACHE_TTL_MS = 30_000;
const ACTIVE_MESSAGE_CACHE_TTL_MS = 60_000;

const userCache = new Map<number, { value: BotUser; expiresAt: number }>();
const lastSeenWrites = new Map<number, number>();
const stateCache = new Map<number, { value: UserState | null; expiresAt: number }>();
const activeMessageCache = new Map<number, { value: { telegram_id: number; chat_id: number; message_id: number } | null; expiresAt: number }>();
const rateLimitCache = new Map<string, { count: number; windowStart: number }>();

function pruneExpiredCaches() {
  const now = Date.now();
  if (userCache.size > 5_000) for (const [k, v] of userCache) if (v.expiresAt <= now) userCache.delete(k);
  if (stateCache.size > 5_000) for (const [k, v] of stateCache) if (v.expiresAt <= now) stateCache.delete(k);
  if (activeMessageCache.size > 5_000) for (const [k, v] of activeMessageCache) if (v.expiresAt <= now) activeMessageCache.delete(k);
  if (lastSeenWrites.size > 5_000) for (const [k, v] of lastSeenWrites) if (now - v > LAST_SEEN_WRITE_MS * 3) lastSeenWrites.delete(k);
  if (rateLimitCache.size > 10_000) for (const [k, v] of rateLimitCache) if (now - v.windowStart > 86_400_000) rateLimitCache.delete(k);
}

export interface BotUser {
  id: string;
  telegram_id: number;
  chat_id: number;
  username: string | null;
  display_name: string | null;
  password_hash: string | null;
  is_authenticated: boolean;
  balance: number;
  total_recharged: number;
  rank: "gold" | "platinum" | "diamond" | "elite" | "normal" | "pro" | "leyenda";
  rank_assigned_at?: string;
}

export async function getOrCreateUser(opts: {
  telegram_id: number;
  chat_id: number;
  username?: string;
}): Promise<BotUser> {
  pruneExpiredCaches();
  const cached = userCache.get(opts.telegram_id);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    const lastWrite = lastSeenWrites.get(opts.telegram_id) ?? 0;
    if (now - lastWrite > LAST_SEEN_WRITE_MS || cached.value.chat_id !== opts.chat_id) {
      lastSeenWrites.set(opts.telegram_id, now);
      sb
        .from("bot_users")
        .update({ last_seen_at: new Date(now).toISOString(), chat_id: opts.chat_id })
        .eq("telegram_id", opts.telegram_id)
        .then(() => {}, () => {});
      cached.value = { ...cached.value, chat_id: opts.chat_id };
    }
    return cached.value;
  }

  const { data: existing } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_id", opts.telegram_id)
    .maybeSingle();
  if (existing) {
    const value = { ...(existing as BotUser), chat_id: opts.chat_id };
    userCache.set(opts.telegram_id, { value, expiresAt: now + USER_CACHE_TTL_MS });
    const lastWrite = lastSeenWrites.get(opts.telegram_id) ?? 0;
    if (now - lastWrite > LAST_SEEN_WRITE_MS || (existing as BotUser).chat_id !== opts.chat_id) {
      lastSeenWrites.set(opts.telegram_id, now);
      sb
        .from("bot_users")
        .update({ last_seen_at: new Date(now).toISOString(), chat_id: opts.chat_id })
        .eq("telegram_id", opts.telegram_id)
        .then(() => {}, () => {});
    }
    return value;
  }
  const { data: created, error } = await sb
    .from("bot_users")
    .insert({
      telegram_id: opts.telegram_id,
      chat_id: opts.chat_id,
      username: opts.username ?? null,
    })
    .select("*")
    .single();
  if (error) {
    const { data: recovered } = await sb
      .from("bot_users")
      .select("*")
      .eq("telegram_id", opts.telegram_id)
      .maybeSingle();
    if (recovered) {
      const value = recovered as BotUser;
      userCache.set(opts.telegram_id, { value, expiresAt: now + USER_CACHE_TTL_MS });
      return value;
    }
    throw error;
  }
  userCache.set(opts.telegram_id, { value: created as BotUser, expiresAt: now + USER_CACHE_TTL_MS });
  return created as BotUser;
}

export async function updateUser(
  telegram_id: number,
  patch: Partial<BotUser>,
) {
  await sb.from("bot_users").update(patch).eq("telegram_id", telegram_id);
  const cached = userCache.get(telegram_id);
  if (cached) {
    userCache.set(telegram_id, {
      value: { ...cached.value, ...patch },
      expiresAt: Date.now() + USER_CACHE_TTL_MS,
    });
  }
}

export async function updateRankFromRecharged(telegram_id: number) {
  const { data: u } = await sb
    .from("bot_users")
    .select("total_recharged, rank")
    .eq("telegram_id", telegram_id)
    .single();
  if (!u) return;
  const { autoPromote } = await import("./ranks.server");
  await autoPromote(telegram_id, Number(u.total_recharged), u.rank);
}

export interface UserState {
  telegram_id: number;
  state: string;
  context: Record<string, unknown>;
  start_lock_at: string | null;
  last_action_at: string;
}

export async function getState(telegram_id: number): Promise<UserState | null> {
  pruneExpiredCaches();
  const cached = stateCache.get(telegram_id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const { data } = await sb
    .from("user_state")
    .select("*")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  const value = data as UserState | null;
  stateCache.set(telegram_id, { value, expiresAt: Date.now() + STATE_CACHE_TTL_MS });
  return value;
}

export async function setState(
  telegram_id: number,
  state: string,
  context: Record<string, unknown> = {},
) {
  const value: UserState = {
    telegram_id,
    state,
    context,
    start_lock_at: null,
    last_action_at: new Date().toISOString(),
  };
  stateCache.set(telegram_id, { value, expiresAt: Date.now() + STATE_CACHE_TTL_MS });
  await sb.from("user_state").upsert({
    telegram_id,
    state,
    context: context as never,
    last_action_at: value.last_action_at,
  });
}

export async function patchContext(
  telegram_id: number,
  patch: Record<string, unknown>,
) {
  const cached = stateCache.get(telegram_id);
  const cur = cached && cached.expiresAt > Date.now() ? cached.value : await getState(telegram_id);
  const merged = { ...(cur?.context ?? {}), ...patch };
  const value: UserState = {
    telegram_id,
    state: cur?.state ?? "idle",
    context: merged,
    start_lock_at: cur?.start_lock_at ?? null,
    last_action_at: new Date().toISOString(),
  };
  stateCache.set(telegram_id, { value, expiresAt: Date.now() + STATE_CACHE_TTL_MS });
  await sb
    .from("user_state")
    .upsert({
      telegram_id,
      state: cur?.state ?? "idle",
      context: merged as never,
      last_action_at: value.last_action_at,
    });
}

/** Single-flight lock para /start (800ms). Devuelve true si adquirió el lock. */
export async function tryAcquireStartLock(telegram_id: number): Promise<boolean> {
  const now = Date.now();
  const cur = await getState(telegram_id);
  if (cur?.start_lock_at) {
    const lockAge = now - new Date(cur.start_lock_at).getTime();
    if (lockAge < 800) return false;
  }
  await sb.from("user_state").upsert({
    telegram_id,
    state: cur?.state ?? "idle",
    context: (cur?.context ?? {}) as never,
    start_lock_at: new Date(now).toISOString(),
    last_action_at: new Date(now).toISOString(),
  });
  return true;
}

/** Rate limit: máximo N acciones por ventana de segundos. */
export async function checkRateLimit(
  telegram_id: number,
  bucket: string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  pruneExpiredCaches();
  const key = `${telegram_id}:${bucket}`;
  const now = Date.now();
  const existing = rateLimitCache.get(key);
  if (!existing || now - existing.windowStart > windowSec * 1000) {
    rateLimitCache.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
}

export async function isBlocked(telegram_id: number): Promise<boolean> {
  const { data } = await sb
    .from("blocked_users")
    .select("telegram_id, blocked_until")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  if (!data) return false;
  if (!data.blocked_until) return true; // bloqueo permanente
  if (new Date(data.blocked_until).getTime() > Date.now()) return true;
  // Expirado → limpiar
  await sb.from("blocked_users").delete().eq("telegram_id", telegram_id);
  return false;
}

/** Bloquea por minutos. Si ya estaba bloqueado, escala 5min → 24h. */
export async function autoBlock(telegram_id: number, reason: string) {
  const { data: existing } = await sb
    .from("blocked_users")
    .select("infraction_count")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  const next = (existing?.infraction_count ?? 0) + 1;
  const minutes = next >= 2 ? 60 * 24 : 5;
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  await sb
    .from("blocked_users")
    .upsert(
      { telegram_id, reason, blocked_until: until, infraction_count: next },
      { onConflict: "telegram_id" },
    );
  return { minutes, infraction_count: next, blocked_until: until };
}

/** Bloqueo fijo de 24h por spam de comprobantes inválidos. Reincidente → mismo 24h. */
export async function blockSpamReceipt(telegram_id: number) {
  const { data: existing } = await sb
    .from("blocked_users")
    .select("infraction_count")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  const next = (existing?.infraction_count ?? 0) + 1;
  const until = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await sb
    .from("blocked_users")
    .upsert(
      { telegram_id, reason: "spam_receipt", blocked_until: until, infraction_count: next },
      { onConflict: "telegram_id" },
    );
  return { blocked_until: until, infraction_count: next };
}

export async function unblockUser(telegram_id: number) {
  await sb.from("blocked_users").delete().eq("telegram_id", telegram_id);
}

export async function blockUserPermanent(telegram_id: number, reason: string) {
  await sb
    .from("blocked_users")
    .upsert(
      { telegram_id, reason, blocked_until: null, infraction_count: 99 },
      { onConflict: "telegram_id" },
    );
}

export async function getActiveMessage(telegram_id: number) {
  const cached = activeMessageCache.get(telegram_id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const { data } = await sb
    .from("active_messages")
    .select("*")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  const value = data as { telegram_id: number; chat_id: number; message_id: number } | null;
  activeMessageCache.set(telegram_id, { value, expiresAt: Date.now() + ACTIVE_MESSAGE_CACHE_TTL_MS });
  return value;
}

export async function setActiveMessage(
  telegram_id: number,
  chat_id: number,
  message_id: number,
) {
  const value = { telegram_id, chat_id, message_id };
  const cached = activeMessageCache.get(telegram_id);
  activeMessageCache.set(telegram_id, { value, expiresAt: Date.now() + ACTIVE_MESSAGE_CACHE_TTL_MS });
  if (
    cached?.value?.chat_id === chat_id &&
    cached.value.message_id === message_id &&
    cached.expiresAt > Date.now()
  ) {
    return;
  }
  await sb
    .from("active_messages")
    .upsert({ telegram_id, chat_id, message_id });
}

export { sb };
