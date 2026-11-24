/**
 * Ночная консолидация заметок — порт
 * `backend/app/services/consolidation.py` на ленивый планировщик `due_jobs`.
 *
 * Что делает: берёт необработанные заметки (`notes.column = 'raw'`), просит
 * модель почистить текст, определить колонку канбана и найти дубликаты, затем
 * пишет результат через DAL заметок. Дубликаты уезжают в `trash` с префиксом
 * `[Дубликат]:`.
 *
 * Отличия от upstream, зафиксированные осознанно:
 *  - колонки порта (`NoteColumn`): `idea` | `note` | `todo` | `trash`, а не
 *    `ideas` | `self` | `useful` | `possible_tasks` | `archive`. Ответ модели
 *    проходит через `COLUMN_ALIASES`, поэтому старый промпт тоже работает;
 *  - идемпотентность — маркер в `kv` по ключу
 *    `nightly_consolidation:<userId>:<YYYY-MM-DD в таймзоне юзера>`: повторный
 *    прогон за ту же локальную дату ничего не делает (`force` снимает запрет).
 *    Второй слой идемпотентности — сам выбор: обработанные заметки уходят из
 *    `raw`, поэтому следующий день их уже не берёт;
 *  - `notes.processed_at` НЕ выставляется: `NotePatch` (DAL заметок) даёт
 *    только `cleanText` и `column`, а лезть в чужой DAL отсюда нельзя. Маркер в
 *    `kv` закрывает ту же задачу «не обрабатывать дважды». Когда владелец
 *    `dal/notes.ts` добавит `processedAt` в патч — здесь достаточно одной строки;
 *  - нет `setTimeout`/фонового процесса (SPEC §2.6): работа выполняется шагом
 *    `due_jobs` через `registerConsolidationHandler()`;
 *  - из того же одного LLM-вызова опционально извлекаются `entities` и `relations`
 *    в граф знаний (`dal/misc.ts`).
 *
 * Модель не вызывается напрямую: как и в классификаторе, наружу торчит
 * `setConsolidationChat()`; по умолчанию используется `chatJson()` из
 * `lib/gemini.ts` с `purpose: 'consolidation'` (биллинг общий).
 */

import type { DueJobRow, IsoTimestamp, NoteColumn, NoteRow } from '../types.js';
import { chatJson } from './gemini.js';
import { getConfig } from './config.js';
import {
  addRelation,
  kvGet,
  kvSetJson,
  linkMention,
  parseKgEntities,
  parseKgRelations,
  upsertEntity,
  type ParsedKgEntity,
  type ParsedKgRelation,
} from './dal/misc.js';
import { registerJobHandler, schedule } from './dal/due_jobs.js';
import { listNotes, updateNote } from './dal/notes.js';
import { getUser } from './dal/users.js';
import { recordFailure } from './evolution.js';
import { loadUserPrefs, type UserPrefs } from './prefs.js';
import { addDays, dateKey, nowIso, startOfLocalDay, truncate } from './utils.js';

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/** Колонка, из которой берутся необработанные заметки (дефолт `dal/notes.ts`). */
export const PENDING_COLUMN: NoteColumn = 'raw';

/** Сколько заметок разбирать за один прогон (как в upstream: LIMIT 30). */
export const DEFAULT_NOTE_LIMIT = 30;

/** Сколько строк читать перед обрезкой: берём самые старые из окна. */
export const DEFAULT_SCAN_LIMIT = 100;

/** Префикс текста дубликата. */
export const DUPLICATE_PREFIX = '[Дубликат]:';

/** Час локальной ночи, в который планируется прогон (как в upstream, 03:00). */
export const NIGHTLY_HOUR = 3;

const CONSOLIDATION_TEMPERATURE = 0.2;

/** Ключ маркера идемпотентности. */
export function consolidationMarkerKey(userId: number, day: string): string {
  return `nightly_consolidation:${userId}:${day}`;
}

