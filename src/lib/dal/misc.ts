/**
 * DAL: служебные таблицы, не относящиеся к деньгам и задачам.
 *
 * Пять независимых секций (§2.4):
 *  - `kv` — глобальное key-value хранилище (без `user_id`: это кэш миграций,
 *    версии схемы и служебные флаги, общие для всей инсталляции);
 *  - `llm_usage` — расход токенов по вызовам моделей (микро-доллары);
 *  - `evolution_items` — очередь самоулучшений (идея → спека → ветка → коммит);
 *  - `entities` / `mentions` / `relations` — граф знаний пользователя;
 *  - корзина (`deleted_at` в `tasks` и `notes`) — просмотр, восстановление,
 *    окончательное удаление и автоочистка по сроку хранения.
 *
 * Внешних ключей на платформе нет, поэтому владение сущностями проверяется
 * вручную: перед записью в `mentions`/`relations` убеждаемся, что `entity_id`
 * принадлежит тому же пользователю.
 */

import { db, sql } from 'sdk/db';
import type {
  EntityKind,
  EntityRow,
  EvolutionCategory,
  EvolutionItemRow,
  EvolutionPriority,
  EvolutionStatus,
  FeedbackRow,
  IsoDate,
  IsoMonth,
  IsoTimestamp,
  KvRow,
  LlmUsageRow,
  MentionRow,
  MentionSourceType,
  RelationRow,
} from '../../types.js';
import { monthKey, nowIso, truncate } from '../utils.js';

// ---------------------------------------------------------------------------
// kv — глобальные значения (без user_id)
// ---------------------------------------------------------------------------

interface KvDbRow {
  key: string;
  value: string;
  updated_at: string | null;
}

function mapKv(row: KvDbRow): KvRow {
  return { key: row.key, value: row.value, updatedAt: row.updated_at ?? null };
}

/** Значение по ключу либо `null`, если ключа нет. */
export async function kvGet(key: string): Promise<string | null> {
  const row = await db.get<KvDbRow>(sql`
    SELECT "key", value, updated_at FROM kv WHERE "key" = ${String(key)} LIMIT 1
  `);
  return row ? row.value : null;
}

/** Записывает значение, перезаписывая существующее (upsert). */
export async function kvSet(key: string, value: string): Promise<KvRow> {
  const now = nowIso();
  const result = await db.run(sql`
    INSERT INTO kv ("key", value, updated_at) VALUES (${String(key)}, ${String(value)}, ${now})
    ON CONFLICT("key") DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    RETURNING "key", value, updated_at
  `);
  const row = result.rows[0] as unknown as KvDbRow | undefined;
  if (!row) throw new Error('misc.kvSet: upsert returned no row');
  return mapKv(row);
}

/** Удаляет ключ. `true`, если он реально был. */
export async function kvDelete(key: string): Promise<boolean> {
  const result = await db.run(sql`DELETE FROM kv WHERE "key" = ${String(key)}`);
  return result.rowsAffected > 0;
}

/**
 * Записывает значение, только если ключа ещё нет. `true` — ключ создан этим
 * вызовом, `false` — он уже был. Атомарный claim для идемпотентных проходов:
 * два параллельных прохода не должны оба получить `true` (в отличие от
 * `kvSet`, который всегда перезаписывает).
 */
export async function kvSetIfAbsent(key: string, value: string): Promise<boolean> {
  const result = await db.run(sql`
    INSERT INTO kv ("key", value, updated_at)
    VALUES (${String(key)}, ${String(value)}, ${nowIso()})
    ON CONFLICT("key") DO NOTHING
  `);
  return result.rowsAffected > 0;
}

/**
 * Атомарно прибавляет `delta` к числовому значению ключа и возвращает новое
 * значение. Сложение выполняет SQLite внутри одного оператора `UPSERT`,
 * поэтому параллельные вызовы не теряют инкрементов: схема
 * «прочитал → прибавил → записал» здесь недопустима, потому что апдейт и RPC
 * могут писать один и тот же ключ одновременно (журнал сбоев живёт в `kv`).
 *
 * `value` объявлен TEXT, но `+` в SQLite всегда арифметический; оба слагаемых
 * приводятся к INTEGER явно, иначе SQLite поднимает результат до REAL и в
 * колонке оказывается `2.0` вместо `2`. Нечисловое или отсутствующее значение
 * считается нулём — ключи версионированы, поэтому коллизия со старым форматом
 * исключена.
 */
export async function kvIncrement(key: string, delta = 1): Promise<number> {
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 1;
  const result = await db.run(sql`
    INSERT INTO kv ("key", value, updated_at)
    VALUES (${String(key)}, ${String(step)}, ${nowIso()})
    ON CONFLICT("key") DO UPDATE
       SET value = CAST(kv.value AS INTEGER) + CAST(${step} AS INTEGER),
           updated_at = excluded.updated_at
    RETURNING value
  `);
  const row = result.rows[0] as unknown as { value: unknown } | undefined;
  if (!row) throw new Error('misc.kvIncrement: upsert returned no row');
  const next = Number(row.value);
  return Number.isFinite(next) ? next : 0;
}

/**
 * Все пары `key`/`value` по префиксу — для обслуживания хранилища (чистка
 * протухших меток). Префикс экранируется от `%` и `_`: иначе `_` в имени метки
 * работал бы как подстановочный знак и захватывал чужие ключи.
 */
