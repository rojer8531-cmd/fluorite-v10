import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";

import { getDatos, type DatosPayload } from "@/lib/api/datos.functions";

export const Route = createFileRoute("/datos")({
  head: () => ({
    meta: [
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover",
      },
      { title: "Datos — Panel de ventas y usuarios" },
      {
        name: "description",
        content: "Panel con ventas, registros, compras, stock y usuarios de los bots de compras y almacén.",
      },
      { property: "og:title", content: "Datos — Panel de ventas y usuarios" },
      {
        property: "og:description",
        content: "Panel con ventas, registros, compras, stock y usuarios de los bots de compras y almacén.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DatosPage,
});

const money = (n: number) =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

const shortDate = (iso: string) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
};

const timeOf = (iso: string) => {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
};

const TABS = ["Resumen", "Ventas", "Movimientos", "Usuarios", "Inventario"] as const;
type Tab = (typeof TABS)[number];

function DatosPage() {
  const fetchDatos = useServerFn(getDatos);
  const [tab, setTab] = useState<Tab>("Resumen");
  const { data, isPending, isError, refetch, isFetching } = useQuery({
    queryKey: ["datos"],
    queryFn: () => fetchDatos(),
    refetchInterval: 60_000,
  });

  return (
    <main className="neu-page min-h-screen w-full px-4 pb-16 pt-8 sm:px-6">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="neu-text-soft text-xs font-medium uppercase tracking-[0.18em]">Panel</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Datos</h1>
            <p className="neu-text-soft mt-1 text-sm">
              Bots de compras y almacén en un solo lugar
            </p>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="neu-soft px-4 py-2 text-sm font-medium transition active:shadow-none"
          >
            {isFetching ? "Actualizando" : "Actualizar"}
          </button>
        </header>

        <nav className="neu-inset mb-6 flex gap-1 p-1.5">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex-1 rounded-[0.9rem] px-1.5 py-2 text-[12px] font-medium transition ${
                tab === t ? "neu-soft" : "neu-text-soft"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        {isPending ? (
          <Placeholder text="Cargando información" />
        ) : isError || !data ? (
          <Placeholder text="No se pudo cargar la información" />
        ) : (
          <>
            {tab === "Resumen" && <Resumen d={data} />}
            {tab === "Ventas" && <Ventas d={data} />}
            {tab === "Movimientos" && <Movimientos d={data} />}
            {tab === "Usuarios" && <Usuarios d={data} />}
            {tab === "Inventario" && <Inventario d={data} />}
            <p className="neu-text-soft mt-8 text-center text-xs">
              Actualizado {timeOf(data.generatedAt)} · Excluido {data.excluded.join(", ")}
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="neu-card flex h-48 items-center justify-center p-6">
      <p className="neu-text-soft text-sm">{text}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="neu-text-soft mb-3 px-1 text-xs font-semibold uppercase tracking-[0.16em]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="neu-card p-4">
      <p className="neu-text-soft text-[11px] font-medium uppercase tracking-[0.12em]">{label}</p>
      <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="neu-text-soft mt-1 text-xs">{hint}</p> : null}
    </div>
  );
}

function Row({
  left,
  sub,
  right,
  rightSub,
}: {
  left: string;
  sub?: string;
  right: string;
  rightSub?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{left}</p>
        {sub ? <p className="neu-text-soft truncate text-xs">{sub}</p> : null}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums">{right}</p>
        {rightSub ? <p className="neu-text-soft text-xs tabular-nums">{rightSub}</p> : null}
      </div>
    </div>
  );
}

function List({ children }: { children: ReactNode }) {
  return <div className="neu-card divide-y divide-black/5 overflow-hidden">{children}</div>;
}

function Empty({ text }: { text: string }) {
  return <p className="neu-text-soft px-4 py-6 text-center text-sm">{text}</p>;
}

function Resumen({ d }: { d: DatosPayload }) {
  return (
    <>
      <Section title="Ventas">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Hoy" value={money(d.sales.revenueToday)} />
          <Stat label="7 días" value={money(d.sales.revenue7d)} />
          <Stat label="30 días" value={money(d.sales.revenue30d)} />
          <Stat label="Total" value={money(d.sales.revenueTotal)} />
        </div>
      </Section>

      <Section title="Actividad">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Usuarios" value={String(d.users.total)} hint={`${d.users.new7d} nuevos en 7 días`} />
          <Stat label="Compras" value={String(d.sales.orders)} hint={`${d.sales.delivered} entregadas`} />
          <Stat label="Keys entregadas" value={String(d.sales.keysDelivered)} />
          <Stat label="Comprobantes" value={String(d.receipts.total)} hint={`${d.receipts.pending} pendientes`} />
          <Stat label="Ticket promedio" value={money(d.sales.avgTicket)} />
          <Stat label="Promedio diario" value={money(d.sales.avgPerDay30d)} hint="Últimos 30 días" />
          <Stat
            label="Variación 7 días"
            value={`${d.sales.growth7d >= 0 ? "+" : ""}${d.sales.growth7d.toFixed(1)} %`}
            hint={`Semana previa ${money(d.sales.revenuePrev7d)}`}
          />
          <Stat label="Mejor día" value={money(d.sales.bestDay.total)} hint={shortDate(d.sales.bestDay.date)} />
        </div>
      </Section>

      <Section title="Últimos 14 días">
        <div className="neu-card p-4">
          <Chart daily={d.daily} />
        </div>
      </Section>

      <Section title="Productos más vendidos">
        <List>
          {d.topProducts.length === 0 ? (
            <Empty text="Sin ventas registradas" />
          ) : (
            d.topProducts.map((p) => (
              <Row
                key={p.name}
                left={p.name}
                sub={`${p.orders} compras`}
                right={money(p.total)}
              />
            ))
          )}
        </List>
      </Section>
    </>
  );
}

function Chart({ daily }: { daily: DatosPayload["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.total));
  return (
    <div>
      <div className="flex h-32 items-end gap-1.5">
        {daily.map((d) => (
          <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-md"
              style={{ height: `${Math.max(6, (d.total / max) * 100)}%`, backgroundColor: "var(--neu-accent)", opacity: d.total ? 1 : 0.25 }}
              title={`${d.date}: ${money(d.total)}`}
            />
          </div>
        ))}
      </div>
      <div className="neu-text-soft mt-2 flex justify-between text-[10px]">
        <span>{shortDate(daily[0]?.date ?? "")}</span>
        <span>{shortDate(daily[daily.length - 1]?.date ?? "")}</span>
      </div>
    </div>
  );
}

function Ventas({ d }: { d: DatosPayload }) {
  return (
    <>
      <Section title="Estado de compras">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Entregadas" value={String(d.sales.delivered)} />
          <Stat label="Pendientes" value={String(d.sales.pending)} />
          <Stat label="Aprobados" value={String(d.receipts.approved)} hint="Comprobantes" />
          <Stat label="Rechazados" value={String(d.receipts.rejected)} hint="Comprobantes" />
          <Stat label="Canceladas" value={String(d.sales.cancelled)} />
          <Stat label="Compras hoy" value={String(d.sales.ordersToday)} hint={`${d.sales.keysToday} keys`} />
          <Stat label="Compras 7 días" value={String(d.sales.orders7d)} />
          <Stat label="Compras 30 días" value={String(d.sales.orders30d)} />
          <Stat label="Ayer" value={money(d.sales.revenueYesterday)} />
          <Stat
            label="Aprobación"
            value={`${d.receipts.approvalRate.toFixed(0)} %`}
            hint={`${d.receipts.today} comprobantes hoy`}
          />
        </div>
      </Section>

      <Section title="Horario con más ventas">
        <div className="neu-card p-4">
          <Bars
            items={d.hourly.map((h) => ({
              key: String(h.hour),
              label: `${String(h.hour).padStart(2, "0")}h`,
              value: h.total,
            }))}
          />
        </div>
      </Section>

      <Section title="Ventas por día de semana">
        <List>
          {d.weekday.map((w) => (
            <Row key={w.label} left={w.label} sub={`${w.orders} compras`} right={money(w.total)} />
          ))}
        </List>
      </Section>

      <Section title="Compras recientes">
        <List>
          {d.recentOrders.length === 0 ? (
            <Empty text="Sin compras registradas" />
          ) : (
            d.recentOrders.map((o) => (
              <Row
                key={o.id}
                left={o.product}
                sub={`${o.duration} · ${o.qty} key · ID ${o.telegramId}`}
                right={money(o.total)}
                rightSub={`${shortDate(o.createdAt)} · ${o.status}`}
              />
            ))
          )}
        </List>
      </Section>
    </>
  );
}

function Bars({ items }: { items: { key: string; label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div>
      <div className="flex h-28 items-end gap-[3px]">
        {items.map((i) => (
          <div
            key={i.key}
            className="flex-1 rounded-sm"
            title={`${i.label}: ${money(i.value)}`}
            style={{
              height: `${Math.max(5, (i.value / max) * 100)}%`,
              backgroundColor: "var(--neu-accent)",
              opacity: i.value ? 1 : 0.2,
            }}
          />
        ))}
      </div>
      <div className="neu-text-soft mt-2 flex justify-between text-[10px]">
        <span>{items[0]?.label}</span>
        <span>{items[items.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function Movimientos({ d }: { d: DatosPayload }) {
  return (
    <>
      <Section title="Actividad reciente">
        <List>
          {d.movements.length === 0 ? (
            <Empty text="Sin movimientos" />
          ) : (
            d.movements.map((m) => (
              <Row
                key={m.id}
                left={`${m.kind} · ${m.title}`}
                sub={m.detail}
                right={m.amount}
                rightSub={`${shortDate(m.createdAt)} ${timeOf(m.createdAt)}`}
              />
            ))
          )}
        </List>
      </Section>
    </>
  );
}

function Usuarios({ d }: { d: DatosPayload }) {
  return (
    <>
      <Section title="Registros">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Total" value={String(d.users.total)} />
          <Stat label="Nuevos 30 días" value={String(d.users.new30d)} />
          <Stat label="Con saldo" value={String(d.users.withBalance)} />
          <Stat label="Bloqueados" value={String(d.users.blocked)} />
          <Stat label="Saldo en cuentas" value={money(d.users.balanceTotal)} />
          <Stat label="Recargado" value={money(d.users.rechargedTotal)} />
          <Stat label="Nuevos 24 horas" value={String(d.users.new24h)} />
          <Stat label="Activos hoy" value={String(d.users.activeToday)} hint={`${d.users.active7d} en 7 días`} />
          <Stat label="Compradores" value={String(d.users.buyers)} hint={`${d.users.repeatBuyers} recurrentes`} />
        </div>
      </Section>

      <Section title="Rangos">
        <List>
          {d.users.byRank.map((r) => (
            <Row key={r.label} left={r.label} right={String(r.count)} />
          ))}
        </List>
      </Section>

      <Section title="Idiomas">
        <List>
          {d.users.byLang.map((l) => (
            <Row key={l.label} left={l.label} right={String(l.count)} />
          ))}
        </List>
      </Section>

      <Section title="Mejores clientes">
        <List>
          {d.topUsers.length === 0 ? (
            <Empty text="Sin clientes registrados" />
          ) : (
            d.topUsers.map((u) => (
              <Row
                key={u.telegramId}
                left={u.name}
                sub={`ID ${u.telegramId} · ${u.orders} compras`}
                right={money(u.total)}
              />
            ))
          )}
        </List>
      </Section>

      <Section title="Últimos registros">
        <List>
          {d.recentUsers.length === 0 ? (
            <Empty text="Sin registros" />
          ) : (
            d.recentUsers.map((u) => (
              <Row
                key={u.telegramId}
                left={u.name}
                sub={`ID ${u.telegramId} · ${shortDate(u.createdAt)}`}
                right={money(u.balance)}
                rightSub={`Recargado ${money(u.recharged)}`}
              />
            ))
          )}
        </List>
      </Section>
    </>
  );
}

function Inventario({ d }: { d: DatosPayload }) {
  return (
    <>
      <Section title="Catálogo">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Productos" value={String(d.catalog.products)} hint={`${d.catalog.activeProducts} activos`} />
          <Stat label="Duraciones" value={String(d.catalog.prices)} />
          <Stat label="Keys en stock" value={String(d.catalog.stockKeys)} />
          <Stat label="Métodos de pago" value={String(d.catalog.paymentMethods)} hint="Activos" />
          <Stat label="Sin stock" value={String(d.catalog.outOfStock)} hint="Duraciones activas" />
        </div>
      </Section>

      <Section title="Stock bajo">
        <List>
          {d.lowStock.length === 0 ? (
            <Empty text="Todo con stock suficiente" />
          ) : (
            d.lowStock.map((s) => (
              <Row key={`low-${s.name}-${s.duration}`} left={s.name} sub={s.duration} right={String(s.keys)} />
            ))
          )}
        </List>
      </Section>

      <Section title="Stock por producto">
        <List>
          {d.stockByProduct.length === 0 ? (
            <Empty text="Sin keys en inventario" />
          ) : (
            d.stockByProduct.map((s) => (
              <Row key={`${s.name}-${s.duration}`} left={s.name} sub={s.duration} right={String(s.keys)} />
            ))
          )}
        </List>
      </Section>

      <Section title="Métodos de pago activos">
        <List>
          {d.paymentMethods.length === 0 ? (
            <Empty text="Sin métodos activos" />
          ) : (
            d.paymentMethods.map((m, i) => (
              <Row key={`${m.country}-${m.method}-${i}`} left={m.country} sub={m.method} right={m.currency} />
            ))
          )}
        </List>
      </Section>
    </>
  );
}