// ---------------------------------------------------------------------------
// Промпт (нейтральный: без бренда и персональных особенностей хозяина)
// ---------------------------------------------------------------------------

export const CONSOLIDATION_PROMPT = `Ты — ночной редактор заметок.
Разбери сырые заметки пользователя, накопившиеся за день: убери словесный мусор, разложи записи по колонкам канбан-доски и (опционально) извлеки факты в граф знаний.

Для каждой заметки определи:
1. "clean_text": лаконичный, грамотно отредактированный текст без слов-паразитов, заиканий и оговорок.
2. "column": одна из колонок:
   - "idea" (творческие идеи, гипотезы, замыслы проектов)
   - "note" (полезное: ссылки, книги, инструменты, наблюдения, личные мысли)
   - "todo" (действия, которые можно превратить в конкретные дела)
   - "trash" (неактуальное, одноразовые заметки)
3. "is_duplicate_of_id": если заметка полностью дублирует другую заметку из списка — id той заметки, иначе null.

Дополнительно, если в заметках явно упоминаются конкретные люди, места, проекты, организации и связи между ними, извлеки их в "entities" и "relations" (если нет — верни пустые массивы, ничего не выдумывай):
- "entities": [{"name": "Имя/Название", "kind": "person|place|project|org|other", "aliases": ["Алиас"], "description": "Краткий факт/роль", "source_note_id": 123}]
- "relations": [{"subject": "Субъект", "predicate": "связь (например: работает в / живёт в / руководит)", "object": "Объект", "source_note_id": 123}]

Входящие заметки переданы JSON-массивом: [{"id": "<id>", "raw_text": "<текст>"}]

Верни строго JSON:
{
  "processed_notes": [
    {
      "id": "<id заметки>",
      "clean_text": "<очищенный текст>",
      "column": "idea | note | todo | trash",
      "is_duplicate_of_id": null
    }
  ],
  "entities": [
    {
      "name": "Имя/Название",
      "kind": "person|place|project|org|other",
      "aliases": ["Алиас"],
      "description": "Краткий факт/роль",
      "source_note_id": 123
    }
  ],
  "relations": [
    {
      "subject": "Субъект",
      "predicate": "связь (например: работает в / живёт в / руководит)",
      "object": "Объект",
      "source_note_id": 123
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Инъекция модели
// ---------------------------------------------------------------------------

/** Запрос к LLM: консолидация не знает, какой клиент под ней (T6). */
export interface ConsolidationChatRequest {
  userId?: number;
  systemPrompt: string;
  userPrompt: string;
  responseFormat: 'json_object';
  temperature: number;
  purpose: 'consolidation';
}

/** Инъекция «чата»: принимает запрос, отдаёт содержимое ответа модели. */
export type ConsolidationChatFn = (request: ConsolidationChatRequest) => Promise<string>;

let chatFn: ConsolidationChatFn | null = null;

/** По умолчанию — общий JSON-чат `lib/gemini.ts` (биллинг с `purpose`). */
const defaultChat: ConsolidationChatFn = async (request) => {
  const response = await chatJson<unknown>(
    [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
    {
      userId: request.userId,
      purpose: request.purpose,
      temperature: request.temperature,
      json: true,
    },
  );
  // Модель могла ответить объектом не той формы — разбор всё равно пойдёт через
  // `parseConsolidationResponse`, поэтому сериализуем как есть.
  return JSON.stringify(response.data ?? {});
};

/** Подключить клиент LLM. `null` — вернуть поведение по умолчанию. */
export function setConsolidationChat(fn: ConsolidationChatFn | null): void {
  chatFn = fn;
}

/** Подключён ли внешний клиент (для тестов и диагностики). */
export function hasConsolidationChat(): boolean {
  return chatFn !== null;
}

function activeChat(): ConsolidationChatFn {
  return chatFn ?? defaultChat;
}

// ---------------------------------------------------------------------------
// Разбор ответа модели
// ---------------------------------------------------------------------------

export type ConsolidationExtractedEntity = ParsedKgEntity;

export type ConsolidationExtractedRelation = ParsedKgRelation;

export interface ConsolidationParsedResponse {
  processedNotes: Record<string, unknown>[];
  entities: ConsolidationExtractedEntity[];
  relations: ConsolidationExtractedRelation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Достаёт JSON-объект или JSON-массив из ответа модели (чистый JSON, фенс, текст вокруг). */
function parseJsonValue(content: string): Record<string, unknown> | unknown[] | null {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  if (!text) return null;

  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  const candidates = [text];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');

  const objectCandidate =
    firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : null;
  const arrayCandidate =
    firstBracket >= 0 && lastBracket > firstBracket
      ? text.slice(firstBracket, lastBracket + 1)
      : null;

  if (arrayCandidate && (!objectCandidate || firstBracket < firstBrace)) {
    candidates.push(arrayCandidate);
    if (objectCandidate) candidates.push(objectCandidate);
  } else {
    if (objectCandidate) candidates.push(objectCandidate);
    if (arrayCandidate) candidates.push(arrayCandidate);
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed) || Array.isArray(parsed)) return parsed;
    } catch {
      // пробуем следующий вариант
    }
  }
  return null;
}

/**
 * Разбирает полный ответ модели: `processed_notes` (или голый JSON-массив)
 * плюс опциональные `entities` и `relations` для графа знаний.
 */
export function parseConsolidationPayload(content: string): ConsolidationParsedResponse {
  const parsed = parseJsonValue(content);
  if (!parsed) return { processedNotes: [], entities: [], relations: [] };

  if (Array.isArray(parsed)) {
    return {
      processedNotes: parsed.filter(isRecord),
      entities: [],
      relations: [],
    };
  }

  const processedNotes = Array.isArray(parsed.processed_notes)
    ? parsed.processed_notes.filter(isRecord)
    : [];

  const entities = parseKgEntities(parsed.entities);
  const relations = parseKgRelations(parsed.relations);

  return { processedNotes, entities, relations };
}

/**
 * Разбирает ответ модели в список элементов `processed_notes`.
 * Мусор/отсутствие поля → пустой список (прогон всё равно считается успешным:
 * модель ответила, значит день отработан).
 */
export function parseConsolidationResponse(content: string): Record<string, unknown>[] {
  return parseConsolidationPayload(content).processedNotes;
}

// ---------------------------------------------------------------------------
// Колонки: алиасы upstream → колонки порта
// ---------------------------------------------------------------------------

/** Синонимы колонок: и порт, и старые имена upstream (`self`, `useful`, …). */
const COLUMN_ALIASES: Readonly<Record<string, NoteColumn>> = {
  idea: 'idea',
  ideas: 'idea',
  note: 'note',
  notes: 'note',
  self: 'note',
  useful: 'note',
  todo: 'todo',
  todos: 'todo',
  task: 'todo',
  tasks: 'todo',
  possible_tasks: 'todo',
  trash: 'trash',
  archive: 'trash',
};

/** Колонка ответа модели → допустимая колонка порта (по умолчанию `idea`). */
export function normalizeColumn(value: unknown): NoteColumn {
  if (typeof value !== 'string') return 'idea';
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return COLUMN_ALIASES[key] ?? 'idea';
}

// ---------------------------------------------------------------------------
// Выборка и запись
// ---------------------------------------------------------------------------

/** Идентификатор из ответа модели → строка для сверки (числа и `"12"`). */
function normalizeId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string') return value.trim().replace(/^["'`]+|["'`]+$/g, '');
  return '';
}

