/**
 * Type declarations for the tgcloud platform SDK.
 *
 * Inside the isolate these modules (`sdk`, `sdk/db`, `sdk/api`, `sdk/fetch`) are
 * provided by the platform; they are never bundled and never installed from npm.
 * Locally they resolve to `tests/mocks/sdk.ts` (see vitest.config.ts).
 *
 * Reference: tgcloud platform SDK documentation
 */

declare module 'sdk/db' {
  /** Result of a `` sql`…` `` tag: text with named parameters `:p1`, `:p2`, … */
  export interface Sql {
    readonly __sql?: true;
    readonly text: string;
    readonly params: Record<string, unknown>;
  }

  export interface SqlTag {
    (strings: TemplateStringsArray, ...values: readonly unknown[]): Sql;
    /** Literal SQL, no parameter binding. */
    raw(literal: string): Sql;
  }

  export const sql: SqlTag;

  export type ColumnMode = 'boolean' | 'json' | 'timestamp' | 'timestamp_ms' | 'bytes';

  export interface ColumnOptions {
    mode?: ColumnMode;
  }

  /** A column reference — used both in the schema DSL and inside queries. */
  export interface Column<T = unknown> {
    readonly __column?: true;
    readonly name: string;
    readonly key?: string;
    readonly tableName?: string | null;
    readonly mode?: ColumnMode;
    notNull(): this;
    unique(): this;
    default(value: unknown): this;
    primaryKey(opts?: { autoIncrement?: boolean }): this;
    /** Foreign keys are unsupported by the platform: this throws. */
    references(...args: unknown[]): never;
    constraint(ddl: string): this;
    generatedAlwaysAs(expr: Sql, opts?: { mode?: 'virtual' | 'stored' }): this;
    deprecated(reason?: string): this;
  }

  export type ColumnFactory = <T = unknown>(name?: string, opts?: ColumnOptions) => Column<T>;

  export const text: ColumnFactory;
  export const integer: ColumnFactory;
  export const real: ColumnFactory;
  export const float: ColumnFactory;
  export const numeric: ColumnFactory;
  export const blob: ColumnFactory;
  export const boolean: ColumnFactory;
  export const json: ColumnFactory;

  export interface IndexDef {
    readonly name: string;
    on(...cols: unknown[]): IndexDef;
    where(cond: Sql): IndexDef;
  }

  export interface ConstraintDef {
    readonly name: string;
    on?(...cols: Column[]): ConstraintDef;
  }

  export function index(name: string): IndexDef;
  export function uniqueIndex(name: string): IndexDef;
  export function check(name: string, expr: Sql): ConstraintDef;
  export function primaryKey(opts: { columns: Column[] }): ConstraintDef;
  export function unique(name: string): ConstraintDef;
  /** Foreign keys are unsupported by the platform: this throws. */
  export function foreignKey(...args: unknown[]): never;

  /** Minimal shape every table descriptor satisfies (use it for query params). */
  export interface AnyTable {
    readonly name: string;
    readonly columns?: Record<string, Column>;
  }

  export type TableExtras<C extends Record<string, Column>> = (t: C) => Record<string, unknown>;

  /** `table()` returns the descriptor with every column exposed as a property. */
  export type Table<C extends Record<string, Column> = Record<string, Column>> = C & {
    readonly name: string;
    readonly columns: C;
    strict(): this;
    withoutRowid(): this;
    constraint(ddl: string, name?: string): this;
    deprecated(reason?: string): this;
  };

  export function table<C extends Record<string, Column>>(
    name: string,
    columns: C,
    extra?: TableExtras<C>,
  ): Table<C>;

  // --- operators -----------------------------------------------------------

  export type Condition = unknown;

  export function eq(left: unknown, right: unknown): Condition;
  export function ne(left: unknown, right: unknown): Condition;
  export function gt(left: unknown, right: unknown): Condition;
  export function gte(left: unknown, right: unknown): Condition;
  export function lt(left: unknown, right: unknown): Condition;
  export function lte(left: unknown, right: unknown): Condition;
  export function like(left: unknown, right: unknown): Condition;
  export function notLike(left: unknown, right: unknown): Condition;
  export function isNull(expr: unknown): Condition;
  export function isNotNull(expr: unknown): Condition;
  export function and(...conds: Condition[]): Condition;
  export function or(...conds: Condition[]): Condition;
  export function not(cond: Condition): Condition;
  export function between(expr: unknown, low: unknown, high: unknown): Condition;
  export function notBetween(expr: unknown, low: unknown, high: unknown): Condition;
  export function inArray(expr: unknown, values: readonly unknown[]): Condition;
  export function notInArray(expr: unknown, values: readonly unknown[]): Condition;

  export function asc(expr: unknown): unknown;
  export function desc(expr: unknown): unknown;

  export function count(expr?: unknown): unknown;
  export function sum(expr?: unknown): unknown;
  export function avg(expr?: unknown): unknown;
  export function min(expr?: unknown): unknown;
  export function max(expr?: unknown): unknown;

  // --- builders ------------------------------------------------------------

  export interface RunResult {
    rowsAffected: number;
    lastInsertRowid: number;
    rows: Record<string, unknown>[];
  }

  export type Row = Record<string, unknown>;

