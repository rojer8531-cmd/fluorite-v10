import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { GlassCard } from "./inventario";
import { createServerFn } from "@tanstack/react-start";
import { requirePanelUnlocked } from "@/lib/panel/gate.functions";

export const Route = createFileRoute("/panel/config")({ component: Config });

const listLogs = createServerFn({ method: "GET" }).handler(async () => {
  await requirePanelUnlocked();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("panel_action_logs").select("*").order("created_at", { ascending: false }).limit(100);
  return data ?? [];
});

function Config() {
  const fn = useServerFn(listLogs);
  const { data: logs = [] } = useQuery({ queryKey: ["panel", "logs"], queryFn: () => fn(), staleTime: 10_000 });

  return (
    <div className="space-y-3">
      <GlassCard>
        <div className="text-sm font-semibold">Configuración</div>
        <div className="mt-2 text-[11px] text-white/60">Nombre del sistema, logotipo, colores, mantenimiento y respaldo llegan en la próxima fase.</div>
      </GlassCard>

      <GlassCard>
        <div className="mb-2 text-sm font-semibold">Registro de acciones · últimas 100</div>
        <div className="max-h-[55dvh] space-y-1 overflow-y-auto pr-1">
          {logs.map((l) => (
            <div key={l.id} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-mono">{l.action}</span>
                <span className="text-white/50">{new Date(l.created_at).toLocaleString()}</span>
              </div>
              {l.entity && <div className="mt-0.5 text-white/50">{l.entity} · {l.entity_id ?? "—"}</div>}
            </div>
          ))}
          {logs.length === 0 && <div className="py-8 text-center text-xs text-white/50">Sin registros aún</div>}
        </div>
      </GlassCard>
    </div>
  );
}
