import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = supabaseAdmin;

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
  rank: "normal" | "pro" | "leyenda";
}

export async function getOrCreateUser(opts: {
  telegram_id: number;
  chat_id: number;
  username?: string;
}): Promise<BotUser> {
  const { data: existing } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_id", opts.telegram_id)
    .maybeSingle();
  if (existing) {
    await sb
      .from("bot_users")
      .update({ last_seen_at: new Date().toISOString(), chat_id: opts.chat_id })
      .eq("telegram_id", opts.telegram_id);
    return existing as BotUser;
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
  if (error) throw error;
  return created as BotUser;
}

export async function updateUser(
  telegram_id: number,
  patch: Partial<BotUser>,
) {
  await sb.from("bot_users").update(patch).eq("telegram_id", telegram_id);
}

export async function updateRankFromRecharged(telegram_id: number) {
  const { data: u } = await sb
    .from("bot_users")
    .select("total_recharged")
    .eq("telegram_id", telegram_id)
    .single();
  if (!u) return;
  let rank: "normal" | "pro" | "leyenda" = "normal";
  if (u.total_recharged >= 200) rank = "leyenda";
  else if (u.total_recharged >= 50) rank = "pro";
  await sb.from("bot_users").update({ rank }).eq("telegram_id", telegram_id);
}

export interface UserState {
  telegram_id: number;
  state: string;
  context: Record<string, unknown>;
  start_lock_at: string | null;
  last_action_at: string;
}

export async function getState(telegram_id: number): Promise<UserState | null> {
  const { data } = await sb
    .from("user_state")
    .select("*")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  return data as UserState | null;
}

export async function setState(
  telegram_id: number,
  state: string,
  context: Record<string, unknown> = {},
) {
  await sb.from("user_state").upsert({
    telegram_id,
    state,
    context,
    last_action_at: new Date().toISOString(),
  });
}

export async function patchContext(
  telegram_id: number,
  patch: Record<string, unknown>,
) {
  const cur = await getState(telegram_id);
  const merged = { ...(cur?.context ?? {}), ...patch };
  await sb
    .from("user_state")
    .upsert({
      telegram_id,
      state: cur?.state ?? "idle",
      context: merged,
      last_action_at: new Date().toISOString(),
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
    context: cur?.context ?? {},
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
  const now = new Date();
  const { data: existing } = await sb
    .from("rate_limits")
    .select("*")
    .eq("telegram_id", telegram_id)
    .eq("bucket", bucket)
    .maybeSingle();
  if (!existing) {
    await sb.from("rate_limits").insert({
      telegram_id,
      bucket,
      count: 1,
      window_start: now.toISOString(),
    });
    return true;
  }
  const winAge = (now.getTime() - new Date(existing.window_start).getTime()) / 1000;
  if (winAge > windowSec) {
    await sb
      .from("rate_limits")
      .update({ count: 1, window_start: now.toISOString() })
      .eq("telegram_id", telegram_id)
      .eq("bucket", bucket);
    return true;
  }
  if (existing.count >= max) return false;
  await sb
    .from("rate_limits")
    .update({ count: existing.count + 1 })
    .eq("telegram_id", telegram_id)
    .eq("bucket", bucket);
  return true;
}

export async function isBlocked(telegram_id: number): Promise<boolean> {
  const { data } = await sb
    .from("blocked_users")
    .select("telegram_id")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  return !!data;
}

export async function getActiveMessage(telegram_id: number) {
  const { data } = await sb
    .from("active_messages")
    .select("*")
    .eq("telegram_id", telegram_id)
    .maybeSingle();
  return data as { telegram_id: number; chat_id: number; message_id: number } | null;
}

export async function setActiveMessage(
  telegram_id: number,
  chat_id: number,
  message_id: number,
) {
  await sb
    .from("active_messages")
    .upsert({ telegram_id, chat_id, message_id });
}

export { sb };
