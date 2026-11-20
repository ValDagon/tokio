/**
 * Схема БД — единственный источник правды.
 *
 * Здесь описаны все таблицы приложения в платформенно-независимом виде (type
 * `TableDef`). Дальше работают два адаптера, и оба читают только этот файл:
 *  - `src/schema.ts` превращает TableDef в декларативный DSL платформы (`table()`
 *    из `sdk/db`) — его применяет `migrate` при деплое;
 *  - `src/db/ddl.ts` превращает тот же TableDef в `CREATE TABLE IF NOT EXISTS` —
 *    это нужно локальным тестам (better-sqlite3).
 *
 * Так исключается дрейф «локальная схема ≠ платформенная»: поменял колонку
 * здесь — она поменялась везде.
 *
 * Соглашения (SPEC §2.4):
 *  - `users.id` = telegram user id, PK без autoincrement;
 *  - `agent_state.user_id` = PK без autoincrement;
 *  - `kv` и `fx_rates` — глобальные таблицы, без `user_id`;
 *  - деньги — INTEGER центы (`*_cents`), курсы — REAL;
 *  - json-поля (эмбеддинги, aliases, metadata, thread, …) — TEXT с JSON внутри;
 *  - timestamp'ы — TEXT ISO-8601 (UTC), булевы — INTEGER 0/1;
 *  - каждая юзерская таблица имеет `user_id NOT NULL` и индекс по нему.
 */

export type ColumnType = 'integer' | 'text' | 'real';

export interface ColumnDef {
  type: ColumnType;
  /** Одноколоночный первичный ключ. */
  pk?: boolean;
  /** `INTEGER PRIMARY KEY AUTOINCREMENT` (только вместе с `pk`). */
  autoincrement?: boolean;
  unique?: boolean;
  notNull?: boolean;
  /** SQL-литерал по умолчанию: число, строка или null. */
  default?: string | number | null;
}

export interface TableIndexDef {
  columns: string[];
  unique?: boolean;
  /** По умолчанию выводится из имени таблицы и колонок. */
  name?: string;
  /** Условие частичного индекса, БЕЗ префикса `WHERE`. */
  where?: string;
}

export interface TableUniqueDef {
  columns: string[];
  name?: string;
}

export interface TableDef {
  name: string;
  columns: Record<string, ColumnDef>;
  /** Композитный первичный ключ (если не задан через `columns.*.pk`). */
  primaryKey?: string[];
  indexes?: TableIndexDef[];
  uniqueConstraints?: TableUniqueDef[];
}

// ---------------------------------------------------------------------------
// Именование объектов
// ---------------------------------------------------------------------------

