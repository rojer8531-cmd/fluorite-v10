import { createFileRoute } from "@tanstack/react-router";
import { getMe, sendMessage, getAdminChatId, type BotKind } from "@/lib/telegram/api.server";
import { sb } from "@/lib/telegram/db.server";

const BOTS: BotKind[] = ["shop", "admin", "warehouse"];

async function checkAlertCooldown(bot: string): Promise<boolean> {
  // Máximo 1 alerta por bot cada 30 min, basado en admin_logs
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data } = await sb
    .from("admin_logs")
    .select("id")
    .eq("action", "tg_health_alert")
    .eq("target_id", bot)
    .gte("created_at", since)
    .limit(1);
  if (data && data.length > 0) return false;
  await sb.from("admin_logs").insert({
    admin_telegram_id: 0,
    action: "tg_health_alert",
    target_type: "telegram_api",
    target_id: bot,
  });
  return true;
}


async function handle() {
  const results: Record<string, { ok: boolean; username?: string; error?: string }> = {};
  for (const b of BOTS) {
    const r = await getMe(b);
    results[b] = r.ok
      ? { ok: true, username: (r.result as { username?: string } | undefined)?.username }
      : { ok: false, error: r.description };
    if (!r.ok) {
      const adminChat = getAdminChatId();
      if (adminChat && (await checkAlertCooldown(b))) {
        await sendMessage(
          "admin",
          adminChat,
          `⚠️ <b>Bot ${b} caído</b>\n<code>${(r.description ?? "unknown").slice(0, 200)}</code>`,
        );
      }
      await sb.from("admin_logs").insert({
        admin_telegram_id: 0,
        action: "tg_health_down",
        target_type: "telegram_api",
        target_id: b,
        details: { error: r.description, code: r.error_code } as never,
      });
    }
  }
  return Response.json({ ok: true, bots: results, ts: new Date().toISOString() });
}

export const Route = createFileRoute("/api/public/telegram/health")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
