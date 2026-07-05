import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  getInventarioOverview, listKeys, addKeys, deleteKeys, exportKeys,
  updatePrice, createPrice, deletePrice, restoreOriginalPrice, copyPricesBetweenProducts,
  createProduct, updateProduct, deleteProduct,
  createCategory, deleteCategory,
  createPaymentMethod, updatePaymentMethod, deletePaymentMethod,
} from "@/lib/panel/inventario.functions";
import { Plus, Trash2, Download, Search, RotateCcw, Copy, Save, X } from "lucide-react";

export const Route = createFileRoute("/panel/inventario")({ component: Inventario });

type Section = "keys" | "precios" | "productos" | "metodos";

function Inventario() {
  const [section, setSection] = useState<Section>("keys");
  const overviewFn = useServerFn(getInventarioOverview);
  const { data, refetch } = useQuery({ queryKey: ["panel", "overview"], queryFn: () => overviewFn(), staleTime: 5_000 });

  return (
    <div className="space-y-4">
      <SegmentedControl
        value={section}
        onChange={setSection}
        options={[
          { value: "keys", label: "Keys" },
          { value: "precios", label: "Precios" },
          { value: "productos", label: "Productos" },
          { value: "metodos", label: "Pagos" },
        ]}
      />
      {!data ? (
        <div className="pt-10 text-center text-white/60">Cargando…</div>
      ) : section === "keys" ? (
        <KeysPanel data={data} refetchOverview={refetch} />
      ) : section === "precios" ? (
        <PreciosPanel data={data} refetchOverview={refetch} />
      ) : section === "productos" ? (
        <ProductosPanel data={data} refetchOverview={refetch} />
      ) : (
        <MetodosPanel data={data} refetchOverview={refetch} />
      )}
    </div>
  );
}

// ==================== UI PRIMITIVES ====================

function SegmentedControl<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex gap-1 rounded-2xl border border-white/15 bg-white/10 p-1 backdrop-blur-2xl">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-xl px-3 py-2 text-sm font-semibold transition ${value === o.value ? "bg-white text-[#0b1a3a] shadow-md" : "text-white/80 active:bg-white/10"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function GlassCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-2xl shadow-[0_20px_50px_-25px_rgba(0,0,0,0.55)] ${className}`}>{children}</div>
  );
}

