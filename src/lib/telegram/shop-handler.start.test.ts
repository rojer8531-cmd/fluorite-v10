import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks =====
// `sb` debe estar declarado antes del vi.mock por la hoisting de Vitest.
const sb = {
  from: vi.fn(),
  rpc: vi.fn(),
};

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: sb,
}));

vi.mock("./db.server", async () => {
  const actual = await vi.importActual<any>("./db.server");
  return {
    ...actual,
    sb,
    getOrCreateUser: vi.fn(async () => ({ telegram_id: 999, chat_id: 999 })),
    isBlocked: vi.fn(async () => false),
    checkRateLimit: vi.fn(async () => true),
    tryAcquireStartLock: vi.fn(async () => true),
    getState: vi.fn(async () => ({ state: "menu", context: {} })),
    setState: vi.fn(async () => {}),
    patchContext: vi.fn(async () => {}),
    getActiveMessage: vi.fn(async () => null),
    setActiveMessage: vi.fn(async () => {}),
  };
});

// Capturamos cada llamada a la Bot API para auditar comportamiento.
const tgCalls: Array<{ method: string; body: any }> = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  tgCalls.push({ method, body });
  return new Response(
    JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body?.chat_id ?? 0 } } }),
    { headers: { "Content-Type": "application/json" } },
  );
});

beforeEach(() => {
  tgCalls.length = 0;
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as any;
  process.env.TELEGRAM_SHOP_BOT_TOKEN = "test:shop";
  process.env.TELEGRAM_SHOP_BOT_USERNAME = "shopbot";
  // Stub mínimo de `sb.from(...).select(...).eq(...).single()` para devolver
  // un usuario autenticado al recibir /start.
  sb.from.mockImplementation((table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: { is_authenticated: true } }),
      single: async () => ({
        data: { telegram_id: 999, chat_id: 999, is_authenticated: true },
      }),
      update: () => builder,
      insert: () => builder,
      delete: () => builder,
      order: () => builder,
      limit: () => builder,
      neq: () => builder,
      not: () => builder,
    };
    return builder;
  });
  sb.rpc.mockResolvedValue({ data: { ok: false }, error: null });
});

describe("/start — bot de compras", () => {
  it("usuario autenticado: NO envía ningún mensaje extra ni teclado", async () => {
    const { handleShopUpdate } = await import("./shop-handler.server");
    await handleShopUpdate({
      message: {
        message_id: 42,
        from: { id: 999, username: "u" },
        chat: { id: 999 },
        text: "/start",
      },
    } as any);

    const sendCalls = tgCalls.filter((c) => c.method === "sendMessage");
    expect(sendCalls).toHaveLength(0);
    // Sólo debería haber, como mucho, el borrado del bubble del /start del usuario.
    const others = tgCalls.filter(
      (c) => c.method !== "sendMessage" && c.method !== "deleteMessage",
    );
    expect(others).toHaveLength(0);
  });

  it("usuario autenticado: borra el mensaje /start del usuario para dejar el chat limpio", async () => {
    const { handleShopUpdate } = await import("./shop-handler.server");
    await handleShopUpdate({
      message: {
        message_id: 42,
        from: { id: 999, username: "u" },
        chat: { id: 999 },
        text: "/start",
      },
    } as any);

    const deletes = tgCalls.filter((c) => c.method === "deleteMessage");
    expect(deletes.some((c) => c.body?.message_id === 42)).toBe(true);
  });
});
