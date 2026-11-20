/**
 * DAL: `messages` — полный лог диалога пользователя.
 *
 * Это «сырой» ingest истории: каждая реплика (user / assistant / system)
 * складывается строкой, `meta` — json-объект шага (tool calls, id моделей,
 * стоимость и т.п.). Агентное состояние (thread для ReAct) живёт отдельно,
 * в `agent_state`; здесь — журнал, по которому строятся дайджесты, память
 * и очистка по сроку хранения.
 *
 * Кодирование значений — руками (SDK/мок не декодируют строки при чтении):
 *  - `meta` — TEXT с JSON: `JSON.stringify` на запись, `JSON.parse` на чтение
 *    (битый json → `{}`);
 *  - `created_at` — ISO-строка из `nowIso()`, никаких объектов `Date`;
 *  - `undefined` в параметры не попадает — только явный `null`.
 *
 * `deleteOlderThan` сравнивает ISO-строки лексикографически: для UTC-формата
 * `YYYY-MM-DDTHH:MM:SS.sssZ` это эквивалентно хронологическому порядку,
 * а объекты `Date` в параметрах запрещены (SDK превратил бы их в epoch-секунды).
 */

import { db, sql } from 'sdk/db';
import type { MessageRole, MessageRow } from '../../types.js';
import { nowIso } from '../utils.js';

const DEFAULT_HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Строка БД → доменная модель
// ---------------------------------------------------------------------------

/** Сырая строка `messages` (snake_case, как лежит в SQLite). */
interface MessageDbRow {
  id: number;
  user_id: number;
  role: string;
  content: string;
  meta: string | null;
  created_at: string | null;
}

/** json-колонка `meta` → объект; битый json / не объект → `{}`. */
function parseMeta(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapMessage(row: MessageDbRow): MessageRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    role: row.role as MessageRole,
    content: row.content,
    meta: parseMeta(row.meta),
    createdAt: row.created_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

/** Добавляет реплику в историю диалога; `meta` по умолчанию — `{}`. */
export async function appendMessage(
  userId: number,
  role: MessageRole,
  content: string,
  meta?: Record<string, unknown>,
): Promise<MessageRow> {
  const result = await db.run(sql`
    INSERT INTO messages (user_id, role, content, meta, created_at)
    VALUES (${userId}, ${role}, ${content}, ${JSON.stringify(meta ?? {})}, ${nowIso()})
    RETURNING id, user_id, role, content, meta, created_at
  `);

  const row = result.rows[0] as unknown as MessageDbRow | undefined;
  if (!row) throw new Error('inbox.appendMessage: insert returned no row');
  return mapMessage(row);
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

/** История пользователя, новые сверху (`created_at DESC, id DESC`). */
export async function getHistory(
  userId: number,
  limit: number = DEFAULT_HISTORY_LIMIT,
  offset: number = 0,
): Promise<MessageRow[]> {
  const safeLimit = Math.max(0, Math.trunc(limit));
  const safeOffset = Math.max(0, Math.trunc(offset));
  if (safeLimit === 0) return [];

  const rows = await db.all<MessageDbRow>(sql`
    SELECT id, user_id, role, content, meta, created_at
    FROM messages
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `);
  return rows.map(mapMessage);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Удаляет сообщения пользователя старше `cutoffIso` (строго `<`).
 * Возвращает число удалённых строк.
 */
export async function deleteOlderThan(userId: number, cutoffIso: string): Promise<number> {
  const result = await db.run(sql`
    DELETE FROM messages
    WHERE user_id = ${userId} AND created_at < ${cutoffIso}
  `);
  return result.rowsAffected;
}