function sanitize(part: string): string {
  return part
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `idx_<table>_<col1>_<col2>` */
export function indexName(table: string, columns: string[]): string {
  return `idx_${sanitize(table)}_${columns.map(sanitize).join('_')}`;
}

/** `uq_<table>_<col1>_<col2>` */
export function uniqueName(table: string, columns: string[]): string {
  return `uq_${sanitize(table)}_${columns.map(sanitize).join('_')}`;
}

// ---------------------------------------------------------------------------
// Мелкие конструкторы колонок
// ---------------------------------------------------------------------------

/** Автоинкрементный id. */
const idPk = (): ColumnDef => ({ type: 'integer', pk: true, autoincrement: true });

/** Первичный ключ без autoincrement (telegram id, user_id в agent_state). */
const naturalPk = (): ColumnDef => ({ type: 'integer', pk: true });

/** Ссылка на users.id — всегда NOT NULL. */
const userRef = (): ColumnDef => ({ type: 'integer', notNull: true });

const createdAt = (): ColumnDef => ({ type: 'text' });
const updatedAt = (): ColumnDef => ({ type: 'text' });

const userIndex = (table: string): TableIndexDef => ({
  name: indexName(table, ['user_id']),
  columns: ['user_id'],
});

/**
 * Дополняет определение: каждая юзерская таблица получает индекс по `user_id`.
 * Отдельный индекс не нужен, если есть составной индекс, начинающийся с user_id
 * (левый префикс его и покрывает).
 */
function defineTable(def: TableDef): TableDef {
  const indexes = [...(def.indexes ?? [])];
  const hasUserIndex = indexes.some((idx) => idx.columns[0] === 'user_id');
  if (def.columns.user_id && !hasUserIndex) indexes.unshift(userIndex(def.name));
  return { ...def, indexes };
}

// ---------------------------------------------------------------------------
// Таблицы
// ---------------------------------------------------------------------------

const users = defineTable({
  name: 'users',
  columns: {
    id: naturalPk(),
    name: { type: 'text' },
    language: { type: 'text', notNull: true, default: 'ru' },
    base_currency: { type: 'text', notNull: true, default: 'EUR' },
    timezone: { type: 'text', notNull: true, default: 'UTC' },
    summary_time: { type: 'text', notNull: true, default: '07:00' },
    low_stimulation_mode: { type: 'integer', notNull: true, default: 0 },
    /** Месяц квоты в формате YYYY-MM. */
    quota_month: { type: 'text' },
    quota_tokens: { type: 'integer', notNull: true, default: 0 },
    quota_limit: { type: 'integer', notNull: true, default: 0 },
    byok_ciphertext: { type: 'text' },
    byok_nonce: { type: 'text' },
    byok_tag: { type: 'text' },
    /** Провайдер BYOK-ключа (gemini|openai|deepseek|anthropic); NULL = Gemini (легаси). */
    model_provider: { type: 'text' },
    /** Статус онбординга: new | overview | timezone | currency | accounts | practice | notifications | gemini | final | completed | skipped */
    onboarding_step: { type: 'text', notNull: true, default: 'completed' },
    onboarding_completed_at: { type: 'text' },
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
});

const taskCategories = defineTable({
  name: 'task_categories',
  columns: {
    id: idPk(),
    user_id: userRef(),
    name: { type: 'text', notNull: true },
    color: { type: 'text' },
    position: { type: 'integer', notNull: true, default: 0 },
    created_at: createdAt(),
  },
  uniqueConstraints: [{ columns: ['user_id', 'name'] }],
});

const taskSubcategories = defineTable({
  name: 'task_subcategories',
  columns: {
    id: idPk(),
    user_id: userRef(),
    category_id: { type: 'integer', notNull: true },
    name: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true, default: 0 },
    created_at: createdAt(),
  },
  uniqueConstraints: [{ columns: ['category_id', 'name'] }],
  indexes: [{ name: indexName('task_subcategories', ['category_id']), columns: ['category_id'] }],
});

const tasks = defineTable({
  name: 'tasks',
  columns: {
    id: idPk(),
    user_id: userRef(),
    category_id: { type: 'integer' },
    subcategory_id: { type: 'integer' },
    parent_id: { type: 'integer' },
    title: { type: 'text', notNull: true },
    notes: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'todo' },
    /** 'task' (обычная задача) или 'event' (событие/встреча с фиксированным днем). */
    item_type: { type: 'text', notNull: true, default: 'task' },
    position: { type: 'integer', notNull: true, default: 0 },
    source_text: { type: 'text' },
    created_at: createdAt(),
    completed_at: { type: 'text' },
    updated_at: updatedAt(),
    due_at: { type: 'text' },
    remind_at: { type: 'text' },
    reminder_sent: { type: 'integer', notNull: true, default: 0 },
    /** Правило повтора (json-текст), null — задача без повтора. */
    recurrence: { type: 'text' },
    /** Soft delete: попадает в «корзину». */
    deleted_at: { type: 'text' },
  },
  indexes: [
    { name: indexName('tasks', ['user_id', 'status']), columns: ['user_id', 'status'] },
    { name: indexName('tasks', ['parent_id']), columns: ['parent_id'] },
    { name: indexName('tasks', ['category_id']), columns: ['category_id'] },
    { name: indexName('tasks', ['subcategory_id']), columns: ['subcategory_id'] },
    {
      name: 'idx_tasks_remind_at_pending',
      columns: ['remind_at'],
      where: `"remind_at" IS NOT NULL AND "reminder_sent" = 0 AND "status" = 'todo' AND "deleted_at" IS NULL`,
    },
    {
      name: 'idx_tasks_trash',
      columns: ['user_id', 'deleted_at'],
      where: `"deleted_at" IS NOT NULL`,
    },
  ],
});

