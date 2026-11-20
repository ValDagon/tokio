/**
 * DAL `src/lib/dal/agentState.ts` — тред ReAct-агента (`agent_state`).
 *
 * Что проверяем (SPEC §3 T11, §2.4):
 *  1) изоляцию по `user_id`: у каждого пользователя свой тред, и запись одного
 *     не задевает другого;
 *  2) идемпотентность `ensureAgentState`: строка создаётся один раз, повторный
 *     вызов не сбрасывает уже накопленную историю;
 *  3) roundtrip `saveThread`/`loadThread` вместе с `meta` шага (вызовы тулз);
 *  4) `appendMessages` дописывает в конец (read-merge-write) и ничего не делает
 *     на пустом списке;
 *  5) битый JSON (обрезанная запись после падения) читается как пустая история,
 *     а не роняет агент;
 *  6) кодирование: `thread` лежит в БД json-строкой, `updated_at` — ISO-строкой
 *     (проверяется сырым SELECT'ом).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, sql } from 'sdk/db';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  appendMessages,
  clearThread,
  ensureAgentState,
  getAgentState,
  loadThread,
  parseThread,
  saveThread,
  serializeThread,
} from '../../src/lib/dal/agentState';
import type { AgentMessage } from '../../src/types';

const USER_A = 101;
const USER_B = 202;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

/** Сырая строка `agent_state` — чтобы видеть, что реально лежит в БД. */
async function rawState(userId: number): Promise<Record<string, unknown> | null> {
  return db.get<Record<string, unknown>>(sql`
    SELECT user_id, thread, updated_at
      FROM agent_state
     WHERE user_id = ${userId}
     LIMIT 1
  `);
}

const threadOf = (...contents: string[]): AgentMessage[] =>
  contents.map((content, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
  }));

describe('parseThread / serializeThread', () => {
  it('переживает битый JSON и мусор внутри массива', () => {
    expect(parseThread(null)).toEqual([]);
    expect(parseThread('')).toEqual([]);
    expect(parseThread('{"not":"array"}')).toEqual([]);
    expect(parseThread('[{"role":"user","content":"привет"')).toEqual([]);
  });

  it('сохраняет метаданные шага и выбрасывает неизвестные роли', () => {
    const parsed = parseThread(
      JSON.stringify([
        { role: 'user', content: 'Поставь задачу' },
        { role: 'assistant', content: 'Action: add_task', meta: { toolCalls: [{ id: 'c1', name: 'add_task' }] } },
        { role: 'wizard', content: 'магия' },
        { role: 'assistant', content: 42 },
      ]),
    );

    expect(parsed).toEqual([
      { role: 'user', content: 'Поставь задачу' },
      {
        role: 'assistant',
        content: 'Action: add_task',
        meta: { toolCalls: [{ id: 'c1', name: 'add_task' }] },
      },
    ]);
  });

  it('сериализует пустое и невалидное как `[]`', () => {
    expect(serializeThread(null)).toBe('[]');
    expect(serializeThread([])).toBe('[]');
    expect(serializeThread(threadOf('привет'))).toBe(
      '[{"role":"user","content":"привет"}]',
    );
  });
});

describe('ensureAgentState', () => {
  it('создаёт пустой тред и повторно его не сбрасывает', async () => {
    const created = await ensureAgentState(USER_A);
    expect(created.thread).toEqual([]);

    await saveThread(USER_A, threadOf('привет'));
    const again = await ensureAgentState(USER_A);

    expect(again.thread).toEqual(threadOf('привет'));
    expect(again.userId).toBe(USER_A);
  });

  it('пишет thread json-строкой и updated_at ISO-строкой', async () => {
    await ensureAgentState(USER_A);
    const raw = await rawState(USER_A);

    expect(raw?.thread).toBe('[]');
    expect(String(raw?.updated_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('saveThread / loadThread', () => {
  it('сохраняет и читает тред вместе с метаданными', async () => {
    const thread: AgentMessage[] = [
      { role: 'user', content: 'Поставь задачу' },
      {
        role: 'assistant',
        content: 'Thought: запишу\nAction: add_task',
        meta: {
          toolCalls: [
            {
              id: 'c1',
              name: 'add_task',
              args: { title: 'Отчёт' },
              extraContent: { google: { thought_signature: 'sig-1' } },
            },
          ],
        },
      },
      {
        role: 'user',
        content: 'Задача создана.',
        meta: { toolResult: { id: 'c1', name: 'add_task', ok: true } },
      },
    ];

    await saveThread(USER_A, thread);

    expect(await loadThread(USER_A)).toEqual(thread);
    const raw = await rawState(USER_A);
    expect(typeof raw?.thread).toBe('string');
    expect(raw?.thread).toContain('"toolCalls"');
  });

  it('держит пользователей отдельно', async () => {
    await saveThread(USER_A, threadOf('тред A'));
    await saveThread(USER_B, threadOf('тред B'));

    expect(await loadThread(USER_A)).toEqual(threadOf('тред A'));
    expect(await loadThread(USER_B)).toEqual(threadOf('тред B'));
  });

  it('перезаписывает тред целиком, а не дописывает', async () => {
    await saveThread(USER_A, threadOf('первый', 'ответ'));
    await saveThread(USER_A, threadOf('второй'));

    expect(await loadThread(USER_A)).toEqual(threadOf('второй'));
  });

  it('не читает строку несуществующего пользователя', async () => {
    await saveThread(USER_A, threadOf('тред A'));

    expect(await getAgentState(USER_B)).toBeNull();
    expect(await loadThread(USER_B)).toEqual([]);
  });

  it('бросает на невалидном user_id', async () => {
    await expect(loadThread(0)).rejects.toThrow(/invalid user_id/);
    await expect(saveThread(1.5, [])).rejects.toThrow(/invalid user_id/);
  });
});

describe('appendMessages', () => {
  it('дописывает в конец существующего треда', async () => {
    await saveThread(USER_A, threadOf('первый'));
    const updated = await appendMessages(USER_A, [{ role: 'assistant', content: 'ответ' }]);

    expect(updated.thread).toEqual([
      { role: 'user', content: 'первый' },
      { role: 'assistant', content: 'ответ' },
    ]);
    expect(await loadThread(USER_A)).toEqual(updated.thread);
  });

  it('создаёт строку при первом обращении', async () => {
    const updated = await appendMessages(USER_A, [{ role: 'user', content: 'привет' }]);
    expect(updated.thread).toEqual([{ role: 'user', content: 'привет' }]);
  });

  it('на пустом списке ничего не меняет', async () => {
    await saveThread(USER_A, threadOf('привет'));
    const before = await getAgentState(USER_A);

    const after = await appendMessages(USER_A, []);

    expect(after.thread).toEqual(before?.thread);
    expect(after.updatedAt).toBe(before?.updatedAt);
  });
});

describe('clearThread', () => {
  it('обнуляет тред и сообщает, была ли строка', async () => {
    await saveThread(USER_A, threadOf('привет'));

    expect(await clearThread(USER_A)).toBe(true);
    expect(await loadThread(USER_A)).toEqual([]);
    expect(await clearThread(USER_B)).toBe(false);
  });

  it('не трогает тред другого пользователя', async () => {
    await saveThread(USER_A, threadOf('тред A'));
    await saveThread(USER_B, threadOf('тред B'));

    await clearThread(USER_A);

    expect(await loadThread(USER_B)).toEqual(threadOf('тред B'));
  });
});
