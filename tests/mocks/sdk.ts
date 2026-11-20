/**
 * Minimal local stand-in for the tgcloud platform SDK.
 *
 * The real `sdk`, `sdk/db`, `sdk/api`, `sdk/fetch` modules only exist inside the
 * V8 isolate. For `vitest` all of them are aliased to this file (see
 * vitest.config.ts), so production code can be imported unchanged.
 *
 * What it provides:
 *  - `db` — the query builder + schema DSL on top of better-sqlite3 (in-memory).
 *    Every terminal (`.all()`, `.get()`, `.values()`, `.run()`, `$count`) returns
 *    a Promise, exactly like the platform, and builders are awaitable.
 *  - `sql` tagged template — `${value}` becomes a named parameter `:p1`, `:p2`, …
 *    Column refs become identifiers, nested sql is spliced.
 *  - `api` — a Proxy that records every Bot API call (`api.calls`) instead of
 *    talking to Telegram.
 *  - `fetch` — injectable (`setFetchMock`) and call-recording.
 *
 * Test helpers (not part of the platform API):
 *  - `sqliteDDL(ddl)` — create tables in the in-memory database: raw SQL strings
 *    and/or table descriptors from `table()`.
 *  - `resetDb()` / `openDb()` / `closeDb()` / `getSqlite()`.
 *  - `apiCalls`, `resetApi()`, `calls`.
 *  - `setFetchMock()`, `resetFetch()`, `fetchCalls`.
 */

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// sql tagged template
// ---------------------------------------------------------------------------

export interface CompiledSql {
  readonly __sql: true;
  readonly text: string;
  readonly params: Record<string, unknown>;
}

interface CompileCtx {
  params: Record<string, unknown>;
  next: number;
}

const isCompiled = (v: unknown): v is CompiledSql =>
  typeof v === 'object' && v !== null && (v as { __sql?: unknown }).__sql === true;

const isColumn = (v: unknown): v is Column =>
  typeof v === 'object' && v !== null && (v as { __column?: unknown }).__column === true;

const isOp = (v: unknown): v is { __op: true; op: string; args: unknown[] } =>
  typeof v === 'object' && v !== null && (v as { __op?: unknown }).__op === true;

const isOrder = (v: unknown): v is { __order: true; dir: 'asc' | 'desc'; expr: unknown } =>
  typeof v === 'object' && v !== null && (v as { __order?: unknown }).__order === true;

const isAggregate = (v: unknown): v is { __agg: true; fn: string; arg: unknown } =>
  typeof v === 'object' && v !== null && (v as { __agg?: unknown }).__agg === true;

/** Boolean / Date / Uint8Array / plain objects are coerced to SQLite-bindable values. */
function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function addParam(ctx: CompileCtx, value: unknown): string {
  const key = `p${ctx.next}`;
  ctx.next += 1;
  ctx.params[key] = normalizeParam(value);
  return `:${key}`;
}

