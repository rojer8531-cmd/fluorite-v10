import { createFileRoute } from "@tanstack/react-router";
import { GlassCard } from "./inventario";
import { Wand2 } from "lucide-react";

export const Route = createFileRoute("/panel/editor")({ component: Editor });

function Editor() {
  return (
    <div className="space-y-3">
      <GlassCard>
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur-xl border border-white/20">
            <Wand2 className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold">Editor Bot de Compras</div>
            <div className="text-[11px] text-white/60">Textos, botones y menús editables sin reiniciar el bot.</div>
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
          Próxima fase. La estructura de datos para editar textos y botones ya está preparada;
          la interfaz visual llegará en la siguiente entrega para no comprometer la estabilidad del bot.
        </div>
      </GlassCard>
    </div>
  );
}
