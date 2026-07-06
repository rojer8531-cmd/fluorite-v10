// Ejecuta el trabajo real del webhook sin bloquear la respuesta HTTP a Telegram.
// La ruta confirma el callback primero y luego mantiene vivo el trabajo con
// waitUntil. Así Telegram no deja botones cargando aunque una acción interna
// tarde o falle.

const SLOW_LOG_MS = 5_000;
const HARD_TIMEOUT_MS = 28_000;

export function keepTelegramPromiseAlive(promise: Promise<unknown>) {
  const g = globalThis as typeof globalThis & {
    __lovableWaitUntil?: (promise: Promise<unknown>) => void;
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  };
  const waitUntil = g.__lovableWaitUntil ?? g.EdgeRuntime?.waitUntil;
  if (typeof waitUntil === "function") {
    try {
      waitUntil(promise);
      return true;
    } catch {
      /* noop */
    }
  }
  return false;
}

export async function runTelegramWebhook(
  label: string,
  work: () => Promise<void>,
) {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`handler timed out after ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS);
  });
  const workPromise = work();
  workPromise.catch((err) => {
    console.error(`[${label} webhook] late error`, err);
  });
  try {
    await Promise.race([workPromise, timeoutPromise]);
  } catch (err) {
    console.error(`[${label} webhook] error`, err);
  } finally {
    if (timeout) clearTimeout(timeout);
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_LOG_MS) {
      console.warn(`[${label} webhook] slow handler ${elapsed}ms`);
    }
  }
}