function quoteIdent(col: Column): string {
  const name = col.name.replace(/"/g, '""');
  if (!col.tableName) return `"${name}"`;
  return `"${col.tableName.replace(/"/g, '""')}"."${name}"`;
}

/** Spliced nested sql keeps its meaning but gets fresh parameter names. */
function spliceNested(nested: CompiledSql, ctx: CompileCtx): string {
  let text = nested.text;
  for (const [oldKey, value] of Object.entries(nested.params)) {
    const newKey = `p${ctx.next}`;
    ctx.next += 1;
    ctx.params[newKey] = value;
    text = text.replace(new RegExp(`:${oldKey}(?![0-9A-Za-z_])`, 'g'), `:${newKey}`);
  }
  return text;
}

function sqlTag(strings: TemplateStringsArray, ...values: unknown[]): CompiledSql {
  const ctx: CompileCtx = { params: {}, next: 1 };
  let text = '';
  for (let i = 0; i < strings.length; i += 1) {
    text += strings[i];
    if (i >= values.length) continue;
    const value = values[i];
    if (isCompiled(value)) {
      text += spliceNested(value, ctx);
    } else if (isColumn(value)) {
      text += quoteIdent(value);
    } else {
      text += addParam(ctx, value);
    }
  }
  return { __sql: true, text, params: ctx.params };
}

/** `sql\`…\`` tag; `value` → `:pN`, column → identifier, nested sql → spliced. */
export const sql = Object.assign(sqlTag, {
  raw: (literal: string): CompiledSql => ({ __sql: true, text: literal, params: {} }),
});

/** Compile a value/column/expression into a SQL fragment. */
function compileExpr(value: unknown, ctx: CompileCtx): string {
  if (isColumn(value)) return quoteIdent(value);
  if (isCompiled(value)) return spliceNested(value, ctx);
  if (isAggregate(value)) {
    const arg = value.arg === undefined ? '*' : compileExpr(value.arg, ctx);
    return `${value.fn.toUpperCase()}(${arg})`;
  }
  return addParam(ctx, value);
}

// ---------------------------------------------------------------------------
// Columns and table descriptors
// ---------------------------------------------------------------------------

export type ColumnMode = 'boolean' | 'json' | 'timestamp' | 'timestamp_ms' | 'bytes';
export type ColumnKind = 'text' | 'integer' | 'real' | 'numeric' | 'blob' | 'boolean' | 'json';

export interface ColumnOptions {
  mode?: ColumnMode | undefined;
}

export class Column {
  readonly __column = true as const;

  key = '';
  name = '';
  tableName: string | null = null;

  readonly kind: ColumnKind;
  mode: ColumnMode | undefined;

  isPrimaryKey = false;
  autoIncrement = false;
  isUnique = false;
  notNullFlag = false;
  hasDefault = false;
  defaultLiteral: unknown = undefined;
  defaultSql: CompiledSql | null = null;
  constraints: string[] = [];
  deprecatedReason: string | null = null;

  constructor(kind: ColumnKind, name?: string, opts: ColumnOptions = {}) {
    this.kind = kind;
    this.name = name ?? '';
    this.mode = opts.mode;
  }

  primaryKey(opts: { autoIncrement?: boolean } = {}): this {
    this.isPrimaryKey = true;
    this.autoIncrement = opts.autoIncrement === true;
    return this;
  }

  notNull(): this {
    this.notNullFlag = true;
    return this;
  }

  unique(): this {
    this.isUnique = true;
    return this;
  }

  default(value: unknown): this {
    this.hasDefault = true;
    if (isCompiled(value)) this.defaultSql = value;
    else this.defaultLiteral = value;
    return this;
  }

  constraint(ddl: string): this {
    this.constraints.push(ddl);
    return this;
  }

  generatedAlwaysAs(expr: CompiledSql, opts: { mode?: 'virtual' | 'stored' } = {}): this {
    this.constraints.push(
      `GENERATED ALWAYS AS (${expr.text}) ${opts.mode === 'stored' ? 'STORED' : 'VIRTUAL'}`,
    );
    return this;
  }

  deprecated(reason = ''): this {
    this.deprecatedReason = reason;
    return this;
  }

  /** Foreign keys are unsupported by the platform — declaration must fail loudly. */
  references(): never {
    throw new Error('mock sdk: foreign keys are not supported (references() throws)');
  }
}

type ColumnFactory = (name?: string, opts?: ColumnOptions) => Column;

export const text: ColumnFactory = (name, opts) => new Column('text', name, opts);
export const integer: ColumnFactory = (name, opts) => new Column('integer', name, opts);
export const real: ColumnFactory = (name, opts) => new Column('real', name, opts);
export const float: ColumnFactory = real;
export const numeric: ColumnFactory = (name, opts) => new Column('numeric', name, opts);
export const blob: ColumnFactory = (name, opts) => new Column('blob', name, opts);
export const boolean: ColumnFactory = (name, opts) =>
  new Column('boolean', name, { ...opts, mode: opts?.mode ?? 'boolean' });
export const json: ColumnFactory = (name, opts) =>
  new Column('json', name, { ...opts, mode: opts?.mode ?? 'json' });

export interface IndexDef {
  readonly __index: true;
  name: string;
  cols: unknown[];
  unique: boolean;
  partial: CompiledSql | null;
  on(...cols: unknown[]): IndexDef;
  where(cond: CompiledSql): IndexDef;
}

function makeIndex(name: string, unique: boolean): IndexDef {
  const def: IndexDef = {
    __index: true,
    name,
    cols: [],
    unique,
    partial: null,
    on(...cols: unknown[]): IndexDef {
      def.cols = cols;
      return def;
    },
    where(cond: CompiledSql): IndexDef {
      def.partial = cond;
      return def;
    },
  };
  return def;
}

export const index = (name: string): IndexDef => makeIndex(name, false);
export const uniqueIndex = (name: string): IndexDef => makeIndex(name, true);

export interface ConstraintDef {
  readonly __constraint: true;
  name: string;
  kind: 'check' | 'primaryKey' | 'unique';
  sql: CompiledSql | null;
  columns: Column[];
  on(...cols: Column[]): ConstraintDef;
}

function makeConstraint(name: string, kind: ConstraintDef['kind'], expr: CompiledSql | null): ConstraintDef {
  const def: ConstraintDef = {
    __constraint: true,
    name,
    kind,
    sql: expr,
    columns: [],
    on(...cols: Column[]): ConstraintDef {
      def.columns = cols;
      return def;
    },
  };
  return def;
}

export const check = (name: string, expr: CompiledSql): ConstraintDef => makeConstraint(name, 'check', expr);

export const primaryKey = (opts: { columns: Column[] }): ConstraintDef => {
  const def = makeConstraint('pk', 'primaryKey', null);
  def.columns = opts.columns;
  return def;
};

export const unique = (name: string): ConstraintDef => makeConstraint(name, 'unique', null);

export const foreignKey = (): never => {
  throw new Error('mock sdk: foreign keys are not supported (foreignKey() throws)');
};

export interface Table<C extends Record<string, Column> = Record<string, Column>> {
  readonly __table: true;
  name: string;
  columns: C;
  indexes: IndexDef[];
  constraints: ConstraintDef[];
  strict(): this;
  withoutRowid(): this;
  constraint(ddl: string, name?: string): this;
  deprecated(reason?: string): this;
  [key: string]: unknown;
}

/** Descriptor's own props — a column with one of these keys must not shadow it. */
const RESERVED_TABLE_KEYS = new Set([
  '__table',
  'name',
  'columns',
  'indexes',
  'constraints',
  'strict',
  'withoutRowid',
  'constraint',
  'deprecated',
]);

export function table<C extends Record<string, Column>>(
  name: string,
  columns: C,
  extra?: (t: C & Record<string, unknown>) => Record<string, unknown>,
): Table<C> & C {
  const t = {
    __table: true as const,
    name,
    columns,
    indexes: [] as IndexDef[],
    constraints: [] as ConstraintDef[],
  } as unknown as Table<C> & C;

  for (const [key, col] of Object.entries(columns)) {
    col.key = key;
    if (!col.name) col.name = key;
    col.tableName = name;
    // A column may legitimately be called `name` (users.name, accounts.name, …).
    // The descriptor's own properties win: such a column is reachable through
    // `t.columns.name`, while `t.name` still returns the SQL table name.
    if (!RESERVED_TABLE_KEYS.has(key)) (t as Record<string, unknown>)[key] = col;
  }

  t.strict = () => t;
  t.withoutRowid = () => t;
  t.constraint = () => t;
  t.deprecated = () => t;

  if (extra) {
    const extras = extra(t as C & Record<string, unknown>);
    for (const [key, value] of Object.entries(extras)) {
      if ((value as { __index?: unknown }).__index) t.indexes.push(value as IndexDef);
      else if ((value as { __constraint?: unknown }).__constraint) {
        t.constraints.push(value as ConstraintDef);
      }
      (t as Record<string, unknown>)[key] = value;
    }
  }

  return t;
}

// ---------------------------------------------------------------------------
// Global condition helpers
// ---------------------------------------------------------------------------

type OpName =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'notLike'
  | 'isNull'
  | 'isNotNull'
  | 'and'
  | 'or'
  | 'not'
  | 'between'
  | 'notBetween'
  | 'inArray'
  | 'notInArray';

interface Op {
  __op: true;
  op: OpName;
  args: unknown[];
}

const op = (name: OpName) => (...args: unknown[]): Op => ({ __op: true, op: name, args });

export const eq = op('eq');
export const ne = op('ne');
export const gt = op('gt');
export const gte = op('gte');
export const lt = op('lt');
export const lte = op('lte');
export const like = op('like');
export const notLike = op('notLike');
export const isNull = op('isNull');
export const isNotNull = op('isNotNull');
export const and = op('and');
export const or = op('or');
export const not = op('not');
export const between = op('between');
export const notBetween = op('notBetween');
export const inArray = op('inArray');
export const notInArray = op('notInArray');

export const asc = (expr: unknown): { __order: true; dir: 'asc'; expr: unknown } => ({
  __order: true,
  dir: 'asc',
  expr,
});
export const desc = (expr: unknown): { __order: true; dir: 'desc'; expr: unknown } => ({
  __order: true,
  dir: 'desc',
  expr,
});

export const count = (arg?: unknown) => ({ __agg: true as const, fn: 'count', arg });
export const sum = (arg?: unknown) => ({ __agg: true as const, fn: 'sum', arg });
export const avg = (arg?: unknown) => ({ __agg: true as const, fn: 'avg', arg });
export const min = (arg?: unknown) => ({ __agg: true as const, fn: 'min', arg });
export const max = (arg?: unknown) => ({ __agg: true as const, fn: 'max', arg });

function compileCondition(cond: unknown, ctx: CompileCtx): string {
  if (cond === undefined || cond === null) return '1';

  if (isCompiled(cond)) return spliceNested(cond, ctx);

  if (Array.isArray(cond)) {
    const parts = cond.filter((c) => c !== undefined && c !== null).map((c) => compileCondition(c, ctx));
    return parts.length === 0 ? '1' : parts.map((p) => `(${p})`).join(' AND ');
  }

  if (isOp(cond)) {
    const a = cond.args;
    switch (cond.op) {
      case 'eq':
      case 'ne':
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const [left, right] = a;
        if (cond.op === 'eq' && (left === null || right === null)) {
          return `${compileExpr(left, ctx)} IS NULL`;
        }
        if (cond.op === 'ne' && (left === null || right === null)) {
          return `${compileExpr(left, ctx)} IS NOT NULL`;
        }
        const symbol =
          cond.op === 'eq' ? '=' : cond.op === 'ne' ? '<>' : cond.op === 'gt' ? '>' : cond.op === 'gte' ? '>=' : cond.op === 'lt' ? '<' : '<=';
        return `${compileExpr(left, ctx)} ${symbol} ${compileExpr(right, ctx)}`;
      }
      case 'like':
      case 'notLike': {
        const [left, right] = a;
        return `${compileExpr(left, ctx)} ${cond.op === 'like' ? 'LIKE' : 'NOT LIKE'} ${compileExpr(right, ctx)}`;
      }
      case 'isNull':
        return `${compileExpr(a[0], ctx)} IS NULL`;
      case 'isNotNull':
        return `${compileExpr(a[0], ctx)} IS NOT NULL`;
      case 'and': {
        const items = a.flat();
        const parts = items.filter((c) => c !== undefined && c !== null).map((c) => compileCondition(c, ctx));
        return parts.length === 0 ? '1' : parts.map((p) => `(${p})`).join(' AND ');
      }
      case 'or': {
        const items = a.flat();
        const parts = items.filter((c) => c !== undefined && c !== null).map((c) => compileCondition(c, ctx));
        return parts.length === 0 ? '0' : parts.map((p) => `(${p})`).join(' OR ');
      }
      case 'not':
        return `NOT (${compileCondition(a[0], ctx)})`;
      case 'between':
      case 'notBetween': {
        const [expr, low, high] = a;
        return `${compileExpr(expr, ctx)} ${cond.op === 'between' ? 'BETWEEN' : 'NOT BETWEEN'} ${compileExpr(low, ctx)} AND ${compileExpr(high, ctx)}`;
      }
      case 'inArray':
      case 'notInArray': {
        const [expr, values] = a;
        const list = Array.isArray(values) ? values : [];
        if (list.length === 0) return cond.op === 'inArray' ? '0' : '1';
        const placeholders = list.map((v) => compileExpr(v, ctx)).join(', ');
        return `${compileExpr(expr, ctx)} ${cond.op === 'inArray' ? 'IN' : 'NOT IN'} (${placeholders})`;
      }
      default:
        throw new Error(`mock sdk: unsupported operator ${String(cond.op)}`);
    }
  }

  if (typeof cond === 'boolean') return cond ? '1' : '0';

  throw new Error(`mock sdk: unsupported condition: ${String(cond)}`);
}

