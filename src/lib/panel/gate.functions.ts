import { createServerFn } from "@tanstack/react-start";
import { useSession } from "@tanstack/react-start/server";
import { createHash, timingSafeEqual } from "node:crypto";

type PanelSession = { unlocked?: boolean; at?: number };

function sessionConfig() {
  const password = process.env.PANEL_SESSION_SECRET;
  if (!password) throw new Error("PANEL_SESSION_SECRET no configurado");
  return {
    password,
    name: "panel-web-session",
    maxAge: 60 * 60 * 24 * 30, // 30 días
    cookie: { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" },
  };
}

function matches(input: string, expected: string): boolean {
  const a = createHash("sha256").update(input, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export const checkPanelSession = createServerFn({ method: "GET" }).handler(async () => {
  const session = await useSession<PanelSession>(sessionConfig());
  return { unlocked: !!session.data.unlocked };
});

export const unlockPanel = createServerFn({ method: "POST" })
  .inputValidator((d: { password: string }) => d)
  .handler(async ({ data }) => {
    const expected = process.env.PANEL_PASSWORD;
    if (!expected) return { ok: false as const, reason: "no-secret" };
    if (!data.password || typeof data.password !== "string") {
      return { ok: false as const, reason: "invalid" };
    }
    if (!matches(data.password, expected)) {
      return { ok: false as const, reason: "wrong" };
    }
    const session = await useSession<PanelSession>(sessionConfig());
    await session.update({ unlocked: true, at: Date.now() });
    return { ok: true as const };
  });

export const lockPanel = createServerFn({ method: "POST" }).handler(async () => {
  const session = await useSession<PanelSession>(sessionConfig());
  await session.clear();
  return { ok: true as const };
});

/** Helper server-side para gate en otros server fns. */
export async function requirePanelUnlocked() {
  const session = await useSession<PanelSession>(sessionConfig());
  if (!session.data.unlocked) {
    throw new Response("Panel bloqueado", { status: 401 });
  }
}