function TextField(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder-white/40 outline-none backdrop-blur-xl focus:border-white/40 ${props.className ?? ""}`} />;
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder-white/40 outline-none backdrop-blur-xl focus:border-white/40 ${props.className ?? ""}`} />;
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none backdrop-blur-xl focus:border-white/40 ${props.className ?? ""}`} />;
}

function Button({ children, variant = "primary", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-50";
  const styles = variant === "primary" ? "bg-white text-[#0b1a3a]" : variant === "danger" ? "bg-red-500/90 text-white" : "border border-white/20 bg-white/10 text-white backdrop-blur-xl";
  return <button {...rest} className={`${base} ${styles} ${rest.className ?? ""}`}>{children}</button>;
}

// ==================== KEYS ====================

type Overview = Awaited<ReturnType<typeof getInventarioOverview>>;

function KeysPanel({ data, refetchOverview }: { data: Overview; refetchOverview: () => void }) {
  const listFn = useServerFn(listKeys);
  const addFn = useServerFn(addKeys);
  const delFn = useServerFn(deleteKeys);
  const expFn = useServerFn(exportKeys);
  const qc = useQueryClient();

  const [productId, setProductId] = useState<string>("");
  const [priceId, setPriceId] = useState<string>("");
  const [onlyAvail, setOnlyAvail] = useState(false);
  const [search, setSearch] = useState("");
  const [textarea, setTextarea] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filteredPrices = useMemo(() => data.prices.filter((p) => !productId || p.product_id === productId), [data.prices, productId]);

  const { data: keys, refetch: refetchKeys, isFetching } = useQuery({
    queryKey: ["panel", "keys", { productId, priceId, onlyAvail, search }],
    queryFn: () => listFn({ data: { product_id: productId || undefined, price_id: priceId || undefined, only_available: onlyAvail, search: search || undefined } }),
    staleTime: 3_000,
  });

  async function handleAdd() {
    if (!productId || !priceId) return alert("Selecciona producto y duración");
    const arr = textarea.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (arr.length === 0) return;
    const r = await addFn({ data: { product_id: productId, price_id: priceId, keys: arr } });
    setTextarea("");
    refetchKeys(); refetchOverview();
    qc.invalidateQueries({ queryKey: ["panel", "overview"] });
    alert(`Añadidas: ${r.inserted} · Duplicados omitidos: ${r.duplicates}`);
  }

  async function handleDelete() {
    if (selected.size === 0) return;
    if (!confirm(`¿Eliminar ${selected.size} keys?`)) return;
    await delFn({ data: { ids: Array.from(selected) } });
    setSelected(new Set());
    refetchKeys(); refetchOverview();
  }

  async function handleExport() {
    const rows = await expFn({ data: { price_id: priceId || undefined, only_available: onlyAvail } });
    const csv = ["key_value,used,created_at", ...rows.map((r) => `"${r.key_value.replace(/"/g, '""')}",${r.used},${r.created_at}`)].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `keys-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <GlassCard>
        <div className="mb-2 text-sm font-semibold">Agregar Keys</div>
        <div className="grid grid-cols-2 gap-2">
          <Select value={productId} onChange={(e) => { setProductId(e.target.value); setPriceId(""); }}>
            <option value="">Producto…</option>
            {data.products.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.category}</option>)}
          </Select>
          <Select value={priceId} onChange={(e) => setPriceId(e.target.value)} disabled={!productId}>
            <option value="">Duración…</option>
            {filteredPrices.map((p) => <option key={p.id} value={p.id}>{p.duration_label} · ${Number(p.price_usd).toFixed(2)} · stock {p.stock}</option>)}
          </Select>
        </div>
        <TextArea rows={5} placeholder="Pega las keys (una por línea, o separadas por coma)" value={textarea} onChange={(e) => setTextarea(e.target.value)} className="mt-2" />
        <div className="mt-2 flex gap-2">
          <Button onClick={handleAdd}><Plus className="h-4 w-4" /> Guardar</Button>
          <Button variant="ghost" onClick={() => setTextarea("")}><X className="h-4 w-4" /> Limpiar</Button>
        </div>
      </GlassCard>

      <GlassCard>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold">Inventario · {keys?.length ?? 0} keys</div>
          <div className="flex gap-1">
            <Button variant="ghost" onClick={handleExport}><Download className="h-4 w-4" /> CSV</Button>
            <Button variant="danger" onClick={handleDelete} disabled={selected.size === 0}><Trash2 className="h-4 w-4" /> {selected.size || ""}</Button>
          </div>
        </div>
        <div className="mb-2 grid grid-cols-2 gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50" />
            <TextField placeholder="Buscar" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <label className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm backdrop-blur-xl">
            <input type="checkbox" checked={onlyAvail} onChange={(e) => setOnlyAvail(e.target.checked)} /> Solo disponibles
          </label>
        </div>
        <div className="max-h-[50dvh] space-y-1 overflow-y-auto pr-1">
          {isFetching && <div className="py-4 text-center text-xs text-white/50">Cargando…</div>}
          {(keys ?? []).map((k) => {
            const price = data.prices.find((p) => p.id === k.price_id);
            const prod = data.products.find((p) => p.id === k.product_id);
            const isSel = selected.has(k.id);
            return (
              <button
                key={k.id}
                onClick={() => {
                  if (k.used) return;
                  const s = new Set(selected); s.has(k.id) ? s.delete(k.id) : s.add(k.id); setSelected(s);
                }}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition ${isSel ? "border-white/50 bg-white/20" : "border-white/10 bg-white/5"} ${k.used ? "opacity-60" : ""}`}
              >
                <div className={`h-2 w-2 rounded-full ${k.used ? "bg-white/30" : "bg-emerald-400"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">{k.key_value}</div>
                  <div className="mt-0.5 text-[10px] text-white/50">{prod?.name} · {price?.duration_label} {k.used ? "· vendida" : ""}</div>
                </div>
              </button>
            );
          })}
          {!isFetching && (keys?.length ?? 0) === 0 && <div className="py-8 text-center text-xs text-white/50">Sin resultados</div>}
        </div>
      </GlassCard>
    </div>
  );
}

// ==================== PRECIOS ====================

