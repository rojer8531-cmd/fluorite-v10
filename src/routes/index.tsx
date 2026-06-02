import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sistema Telegram Bot — Panel" },
      { name: "description", content: "Backend del sistema de tienda Telegram con bots Compras + Admin." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Index,
});

function Index() {
  const setupUrl = "/api/public/telegram/setup";
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-2 rounded-full bg-emerald-500" /> Backend activo
          </div>
          <h1 className="text-4xl font-bold tracking-tight">Sistema Telegram Bot</h1>
          <p className="mt-3 text-muted-foreground">
            Tienda privada con bots de Compras y Admin · Saldo · Comprobantes anti-duplicado · Entrega
            automática de keys · 24/7 serverless.
          </p>
        </header>

        <section className="mb-10 rounded-xl border border-border bg-card p-6">
          <h2 className="mb-3 text-lg font-semibold">1. Registrar los webhooks</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Abrí esta URL <b>una sola vez</b> para registrar ambos bots contra Telegram. Devuelve JSON con
            el estado de la configuración.
          </p>
          <a
            href={setupUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Ejecutar /api/public/telegram/setup
          </a>
        </section>

        <section className="mb-10 grid gap-4 sm:grid-cols-2">
          <Card title="🤖 Bot Compras">
            Usuarios hacen <code className="rounded bg-muted px-1">/start</code>, login con contraseña
            <code className="ml-1 rounded bg-muted px-1">117</code>, eligen producto · duración · cantidad ·
            país · pagan y envían foto del comprobante.
          </Card>
          <Card title="🛠 Bot Admin">
            Recibe cada comprobante con la foto completa y botones para <b>Aprobar</b>, <b>Rechazar</b>,
            <b> Bloquear</b> o enviar <b>Key Manual</b>. Comandos:
            <code className="ml-1 rounded bg-muted px-1">/pendientes</code>{" "}
            <code className="rounded bg-muted px-1">/stock</code>{" "}
            <code className="rounded bg-muted px-1">/usuarios</code>.
          </Card>
        </section>

        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-3 text-lg font-semibold">Garantías técnicas</h2>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>✅ <b>/start nunca se congela</b> — debounce 800ms + lock persistente en DB.</li>
            <li>✅ <b>Comprobantes válidos</b> — solo fotos reales (no documentos, mín. 200×200).</li>
            <li>✅ <b>Anti-duplicado 24h</b> — fingerprint por <code>file_unique_id</code>.</li>
            <li>✅ <b>Imagen completa al admin</b> — descarga + re-upload entre bots (sendPhoto).</li>
            <li>✅ <b>100% privado</b> — cada mensaje va solo al chat del dueño.</li>
            <li>✅ <b>Retry exponencial</b> contra rate limits de Telegram.</li>
            <li>✅ <b>14 métodos de pago</b> cargados (Mercado Pago, Pix, Nequi, Zelle, Binance, etc.).</li>
            <li>✅ <b>Rangos automáticos</b>: Pro ≥ $50 recargados · Leyenda ≥ $200.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
