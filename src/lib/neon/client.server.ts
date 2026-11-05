// Cliente de base de datos sobre Neon (vía el conector de Lovable) con la misma
// forma que el cliente supabase-js que usaba la app: from().select().eq()...
// Todas las tablas viven en el esquema "bot" de Neon.
const GATEWAY_URL = "https://connector-gateway.lovable.dev/neon/sql";
const SCHEMA = "bot";

type Row = Record<string, any>;
type DbError = { message: string; code?: string; details?: string | null; hint?: string | null };
type Result = { data: any; error: DbError | null; count?: number | null; status?: number };
type Statement = { query: string; params?: unknown[] };

function headers() {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const NEON_API_KEY = process.env.NEON_API_KEY;
  if (!LOVABLE_API_KEY || !NEON_API_KEY) throw new Error("Missing LOVABLE_API_KEY or NEON_API_KEY");
  return {
    Authorization: `Bearer ${LOVABLE_API_KEY}`,
    "X-Connection-Api-Key": NEON_API_KEY,
    "Content-Type": "application/json",
  };
}

const NUMERIC_TYPES = new Set([20, 1700]); // int8, numeric
const TS_TYPES = new Set([1184, 1114]);

function normTs(v: string, withTz: boolean) {
  let s = v.replace(" ", "T");
  if (!withTz) s += "Z";
  else if (/[+-]\d\d$/.test(s)) s += ":00";
  const d = new Date(s);
  return isNaN(d.getTime()) ? v : d.toISOString();
}

function convertRows(json: any): Row[] {
  const rows: Row[] = json?.rows ?? [];
  const fields: { name: string; dataTypeID: number }[] = json?.fields ?? [];
  const num = fields.filter((f) => NUMERIC_TYPES.has(f.dataTypeID)).map((f) => f.name);
  const ts = fields.filter((f) => TS_TYPES.has(f.dataTypeID));
  if (!num.length && !ts.length) return rows;
  for (const r of rows) {
    for (const n of num) if (r[n] != null) r[n] = Number(r[n]);
    for (const f of ts) if (typeof r[f.name] === "string") r[f.name] = normTs(r[f.name], f.dataTypeID === 1184);
  }
  return rows;
}

async function exec(body: unknown): Promise<{ ok: true; json: any } | { ok: false; error: DbError }> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    let text = "";
    try {
      res = await fetch(GATEWAY_URL, { method: "POST", headers: headers(), body: JSON.stringify(body) });
      text = await res.text();
    } catch (e: any) {
      if (attempt < 2) continue;
      return { ok: false, error: { message: `network: ${String(e?.message ?? e)}` } };
    }
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* noop */ }
    if (res.ok) return { ok: true, json };
    if ((res.status === 503 || res.status === 500 || res.status === 429) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 300 * attempt));
      continue;
    }
    console.error(`[neon] ${res.status}`, text.slice(0, 500));
    return { ok: false, error: { message: json?.message ?? text.slice(0, 300), code: json?.code ?? json?.type, details: json?.detail ?? null, hint: json?.hint ?? null } };
  }
}

export async function neonSql(query: string, params: unknown[] = []): Promise<Row[]> {
  const r = await exec({ query, params });
  if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
  return convertRows(r.json);
}

// ---------- metadatos (FKs y PKs), cacheados ----------
type Meta = {
  fks: { table: string; column: string; refTable: string; refColumn: string }[];
  pks: Map<string, string[]>;
};
let metaPromise: Promise<Meta> | null = null;
function getMeta(): Promise<Meta> {
  if (!metaPromise) {
    metaPromise = (async () => {
      const r = await exec({
        queries: [
          {
            query: `select tc.table_name as t, kcu.column_name as c, ccu.table_name as rt, ccu.column_name as rc
              from information_schema.table_constraints tc
              join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
              join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
              where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = $1`,
            params: [SCHEMA],
          },
          {
            query: `select tc.table_name as t, kcu.column_name as c
              from information_schema.table_constraints tc
              join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
              where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = $1 order by kcu.ordinal_position`,
            params: [SCHEMA],
          },
        ],
      });
      if (!r.ok) { metaPromise = null; throw new Error(r.error.message); }
      const [fkRes, pkRes] = r.json.results;
      const pks = new Map<string, string[]>();
      for (const p of pkRes.rows) pks.set(p.t, [...(pks.get(p.t) ?? []), p.c]);
      return {
        fks: fkRes.rows.map((f: any) => ({ table: f.t, column: f.c, refTable: f.rt, refColumn: f.rc })),
        pks,
      };
    })();
  }
  return metaPromise;
}

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const qt = (t: string) => `${qi(SCHEMA)}.${qi(t)}`;

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

