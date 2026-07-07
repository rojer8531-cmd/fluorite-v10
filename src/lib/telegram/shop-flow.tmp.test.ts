import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleShopUpdate } from "./shop-handler.server";
import { sb } from "./db.server";

const TEST_ID = 990300001;
const CHAT_ID = 990300001;
let messageId = 1000;
let calls: Array<{ method: string; payload: any }> = [];
const originalFetch = globalThis.fetch;

function tgResponse(method: string) {
  if (method === "getMe") return { ok: true, result: { id: 1, username: "wildzinv_bot", is_bot: true } };
  if (method === "getFile") return { ok: true, result: { file_id: "f", file_path: "photos/file.jpg", file_size: 10 } };
  return { ok: true, result: { message_id: ++messageId, chat: { id: CHAT_ID } } };
}

beforeEach(async () => {
  calls = [];
  messageId = 1000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").pop() || "";
      let payload: any = {};
      if (init?.body instanceof FormData) {
        payload = Object.fromEntries(init.body.entries());
      } else if (typeof init?.body === "string") {
        payload = JSON.parse(init.body);
      }
      calls.push({ method, payload });
      return new Response(JSON.stringify(tgResponse(method)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  await sb.from("active_messages").delete().eq("telegram_id", TEST_ID);
  await sb.from("user_state").delete().eq("telegram_id", TEST_ID);
  await sb.from("orders").delete().eq("telegram_id", TEST_ID);
  await sb.from("bot_users").delete().eq("telegram_id", TEST_ID);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await sb.from("active_messages").delete().eq("telegram_id", TEST_ID);
  await sb.from("user_state").delete().eq("telegram_id", TEST_ID);
  await sb.from("orders").delete().eq("telegram_id", TEST_ID);
  await sb.from("bot_users").delete().eq("telegram_id", TEST_ID);
});

function msg(text: string, mid = ++messageId) {
  return {
    update_id: mid,
    message: {
      message_id: mid,
      from: { id: TEST_ID, username: "test_user", first_name: "Test" },
      chat: { id: CHAT_ID },
      text,
    },
  } as any;
}

function cb(data: string, mid = 2000) {
  return {
    update_id: ++messageId,
    callback_query: {
      id: `cb_${messageId}`,
      from: { id: TEST_ID, username: "test_user", first_name: "Test" },
      message: { message_id: mid, chat: { id: CHAT_ID }, text: "screen" },
      data,
    },
  } as any;
}

function lastText() {
  return [...calls].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText")?.payload?.text || "";
}

describe("shop bot critical flow", () => {
  it("responds to start, name, menu and main functions", async () => {
    await handleShopUpdate(msg("/start"));
    expect(lastText()).toContain("Cuál es tu nombre");

    await handleShopUpdate(msg("Cliente Prueba"));
    expect(lastText()).toContain("Inicio");

    await handleShopUpdate(msg("🛒 Productos"));
    expect(lastText()).toContain("Elegí una categoría");

    await handleShopUpdate(cb("cat:iOS"));
    expect(lastText()).toContain("Elegí un producto");

    await handleShopUpdate(msg("💰 Recargar Saldo"));
    expect(lastText()).toContain("Elegí tu país");

    await handleShopUpdate(cb("rcc:NI"));
    expect(lastText()).toContain("Cuánto deseas recargar");

    await handleShopUpdate(msg("10"));
    expect(lastText()).toContain("Métodos De Pago");

    await handleShopUpdate(msg("👤 Mi Perfil"));
    expect(lastText()).toContain("Mi Perfil");

    await handleShopUpdate(msg("💳 Comprar"));
    expect(lastText()).toContain("Elegí una categoría");
  });
});