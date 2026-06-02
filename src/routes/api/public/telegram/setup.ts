// Endpoint para registrar los webhooks contra Telegram. Visitar en navegador.
import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "crypto";
import { setWebhook, getWebhookInfo } from "@/lib/telegram/api.server";

function deriveSecret(token: string) {
  return createHash("sha256").update(`tg-webhook:${token}`).digest("base64url");
}

export const Route = createFileRoute("/api/public/telegram/setup")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        // forzar host estable público (project--<id>.lovable.app o dev)
        const host = request.headers.get("host") ?? url.host;
        const proto = "https";
        const base = `${proto}://${host}`;
        const shopUrl = `${base}/api/public/telegram/shop`;
        const adminUrl = `${base}/api/public/telegram/admin`;

        const shopToken = process.env.TELEGRAM_SHOP_BOT_TOKEN;
        const adminToken = process.env.TELEGRAM_ADMIN_BOT_TOKEN;
        const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
        if (!shopToken || !adminToken || !adminChatId) {
          return Response.json(
            { ok: false, error: "Faltan secrets TELEGRAM_*" },
            { status: 500 },
          );
        }

        const shopSecret = deriveSecret(shopToken);
        const adminSecret = deriveSecret(adminToken);

        const [shopSet, adminSet, shopInfo, adminInfo] = await Promise.all([
          setWebhook("shop", shopUrl, shopSecret),
          setWebhook("admin", adminUrl, adminSecret),
          getWebhookInfo("shop"),
          getWebhookInfo("admin"),
        ]);

        return Response.json({
          ok: shopSet.ok && adminSet.ok,
          shop: { url: shopUrl, set: shopSet, info: shopInfo },
          admin: { url: adminUrl, set: adminSet, info: adminInfo },
          admin_chat_id: adminChatId,
        });
      },
    },
  },
});