// ---------------------------------------------------------------------------
// better-sqlite3 handle (swappable per test)
// ---------------------------------------------------------------------------

let database = new Database(':memory:');

/**
 * tgcloud блокирует явный `BEGIN` (SQLite authorizer, error 23), а локальный
 * better-sqlite3 — нет. Без этого флага тесты видят атомарность, которой в
 * проде нет: `withTransaction` там деградирует в обычный вызов, и всё, что
 * записано до сбоя, остаётся в базе.
 */
let beginBlocked = false;

/** Включает/выключает запрет `BEGIN`, как на платформе tgcloud. */
export function setBeginBlocked(blocked: boolean): void {
  beginBlocked = blocked;
}

export function getSqlite(): Database.Database {
  return database;
}

export function openDb(): Database.Database {
  database.close();
  database = new Database(':memory:');
  return database;
}

export function closeDb(): void {
  database.close();
}

/** Drop everything and start from an empty in-memory database. */
export function resetDb(): Database.Database {
  beginBlocked = false;
  return openDb();
}

type DdlInput = string | CompiledSql | Table | Array<string | CompiledSql | Table>;

function columnSqlType(col: Column): string {
  switch (col.mode ?? col.kind) {
    case 'boolean':
      return 'INTEGER';
    case 'json':
      return 'TEXT';
    case 'timestamp':
    case 'timestamp_ms':
      return 'INTEGER';
    case 'bytes':
      return 'BLOB';
    case 'text':
      return 'TEXT';
    case 'integer':
      return 'INTEGER';
    case 'real':
      return 'REAL';
    case 'numeric':
      return 'NUMERIC';
    case 'blob':
      return 'BLOB';
    default:
      return 'TEXT';
  }
}