function PreciosPanel({ data, refetchOverview }: { data: Overview; refetchOverview: () => void }) {
  const upd = useServerFn(updatePrice);
  const del = useServerFn(deletePrice);
  const create = useServerFn(createPrice);
  const restore = useServerFn(restoreOriginalPrice);
  const copy = useServerFn(copyPricesBetweenProducts);

  const [productId, setProductId] = useState<string>(data.products[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, { price_usd?: string; sale_price_usd?: string; sale_ends_at?: string }>>({});
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTarget, setCopyTarget] = useState("");
  const [newPrice, setNewPrice] = useState({ duration_label: "", duration_days: "30", price_usd: "" });

  const prices = data.prices.filter((p) => p.product_id === productId);

  async function save(id: string) {
    const d = drafts[id] ?? {};
    const patch: Parameters<typeof upd>[0]["data"] = { id };
    if (d.price_usd !== undefined) patch.price_usd = Number(d.price_usd);
    if (d.sale_price_usd !== undefined) patch.sale_price_usd = d.sale_price_usd ? Number(d.sale_price_usd) : null;
    if (d.sale_ends_at !== undefined) patch.sale_ends_at = d.sale_ends_at || null;
    await upd({ data: patch });
    setDrafts((s) => { const c = { ...s }; delete c[id]; return c; });
    refetchOverview();
  }

  async function handleCopy() {
    if (!copyTarget || copyTarget === productId) return;
    const r = await copy({ data: { source_product_id: productId, target_product_id: copyTarget, overwrite: true } });
    setCopyOpen(false);
    refetchOverview();
    alert(`Copiadas ${r.copied} duraciones`);
  }

  return (
    <div className="space-y-3">
      <GlassCard>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold">Precios por producto</div>
          <Button variant="ghost" onClick={() => setCopyOpen((v) => !v)}><Copy className="h-4 w-4" /> Copiar</Button>
        </div>
        <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
          {data.products.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.category}</option>)}
        </Select>
        {copyOpen && (
          <div className="mt-2 flex gap-2">
            <Select value={copyTarget} onChange={(e) => setCopyTarget(e.target.value)}>
              <option value="">Destino…</option>
              {data.products.filter((p) => p.id !== productId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Button onClick={handleCopy} disabled={!copyTarget}>Copiar</Button>
          </div>
        )}
      </GlassCard>

      <div className="space-y-2">
        {prices.map((p) => {
          const draft = drafts[p.id] ?? {};
          const hasDraft = Object.keys(draft).length > 0;
          return (
            <GlassCard key={p.id}>
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">{p.duration_label}</div>
                  <div className="text-[11px] text-white/50">Stock disponible: {p.stock}</div>
                </div>
                <div className="flex gap-1">
                  {p.original_price_usd != null && Number(p.original_price_usd) !== Number(p.price_usd) && (
                    <Button variant="ghost" onClick={() => restore({ data: { id: p.id } }).then(() => refetchOverview())}><RotateCcw className="h-4 w-4" /></Button>
                  )}
                  <Button variant="danger" onClick={() => { if (confirm("¿Eliminar esta duración?")) del({ data: { id: p.id } }).then(() => refetchOverview()); }}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-white/50">Precio USD</div>
                  <TextField type="number" step="0.01" defaultValue={p.price_usd as unknown as string} onChange={(e) => setDrafts((s) => ({ ...s, [p.id]: { ...s[p.id], price_usd: e.target.value } }))} />
                </label>
                <label className="block">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-white/50">Oferta</div>
                  <TextField type="number" step="0.01" defaultValue={(p.sale_price_usd ?? "") as unknown as string} onChange={(e) => setDrafts((s) => ({ ...s, [p.id]: { ...s[p.id], sale_price_usd: e.target.value } }))} />
                </label>
                <label className="block">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-white/50">Fin oferta</div>
                  <TextField type="datetime-local" defaultValue={p.sale_ends_at ? new Date(p.sale_ends_at).toISOString().slice(0, 16) : ""} onChange={(e) => setDrafts((s) => ({ ...s, [p.id]: { ...s[p.id], sale_ends_at: e.target.value ? new Date(e.target.value).toISOString() : "" } }))} />
                </label>
              </div>
              {hasDraft && (
                <div className="mt-2 flex justify-end">
                  <Button onClick={() => save(p.id)}><Save className="h-4 w-4" /> Guardar</Button>
                </div>
              )}
            </GlassCard>
          );
        })}
      </div>

      <GlassCard>
        <div className="mb-2 text-sm font-semibold">Nueva duración</div>
        <div className="grid grid-cols-3 gap-2">
          <TextField placeholder="Etiqueta (30 días)" value={newPrice.duration_label} onChange={(e) => setNewPrice({ ...newPrice, duration_label: e.target.value })} />
          <TextField type="number" placeholder="Días" value={newPrice.duration_days} onChange={(e) => setNewPrice({ ...newPrice, duration_days: e.target.value })} />
          <TextField type="number" step="0.01" placeholder="Precio USD" value={newPrice.price_usd} onChange={(e) => setNewPrice({ ...newPrice, price_usd: e.target.value })} />
        </div>
        <div className="mt-2 flex justify-end">
          <Button onClick={async () => {
            if (!productId || !newPrice.duration_label || !newPrice.price_usd) return;
            await create({ data: { product_id: productId, duration_label: newPrice.duration_label, duration_days: Number(newPrice.duration_days), price_usd: Number(newPrice.price_usd) } });
            setNewPrice({ duration_label: "", duration_days: "30", price_usd: "" });
            refetchOverview();
          }}><Plus className="h-4 w-4" /> Añadir</Button>
        </div>
      </GlassCard>
    </div>
  );
}

// ==================== PRODUCTOS ====================

function ProductosPanel({ data, refetchOverview }: { data: Overview; refetchOverview: () => void }) {
  const create = useServerFn(createProduct);
  const upd = useServerFn(updateProduct);
  const del = useServerFn(deleteProduct);
  const createCat = useServerFn(createCategory);
  const delCat = useServerFn(deleteCategory);

  const [newProd, setNewProd] = useState({ name: "", category: data.categories[0]?.name ?? "iOS", description: "" });
  const [newCat, setNewCat] = useState("");

  return (
    <div className="space-y-3">
      <GlassCard>
        <div className="mb-2 text-sm font-semibold">Nuevo producto</div>
        <div className="space-y-2">
          <TextField placeholder="Nombre" value={newProd.name} onChange={(e) => setNewProd({ ...newProd, name: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <Select value={newProd.category} onChange={(e) => setNewProd({ ...newProd, category: e.target.value })}>
              {data.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </Select>
            <Button onClick={async () => {
              if (!newProd.name) return;
              await create({ data: { name: newProd.name, category: newProd.category, description: newProd.description || undefined } });
              setNewProd({ ...newProd, name: "", description: "" });
              refetchOverview();
            }}><Plus className="h-4 w-4" /> Crear</Button>
          </div>
          <TextArea rows={2} placeholder="Descripción (opcional)" value={newProd.description} onChange={(e) => setNewProd({ ...newProd, description: e.target.value })} />
        </div>
      </GlassCard>

      <div className="space-y-2">
        {data.products.map((p) => (
          <GlassCard key={p.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <TextField defaultValue={p.name} onBlur={(e) => e.target.value !== p.name && upd({ data: { id: p.id, name: e.target.value } }).then(() => refetchOverview())} />
                <div className="grid grid-cols-2 gap-2">
                  <Select defaultValue={p.category} onChange={(e) => upd({ data: { id: p.id, category: e.target.value } }).then(() => refetchOverview())}>
                    {data.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                  </Select>
                  <TextField type="number" defaultValue={p.sort_order} onBlur={(e) => upd({ data: { id: p.id, sort_order: Number(e.target.value) } }).then(() => refetchOverview())} />
                </div>
                <TextArea rows={2} defaultValue={p.description ?? ""} onBlur={(e) => upd({ data: { id: p.id, description: e.target.value } }).then(() => refetchOverview())} placeholder="Descripción" />
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" defaultChecked={p.active} onChange={(e) => upd({ data: { id: p.id, active: e.target.checked } }).then(() => refetchOverview())} />
                  Activo
                </label>
              </div>
              <Button variant="danger" onClick={() => { if (confirm("¿Eliminar producto?")) del({ data: { id: p.id } }).then(() => refetchOverview()); }}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </GlassCard>
        ))}
      </div>

      <GlassCard>
        <div className="mb-2 text-sm font-semibold">Categorías</div>
        <div className="space-y-1">
          {data.categories.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm">
              <span>{c.name}</span>
              <button onClick={() => { if (confirm("¿Eliminar categoría?")) delCat({ data: { id: c.id } }).then(() => refetchOverview()); }} className="text-red-300"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <TextField placeholder="Nueva categoría" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
          <Button onClick={async () => { if (!newCat) return; await createCat({ data: { name: newCat } }); setNewCat(""); refetchOverview(); }}><Plus className="h-4 w-4" /></Button>
        </div>
      </GlassCard>
    </div>
  );
}

// ==================== MÉTODOS DE PAGO ====================

function MetodosPanel({ data, refetchOverview }: { data: Overview; refetchOverview: () => void }) {
  const create = useServerFn(createPaymentMethod);
  const upd = useServerFn(updatePaymentMethod);
  const del = useServerFn(deletePaymentMethod);
  const [form, setForm] = useState({ country_code: "", country_name: "", method_name: "", holder_name: "", account_info: "", extra_info: "", currency: "USD", usd_rate: "1" });

  return (
    <div className="space-y-3">
      <GlassCard>
        <div className="mb-2 text-sm font-semibold">Nuevo método</div>
        <div className="grid grid-cols-2 gap-2">
          <TextField placeholder="País código (AR)" value={form.country_code} onChange={(e) => setForm({ ...form, country_code: e.target.value.toUpperCase() })} maxLength={4} />
          <TextField placeholder="País nombre" value={form.country_name} onChange={(e) => setForm({ ...form, country_name: e.target.value })} />
          <TextField placeholder="Método (Nequi)" value={form.method_name} onChange={(e) => setForm({ ...form, method_name: e.target.value })} />
          <TextField placeholder="Titular" value={form.holder_name} onChange={(e) => setForm({ ...form, holder_name: e.target.value })} />
          <TextField placeholder="Cuenta / número" value={form.account_info} onChange={(e) => setForm({ ...form, account_info: e.target.value })} className="col-span-2" />
          <TextField placeholder="Moneda" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
          <TextField type="number" step="0.000001" placeholder="Tasa a USD" value={form.usd_rate} onChange={(e) => setForm({ ...form, usd_rate: e.target.value })} />
          <TextArea rows={2} placeholder="Instrucciones extra" value={form.extra_info} onChange={(e) => setForm({ ...form, extra_info: e.target.value })} className="col-span-2" />
        </div>
        <div className="mt-2 flex justify-end">
          <Button onClick={async () => {
            if (!form.country_code || !form.method_name || !form.account_info) return;
            await create({ data: { ...form, usd_rate: Number(form.usd_rate) } });
            setForm({ country_code: "", country_name: "", method_name: "", holder_name: "", account_info: "", extra_info: "", currency: "USD", usd_rate: "1" });
            refetchOverview();
          }}><Plus className="h-4 w-4" /> Crear</Button>
        </div>
      </GlassCard>

      <div className="space-y-2">
        {data.methods.map((m) => (
          <GlassCard key={m.id}>
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">{m.country_code} · {m.method_name}</div>
                <div className="text-[10px] text-white/50">{m.holder_name} · {m.currency}</div>
              </div>
              <Button variant="danger" onClick={() => { if (confirm("¿Eliminar método?")) del({ data: { id: m.id } }).then(() => refetchOverview()); }}><Trash2 className="h-4 w-4" /></Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <TextField defaultValue={m.method_name} onBlur={(e) => e.target.value !== m.method_name && upd({ data: { id: m.id, method_name: e.target.value } }).then(() => refetchOverview())} />
              <TextField defaultValue={m.holder_name} onBlur={(e) => e.target.value !== m.holder_name && upd({ data: { id: m.id, holder_name: e.target.value } }).then(() => refetchOverview())} />
              <TextField defaultValue={m.account_info} onBlur={(e) => e.target.value !== m.account_info && upd({ data: { id: m.id, account_info: e.target.value } }).then(() => refetchOverview())} className="col-span-2" />
              <TextField defaultValue={m.currency} onBlur={(e) => e.target.value !== m.currency && upd({ data: { id: m.id, currency: e.target.value.toUpperCase() } }).then(() => refetchOverview())} />
              <TextField type="number" step="0.000001" defaultValue={m.usd_rate} onBlur={(e) => Number(e.target.value) !== Number(m.usd_rate) && upd({ data: { id: m.id, usd_rate: Number(e.target.value) } }).then(() => refetchOverview())} />
              <TextArea rows={2} defaultValue={m.extra_info ?? ""} onBlur={(e) => (e.target.value || null) !== m.extra_info && upd({ data: { id: m.id, extra_info: e.target.value || null } }).then(() => refetchOverview())} className="col-span-2" />
              <label className="col-span-2 flex items-center gap-2 text-xs">
                <input type="checkbox" defaultChecked={m.active} onChange={(e) => upd({ data: { id: m.id, active: e.target.checked } }).then(() => refetchOverview())} />
                Activo
              </label>
            </div>
          </GlassCard>
        ))}
      </div>
    </div>
  );
}
