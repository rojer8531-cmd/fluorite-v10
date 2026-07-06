// Ejecuta el trabajo del webhook garantizando que Telegram reciba una
// respuesta 200 y que ningún handler quede colgado. Estrategia:
//  - Se corre el trabajo con un timeout duro (HARD_TIMEOUT_MS): si algo
//    se cuelga, no bloquea la respuesta a Telegram.
//  - Los errores nunca se propagan al cliente HTTP: se loguean y punto.
//  - Se mantiene una referencia (inflight) para que el runtime no
//    descarte la promesa mientras aún trabaja en background.
const inflight = new Set<Promise<void>>();

// Timeout máximo total del handler. Telegram deja de esperar a los ~60s
// y reintenta; queremos responder mucho antes. 10s es un balance:
// suficiente para operaciones normales (DB + 1-2 sendMessage) sin que
// un handler patológico congele al bot para otros usuarios.
const HARD_TIMEOUT_MS = 10_000;

export async function runTelegramWebhook(
  label: string,
  work: () => Promise<void>,
) {
  const startedAt = Date.now();

  const job = (async () => {
    try {
      await work();
    } catch (err) {
      console.error(`[${label} webhook] error`, err);
    }
  })().finally(() => {
    inflight.delete(job);
    const elapsed = Date.now() - startedAt;
    if (elapsed > 8_000) {
      console.warn(`[${label} webhook] slow handler ${elapsed}ms`);
    }
  });
  inflight.add(job);

  // Devolvemos el control al route handler apenas termine el trabajo o
  // se cumpla el timeout duro. Si vence el timeout, el job sigue vivo
  // en background (referenciado en inflight) para no perder envíos.
  await Promise.race([
    job,
    new Promise<void>((resolve) => setTimeout(resolve, HARD_TIMEOUT_MS)),
  ]);
}
