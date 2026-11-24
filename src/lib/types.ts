/**
 * Доменные типы.
 *
 * Строки таблиц в том виде, в котором их видят сервисы: json-колонки уже
 * распарсены, булевы — настоящие `boolean`, деньги — целые центы. Превращением
 * «строка SQLite → доменный объект» занимается DAL (`src/lib/dal/`), он же
 * кодирует обратно при записи.
 *
 * SQL-схема описана отдельно в `src/db/tables.ts`; этот файл ничего не знает
 * про DDL и не импортирует платформенные модули.
 */

import type { ProviderId } from './provider/types.js';

// ---------------------------------------------------------------------------
// Базовые скаляры
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp в UTC, например `2026-11-06T09:30:00.000Z`. */
export type IsoTimestamp = string;

/** Дата без времени, `YYYY-MM-DD`. */
export type IsoDate = string;

/** Время суток `HH:MM` (24h). */
export type TimeOfDay = string;

/** Месяц `YYYY-MM`. */
export type IsoMonth = string;

/** Код валюты ISO-4217 (`EUR`, `USD`, …). */
export type CurrencyCode = string;

/** Деньги — всегда целые центы. */
export type Cents = number;

/** Размерность эмбеддингов Gemini. */
export const EMBEDDING_DIMENSIONS = 768;

// ---------------------------------------------------------------------------
// Перечисления
// ---------------------------------------------------------------------------

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';

/**
 * Конверт счёта для расчёта ранвея: свободные деньги против уже
 * распределённых под обязательства. Per-user настройка (ADR-002).
 */
export type AccountEnvelope = 'spendable' | 'reserved';

/** Колонка канбана инбокса. */
export type NoteColumn = 'raw' | 'todo' | 'note' | 'idea' | 'trash';

export type NoteSourceType = 'text' | 'voice' | 'photo' | 'document' | 'video_note';

/**
 * `adjustment` — служебная строка: корректировка баланса или непокрытая
 * разница расхода. В суммы расходов она не входит.
 */
export type TransactionKind = 'expense' | 'income' | 'transfer' | 'exchange' | 'adjustment';

export type FinCategoryKind = 'expense' | 'income';

export type EntityKind = 'person' | 'place' | 'project' | 'org' | 'other';

export type MentionSourceType = 'note' | 'message' | 'transaction' | 'task';

export type MessageRole = 'user' | 'assistant' | 'system';

export type LiabilityQueue = 'queue_1' | 'queue_2' | 'queue_3' | 'queue_4';

export type MedicationFrequency = 'daily' | 'weekly' | 'as_needed';

export type MedicationLogStatus = 'pending' | 'taken' | 'skipped';

export type DueJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type DueJobKind =
  | 'task_reminder'
  | 'medication_reminder'
  | 'morning_digest'
  | 'nightly_consolidation'
  | 'trash_autocleanup'
  | 'daily_backup';

/**
 * `skill` — предложенная процедура (черновик скилла), а не задача на код.
 * Таблица та же; `spec` у неё несёт `lifeos.skill.v1`, `branch_name`/`commit_hash`
 * остаются только для реализации кода.
 */
export type EvolutionCategory = 'feature' | 'bug' | 'improvement' | 'idea' | 'skill';

/**
 * `active` — скилл включён владельцем и попадает в промпт; `superseded` —
 * прежняя версия, вытесненная ревизией (остаётся для ручного отклта).
 * Остальные статусы — обычные состояния бэклога.
 */
export type EvolutionStatus =
  | 'pending'
  | 'in_progress'
  | 'shipped'
  | 'rejected'
  | 'active'
  | 'superseded'
  | 'disabled';

export type EvolutionPriority = 'low' | 'medium' | 'high';

/** Поддерживаемые локали интерфейса и ответов бота. */
export type LocaleCode = 'ru' | 'en' | 'sr' | 'ja';

export type OnboardingStep =
  | 'new'
  | 'overview'
  | 'timezone'
  | 'currency'
  | 'accounts'
  | 'practice'
  | 'notifications'
  | 'gemini'
  | 'final'
  | 'completed'
  | 'skipped';

// ---------------------------------------------------------------------------
// Профиль и настройки
// ---------------------------------------------------------------------------