/**
 * Необработанные заметки: только `raw`, только живые, самые старые первыми.
 * `listNotes` отдаёт новые первыми, поэтому читаем окно и разворачиваем его.
 */
async function pendingNotes(userId: number, limit: number): Promise<NoteRow[]> {
  const scan = Math.max(limit, DEFAULT_SCAN_LIMIT);
  const notes = await listNotes(userId, { column: PENDING_COLUMN, limit: scan });
  return notes
    .slice()
    .sort((a, b) => {
      const left = a.createdAt ?? '';
      const right = b.createdAt ?? '';
      if (left === right) return a.id - b.id;
      return left < right ? -1 : 1;
    })
    .slice(0, limit);
}

/** Таймзона пользователя (для локальной даты и расписания). */
export async function resolveUserTimezone(userId: number): Promise<string> {
  const user = await getUser(userId);
  if (user?.timezone?.trim()) return user.timezone.trim();
  try {
    const config = await getConfig();
    if (config.defaultTimezone?.trim()) return config.defaultTimezone.trim();
  } catch {
    // конфиг недоступен (например, нет secrets.js) — остаёмся на UTC
  }
  return 'UTC';
}

/** Русская форма слова «заметка» для числа. */
function pluralNotes(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'заметку';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'заметки';
  return 'заметок';
}

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