let aliasSeq = 0;
function buildColumns(cols: string, table: string, alias: string, meta: Meta): string {
  const parts = splitTop(cols || "*");
  const out: string[] = [];
  for (const raw of parts) {
    const m = raw.match(/^(?:([a-zA-Z_][\w]*):)?([a-zA-Z_][\w]*)(?:![\w]+)?(?:!inner)?\s*\(([\s\S]*)\)$/);
    if (m) {
      const label = m[1] || m[2];
      const rel = m[2];
      const inner = m[3];
      const sub = `e${++aliasSeq}`;
      const subCols = buildColumns(inner, rel, sub, meta);
      const toOne = meta.fks.find((f) => f.table === table && f.refTable === rel);
      if (toOne) {
        out.push(`(select row_to_json(${sub}x) from (select ${subCols} from ${qt(rel)} ${sub} where ${sub}.${qi(toOne.refColumn)} = ${alias}.${qi(toOne.column)} limit 1) ${sub}x) as ${qi(label)}`);
        continue;
      }
      const toMany = meta.fks.find((f) => f.table === rel && f.refTable === table);
      if (toMany) {
        out.push(`coalesce((select json_agg(row_to_json(${sub}x)) from (select ${subCols} from ${qt(rel)} ${sub} where ${sub}.${qi(toMany.column)} = ${alias}.${qi(toMany.refColumn)}) ${sub}x), '[]'::json) as ${qi(label)}`);
        continue;
      }
      out.push(`null as ${qi(label)}`);
      continue;
    }
    if (raw === "*") { out.push(`${alias}.*`); continue; }
    const a = raw.match(/^([a-zA-Z_][\w]*):([a-zA-Z_][\w]*)$/);
    if (a) { out.push(`${alias}.${qi(a[2])} as ${qi(a[1])}`); continue; }
    out.push(`${alias}.${qi(raw.replace(/::\w+$/, ""))}`);
  }
  return out.join(", ");
}

function parseListLiteral(v: string): string[] {
  const s = v.trim().replace(/^\(/, "").replace(/\)$/, "");
  return s.split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter((x) => x.length);
}