export interface UserRow {
  id: number;
  name: string | null;
  language: LocaleCode;
  baseCurrency: CurrencyCode;
  timezone: string;
  summaryTime: TimeOfDay;
  lowStimulationMode: boolean;
  quotaMonth: IsoMonth | null;
  quotaTokens: number;
  quotaLimit: number;
  /** BYOK-ключ, зашифрованный на сервере (ChaCha20-Poly1305). */
  byok: { ciphertext: string; nonce: string; tag: string } | null;
  /** Провайдер, к которому относится BYOK-ключ; `null` — Gemini (легаси). */
  modelProvider: ProviderId | null;
  /** Текущий шаг мастера онбординга. */
  onboardingStep: OnboardingStep;
  /** Дата завершения или пропуска онбординга. */
  onboardingCompletedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------
// Задачи
// ---------------------------------------------------------------------------

export interface TaskCategoryRow {
  id: number;
  userId: number;
  name: string;
  color: string | null;
  position: number;
  createdAt: IsoTimestamp | null;
}

export interface TaskSubcategoryRow {
  id: number;
  userId: number;
  categoryId: number;
  name: string;
  position: number;
  createdAt: IsoTimestamp | null;
}

/** Правило повтора задачи (json-колонка `recurrence`). */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  /** Для weekly: 0=Пн … 6=Вс. */
  weekdays?: number[];
  until?: IsoDate;
  count?: number;
}

export type TaskItemType = 'task' | 'event';

export interface TaskRow {
  id: number;
  userId: number;
  categoryId: number | null;
  subcategoryId: number | null;
  parentId: number | null;
  title: string;
  notes: string | null;
  status: TaskStatus;
  itemType: TaskItemType;
  position: number;
  sourceText: string | null;
  createdAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp | null;
  dueAt: IsoTimestamp | null;
  remindAt: IsoTimestamp | null;
  reminderSent: boolean;
  recurrence: RecurrenceRule | null;
  deletedAt: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------
// Финансы
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: number;
  userId: number;
  name: string;
  currency: CurrencyCode;
  initialBalanceCents: Cents;
  currentBalanceCents: Cents;
  /** `spendable` | `reserved` (ADR-002: классификация — per-user, не по имени банка). */
  envelope: AccountEnvelope;
  isActive: boolean;
  createdAt: IsoTimestamp | null;
}

export interface FinCategoryRow {
  id: number;
  userId: number;
  name: string;
  kind: FinCategoryKind;
  icon: string | null;
  createdAt: IsoTimestamp | null;
}

export interface TransactionRow {
  id: number;
  userId: number;
  kind: TransactionKind;
  accountId: number;
  toAccountId: number | null;
  amountCents: Cents;
  currency: CurrencyCode;
  fxRate: number;
  amountEurCents: Cents;
  categoryId: number | null;
  description: string | null;
  occurredAt: IsoTimestamp;
  transferGroupId: string | null;
  receiptFileId: string | null;
  rawText: string | null;
  createdAt: IsoTimestamp | null;
  /**
   * Сколько суммы расхода осталось без покрытия остатком счёта. Поле не из
   * таблицы: его заполняет `createTransaction`, чтобы ответ сказал об этом
   * вслух, и откат расхода (`revertTransactionRecord`), чтобы текст отмены
   * назвал возврат, а не номинал. Баланс от него в минус не уходит — разница
   * помечается отдельной строкой компенсации в той же группе.
   */
  uncoveredCents?: Cents;
}

export interface BudgetRow {
  id: number;
  userId: number;
  categoryId: number;
  month: IsoMonth;
  limitAmountEurCents: Cents;
  createdAt: IsoTimestamp | null;
}

export interface LiabilityRow {
  id: number;
  userId: number;
  name: string;
  queue: LiabilityQueue;
  amountCents: Cents;
  currency: CurrencyCode;
  amountEurCents: Cents;
  monthlyPaymentCents: Cents;
  paymentDay: number | null;
  totalPayments: number | null;
  endDate: IsoDate | null;
  notes: string | null;
  isActive: boolean;
  paidMonths: IsoMonth[];
  lastPaymentDate: IsoDate | null;
  accountId: number | null;
  createdAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp | null;
}

