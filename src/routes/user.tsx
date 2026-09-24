import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState, type ReactNode } from "react";

import {
  listUsers,
  getUserDetail,
  type UserDetail,
  type UserListItem,
} from "@/lib/api/users.functions";
import {
  sendUserMessage,
  setUserBlock,
  adjustUserBalance,
  setUserRank,
  getUserCatalog,
  setUserPriceOverride,
} from "@/lib/api/user-actions.functions";

const RANKS = ["normal", "pro", "leyenda", "gold", "platinum", "diamond", "elite"];

export const Route = createFileRoute("/user")({
  head: () => ({
    meta: [
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover",
      },
      { title: "Usuarios — Administración de cuentas" },
      {
        name: "description",
        content: "Administra cada usuario del bot: saldo, compras, keys, comprobantes y actividad.",
      },
      { property: "og:title", content: "Usuarios — Administración de cuentas" },
      {
        property: "og:description",
        content: "Administra cada usuario del bot: saldo, compras, keys, comprobantes y actividad.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: UsersPage,
});

const money = (n: number) =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fullDate = (iso: string) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

const relative = (iso: string) => {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d} d`;
  return fullDate(iso);
};

const initials = (name: string) =>
  name
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("") || "U";

const STATUS_LABEL: Record<string, string> = {
  pending_receipt: "Pendiente",
  pending_approval: "En revisión",
  approved: "Aprobada",
  delivered: "Entregada",
  rejected: "Rechazada",
  cancelled: "Cancelada",
};

function UsersPage() {
  const fetchUsers = useServerFn(listUsers);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<NavTab>("users");
  const [sort, setSort] = useState<SortKey>("recent");

  const { data, isPending, isError, refetch, isFetching } = useQuery({
    queryKey: ["users-admin"],
    queryFn: () => fetchUsers(),
    refetchInterval: 90_000,
  });

  const users = data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = users;
    if (tab === "blocked") list = list.filter((u) => u.blocked);
    if (tab === "top") list = list.filter((u) => u.spent > 0);
    if (q)
      list = list.filter(
        (u) =>
          u.telegramId.includes(q) ||
          u.name.toLowerCase().includes(q) ||
          (u.username ?? "").toLowerCase().includes(q),
      );
    const key: SortKey = tab === "top" ? "spent" : sort;
    const by: Record<SortKey, (a: UserListItem, b: UserListItem) => number> = {
      recent: (a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""),
      newest: (a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""),
      balance: (a, b) => b.balance - a.balance,
      spent: (a, b) => b.spent - a.spent,
    };
    return [...list].sort(by[key]);
  }, [users, query, tab, sort]);

  const switchTab = (t: NavTab) => {
    setTab(t);
    setSelected(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  };

  const index = selected ? filtered.findIndex((u) => u.telegramId === selected) : -1;
  const go = (step: number) => {
    if (index < 0 || filtered.length === 0) return;
    const next = (index + step + filtered.length) % filtered.length;
    setSelected(filtered[next]!.telegramId);
  };

  return (
    <main className="usr-page min-h-screen w-full overflow-x-hidden px-4 pb-32 pt-8 sm:px-6">
      <div className="mx-auto w-full max-w-6xl">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="min-w-0">
            <p className="usr-soft text-[11px] font-medium uppercase tracking-[0.2em]">Administración</p>
            <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight sm:text-4xl">{NAV.find((n) => n.id === tab)?.title}</h1>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="usr-chip shrink-0 px-4 py-2 text-sm font-medium"
          >
            {isFetching ? "Actualizando" : "Actualizar"}
          </button>
        </header>

        {tab === "stats" ? (
          isPending ? <Placeholder text="Cargando resumen" /> : <Stats users={users} onOpen={(id) => { setTab("users"); setSelected(id); }} />
        ) : (
        <>
        <div className="usr-card mt-6 flex items-center gap-3 px-4 py-3">
          <span className="usr-soft text-xs uppercase tracking-[0.14em]">Buscar</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nombre, usuario o UID"
            inputMode="search"
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:opacity-45"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} className="usr-soft shrink-0 text-sm">
              Limpiar
            </button>
          ) : null}
        </div>

        {isPending ? (
          <Placeholder text="Cargando usuarios" />
        ) : isError ? (
          <Placeholder text="No se pudo cargar la información" />
        ) : (
          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <section className={selected ? "hidden lg:block" : "block"}>
              <div className="mb-3 flex items-center justify-between gap-2 px-1">
                <p className="usr-soft shrink-0 text-[11px] uppercase tracking-[0.16em]">
                  {filtered.length} cuentas
                </p>
                {tab === "users" ? (
                  <div className="flex min-w-0 gap-1 overflow-x-auto">
                    {SORTS.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => setSort(o.id)}
                        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${sort === o.id ? "bg-[var(--usr-text)] text-[var(--usr-bg)]" : "usr-soft"}`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {filtered.length === 0 ? (
                <Placeholder text="Sin resultados" />
              ) : (
                <div className="usr-card overflow-hidden divide-y divide-[var(--usr-line)] lg:max-h-[70vh] lg:overflow-y-auto">
                  {filtered.map((u) => (
                    <UserRow
                      key={u.telegramId}
                      u={u}
                      active={u.telegramId === selected}
                      onSelect={() => setSelected(u.telegramId)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className={selected ? "block" : "hidden lg:block"}>
              {selected ? (
                <DetailPane
                  telegramId={selected}
                  position={index >= 0 ? `${index + 1} de ${filtered.length}` : ""}
                  onBack={() => setSelected(null)}
                  onPrev={() => go(-1)}
                  onNext={() => go(1)}
                />
              ) : (
                <Placeholder text="Selecciona un usuario para ver su perfil" />
              )}
            </section>
          </div>
        )}
        </>
        )}
      </div>
      <BottomNav tab={tab} onChange={switchTab} counts={{ users: users.length, top: users.filter((u) => u.spent > 0).length, blocked: users.filter((u) => u.blocked).length }} />
    </main>
  );
}

type NavTab = "users" | "top" | "blocked" | "stats";
type SortKey = "recent" | "newest" | "balance" | "spent";
const NAV: { id: NavTab; label: string; title: string }[] = [
  { id: "users", label: "Usuarios", title: "Usuarios" },
  { id: "top", label: "Top", title: "Mejores clientes" },
  { id: "blocked", label: "Bloqueados", title: "Bloqueados" },
  { id: "stats", label: "Resumen", title: "Resumen" },
];
const SORTS: { id: SortKey; label: string }[] = [
  { id: "recent", label: "Activos" },
  { id: "newest", label: "Nuevos" },
  { id: "balance", label: "Saldo" },
  { id: "spent", label: "Gastado" },
];

function NavIcon({ id }: { id: NavTab }) {
  const c = { width: 22, height: 22, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, viewBox: "0 0 24 24" };
  if (id === "users") return <svg {...c}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2" /></svg>;
  if (id === "top") return <svg {...c}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
  if (id === "blocked") return <svg {...c}><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg>;
  return <svg {...c}><rect x="3" y="3" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" /></svg>;
}

function BottomNav({ tab, onChange, counts }: { tab: NavTab; onChange: (t: NavTab) => void; counts: Partial<Record<NavTab, number>> }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 px-3 pb-[max(env(safe-area-inset-bottom),12px)]">
      <div className="mx-auto grid max-w-md grid-cols-4 gap-1 rounded-[1.75rem] border border-[var(--usr-line)] bg-[var(--usr-surface)]/90 p-1.5 shadow-2xl backdrop-blur-xl">
        {NAV.map((n) => {
          const on = n.id === tab;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onChange(n.id)}
              className={`relative flex flex-col items-center gap-0.5 rounded-[1.35rem] py-2 text-[10.5px] font-medium transition-colors ${on ? "bg-[var(--usr-surface-2)] text-[var(--usr-text)]" : "usr-soft"}`}
            >
              <NavIcon id={n.id} />
              <span>{n.label}</span>
              {counts[n.id] ? (
                <span className="absolute right-3 top-1 rounded-full bg-[var(--usr-text)] px-1.5 text-[9px] font-semibold leading-4 text-[var(--usr-bg)]">
                  {counts[n.id]! > 999 ? "999+" : counts[n.id]}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function Stats({ users, onOpen }: { users: UserListItem[]; onOpen: (id: string) => void }) {
  const now = Date.now();
  const day = 86_400_000;
  const sum = (f: (u: UserListItem) => number) => users.reduce((s, u) => s + f(u), 0);
  const active7 = users.filter((u) => u.lastSeenAt && now - new Date(u.lastSeenAt).getTime() < 7 * day).length;
  const new7 = users.filter((u) => u.createdAt && now - new Date(u.createdAt).getTime() < 7 * day).length;
  const buyers = users.filter((u) => u.orders > 0).length;
  const top = [...users].sort((a, b) => b.balance - a.balance).slice(0, 5);
  const ranks = new Map<string, number>();
  for (const u of users) ranks.set(u.rank, (ranks.get(u.rank) ?? 0) + 1);
  const cards: [string, string][] = [
    ["Cuentas", String(users.length)],
    ["Activos 7 días", String(active7)],
    ["Nuevos 7 días", String(new7)],
    ["Compradores", String(buyers)],
    ["Saldo total USD", money(sum((u) => u.balance))],
    ["Gastado total USD", money(sum((u) => u.spent))],
    ["Recargado USD", money(sum((u) => u.recharged))],
    ["Órdenes", String(sum((u) => u.orders))],
  ];
  return (
    <div className="mt-6 flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(([l, v]) => (
          <div key={l} className="usr-card p-4">
            <p className="usr-soft text-[11px] uppercase tracking-[0.14em]">{l}</p>
            <p className="mt-2 break-all text-2xl font-semibold tracking-tight">{v}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="usr-card p-5">
          <p className="usr-soft text-[11px] uppercase tracking-[0.14em]">Mayor saldo</p>
          <div className="mt-3 flex flex-col gap-1">
            {top.map((u) => (
              <button key={u.telegramId} type="button" onClick={() => onOpen(u.telegramId)} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 text-left hover:bg-[var(--usr-surface-2)]">
                <span className="min-w-0 truncate text-sm">{u.name}</span>
                <span className="shrink-0 text-sm font-semibold">{money(u.balance)} USD</span>
              </button>
            ))}
          </div>
        </div>
        <div className="usr-card p-5">
          <p className="usr-soft text-[11px] uppercase tracking-[0.14em]">Rangos</p>
          <div className="mt-3 flex flex-col gap-2.5">
            {[...ranks.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => (
              <div key={r}>
                <div className="flex justify-between text-sm capitalize"><span>{r}</span><span className="usr-soft">{n}</span></div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--usr-surface-2)]">
                  <div className="h-full rounded-full bg-[var(--usr-text)]" style={{ width: `${(n / Math.max(users.length, 1)) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="usr-card mt-5 flex h-44 items-center justify-center p-6">
      <p className="usr-soft text-sm">{text}</p>
    </div>
  );
}

function Avatar({ size }: { size: number }) {
  return (
    <img
      src={avatarAsset.url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size, border: "1px solid var(--usr-line)" }}
    />
  );
}

function UserRow({ u, active, onSelect }: { u: UserListItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full px-4 py-3 text-left transition active:bg-[var(--usr-surface-2)]"
      style={active ? { backgroundColor: "var(--usr-surface-2)" } : undefined}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3">
        <span className="relative">
          <Avatar size={44} />
          {u.blocked ? (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-destructive"
              style={{ border: "2px solid var(--usr-surface)" }}
            />
          ) : null}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-medium">{u.name}</span>
          <span className="usr-soft block truncate text-xs">
            {u.username ? `@${u.username}` : `UID ${u.telegramId}`} · {relative(u.lastSeenAt)}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[15px] font-semibold tabular-nums">{money(u.balance)}</span>
          <span className="usr-soft block text-[11px] capitalize">
            {u.blocked ? "Bloqueado" : u.rank}
          </span>
        </span>
        <svg width="8" height="14" viewBox="0 0 8 14" className="usr-soft shrink-0" aria-hidden>
          <path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </button>
  );
}

function DetailPane({
  telegramId,
  position,
  onBack,
  onPrev,
  onNext,
}: {
  telegramId: string;
  position: string;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const fetchDetail = useServerFn(getUserDetail);
  const { data, isPending, isError } = useQuery({
    queryKey: ["user-detail", telegramId],
    queryFn: () => fetchDetail({ data: { telegramId } }),
  });

  return (
    <div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <button type="button" onClick={onBack} className="usr-chip shrink-0 px-4 py-2 text-sm lg:hidden">
          Volver
        </button>
        <p className="usr-soft min-w-0 truncate px-1 text-[11px] uppercase tracking-[0.16em]">
          {position || "Perfil"}
        </p>
        <span className="flex shrink-0 gap-2">
          <button type="button" onClick={onPrev} className="usr-chip px-3.5 py-2 text-sm">
            Anterior
          </button>
          <button type="button" onClick={onNext} className="usr-chip px-3.5 py-2 text-sm">
            Siguiente
          </button>
        </span>
      </div>

      {isPending ? (
        <Placeholder text="Cargando perfil" />
      ) : isError || !data ? (
        <Placeholder text="No se encontró el usuario" />
      ) : (
        <Profile d={data} />
      )}
    </div>
  );
}

function Profile({ d }: { d: UserDetail }) {
  const maxMonth = Math.max(1, ...d.monthly.map((m) => m.total));

  return (
    <div className="mt-4 flex flex-col gap-4">
      <section className="usr-card p-5">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4">
          <Avatar size={64} />
          <span className="min-w-0">
            <span className="block truncate text-2xl font-semibold tracking-tight">{d.name}</span>
            <span className="usr-soft mt-1 block truncate text-sm">
              {d.username ? `@${d.username} · ` : ""}UID {d.telegramId}
            </span>
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Tag text={d.rank} />
          <Tag text={d.lang.toUpperCase()} />
          <Tag text={d.blocked ? "Bloqueado" : "Activo"} />
          {d.authenticated ? <Tag text="Verificado" /> : null}
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4">
        <Metric label="Saldo disponible" value={money(d.balance)} unit="USD" hint={`Recargado ${money(d.recharged)}`} />
        <Metric label="Total gastado" value={money(d.spent)} unit="USD" hint={`${d.orders} órdenes`} />
      </div>

      <section className="usr-card p-5">
        <p className="usr-soft text-[11px] uppercase tracking-[0.16em]">Actividad de compras</p>
        <div className="mt-4 grid grid-cols-6 items-end gap-2">
          {d.monthly.map((m) => (
            <div key={m.label} className="flex flex-col items-center gap-2">
              <div className="flex h-24 w-full items-end">
                <div
                  className="usr-chip w-full"
                  style={{
                    height: `${Math.max(6, (m.total / maxMonth) * 100)}%`,
                    borderRadius: "0.6rem",
                    backgroundColor: "var(--usr-text)",
                    opacity: m.total > 0 ? 0.9 : 0.18,
                  }}
                />
              </div>
              <span className="usr-soft text-[11px] tabular-nums">{m.label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Small label="Keys" value={String(d.keys)} />
        <Small label="Pendientes" value={String(d.pendingOrders)} />
        <Small label="Comprobantes" value={String(d.receipts.total)} />
        <Small label="Aprobados" value={String(d.receipts.approved)} />
      </div>

      <section className="usr-card divide-y" style={{ borderColor: "var(--usr-line)" }}>
        <Line label="Registro" value={fullDate(d.createdAt)} />
        <Line label="Última conexión" value={relative(d.lastSeenAt)} />
        <Line label="Última compra" value={d.lastOrderAt ? fullDate(d.lastOrderAt) : "—"} />
        <Line label="Referido por" value={d.referredBy ?? "—"} />
        <Line label="Compartidos" value={String(d.sharesCount)} />
        {d.blocked ? (
          <Line
            label="Bloqueo"
            value={`${d.blockedReason ?? "sin motivo"}${d.blockedUntil ? ` · hasta ${fullDate(d.blockedUntil)}` : " · permanente"}`}
          />
        ) : null}
      </section>

      <section className="usr-card p-5">
        <p className="usr-soft text-[11px] uppercase tracking-[0.16em]">Órdenes recientes</p>
        <div className="mt-3 flex flex-col gap-2.5">
          {d.recentOrders.length === 0 ? (
            <p className="usr-soft text-sm">Sin órdenes registradas</p>
          ) : (
            d.recentOrders.map((o) => (
              <div key={o.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{o.product}</span>
                  <span className="usr-soft block truncate text-xs">
                    {o.duration} · {o.qty} key{o.qty === 1 ? "" : "s"} · {STATUS_LABEL[o.status] ?? o.status}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-medium tabular-nums">{money(o.total)}</span>
                  <span className="usr-soft block text-[11px]">{fullDate(o.createdAt)}</span>
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="usr-card p-5">
        <p className="usr-soft text-[11px] uppercase tracking-[0.16em]">Keys entregadas</p>
        <div className="mt-3 flex flex-col gap-2">
          {d.recentKeys.length === 0 ? (
            <p className="usr-soft text-sm">Sin keys entregadas</p>
          ) : (
            d.recentKeys.map((k, i) => (
              <div
                key={`${k.value}-${i}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
              >
                <code className="truncate font-mono text-sm">{k.value}</code>
                <span className="usr-soft shrink-0 text-[11px]">{fullDate(k.deliveredAt)}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <ActionsPanel d={d} />
    </div>
  );
}

type ActionTab = "message" | "balance" | "rank" | "block" | "discount";

const TABS: { key: ActionTab; label: string }[] = [
  { key: "message", label: "Mensaje" },
  { key: "balance", label: "Saldo" },
  { key: "rank", label: "Rango" },
  { key: "block", label: "Bloqueo" },
  { key: "discount", label: "Descuentos" },
];

function ActionsPanel({ d }: { d: UserDetail }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<ActionTab>("message");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [rank, setRank] = useState(d.rank);
  const [openProduct, setOpenProduct] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const sendMsg = useServerFn(sendUserMessage);
  const doBlock = useServerFn(setUserBlock);
  const doBalance = useServerFn(adjustUserBalance);
  const doRank = useServerFn(setUserRank);
  const fetchCatalog = useServerFn(getUserCatalog);
  const doOverride = useServerFn(setUserPriceOverride);

  const catalog = useQuery({
    queryKey: ["user-catalog", d.telegramId],
    queryFn: () => fetchCatalog({ data: { telegramId: d.telegramId } }),
    enabled: tab === "discount",
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["user-detail", d.telegramId] });
    qc.invalidateQueries({ queryKey: ["users-admin"] });
  };

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>, after?: () => void) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fn();
      setNote(res.message);
      if (res.ok) {
        after?.();
        refresh();
      }
    } catch {
      setNote("No se pudo completar la acción");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="usr-card p-5">
      <p className="usr-soft text-[11px] uppercase tracking-[0.16em]">Acciones</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setTab(t.key);
              setNote(null);
            }}
            className="usr-chip px-3.5 py-2 text-sm"
            style={tab === t.key ? { borderColor: "var(--usr-text-soft)", opacity: 1 } : { opacity: 0.65 }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {tab === "message" ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="Escribe el mensaje que recibirá el usuario en su chat"
              className="usr-card w-full resize-none bg-transparent p-3 text-[16px] outline-none placeholder:opacity-45"
            />
            <ActionButton
              label="Enviar mensaje"
              busy={busy}
              disabled={!text.trim()}
              onClick={() => run(() => sendMsg({ data: { telegramId: d.telegramId, text } }), () => setText(""))}
            />
          </>
        ) : null}

        {tab === "balance" ? (
          <>
            <p className="usr-soft text-sm">Saldo actual {money(d.balance)} USD</p>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="Cantidad en USD"
              className="usr-card w-full bg-transparent p-3 text-[16px] outline-none placeholder:opacity-45"
            />
            <div className="grid grid-cols-2 gap-3">
              <ActionButton
                label="Sumar saldo"
                busy={busy}
                disabled={!amount.trim()}
                onClick={() =>
                  run(
                    () =>
                      doBalance({
                        data: { telegramId: d.telegramId, amount: Number(amount.replace(",", ".")), mode: "add" },
                      }),
                    () => setAmount(""),
                  )
                }
              />
              <ActionButton
                label="Restar saldo"
                busy={busy}
                disabled={!amount.trim()}
                onClick={() =>
                  run(
                    () =>
                      doBalance({
                        data: { telegramId: d.telegramId, amount: Number(amount.replace(",", ".")), mode: "sub" },
                      }),
                    () => setAmount(""),
                  )
                }
              />
            </div>
          </>
        ) : null}

        {tab === "rank" ? (
          <>
            <div className="flex flex-wrap gap-2">
              {RANKS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRank(r)}
                  className="usr-chip px-3 py-1.5 text-[11px] uppercase tracking-[0.12em]"
                  style={rank === r ? { borderColor: "var(--usr-text-soft)", opacity: 1 } : { opacity: 0.6 }}
                >
                  {r}
                </button>
              ))}
            </div>
            <ActionButton
              label="Guardar rango"
              busy={busy}
              disabled={rank === d.rank}
              onClick={() => run(() => doRank({ data: { telegramId: d.telegramId, rank } }))}
            />
          </>
        ) : null}

        {tab === "block" ? (
          <>
            <p className="usr-soft text-sm">
              {d.blocked
                ? `Bloqueado${d.blockedReason ? ` · ${d.blockedReason}` : ""}`
                : "El usuario tiene acceso normal al servicio."}
            </p>
            {!d.blocked ? (
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Motivo (opcional)"
                className="usr-card w-full bg-transparent p-3 text-[16px] outline-none placeholder:opacity-45"
              />
            ) : null}
            <ActionButton
              label={d.blocked ? "Desbloquear usuario" : "Bloquear usuario"}
              busy={busy}
              onClick={() =>
                run(
                  () => doBlock({ data: { telegramId: d.telegramId, blocked: !d.blocked, reason } }),
                  () => setReason(""),
                )
              }
            />
          </>
        ) : null}

        {tab === "discount" ? (
          catalog.isPending ? (
            <p className="usr-soft text-sm">Cargando productos</p>
          ) : (
            <div className="flex flex-col gap-2">
              {(catalog.data ?? []).map((p) => (
                <div key={p.productId} className="usr-card px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setOpenProduct(openProduct === p.productId ? null : p.productId)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{p.name}</span>
                      <span className="usr-soft block truncate text-xs">{p.category}</span>
                    </span>
                    <span className="usr-soft shrink-0 text-xs">
                      {openProduct === p.productId ? "Cerrar" : "Ver precios"}
                    </span>
                  </button>

                  {openProduct === p.productId ? (
                    <div className="mt-3 flex flex-col gap-2.5">
                      {p.prices.map((pr) => (
                        <div key={pr.priceId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                          <span className="min-w-0">
                            <span className="block truncate text-sm">{pr.duration}</span>
                            <span className="usr-soft block text-xs">
                              {money(pr.price)} USD
                              {pr.override !== null ? ` · personalizado ${money(pr.override)}` : ""}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <input
                              value={draft[pr.priceId] ?? (pr.override !== null ? String(pr.override) : "")}
                              onChange={(e) => setDraft({ ...draft, [pr.priceId]: e.target.value })}
                              inputMode="decimal"
                              placeholder="USD"
                              className="usr-card w-20 bg-transparent px-2 py-1.5 text-center text-[16px] outline-none placeholder:opacity-45"
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                run(
                                  () =>
                                    doOverride({
                                      data: {
                                        telegramId: d.telegramId,
                                        priceId: pr.priceId,
                                        price: Number((draft[pr.priceId] ?? "").replace(",", ".")),
                                      },
                                    }),
                                  () => catalog.refetch(),
                                )
                              }
                              className="usr-chip px-3 py-1.5 text-xs"
                            >
                              Aplicar
                            </button>
                            {pr.override !== null ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  run(
                                    () =>
                                      doOverride({
                                        data: { telegramId: d.telegramId, priceId: pr.priceId, price: null },
                                      }),
                                    () => {
                                      setDraft({ ...draft, [pr.priceId]: "" });
                                      catalog.refetch();
                                    },
                                  )
                                }
                                className="usr-chip px-3 py-1.5 text-xs"
                              >
                                Quitar
                              </button>
                            ) : null}
                          </span>
                        </div>
                      ))}
                      {p.prices.length === 0 ? <p className="usr-soft text-sm">Sin precios activos</p> : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : null}

        {note ? <p className="usr-soft text-sm">{note}</p> : null}
      </div>
    </section>
  );
}

function ActionButton({
  label,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="usr-chip px-4 py-2.5 text-sm font-medium"
      style={busy || disabled ? { opacity: 0.5 } : undefined}
    >
      {busy ? "Procesando" : label}
    </button>
  );
}

function Tag({ text }: { text: string }) {
  return <span className="usr-chip px-3 py-1 text-[11px] uppercase tracking-[0.12em]">{text}</span>;
}

function Metric({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: string;
  unit: string;
  hint: string;
}) {
  return (
    <div className="usr-card p-5">
      <p className="usr-soft text-[11px] uppercase tracking-[0.14em]">{label}</p>
      <p className="mt-3 flex items-baseline gap-1.5">
        <span className="min-w-0 break-all text-xl font-semibold tabular-nums sm:text-2xl">{value}</span>
        <span className="usr-soft text-xs">{unit}</span>
      </p>
      <p className="usr-soft mt-1 truncate text-xs">{hint}</p>
    </div>
  );
}

function Small({ label, value }: { label: string; value: string }) {
  return (
    <div className="usr-card px-4 py-3.5">
      <p className="usr-soft text-[11px] uppercase tracking-[0.12em]">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-5 py-3.5">
      <span className="usr-soft min-w-0 truncate text-sm">{label}</span>
      <span className="shrink-0 truncate text-sm font-medium">{value}</span>
    </div>
  );
}