export type ConsolidationStatus = 'success' | 'skipped' | 'error';

export interface ConsolidationOptions {
  /** Момент прогона (для даты и маркера) — в тестах подменяется. */
  now?: Date;
  /** Игнорировать маркер: прогнать заново за ту же дату. */
  force?: boolean;
  /** Сколько заметок разбирать за прогон. */
  limit?: number;
  /** Таймзона для локальной даты; по умолчанию — из профиля юзера. */
  timeZone?: string;
}

export interface ConsolidationResult {
  status: ConsolidationStatus;
  message: string;
  /** Сколько уникальных заметок реально обновлено. */
  processedCount: number;
  /** Локальная дата прогона `YYYY-MM-DD`. */
  dateKey: string;
  /** id обновлённых заметок. */
  noteIds: number[];
  /** Сколько сущностей графа знаний создано/обновлено. */
  entitiesUpserted: number;
  /** Сколько связей графа знаний добавлено. */
  relationsAdded: number;
}

interface ConsolidationMarker {
  dateKey: string;
  processedCount: number;
  noteIds: number[];
  finishedAt: IsoTimestamp;
}

/**
 * Один прогон консолидации за локальную дату пользователя.
 *
 * Идемпотентность: маркер в `kv`. Если за эту дату уже отработали —
 * `status: 'skipped'` и ничего не пишем (снять запрет можно `force: true`).
 * Ошибка модели/записи → `status: 'error'` и маркер НЕ ставится, чтобы
 * следующая попытка (или `markFailed` в планировщике) могла повторить.
 */
