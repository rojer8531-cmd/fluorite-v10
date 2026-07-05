import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { unlockPanel } from "@/lib/panel/gate.functions";
import { Lock } from "lucide-react";

export const Route = createFileRoute("/panel/unlock")({ component: Unlock });

function Unlock() {
  const router = useRouter();
  const unlock = useServerFn(unlockPanel);
  const [pwd, setPwd] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const r = await unlock({ data: { password: pwd } });
      if (r.ok) {
        await router.invalidate();
        router.navigate({ to: "/panel/inventario" });
      } else {
        setErr("Contraseña incorrecta");
      }
    } catch {
      setErr("Error de red, intenta de nuevo");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[80dvh] items-center justify-center px-2">
      <div className="w-full max-w-sm rounded-3xl border border-white/15 bg-white/10 p-7 backdrop-blur-2xl shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]">
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-xl border border-white/20">
            <Lock className="h-6 w-6 text-white" />
          </div>
          <div className="text-center">
            <div className="text-lg font-semibold">Panel Web</div>
            <div className="text-sm text-white/60">Ingresa la contraseña de administración</div>
          </div>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            inputMode="text"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="Contraseña"
            className="w-full rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-base text-white placeholder-white/40 outline-none backdrop-blur-xl focus:border-white/40"
          />
          {err && <div className="text-center text-sm text-red-300">{err}</div>}
          <button
            type="submit"
            disabled={loading || pwd.length === 0}
            className="w-full rounded-2xl bg-white py-3 text-base font-semibold text-[#0b1a3a] disabled:opacity-60 active:scale-[0.99] transition"
          >
            {loading ? "Verificando…" : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
