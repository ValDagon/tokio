/**
 * Бэклог авто-эволюции — порт `backend/app/services/evolution.py`:
 * распознавание «это идея/баг», запись в `evolution_items` и обёртки над CRUD.
 *
 * Распознавание — дешёвый fast-path: сообщение разбирается регуляркой ДО вызова
 * LLM, поэтому идея стоит 0 токенов. Паттерн и правила взяты из upstream:
 *  - триггеры: `#идея`, `фича`, `баг`, `улучшение`, `feature`, `bug`, `idea`,
 *    а также фразы «запиши идею», «сделай в боте», «добавь в бот», «предложение»;
 *  - «баг» в первом слове → категория `bug`, всё остальное → `feature`;
 *  - заголовок — первая строка сути (до 100 символов), `raw_input` — всё сообщение.
 *
 * Ответ пользователю отдаётся простым текстом без markdown: разметку навешивает
 * слой bot/formatting (T14), иначе получим двойное экранирование.
 *
 * Вторая, независимая часть модуля (MU-3) — журнал сбоев: нормализованная
 * сигнатура, атомарный счётчик и агрегаты. Хранилище — существующая `kv`.
 */

import { getAssistantName } from './overlay.js';
import type {
  EvolutionCategory,
  EvolutionItemRow,
  EvolutionPriority,
  EvolutionStatus,
} from '../types.js';
import {
  activateSkillRevision,
  createEvolutionItem,
  deleteEvolutionItem,
  deriveEvolutionTitle,
  getEvolutionItem,
  kvDelete,
  kvGet,
  kvIncrement,
  kvListByPrefix,
  kvSet,
  kvSetIfAbsent,
  kvSetJson,
  listEvolutionItems,
  updateEvolutionItem,
} from './dal/misc.js';
import type { CreateEvolutionItemInput, UpdateEvolutionItemInput } from './dal/misc.js';
import { chat } from './gemini.js';
import { normalizeWhitespace, nowIso, truncate } from './utils.js';

// ---------------------------------------------------------------------------
// Распознавание команды
// ---------------------------------------------------------------------------

/**
 * Регулярка-триггер (порт python-паттерна, `IGNORECASE | DOTALL`).
 * Группа 1 — суть идеи без префикса.
 */
