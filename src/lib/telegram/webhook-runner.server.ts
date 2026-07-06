// Ejecuta el trabajo del webhook sin dejar a Telegram esperando.
// El bot debe contestar rápido incluso si una consulta/acción tarda.
const inflight = new Set<Promise<void>>();

// Espera mínima para permitir que callbacks manden el ACK inmediato y luego
// devolvemos 200 a Telegram. El trabajo sigue referenciado en background.
const ACK_WAIT_MS = 350;
const SLOW_LOG_MS = 2_500;
const MAX_INFLIGHT_JOBS = 500;

export async function runTelegramWebhook(
  label: string,
  work: () => Promise<void>,
) {
  const startedAt = Date.now();

  if (inflight.size > MAX_INFLIGHT_JOBS) {
    console.warn(`[${label} webhook] too many inflight jobs: ${inflight.size}`);
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

  // La ruta HTTP no debe esperar todo el flujo del bot. Si una función tarda,
  // Telegram igual recibe OK rápido y no reintenta ni deja botones colgados.
  await Promise.race([
    job,
    new Promise<void>((resolve) => setTimeout(resolve, ACK_WAIT_MS)),
  ]);
}