  export interface SelectBuilder<T = Row> extends PromiseLike<T[]> {
    from(table: AnyTable): SelectBuilder<T>;
    where(...conds: Condition[]): SelectBuilder<T>;
    orderBy(...items: unknown[]): SelectBuilder<T>;
    groupBy(...items: unknown[]): SelectBuilder<T>;
    having(...conds: Condition[]): SelectBuilder<T>;
    limit(n: number): SelectBuilder<T>;
    offset(n: number): SelectBuilder<T>;
    distinct(): SelectBuilder<T>;
    all(): Promise<T[]>;
    get(): Promise<T | null>;
    values(): Promise<unknown[][]>;
  }

  export interface InsertBuilder<R = Row> extends PromiseLike<RunResult> {
    values(row: Row | Row[]): InsertBuilder<R>;
    onConflictDoNothing(opts?: { target?: unknown }): InsertBuilder<R>;
    onConflictDoUpdate(opts: { target?: unknown; set: Row }): InsertBuilder<R>;
    returning(projection?: Record<string, unknown>): PromiseLike<R[]>;
    run(): Promise<RunResult | R[]>;
  }

  export interface UpdateBuilder<R = Row> extends PromiseLike<RunResult> {
    set(values: Row): UpdateBuilder<R>;
    where(...conds: Condition[]): UpdateBuilder<R>;
    returning(projection?: Record<string, unknown>): PromiseLike<R[]>;
    run(): Promise<RunResult | R[]>;
  }

  export interface DeleteBuilder<R = Row> extends PromiseLike<RunResult> {
    where(...conds: Condition[]): DeleteBuilder<R>;
    returning(projection?: Record<string, unknown>): PromiseLike<R[]>;
    run(): Promise<RunResult | R[]>;
  }

  export interface Db {
    select<T = Row>(projection?: Record<string, unknown>): SelectBuilder<T>;
    insert<R = Row>(table: AnyTable): InsertBuilder<R>;
    update<R = Row>(table: AnyTable): UpdateBuilder<R>;
    delete<R = Row>(table: AnyTable): DeleteBuilder<R>;
    $count(table: AnyTable, where?: Condition): Promise<number>;
    run(query: string | Sql, params?: Record<string, unknown>): Promise<RunResult>;
    all<T = Row>(query: string | Sql, params?: Record<string, unknown>): Promise<T[]>;
    get<T = Row>(query: string | Sql, params?: Record<string, unknown>): Promise<T | null>;
    values(query: string | Sql, params?: Record<string, unknown>): Promise<unknown[][]>;
  }

  export const db: Db;
  export default db;
}

declare module 'sdk/api' {
  /**
   * Bot API proxy: `api.<method>(params)` resolves the unwrapped `result`
   * (params use the Bot API's snake_case names) and throws `BotApiError` on
   * `{ ok: false }`.
   */
  /**
   * Bot API 10.4: marks a `sendMessage` as ephemeral (visible only to the receiver,
   * disappears on its own). For callback replies pass `callback_query_id`.
   */
  export interface EphemeralMessageParameters {
    callback_query_id?: string;
    receiver_user_id?: number;
  }

  export interface Api {
    /** Any Bot API method not listed below; resolves the unwrapped `result`. */
    [method: string]: any;
    getMe(params?: Record<string, any>): Promise<any>;
    getApp(params?: Record<string, any>): Promise<any>;
    sendMessage(params?: Record<string, any>): Promise<any>;
    editMessageText(params?: Record<string, any>): Promise<any>;
    answerCallbackQuery(params?: Record<string, any>): Promise<any>;
    sendChatAction(params?: Record<string, any>): Promise<any>;
    deleteMessage(params?: Record<string, any>): Promise<any>;
    getFileContent(fileId: string | { file_id: string }): Promise<Uint8Array>;
  }

  export const api: Api;
}

declare module 'sdk/fetch' {
  export interface FetchResponse {
    status: number;
    statusText: string;
    ok: boolean;
    url: string;
    headers: {
      get(name: string): string | null;
      has(name: string): boolean;
      keys(): IterableIterator<string>;
      entries(): IterableIterator<[string, string]>;
    };
    body: AsyncIterable<Uint8Array>;
    bodyUsed: boolean;
    json<T = any>(): Promise<T>;
    text(): Promise<string>;
  }

  export interface FetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | ArrayBuffer | object;
  }

  export interface FetchLike {
    (url: string, init?: FetchInit): Promise<FetchResponse>;
    body: {
      json(value: unknown): string;
      form(value: Record<string, unknown>): string;
      text(value: string): string;
    };
  }

  export const fetch: FetchLike;
}

declare module 'sdk' {
  export * from 'sdk/db';
  export * from 'sdk/api';
  export * from 'sdk/fetch';

  /** A file (bytes + name) to upload through `api` or `fetch`. */
  export class InputFile {
    constructor(bytes: Uint8Array | ArrayBuffer, filename: string, opts?: { type?: string });
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly type?: string;
  }

  /** Thrown by `api.<method>()` when the Bot API answers `{ ok: false }`. */
  export class BotApiError extends Error {
    readonly code: number;
    readonly description: string;
    readonly method: string;
    readonly parameters: Record<string, unknown>;
  }

  /** Thrown by an endpoint to refuse a Mini App call (→ HTTP 400). */
  export class EndpointError extends Error {
    constructor(description: string, parameters?: Record<string, unknown>);
    readonly parameters: Record<string, unknown>;
  }

  export class FormData {
    append(name: string, value: unknown, filename?: string): void;
  }
}