const accounts = defineTable({
  name: 'accounts',
  columns: {
    id: idPk(),
    user_id: userRef(),
    name: { type: 'text', notNull: true },
    currency: { type: 'text', notNull: true },
    initial_balance_cents: { type: 'integer', notNull: true, default: 0 },
    current_balance_cents: { type: 'integer', notNull: true, default: 0 },
    /**
     * Конверт счёта: `spendable` (свободные деньги) | `reserved` (уже
     * распределены под обязательства). Per-user классификация вместо
     * хардкода имён банков из upstream (runway.classify_envelope) — ADR-002.
     */
    envelope: { type: 'text', notNull: true, default: 'spendable' },
    is_active: { type: 'integer', notNull: true, default: 1 },
    created_at: createdAt(),
  },
  uniqueConstraints: [{ columns: ['user_id', 'name', 'currency'] }],
});

/**
 * Системная документация юзера (Docs-as-Code) — per-user главы вместо
 * вшитых в код текстов upstream `docs/system/*.md` (ADR-002: контент глав —
 * данные юзера, сеются нейтральными продуктовыми дефолтами).
 */
const docChapters = defineTable({
  name: 'doc_chapters',
  columns: {
    id: idPk(),
    user_id: userRef(),
    /** Слаг главы, например `01_finances_and_debts`. */
    slug: { type: 'text', notNull: true },
    /** Имя файла-источника (для цитат «Источник: docs/system/…»). */
    filename: { type: 'text' },
    title: { type: 'text', notNull: true },
    /** Markdown-текст главы целиком. */
    content: { type: 'text', notNull: true },
    /** Защищена от перезаписи сидом дефолтных глав. */
    is_pinned: { type: 'integer', notNull: true, default: 0 },
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  uniqueConstraints: [{ columns: ['user_id', 'slug'] }],
});

const finCategories = defineTable({
  name: 'fin_categories',
  columns: {
    id: idPk(),
    user_id: userRef(),
    name: { type: 'text', notNull: true },
    /** `expense` | `income`. */
    kind: { type: 'text', notNull: true, default: 'expense' },
    icon: { type: 'text' },
    created_at: createdAt(),
  },
  uniqueConstraints: [{ columns: ['user_id', 'kind', 'name'] }],
});

const transactions = defineTable({
  name: 'transactions',
  columns: {
    id: idPk(),
    user_id: userRef(),
    /** `expense` | `income` | `transfer`. */
    kind: { type: 'text', notNull: true },
    account_id: { type: 'integer', notNull: true },
    /** Счёт-получатель для transfer. */
    to_account_id: { type: 'integer' },
    amount_cents: { type: 'integer', notNull: true },
    currency: { type: 'text', notNull: true },
    fx_rate: { type: 'real', notNull: true, default: 1 },
    amount_eur_cents: { type: 'integer', notNull: true },
    category_id: { type: 'integer' },
    description: { type: 'text' },
    occurred_at: { type: 'text', notNull: true },
    transfer_group_id: { type: 'text' },
    receipt_file_id: { type: 'text' },
    raw_text: { type: 'text' },
    created_at: createdAt(),
  },
  indexes: [
    { name: indexName('transactions', ['user_id', 'occurred_at']), columns: ['user_id', 'occurred_at'] },
    { name: indexName('transactions', ['account_id']), columns: ['account_id'] },
    { name: indexName('transactions', ['category_id']), columns: ['category_id'] },
  ],
});

const budgets = defineTable({
  name: 'budgets',
  columns: {
    id: idPk(),
    user_id: userRef(),
    category_id: { type: 'integer', notNull: true },
    /** Месяц бюджета, YYYY-MM. */
    month: { type: 'text', notNull: true },
    limit_amount_eur_cents: { type: 'integer', notNull: true },
    created_at: createdAt(),
  },
  uniqueConstraints: [{ columns: ['user_id', 'category_id', 'month'] }],
  indexes: [{ name: indexName('budgets', ['user_id', 'month']), columns: ['user_id', 'month'] }],
});

const liabilities = defineTable({
  name: 'liabilities',
  columns: {
    id: idPk(),
    user_id: userRef(),
    name: { type: 'text', notNull: true },
    /** Очередь выплат: `queue_1`, `queue_2`, … */
    queue: { type: 'text', notNull: true, default: 'queue_1' },
    amount_cents: { type: 'integer', notNull: true, default: 0 },
    currency: { type: 'text', notNull: true, default: 'EUR' },
    amount_eur_cents: { type: 'integer', notNull: true, default: 0 },
    monthly_payment_cents: { type: 'integer', notNull: true, default: 0 },
    /** День месяца для платежа (1..31). */
    payment_day: { type: 'integer' },
    total_payments: { type: 'integer' },
    end_date: { type: 'text' },
    notes: { type: 'text' },
    is_active: { type: 'integer', notNull: true, default: 1 },
    /** json-массив оплаченных месяцев: ["2026-01", …]. */
    paid_months: { type: 'text', notNull: true, default: '[]' },
    last_payment_date: { type: 'text' },
    account_id: { type: 'integer' },
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  indexes: [{ name: indexName('liabilities', ['account_id']), columns: ['account_id'] }],
});

/** Глобальная таблица курсов: PK(date, base), без user_id. */
const fxRates = defineTable({
  name: 'fx_rates',
  columns: {
    /** Дата курса, YYYY-MM-DD. */
    date: { type: 'text', notNull: true },
    /** Базовая валюта, обычно EUR. */
    base: { type: 'text', notNull: true, default: 'EUR' },
    /** json-объект {USD: 1.08, …}. */
    rates: { type: 'text', notNull: true },
    updated_at: updatedAt(),
  },
  primaryKey: ['date', 'base'],
});

const notes = defineTable({
  name: 'notes',
  columns: {
    id: idPk(),
    user_id: userRef(),
    raw_text: { type: 'text', notNull: true },
    clean_text: { type: 'text' },
    /** Колонка канбана (inbox column): `raw`, `todo`, … */
    column: { type: 'text', notNull: true, default: 'raw' },
    /** json-массив 768 float'ов. */
    embedding: { type: 'text' },
    merged_into: { type: 'integer' },
    source_message_id: { type: 'integer' },
    /** `text` | `voice` | `photo` | `document`. */
    source_type: { type: 'text', notNull: true, default: 'text' },
    file_id: { type: 'text' },
    /** json-объект метаданных. */
    metadata: { type: 'text', notNull: true, default: '{}' },
    deleted_at: { type: 'text' },
    processed_at: { type: 'text' },
    created_at: createdAt(),
  },
  indexes: [
    { name: indexName('notes', ['user_id', 'column']), columns: ['user_id', 'column'] },
    { name: indexName('notes', ['source_type']), columns: ['source_type'] },
    {
      name: 'idx_notes_trash',
      columns: ['user_id', 'deleted_at'],
      where: `"deleted_at" IS NOT NULL`,
    },
  ],
});

const entities = defineTable({
  name: 'entities',
  columns: {
    id: idPk(),
    user_id: userRef(),
    /** `person` | `place` | `project` | `org` | `other`. */
    kind: { type: 'text', notNull: true, default: 'other' },
    name: { type: 'text', notNull: true },
    /** json-массив альтернативных имён. */
    aliases: { type: 'text', notNull: true, default: '[]' },
    description: { type: 'text' },
    embedding: { type: 'text' },
    created_at: createdAt(),
  },
  uniqueConstraints: [{ columns: ['user_id', 'kind', 'name'] }],
  indexes: [{ name: indexName('entities', ['user_id', 'kind']), columns: ['user_id', 'kind'] }],
});

const mentions = defineTable({
  name: 'mentions',
  columns: {
    id: idPk(),
    user_id: userRef(),
    entity_id: { type: 'integer', notNull: true },
    /** `note` | `message` | `transaction` | `task`. */
    source_type: { type: 'text', notNull: true },
    source_id: { type: 'integer' },
    context: { type: 'text' },
    at: { type: 'text', notNull: true },
  },
  indexes: [{ name: indexName('mentions', ['entity_id']), columns: ['entity_id'] }],
});

const relations = defineTable({
  name: 'relations',
  columns: {
    id: idPk(),
    user_id: userRef(),
    subject_id: { type: 'integer', notNull: true },
    predicate: { type: 'text', notNull: true },
    object_id: { type: 'integer', notNull: true },
    valid_from: { type: 'text', notNull: true },
    /** null — связь актуальна. */
    valid_to: { type: 'text' },
    source_id: { type: 'integer' },
  },
  indexes: [
    {
      name: indexName('relations', ['user_id', 'subject_id', 'valid_to']),
      columns: ['user_id', 'subject_id', 'valid_to'],
    },
  ],
});

const messages = defineTable({
  name: 'messages',
  columns: {
    id: idPk(),
    user_id: userRef(),
    /** `user` | `assistant` | `system`. */
    role: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    /** json-объект метаданных шага диалога (tool calls и т.п.). */
    meta: { type: 'text', notNull: true, default: '{}' },
    created_at: createdAt(),
  },
  indexes: [{ name: indexName('messages', ['user_id', 'created_at']), columns: ['user_id', 'created_at'] }],
});

const agentState = defineTable({
  name: 'agent_state',
  columns: {
    user_id: naturalPk(),
    /** json-массив сообщений диалога (замена Postgres-чекпоинтов LangGraph). */
    thread: { type: 'text', notNull: true, default: '[]' },
    updated_at: updatedAt(),
  },
});

const llmUsage = defineTable({
  name: 'llm_usage',
  columns: {
    id: idPk(),
    user_id: userRef(),
    model: { type: 'text', notNull: true },
    prompt_tokens: { type: 'integer', notNull: true, default: 0 },
    completion_tokens: { type: 'integer', notNull: true, default: 0 },
    /** Стоимость в микро-долларах (1e-6 USD). */
    cost_micros: { type: 'integer', notNull: true, default: 0 },
    /** `agent` | `summary` | `embedding` | `classifier` | … */
    purpose: { type: 'text' },
    created_at: createdAt(),
  },
  indexes: [
    { name: indexName('llm_usage', ['user_id', 'created_at']), columns: ['user_id', 'created_at'] },
  ],
});

const medications = defineTable({
  name: 'medications',
  columns: {
    id: idPk(),
    user_id: userRef(),
    name: { type: 'text', notNull: true },
    dosage: { type: 'text', notNull: true, default: '' },
    /** json-массив времён приёма: ["08:00", "20:00"]. */
    times: { type: 'text', notNull: true, default: '[]' },
    /** `daily` | `weekly` | `as_needed` | … */
    frequency: { type: 'text', notNull: true, default: 'daily' },
    instructions: { type: 'text' },
    is_active: { type: 'integer', notNull: true, default: 1 },
    stock_count: { type: 'integer' },
    refill_threshold: { type: 'integer', notNull: true, default: 0 },
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  indexes: [{ name: indexName('medications', ['user_id', 'is_active']), columns: ['user_id', 'is_active'] }],
});

const medicationLogs = defineTable({
  name: 'medication_logs',
  columns: {
    id: idPk(),
    user_id: userRef(),
    medication_id: { type: 'integer', notNull: true },
    /** `HH:MM` — запланированное время приёма. */
    scheduled_time: { type: 'text', notNull: true },
    /** `YYYY-MM-DD` — локальная дата приёма. */
    date: { type: 'text', notNull: true },
    /** `taken` | `skipped` | `pending`. */
    status: { type: 'text', notNull: true, default: 'taken' },
    taken_at: { type: 'text' },
    created_at: createdAt(),
  },
  uniqueConstraints: [{ columns: ['medication_id', 'date', 'scheduled_time'] }],
  indexes: [{ name: indexName('medication_logs', ['user_id', 'date']), columns: ['user_id', 'date'] }],
});

/** Ленивый планировщик: задачи исполняются при следующем заходе бота. */
const dueJobs = defineTable({
  name: 'due_jobs',
  columns: {
    id: idPk(),
    user_id: userRef(),
    /** `task_reminder` | `medication_reminder` | `morning_digest` | … */
    kind: { type: 'text', notNull: true },
    run_at: { type: 'text', notNull: true },
    /** json-объект параметров джобы. */
    payload: { type: 'text', notNull: true, default: '{}' },
    /** `pending` | `done` | `failed` | `cancelled`. */
    status: { type: 'text', notNull: true, default: 'pending' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  indexes: [
    {
      name: indexName('due_jobs', ['user_id', 'status', 'run_at']),
      columns: ['user_id', 'status', 'run_at'],
    },
    {
      name: indexName('due_jobs', ['status', 'run_at']),
      columns: ['status', 'run_at'],
    },
  ],
});

/** Глобальное key-value хранилище, без user_id. */
const kv = defineTable({
  name: 'kv',
  columns: {
    key: { type: 'text', pk: true },
    value: { type: 'text', notNull: true },
    updated_at: updatedAt(),
  },
});

const evolutionItems = defineTable({
  name: 'evolution_items',
  columns: {
    id: idPk(),
    user_id: userRef(),
    /** `feature` | `bug` | `improvement` | `idea`. */
    category: { type: 'text', notNull: true, default: 'feature' },
    title: { type: 'text', notNull: true },
    raw_input: { type: 'text', notNull: true },
    /** Спека, которую сгенерировал агент. */
    spec: { type: 'text' },
    /** `pending` | `in_progress` | `shipped` | `rejected`. */
    status: { type: 'text', notNull: true, default: 'pending' },
    /** `low` | `medium` | `high`. */
    priority: { type: 'text', notNull: true, default: 'medium' },
    branch_name: { type: 'text' },
    commit_hash: { type: 'text' },
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  indexes: [{ name: indexName('evolution_items', ['user_id', 'status']), columns: ['user_id', 'status'] }],
});

// ---------------------------------------------------------------------------

/** Бета-фидбек: отзывы, предложения по улучшению и багрепорты тестировщиков. */
const feedback = defineTable({
  name: 'feedback',
  columns: {
    id: idPk(),
    user_id: userRef(),
    /** `feedback` | `suggestion` | `bug`. */
    kind: { type: 'text', notNull: true, default: 'feedback' },
    text: { type: 'text', notNull: true },
    /** `new` | `ack` | `done`. */
    status: { type: 'text', notNull: true, default: 'new' },
    /** Необязательный контекст тестера: версия приложения/платформа. */
    context: { type: 'text' },
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  indexes: [{ name: indexName('feedback', ['user_id', 'created_at']), columns: ['user_id', 'created_at'] }],
});

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

/** Все таблицы приложения в порядке создания. */
export const TABLES: readonly TableDef[] = [
  users,
  taskCategories,
  taskSubcategories,
  tasks,
  accounts,
  finCategories,
  transactions,
  budgets,
  liabilities,
  fxRates,
  docChapters,
  notes,
  entities,
  mentions,
  relations,
  messages,
  agentState,
  llmUsage,
  medications,
  medicationLogs,
  dueJobs,
  kv,
  evolutionItems,
  feedback,
];

/** Быстрый доступ по SQL-имени таблицы. */
export const TABLES_BY_NAME: Readonly<Record<string, TableDef>> = Object.freeze(
  Object.fromEntries(TABLES.map((def) => [def.name, def])),
);

/** Имена всех таблиц. */
export const TABLE_NAMES: readonly string[] = TABLES.map((def) => def.name);

export function getTableDef(name: string): TableDef {
  const def = TABLES_BY_NAME[name];
  if (!def) throw new Error(`tables: unknown table "${name}"`);
  return def;
}
