import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { answerCallbackQuery } from "@/lib/telegram/api.server";
import { handleShopUpdate } from "@/lib/telegram/shop-handler.server";
import { keepTelegramPromiseAlive, runTelegramWebhook } from "@/lib/telegram/webhook-runner.server";

async function quickAck(callbackId?: string, data?: string) {
  if (!callbackId) return;
  if (data?.startsWith("shlink:")) return;
  const ack = answerCallbackQuery("shop", callbackId);
  keepTelegramPromiseAlive(ack);
  await Promise.race([
    ack,
    new Promise<void>((resolve) => setTimeout(resolve, 900)),
  ]).catch(() => {});
}

function deriveSecret(token: string) {
  return createHash("sha256").update(`tg-webhook:${token}`).digest("base64url");
}
function deriveLegacySecret(token: string) {
  return createHash("sha256").update(`telegram-webhook:${token}`).digest("base64url");
}
function safeEq(a: string, b: string) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}
function isValidWebhookSecret(got: string, token: string) {
  return safeEq(got, deriveSecret(token)) || safeEq(got, deriveLegacySecret(token));
}

function getQueueKey(update: any) {
  return update?.callback_query?.from?.id ?? update?.message?.from?.id ?? update?.message?.chat?.id;
}

export const Route = createFileRoute("/api/public/telegram/shop")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = process.env.TELEGRAM_SHOP_BOT_TOKEN;
        if (!token) return new Response("Missing token", { status: 500 });
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!isValidWebhookSecret(got, token)) return new Response("Unauthorized", { status: 401 });
        const update = await request.json();
        await quickAck(update?.callback_query?.id, update?.callback_query?.data);
        await runTelegramWebhook("shop", () => handleShopUpdate(update), getQueueKey(update));
        return Response.json({ ok: true });
      },
    },
  },
});
