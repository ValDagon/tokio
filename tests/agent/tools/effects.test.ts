/**
 * Классификация эффектов тулз и гейт подтверждения (PLAN-AGENT-WRITE-GUARD T1).
 *
 * Инцидент 22.11.2026: на «Привет» бот унёс заметку в корзину, потому что класс
 * эффекта объявлялся только у двух тулз из 39 — и даже этот флаг терялся в
 * `defineTool`. Здесь держим инварианты, которые делают класс обязательным и
 * проверяемым по поведению, а не по имени тулзы:
 *
 *  - у каждой тулзы валидный `effect`, и `requiresConfirmation` выводится из него;
 *  - подтверждения требуют ровно пять тулз: безвозвратные одиночные удаления и
 *    массовые сносы (`bulk`); удаления в корзину — нет;
 *  - `READ_ONLY_TOOL_NAMES` совпадает с классом `read` в обе стороны;
 *  - ни одна read-тулза не меняет строк данных владельца (кэш эмбеддинга —
 *    производная чтения, а не защищаемое состояние; отдельно доказано, что
 *    чтение дневника не создаёт запись);
 *  - заявленная непоправимость правдива: `delete_liability` стирает строку,
 *    `delete_note`/`delete_task` уносят её в корзину, `undo_last_transaction`
 *    возвращает баланс, `reset_finance_history`/`clear_trash` сносят всё класса.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getSqlite, resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { agentTools } from '../../../src/lib/agent/tools';
import {
  requiresConfirmation,
  type Tool,
  type ToolContext,
  type ToolOutcome,
} from '../../../src/lib/agent/registry';
import { READ_ONLY_TOOL_NAMES } from '../../../src/lib/agent/engine';
import { createNote } from '../../../src/lib/dal/notes';
import { createTask } from '../../../src/lib/dal/tasks';
import {
  createAccount,
  createLiability,
  getAccount,
} from '../../../src/lib/dal/finances';
import { createMedication } from '../../../src/lib/dal/medications';
import { ensureUser } from '../../../src/lib/dal/users';

const USER_A = 1;
const USER_B = 2;

/** Фиксированный момент: 15 марта, 11:00 по Белграду. */
const NOW = new Date('2026-03-15T10:00:00.000Z');

const CTX: ToolContext = {
  userId: USER_A,
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  now: NOW,
};

const GATED_TOOLS = [
  'clear_trash',
  'delete_account',
  'delete_liability',
  'delete_medication',
  'reset_finance_history',
];

function toolByName(name: string): Tool {
  const found = agentTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`тулза ${name} не найдена в реестре`);
  return found;
}

async function run(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const outcome = await toolByName(name).run(args, CTX);
  return typeof outcome === 'string' ? { ok: true, content: outcome } : outcome;
}

// ---------------------------------------------------------------------------
// Снимки базы: строки по таблицам и содержимое kv
// ---------------------------------------------------------------------------

function tableNames(): string[] {
  const rows = getSqlite()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function countRows(table: string, where = '1 = 1'): number {
  const row = getSqlite().prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get() as {
    n: number;
  };
  return row.n;
}

/** Сколько строк в каждой таблице — данные владельца без производных кэшей. */
function rowCounts(): Record<string, number> {
  const data: Record<string, number> = {};
  for (const table of tableNames().sort()) data[table] = countRows(table);
  return data;
}

/** Снимок «сколько строк в каждой таблице + что лежит в kv». */
function snapshot(): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const table of tableNames().sort()) {
    data[table] = countRows(table);
  }
  if (tableNames().includes('kv')) {
    data.kv = getSqlite().prepare('SELECT * FROM kv ORDER BY key').all();
  }
  return data;
}

