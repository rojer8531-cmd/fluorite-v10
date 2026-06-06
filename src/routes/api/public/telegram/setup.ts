// Endpoint para registrar los webhooks contra Telegram. Visitar en navegador.
import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "crypto";
import { setWebhook, getWebhookInfo } from "@/lib/telegram/api.server";

function deriveSecret(token: string) {
  return createHash("sha256").update(`tg-webhook:${token}`).digest("base64url");
}

function resolveStableBaseUrl(url: URL, hostHeader?: string | null) {
  const envProjectId = process.env.LOVABLE_PROJECT_ID ?? process.env.__LOVABLE_PROJECT_ID;
  const currentHost = hostHeader ?? url.host;

  if (envProjectId) {
    if (currentHost.includes("lovable.app")) {
      return `https://project--${envProjectId}-dev.lovable.app`;
    }
    const customHost = currentHost.replace(/^id-preview--[^.]+\./, "");
    if (customHost !== currentHost) {
      return `https://project--${envProjectId}-dev.${customHost}`;
    }
  }

  if (currentHost.startsWith("project--")) {
    return `https://${currentHost}`;
  }

  return `${url.protocol}//${currentHost}`;
}

export const Route = createFileRoute("/api/public/telegram/setup")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const base = resolveStableBaseUrl(url, request.headers.get("host"));
        const shopUrl = `${base}/api/public/telegram/shop`;
        const adminUrl = `${base}/api/public/telegram/admin`;
        const warehouseUrl = `${base}/api/public/telegram/warehouse`;

        const shopToken = process.env.TELEGRAM_SHOP_BOT_TOKEN;
        const adminToken = process.env.TELEGRAM_ADMIN_BOT_TOKEN;
        const warehouseToken = process.env.TELEGRAM_WAREHOUSE_BOT_TOKEN;
        const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
        const warehouseChatId = process.env.TELEGRAM_WAREHOUSE_CHAT_ID;
        if (!shopToken || !adminToken || !warehouseToken || !adminChatId || !warehouseChatId) {
          return Response.json(
            { ok: false, error: "Faltan secrets TELEGRAM_*" },
            { status: 500 },
          );
        }

        const shopSecret = deriveSecret(shopToken);
        const adminSecret = deriveSecret(adminToken);
        const warehouseSecret = deriveSecret(warehouseToken);

        const [shopSet, adminSet, warehouseSet, shopInfo, adminInfo, warehouseInfo] = await Promise.all([
          setWebhook("shop", shopUrl, shopSecret),
          setWebhook("admin", adminUrl, adminSecret),
          setWebhook("warehouse", warehouseUrl, warehouseSecret),
          getWebhookInfo("shop"),
          getWebhookInfo("admin"),
          getWebhookInfo("warehouse"),
        ]);

        return Response.json({
          ok: shopSet.ok && adminSet.ok && warehouseSet.ok,
          shop: { url: shopUrl, set: shopSet, info: shopInfo },
          admin: { url: adminUrl, set: adminSet, info: adminInfo },
          warehouse: { url: warehouseUrl, set: warehouseSet, info: warehouseInfo },
          admin_chat_id: adminChatId,
          warehouse_chat_id: warehouseChatId,
        });
      },
    },
  },
});