export const EVOLUTION_TRIGGER_PATTERN =
  /^(?:#?(?:идея|фича|баг|улучшение|feature|bug|idea)|запиши идею|сделай в боте|добавь в бот|предложение)\s*[:\-—]?\s*(.+)/isu;

/** Длина заголовка из первой строки (как в upstream). */
export const EVOLUTION_TITLE_LENGTH = 100;

/** Категории бэклога, которые ставит fast-path (остальные — через DAL вручную). */
export type EvolutionFastPathCategory = Extract<EvolutionCategory, 'feature' | 'bug'>;

/** Результат разбора сообщения. */
export interface EvolutionCommand {
  category: EvolutionFastPathCategory;
  /** Заголовок: первая строка сути, до 100 символов. */
  title: string;
  /** Исходное сообщение целиком (trim) — уходит в `raw_input`. */
  rawInput: string;
}

/** Первое слово без `#` и хвостовых разделителей — по нему определяется категория. */
function firstWordKey(text: string): string {
  const first = text.split(/\s+/)[0] ?? '';
  return first.toLowerCase().replace(/^#+/, '').replace(/[:\-—]+$/, '');
}

/**
 * Разбирает сообщение как элемент бэклога.
 * `null` — это не просьба «запиши идею», обрабатывать надо обычным путём.
 */
export function parseEvolutionCommand(text: string): EvolutionCommand | null {
  const cleaned = String(text ?? '').trim();
  if (!cleaned) return null;

  const match = EVOLUTION_TRIGGER_PATTERN.exec(cleaned);
  if (!match) return null;

  const content = (match[1] ?? '').trim();
  // Разделитель необязателен, поэтому «баг:» без сути ловится как «:».
  if (!content || /^[:\-—]+$/.test(content)) return null;

  const rawCategory = firstWordKey(cleaned);
  const category: EvolutionFastPathCategory =
    rawCategory.includes('баг') || rawCategory.includes('bug') ? 'bug' : 'feature';

  const firstLine = (content.split(/\r?\n/)[0] ?? '').trim();
  const title = truncate(firstLine, EVOLUTION_TITLE_LENGTH) || deriveEvolutionTitle(content);

  return { category, title, rawInput: cleaned };
}

/** Быстрая проверка без создания объекта — для роутера сообщений. */
export function isEvolutionCommand(text: string): boolean {
  return parseEvolutionCommand(text) !== null;
}

// ---------------------------------------------------------------------------
// Сообщение пользователю
// ---------------------------------------------------------------------------

/** Человеческое имя категории для ответа в чат. */
export function evolutionCategoryLabel(category: EvolutionCategory): string {
  switch (category) {
    case 'bug':
      return 'Баг-репорт';
    case 'feature':
      return 'Идея / Фича';
    case 'improvement':
      return 'Улучшение';
    case 'idea':
      return 'Идея';
    case 'skill':
      return 'Скилл (процедура)';
    default:
      return 'Идея / Фича';
  }
}

/** Текст-подтверждение после записи (plain text, без markdown). */
export function formatEvolutionReply(command: Pick<EvolutionCommand, 'category' | 'title'>): string {
  return [
    `💡 Записано в бэклог авто-эволюции ${getAssistantName()}!`,
    '',
    `• Тип: ${evolutionCategoryLabel(command.category)}`,
    `• Суть: ${command.title}`,
    '',
    'Задача попадёт в разбор следующей итерацией: тесты, спека, реализация.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CRUD-обёртки
// ---------------------------------------------------------------------------

export interface AddEvolutionItemInput extends Partial<Omit<CreateEvolutionItemInput, 'rawInput'>> {
  rawInput: string;
}

/** Добавить элемент в бэклог (значения по умолчанию — в DAL: feature / medium / pending). */
export async function addItem(
  userId: number,
  input: AddEvolutionItemInput,
): Promise<EvolutionItemRow> {
  return createEvolutionItem(userId, input);
}

/** Записать разобранную команду в бэклог. */
export async function addFromCommand(
  userId: number,
  command: EvolutionCommand,
  extra: { priority?: EvolutionPriority } = {},
): Promise<EvolutionItemRow> {
  return createEvolutionItem(userId, {
    rawInput: command.rawInput,
    title: command.title,
    category: command.category,
    priority: extra.priority,
  });
}

export interface EvolutionCommandResult {
  command: EvolutionCommand;
  item: EvolutionItemRow;
  /** Готовый ответ в чат. */
  reply: string;
}

/**
 * Полный fast-path: распознать → записать → отдать ответ.
 * `null` — сообщение не про бэклог, его должен обработать агент.
 */
export async function handleEvolutionCommand(
  userId: number,
  text: string,
  options: { priority?: EvolutionPriority } = {},
): Promise<EvolutionCommandResult | null> {
  const command = parseEvolutionCommand(text);
  if (!command) return null;

  const item = await addFromCommand(userId, command, options);
  return { command, item, reply: formatEvolutionReply(command) };
}

/** Список элементов, свежие сверху; можно отфильтровать по статусу. */
export async function listItems(
  userId: number,
  options: { status?: EvolutionStatus; limit?: number } = {},
): Promise<EvolutionItemRow[]> {
  return listEvolutionItems(userId, options);
}

/** Один элемент (чужой/несуществующий → `null`). */
export async function getItem(userId: number, itemId: number): Promise<EvolutionItemRow | null> {
  return getEvolutionItem(userId, itemId);
}

/**
 * Закрыть/перевести элемент: статус + необязательные артефакты реализации.
 * `null` — элемента нет или он чужой.
 */
export async function resolveItem(
  userId: number,
  itemId: number,
  status: EvolutionStatus,
  patch: Omit<UpdateEvolutionItemInput, 'status'> = {},
): Promise<EvolutionItemRow | null> {
  return updateEvolutionItem(userId, itemId, { ...patch, status });
}

/** Удалить элемент из бэклога. */
export async function removeItem(userId: number, itemId: number): Promise<boolean> {
  return deleteEvolutionItem(userId, itemId);
}

// ---------------------------------------------------------------------------
// Журнал сбоев (MU-3)
// ---------------------------------------------------------------------------
//
// Наблюдаемость, а не часть операции. Сбой описывается не свободным текстом
// ошибки, а сигнатурой из конечных наборов кодов: один и тот же отказ обязан
// попадать в один счётчик, иначе повторяемость не видна. `detail` — короткий
// диагностический хвост для человека; в сигнатуру он не входит никогда.
//
// Хранилище — существующая таблица `kv` (новых таблиц нет):
//   failure_count:v1:<userId>:<signature>   — счётчик, атомарный UPSERT;
//   failure_meta:v1:<userId>:<signature>    — JSON {lastAt, detail};
//   failure_recovered:v1:<userId>:<signature> — момент восстановления.
// Версия `v1` в ключе: смена нормализации не должна смешивать старые и новые
// кластеры и не должна требовать миграции.

/** Версия схемы ключей журнала. */
export const FAILURE_KEY_VERSION = 'v1';

/** Длина `detail` после скраба и усечения. */
export const FAILURE_DETAIL_LIMIT = 200;

/**
 * Сколько одинаковых сбоев создают одну задачу самодиагностики. Порог
 * централизован: `recordFailure` не решает, что считать «слишком частым».
 */
export const FAILURE_EVOLUTION_THRESHOLD = 3;

export const FAILURE_COUNT_PREFIX = 'failure_count';
export const FAILURE_META_PREFIX = 'failure_meta';
export const FAILURE_RECOVERED_PREFIX = 'failure_recovered';

/**
 * Ключ авто-задачи самодиагностики. Он же claim: `kvSetIfAbsent` не даёт двум
 * параллельным третям создать две задачи, и он же хранит ссылку на строку
 * `evolution_items`, которую читает диагностика.
 */
export const FAILURE_EVOLUTION_PREFIX = 'evolution:auto';

/** Стадия обработки, на которой случился отказ. */
export type FailureStage =
  | 'ingest'
  | 'stt'
  | 'vision'
  | 'receipt'
  | 'consolidation'
  | 'agent'
  | 'delivery'
  | 'router'
  | 'evolution'
  | 'other';

/** Вид входящего, к которому относится отказ. */
export type FailureMediaKind = 'text' | 'voice' | 'photo' | 'document' | 'none';

/** Терминальная причина прогона — не текст исключения. */
export type FailureReason =
  | 'download_failed'
  | 'empty_bytes'
  | 'transcription_failed'
  | 'empty_transcription'
  | 'vision_failed'
  | 'parse_failed'
  | 'llm_error'
  | 'empty_reply'
  | 'step_limit'
  | 'tool_error'
  | 'delivery_failed'
  | 'consolidation_failed'
  | 'storage_failed'
  | 'unhandled'
  | 'other';

const FAILURE_STAGES: readonly FailureStage[] = [
  'ingest',
  'stt',
  'vision',
  'receipt',
  'consolidation',
  'agent',
  'delivery',
  'router',
  'evolution',
  'other',
];

const FAILURE_MEDIA: readonly FailureMediaKind[] = ['text', 'voice', 'photo', 'document', 'none'];

const FAILURE_REASONS: readonly FailureReason[] = [
  'download_failed',
  'empty_bytes',
  'transcription_failed',
  'empty_transcription',
  'vision_failed',
  'parse_failed',
  'llm_error',
  'empty_reply',
  'step_limit',
  'tool_error',
  'delivery_failed',
  'consolidation_failed',
  'storage_failed',
  'unhandled',
  'other',
];

/** Максимальная длина имени инструмента в сигнатуре. */
const FAILURE_TOOL_LIMIT = 32;

/** Что записывается в журнал. Свободный текст допустим только в `detail`. */
export interface FailureSignal {
  stage: FailureStage;
  reason: FailureReason;
  media?: FailureMediaKind;
  /** Имя инструмента — только для `tool_error`; всё остальное нормализуется в `-`. */
  tool?: string | null;
  /** Диагностический хвост для человека: первая строка, ≤200 символов, со скрабом.
   *  В сигнатуру не входит. Это не место для текста сообщения или содержимого медиа —
   *  call-site передаёт сюда код или короткую причину, а не ввод пользователя. */
  detail?: string | null;
}

export interface RecordedFailure {
  /** Нормализованная сигнатура (`stage|media|reason|tool`). */
  signature: string;
  /** Значение счётчика после инкремента. */
  count: number;
  lastAt: string;
  detail: string | null;
  /** Задача самодиагностики, если порог был достигнут именно этим вызовом. */
  evolutionItemId?: number | null;
}

export interface FailureAggregate {
  signature: string;
  stage: FailureStage;
  media: FailureMediaKind;
  reason: FailureReason;
  tool: string | null;
  count: number;
  lastAt: string | null;
  detail: string | null;
  /** Момент последнего восстановления либо `null`, если сбой не восстановлен. */
  recoveredAt: string | null;
  /** Задача самодиагностики, созданная на пороге повторов, либо `null`. */
  evolutionItemId: number | null;
}

/**
 * Приводит код к конечному набору: неизвестное значение (в том числе мусор от
 * JS-вызывающего) становится `fallback`, а не новой сигнатурой.
 */
function pickFailureCode<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const code = String(value ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(code) ? (code as T) : fallback;
}

/** Имя инструмента в ключе: только `[a-z0-9_]`, иначе `-`. */
function normalizeFailureTool(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!raw) return '-';
  return raw.length > FAILURE_TOOL_LIMIT ? raw.slice(0, FAILURE_TOOL_LIMIT) : raw;
}

/**
 * Сигнатура сбоя из конечных наборов кодов. Порядок фиксирован:
 * `stage|media|reason|tool`; в ключе она идёт без версии (версия — в префиксе).
 */
export function normalizeFailureSignature(signal: FailureSignal): string {
  const stage = pickFailureCode(signal.stage, FAILURE_STAGES, 'other');
  const media = pickFailureCode(signal.media ?? 'none', FAILURE_MEDIA, 'none');
  const reason = pickFailureCode(signal.reason, FAILURE_REASONS, 'other');
  const tool = normalizeFailureTool(signal.tool);
  return `${stage}|${media}|${reason}|${tool}`;
}

/** Обратный разбор сигнатуры. `null` — ключ не нашего формата. */
export function parseFailureSignature(signature: string): {
  stage: FailureStage;
  media: FailureMediaKind;
  reason: FailureReason;
  tool: string | null;
} | null {
  const parts = String(signature ?? '').split('|');
  if (parts.length !== 4) return null;
  const [stage, media, reason, tool] = parts as [string, string, string, string];
  return {
    stage: pickFailureCode(stage, FAILURE_STAGES, 'other'),
    media: pickFailureCode(media, FAILURE_MEDIA, 'none'),
    reason: pickFailureCode(reason, FAILURE_REASONS, 'other'),
    tool: tool === '-' || tool === '' ? null : tool,
  };
}

/**
 * Что вырезается из `detail` перед записью. Журнал не должен становиться
 * вторым местом хранения секретов и идентификаторов чата.
 */
const FAILURE_REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // токен бота: 123456789:AAH…
  { pattern: /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, replacement: '[redacted]' },
  // sk-…, api_key=…, bearer …
  {
    pattern: /\b(?:sk|pk|rk|api|key|token|secret|bearer)[-_ ]?[A-Za-z0-9_+/=-]{8,}\b/gi,
    replacement: '[redacted]',
  },
  // chat_id / from_id / message_id с числом
  {
    pattern: /\b(?:chat|from|user|message)[-_ ]?id\s*[:=]\s*-?\d+/gi,
    replacement: '[redacted]',
  },
  // file_id / file_unique_id
  {
    pattern: /\b(?:file|file_unique)[-_ ]?id\s*[:=]\s*[A-Za-z0-9_-]+/gi,
    replacement: '[redacted]',
  },
  // длинный непрозрачный ключ или base64
  { pattern: /\b[A-Za-z0-9_+/=-]{40,}\b/g, replacement: '[redacted]' },
];

/**
 * `detail` — не дамп сообщения, а одна строка диагностики: только первая
 * строка, управляющие символы в пробел, секреты вырезаны, длина ≤ 200.
 */
export function sanitizeFailureDetail(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const firstLine = String(raw).split(/\r?\n/, 1)[0] ?? '';
  let value = firstLine.replace(/[\u0000-\u001f\u007f]/g, ' ');
  for (const { pattern, replacement } of FAILURE_REDACTIONS) {
    value = value.replace(pattern, replacement);
  }
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) return null;
  return truncate(cleaned, FAILURE_DETAIL_LIMIT);
}

function failureKey(prefix: string, userId: number, signature: string): string {
  return `${prefix}:${FAILURE_KEY_VERSION}:${Math.trunc(Number(userId))}:${signature}`;
}

function failurePrefix(prefix: string, userId: number): string {
  return `${prefix}:${FAILURE_KEY_VERSION}:${Math.trunc(Number(userId))}:`;
}

interface FailureEvolutionRef {
  itemId: number;
  at: string;
  count: number;
}

function failureEvolutionKey(userId: number, signature: string): string {
  return `${FAILURE_EVOLUTION_PREFIX}:${FAILURE_KEY_VERSION}:${Math.trunc(Number(userId))}:${signature}`;
}

function failureEvolutionPrefix(userId: number): string {
  return `${FAILURE_EVOLUTION_PREFIX}:${FAILURE_KEY_VERSION}:${Math.trunc(Number(userId))}:`;
}

function parseFailureEvolution(raw: string | null | undefined): FailureEvolutionRef | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const itemId = Number(record.itemId);
    if (!Number.isFinite(itemId) || itemId <= 0) return null;
    return {
      itemId,
      at: typeof record.at === 'string' ? record.at : '',
      count: Number.isFinite(Number(record.count)) ? Number(record.count) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Третья и последующие одинаковые неудачи превращаются в **одну** задачу
 * самодиагностики.
 *
 * Порог — не решение этого вызова: он централизован в
 * `FAILURE_EVOLUTION_THRESHOLD`, а защита от дублей — атомарный `kvSetIfAbsent`
 * по тому же ключу, в котором потом лежит ссылка на задачу. Проигравший
 * параллельный вызов не создаёт ничего и не снимает чужой claim. Если вставка
 * (`evolution_items`) упала, claim снимается, чтобы следующая неудача могла
 * попробовать снова.
 *
 * В `raw_input` попадает только сигнатура и счётчик: сырого входящего здесь
 * нет и быть не может.
 *
 * Никогда не бросает: журнал и его порог не имеют права менять результат
 * основной операции.
 */
async function ensureSelfDiagnosisItem(
  userId: number,
  signature: string,
  count: number,
): Promise<number | null> {
  if (count < FAILURE_EVOLUTION_THRESHOLD) return null;

  const key = failureEvolutionKey(userId, signature);
  let claimed: boolean;
  try {
    claimed = await kvSetIfAbsent(key, nowIso());
  } catch {
    return null;
  }
  if (!claimed) return null;

  // Вставка и запись ссылки разделены: если упала вставка, claim снимается и
  // следующая неудача попробует снова; если упала только запись ссылки, задача
  // уже существует — claim остаётся, и дубль не появится.
  let itemId: number;
  try {
    const item = await createEvolutionItem(userId, {
      rawInput: [
        `Сигнатура: ${signature}`,
        `Повторов: ${count}`,
        'Источник: журнал сбоев (запись автоматическая)',
        'Что посмотреть: /diagnostics',
      ].join('\n'),
      title: truncate(`Самодиагностика: ${signature}`, 80),
      category: 'bug',
      priority: 'high',
    });
    itemId = item.id;
  } catch {
    try {
      await kvDelete(key);
    } catch {
      // снять claim не удалось — следующая неудача попробует снова
    }
    return null;
  }

  const ref: FailureEvolutionRef = { itemId, at: nowIso(), count };
  try {
    await kvSet(key, JSON.stringify(ref));
  } catch {
    // ссылка потеряна, но задача одна: claim не снимаем
  }
  return itemId;
}

interface FailureMeta {
  lastAt: string | null;
  detail: string | null;
}

const EMPTY_FAILURE_META: FailureMeta = { lastAt: null, detail: null };

function parseFailureMeta(raw: string | null | undefined): FailureMeta {
  if (!raw) return EMPTY_FAILURE_META;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return EMPTY_FAILURE_META;
    const record = parsed as Record<string, unknown>;
    return {
      lastAt: typeof record.lastAt === 'string' ? record.lastAt : null,
      detail: typeof record.detail === 'string' ? record.detail : null,
    };
  } catch {
    return EMPTY_FAILURE_META;
  }
}

/**
 * Вход журнала: либо описание сбоя, либо уже готовая строка сигнатуры (её
 * отдают места, где сигнатура пришла из базы). Строка канонизируется: мусор не
 * создаёт ключ, который никогда не резолвится агрегатом.
 */
function resolveFailureSignature(signal: FailureSignal | string): string | null {
  if (typeof signal !== 'string') return normalizeFailureSignature(signal);
  const parts = parseFailureSignature(signal);
  if (!parts) return null;
  return normalizeFailureSignature({
    stage: parts.stage,
    media: parts.media,
    reason: parts.reason,
    tool: parts.tool,
  });
}

/**
 * Записывает сбой: мета кластера, сброс отметки восстановления и атомарный
 * инкремент счётчика. Счётчик идёт последним, потому что финализирует кластер:
 * отказ меты или удаления не оставляет «фантомного» инкремента, а лишняя мета
 * без счётчика кластером не считается.
 *
 * Никогда не бросает: журнал — наблюдаемость, поэтому его отказ не имеет права
 * менять результат вызывающего кода. Рекурсивной записи нет — собственный сбой
 * здесь просто проглатывается, а не журналируется второй раз.
 *
 * `null` — записать не удалось (или сигнатура невалидна).
 */
export async function recordFailure(
  userId: number,
  signal: FailureSignal,
): Promise<RecordedFailure | null> {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return null;

  const signature = normalizeFailureSignature(signal);
  const detail = sanitizeFailureDetail(signal.detail);
  const lastAt = nowIso();

  try {
    await kvDelete(failureKey(FAILURE_RECOVERED_PREFIX, uid, signature));
    await kvSetJson(failureKey(FAILURE_META_PREFIX, uid, signature), { lastAt, detail });
    const count = await kvIncrement(failureKey(FAILURE_COUNT_PREFIX, uid, signature));
    const evolutionItemId = await ensureSelfDiagnosisItem(uid, signature, count);
    return { signature, count, lastAt, detail, evolutionItemId };
  } catch {
    return null;
  }
}

/**
 * Отмечает кластер восстановленным (успешный повтор из MU-1/MU-2). Возвращает
 * момент восстановления либо `null`, если записать не удалось.
 */
export async function markFailureRecovered(
  userId: number,
  signal: FailureSignal | string,
): Promise<string | null> {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return null;
  const signature = resolveFailureSignature(signal);
  if (!signature) return null;
  const at = nowIso();
  try {
    await kvSet(failureKey(FAILURE_RECOVERED_PREFIX, uid, signature), at);
    return at;
  } catch {
    return null;
  }
}

/** Один кластер по сигнатуре; `null` — сбоев не записано. */
export async function getFailureAggregate(
  userId: number,
  signal: FailureSignal | string,
): Promise<FailureAggregate | null> {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return null;
  const signature = resolveFailureSignature(signal);
  if (!signature) return null;
  const parts = parseFailureSignature(signature);
  if (!parts) return null;

  const [rawCount, rawMeta, rawRecovered, rawEvolution] = await Promise.all([
    kvGet(failureKey(FAILURE_COUNT_PREFIX, uid, signature)),
    kvGet(failureKey(FAILURE_META_PREFIX, uid, signature)),
    kvGet(failureKey(FAILURE_RECOVERED_PREFIX, uid, signature)),
    kvGet(failureEvolutionKey(uid, signature)),
  ]);

  const count = Number(rawCount ?? 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  const meta = parseFailureMeta(rawMeta);
  return {
    signature,
    stage: parts.stage,
    media: parts.media,
    reason: parts.reason,
    tool: parts.tool,
    count,
    lastAt: meta.lastAt,
    detail: meta.detail,
    recoveredAt: rawRecovered ?? null,
    evolutionItemId: parseFailureEvolution(rawEvolution)?.itemId ?? null,
  };
}

/**
 * Агрегаты пользователя: чаще всего повторяющиеся сверху, при равенстве —
 * свежие сверху. Читаются только кластеры со счётчиком > 0; осиротевшие
 * `failure_meta`/`failure_recovered` без счётчика кластером не считаются.
 */
export async function listFailureAggregates(
  userId: number,
  options: { limit?: number } = {},
): Promise<FailureAggregate[]> {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return [];

  const countPrefix = failurePrefix(FAILURE_COUNT_PREFIX, uid);
  const [countRows, metaRows, recoveryRows, evolutionRows] = await Promise.all([
    kvListByPrefix(countPrefix),
    kvListByPrefix(failurePrefix(FAILURE_META_PREFIX, uid)),
    kvListByPrefix(failurePrefix(FAILURE_RECOVERED_PREFIX, uid)),
    kvListByPrefix(failureEvolutionPrefix(uid)),
  ]);

  const meta = new Map<string, FailureMeta>();
  for (const row of metaRows) {
    meta.set(row.key.slice(failurePrefix(FAILURE_META_PREFIX, uid).length), parseFailureMeta(row.value));
  }
  const recovered = new Map<string, string>();
  for (const row of recoveryRows) {
    recovered.set(row.key.slice(failurePrefix(FAILURE_RECOVERED_PREFIX, uid).length), row.value);
  }
  const evolution = new Map<string, number>();
  for (const row of evolutionRows) {
    const ref = parseFailureEvolution(row.value);
    if (ref) evolution.set(row.key.slice(failureEvolutionPrefix(uid).length), ref.itemId);
  }

  const aggregates: FailureAggregate[] = [];
  for (const row of countRows) {
    const signature = row.key.slice(countPrefix.length);
    const parts = parseFailureSignature(signature);
    const count = Number(row.value);
    if (!parts || !Number.isFinite(count) || count <= 0) continue;
    const info = meta.get(signature) ?? EMPTY_FAILURE_META;
    aggregates.push({
      signature,
      ...parts,
      count,
      lastAt: info.lastAt,
      detail: info.detail,
      recoveredAt: recovered.get(signature) ?? null,
      evolutionItemId: evolution.get(signature) ?? null,
    });
  }

  aggregates.sort(
    (a, b) => b.count - a.count || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''),
  );

  const limit = options.limit === undefined ? 20 : Math.max(1, Math.trunc(options.limit));
  return aggregates.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Скиллы: черновик → включение владельцем → замер → ревизия (MU-6…MU-9)
// ---------------------------------------------------------------------------
//
// Скилл — не магия и не «самоулучшение модели», а процедура, которую владелец
// включил руками. Петля целиком:
//   1) журнал сбоев (MU-3) видит повторяющийся agent-кластер;
//   2) следующее касание бота готовит ОДИН черновик в `pending` (1 вызов модели);
//   3) `pending`/`rejected` физически не попадают в промпт — только `active`;
//   4) после включения каждый прогон пишет наблюдаемое: применение, исход,
//      сигнатуры неудачных шагов;
//   5) три неудачных прогона включённого скилла дают ревизию `version=N+1`,
//      которая тоже ждёт решения владельца.
//
// Хранилище — `evolution_items` (новых таблиц нет): `category='skill'`,
// `spec` = JSON `lifeos.skill.v1`, счётчики — в `kv` с версией в префиксе.
// Никакой формулировки «качество»: числа показывают совместную встречаемость,
// а не влияние скилла на исход.

/** Версия схемы `spec` скилла. */
export const SKILL_SPEC_FORMAT = 'lifeos.skill.v1';

/** Обязательные секции тела в фиксированном порядке. */
export const SKILL_SECTIONS = ['When to Use', 'Procedure', 'Pitfalls', 'Verification'] as const;

/** Предел тела одного скилла. Превышение — отказ, не обрезание. */
export const SKILL_BODY_LIMIT = 4000;

/** Суммарный бюджет включённых скиллов в промпте. Превышение запрещает включение. */
export const SKILL_PROMPT_BUDGET = 6000;

/** Сколько одинаковых agent-сбоев создают предложение скилла. */
export const SKILL_DRAFT_THRESHOLD = FAILURE_EVOLUTION_THRESHOLD;

/** Сколько неудачных прогонов включённого скилла создают ревизию. */
export const SKILL_REVISION_THRESHOLD = 3;

/**
 * Классы сбоев агента, из которых рождается процедура. `llm_error` — отказ
 * провайдера, а не поведение агента, поэтому остаётся задачей-багом.
 */
export const SKILL_CANDIDATE_REASONS: readonly FailureReason[] = [
  'tool_error',
  'step_limit',
  'empty_reply',
];

/** Предел ответа модели при генерации черновика. */
export const SKILL_DRAFT_MAX_TOKENS = 4096;

/** Версия схемы ключей телеметрии. */
export const SKILL_KEY_VERSION = 'v1';

/** Префиксы ключей в `kv`. */
export const SKILL_RUN_PREFIX = 'skill_run';
export const SKILL_VIEW_PREFIX = 'skill_view';
export const SKILL_OUTCOME_PREFIX = 'skill_outcome';
export const SKILL_FAIL_PREFIX = 'skill_fail';
export const SKILL_LAST_PREFIX = 'skill_last';
export const SKILL_DRAFT_CLAIM_PREFIX = 'skill_draft';
export const SKILL_REVISION_CLAIM_PREFIX = 'skill_revision';
export const SKILL_ACTIVATE_CLAIM_PREFIX = 'skill_activate';

/**
 * Сколько живёт claim активации. В изоляте нет транзакций и нет таймеров:
 * упавший между claim и освобождением проход не должен заблокировать включение
 * навсегда, поэтому просроченный claim считается свободным.
 */
export const SKILL_ACTIVATE_CLAIM_TTL_MS = 30_000;

/** Оценки качества и «стало лучше» запрещены и в теле скилла. */
const SKILL_FORBIDDEN_WORDS: readonly RegExp[] = [/улучшил/i, /качеств/i];

/** Тело скилла из `spec`. */
export interface SkillSpec {
  format: string;
  /** Стабильный ключ кластера: у одного ключа одна активная версия. */
  key: string;
  /** `N` в ревизии `N+1`. */
  version: number;
  /** Сигнатура исходного сбоя — она же ключ дедупликации черновика. */
  originFailure: string | null;
  /** `id` вытесняемой версии либо `null` у первой. */
  supersedes: number | null;
  /** Текст процедуры: четыре секции. */
  body: string;
}

/** Загруженный включённый скилл — ровно один на ключ. */
export interface ActiveSkill {
  id: number;
  key: string;
  version: number;
  originFailure: string | null;
  body: string;
}

export type SkillValidation =
  | { ok: true }
  | { ok: false; error: string };

export interface SkillReviewResult {
  /** Что сделал обзор на этом касании. */
  kind: 'none' | 'draft' | 'revision' | 'failed';
  itemId: number | null;
  reason: string;
}

export type SkillAction =
  | { ok: true; item: EvolutionItemRow }
  | { ok: false; error: string };

/** Клиент модели для черновика; в тестах подменяется. */
export type SkillDraftChatFn = (request: {
  userId: number;
  system: string;
  user: string;
}) => Promise<string>;

export interface ReviewSkillDraftsOptions {
  chatFn?: SkillDraftChatFn;
}

export interface SkillUsage {
  /** Сколько прогонов скилл был в промпте (ровно один инкремент за прогон). */
  uses: number;
  /** Сколько раз владелец открывал полный текст (`/skills show`). */
  views: number;
  final: number;
  failedSteps: number;
  llmError: number;
  lastUsedAt: string | null;
}

// --- ключи хранилища -------------------------------------------------------

function skillStoreKey(prefix: string, userId: number, skillId: number): string {
  return `${prefix}:${SKILL_KEY_VERSION}:${Math.trunc(Number(userId))}:${Math.trunc(Number(skillId))}`;
}

function skillFailKey(userId: number, skillId: number, signature: string): string {
  return `${skillStoreKey(SKILL_FAIL_PREFIX, userId, skillId)}:${signature}`;
}

function skillDraftClaimKey(userId: number, signature: string): string {
  return `${SKILL_DRAFT_CLAIM_PREFIX}:${SKILL_KEY_VERSION}:${Math.trunc(Number(userId))}:${signature}`;
}

function skillRevisionClaimKey(
  userId: number,
  skillId: number,
  version: number,
  signature: string,
): string {
  return [
    SKILL_REVISION_CLAIM_PREFIX,
    SKILL_KEY_VERSION,
    Math.trunc(Number(userId)),
    Math.trunc(Number(skillId)),
    Math.trunc(Number(version)),
    signature,
  ].join(':');
}

/** Claim активации: у одного пользователя включение идёт строго по одному. */
function skillActivationClaimKey(userId: number): string {
  return `${SKILL_ACTIVATE_CLAIM_PREFIX}:${SKILL_KEY_VERSION}:${Math.trunc(Number(userId))}`;
}

interface SkillActivationClaim {
  key: string;
  /** Уникальный токен: снять метку вправе только тот, кто её поставил. */
  token: string;
}

/**
 * Захватывает право на активацию. Просроченный claim (упавший проход) снимается
 * и переиспользуется, свежий — отказ «уже выполняется». `null` — не захватили.
 *
 * Токен в значении, а не только время: освобождение сверяет метку, поэтому
 * медленный держатель не снимет claim того, кто перехватил просроченную метку.
 */
async function claimSkillActivation(userId: number): Promise<SkillActivationClaim | null> {
  const key = skillActivationClaimKey(userId);
  const now = Date.now();
  const token = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  try {
    const current = await kvGet(key);
    if (current) {
      const takenAt = Number.parseInt(current.split(':', 1)[0] ?? '', 10);
      if (Number.isFinite(takenAt) && now - takenAt < SKILL_ACTIVATE_CLAIM_TTL_MS) return null;
      await kvDelete(key);
    }
    const claimed = await kvSetIfAbsent(key, token);
    return claimed ? { key, token } : null;
  } catch {
    return null;
  }
}

/** Освобождает claim, только если метка всё ещё наша. */
async function releaseSkillActivation(claim: SkillActivationClaim): Promise<void> {
  try {
    const current = await kvGet(claim.key);
    if (current === claim.token) await kvDelete(claim.key);
  } catch {
    // протухнет по TTL — включение не блокируется навсегда
  }
}

// --- ключ кластера ---------------------------------------------------------

/** Ключ скилла из сигнатуры сбоя: стабилен, читаем, без свободного текста. */
export function skillKeyFromSignature(signature: string): string {
  const parts = parseFailureSignature(signature);
  const reason = parts?.reason ?? 'other';
  const tool = parts?.tool ?? '';
  const raw = `agent-${reason}${tool ? `-${tool}` : ''}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncate(slug || 'agent-other', 48);
}

// --- разбор и проверка -----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Разбор `spec`. `null` — это не скилл или строка повреждена. */
export function parseSkillSpec(raw: string | null | undefined): SkillSpec | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.format !== SKILL_SPEC_FORMAT) return null;
    const key = typeof parsed.key === 'string' ? parsed.key.trim() : '';
    if (!key) return null;
    const version = Number(parsed.version);
    if (!Number.isFinite(version) || version < 1) return null;
    const body = typeof parsed.body === 'string' ? parsed.body : '';
    if (!body.trim()) return null;
    const supersedesRaw = Number(parsed.supersedes);
    return {
      format: SKILL_SPEC_FORMAT,
      key,
      version: Math.trunc(version),
      originFailure:
        typeof parsed.originFailure === 'string' && parsed.originFailure.trim()
          ? parsed.originFailure
          : null,
      supersedes: Number.isFinite(supersedesRaw) && supersedesRaw > 0 ? Math.trunc(supersedesRaw) : null,
      body,
    };
  } catch {
    return null;
  }
}

/** Сборка `spec` в стабильном порядке полей (по нему не меняется сравнение). */
export function buildSkillSpec(input: {
  key: string;
  version: number;
  originFailure: string | null;
  supersedes: number | null;
  body: string;
}): string {
  const spec: SkillSpec = {
    format: SKILL_SPEC_FORMAT,
    key: input.key,
    version: Math.trunc(input.version),
    originFailure: input.originFailure,
    supersedes: input.supersedes,
    body: input.body,
  };
  return JSON.stringify(spec);
}

/** Индекс заголовка секции (`## When to Use`); `-1` — секции нет. */
function sectionIndex(body: string, name: string): number {
  const pattern = new RegExp(`^#{1,6}\\s*${name}\\b`, 'im');
  const match = pattern.exec(body);
  return match ? match.index : -1;
}

/**
 * Проверка тела: четыре секции в порядке, непустая `Verification`, лимит и
 * запрет оценочных формулировок. Возвращает причину отказа, а не обрезает.
 */
export function validateSkillBody(body: string): SkillValidation {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return { ok: false, error: 'тело скилла пустое' };
  if (text.length > SKILL_BODY_LIMIT) {
    return { ok: false, error: `тело скилла длиннее ${SKILL_BODY_LIMIT} символов` };
  }
  for (const forbidden of SKILL_FORBIDDEN_WORDS) {
    if (forbidden.test(text)) {
      return { ok: false, error: 'в теле скилла оценочная формулировка (запрещено)' };
    }
  }

  const indices = SKILL_SECTIONS.map((name) => sectionIndex(text, name));
  for (let i = 0; i < indices.length; i += 1) {
    if ((indices[i] as number) < 0) {
      return { ok: false, error: `нет обязательной секции «${SKILL_SECTIONS[i]}»` };
    }
  }
  for (let i = 1; i < indices.length; i += 1) {
    if ((indices[i] as number) < (indices[i - 1] as number)) {
      return { ok: false, error: `секции не в порядке: «${SKILL_SECTIONS[i]}»` };
    }
  }

  const verification = text.slice(indices[3] as number);
  const verificationBody = verification
    .replace(/^#{1,6}\s*Verification\b[^\n]*\n?/i, '')
    .trim();
  if (!verificationBody) return { ok: false, error: 'секция Verification пустая' };

  return { ok: true };
}

/** Проверка спеки целиком: формат, ключ, версия, тело. */
export function validateSkillSpec(spec: SkillSpec | null): SkillValidation {
  if (!spec) return { ok: false, error: 'спека скилла не разбирается' };
  if (!spec.key.trim()) return { ok: false, error: 'у скилла нет ключа' };
  if (!Number.isFinite(spec.version) || spec.version < 1) {
    return { ok: false, error: 'у скилла некорректная версия' };
  }
  return validateSkillBody(spec.body);
}

/** Срезает обёртку из ``` и предисловие: тело начинается с первой секции. */
export function normalizeSkillBody(raw: string): string {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  }
  const first = sectionIndex(text, SKILL_SECTIONS[0]);
  if (first > 0) text = text.slice(first).trim();
  return text;
}

// --- загрузка включённых скиллов ------------------------------------------

/**
 * Применимые скиллы: только `active`, только валидные, ровно один на ключ
 * (старшая версия). `pending` и `rejected` сюда не попадают физически, поэтому
 * и в промпт попасть не могут.
 */
export async function listActiveSkills(userId: number): Promise<ActiveSkill[]> {
  const rows = await listEvolutionItems(userId, { status: 'active', limit: 200 });
  const byKey = new Map<string, ActiveSkill>();
  for (const row of rows) {
    if (row.category !== 'skill') continue;
    const spec = parseSkillSpec(row.spec);
    if (!spec || !validateSkillSpec(spec).ok) continue;
    const current = byKey.get(spec.key);
    if (
      !current ||
      spec.version > current.version ||
      (spec.version === current.version && row.id > current.id)
    ) {
      byKey.set(spec.key, {
        id: row.id,
        key: spec.key,
        version: spec.version,
        originFailure: spec.originFailure,
        body: spec.body,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Один элемент блока скиллов. Единственный источник формата для бюджета и рендера. */
export function renderSkillEntryText(key: string, version: number, body: string): string {
  return `### ${key} (v${version})\n${body.trim()}`;
}

/** Тот же элемент для загруженного скилла. */
export function renderSkillEntry(skill: ActiveSkill): string {
  return renderSkillEntryText(skill.key, skill.version, skill.body);
}

/**
 * Сколько символов занимает блок скиллов: ровно тот текст, который уходит в
 * промпт (без вводной строки блока). Меряем то же, что рендерим, чтобы бюджет
 * не разъезжался с реальностью.
 */
export function skillPromptChars(skills: readonly ActiveSkill[]): number {
  return skills.map(renderSkillEntry).join('\n\n').length;
}

/** Строки `active` этого пользователя с разобранной спекой. */
async function activeSkillRows(
  userId: number,
): Promise<Array<{ row: EvolutionItemRow; spec: SkillSpec }>> {
  const rows = await listEvolutionItems(userId, { status: 'active', limit: 200 });
  const out: Array<{ row: EvolutionItemRow; spec: SkillSpec }> = [];
  for (const row of rows) {
    if (row.category !== 'skill') continue;
    const spec = parseSkillSpec(row.spec);
    if (!spec) continue;
    out.push({ row, spec });
  }
  return out;
}

// --- генерация черновика ---------------------------------------------------

const SKILL_DRAFT_SYSTEM = [
  'Ты превращаешь повторяющуюся слабость персонального ассистента в проверяемую процедуру.',
  'Ответ — только тело скилла, без предисловий, без markdown-обёртки из ```.',
  'Обязательные секции, строго в этом порядке и с этими заголовками уровня ##:',
  '## When to Use',
  '## Procedure',
  '## Pitfalls',
  '## Verification',
  'Требования:',
  `- весь ответ не длиннее ${SKILL_BODY_LIMIT} символов;`,
  '- Procedure — пронумерованные шаги, которые можно выполнить в этом же ассистенте;',
  '- Verification — как владелец проверит, что процедура выполнена (конкретные признаки);',
  '- никаких оценок вроде «качество» и «улучшилось», никаких обещаний будущего;',
  '- не вставляй сырые данные пользователя, идентификаторы чатов, ключи и токены.',
].join('\n');

function skillDraftUserPrompt(request: {
  key: string;
  version: number;
  signature: string;
  count: number;
  detail: string | null;
}): string {
  const lines = [
    `Кластер сбоя: ${request.signature}`,
    `Повторов: ${request.count}`,
    `Ключ процедуры: ${request.key}`,
    `Версия: ${request.version}`,
  ];
  if (request.detail) lines.push(`Диагностический хвост журнала: ${request.detail}`);
  lines.push('Сформулируй процедуру, которая предотвращает этот класс сбоя в следующий раз.');
  return lines.join('\n');
}

const defaultSkillDraftChat: SkillDraftChatFn = async (request) => {
  const result = await chat(
    [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    {
      userId: request.userId,
      purpose: 'skill_draft',
      temperature: 0.2,
      maxTokens: SKILL_DRAFT_MAX_TOKENS,
    },
  );
  return result.content ?? '';
};

interface SkillGenerationRequest {
  key: string;
  version: number;
  originFailure: string;
  supersedes: number | null;
  signature: string;
  count: number;
  detail: string | null;
}

type SkillGeneration =
  | { ok: true; item: EvolutionItemRow }
  | { ok: false; reason: string };

/**
 * Ровно один вызов модели на запрос. Ошибка модели и невалидный ответ попадают
 * в журнал, но не создают строку: следующее касание попробует снова.
 */
async function generateSkillVersion(
  userId: number,
  options: ReviewSkillDraftsOptions,
  request: SkillGenerationRequest,
): Promise<SkillGeneration> {
  const chatFn = options.chatFn ?? defaultSkillDraftChat;
  let raw: string;
  try {
    raw = await chatFn({
      userId,
      system: SKILL_DRAFT_SYSTEM,
      user: skillDraftUserPrompt(request),
    });
  } catch (error) {
    await recordFailure(userId, {
      stage: 'evolution',
      reason: 'llm_error',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'llm_error' };
  }

  const body = normalizeSkillBody(raw);
  const validation = validateSkillBody(body);
  if (!validation.ok) {
    await recordFailure(userId, {
      stage: 'evolution',
      reason: 'parse_failed',
      detail: validation.error,
    });
    return { ok: false, reason: 'invalid-draft' };
  }

  const spec = buildSkillSpec({
    key: request.key,
    version: request.version,
    originFailure: request.originFailure,
    supersedes: request.supersedes,
    body,
  });

  try {
    const item = await createEvolutionItem(userId, {
      rawInput: [
        `Сигнатура: ${request.signature}`,
        `Повторов: ${request.count}`,
        `Ключ: ${request.key} v${request.version}`,
        'Источник: журнал сбоев (черновик скилла)',
      ].join('\n'),
      title: truncate(`Скилл: ${request.key} v${request.version}`, 80),
      category: 'skill',
      spec,
      priority: 'medium',
    });
    return { ok: true, item };
  } catch (error) {
    await recordFailure(userId, {
      stage: 'evolution',
      reason: 'storage_failed',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'storage_failed' };
  }
}

/**
 * Проигравший параллельный проход удаляет только свой свежесозданный черновик:
 * побеждает меньший `id` по тому же origin. Чужую строку не трогаем никогда.
 */
async function dropLosingDuplicate(
  userId: number,
  item: EvolutionItemRow,
): Promise<EvolutionItemRow | null> {
  try {
    const origin = parseSkillSpec(item.spec)?.originFailure ?? null;
    if (!origin) return item;
    const rows = await listEvolutionItems(userId, { limit: 200 });
    const twins = rows.filter((row) => {
      if (row.id === item.id || row.category !== 'skill') return false;
      if (row.status !== 'pending') return false;
      return parseSkillSpec(row.spec)?.originFailure === origin;
    });
    if (twins.length === 0) return item;
    const winnerId = Math.min(item.id, ...twins.map((row) => row.id));
    if (winnerId === item.id) return item;
    await deleteEvolutionItem(userId, item.id);
    return null;
  } catch {
    // дедупликация — вспомогательный шаг: черновик уже создан
    return item;
  }
}

/**
 * Кандидат на ревизию: включённый скилл, у которого исходный класс сбоя
 * повторился `SKILL_REVISION_THRESHOLD` раз. Claim по
 * `(skillId, version, signature)` не даёт второй ревизии при повторе.
 */
async function prepareRevision(
  userId: number,
  options: ReviewSkillDraftsOptions,
): Promise<SkillReviewResult | null> {
  const active = await listActiveSkills(userId);
  for (const skill of active) {
    const signature = skill.originFailure;
    if (!signature) continue;
    let failures = 0;
    try {
      failures = Number((await kvGet(skillFailKey(userId, skill.id, signature))) ?? 0);
    } catch {
      continue;
    }
    if (!Number.isFinite(failures) || failures < SKILL_REVISION_THRESHOLD) continue;

    const version = skill.version + 1;
    const claim = skillRevisionClaimKey(userId, skill.id, version, signature);
    let claimed = false;
    try {
      claimed = await kvSetIfAbsent(claim, nowIso());
    } catch {
      claimed = false;
    }
    if (!claimed) continue;

    const generated = await generateSkillVersion(userId, options, {
      key: skill.key,
      version,
      originFailure: signature,
      supersedes: skill.id,
      signature,
      count: failures,
      detail: null,
    });
    if (!generated.ok) {
      try {
        await kvDelete(claim);
      } catch {
        // следующий проход попробует снова
      }
      return { kind: 'failed', itemId: null, reason: generated.reason };
    }
    return { kind: 'revision', itemId: generated.item.id, reason: 'revision' };
  }
  return null;
}

/** Кандидат на первый черновик: самый частый agent-кластер без скилла. */
async function prepareDraft(
  userId: number,
  options: ReviewSkillDraftsOptions,
): Promise<SkillReviewResult | null> {
  const [aggregates, items] = await Promise.all([
    listFailureAggregates(userId, { limit: 20 }),
    listEvolutionItems(userId, { limit: 200 }),
  ]);

  const knownOrigins = new Set<string>();
  for (const item of items) {
    if (item.category !== 'skill') continue;
    const spec = parseSkillSpec(item.spec);
    if (spec?.originFailure) knownOrigins.add(spec.originFailure);
  }

  // Скилл описывает поведение агента, а не отказ загрузки и не недоступность
  // провайдера: медиа/инфраструктура (и `llm_error` как инфраструктура) остаются
  // bug-задачами и модель не вызывают.
  const candidate = aggregates.find(
    (aggregate) =>
      aggregate.stage === 'agent' &&
      aggregate.media === 'none' &&
      SKILL_CANDIDATE_REASONS.includes(aggregate.reason) &&
      aggregate.count >= SKILL_DRAFT_THRESHOLD &&
      !knownOrigins.has(aggregate.signature),
  );
  if (!candidate) return null;

  const claim = skillDraftClaimKey(userId, candidate.signature);
  let claimed = false;
  try {
    claimed = await kvSetIfAbsent(claim, nowIso());
  } catch {
    claimed = false;
  }
  if (!claimed) return null;

  const generated = await generateSkillVersion(userId, options, {
    key: skillKeyFromSignature(candidate.signature),
    version: 1,
    originFailure: candidate.signature,
    supersedes: null,
    signature: candidate.signature,
    count: candidate.count,
    detail: candidate.detail,
  });
  if (!generated.ok) {
    try {
      await kvDelete(claim);
    } catch {
      // следующий проход попробует снова
    }
    return { kind: 'failed', itemId: null, reason: generated.reason };
  }

  const winner = await dropLosingDuplicate(userId, generated.item);
  if (!winner) return { kind: 'none', itemId: null, reason: 'duplicate' };
  return { kind: 'draft', itemId: winner.id, reason: 'draft' };
}

/**
 * Обзор одного касания: не более одного кандидата и не более одного вызова
 * модели. Ревизия приоритетнее нового черновика. Никогда не бросает.
 */
export async function reviewSkillDrafts(
  userId: number,
  options: ReviewSkillDraftsOptions = {},
): Promise<SkillReviewResult> {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return { kind: 'none', itemId: null, reason: 'invalid-user' };
  try {
    const revision = await prepareRevision(uid, options);
    if (revision) return revision;
    const draft = await prepareDraft(uid, options);
    if (draft) return draft;
    return { kind: 'none', itemId: null, reason: 'no-candidate' };
  } catch (error) {
    await recordFailure(uid, {
      stage: 'evolution',
      reason: 'other',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed', itemId: null, reason: 'review-error' };
  }
}

// --- решение владельца -----------------------------------------------------

/**
 * Включение: только владелец, только валидная спека, только в пределах бюджета.
 * Превышение — явный отказ, текст не обрезается. Соседи по ключу вытесняются,
 * поэтому двух активных версий одного ключа не бывает.
 *
 * Активации одного пользователя сериализуются claim'ом в `kv`: без него два
 * одновременных включения прочитали бы один и тот же набор активных строк и
 * оба записали `active` — инвариант «одна активная версия на ключ» и бюджет
 * держались бы только на честном слове.
 */
export async function activateSkill(userId: number, itemId: number): Promise<SkillAction> {
  const item = await getEvolutionItem(userId, itemId);
  if (!item || item.category !== 'skill') {
    return { ok: false, error: 'Скилл не найден.' };
  }
  const spec = parseSkillSpec(item.spec);
  if (!spec) return { ok: false, error: 'Спека скилла повреждена — включить нельзя.' };
  const validation = validateSkillSpec(spec);
  if (!validation.ok) return { ok: false, error: `Скилл невалиден: ${validation.error}.` };

  if (item.status === 'active') return { ok: false, error: 'Этот скилл уже включён.' };
  if (item.status === 'rejected') {
    return { ok: false, error: 'Отклонённый скилл включить нельзя: сначала нужен новый черновик.' };
  }
  if (item.status !== 'pending' && item.status !== 'superseded') {
    return { ok: false, error: 'Включить можно только ожидающий черновик или прежнюю версию.' };
  }

  const claim = await claimSkillActivation(userId);
  if (!claim) {
    return { ok: false, error: 'Включение уже выполняется — повторите через минуту.' };
  }

  try {
    // Читаем активные строки ТОЛЬКО после захвата claim: иначе бюджет и список
    // соседей посчитаны по устаревшему снимку.
    const active = await listActiveSkills(userId);
    const others = active.filter((skill) => skill.key !== spec.key);
    const candidate: ActiveSkill = {
      id: item.id,
      key: spec.key,
      version: spec.version,
      originFailure: spec.originFailure,
      body: spec.body,
    };
    const total = skillPromptChars([...others, candidate]);
    if (total > SKILL_PROMPT_BUDGET) {
      return {
        ok: false,
        error: [
          `Не включаю: суммарный текст процедур станет ${total} символов при лимите ${SKILL_PROMPT_BUDGET}.`,
          'Текст не обрезается — сократите процедуру или отклоните другую.',
        ].join(' '),
      };
    }

    const siblings = (await activeSkillRows(userId))
      .filter((entry) => entry.spec.key === spec.key && entry.row.id !== itemId)
      .map((entry) => entry.row.id);

    const activated = await activateSkillRevision(userId, itemId, siblings);
    if (!activated) return { ok: false, error: 'Не удалось включить скилл.' };
    return { ok: true, item: activated };
  } finally {
    await releaseSkillActivation(claim);
  }
}

/** Отклонение черновика: только `pending`, следов в промпте не остаётся. */
export async function rejectSkill(userId: number, itemId: number): Promise<SkillAction> {
  const item = await getEvolutionItem(userId, itemId);
  if (!item || item.category !== 'skill') return { ok: false, error: 'Скилл не найден.' };
  if (item.status !== 'pending') {
    return { ok: false, error: 'Отклонить можно только ожидающий черновик.' };
  }
  const updated = await updateEvolutionItem(userId, itemId, { status: 'rejected' });
  if (!updated) return { ok: false, error: 'Не удалось отклонить скилл.' };
  return { ok: true, item: updated };
}

// --- замер -----------------------------------------------------------------

/** Исход прогона в терминах скилла. `confirm` — штатная остановка. */
export type SkillRunOutcome = 'final' | 'failed_steps' | 'llm_error';

export interface SkillRunReport {
  skills: readonly ActiveSkill[];
  /** `AgentStopReason` движка; здесь строка, чтобы не тянуть движок в модуль. */
  stopReason: string;
  steps?: ReadonlyArray<{ ok: boolean; action?: { name: string } | null }>;
}

export function skillRunOutcome(stopReason: string): SkillRunOutcome {
  if (stopReason === 'llm_error') return 'llm_error';
  if (stopReason === 'final' || stopReason === 'confirm') return 'final';
  return 'failed_steps';
}

/**
 * Сигнатура терминального отказа прогона. Нужна, чтобы сверять её с исходным
 * сбоем скилла: без неудачных шагов причину знает только `stopReason`.
 */
export function terminalSkillSignature(stopReason: string): string | null {
  if (stopReason === 'llm_error' || stopReason === 'step_limit' || stopReason === 'empty_reply') {
    return normalizeFailureSignature({ stage: 'agent', reason: stopReason });
  }
  return null;
}

/**
 * Один прогон → один инкремент применения на скилл, а не на шаг. Неудачный шаг
 * пишется отдельным счётчиком как совместное событие; причиной сбоя скилла он
 * не объявляется. Счётчик ревизии растёт только когда сигнатура отказа прогона
 * совпала с исходным сбоем этого скилла. Никогда не бросает.
 */
export async function recordSkillRun(userId: number, report: SkillRunReport): Promise<void> {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || report.skills.length === 0) return;
  try {
    const outcome = skillRunOutcome(report.stopReason);
    const at = nowIso();
    const signatures = new Set<string>();
    for (const step of report.steps ?? []) {
      if (step.ok !== false) continue;
      const tool = step.action?.name ?? null;
      signatures.add(
        normalizeFailureSignature({
          stage: 'agent',
          reason: tool ? 'tool_error' : 'other',
          tool,
        }),
      );
    }
    const terminal = terminalSkillSignature(report.stopReason);
    if (terminal) signatures.add(terminal);

    for (const skill of report.skills) {
      const uses = skillStoreKey(SKILL_RUN_PREFIX, uid, skill.id);
      await kvIncrement(uses);
      await kvIncrement(`${skillStoreKey(SKILL_OUTCOME_PREFIX, uid, skill.id)}:${outcome}`);
      await kvSet(skillStoreKey(SKILL_LAST_PREFIX, uid, skill.id), at);
      for (const signature of signatures) {
        await kvIncrement(`${uses}:${signature}`);
      }
      if (skill.originFailure && signatures.has(skill.originFailure)) {
        await kvIncrement(skillFailKey(uid, skill.id, skill.originFailure));
      }
    }
  } catch {
    // телеметрия не имеет права менять результат прогона
  }
}

/** Просмотр полного текста — отдельный счётчик, не применение. */
export async function recordSkillView(userId: number, skillId: number): Promise<void> {
  const uid = Number(userId);
  const id = Math.trunc(Number(skillId));
  if (!Number.isFinite(uid) || !Number.isFinite(id) || id <= 0) return;
  try {
    await kvIncrement(skillStoreKey(SKILL_VIEW_PREFIX, uid, id));
  } catch {
    // счётчик просмотров — вспомогательный
  }
}

/** Числа по одному скиллу. Отсутствие ключа — ноль, а не ошибка. */
export async function skillUsage(userId: number, skillId: number): Promise<SkillUsage> {
  const read = async (key: string): Promise<number> => {
    try {
      const value = Number((await kvGet(key)) ?? 0);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  };
  const [uses, views, final, failedSteps, llmError, last] = await Promise.all([
    read(skillStoreKey(SKILL_RUN_PREFIX, userId, skillId)),
    read(skillStoreKey(SKILL_VIEW_PREFIX, userId, skillId)),
    read(`${skillStoreKey(SKILL_OUTCOME_PREFIX, userId, skillId)}:final`),
    read(`${skillStoreKey(SKILL_OUTCOME_PREFIX, userId, skillId)}:failed_steps`),
    read(`${skillStoreKey(SKILL_OUTCOME_PREFIX, userId, skillId)}:llm_error`),
    kvGet(skillStoreKey(SKILL_LAST_PREFIX, userId, skillId)).catch(() => null),
  ]);
  return { uses, views, final, failedSteps, llmError, lastUsedAt: last ?? null };
}

// --- текст для команд ------------------------------------------------------

const SKILL_STATUS_LABELS: Record<string, string> = {
  pending: 'ожидает решения',
  active: 'включён',
  superseded: 'вытеснен',
  rejected: 'отклонён',
};

/** Оговорка к числам: совместная встречаемость, а не доказанное влияние. */
export const SKILL_CORRELATION_NOTE =
  'Числа показывают совместную встречаемость и не доказывают, что процедура повлияла на исход.';

/** Время последнего применения в коротком виде. */
function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  return value.slice(0, 16).replace('T', ' ');
}

function skillCountersLine(usage: SkillUsage): string {
  return [
    `применений: ${usage.uses}`,
    `просмотров: ${usage.views}`,
    `финальных: ${usage.final}`,
    `шагов с ошибкой: ${usage.failedSteps}`,
    `llm_error: ${usage.llmError}`,
    `последний раз: ${formatTimestamp(usage.lastUsedAt)}`,
  ].join(' · ');
}

/** Все скиллы пользователя с числами — для `/skills`. */
export async function formatSkillsList(userId: number): Promise<string> {
  const items = (await listEvolutionItems(userId, { limit: 200 })).filter(
    (item) => item.category === 'skill',
  );
  if (items.length === 0) {
    return [
      '🧩 Скиллов пока нет.',
      '',
      'Черновик появится сам: после трёх одинаковых сбоев агента бот предложит процедуру.',
      SKILL_CORRELATION_NOTE,
    ].join('\n');
  }

  const order: Record<string, number> = { pending: 0, active: 1, superseded: 2, rejected: 3 };
  const sorted = [...items].sort(
    (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.id - a.id,
  );

  const lines: string[] = ['🧩 Скиллы (предложенные процедуры)', ''];
  for (const item of sorted) {
    const spec = parseSkillSpec(item.spec);
    const usage = await skillUsage(userId, item.id);
    const key = spec?.key ?? 'повреждён';
    const version = spec ? `v${spec.version}` : 'v?';
    lines.push(`#${item.id} · ${key} ${version} · ${SKILL_STATUS_LABELS[item.status] ?? item.status}`);
    lines.push(`   ${skillCountersLine(usage)}`);
  }
  lines.push('');
  lines.push('Показать полный текст: /skills show <id>');
  lines.push('Включить (только владелец): /skills activate <id>');
  lines.push('Отклонить черновик: /skills reject <id>');
  lines.push(SKILL_CORRELATION_NOTE);
  return lines.join('\n');
}

/** Полный текст одного скилла. `null` — нет такого / чужой. */
export async function formatSkillCard(
  userId: number,
  itemId: number,
  options: { countView?: boolean } = {},
): Promise<string | null> {
  const item = await getEvolutionItem(userId, itemId);
  if (!item || item.category !== 'skill') return null;
  const spec = parseSkillSpec(item.spec);
  if (options.countView !== false) await recordSkillView(userId, item.id);
  const usage = await skillUsage(userId, item.id);

  const lines: string[] = [
    `🧩 ${spec?.key ?? 'повреждённый скилл'} v${spec?.version ?? '?'} · ${
      SKILL_STATUS_LABELS[item.status] ?? item.status
    }`,
  ];
  if (spec?.originFailure) lines.push(`Исходный сбой: ${spec.originFailure}`);
  if (spec?.supersedes) lines.push(`Вытесняет: #${spec.supersedes}`);
  lines.push(skillCountersLine(usage));
  lines.push('');
  lines.push(spec?.body ?? item.rawInput);
  lines.push('');
  if (item.status === 'pending') lines.push(`Включить: /skills activate ${item.id}`);
  if (item.status !== 'rejected') lines.push(`Отклонить: /skills reject ${item.id}`);
  lines.push(SKILL_CORRELATION_NOTE);
  return lines.join('\n');
}