export interface FxRateRow {
  date: IsoDate;
  base: CurrencyCode;
  /** Курсы валют к базовой: `{ USD: 1.08, GBP: 0.85 }`. */
  rates: Record<string, number>;
  updatedAt: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------
// Системная документация юзера (Docs-as-Code, ADR-002: главы — per-user данные)
// ---------------------------------------------------------------------------

export interface DocChapterRow {
  id: number;
  userId: number;
  slug: string;
  filename: string | null;
  title: string;
  /** Markdown-текст главы целиком. */
  content: string;
  /** Защищена от перезаписи сидом дефолтных глав. */
  isPinned: boolean;
  createdAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------
// Заметки и граф знаний
// ---------------------------------------------------------------------------

export interface NoteMetadata {
  mimeType?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  transcript?: string;
  [key: string]: unknown;
}

export interface NoteRow {
  id: number;
  userId: number;
  rawText: string;
  cleanText: string | null;
  column: NoteColumn;
  embedding: number[] | null;
  mergedInto: number | null;
  sourceMessageId: number | null;
  sourceType: NoteSourceType;
  fileId: string | null;
  metadata: NoteMetadata;
  deletedAt: IsoTimestamp | null;
  processedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp | null;
}

export interface FeedbackRow {
  id: number;
  userId: number;
  kind: 'feedback' | 'suggestion' | 'bug';
  text: string;
  status: 'new' | 'ack' | 'done';
  context: string | null;
  createdAt: IsoTimestamp;
}

export interface EntityRow {
  id: number;
  userId: number;
  kind: EntityKind;
  name: string;
  aliases: string[];
  description: string | null;
  embedding: number[] | null;
  createdAt: IsoTimestamp | null;
}

export interface MentionRow {
  id: number;
  userId: number;
  entityId: number;
  sourceType: MentionSourceType;
  sourceId: number | null;
  context: string | null;
  at: IsoTimestamp;
}

export interface RelationRow {
  id: number;
  userId: number;
  subjectId: number;
  predicate: string;
  objectId: number;
  validFrom: IsoTimestamp;
  /** null — связь всё ещё актуальна. */
  validTo: IsoTimestamp | null;
  sourceId: number | null;
}

// ---------------------------------------------------------------------------
// Диалог и агент
// ---------------------------------------------------------------------------

export interface MessageRow {
  id: number;
  userId: number;
  role: MessageRole;
  content: string;
  /** json-метаданные шага (tool calls и т.п.). */
  meta: Record<string, unknown>;
  createdAt: IsoTimestamp | null;
}

export interface AgentMessage {
  role: MessageRole;
  content: string;
  /** Опциональные метаданные шага (tool calls и т.п.). */
  meta?: Record<string, unknown>;
}

export interface AgentStateRow {
  userId: number;
  thread: AgentMessage[];
  updatedAt: IsoTimestamp | null;
}

export interface LlmUsageRow {
  id: number;
  userId: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Стоимость в микро-долларах (1e-6 USD). */
  costMicros: number;
  purpose: string | null;
  createdAt: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------
// Медикаменты
// ---------------------------------------------------------------------------

export interface MedicationRow {
  id: number;
  userId: number;
  name: string;
  dosage: string;
  times: TimeOfDay[];
  frequency: MedicationFrequency;
  instructions: string | null;
  isActive: boolean;
  stockCount: number | null;
  refillThreshold: number;
  createdAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp | null;
}

export interface MedicationLogRow {
  id: number;
  userId: number;
  medicationId: number;
  scheduledTime: TimeOfDay;
  date: IsoDate;
  status: MedicationLogStatus;
  takenAt: IsoTimestamp | null;
  createdAt: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------
// Планировщик, kv, бэклог эволюции
// ---------------------------------------------------------------------------

export interface DueJobRow {
  id: number;
  userId: number;
  kind: DueJobKind | string;
  runAt: IsoTimestamp;
  payload: Record<string, unknown>;
  status: DueJobStatus;
  attempts: number;
  lastError: string | null;
  createdAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp | null;
}

export interface KvRow {
  key: string;
  value: string;
  updatedAt: IsoTimestamp | null;
}

export interface EvolutionItemRow {
  id: number;
  userId: number;
  category: EvolutionCategory;
  title: string;
  rawInput: string;
  spec: string | null;
  status: EvolutionStatus;
  priority: EvolutionPriority;
  branchName: string | null;
  commitHash: string | null;
  createdAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------
// Утилитарные типы
// ---------------------------------------------------------------------------

/** Результат «разобрал деньги»: сумма в центах + валюта. */
export interface MoneyAmount {
  cents: Cents;
  currency: CurrencyCode;
}

/** Пара «ключ → строка таблицы», удобно для типизированного DAL. */
export type RowByTable = {
  users: UserRow;
  task_categories: TaskCategoryRow;
  task_subcategories: TaskSubcategoryRow;
  tasks: TaskRow;
  accounts: AccountRow;
  fin_categories: FinCategoryRow;
  transactions: TransactionRow;
  budgets: BudgetRow;
  liabilities: LiabilityRow;
  fx_rates: FxRateRow;
  notes: NoteRow;
  entities: EntityRow;
  mentions: MentionRow;
  relations: RelationRow;
  messages: MessageRow;
  agent_state: AgentStateRow;
  llm_usage: LlmUsageRow;
  medications: MedicationRow;
  medication_logs: MedicationLogRow;
  due_jobs: DueJobRow;
  kv: KvRow;
  evolution_items: EvolutionItemRow;
};