export async function kvListByPrefix(prefix: string): Promise<Array<{ key: string; value: string }>> {
  const pattern = `${String(prefix).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db.all<KvDbRow>(sql`
    SELECT "key", value, updated_at FROM kv
    WHERE "key" LIKE ${pattern} ESCAPE '\\'
    ORDER BY "key"
  `);
  return rows.map((row) => ({ key: row.key, value: row.value }));
}

/** Значение как JSON; отсутствующий ключ и битый json → `fallback`. */
export async function kvGetJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await kvGet(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Записывает значение как JSON. */
export async function kvSetJson(key: string, value: unknown): Promise<KvRow> {
  return kvSet(key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Крошка хода агента: где умер медленный ход и что стало с индикатором
// ---------------------------------------------------------------------------

/**
 * Почему ход остановился по времени.
 *
 * `budget` — резерв не пустил очередной вызов модели (бюджет съеден моделью),
 * `tools-skipped` — вызов прошёл, но инструменты уже не успевали.
 */
export type TurnDeadlineCause = 'budget' | 'tools-skipped';

/** Стадия, до которой ход дошёл: последняя перезаписывает предыдущую. */
export type TurnTraceStage = 'start' | 'model-start' | 'model-end' | 'send';

/** Судьба живой строки «⏳ …»: показана, оба способа отправки отказали, не открывалась. */
export type TurnIndicatorState = 'none' | 'shown' | 'unavailable';

/** Последний ход пользователя — перезаписывается каждым прогоном. */
export interface TurnTrace {
  startedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  stage: TurnTraceStage;
  /** Сколько вызовов модели ход уже сделал (первый — 1). */
  modelCalls: number;
  /** Модели, которые ответили: запасная в цепочке видна сразу. */
  models: string[];
  deadlineAt: IsoTimestamp | null;
  deadlineCause: TurnDeadlineCause | null;
  indicator: TurnIndicatorState;
  stopReason: string | null;
}

/** Счётчики ходов пользователя: сколько всего и сколько упёрлось в дедлайн. */
export interface TurnStats {
  turns: number;
  deadlineTurns: number;
  updatedAt: IsoTimestamp;
}

/** Что именно дописывается в крошку: отсутствующее поле не трогается. */
export interface TurnTracePatch {
  stage?: TurnTraceStage;
  /** Начинается ещё один вызов модели: счётчик вызовов +1. */
  modelStarted?: boolean;
  /** Модель, которая ответила (пустая строка/`null` — не записываем). */
  model?: string | null;
  /** Дедлайн сработал: время, причина и счётчик дедлайнов. */
  deadline?: TurnDeadlineCause;
  indicator?: TurnIndicatorState;
  stopReason?: string | null;
}

const TURN_TRACE_PREFIX = 'turn_trace:v1:';
const TURN_STATS_PREFIX = 'turn_stats:v1:';

const turnTraceKey = (userId: number): string => `${TURN_TRACE_PREFIX}${Number(userId)}`;
const turnStatsKey = (userId: number): string => `${TURN_STATS_PREFIX}${Number(userId)}`;

const EMPTY_TURN_STATS: TurnStats = { turns: 0, deadlineTurns: 0, updatedAt: '' };

/**
 * Крошка хода и счётчики.
 *
 * Зачем: 22.11.2026 ход «разбери инбокс» отвечал дедлайном после отказа
 * `gemini-4-hydrogen`, но ни `/diagnostics`, ни `kv` не говорили, где именно
 * ушло время и почему не появилась строка «⏳ …». Крошка отвечает на это тремя
 * фактами: до какой стадии дошёл ход, почему сработал дедлайн и что стало с
 * индикатором. В журнал сбоев она не пишется: дедлайн — латентность, а не отказ.
 *
 * Все функции молчат на ошибках хранилища — крошка не имеет права ломать ход.
 */
export async function readTurnTrace(
  userId: number,
): Promise<{ trace: TurnTrace | null; stats: TurnStats | null }> {
  try {
    const [trace, stats] = await Promise.all([
      kvGetJson<TurnTrace | null>(turnTraceKey(userId), null),
      kvGetJson<TurnStats | null>(turnStatsKey(userId), null),
    ]);
    return { trace, stats };
  } catch {
    return { trace: null, stats: null };
  }
}

/** Новый ход: чистая крошка и `turns + 1`. */
export async function startTurnTrace(userId: number): Promise<void> {
  try {
    const at = nowIso();
    const stats = await kvGetJson<TurnStats>(turnStatsKey(userId), EMPTY_TURN_STATS);
    const trace: TurnTrace = {
      startedAt: at,
      updatedAt: at,
      stage: 'start',
      modelCalls: 0,
      models: [],
      deadlineAt: null,
      deadlineCause: null,
      indicator: 'none',
      stopReason: null,
    };
    await kvSetJson(turnTraceKey(userId), trace);
    await kvSetJson(turnStatsKey(userId), {
      turns: Math.max(0, Number(stats?.turns) || 0) + 1,
      deadlineTurns: Math.max(0, Number(stats?.deadlineTurns) || 0),
      updatedAt: at,
    } satisfies TurnStats);
  } catch {
    // крошка — украшение диагностики
  }
}

/** Дописывает факт в крошку текущего хода (read-merge-write). */
export async function patchTurnTrace(userId: number, patch: TurnTracePatch): Promise<void> {
  try {
    const at = nowIso();
    const current = await kvGetJson<TurnTrace | null>(turnTraceKey(userId), null);
    const trace: TurnTrace = {
      startedAt: current?.startedAt ?? at,
      updatedAt: at,
      stage: patch.stage ?? current?.stage ?? 'start',
      modelCalls: (Math.max(0, Number(current?.modelCalls) || 0) || 0) + (patch.modelStarted ? 1 : 0),
      models: [...(Array.isArray(current?.models) ? current.models : [])],
      deadlineAt: patch.deadline ? at : (current?.deadlineAt ?? null),
      deadlineCause: patch.deadline ?? current?.deadlineCause ?? null,
      indicator: patch.indicator ?? current?.indicator ?? 'none',
      stopReason: patch.stopReason !== undefined ? patch.stopReason : (current?.stopReason ?? null),
    };
    const model = typeof patch.model === 'string' ? patch.model.trim() : '';
    if (model && !trace.models.includes(model)) trace.models.push(model);
    await kvSetJson(turnTraceKey(userId), trace);

    // Счётчик дедлайнов идёт отдельно от крошки: он переживает следующий ход.
    if (patch.deadline) {
      const stats = await kvGetJson<TurnStats>(turnStatsKey(userId), EMPTY_TURN_STATS);
      await kvSetJson(turnStatsKey(userId), {
        turns: Math.max(0, Number(stats?.turns) || 0),
        deadlineTurns: Math.max(0, Number(stats?.deadlineTurns) || 0) + 1,
        updatedAt: at,
      } satisfies TurnStats);
    }
  } catch {
    // крошка — украшение диагностики
  }
}

// ---------------------------------------------------------------------------
// Решения по обязательствам за месяц («Проверка списаний»)
// ---------------------------------------------------------------------------

/**
 * Что владелец ответил про платёж этого месяца.
 *
 * `paid` — платёж прошёл: месяц уходит в `paid_months`, остаток долга
 * уменьшается, счета и `transactions` не трогаются. `unpaid` — только решение,
 * никаких финансовых записей. `deleted` — обязательство удалено, прошлые
 * транзакции не откатываются.
 */
export type LiabilityReviewDecision = 'paid' | 'unpaid' | 'deleted';

/** Значение метки `liability_review:<user_id>:<liability_id>:<YYYY-MM>`. */
export interface LiabilityReviewRecord {
  decision: LiabilityReviewDecision;
  decidedAt: IsoTimestamp;
  /** Календарный день платежа этого месяца — он же дата платежа в DAL. */
  dueAt: IsoDate;
  status?: 'pending' | 'done';
}

/**
 * Ключ решения по обязательству за месяц.
 *
 * Решение одноразовое: метку ставит `kvSetIfAbsent` до финансового действия,
 * поэтому первое нажатие побеждает, а повтор и другое действие финансово
 * ничего не меняют. Ключ привязан к пользователю: `kv` — общая таблица без
 * `user_id`.
 */
export function liabilityReviewKey(
  userId: number,
  liabilityId: number,
  month: IsoMonth,
): string {
  return `liability_review:${userId}:${liabilityId}:${month}`;
}

// ---------------------------------------------------------------------------
// llm_usage — расход токенов
// ---------------------------------------------------------------------------

interface LlmUsageDbRow {
  id: number;
  user_id: number;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_micros: number | null;
  purpose: string | null;
  created_at: string | null;
}

function mapUsage(row: LlmUsageDbRow): LlmUsageRow {
  return {
    id: row.id,
    userId: row.user_id,
    model: row.model,
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    costMicros: Number(row.cost_micros ?? 0),
    purpose: row.purpose ?? null,
    createdAt: row.created_at ?? null,
  };
}

export interface UsageInput {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Стоимость в микро-долларах. */
  costMicros?: number;
  /** `agent` | `summary` | `embedding` | `classifier` | … */
  purpose?: string | null;
}

function nonNegativeInt(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** Записывает один вызов модели. */
export async function recordUsage(userId: number, input: UsageInput): Promise<LlmUsageRow> {
  const model = String(input.model ?? '').trim();
  if (!model) throw new Error('misc.recordUsage: model is required');

  const result = await db.run(sql`
    INSERT INTO llm_usage (user_id, model, prompt_tokens, completion_tokens, cost_micros, purpose, created_at)
    VALUES (
      ${userId}, ${model}, ${nonNegativeInt(input.promptTokens)},
      ${nonNegativeInt(input.completionTokens)}, ${nonNegativeInt(input.costMicros)},
      ${input.purpose ?? null}, ${nowIso()}
    )
    RETURNING id, user_id, model, prompt_tokens, completion_tokens, cost_micros, purpose, created_at
  `);
  const row = result.rows[0] as unknown as LlmUsageDbRow | undefined;
  if (!row) throw new Error('misc.recordUsage: insert returned no row');
  return mapUsage(row);
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  /** Количество записанных вызовов. */
  calls: number;
}

const EMPTY_TOTALS: UsageTotals = { promptTokens: 0, completionTokens: 0, costMicros: 0, calls: 0 };

interface UsageTotalsDbRow {
  calls: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_micros: number | null;
}

function mapTotals(row: UsageTotalsDbRow | null): UsageTotals {
  if (!row) return { ...EMPTY_TOTALS };
  return {
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    costMicros: Number(row.cost_micros ?? 0),
    calls: Number(row.calls ?? 0),
  };
}

/** Первое число следующего месяца — как граница `created_at < …`. */
function nextMonthStart(month: IsoMonth): IsoDate {
  const [yearRaw, monthRaw] = month.split('-');
  const year = Number(yearRaw);
  const monthNumber = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error(`misc: invalid month "${String(month)}"`);
  }
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
}

/**
 * Расход за месяц (`YYYY-MM`). Границы сравниваются как ISO-строки, поэтому
 * отдельный парсинг дат в SQL не нужен.
 */
export async function monthUsage(userId: number, month?: IsoMonth): Promise<UsageTotals> {
  const key = month ?? monthKey();
  const from = `${key.slice(0, 7)}-01`;
  const row = await db.get<UsageTotalsDbRow>(sql`
    SELECT COUNT(*) AS calls,
           COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(cost_micros), 0) AS cost_micros
      FROM llm_usage
     WHERE user_id = ${userId} AND created_at >= ${from} AND created_at < ${nextMonthStart(key.slice(0, 7))}
  `);
  return mapTotals(row);
}

/** Расход за всё время. */
export async function totalUsage(userId: number): Promise<UsageTotals> {
  const row = await db.get<UsageTotalsDbRow>(sql`
    SELECT COUNT(*) AS calls,
           COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(cost_micros), 0) AS cost_micros
      FROM llm_usage
     WHERE user_id = ${userId}
  `);
  return mapTotals(row);
}

// ---------------------------------------------------------------------------
// evolution_items — очередь самоулучшений
// ---------------------------------------------------------------------------

const EVOLUTION_COLUMNS = `id, user_id, category, title, raw_input, spec, status, priority,
  branch_name, commit_hash, created_at, updated_at`;

interface EvolutionDbRow {
  id: number;
  user_id: number;
  category: string;
  title: string;
  raw_input: string;
  spec: string | null;
  status: string;
  priority: string;
  branch_name: string | null;
  commit_hash: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function mapEvolution(row: EvolutionDbRow): EvolutionItemRow {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category as EvolutionCategory,
    title: row.title,
    rawInput: row.raw_input,
    spec: row.spec ?? null,
    status: row.status as EvolutionStatus,
    priority: row.priority as EvolutionPriority,
    branchName: row.branch_name ?? null,
    commitHash: row.commit_hash ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** Заголовок из первой содержательной строки (upstream тоже режет до 80). */
export function deriveEvolutionTitle(rawInput: string): string {
  const firstLine = String(rawInput ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return truncate(firstLine ?? 'Без названия', 80);
}

export interface CreateEvolutionItemInput {
  rawInput: string;
  title?: string;
  category?: EvolutionCategory;
  priority?: EvolutionPriority;
  /** Артефакт генерации (у скиллов — `lifeos.skill.v1`). */
  spec?: string | null;
}

export async function createEvolutionItem(
  userId: number,
  input: CreateEvolutionItemInput,
): Promise<EvolutionItemRow> {
  const rawInput = String(input.rawInput ?? '').trim();
  if (!rawInput) throw new Error('misc.createEvolutionItem: rawInput is required');
  const title = input.title?.trim() || deriveEvolutionTitle(rawInput);
  const now = nowIso();

  const result = await db.run(sql`
    INSERT INTO evolution_items (
      user_id, category, title, raw_input, spec, status, priority,
      branch_name, commit_hash, created_at, updated_at
    ) VALUES (
      ${userId}, ${input.category ?? 'feature'}, ${title}, ${rawInput}, ${input.spec ?? null},
      'pending', ${input.priority ?? 'medium'}, NULL, NULL, ${now}, ${now}
    )
    RETURNING ${sql.raw(EVOLUTION_COLUMNS)}
  `);
  const row = result.rows[0] as unknown as EvolutionDbRow | undefined;
  if (!row) throw new Error('misc.createEvolutionItem: insert returned no row');
  return mapEvolution(row);
}

export async function listEvolutionItems(
  userId: number,
  opts: { status?: EvolutionStatus; limit?: number } = {},
): Promise<EvolutionItemRow[]> {
  const statusFilter = opts.status === undefined ? sql`` : sql` AND status = ${opts.status}`;
  const limit = opts.limit === undefined ? 100 : Math.max(1, Math.trunc(opts.limit));
  const rows = await db.all<EvolutionDbRow>(sql`
    SELECT ${sql.raw(EVOLUTION_COLUMNS)}
      FROM evolution_items
     WHERE user_id = ${userId}${statusFilter}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}
  `);
  return rows.map(mapEvolution);
}

export async function getEvolutionItem(
  userId: number,
  itemId: number,
): Promise<EvolutionItemRow | null> {
  const row = await db.get<EvolutionDbRow>(sql`
    SELECT ${sql.raw(EVOLUTION_COLUMNS)}
      FROM evolution_items
     WHERE id = ${itemId} AND user_id = ${userId}
     LIMIT 1
  `);
  return row ? mapEvolution(row) : null;
}

export interface UpdateEvolutionItemInput {
  category?: EvolutionCategory;
  title?: string;
  /** `undefined` — не трогаем, `null` — очищаем. */
  spec?: string | null;
  status?: EvolutionStatus;
  priority?: EvolutionPriority;
  branchName?: string | null;
  commitHash?: string | null;
}

/**
 * Частичное обновление. Читаем-мержим-пишем: динамический `SET` из вложенных
 * sql-фрагментов ломает нумерацию параметров, а полный UPDATE по колонкам —
 * предсказуем.
 */
export async function updateEvolutionItem(
  userId: number,
  itemId: number,
  patch: UpdateEvolutionItemInput,
): Promise<EvolutionItemRow | null> {
  const current = await getEvolutionItem(userId, itemId);
  if (!current) return null;

  const category = patch.category ?? current.category;
  const title = patch.title === undefined ? current.title : patch.title.trim();
  if (!title) throw new Error('misc.updateEvolutionItem: title cannot be empty');
  const specPatch = patch.spec;
  const spec = specPatch === undefined ? current.spec : specPatch;
  const status = patch.status ?? current.status;
  const priority = patch.priority ?? current.priority;
  const branchName = patch.branchName === undefined ? current.branchName : patch.branchName;
  const commitHash = patch.commitHash === undefined ? current.commitHash : patch.commitHash;

  const result = await db.run(sql`
    UPDATE evolution_items
       SET category = ${category},
           title = ${title},
           spec = ${spec},
           status = ${status},
           priority = ${priority},
           branch_name = ${branchName},
           commit_hash = ${commitHash},
           updated_at = ${nowIso()}
     WHERE id = ${itemId} AND user_id = ${userId}
    RETURNING ${sql.raw(EVOLUTION_COLUMNS)}
  `);
  const row = result.rows[0] as unknown as EvolutionDbRow | undefined;
  return row ? mapEvolution(row) : null;
}

/**
 * Активация версии скилла: цель становится `active`, перечисленные соседи —
 * `superseded`. Явная операция DAL, а не побочный эффект `updateEvolutionItem`.
 *
 * Порядок фиксирован: сначала вытесняем соседей, потом включаем цель. Между
 * двумя UPDATE в изоляте нет транзакции (`BEGIN` заблокирован платформой), и
 * такой порядок оставляет в худшем случае ноль активных версий ключа, но
 * никогда — две.
 *
 * `supersedeItemIds` фильтруется: себя вытеснить нельзя, повторы схлопываются,
 * трогаются только реально активные строки этого же пользователя.
 */
export async function activateSkillRevision(
  userId: number,
  itemId: number,
  supersedeItemIds: readonly number[] = [],
): Promise<EvolutionItemRow | null> {
  const now = nowIso();
  const seen = new Set<number>();
  for (const raw of supersedeItemIds) {
    const id = Math.trunc(Number(raw));
    if (!Number.isFinite(id) || id <= 0 || id === itemId || seen.has(id)) continue;
    seen.add(id);
    await db.run(sql`
      UPDATE evolution_items
         SET status = 'superseded',
             updated_at = ${now}
       WHERE id = ${id} AND user_id = ${userId} AND status = 'active'
    `);
  }

  const result = await db.run(sql`
    UPDATE evolution_items
       SET status = 'active',
           updated_at = ${now}
     WHERE id = ${itemId} AND user_id = ${userId}
    RETURNING ${sql.raw(EVOLUTION_COLUMNS)}
  `);
  const row = result.rows[0] as unknown as EvolutionDbRow | undefined;
  return row ? mapEvolution(row) : null;
}

export async function deleteEvolutionItem(userId: number, itemId: number): Promise<boolean> {
  const result = await db.run(sql`
    DELETE FROM evolution_items WHERE id = ${itemId} AND user_id = ${userId}
  `);
  return result.rowsAffected > 0;
}

// ---------------------------------------------------------------------------
// Граф знаний: entities / mentions / relations
// ---------------------------------------------------------------------------

const ENTITY_COLUMNS = `id, user_id, kind, name, aliases, description, embedding, created_at`;
const MENTION_COLUMNS = `id, user_id, entity_id, source_type, source_id, context, at`;
const RELATION_COLUMNS = `id, user_id, subject_id, predicate, object_id, valid_from, valid_to, source_id`;

interface EntityDbRow {
  id: number;
  user_id: number;
  kind: string;
  name: string;
  aliases: string | null;
  description: string | null;
  embedding: string | null;
  created_at: string | null;
}

interface MentionDbRow {
  id: number;
  user_id: number;
  entity_id: number;
  source_type: string;
  source_id: number | null;
  context: string | null;
  at: string;
}

interface RelationDbRow {
  id: number;
  user_id: number;
  subject_id: number;
  predicate: string;
  object_id: number;
  valid_from: string;
  valid_to: string | null;
  source_id: number | null;
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseNumberArray(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    const numbers = raw.filter((item): item is number => typeof item === 'number');
    return numbers.length > 0 ? numbers : null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const numbers = parsed.filter((item): item is number => typeof item === 'number');
    return numbers.length > 0 ? numbers : null;
  } catch {
    return null;
  }
}

function mapEntity(row: EntityDbRow): EntityRow {
  return {
    id: row.id,
    userId: row.user_id,
    kind: (row.kind ?? 'other') as EntityKind,
    name: row.name,
    aliases: parseStringArray(row.aliases),
    description: row.description ?? null,
    embedding: parseNumberArray(row.embedding),
    createdAt: row.created_at ?? null,
  };
}

function mapMention(row: MentionDbRow): MentionRow {
  return {
    id: row.id,
    userId: row.user_id,
    entityId: row.entity_id,
    sourceType: row.source_type as MentionSourceType,
    sourceId: row.source_id === null || row.source_id === undefined ? null : Number(row.source_id),
    context: row.context ?? null,
    at: row.at,
  };
}

function mapRelation(row: RelationDbRow): RelationRow {
  return {
    id: row.id,
    userId: row.user_id,
    subjectId: row.subject_id,
    predicate: row.predicate,
    objectId: row.object_id,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? null,
    sourceId: row.source_id === null || row.source_id === undefined ? null : Number(row.source_id),
  };
}

export interface UpsertEntityInput {
  name: string;
  kind?: EntityKind;
  description?: string | null;
  aliases?: readonly string[];
  embedding?: readonly number[] | null;
}

/**
 * Нормализует имя сущности / алиас / предикат для сопоставления без учёта регистра,
 * буквы `ё`/`Ё`, окружающих кавычек и лишних пробелов.
 */
export function normalizeEntityName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^["'«»\s]+|["'«»\s]+$/g, '')
    .replace(/[ёЁ]/g, 'е')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const VALID_ENTITY_KINDS: ReadonlySet<string> = new Set<EntityKind>([
  'person',
  'place',
  'project',
  'org',
  'other',
]);

/** Валидирует `kind` сущности графа знаний (дефолт — `'other'`). */
export function normalizeEntityKind(raw: unknown): EntityKind {
  if (typeof raw !== 'string') return 'other';
  const normalized = raw.trim().toLowerCase();
  return VALID_ENTITY_KINDS.has(normalized) ? (normalized as EntityKind) : 'other';
}

/** Проверяет, содержит ли имя, алиас или описание сущности нормализованный запрос. */
export function matchesEntityQuery(
  entity: Pick<EntityRow, 'name' | 'aliases' | 'description'>,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return false;
  if (normalizeEntityName(entity.name).includes(normalizedQuery)) return true;
  if (entity.aliases.some((alias) => normalizeEntityName(alias).includes(normalizedQuery))) {
    return true;
  }
  if (normalizeEntityName(entity.description ?? '').includes(normalizedQuery)) return true;
  return false;
}

export interface ParsedKgEntity {
  name: string;
  kind: EntityKind;
  aliases: string[];
  description: string | null;
  sourceNoteId: number | null;
}

export interface ParsedKgRelation {
  subject: string;
  predicate: string;
  object: string;
  sourceNoteId: number | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalPositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/** Разбирает и санитизирует список KG-сущностей из ответа LLM или аргументов тулзы. */
export function parseKgEntities(raw: unknown): ParsedKgEntity[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedKgEntity[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || !normalizeEntityName(name)) continue;

    const aliases = Array.isArray(item.aliases)
      ? item.aliases
          .filter((alias): alias is string => typeof alias === 'string')
          .map((alias) => alias.trim())
          .filter((alias) => alias.length > 0)
      : [];
    const descriptionRaw = typeof item.description === 'string' ? item.description.trim() : '';
    const description = descriptionRaw.length > 0 ? descriptionRaw : null;

    out.push({
      name,
      kind: normalizeEntityKind(item.kind),
      aliases,
      description,
      sourceNoteId: parseOptionalPositiveInt(item.source_note_id ?? item.sourceNoteId),
    });
  }
  return out;
}

/** Разбирает и санитизирует список KG-связей (пустые, кавычки-only и self-loop отбрасываются). */
export function parseKgRelations(raw: unknown): ParsedKgRelation[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedKgRelation[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const subject = typeof item.subject === 'string' ? item.subject.trim() : '';
    const predicate =
      typeof item.predicate === 'string' ? item.predicate.trim().replace(/\s+/g, ' ') : '';
    const object = typeof item.object === 'string' ? item.object.trim() : '';

    const subjectNorm = normalizeEntityName(subject);
    const predicateNorm = normalizeEntityName(predicate);
    const objectNorm = normalizeEntityName(object);
    if (!subject || !predicate || !object || !subjectNorm || !predicateNorm || !objectNorm) {
      continue;
    }
    if (subjectNorm === objectNorm) continue;

    out.push({
      subject,
      predicate,
      object,
      sourceNoteId: parseOptionalPositiveInt(item.source_note_id ?? item.sourceNoteId),
    });
  }
  return out;
}

/**
 * Ищет сущность по нормализованному имени или алиасу и обновляет её, иначе создаёт.
 *
 * В SQLite `lower()` умеет только ASCII, поэтому загружаем сущности пользователя
 * (упорядоченные по `id ASC`) одним запросом и сравниваем через `normalizeEntityName`
 * по `[input.name, ...(input.aliases ?? [])]` (приоритет: основное `name`, затем `aliases`).
 * При слиянии:
 *  - если `input.name` отличается от `existing.name` после нормализации, добавляется в `aliases`;
 *  - `aliases` дедуплицируются по `normalizeEntityName` (с сохранением первого регистра, без `existing.name`);
 *  - `existing.kind` сохраняется, если уже специфичен (`!== 'other'`), либо повышается с `'other'` до `input.kind`.
 */
export async function upsertEntity(userId: number, input: UpsertEntityInput): Promise<EntityRow> {
  const name = String(input.name ?? '').trim();
  if (!name || !normalizeEntityName(name)) {
    throw new Error('misc.upsertEntity: name is required');
  }

  const rows = await db.all<EntityDbRow>(sql`
    SELECT ${sql.raw(ENTITY_COLUMNS)}
      FROM entities
     WHERE user_id = ${userId}
     ORDER BY id ASC
  `);
  const indexed = rows.map((row) => ({
    row,
    nameNorm: normalizeEntityName(row.name ?? ''),
    aliasNorms: parseStringArray(row.aliases).map(normalizeEntityName),
  }));

  let existingRow: EntityDbRow | null = null;
  for (const candidate of [name, ...(input.aliases ?? [])]) {
    const target = normalizeEntityName(candidate);
    if (!target) continue;
    const byName = indexed.find((entry) => entry.nameNorm === target);
    if (byName) {
      existingRow = byName.row;
      break;
    }
    const byAlias = indexed.find((entry) => entry.aliasNorms.includes(target));
    if (byAlias) {
      existingRow = byAlias.row;
      break;
    }
  }

  if (existingRow) {
    const existing = mapEntity(existingRow);
    const incomingDescription = input.description?.trim() ?? '';
    const extraAliases =
      normalizeEntityName(existing.name) !== normalizeEntityName(name)
        ? [name, ...(input.aliases ?? [])]
        : (input.aliases ?? []);
    const aliases = unionAliases(existing.aliases, extraAliases, existing.name);
    const nextKind: EntityKind =
      existing.kind !== 'other'
        ? existing.kind
        : input.kind && input.kind !== 'other'
          ? input.kind
          : existing.kind;
    const description =
      incomingDescription && !(existing.description ?? '').includes(incomingDescription)
        ? existing.description
          ? `${existing.description}; ${incomingDescription}`
          : incomingDescription
        : existing.description;
    const embedding =
      input.embedding && input.embedding.length > 0
        ? [...input.embedding]
        : existing.embedding;

    const kindChanged = nextKind !== existing.kind;
    const descriptionChanged = (description ?? null) !== (existing.description ?? null);
    const aliasesChanged = JSON.stringify(aliases) !== JSON.stringify(existing.aliases);
    const embeddingChanged =
      JSON.stringify(embedding ?? null) !== JSON.stringify(existing.embedding ?? null);
    if (!kindChanged && !descriptionChanged && !aliasesChanged && !embeddingChanged) return existing;

    const result = await db.run(sql`
      UPDATE entities
         SET kind = ${nextKind},
             aliases = ${JSON.stringify(aliases)},
             description = ${description ?? null},
             embedding = ${embedding ? JSON.stringify(embedding) : null}
       WHERE id = ${existing.id} AND user_id = ${userId}
      RETURNING ${sql.raw(ENTITY_COLUMNS)}
    `);
    const row = result.rows[0] as unknown as EntityDbRow | undefined;
    return row ? mapEntity(row) : existing;
  }

  const result = await db.run(sql`
    INSERT INTO entities (user_id, kind, name, aliases, description, embedding, created_at)
    VALUES (
      ${userId}, ${input.kind ?? 'other'}, ${name},
      ${JSON.stringify(unionAliases([], input.aliases ?? [], name))},
      ${input.description?.trim() || null},
      ${input.embedding && input.embedding.length > 0 ? JSON.stringify([...input.embedding]) : null},
      ${nowIso()}
    )
    RETURNING ${sql.raw(ENTITY_COLUMNS)}
  `);
  const row = result.rows[0] as unknown as EntityDbRow | undefined;
  if (!row) throw new Error('misc.upsertEntity: insert returned no row');
  return mapEntity(row);
}

function unionAliases(
  existing: readonly string[],
  incoming: readonly string[],
  primaryName: string,
): string[] {
  const primaryNorm = normalizeEntityName(primaryName);
  const seen = new Set<string>();
  if (primaryNorm) seen.add(primaryNorm);
  const out: string[] = [];
  for (const raw of [...existing, ...incoming]) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const key = normalizeEntityName(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Сущность по id — только если принадлежит пользователю. */
export async function getEntity(userId: number, entityId: number): Promise<EntityRow | null> {
  const row = await db.get<EntityDbRow>(sql`
    SELECT ${sql.raw(ENTITY_COLUMNS)}
      FROM entities
     WHERE id = ${entityId} AND user_id = ${userId}
     LIMIT 1
  `);
  return row ? mapEntity(row) : null;
}

/** Все сущности пользователя (опционально — только заданного вида). */
export async function listEntities(
  userId: number,
  opts: { kind?: EntityKind; limit?: number } = {},
): Promise<EntityRow[]> {
  const kindFilter = opts.kind === undefined ? sql`` : sql` AND kind = ${opts.kind}`;
  const limit = opts.limit === undefined ? 200 : Math.max(1, Math.trunc(opts.limit));
  const rows = await db.all<EntityDbRow>(sql`
    SELECT ${sql.raw(ENTITY_COLUMNS)}
      FROM entities
     WHERE user_id = ${userId}${kindFilter}
     ORDER BY name COLLATE NOCASE ASC, id ASC
     LIMIT ${limit}
  `);
  return rows.map(mapEntity);
}

/** Длина контекста упоминания — как в `kg.py` (`text[:250]`). */
const MENTION_CONTEXT_LIMIT = 250;

export interface LinkMentionInput {
  entityId: number;
  sourceType: MentionSourceType;
  sourceId?: number | null;
  /** Фрагмент текста, где сущность встретилась. */
  context?: string | null;
}

/**
 * Записывает упоминание сущности в источнике. Контекст пишется только когда
 * известен `source_id` — иначе упоминание не к чему привязать, и хранить
 * обрывок текста бессмысленно.
 */
export async function linkMention(userId: number, input: LinkMentionInput): Promise<MentionRow> {
  const entity = await getEntity(userId, Number(input.entityId));
  if (!entity) {
    throw new Error(`misc.linkMention: entity ${Number(input.entityId)} not found for user ${userId}`);
  }

  const sourceId =
    input.sourceId === undefined || input.sourceId === null ? null : Number(input.sourceId);
  const context =
    sourceId === null ? null : truncate(String(input.context ?? ''), MENTION_CONTEXT_LIMIT) || null;

  const result = await db.run(sql`
    INSERT INTO mentions (user_id, entity_id, source_type, source_id, context, at)
    VALUES (${userId}, ${entity.id}, ${input.sourceType}, ${sourceId}, ${context}, ${nowIso()})
    RETURNING ${sql.raw(MENTION_COLUMNS)}
  `);
  const row = result.rows[0] as unknown as MentionDbRow | undefined;
  if (!row) throw new Error('misc.linkMention: insert returned no row');
  return mapMention(row);
}

/** Упоминания сущности (свежие сверху). */
export async function listMentions(
  userId: number,
  entityId: number,
  limit = 50,
): Promise<MentionRow[]> {
  const rows = await db.all<MentionDbRow>(sql`
    SELECT ${sql.raw(MENTION_COLUMNS)}
      FROM mentions
     WHERE user_id = ${userId} AND entity_id = ${entityId}
     ORDER BY at DESC, id DESC
     LIMIT ${Math.max(1, Math.trunc(limit))}
  `);
  return rows.map(mapMention);
}

export interface AddRelationInput {
  subjectId: number;
  predicate: string;
  objectId: number;
  sourceId?: number | null;
  validFrom?: IsoTimestamp;
  validTo?: IsoTimestamp | null;
  replaceExistingPredicate?: boolean;
}

/**
 * Связывает две сущности. Возвращает `null`, если связь «сама с собой» —
 * такие рёбра в граф не пишем. Пустой предикат бросает ошибку. Дубль активной связи
 * (`valid_to IS NULL`, совпадение по нормализованному предикату и `object_id`)
 * не создаётся: возвращается уже существующее ребро. При `replaceExistingPredicate !== false`
 * старые активные рёбра с тем же нормализованным предикатом и другим `object_id` закрываются (`valid_to = nowIso()`).
 */
export async function addRelation(
  userId: number,
  input: AddRelationInput,
): Promise<RelationRow | null> {
  const subjectId = Number(input.subjectId);
  const objectId = Number(input.objectId);
  const predicate = String(input.predicate ?? '').trim().replace(/\s+/g, ' ');
  if (!predicate || !normalizeEntityName(predicate)) {
    throw new Error('misc.addRelation: predicate is required');
  }
  if (subjectId === objectId) return null;

  const [subject, object] = await Promise.all([
    getEntity(userId, subjectId),
    getEntity(userId, objectId),
  ]);
  if (!subject) throw new Error(`misc.addRelation: subject ${subjectId} not found for user ${userId}`);
  if (!object) throw new Error(`misc.addRelation: object ${objectId} not found for user ${userId}`);

  const now = nowIso();
  const validFrom = input.validFrom ?? now;
  const validTo = input.validTo ?? null;

  // Проверка дублей и вытеснение старых рёбер применяются только для живой связи:
  // исторический факт (validTo != null) не должен закрывать текущую активную связь.
  if (validTo === null) {
    const activeRows = await db.all<RelationDbRow>(sql`
      SELECT ${sql.raw(RELATION_COLUMNS)}
        FROM relations
       WHERE user_id = ${userId} AND subject_id = ${subjectId} AND valid_to IS NULL
       ORDER BY id ASC
    `);
    const targetPredNorm = normalizeEntityName(predicate);
    const matchingRows = activeRows.filter(
      (row) => normalizeEntityName(row.predicate) === targetPredNorm,
    );
    const sameObject = matchingRows.find((row) => row.object_id === objectId);
    if (sameObject) return mapRelation(sameObject);

    if (input.replaceExistingPredicate !== false) {
      for (const oldRow of matchingRows) {
        if (oldRow.object_id === objectId) continue;
        await db.run(sql`
          UPDATE relations
             SET valid_to = ${now}
           WHERE id = ${oldRow.id} AND user_id = ${userId} AND valid_to IS NULL
        `);
      }
    }
  }

  const sourceId =
    input.sourceId === undefined || input.sourceId === null ? null : Number(input.sourceId);

  const result = await db.run(sql`
    INSERT INTO relations (user_id, subject_id, predicate, object_id, valid_from, valid_to, source_id)
    VALUES (${userId}, ${subjectId}, ${predicate}, ${objectId}, ${validFrom}, ${validTo}, ${sourceId})
    RETURNING ${sql.raw(RELATION_COLUMNS)}
  `);
  const row = result.rows[0] as unknown as RelationDbRow | undefined;
  if (!row) throw new Error('misc.addRelation: insert returned no row');
  return mapRelation(row);
}

/** Активные связи сущности в роли субъекта. */
export async function listRelations(userId: number, subjectId: number): Promise<RelationRow[]> {
  const rows = await db.all<RelationDbRow>(sql`
    SELECT ${sql.raw(RELATION_COLUMNS)}
      FROM relations
     WHERE user_id = ${userId} AND subject_id = ${subjectId} AND valid_to IS NULL
     ORDER BY valid_from DESC, id DESC
  `);
  return rows.map(mapRelation);
}

/** Все активные связи сущности в обе стороны (`subject_id = entityId OR object_id = entityId`). */
export async function listEntityRelationsBidirectional(
  userId: number,
  entityId: number,
): Promise<RelationRow[]> {
  const rows = await db.all<RelationDbRow>(sql`
    SELECT ${sql.raw(RELATION_COLUMNS)}
      FROM relations
     WHERE user_id = ${userId} AND (subject_id = ${entityId} OR object_id = ${entityId}) AND valid_to IS NULL
     ORDER BY id ASC
  `);
  return rows.map(mapRelation);
}

// ---------------------------------------------------------------------------
// Корзина (tasks / notes с проставленным deleted_at)
// ---------------------------------------------------------------------------

/** Срок хранения удалённого — как в upstream `trash.py`. */
export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TrashItemType = 'task' | 'note';

export interface TrashTaskItem {
  kind: 'task';
  id: number;
  title: string;
  notes: string | null;
  status: string;
  categoryId: number | null;
  /** Имя категории, «Быт» если категории нет. */
  categoryName: string;
  /** Сколько подзадач висит на задаче. */
  stepsCount: number;
  createdAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp;
  daysRemaining: number;
}

export interface TrashNoteItem {
  kind: 'note';
  id: number;
  rawText: string;
  cleanText: string | null;
  column: string;
  createdAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp;
  daysRemaining: number;
}

export interface TrashList {
  tasks: TrashTaskItem[];
  notes: TrashNoteItem[];
  totalCount: number;
}

/** Сколько дней осталось до окончательного удаления (не меньше нуля). */
export function daysRemaining(
  deletedAt: string | null | undefined,
  retentionDays: number = TRASH_RETENTION_DAYS,
): number {
  if (!deletedAt) return retentionDays;
  const parsed = Date.parse(String(deletedAt));
  if (Number.isNaN(parsed)) return retentionDays;
  const elapsedDays = Math.floor((Date.now() - parsed) / DAY_MS);
  return Math.max(0, retentionDays - elapsedDays);
}

interface TrashTaskDbRow {
  id: number;
  title: string;
  notes: string | null;
  status: string;
  category_id: number | null;
  category_name: string | null;
  created_at: string | null;
  deleted_at: string;
  steps_count: number | null;
}

interface TrashNoteDbRow {
  id: number;
  raw_text: string;
  clean_text: string | null;
  column: string | null;
  created_at: string | null;
  deleted_at: string;
}

/** Содержимое корзины пользователя: только задачи верхнего уровня и заметки. */
export async function listTrash(userId: number): Promise<TrashList> {
  const [taskRows, noteRows] = await Promise.all([
    db.all<TrashTaskDbRow>(sql`
      SELECT t.id, t.title, t.notes, t.status, t.category_id, c.name AS category_name,
             t.created_at, t.deleted_at,
             (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS steps_count
        FROM tasks t
        LEFT JOIN task_categories c ON t.category_id = c.id AND c.user_id = t.user_id
       WHERE t.user_id = ${userId} AND t.parent_id IS NULL AND t.deleted_at IS NOT NULL
       ORDER BY t.deleted_at DESC, t.id DESC
    `),
    db.all<TrashNoteDbRow>(sql`
      SELECT id, raw_text, clean_text, "column", created_at, deleted_at
        FROM notes
       WHERE user_id = ${userId} AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC, id DESC
    `),
  ]);

  const tasks: TrashTaskItem[] = taskRows.map((row) => ({
    kind: 'task',
    id: row.id,
    title: row.title,
    notes: row.notes ?? null,
    status: row.status,
    categoryId: row.category_id === null || row.category_id === undefined ? null : Number(row.category_id),
    categoryName: row.category_name ?? 'Быт',
    stepsCount: Number(row.steps_count ?? 0),
    createdAt: row.created_at ?? null,
    deletedAt: row.deleted_at,
    daysRemaining: daysRemaining(row.deleted_at),
  }));

  const notes: TrashNoteItem[] = noteRows.map((row) => ({
    kind: 'note',
    id: row.id,
    rawText: row.raw_text,
    cleanText: row.clean_text ?? null,
    column: row.column ?? 'raw',
    createdAt: row.created_at ?? null,
    deletedAt: row.deleted_at,
    daysRemaining: daysRemaining(row.deleted_at),
  }));

  return { tasks, notes, totalCount: tasks.length + notes.length };
}

/**
 * В корзину: задача и все её шаги (`parent_id = id`).
 * У `notes` нет колонки `updated_at` — трогаем только `deleted_at`.
 */
export async function softDeleteTask(userId: number, taskId: number): Promise<boolean> {
  const now = nowIso();
  const result = await db.run(sql`
    UPDATE tasks
       SET deleted_at = ${now}, updated_at = ${now}
     WHERE (id = ${taskId} OR parent_id = ${taskId})
       AND user_id = ${userId} AND deleted_at IS NULL
  `);
  return result.rowsAffected > 0;
}

export async function softDeleteNote(userId: number, noteId: number): Promise<boolean> {
  const result = await db.run(sql`
    UPDATE notes
       SET deleted_at = ${nowIso()}
     WHERE id = ${noteId} AND user_id = ${userId} AND deleted_at IS NULL
  `);
  return result.rowsAffected > 0;
}

/** Достаёт элемент (с шагами, если это задача) из корзины. */
export async function restoreTrashItem(
  userId: number,
  itemType: TrashItemType,
  itemId: number,
): Promise<boolean> {
  if (itemType === 'task') {
    const result = await db.run(sql`
      UPDATE tasks
         SET deleted_at = NULL, updated_at = ${nowIso()}
       WHERE (id = ${itemId} OR parent_id = ${itemId})
         AND user_id = ${userId} AND deleted_at IS NOT NULL
    `);
    return result.rowsAffected > 0;
  }
  if (itemType === 'note') {
    const result = await db.run(sql`
      UPDATE notes
         SET deleted_at = NULL
       WHERE id = ${itemId} AND user_id = ${userId} AND deleted_at IS NOT NULL
    `);
    return result.rowsAffected > 0;
  }
  throw new Error(`misc.restoreTrashItem: unknown item type "${String(itemType)}"`);
}

/** Окончательно удаляет элемент из корзины (только уже удалённый). */
export async function purgeTrashItem(
  userId: number,
  itemType: TrashItemType,
  itemId: number,
): Promise<boolean> {
  if (itemType === 'task') {
    const result = await db.run(sql`
      DELETE FROM tasks
       WHERE (id = ${itemId} OR parent_id = ${itemId})
         AND user_id = ${userId} AND deleted_at IS NOT NULL
    `);
    return result.rowsAffected > 0;
  }
  if (itemType === 'note') {
    const result = await db.run(sql`
      DELETE FROM notes
       WHERE id = ${itemId} AND user_id = ${userId} AND deleted_at IS NOT NULL
    `);
    return result.rowsAffected > 0;
  }
  throw new Error(`misc.purgeTrashItem: unknown item type "${String(itemType)}"`);
}

export interface TrashPurgeResult {
  tasksPurged: number;
  notesPurged: number;
}

/** Опустошает корзину пользователя целиком. */
export async function emptyTrash(userId: number): Promise<TrashPurgeResult> {
  const tasks = await db.run(sql`
    DELETE FROM tasks WHERE user_id = ${userId} AND deleted_at IS NOT NULL
  `);
  const notes = await db.run(sql`
    DELETE FROM notes WHERE user_id = ${userId} AND deleted_at IS NOT NULL
  `);
  return { tasksPurged: tasks.rowsAffected, notesPurged: notes.rowsAffected };
}

/**
 * Фоновая автоочистка: удаляет всё, что пролежало в корзине дольше срока
 * хранения, у всех пользователей (это задача планировщика, не запрос юзера).
 */
export async function cleanupExpiredTrash(
  retentionDays: number = TRASH_RETENTION_DAYS,
): Promise<TrashPurgeResult> {
  const days = Math.max(0, Math.trunc(retentionDays));
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();

  const tasks = await db.run(sql`
    DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}
  `);
  const notes = await db.run(sql`
    DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}
  `);
  return { tasksPurged: tasks.rowsAffected, notesPurged: notes.rowsAffected };
}


  // -----------------------------------------------------------------------
  // §6. `feedback` — бета-фидбек: отзывы, предложения, багрепорты.
  //     Таблица добавлена после порта (в upstream отсутствует); тестер видит
  //     только свои записи, админ — все. Текст обрезается и ограничен 4000.
  // -----------------------------------------------------------------------

export type FeedbackKind = 'feedback' | 'suggestion' | 'bug';
export type FeedbackStatus = 'new' | 'ack' | 'done';

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['feedback', 'suggestion', 'bug'];
const DEFAULT_LIST_LIMIT = 100;

/** Сырая строка `feedback` (snake_case, как лежит в SQLite). */
interface FeedbackDbRow {
  id: number;
  user_id: number;
  kind: string;
  text: string;
  status: string;
  context: string | null;
  created_at: string;
}

function toFeedbackRow(row: FeedbackDbRow): FeedbackRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    kind: row.kind as FeedbackKind,
    text: row.text,
    status: row.status as FeedbackStatus,
    context: row.context,
    createdAt: row.created_at,
  };
}

/** Создаёт запись фидбека. */
export async function createFeedback(
  userId: number,
  kind: FeedbackKind,
  text: string,
  context: string | null = null,
): Promise<FeedbackRow> {
  const cleanText = text.trim().slice(0, 4000);
  const cleanContext = context?.trim().slice(0, 300) || null;
  const result = await db.run(sql`
    INSERT INTO feedback (user_id, kind, text, status, context, created_at, updated_at)
    VALUES (
      ${userId},
      ${kind},
      ${cleanText},
      ${'new'},
      ${cleanContext},
      ${nowIso()},
      ${nowIso()}
    )
  `);
  const created = await db.get<FeedbackDbRow>(sql`
    SELECT id, user_id, kind, text, status, context, created_at
    FROM feedback
    WHERE id = ${Number(result.lastInsertRowid)}
  `);
  if (!created) {
    throw new Error(`feedback: insert succeeded but row ${result.lastInsertRowid} not found`);
  }
  return toFeedbackRow(created);
}

/** Последние записи одного тестера (только свои — tenant scoping). */
export async function listFeedback(userId: number, limit = DEFAULT_LIST_LIMIT): Promise<FeedbackRow[]> {
  const rows = await db.all<FeedbackDbRow>(sql`
    SELECT id, user_id, kind, text, status, context, created_at
    FROM feedback
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `);
  return rows.map(toFeedbackRow);
}

/** Все записи — только для админского просмотра. */
export async function listAllFeedback(limit = DEFAULT_LIST_LIMIT): Promise<FeedbackRow[]> {
  const rows = await db.all<FeedbackDbRow>(sql`
    SELECT id, user_id, kind, text, status, context, created_at
    FROM feedback
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `);
  return rows.map(toFeedbackRow);
}

/** Смена статуса (админ): `ack` — принят в работу, `done` — закрыт. */
export async function updateFeedbackStatus(id: number, status: 'ack' | 'done'): Promise<void> {
  await db.run(sql`
    UPDATE feedback
    SET status = ${status}, updated_at = ${nowIso()}
    WHERE id = ${id}
  `);
}
