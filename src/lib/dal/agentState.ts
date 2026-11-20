/**
 * DAL `agent_state` — thread диалога ReAct-агента (SPEC §3 T11, §2.4).
 *
 * Заменяет Postgres-чекпоинты LangGraph из upstream: там состояние треда жило
 * в служебных таблицах `checkpoints*`, здесь — одна строка на пользователя и
 * json-массив сообщений в колонке `thread`.
 *
 * Инварианты:
 *  - `user_id` — натуральный PK (telegram id), отдельного autoincrement-id нет,
 *    поэтому и `created_at` нет: строка создаётся при первом обращении
 *    (`ensureAgentState`) и дальше только переписывается;
 *  - изоляция: каждый запрос фильтруется по `user_id`; чужой тред не читается
 *    и не перезаписывается даже при совпадении содержимого;
 *  - содержимое треда — данные, а не код: битый JSON (обрезанная запись после
 *    падения процесса) не роняет агент, а трактуется как пустая история;
 *  - запись идёт целиком (`thread` — одна json-колонка), read-merge-write для
 *    элементов массива на платформе невозможен; `updated_at` ставит DAL.
 *
 * Кодирование значений (SPEC §2.4): даты — только ISO-строки (`nowIso()`),
 * json — только строкой, `undefined` в параметры не попадает.
 */

import { db, sql } from 'sdk/db';
import type { AgentMessage, AgentStateRow, MessageRole } from '../../types.js';
import { nowIso } from '../utils.js';

/** Полный список колонок `agent_state` — в одном месте, чтобы не разъезжались SELECT'ы. */
const STATE_COLUMNS = `user_id, thread, updated_at`;

// ---------------------------------------------------------------------------
// Строка БД ↔ доменный объект
// ---------------------------------------------------------------------------

interface AgentStateDbRow {
  user_id: number;
  thread: string | null;
  updated_at: string | null;
}

const ROLES = new Set<string>(['user', 'assistant', 'system']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Разбор json-массива сообщений. Всё, что не похоже на сообщение, выбрасывается:
 * тред — это история диалога, а не свалка произвольных объектов.
 */
export function parseThread(raw: string | null | undefined): AgentMessage[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const messages: AgentMessage[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const role = typeof entry.role === 'string' ? entry.role : '';
    if (!ROLES.has(role) || typeof entry.content !== 'string') continue;
    const message: AgentMessage = { role: role as MessageRole, content: entry.content };
    if (isRecord(entry.meta)) message.meta = { ...entry.meta };
    messages.push(message);
  }
  return messages;
}

/** Сериализация треда в json-строку колонки `thread`. */
export function serializeThread(thread: readonly AgentMessage[] | null | undefined): string {
  const source = Array.isArray(thread) ? thread : [];
  const normalized = source
    .filter(
      (message): message is AgentMessage =>
        isRecord(message) &&
        typeof message.role === 'string' &&
        ROLES.has(message.role) &&
        typeof message.content === 'string',
    )
    .map((message) => {
      const clean: AgentMessage = { role: message.role, content: message.content };
      if (isRecord(message.meta)) clean.meta = { ...message.meta };
      return clean;
    });
  return JSON.stringify(normalized);
}

function mapState(row: AgentStateDbRow): AgentStateRow {
  return {
    userId: Number(row.user_id),
    thread: parseThread(row.thread),
    updatedAt: row.updated_at ?? null,
  };
}

function assertUserId(userId: number): number {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`agent_state: invalid user_id "${String(userId)}"`);
  }
  return userId;
}

// ---------------------------------------------------------------------------
// Чтение и запись
// ---------------------------------------------------------------------------

/** Состояние агента пользователя; `null`, если строки ещё нет. */
export async function getAgentState(userId: number): Promise<AgentStateRow | null> {
  const row = await db.get<AgentStateDbRow>(sql`
    SELECT ${sql.raw(STATE_COLUMNS)}
      FROM agent_state
     WHERE user_id = ${assertUserId(userId)}
     LIMIT 1
  `);
  return row ? mapState(row) : null;
}

/** Тред пользователя; пустой массив, если строки нет или json битый. */
export async function loadThread(userId: number): Promise<AgentMessage[]> {
  const state = await getAgentState(userId);
  return state ? state.thread : [];
}

/** Создаёт строку при первом обращении; существующую не трогает (идемпотентно). */
export async function ensureAgentState(userId: number): Promise<AgentStateRow> {
  const id = assertUserId(userId);
  const now = nowIso();
  await db.run(sql`
    INSERT INTO agent_state (user_id, thread, updated_at)
    VALUES (${id}, ${'[]'}, ${now})
    ON CONFLICT(user_id) DO NOTHING
  `);
  const state = await getAgentState(id);
  if (!state) throw new Error(`agent_state.ensureAgentState: row for user ${id} is missing`);
  return state;
}

/** Полная перезапись треда (агент сохраняет историю после прогона). */
export async function saveThread(
  userId: number,
  thread: readonly AgentMessage[] | null | undefined,
): Promise<AgentStateRow> {
  const id = assertUserId(userId);
  const payload = serializeThread(thread);
  const now = nowIso();
  const result = await db.run(sql`
    INSERT INTO agent_state (user_id, thread, updated_at)
    VALUES (${id}, ${payload}, ${now})
    ON CONFLICT(user_id) DO UPDATE SET
      thread = excluded.thread,
      updated_at = excluded.updated_at
    RETURNING ${sql.raw(STATE_COLUMNS)}
  `);

  const row = result.rows[0] as unknown as AgentStateDbRow | undefined;
  if (!row) throw new Error(`agent_state.saveThread: upsert returned no row for user ${id}`);
  return mapState(row);
}

/**
 * Дописывает сообщения в конец треда (read-merge-write: колонка одна, поэтому
 * операция атомарна на уровне строки, но не на уровне отдельного сообщения —
 * параллельные прогоны одного пользователя сериализует движок).
 */
export async function appendMessages(
  userId: number,
  messages: readonly AgentMessage[] | null | undefined,
): Promise<AgentStateRow> {
  const id = assertUserId(userId);
  const incoming = Array.isArray(messages) ? messages : [];
  if (incoming.length === 0) return (await getAgentState(id)) ?? ensureAgentState(id);

  const current = await loadThread(id);
  return saveThread(id, [...current, ...incoming]);
}

/** Очищает тред (автовосстановление после испорченной истории). `true`, если строка была. */
export async function clearThread(userId: number): Promise<boolean> {
  const id = assertUserId(userId);
  const result = await db.run(sql`
    UPDATE agent_state
       SET thread = ${'[]'},
           updated_at = ${nowIso()}
     WHERE user_id = ${id}
  `);
  return result.rowsAffected > 0;
}
