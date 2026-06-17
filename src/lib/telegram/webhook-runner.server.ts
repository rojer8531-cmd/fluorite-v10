// Lista de jobs en vuelo: mantenemos referencias para que el runtime
// no descarte las promesas mientras siguen ejecutándose en background
// después de que ya respondimos a Telegram.
const inflight = new Set<Promise<void>>();

export async function runTelegramWebhook(
  label: string,
  work: () => Promise<void>,
  // Ventana mínima para que el primer sendMessage/answerCallbackQuery
  // se despache antes de devolver 200 a Telegram. Si el handler tarda
  // más, soltamos la respuesta y dejamos el resto en background.
  ackAfterMs = 1_500,
) {
  const job = work()
    .catch((err) => {
      console.error(`[${label} webhook] error`, err);
    })
    .finally(() => {
      inflight.delete(job);
    });
  inflight.add(job);

  // Espera corta: si el trabajo termina rápido, perfecto; si no, devolvemos
  // ACK a Telegram para que no reintente ni encole otra actualización, y
  // dejamos el job corriendo. Esto multiplica la capacidad de mensajes
  // concurrentes que el bot puede atender sin congelarse.
  await Promise.race([
    job.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ackAfterMs)),
  ]);
}