function defaultSqlLiteral(col: Column): string | null {
  if (col.defaultSql) return col.defaultSql.text;
  if (!col.hasDefault) return null;
  const value = col.defaultLiteral;
  if (value === null) return 'NULL';
  if (value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  const mode = col.mode;
  if (mode === 'json') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Render a `CREATE TABLE` (+ indexes) for a table descriptor, for test fixtures. */
export function createTableSql(t: Table): string[] {
  const statements: string[] = [];
  const cols = Object.values(t.columns).map((col) => {
    let def = `"${col.name}" ${columnSqlType(col)}`;
    if (col.isPrimaryKey) def += col.autoIncrement ? ' PRIMARY KEY AUTOINCREMENT' : ' PRIMARY KEY';
    if (col.notNullFlag && !col.isPrimaryKey) def += ' NOT NULL';
    if (col.isUnique) def += ' UNIQUE';
    const dflt = defaultSqlLiteral(col);
    if (dflt !== null) def += ` DEFAULT ${dflt}`;
    if (col.constraints.length > 0) def += ` ${col.constraints.join(' ')}`;
    return def;
  });

  const tableConstraints = t.constraints
    .filter((c) => c.kind === 'primaryKey' || c.kind === 'unique' || c.kind === 'check')
    .map((c) => {
      if (c.kind === 'check') return `CONSTRAINT "${c.name}" CHECK (${c.sql ? c.sql.text : '1'})`;
      const colsSql = c.columns.map((col) => `"${col.name}"`).join(', ');
      return c.kind === 'primaryKey'
        ? `PRIMARY KEY (${colsSql})`
        : `CONSTRAINT "${c.name}" UNIQUE (${colsSql})`;
    });

  statements.push(`CREATE TABLE IF NOT EXISTS "${t.name}" (${[...cols, ...tableConstraints].join(', ')})`);

  for (const idx of t.indexes) {
    const colsSql = idx.cols
      .map((c) => (isColumn(c) ? `"${c.name}"` : isCompiled(c) ? c.text : String(c)))
      .join(', ');
    const partial = idx.partial ? ` WHERE ${idx.partial.text}` : '';
    statements.push(
      `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${idx.name}" ON "${t.name}" (${colsSql})${partial}`,
    );
  }

  return statements;
}

/**
 * Inject tables into the in-memory database: raw DDL strings and/or table
 * descriptors built with `table()`. Returns the statements that were executed.
 */
export function sqliteDDL(input: DdlInput): string[] {
  const items = Array.isArray(input) ? input : [input];
  const statements: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') statements.push(item);
    else if (isCompiled(item)) statements.push(item.text);
    else statements.push(...createTableSql(item));
  }
  for (const statement of statements) database.exec(statement);
  return statements;
}

// ---------------------------------------------------------------------------
// Row conversion (mode-aware, table-bound queries only)
// ---------------------------------------------------------------------------

function columnByName(t: Table | null, name: string): Column | undefined {
  if (!t) return undefined;
  return Object.values(t.columns).find((col) => col.name === name || col.key === name);
}

function columnByKey(t: Table, key: string): Column | undefined {
  return t.columns[key] ?? Object.values(t.columns).find((col) => col.name === key);
}

function encodeValue(col: Column | undefined, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    return col?.mode === 'timestamp_ms' ? value.getTime() : Math.floor(value.getTime() / 1000);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function decodeValue(col: Column | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (col?.mode) {
    case 'boolean':
      return Boolean(value);
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    case 'timestamp':
      return new Date(Number(value) * 1000);
    case 'timestamp_ms':
      return new Date(Number(value));
    case 'bytes':
      return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    default:
      return value;
  }
}

function decodeRow(t: Table | null, row: Record<string, unknown>): Record<string, unknown> {
  if (!t) return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = decodeValue(columnByName(t, key), value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

interface RunResult {
  rowsAffected: number;
  lastInsertRowid: number;
  rows: Record<string, unknown>[];
}

type Projection = Record<string, unknown> | undefined;

interface SelectState {
  projection: Projection;
  table: Table | null;
  where: unknown[];
  order: unknown[];
  groupBy: unknown[];
  having: unknown[];
  limit: number | undefined;
  offset: number | undefined;
  distinct: boolean;
}

function compileProjection(state: SelectState, ctx: CompileCtx): string {
  if (!state.projection) return '*';
  return Object.entries(state.projection)
    .map(([alias, expr]) => `${compileExpr(expr, ctx)} AS "${alias}"`)
    .join(', ');
}

function fromClause(t: Table | null): string {
  if (!t) throw new Error('mock sdk: .from(table) is required');
  return `"${t.name}"`;
}

function compileSelect(state: SelectState): CompiledSql {
  const ctx: CompileCtx = { params: {}, next: 1 };
  const projection = compileProjection(state, ctx);
  const where = state.where.filter((c) => c !== undefined && c !== null);
  let text = `SELECT ${state.distinct ? 'DISTINCT ' : ''}${projection} FROM ${fromClause(state.table)}`;
  if (where.length > 0) text += ` WHERE ${where.map((c) => `(${compileCondition(c, ctx)})`).join(' AND ')}`;
  if (state.groupBy.length > 0) {
    text += ` GROUP BY ${state.groupBy.map((g) => compileExpr(g, ctx)).join(', ')}`;
  }
  if (state.having.length > 0) {
    text += ` HAVING ${state.having.map((h) => `(${compileCondition(h, ctx)})`).join(' AND ')}`;
  }
  if (state.order.length > 0) {
    const parts = state.order.map((item) => {
      if (isOrder(item)) return `${compileExpr(item.expr, ctx)} ${item.dir.toUpperCase()}`;
      return `${compileExpr(item, ctx)} ASC`;
    });
    text += ` ORDER BY ${parts.join(', ')}`;
  }
  if (state.limit !== undefined) text += ` LIMIT ${Number(state.limit)}`;
  if (state.offset !== undefined) text += ` OFFSET ${Number(state.offset)}`;
  return { __sql: true, text, params: ctx.params };
}

function select(projection?: Projection) {
  const state: SelectState = {
    projection,
    table: null,
    where: [],
    order: [],
    groupBy: [],
    having: [],
    limit: undefined,
    offset: undefined,
    distinct: false,
  };

  const builder = {
    from(t: Table) {
      state.table = t;
      return builder;
    },
    where(...conds: unknown[]) {
      state.where.push(...conds);
      return builder;
    },
    orderBy(...items: unknown[]) {
      state.order.push(...items);
      return builder;
    },
    groupBy(...items: unknown[]) {
      state.groupBy.push(...items);
      return builder;
    },
    having(...conds: unknown[]) {
      state.having.push(...conds);
      return builder;
    },
    limit(n: number) {
      state.limit = n;
      return builder;
    },
    offset(n: number) {
      state.offset = n;
      return builder;
    },
    distinct() {
      state.distinct = true;
      return builder;
    },
    toSql(): CompiledSql {
      return compileSelect(state);
    },
    async all(): Promise<Record<string, unknown>[]> {
      const compiled = compileSelect(state);
      const rows = database.prepare(compiled.text).all(compiled.params) as Record<string, unknown>[];
      return rows.map((row) => decodeRow(state.table, row));
    },
    async get(): Promise<Record<string, unknown> | null> {
      const compiled = compileSelect({ ...state, limit: 1 });
      const row = database.prepare(compiled.text).get(compiled.params) as Record<string, unknown> | undefined;
      return row === undefined ? null : decodeRow(state.table, row);
    },
    async values(): Promise<unknown[][]> {
      const compiled = compileSelect(state);
      const stmt = database.prepare(compiled.text);
      stmt.raw(true);
      return stmt.all(compiled.params) as unknown[][];
    },
    then<TResult1 = Record<string, unknown>[], TResult2 = never>(
      onfulfilled?: ((value: Record<string, unknown>[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return builder.all().then(onfulfilled, onrejected);
    },
  };

  return builder;
}

interface ConflictConfig {
  type: 'nothing' | 'update';
  target?: unknown;
  set?: Record<string, unknown>;
}

interface InsertState {
  table: Table | null;
  rows: Record<string, unknown>[];
  returning: Projection | 'star' | null;
  conflict: ConflictConfig | null;
}

function insertInto(t: Table) {
  const state: InsertState = { table: t, rows: [], returning: null, conflict: null };

  const compile = (): CompiledSql => {
    if (!state.table) throw new Error('mock sdk: insert target missing');
    if (state.rows.length === 0) throw new Error('mock sdk: insert requires .values()');
    const ctx: CompileCtx = { params: {}, next: 1 };
    const keys = Object.keys(state.rows[0] ?? {});
    const columns = keys.map((key) => {
      const col = columnByKey(state.table as Table, key);
      return `"${col ? col.name : key}"`;
    });
    const tuples = state.rows.map((row) => {
      const placeholders = keys.map((key) => {
        const col = columnByKey(state.table as Table, key);
        const key2 = `p${ctx.next}`;
        ctx.next += 1;
        ctx.params[key2] = encodeValue(col, row[key]);
        return `:${key2}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    let text = `INSERT INTO "${state.table.name}" (${columns.join(', ')}) VALUES ${tuples.join(', ')}`;

    if (state.conflict && state.conflict.type === 'nothing') {
      const target = state.conflict.target as { name?: string; columns?: Record<string, Column> } | undefined;
      text += ` ON CONFLICT DO NOTHING`;
      void target;
    } else if (state.conflict && state.conflict.type === 'update') {
      const target = state.conflict.target as Record<string, Column> | undefined;
      const targetCols = target ? Object.values(target).map((col) => `"${col.name}"`).join(', ') : '';
      const set = state.conflict.set ?? {};
      const assignments = Object.entries(set).map(([key, value]) => {
        const col = columnByKey(state.table as Table, key);
        const key2 = `p${ctx.next}`;
        ctx.next += 1;
        ctx.params[key2] = encodeValue(col, value);
        return `"${col ? col.name : key}" = :${key2}`;
      });
      text += ` ON CONFLICT (${targetCols}) DO UPDATE SET ${assignments.join(', ')}`;
    }

    if (state.returning === 'star') text += ' RETURNING *';
    else if (state.returning) {
      const cols = Object.entries(state.returning)
        .map(([alias, expr]) => `${compileExpr(expr, ctx)} AS "${alias}"`)
        .join(', ');
      text += ` RETURNING ${cols}`;
    }

    return { __sql: true, text, params: ctx.params };
  };

  const execute = async (): Promise<RunResult | Record<string, unknown>[]> => {
    const compiled = compile();
    const stmt = database.prepare(compiled.text);
    if (state.returning) {
      const rows = stmt.all(compiled.params) as Record<string, unknown>[];
      return rows.map((row) => decodeRow(state.table, row));
    }
    const info = stmt.run(compiled.params);
    return {
      rowsAffected: info.changes,
      lastInsertRowid: Number(info.lastInsertRowid),
      rows: [],
    };
  };

  const builder = {
    values(rows: Record<string, unknown> | Record<string, unknown>[]) {
      state.rows = Array.isArray(rows) ? rows : [rows];
      return builder;
    },
    onConflictDoNothing(opts: { target?: unknown } = {}) {
      state.conflict = { type: 'nothing', target: opts.target };
      return builder;
    },
    onConflictDoUpdate(opts: { target?: unknown; set: Record<string, unknown> }) {
      state.conflict = { type: 'update', target: opts.target, set: opts.set };
      return builder;
    },
    returning(projection?: Record<string, unknown>) {
      state.returning = projection ?? 'star';
      return builder;
    },
    toSql(): CompiledSql {
      return compile();
    },
    async run(): Promise<RunResult | Record<string, unknown>[]> {
      return execute();
    },
    then<TResult1 = RunResult | Record<string, unknown>[], TResult2 = never>(
      onfulfilled?: ((value: RunResult | Record<string, unknown>[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return execute().then(onfulfilled, onrejected);
    },
  };

  return builder;
}

interface UpdateState {
  table: Table | null;
  set: Record<string, unknown>;
  where: unknown[];
  returning: Projection | 'star' | null;
}

function updateTable(t: Table) {
  const state: UpdateState = { table: t, set: {}, where: [], returning: null };

  const compile = (): CompiledSql => {
    if (!state.table) throw new Error('mock sdk: update target missing');
    const ctx: CompileCtx = { params: {}, next: 1 };
    const assignments = Object.entries(state.set).map(([key, value]) => {
      const col = columnByKey(state.table as Table, key);
      const param = `p${ctx.next}`;
      ctx.next += 1;
      ctx.params[param] = encodeValue(col, value);
      return `"${col ? col.name : key}" = :${param}`;
    });
    let text = `UPDATE "${state.table.name}" SET ${assignments.join(', ')}`;
    const where = state.where.filter((c) => c !== undefined && c !== null);
    if (where.length > 0) text += ` WHERE ${where.map((c) => `(${compileCondition(c, ctx)})`).join(' AND ')}`;
    if (state.returning === 'star') text += ' RETURNING *';
    else if (state.returning) {
      text += ` RETURNING ${Object.entries(state.returning)
        .map(([alias, expr]) => `${compileExpr(expr, ctx)} AS "${alias}"`)
        .join(', ')}`;
    }
    return { __sql: true, text, params: ctx.params };
  };

  const execute = async (): Promise<RunResult | Record<string, unknown>[]> => {
    const compiled = compile();
    const stmt = database.prepare(compiled.text);
    if (state.returning) {
      const rows = stmt.all(compiled.params) as Record<string, unknown>[];
      return rows.map((row) => decodeRow(state.table, row));
    }
    const info = stmt.run(compiled.params);
    return { rowsAffected: info.changes, lastInsertRowid: Number(info.lastInsertRowid), rows: [] };
  };

  const builder = {
    set(values: Record<string, unknown>) {
      state.set = values;
      return builder;
    },
    where(...conds: unknown[]) {
      state.where.push(...conds);
      return builder;
    },
    returning(projection?: Record<string, unknown>) {
      state.returning = projection ?? 'star';
      return builder;
    },
    toSql(): CompiledSql {
      return compile();
    },
    async run(): Promise<RunResult | Record<string, unknown>[]> {
      return execute();
    },
    then<TResult1 = RunResult | Record<string, unknown>[], TResult2 = never>(
      onfulfilled?: ((value: RunResult | Record<string, unknown>[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return execute().then(onfulfilled, onrejected);
    },
  };

  return builder;
}

interface DeleteState {
  table: Table | null;
  where: unknown[];
  returning: Projection | 'star' | null;
}

function deleteFrom(t: Table) {
  const state: DeleteState = { table: t, where: [], returning: null };

  const compile = (): CompiledSql => {
    if (!state.table) throw new Error('mock sdk: delete target missing');
    const ctx: CompileCtx = { params: {}, next: 1 };
    let text = `DELETE FROM "${state.table.name}"`;
    const where = state.where.filter((c) => c !== undefined && c !== null);
    if (where.length > 0) text += ` WHERE ${where.map((c) => `(${compileCondition(c, ctx)})`).join(' AND ')}`;
    if (state.returning === 'star') text += ' RETURNING *';
    else if (state.returning) {
      text += ` RETURNING ${Object.entries(state.returning)
        .map(([alias, expr]) => `${compileExpr(expr, ctx)} AS "${alias}"`)
        .join(', ')}`;
    }
    return { __sql: true, text, params: ctx.params };
  };

  const execute = async (): Promise<RunResult | Record<string, unknown>[]> => {
    const compiled = compile();
    const stmt = database.prepare(compiled.text);
    if (state.returning) {
      const rows = stmt.all(compiled.params) as Record<string, unknown>[];
      return rows.map((row) => decodeRow(state.table, row));
    }
    const info = stmt.run(compiled.params);
    return { rowsAffected: info.changes, lastInsertRowid: Number(info.lastInsertRowid), rows: [] };
  };

  const builder = {
    where(...conds: unknown[]) {
      state.where.push(...conds);
      return builder;
    },
    returning(projection?: Record<string, unknown>) {
      state.returning = projection ?? 'star';
      return builder;
    },
    toSql(): CompiledSql {
      return compile();
    },
    async run(): Promise<RunResult | Record<string, unknown>[]> {
      return execute();
    },
    then<TResult1 = RunResult | Record<string, unknown>[], TResult2 = never>(
      onfulfilled?: ((value: RunResult | Record<string, unknown>[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return execute().then(onfulfilled, onrejected);
    },
  };

  return builder;
}

// ---------------------------------------------------------------------------
// Raw SQL
// ---------------------------------------------------------------------------

type RawQuery = string | CompiledSql;

function rawParts(query: RawQuery, params?: Record<string, unknown>): { text: string; params: Record<string, unknown> } {
  if (isCompiled(query)) return { text: query.text, params: query.params };
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    normalized[key.replace(/^[:@$]/, '')] = normalizeParam(value);
  }
  return { text: query, params: normalized };
}

async function rawRun(query: RawQuery, params?: Record<string, unknown>): Promise<RunResult> {
  const { text, params: bound } = rawParts(query, params);
  if (beginBlocked && /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(text)) {
    throw new Error('SQLITE_AUTH: not authorized (tgcloud blocks explicit BEGIN)');
  }
  const stmt = database.prepare(text);
  if (stmt.reader) {
    const rows = stmt.all(bound) as Record<string, unknown>[];
    return { rowsAffected: rows.length, lastInsertRowid: 0, rows };
  }
  const info = stmt.run(bound);
  return { rowsAffected: info.changes, lastInsertRowid: Number(info.lastInsertRowid), rows: [] };
}

async function rawAll<T = Record<string, unknown>>(query: RawQuery, params?: Record<string, unknown>): Promise<T[]> {
  const { text, params: bound } = rawParts(query, params);
  return database.prepare(text).all(bound) as T[];
}

async function rawGet<T = Record<string, unknown>>(query: RawQuery, params?: Record<string, unknown>): Promise<T | null> {
  const { text, params: bound } = rawParts(query, params);
  const row = database.prepare(text).get(bound) as T | undefined;
  return row === undefined ? null : row;
}

async function rawValues(query: RawQuery, params?: Record<string, unknown>): Promise<unknown[][]> {
  const { text, params: bound } = rawParts(query, params);
  const stmt = database.prepare(text);
  stmt.raw(true);
  return stmt.all(bound) as unknown[][];
}

async function countRows(t: Table, where?: unknown): Promise<number> {
  const ctx: CompileCtx = { params: {}, next: 1 };
  let text = `SELECT COUNT(*) AS c FROM "${t.name}"`;
  if (where !== undefined && where !== null) text += ` WHERE (${compileCondition(where, ctx)})`;
  const row = database.prepare(text).get(ctx.params) as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

export const db = {
  select,
  insert: insertInto,
  update: updateTable,
  delete: deleteFrom,
  $count: countRows,
  run: rawRun,
  all: rawAll,
  get: rawGet,
  values: rawValues,
  /** Escape hatch for fixtures that need the raw better-sqlite3 handle. */
  raw(): Database.Database {
    return database;
  },
};

export default db;

// ---------------------------------------------------------------------------
// Telegram Bot API mock
// ---------------------------------------------------------------------------

export interface ApiCall {
  method: string;
  params: Record<string, unknown>;
}

const calls: ApiCall[] = [];

/** Every Bot API call recorded since the last `resetApi()` (oldest first). */
export const apiCalls: readonly ApiCall[] = calls;

export function resetApi(): void {
  calls.length = 0;
}

export function callsOf(method: string): ApiCall[] {
  return calls.filter((call) => call.method === method);
}

function fakeResult(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'getApp':
    case 'getMe':
      return { id: 42, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
    case 'sendMessage':
      return { message_id: calls.length, date: 0, chat: { id: params.chat_id }, text: params.text };
    case 'editMessageText':
      return { message_id: params.message_id, date: 0, chat: { id: params.chat_id }, text: params.text };
    case 'answerCallbackQuery':
      return true;
    case 'sendChatAction':
      return true;
    case 'deleteMessage':
      return true;
    case 'getFileContent':
      return new Uint8Array();
    default:
      return { ok: true };
  }
}

/** Bot API proxy: `api.<method>(params)` records the call and resolves a fake result. */
export const api = new Proxy({} as Record<string, unknown>, {
  get(_target, prop: string | symbol) {
    if (prop === 'then') return undefined; // never a thenable
    if (prop === 'calls') return calls;
    if (prop === 'reset') return resetApi;
    if (typeof prop !== 'string') return undefined;
    if (prop in _target) return (_target as Record<string, unknown>)[prop];
    return async (params: Record<string, unknown> = {}) => {
      calls.push({ method: prop, params });
      return fakeResult(prop, params);
    };
  },
});

export class BotApiError extends Error {
  readonly code: number;
  readonly description: string;
  readonly method: string;
  readonly parameters: Record<string, unknown>;

  constructor(method: string, code: number, description: string, parameters: Record<string, unknown> = {}) {
    super(`${method} failed: ${code} ${description}`);
    this.name = 'BotApiError';
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

export class EndpointError extends Error {
  readonly parameters: Record<string, unknown>;

  constructor(description: string, parameters: Record<string, unknown> = {}) {
    super(description);
    this.name = 'EndpointError';
    this.parameters = parameters;
  }
}

export class InputFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly type: string | undefined;

  constructor(bytes: Uint8Array | ArrayBuffer, filename: string, opts: { type?: string } = {}) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.filename = filename;
    this.type = opts.type;
  }
}

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

export interface MockResponse {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  bodyUsed: boolean;
  headers: { get(name: string): string | null; has(name: string): boolean };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface MockFetchCall {
  url: string;
  init: Record<string, unknown> | undefined;
}

export type FetchMockImpl = (url: string, init?: Record<string, unknown>) => unknown;

const fetchCalls: MockFetchCall[] = [];

function makeResponse(status: number, body: unknown, url: string): MockResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  let used = false;
  return {
    status,
    statusText: status === 200 ? 'OK' : '',
    ok: status >= 200 && status < 300,
    url,
    get bodyUsed() {
      return used;
    },
    headers: {
      get: () => 'application/json',
      has: () => true,
    },
    async json() {
      if (used) throw new TypeError('body used already');
      used = true;
      return JSON.parse(text);
    },
    async text() {
      if (used) throw new TypeError('body used already');
      used = true;
      return text;
    },
  };
}

let fetchImpl: FetchMockImpl = () => makeResponse(200, { ok: true }, '');

export function setFetchMock(impl: FetchMockImpl): void {
  fetchImpl = impl;
}

export function resetFetch(): void {
  fetchCalls.length = 0;
  fetchImpl = () => makeResponse(200, { ok: true }, '');
}

export const fetch = Object.assign(
  async (url: string, init?: Record<string, unknown>): Promise<unknown> => {
    fetchCalls.push({ url, init });
    return fetchImpl(url, init);
  },
  {
    calls: fetchCalls,
    body: {
      json: (value: unknown) => JSON.stringify(value),
      form: (value: Record<string, unknown>) =>
        Object.entries(value)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&'),
      text: (value: string) => value,
    },
  },
);

export { makeResponse };
