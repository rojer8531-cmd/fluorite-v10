import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/panel/")({
  component: () => <div className="pt-10 text-center text-white/60">Cargando…</div>,
});
