export async function runTelegramWebhook(
  label: string,
  work: () => Promise<void>,
  timeoutMs = 7_500,
) {
  const job = work().catch((err) => {
    console.error(`[${label} webhook] error`, err);
  });

  const timedOut = await Promise.race([
    job.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
  ]);

  if (timedOut) {
    console.warn(`[${label} webhook] still processing after ${timeoutMs}ms; Telegram was acknowledged.`);
    job.catch(() => {});
  }
}