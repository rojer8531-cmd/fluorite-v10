// Ejecuta el trabajo del webhook. Volvemos al comportamiento original:
// esperamos a que la acción termine antes de responder 200 a Telegram.
// Telegram permite múltiples conexiones concurrentes (max_connections=100),
// así que distintos taps del mismo o de otros usuarios no se bloquean entre sí.

const SLOW_LOG_MS = 5_000;

export function keepTelegramPromiseAlive(promise: Promise<unknown>) {
  const g = globalThis as typeof globalThis & {
    __lovableWaitUntil?: (promise: Promise<unknown>) => void;
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  };
  const waitUntil = g.__lovableWaitUntil ?? g.EdgeRuntime?.waitUntil;
  if (typeof waitUntil === "function") {
    try {
      waitUntil(promise);
    } catch {
      /* noop */
    }
  }
}

export async function runTelegramWebhook(
  label: string,
  work: () => Promise<void>,
) {
  const startedAt = Date.now();
  try {
    await work();
  } catch (err) {
    console.error(`[${label} webhook] error`, err);
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_LOG_MS) {
      console.warn(`[${label} webhook] slow handler ${elapsed}ms`);
    }
  }
}
