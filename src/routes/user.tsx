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

  const { data, isPending, isError, refetch, isFetching } = useQuery({
    queryKey: ["users-admin"],
    queryFn: () => fetchUsers(),
    refetchInterval: 90_000,
  });

  const users = data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.telegramId.includes(q) ||
        u.name.toLowerCase().includes(q) ||
        (u.username ?? "").toLowerCase().includes(q),
    );
  }, [users, query]);

  const index = selected ? filtered.findIndex((u) => u.telegramId === selected) : -1;
  const go = (step: number) => {
    if (index < 0 || filtered.length === 0) return;
    const next = (index + step + filtered.length) % filtered.length;
    setSelected(filtered[next]!.telegramId);
  };

  return (
    <main className="usr-page min-h-screen w-full overflow-x-hidden px-4 pb-12 pt-8 sm:px-6">
      <div className="mx-auto w-full max-w-6xl">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="min-w-0">
            <p className="usr-soft text-[11px] font-medium uppercase tracking-[0.2em]">Administración</p>
            <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight sm:text-4xl">Usuarios</h1>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="usr-chip shrink-0 px-4 py-2 text-sm font-medium"
          >
            {isFetching ? "Actualizando" : "Actualizar"}
          </button>
        </header>

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
              <p className="usr-soft mb-3 px-1 text-[11px] uppercase tracking-[0.16em]">
                {filtered.length} cuentas
              </p>
              <div className="flex flex-col gap-2.5 lg:max-h-[70vh] lg:overflow-y-auto lg:pr-1">
                {filtered.map((u) => (
                  <UserRow
                    key={u.telegramId}
                    u={u}
                    active={u.telegramId === selected}
                    onSelect={() => setSelected(u.telegramId)}
                  />
                ))}
                {filtered.length === 0 ? <Placeholder text="Sin resultados" /> : null}
              </div>
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
      </div>
    </main>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="usr-card mt-5 flex h-44 items-center justify-center p-6">
      <p className="usr-soft text-sm">{text}</p>
    </div>
  );
}

function UserRow({ u, active, onSelect }: { u: UserListItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="usr-card w-full px-4 py-3.5 text-left transition"
      style={active ? { borderColor: "var(--usr-text-soft)" } : undefined}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <span className="usr-chip grid h-11 w-11 shrink-0 place-items-center text-sm font-semibold">
          {initials(u.name)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-medium">{u.name}</span>
          <span className="usr-soft block truncate text-xs">
            UID {u.telegramId} · {relative(u.lastSeenAt)}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[15px] font-semibold tabular-nums">{money(u.balance)}</span>
          <span className="usr-soft block text-[11px] uppercase tracking-[0.1em]">
            {u.blocked ? "Bloqueado" : u.rank}
          </span>
        </span>
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
          <span className="usr-chip grid h-16 w-16 shrink-0 place-items-center text-lg font-semibold">
            {initials(d.name)}
          </span>
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