type Filter = (params: unknown[], alias: string) => string;

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private cols = "*";
  private returning: string | null = null;
  private countMode: string | null = null;
  private head = false;
  private filters: Filter[] = [];
  private orders: { col: string; asc: boolean; nullsFirst?: boolean }[] = [];
  private lim: number | null = null;
  private off: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";
  private payload: any = null;
  private onConflict: string | null = null;
  private ignoreDup = false;

  constructor(private table: string) {}

  select(cols = "*", opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.cols = cols;
      this.countMode = opts?.count ?? null;
      this.head = Boolean(opts?.head);
    } else this.returning = cols;
    return this;
  }
  insert(rows: any, _o?: any) { this.op = "insert"; this.payload = rows; return this; }
  upsert(rows: any, o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert"; this.payload = rows; this.onConflict = o?.onConflict ?? null; this.ignoreDup = Boolean(o?.ignoreDuplicates); return this;
  }
  update(patch: any, _o?: any) { this.op = "update"; this.payload = patch; return this; }
  delete(_o?: any) { this.op = "delete"; return this; }

  private add(f: Filter) { this.filters.push(f); return this; }
  private cmp(col: string, opr: string, v: unknown) {
    return this.add((p, a) => { p.push(v); return `${a}.${qi(col)} ${opr} $${p.length}`; });
  }
  eq(col: string, v: unknown) { return v === null ? this.is(col, null) : this.cmp(col, "=", v); }
  neq(col: string, v: unknown) { return this.add((p, a) => { p.push(v); return `${a}.${qi(col)} is distinct from $${p.length}`; }); }
  gt(col: string, v: unknown) { return this.cmp(col, ">", v); }
  gte(col: string, v: unknown) { return this.cmp(col, ">=", v); }
  lt(col: string, v: unknown) { return this.cmp(col, "<", v); }
  lte(col: string, v: unknown) { return this.cmp(col, "<=", v); }
  like(col: string, v: unknown) { return this.cmp(col, "like", v); }
  ilike(col: string, v: unknown) { return this.cmp(col, "ilike", v); }
  in(col: string, vals: unknown[]) {
    return this.add((p, a) => {
      if (!vals?.length) return "false";
      p.push(vals.map((v) => (v === null ? null : String(v))));
      return `${a}.${qi(col)}::text = any($${p.length}::text[])`;
    });
  }
  is(col: string, v: null | boolean) {
    return this.add((_p, a) => `${a}.${qi(col)} is ${v === null ? "null" : v ? "true" : "false"}`);
  }
  not(col: string, opr: string, v: any) {
    if (opr === "in") {
      const list = Array.isArray(v) ? v.map(String) : parseListLiteral(String(v));
      return this.add((p, a) => { p.push(list); return `not (${a}.${qi(col)}::text = any($${p.length}::text[]))`; });
    }
    if (opr === "is") return this.add((_p, a) => `${a}.${qi(col)} is not ${v === null || v === "null" ? "null" : v}`);
    const map: Record<string, string> = { eq: "<>", neq: "=", gt: "<=", gte: "<", lt: ">=", lte: ">" };
    return this.cmp(col, map[opr] ?? "<>", v);
  }
  match(obj: Record<string, unknown>) { for (const [k, v] of Object.entries(obj)) this.eq(k, v); return this; }
  filter(col: string, opr: string, v: any) {
    if (opr === "in") return this.in(col, parseListLiteral(String(v)));
    const fn = (this as any)[opr];
    if (typeof fn === "function") return fn.call(this, col, v);
    return this.eq(col, v);
  }
  order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string; referencedTable?: string }) {
    if (o?.foreignTable || o?.referencedTable) return this;
    this.orders.push({ col, asc: o?.ascending !== false, nullsFirst: o?.nullsFirst }); return this;
  }
  limit(n: number) { this.lim = n; return this; }
  range(from: number, to: number) { this.off = from; this.lim = to - from + 1; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  abortSignal(_s: AbortSignal) { return this; }

  private where(params: unknown[], alias: string) {
    if (!this.filters.length) return "";
    return " where " + this.filters.map((f) => f(params, alias)).join(" and ");
  }

  private async build(meta: Meta): Promise<{ statements: Statement[]; countIdx: number | null; rowsIdx: number | null }> {
    const t = qt(this.table);
    const A = "t0";
    if (this.op === "select") {
      const statements: Statement[] = [];
      let countIdx: number | null = null, rowsIdx: number | null = null;
      if (this.countMode) {
        const p: unknown[] = [];
        statements.push({ query: `select count(*)::int as c from ${t} ${A}${this.where(p, A)}`, params: p });
        countIdx = 0;
      }
      if (!this.head) {
        const p: unknown[] = [];
        let q = `select ${buildColumns(this.cols, this.table, A, meta)} from ${t} ${A}${this.where(p, A)}`;
        if (this.orders.length)
          q += " order by " + this.orders.map((o) => `${A}.${qi(o.col)} ${o.asc ? "asc" : "desc"}${o.nullsFirst === undefined ? "" : o.nullsFirst ? " nulls first" : " nulls last"}`).join(", ");
        const lim = this.mode === "many" ? this.lim : this.lim ?? 2;
        if (lim != null) q += ` limit ${Number(lim)}`;
        if (this.off != null) q += ` offset ${Number(this.off)}`;
        rowsIdx = statements.length;
        statements.push({ query: q, params: p });
      }
      return { statements, countIdx, rowsIdx };
    }

    const ret = this.returning != null ? ` returning ${buildColumns(this.returning, this.table, A, meta)}` : "";
    if (this.op === "delete") {
      const p: unknown[] = [];
      return { statements: [{ query: `delete from ${t} ${A}${this.where(p, A)}${ret}`, params: p }], countIdx: null, rowsIdx: 0 };
    }
    if (this.op === "update") {
      const p: unknown[] = [];
      const sets = Object.entries(this.payload ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => { p.push(prep(v)); return `${qi(k)} = $${p.length}`; });
      if (!sets.length) return { statements: [], countIdx: null, rowsIdx: null };
      return { statements: [{ query: `update ${t} ${A} set ${sets.join(", ")}${this.where(p, A)}${ret}`, params: p }], countIdx: null, rowsIdx: 0 };
    }
    // insert / upsert
    const rows: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
    if (!rows.length) return { statements: [], countIdx: null, rowsIdx: null };
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)))];
    const p: unknown[] = [];
    const values = rows
      .map((r) => "(" + cols.map((c) => (r[c] === undefined ? "default" : (p.push(prep(r[c])), `$${p.length}`))).join(", ") + ")")
      .join(", ");
    let q = `insert into ${t} as ${A} (${cols.map(qi).join(", ")}) values ${values}`;
    if (this.op === "upsert") {
      const target = this.onConflict ? this.onConflict.split(",").map((s) => s.trim()) : meta.pks.get(this.table) ?? ["id"];
      const upd = cols.filter((c) => !target.includes(c));
      q += ` on conflict (${target.map(qi).join(", ")}) `;
      q += this.ignoreDup || !upd.length ? "do nothing" : `do update set ${upd.map((c) => `${qi(c)} = excluded.${qi(c)}`).join(", ")}`;
    }
    q += ret;
    return { statements: [{ query: q, params: p }], countIdx: null, rowsIdx: 0 };
  }

  async execute(): Promise<Result> {
    let meta: Meta;
    try { meta = await getMeta(); } catch (e: any) { return { data: null, error: { message: String(e?.message ?? e) }, count: null }; }
    const { statements, countIdx, rowsIdx } = await this.build(meta);
    if (!statements.length) return { data: this.mode === "many" ? [] : null, error: null, count: null, status: 200 };
    const r = await exec(statements.length === 1 ? statements[0] : { queries: statements });
    if (!r.ok) return { data: null, error: r.error, count: null, status: 400 };
    const results = statements.length === 1 ? [r.json] : r.json.results;
    const count = countIdx != null ? Number(results[countIdx].rows[0]?.c ?? 0) : null;
    let data: any = null;
    const isMutationNoReturn = this.op !== "select" && this.returning == null;
    if (rowsIdx != null && !isMutationNoReturn) {
      const rows = convertRows(results[rowsIdx]);
      if (this.mode === "many") data = rows;
      else if (rows.length === 1) data = rows[0];
      else if (rows.length === 0) {
        if (this.mode === "single") return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }, count, status: 406 };
        data = null;
      } else {
        return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }, count, status: 406 };
      }
    }
    return { data, error: null, count, status: 200 };
  }

  then<T1 = Result, T2 = never>(ok?: ((v: Result) => T1 | PromiseLike<T1>) | null, bad?: ((e: any) => T2 | PromiseLike<T2>) | null) {
    return this.execute().then(ok, bad);
  }
  catch<T = never>(bad: (e: any) => T | PromiseLike<T>) { return this.execute().catch(bad); }
}

function prep(v: unknown) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

async function rpc(fn: string, args: Record<string, unknown> = {}): Promise<Result> {
  const p: unknown[] = [];
  const named = Object.entries(args).map(([k, v]) => { p.push(prep(v)); return `${qi(k)} => $${p.length}`; });
  const r = await exec({ query: `select ${qt(fn)}(${named.join(", ")}) as r`, params: p });
  if (!r.ok) return { data: null, error: r.error };
  return { data: r.json.rows?.[0]?.r ?? null, error: null };
}

export const supabaseAdmin = {
  from: (table: string) => new Query(table),
  rpc,
} as any;
