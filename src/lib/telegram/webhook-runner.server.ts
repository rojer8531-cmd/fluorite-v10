// Ejecuta el trabajo del webhook de forma confiable.
// Importante: en producción el runtime puede cancelar tareas "en background"
// cuando la ruta HTTP responde. Por eso NO soltamos el trabajo a medias: cada
// update debe terminar su primera respuesta/estado antes de devolver 200.
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

  // Esperamos el trabajo real para que /start, callbacks y cambios de estado
  // no se pierdan por tareas canceladas después del Response.
  await job;
}
