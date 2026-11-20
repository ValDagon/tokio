/**
 * DAL `src/lib/dal/inbox.ts` — журнал диалога (`messages`).
 *
 * Таблица — «сырой» ingest: каждая реплика строкой, `meta` — json-объект шага.
 * Проверяем:
 *  - кодирование: `meta` пишется как JSON-строка, читается как объект
 *    (битый json → `{}`), `created_at` — ISO-строка из `nowIso()`;
 *  - порядок выдачи: новые сверху, окно `limit/offset`;
 *  - изоляцию по `user_id` в чтении и в retention-удалении;
 *  - `deleteOlderThan` — строгое `<` по ISO-строке и точное число удалённых.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, sql } from 'sdk/db';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { appendMessage, deleteOlderThan, getHistory } from '../../src/lib/dal/inbox';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

interface RawMessage {
  user_id: number;
  role: string;
  content: string;
  meta: string | null;
  created_at: string | null;
}

async function rawMessage(id: number): Promise<RawMessage | null> {
  return db.get<RawMessage>(sql`
    SELECT user_id, role, content, meta, created_at
      FROM messages WHERE id = ${id}
  `);
}

/** Сырой инсерт с конкретной `created_at` — для проверки окна и retention. */
async function seedMessage(
  userId: number,
  content: string,
  createdAt: string,
  opts: { role?: string; meta?: string } = {},
): Promise<number> {
  const result = await db.run(sql`
    INSERT INTO messages (user_id, role, content, meta, created_at)
    VALUES (${userId}, ${opts.role ?? 'user'}, ${content}, ${opts.meta ?? '{}'}, ${createdAt})
  `);
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe('inbox: appendMessage', () => {
  it('пишет реплику с дефолтным meta', async () => {
    const message = await appendMessage(1, 'user', 'привет');

    expect(message.id).toBeGreaterThan(0);
    expect(message.userId).toBe(1);
    expect(message.role).toBe('user');
    expect(message.content).toBe('привет');
    expect(message.meta).toEqual({});
    expect(message.createdAt).toMatch(ISO);

    const raw = await rawMessage(message.id);
    expect(raw?.meta).toBe('{}');
    expect(raw?.created_at).toMatch(ISO);
  });

  it('сохраняет meta как json-строку и возвращает объектом', async () => {
    const meta = { model: 'glm-4', toolCalls: [{ name: 'notes.list' }], costMicros: 120 };
    const message = await appendMessage(1, 'assistant', 'готово', meta);

    expect(message.meta).toEqual(meta);

    const raw = await rawMessage(message.id);
    expect(typeof raw?.meta).toBe('string');
    expect(JSON.parse(raw?.meta ?? 'null')).toEqual(meta);
  });

  it('сохраняет роль и несколько реплик подряд', async () => {
    const first = await appendMessage(1, 'user', 'первый');
    const second = await appendMessage(1, 'assistant', 'второй');
    const third = await appendMessage(1, 'system', 'третий');

    expect(second.id).toBeGreaterThan(first.id);
    expect(third.id).toBeGreaterThan(second.id);

    const raw = await rawMessage(third.id);
    expect(raw?.role).toBe('system');
    expect(raw?.content).toBe('третий');
    expect(raw?.user_id).toBe(1);
  });

  it('битый json в meta читается как пустой объект', async () => {
    const id = await seedMessage(1, 'мусор', '2026-01-01T00:00:00.000Z', { meta: '{oops' });

    const history = await getHistory(1);
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe(id);
    expect(history[0]?.meta).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

describe('inbox: getHistory', () => {
  it('отдаёт историю новыми сверху', async () => {
    for (let day = 1; day <= 3; day += 1) {
      await seedMessage(1, `msg-0${day}`, `2026-02-0${day}T00:00:00.000Z`);
    }

    const history = await getHistory(1);
    expect(history.map((message) => message.content)).toEqual(['msg-03', 'msg-02', 'msg-01']);
    expect(history.every((message) => message.userId === 1)).toBe(true);
  });

  it('соблюдает окно limit/offset', async () => {
    for (let day = 1; day <= 5; day += 1) {
      await seedMessage(1, `msg-0${day}`, `2026-03-0${day}T00:00:00.000Z`);
    }

    const window = await getHistory(1, 2, 2);
    expect(window.map((message) => message.content)).toEqual(['msg-03', 'msg-02']);

    expect(await getHistory(1, 0)).toEqual([]);
  });

  it('не отдаёт чужие сообщения', async () => {
    await seedMessage(1, 'моё', '2026-04-01T00:00:00.000Z');
    await seedMessage(2, 'чужое', '2026-04-02T00:00:00.000Z');

    const history = await getHistory(1);
    expect(history.map((message) => message.content)).toEqual(['моё']);
    expect(await getHistory(2)).toHaveLength(1);
    expect(await getHistory(3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteOlderThan
// ---------------------------------------------------------------------------

describe('inbox: deleteOlderThan', () => {
  it('удаляет только строки строго старше cutoff и возвращает их число', async () => {
    await seedMessage(1, 'old-1', '2026-01-01T00:00:00.000Z');
    await seedMessage(1, 'old-2', '2026-01-02T00:00:00.000Z');
    await seedMessage(1, 'fresh', '2026-01-03T00:00:00.000Z');

    expect(await deleteOlderThan(1, '2026-01-02T00:00:00.000Z')).toBe(1);

    const left = await getHistory(1);
    expect(left.map((message) => message.content)).toEqual(['fresh', 'old-2']);
  });

  it('не трогает чужие сообщения с той же датой', async () => {
    await seedMessage(1, 'моё старое', '2026-01-01T00:00:00.000Z');
    await seedMessage(2, 'чужое старое', '2026-01-01T00:00:00.000Z');

    expect(await deleteOlderThan(1, '2026-02-01T00:00:00.000Z')).toBe(1);

    expect(await getHistory(1)).toEqual([]);
    expect((await getHistory(2)).map((message) => message.content)).toEqual(['чужое старое']);
  });

  it('ничего не подходит → 0', async () => {
    await seedMessage(1, 'свежее', '2026-05-01T00:00:00.000Z');

    expect(await deleteOlderThan(1, '2026-01-01T00:00:00.000Z')).toBe(0);
    expect(await getHistory(1)).toHaveLength(1);
  });
});
