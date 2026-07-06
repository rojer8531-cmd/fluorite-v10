import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { handleShopUpdate } from "@/lib/telegram/shop-handler.server";
import { runTelegramWebhook } from "@/lib/telegram/webhook-runner.server";

function deriveSecret(token: string) {
  return createHash("sha256").update(`tg-webhook:${token}`).digest("base64url");
}
function safeEq(a: string, b: string) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

export const Route = createFileRoute("/api/public/telegram/shop")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = process.env.TELEGRAM_SHOP_BOT_TOKEN;
        if (!token) return new Response("Missing token", { status: 500 });
        const expected = deriveSecret(token);
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEq(got, expected)) return new Response("Unauthorized", { status: 401 });
        const update = await request.json();
        const startLike = typeof update?.message?.text === "string" && update.message.text.trim().startsWith("/start");
        await runTelegramWebhook("shop", () => handleShopUpdate(update));
        return Response.json({ ok: true });
      },
    },
  },
});