async function seedData(): Promise<void> {
  await createNote(USER_A, 'Я оплатил mtel c Freedom');
  await createTask(USER_A, { title: 'Позвонить в банк' });
  await createLiability(USER_A, { name: 'Тестовый долг', currency: 'EUR', amountCents: 100_00 });
  await createMedication(USER_A, { name: 'Магний', times: ['09:00'], stockCount: 10 });
  await createAccount(USER_A, { name: 'Main', currency: 'EUR', initialBalanceCents: 100_00 });
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
});

// ---------------------------------------------------------------------------
// Классификация и политика подтверждения
// ---------------------------------------------------------------------------

describe('классификация эффектов', () => {
  it('у каждой тулзы валидный effect', () => {
    expect(agentTools.length).toBe(56);
    for (const tool of agentTools) {
      expect({ tool: tool.name, kind: tool.effect.kind }).toEqual({
        tool: tool.name,
        kind: expect.stringMatching(/^(read|create|mutate|destroy)$/),
      });
      if (tool.effect.recovery !== undefined) {
        expect({ tool: tool.name, ok: ['trash', 'undo'].includes(tool.effect.recovery) }).toEqual({
          tool: tool.name,
          ok: true,
        });
      }
      if (tool.effect.bulk !== undefined) {
        expect({ tool: tool.name, bulk: typeof tool.effect.bulk }).toEqual({
          tool: tool.name,
          bulk: 'boolean',
        });
      }
    }
  });

  it('подтверждение требуется только необратимым и массовым удалениям', () => {
    expect(requiresConfirmation({ kind: 'read' })).toBe(false);
    expect(requiresConfirmation({ kind: 'create' })).toBe(false);
    expect(requiresConfirmation({ kind: 'create', bulk: true })).toBe(false);
    expect(requiresConfirmation({ kind: 'mutate' })).toBe(false);
    expect(requiresConfirmation({ kind: 'destroy', recovery: 'trash' })).toBe(false);
    expect(requiresConfirmation({ kind: 'destroy', recovery: 'undo' })).toBe(false);
    expect(requiresConfirmation({ kind: 'destroy' })).toBe(true);
    expect(requiresConfirmation({ kind: 'destroy', bulk: true })).toBe(true);
    expect(requiresConfirmation({ kind: 'destroy', recovery: 'trash', bulk: true })).toBe(true);
  });

  it('в реестре ровно пять тулз с подтверждением — и это те самые', () => {
    const gated = agentTools
      .filter((tool) => requiresConfirmation(tool.effect))
      .map((tool) => tool.name)
      .sort();
    expect(gated).toEqual(GATED_TOOLS);
  });

  it('READ_ONLY_TOOL_NAMES совпадает с классом read в обе стороны', () => {
    const readNames = agentTools
      .filter((tool) => tool.effect.kind === 'read')
      .map((tool) => tool.name)
      .sort();
    expect(readNames).toEqual([...READ_ONLY_TOOL_NAMES].sort());
    expect(readNames.length).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// read-тулзы ничего не пишут
// ---------------------------------------------------------------------------

describe('read-тулзы не меняют данные', () => {
  it('после каждого прогона строки во всех таблицах идентичны', async () => {
    await seedData();

    for (const tool of agentTools.filter((item) => item.effect.kind === 'read')) {
      const before = rowCounts();
      // Пустые аргументы дают честный отказ там, где нужен параметр; важно, что
      // даже отказ не оставляет следов в данных владельца.
      await Promise.resolve(tool.run({}, CTX));
      expect({ tool: tool.name, after: rowCounts() }).toEqual({
        tool: tool.name,
        after: before,
      });
    }
  });

  it('чтение отсутствующего дневника не создаёт запись (kv пуст)', async () => {
    const before = snapshot();
    const outcome = await run('read_daily_diary', {});

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('ещё не создан');
    expect(snapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Заявленная непоправимость правдива
// ---------------------------------------------------------------------------

describe('destroy: обратимость и безвозвратность', () => {
  it('delete_note уносит заметку в корзину, restore_from_trash возвращает её', async () => {
    await createNote(USER_A, 'Я оплатил mtel c Freedom');
    expect(countRows('notes', 'deleted_at IS NULL')).toBe(1);

    expect(await run('delete_note', { query: 'mtel' })).toMatchObject({ ok: true });

    // Строка не уничтожена — она в корзине: класс `destroy` + recovery `trash`.
    expect(countRows('notes')).toBe(1);
    expect(countRows('notes', 'deleted_at IS NOT NULL')).toBe(1);

    expect(await run('restore_from_trash', { query: 'mtel', item_type: 'note' })).toMatchObject({
      ok: true,
    });
    expect(countRows('notes', 'deleted_at IS NULL')).toBe(1);
  });

  it('delete_task уносит задачу в корзину, restore_from_trash возвращает её', async () => {
    await createTask(USER_A, { title: 'Позвонить в банк' });

    expect(await run('delete_task', { query: 'банк' })).toMatchObject({ ok: true });
    expect(countRows('tasks', 'deleted_at IS NOT NULL')).toBe(1);

    expect(await run('restore_from_trash', { query: 'банк', item_type: 'task' })).toMatchObject({
      ok: true,
    });
    expect(countRows('tasks', 'deleted_at IS NULL')).toBe(1);
  });

  it('delete_liability стирает строку безвозвратно — корзины для неё нет', async () => {
    await createLiability(USER_A, { name: 'Тестовый долг', currency: 'EUR', amountCents: 100_00 });
    expect(countRows('liabilities')).toBe(1);

    expect(await run('delete_liability', { liability_name: 'Тестовый долг' })).toMatchObject({
      ok: true,
    });

    expect(countRows('liabilities')).toBe(0);
    expect(countRows('notes', 'deleted_at IS NOT NULL')).toBe(0);
    expect(countRows('tasks', 'deleted_at IS NOT NULL')).toBe(0);
  });

  it('delete_medication удаляет лекарство из аптечки', async () => {
    await createMedication(USER_A, { name: 'Магний', times: ['09:00'], stockCount: 10 });

    expect(await run('delete_medication', { name: 'Магний' })).toMatchObject({ ok: true });
    expect(countRows('medications')).toBe(0);
  });

  it('reset_finance_history снимает всю историю операций', async () => {
    await seedData();
    await run('add_expense', { amount: '10', account_name: 'Main' });
    await run('add_expense', { amount: '5', account_name: 'Main' });
    expect(countRows('transactions')).toBe(2);

    expect(await run('reset_finance_history', { confirm: true })).toMatchObject({ ok: true });
    expect(countRows('transactions')).toBe(0);
  });

  it('clear_trash безвозвратно чистит и заметки, и задачи', async () => {
    await createNote(USER_A, 'Заметка на снос');
    await createTask(USER_A, { title: 'Задача на снос' });
    await run('delete_note', { query: 'снос' });
    await run('delete_task', { query: 'снос' });
    expect(countRows('notes', 'deleted_at IS NOT NULL')).toBe(1);
    expect(countRows('tasks', 'deleted_at IS NOT NULL')).toBe(1);

    expect(await run('clear_trash', {})).toMatchObject({ ok: true });

    expect(countRows('notes')).toBe(0);
    expect(countRows('tasks')).toBe(0);
  });
});

describe('откат денежной операции восстанавливает баланс', () => {
  it('add_expense → undo_last_transaction возвращает исходный баланс', async () => {
    const account = await createAccount(USER_A, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 100_00,
    });
    expect((await getAccount(USER_A, account.id))?.currentBalanceCents).toBe(100_00);

    expect(await run('add_expense', { amount: '10', account_name: 'Main' })).toMatchObject({
      ok: true,
    });
    expect((await getAccount(USER_A, account.id))?.currentBalanceCents).toBe(90_00);

    expect(await run('undo_last_transaction', { account_name: 'Main' })).toMatchObject({
      ok: true,
    });
    expect((await getAccount(USER_A, account.id))?.currentBalanceCents).toBe(100_00);
    expect(countRows('transactions')).toBe(0);
  });
});
