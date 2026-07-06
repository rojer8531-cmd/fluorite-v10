// Ejecuta el trabajo del webhook sin bloquear la siguiente interacción.
// La ruta HTTP debe responder rápido a Telegram; el trabajo real queda
// sostenido por waitUntil cuando el runtime lo ofrece.
const inflightByLabel = new Map<string, Set<Promise<void>>>();

const SLOW_LOG_MS = 2_500;
const MAX_INFLIGHT_JOBS = 500;

function getInflight(label: string) {
  let set = inflightByLabel.get(label);
  if (!set) {
    set = new Set<Promise<void>>();
    inflightByLabel.set(label, set);
  }
  return set;
}

export function keepTelegramPromiseAlive(promise: Promise<unknown>) {
  const g = globalThis as typeof globalThis & {
    __lovableWaitUntil?: (promise: Promise<unknown>) => void;
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  };
  const waitUntil = g.__lovableWaitUntil ?? g.EdgeRuntime?.waitUntil;
  if (typeof waitUntil === "function") {
    waitUntil(promise);
  }
}

export async function runTelegramWebhook(
  label: string,
  work: () => Promise<void>,
) {
  const startedAt = Date.now();
  const inflight = getInflight(label);

  if (inflight.size > MAX_INFLIGHT_JOBS) {
    console.warn(`[${label} webhook] too many inflight jobs: ${inflight.size}`);
    return;
  }

  const job = (async () => {
    try {
      await work();
    } catch (err) {
      console.error(`[${label} webhook] error`, err);
    }
  })().finally(() => {
    inflight.delete(job);
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_LOG_MS) {
      console.warn(`[${label} webhook] slow handler ${elapsed}ms`);
    }
  });
  inflight.add(job);
  keepTelegramPromiseAlive(job);

  // No esperamos todo el flujo: así Telegram puede entregar el siguiente tap
  // inmediatamente aunque la acción anterior todavía esté editando/enviando.
}
