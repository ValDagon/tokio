/**
 * Тулзы агента: дневник рефлексии (PLAN-AGENT-FIRST T2).
 *
 * Держим инварианты тулз:
 *  - `read_daily_diary` ничего не пишет: если записи нет, отдаёт шаблон за день
 *    и помечает, что запись ещё не создана; сохранённую запись возвращает как есть;
 *  - `append_reflection` дописывает запись с меткой времени и, если передан,
 *    уровень энергии;
 *  - пустой текст рефлексии — `ok:false`, а не исключение;
 *  - дневник каждого пользователя изолирован.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { diaryTools } from '../../../src/lib/agent/tools/diary';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import { ensureUser, updateUser } from '../../../src/lib/dal/users';
import { diaryStorageKey } from '../../../src/lib/diary';
import { kvGet } from '../../../src/lib/dal/misc';

const USER_A = 1;
const USER_B = 2;

/** Фиксированный момент: 15 марта, 11:00 по Белграду. */
const NOW = new Date('2026-03-15T10:00:00.000Z');

const CTX_A: ToolContext = {
  userId: USER_A,
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  now: NOW,
};

function contextFor(userId: number): ToolContext {
  return { ...CTX_A, userId };
}

function toolByName(name: string): Tool {
  const found = diaryTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`тулза ${name} не зарегистрирована в diaryTools`);
  return found;
}

async function run(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = CTX_A,
): Promise<ToolOutcome> {
  const outcome = await toolByName(name).run(args, ctx);
  return typeof outcome === 'string' ? { ok: true, content: outcome } : outcome;
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
  await updateUser(USER_A, { timezone: 'Europe/Belgrade' });
  await updateUser(USER_B, { timezone: 'Europe/Belgrade' });
});

// ---------------------------------------------------------------------------
// read_daily_diary
// ---------------------------------------------------------------------------

describe('read_daily_diary', () => {
  it('отдаёт шаблон за сегодня и ничего не пишет, пока записи нет', async () => {
    const outcome = await run('read_daily_diary', {});

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('# Дневник: 2026-03-15');
    expect(outcome.content).toContain('уровень энергии');
    expect(outcome.content).toContain('ещё не создан');
    expect(outcome.data).toMatchObject({ date: '2026-03-15', created: false, persisted: false });

    expect(await kvGet(diaryStorageKey(USER_A, '2026-03-15'))).toBeNull();
  });

  it('второе чтение возвращает сохранённую запись, а не шаблон', async () => {
    await run('read_daily_diary', {});
    await run('append_reflection', { text: 'Спокойный день.' });

    const again = await run('read_daily_diary', {});

    expect(again.ok).toBe(true);
    expect(again.content).toContain('Спокойный день.');
    expect(again.data).toMatchObject({ created: false });
  });

  it('читает заданную дату, не создавая запись, и не показывает чужие дневники', async () => {
    const before = await run('read_daily_diary', { date: '2026-03-01' });

    expect(before.content).toContain('# Дневник: 2026-03-01');
    expect(await kvGet(diaryStorageKey(USER_A, '2026-03-01'))).toBeNull();

    await run('append_reflection', { text: 'Запись А', date: '2026-03-01' });

    const other = await run('read_daily_diary', {}, contextFor(USER_B));

    expect(other.content).not.toContain('Запись А');
    expect(await kvGet(diaryStorageKey(USER_A, '2026-03-01'))).toContain('# Дневник: 2026-03-01');
  });
});

// ---------------------------------------------------------------------------
// append_reflection
// ---------------------------------------------------------------------------

describe('append_reflection', () => {
  it('дописывает рефлексию с меткой времени и уровнем энергии', async () => {
    const outcome = await run('append_reflection', {
      text: 'Сделал главное до обеда.',
      energy: 7,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe('Записал в дневник за 2026-03-15.');

    const stored = await kvGet(diaryStorageKey(USER_A, '2026-03-15'));
    expect(stored).toContain('**[11:00]** Сделал главное до обеда.');
    expect(stored).toContain('**Уровень энергии (1–10):** 7');
  });

  it('без текста отвечает ok:false и не создаёт дневник', async () => {
    const outcome = await run('append_reflection', { text: '   ' });

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('text');
    expect(await kvGet(diaryStorageKey(USER_A, '2026-03-15'))).toBeNull();
  });
});
