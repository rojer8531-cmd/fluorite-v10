import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { listUsers, updateUserRank, updateUserBalance, blockUser24h, blockUserPermanent, unblockUser } from "@/lib/panel/usuarios.functions";
import avatarAsset from "@/assets/panel-avatar.jpeg.asset.json";
import { GlassCard } from "./inventario";
import { Search, ShieldOff, ShieldCheck, Ban } from "lucide-react";

export const Route = createFileRoute("/panel/usuarios")({ component: Usuarios });

const RANKS = ["gold", "platinum", "diamond", "elite"] as const;
const RANK_LABELS: Record<string, string> = { gold: "Gold", platinum: "Platinum", diamond: "Diamond", elite: "Elite" };

function Usuarios() {
  const listFn = useServerFn(listUsers);
  const rankFn = useServerFn(updateUserRank);
  const balFn = useServerFn(updateUserBalance);
  const b24 = useServerFn(blockUser24h);
  const bPerm = useServerFn(blockUserPermanent);
  const unblock = useServerFn(unblockUser);

  const [search, setSearch] = useState("");
  const [rankFilter, setRankFilter] = useState<string>("");

  const { data: users = [], refetch } = useQuery({
    queryKey: ["panel", "users", search, rankFilter],
    queryFn: () => listFn({ data: { search: search || undefined, rank: rankFilter || undefined } }),
    staleTime: 5_000,
  });

  const sorted = useMemo(() => {
    const order: Record<string, number> = { elite: 0, diamond: 1, platinum: 2, gold: 3 };
    return [...users].sort((a, b) => (order[a.rank] ?? 9) - (order[b.rank] ?? 9));
  }, [users]);

  return (
    <div className="space-y-3">
      <GlassCard>
        <div className="mb-2 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50" />
            <input
              placeholder="Buscar por ID, usuario o nombre"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-white/15 bg-white/10 py-2 pl-8 pr-3 text-sm text-white placeholder-white/40 outline-none backdrop-blur-xl"
            />
          </div>
          <select value={rankFilter} onChange={(e) => setRankFilter(e.target.value)} className="rounded-xl border border-white/15 bg-white/10 px-2 py-2 text-sm text-white outline-none backdrop-blur-xl">
            <option value="">Todos</option>
            {RANKS.map((r) => <option key={r} value={r}>{RANK_LABELS[r]}</option>)}
          </select>
        </div>
        <div className="text-xs text-white/50">Total: {sorted.length}</div>
      </GlassCard>

      <div className="space-y-2">
        {sorted.map((u) => {
          const isElite = u.rank === "elite" || u.rank === "diamond";
          return (
            <GlassCard key={u.id} className={isElite ? "border-yellow-300/40 ring-1 ring-yellow-300/20" : ""}>
              <div className="flex items-start gap-3">
                <div
                  className="relative shrink-0"
                  style={{
                    padding: 2.5,
                    background: "conic-gradient(from 180deg,#60a5fa,#1d4ed8,#38bdf8,#60a5fa)",
                    borderRadius: 999,
                  }}
                >
                  <img src={avatarAsset.url} alt="" className="h-12 w-12 rounded-full border-2 border-[#0b1a3a] object-cover" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{u.display_name || u.username || `ID ${u.telegram_id}`}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${isElite ? "bg-yellow-300 text-[#0b1a3a]" : "bg-white/15 text-white/80"}`}>{RANK_LABELS[u.rank] ?? u.rank}</span>
                  </div>
                  <div className="text-[11px] text-white/50">@{u.username ?? "—"} · <code>{u.telegram_id}</code></div>
                  <div className="mt-1 grid grid-cols-2 gap-1 text-[11px]">
                    <div className="rounded-lg bg-white/5 px-2 py-1">Saldo <b className="text-white">${Number(u.balance).toFixed(2)}</b></div>
                    <div className="rounded-lg bg-white/5 px-2 py-1">Gastado <b className="text-white">${Number(u.total_recharged).toFixed(2)}</b></div>
                  </div>
                  {u.blocked_until && <div className="mt-1 text-[10px] text-red-300">Bloqueado hasta {new Date(u.blocked_until).toLocaleString()}</div>}
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <select
                  value={u.rank}
                  onChange={(e) => rankFn({ data: { telegram_id: u.telegram_id, new_rank: e.target.value } }).then(() => refetch())}
                  className="rounded-xl border border-white/15 bg-white/10 px-2 py-2 text-xs text-white outline-none backdrop-blur-xl"
                >
                  {RANKS.map((r) => <option key={r} value={r}>{RANK_LABELS[r]}</option>)}
                </select>
                <input
                  type="number" step="0.01" defaultValue={Number(u.balance).toFixed(2)}
                  onBlur={(e) => Number(e.target.value) !== Number(u.balance) && balFn({ data: { telegram_id: u.telegram_id, balance: Number(e.target.value) } }).then(() => refetch())}
                  className="rounded-xl border border-white/15 bg-white/10 px-2 py-2 text-xs text-white outline-none backdrop-blur-xl"
                />
              </div>
              <div className="mt-2 flex gap-1">
                {u.blocked_until ? (
                  <button onClick={() => unblock({ data: { telegram_id: u.telegram_id } }).then(() => refetch())} className="flex-1 rounded-xl border border-white/20 bg-white/10 px-2 py-2 text-xs font-semibold text-white backdrop-blur-xl active:scale-95">
                    <ShieldCheck className="mx-auto h-4 w-4" />
                  </button>
                ) : (
                  <>
                    <button onClick={() => b24({ data: { telegram_id: u.telegram_id } }).then(() => refetch())} className="flex-1 rounded-xl bg-orange-500/80 px-2 py-2 text-xs font-semibold text-white active:scale-95">24h</button>
                    <button onClick={() => { if (confirm("Bloquear permanentemente?")) bPerm({ data: { telegram_id: u.telegram_id } }).then(() => refetch()); }} className="flex-1 rounded-xl bg-red-500/90 px-2 py-2 text-xs font-semibold text-white active:scale-95"><Ban className="mx-auto h-4 w-4" /></button>
                  </>
                )}
              </div>
            </GlassCard>
          );
        })}
      </div>
    </div>
  );
}
