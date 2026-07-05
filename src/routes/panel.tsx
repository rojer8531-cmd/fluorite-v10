import { createFileRoute, Outlet, Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { checkPanelSession, lockPanel } from "@/lib/panel/gate.functions";
import bgAsset from "@/assets/panel-bg.jpeg.asset.json";
import { Package, Users, Wand2, Settings, LogOut } from "lucide-react";

export const Route = createFileRoute("/panel")({
  head: () => ({
    meta: [
      { title: "Panel Web · Administración" },
      { name: "description", content: "Panel administrativo del sistema Telegram." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PanelLayout,
});

const TABS = [
  { to: "/panel/inventario", label: "Inventario", icon: Package },
  { to: "/panel/usuarios", label: "Usuarios", icon: Users },
  { to: "/panel/editor", label: "Editor Bot", icon: Wand2 },
  { to: "/panel/config", label: "Configuración", icon: Settings },
];

function PanelLayout() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const check = useServerFn(checkPanelSession);
  const lock = useServerFn(lockPanel);

  const { data, isLoading } = useQuery({ queryKey: ["panel-session"], queryFn: () => check(), staleTime: 60_000 });

  useEffect(() => {
    if (isLoading) return;
    if (!data?.unlocked && !pathname.startsWith("/panel/unlock")) {
      router.navigate({ to: "/panel/unlock" });
    }
    if (data?.unlocked && pathname === "/panel/unlock") {
      router.navigate({ to: "/panel/inventario" });
    }
    if (data?.unlocked && pathname === "/panel") {
      router.navigate({ to: "/panel/inventario" });
    }
  }, [data, isLoading, pathname, router]);

  const showChrome = data?.unlocked && !pathname.startsWith("/panel/unlock");

  return (
    <div
      className="min-h-[100dvh] w-full bg-[#0b1a3a] text-white antialiased"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(8,16,40,0.55) 0%, rgba(8,16,40,0.85) 100%), url(${bgAsset.url})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
      }}
    >
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col pb-[calc(96px+env(safe-area-inset-bottom))] pt-[env(safe-area-inset-top)]">
        {showChrome && (
          <header className="sticky top-0 z-30 flex items-center justify-between px-5 py-4 backdrop-blur-2xl" style={{ background: "linear-gradient(180deg, rgba(10,20,45,0.75), rgba(10,20,45,0.35))" }}>
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/60">Panel Web</div>
              <div className="text-lg font-semibold">Administración</div>
            </div>
            <button
              onClick={async () => { await lock(); router.navigate({ to: "/panel/unlock" }); }}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 backdrop-blur-xl active:scale-95 transition"
              aria-label="Cerrar sesión"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </header>
        )}
        <main className="flex-1 px-4 pb-6">
          <Outlet />
        </main>
      </div>

      {showChrome && (
        <nav
          className="fixed bottom-0 left-1/2 z-40 -translate-x-1/2 w-full max-w-2xl px-4 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2"
        >
          <div className="flex items-stretch justify-between gap-1 rounded-3xl border border-white/15 bg-white/10 p-2 backdrop-blur-2xl shadow-[0_20px_60px_-20px_rgba(0,0,0,0.6)]">
            {TABS.map((t) => {
              const active = pathname.startsWith(t.to);
              const Icon = t.icon;
              return (
                <Link
                  key={t.to}
                  to={t.to}
                  className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 transition ${active ? "bg-white text-[#0b1a3a] shadow-lg" : "text-white/80 active:bg-white/10"}`}
                >
                  <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2.4 : 2} />
                  <span className="text-[10px] font-semibold tracking-wide">{t.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