export async function runNightlyConsolidation(
  userId: number,
  options: ConsolidationOptions = {},
): Promise<ConsolidationResult> {
  const now = options.now ?? new Date();
  const day = options.timeZone
    ? dateKey(now, options.timeZone)
    : dateKey(now, await resolveUserTimezone(userId));
  const markerKey = consolidationMarkerKey(userId, day);

  const prefs = await loadUserPrefs(userId).catch((): UserPrefs => ({}));
  const ncPrefs = prefs.proactive?.jobs?.nightly_consolidation;
  if (options.force !== true && ncPrefs?.enabled === false) {
    return {
      status: 'skipped',
      message: 'Ночная консолидация отключена в настройках.',
      processedCount: 0,
      dateKey: day,
      noteIds: [],
      entitiesUpserted: 0,
      relationsAdded: 0,
    };
  }

  if (options.force !== true) {
    const existing = await kvGet(markerKey);
    if (existing !== null) {
      return {
        status: 'skipped',
        message: `Консолидация за ${day} уже выполнена.`,
        processedCount: 0,
        dateKey: day,
        noteIds: [],
        entitiesUpserted: 0,
        relationsAdded: 0,
      };
    }
  }

  const limit = Math.max(1, Math.trunc(options.limit ?? ncPrefs?.noteLimit ?? DEFAULT_NOTE_LIMIT));

  try {
    const notes = await pendingNotes(userId, limit);
    if (notes.length === 0) {
      await kvSetJson(markerKey, {
        dateKey: day,
        processedCount: 0,
        noteIds: [],
        finishedAt: nowIso(),
      } satisfies ConsolidationMarker);
      return {
        status: 'skipped',
        message: 'Нет новых заметок для консолидации.',
        processedCount: 0,
        dateKey: day,
        noteIds: [],
        entitiesUpserted: 0,
        relationsAdded: 0,
      };
    }

    const userPrompt = JSON.stringify(
      notes.map((note) => ({ id: String(note.id), raw_text: note.rawText })),
    );
    const answer = await activeChat()({
      userId,
      systemPrompt: CONSOLIDATION_PROMPT,
      userPrompt,
      responseFormat: 'json_object',
      temperature: CONSOLIDATION_TEMPERATURE,
      purpose: 'consolidation',
    });

    const {
      processedNotes: items,
      entities: extractedEntities,
      relations: extractedRelations,
    } = parseConsolidationPayload(answer);
    const validIds = new Map(notes.map((note) => [String(note.id), note.id] as const));
    const processed: number[] = [];

    for (const item of items) {
      const rawId = item.id;
      const cleanRaw = typeof item.clean_text === 'string' ? item.clean_text.trim() : '';
      if (rawId === null || rawId === undefined || !cleanRaw) continue;

      const key = normalizeId(rawId);
      let targetId = key ? validIds.get(key) : undefined;
      // как в upstream: единственная заметка в выборке — принимаем любой id
      if (targetId === undefined && notes.length === 1) targetId = notes[0].id;
      if (targetId === undefined) continue;

      const duplicate = item.is_duplicate_of_id;
      const isDuplicate =
        duplicate !== null &&
        duplicate !== undefined &&
        normalizeId(duplicate) !== '' &&
        normalizeId(duplicate) !== '0';

      const column: NoteColumn = isDuplicate ? 'trash' : normalizeColumn(item.column);
      const cleanText =
        isDuplicate && !cleanRaw.startsWith(DUPLICATE_PREFIX)
          ? `${DUPLICATE_PREFIX} ${cleanRaw}`
          : cleanRaw;

      const updated = await updateNote(userId, targetId, { cleanText, column });
      if (!updated) continue;
      if (!processed.includes(targetId)) processed.push(targetId);
    }

    const resolveBatchNoteId = (rawNoteId: number | null): number | null => {
      if (rawNoteId === null) return null;
      return validIds.get(String(rawNoteId)) ?? null;
    };

    let entitiesUpserted = 0;
    for (const ent of extractedEntities) {
      try {
        const upserted = await upsertEntity(userId, {
          name: ent.name,
          kind: ent.kind,
          aliases: ent.aliases,
          description: ent.description,
        });
        entitiesUpserted += 1;
        const sourceId = resolveBatchNoteId(ent.sourceNoteId);
        if (sourceId !== null) {
          await linkMention(userId, {
            entityId: upserted.id,
            sourceType: 'note',
            sourceId,
          });
        }
      } catch {
        // Ошибки отдельной сущности не должны ронять ночную консолидацию заметок.
      }
    }

    let relationsAdded = 0;
    for (const rel of extractedRelations) {
      try {
        const subj = await upsertEntity(userId, { name: rel.subject });
        const obj = await upsertEntity(userId, { name: rel.object });
        const sourceId = resolveBatchNoteId(rel.sourceNoteId);
        const added = await addRelation(userId, {
          subjectId: subj.id,
          predicate: rel.predicate,
          objectId: obj.id,
          sourceId,
        });
        if (added) relationsAdded += 1;
      } catch {
        // Ошибки отдельной связи не должны ронять ночную консолидацию заметок.
      }
    }

    await kvSetJson(markerKey, {
      dateKey: day,
      processedCount: processed.length,
      noteIds: processed,
      finishedAt: nowIso(),
    } satisfies ConsolidationMarker);

    return {
      status: 'success',
      message: `Консолидация завершена: разобрано ${processed.length} ${pluralNotes(processed.length)}.`,
      processedCount: processed.length,
      dateKey: day,
      noteIds: processed,
      entitiesUpserted,
      relationsAdded,
    };
  } catch (error) {
    const reason = truncate(
      error instanceof Error ? error.message : String(error ?? 'unknown error'),
      300,
    );
    // Консолидация — стадия без кнопки повтора: следующий прогон и есть повтор.
    // Причина остаётся в журнале, иначе ночной отказ виден только в ответе,
    // которого пользователь не увидит.
    await recordFailure(userId, {
      stage: 'consolidation',
      reason: 'consolidation_failed',
      detail: reason,
    });
    return {
      status: 'error',
      message: `Ошибка консолидации: ${reason}`,
      processedCount: 0,
      dateKey: day,
      noteIds: [],
      entitiesUpserted: 0,
      relationsAdded: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Планировщик (due_jobs)
// ---------------------------------------------------------------------------

/**
 * Ближайший локальный час `hour` (сегодня, если ещё не наступил, иначе завтра).
 *
 * DST: `startOfLocalDay` уже учитывает смещение на текущий момент, а `addDays`
 * прибавляет ровно 24 часа по UTC — в день перевода часов прогон может
 * сместиться на час. Для ночной джобы это допустимо (и документируется здесь),
 * а не «тихая» ошибка расчёта: дата прогона в маркере всё равно локальная.
 */
export function nextNightlyAt(now: Date, hour: number, timeZone: string): Date {
  const safeHour = Math.min(23, Math.max(0, Math.trunc(hour)));
  const startToday = startOfLocalDay(now, timeZone);
  const todayAt = new Date(startToday.getTime() + safeHour * 3_600_000);
  if (todayAt.getTime() > now.getTime()) return todayAt;
  return new Date(addDays(startToday, 1).getTime() + safeHour * 3_600_000);
}

/**
 * Ставит (или переставляет) ночную консолидацию пользователя.
 * Идемпотентно: `due_jobs.schedule` обновляет уже ожидающую задачу.
 */
export async function scheduleNightlyConsolidation(
  userId: number,
  options: { now?: Date; hour?: number; timeZone?: string } = {},
): Promise<DueJobRow> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? (await resolveUserTimezone(userId));
  let configuredHour: number | undefined;
  if (options.hour === undefined) {
    const prefs = await loadUserPrefs(userId).catch((): UserPrefs => ({}));
    configuredHour = prefs.proactive?.jobs?.nightly_consolidation?.hour;
  }
  const hour = Math.min(23, Math.max(0, Math.trunc(options.hour ?? configuredHour ?? NIGHTLY_HOUR)));
  return schedule(userId, 'nightly_consolidation', nextNightlyAt(now, hour, timeZone), { hour });
}

/**
 * Регистрирует обработчик `nightly_consolidation` в ленивом планировщике.
 *
 * После прогона ставит задачу на следующую ночь: `due_jobs` не умеет
 * самоповтор, а upstream-крон был ежедневным. Ошибка прогона пробрасывается,
 * чтобы `runDueJobs` пометил задачу `failed` с причиной (`last_error`).
 */
export function registerConsolidationHandler(
  options: { hour?: number; timeZone?: string } = {},
): void {
  registerJobHandler('nightly_consolidation', async (job: DueJobRow) => {
    const result = await runNightlyConsolidation(job.userId, {
      timeZone: options.timeZone,
    });
    if (result.status === 'error') throw new Error(result.message);
    await scheduleNightlyConsolidation(job.userId, {
      hour: options.hour,
      timeZone: options.timeZone,
    });
  });
}
