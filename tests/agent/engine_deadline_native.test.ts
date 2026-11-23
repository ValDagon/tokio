/**
 * Дедлайн на нативном цикле `toolCalls`: частичный батч и пропуск остатка.
 *
 * Зачем: риск №2 ревью 23.11.2026 — «полнота покрытия нативной ветки
 * `tools-skipped`». Живой ход и легаси-ветка были проверены, а вот путь
 * «первый инструмент батча выполнился, бюджет кончился, остальные не зовём»
 * тестами не считался. Здесь проверяется именно он, и проверяется тред:
 *
 *  1. вызов после дедлайна не выполняется (тулза не запускается вовсе);
 *  2. на невыполненный вызов в треде остаётся честное наблюдение `ok: false`;
 *  3. `repairToolPairing` не синтезирует «Действие успешно зафиксировано» —
 *     тред не врёт модели о том, чего не было;
 *  4. причина дедлайна в крошке — `tools-skipped`, а не `budget`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb, sqliteDDL } from '../mocks/sdk';
import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { readTurnTrace } from '../../src/lib/dal/misc';
import { TOOL_RESULT_KEY } from '../../src/lib/agent/sanitize';
import type { Tool } from '../../src/lib/agent/registry';
import { runAgent, type AgentChatFn } from '../../src/lib/agent/engine';

const USER = 707070;
const NOW = new Date('2026-11-23T04:50:00Z');

const PROFILE = { userName: 'Иван', timezone: 'Europe/Belgrade', baseCurrency: 'EUR' };

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('дедлайн на нативном цикле', () => {
  it('инструмент после дедлайна не выполняется, но наблюдение честное', async () => {
    const started = NOW.getTime();
    let elapsed = 0;
    let firstRuns = 0;
    let secondRuns = 0;

    const firstTool: Tool = {
      name: 'write_one',
      effect: { kind: 'create' },
      description: 'Первая запись',
      schema: { type: 'object', properties: {} },
      run: () => {
        firstRuns += 1;
        // Инструмент съел бюджет: до второго вызова батча уже не успеть.
        elapsed = 23_000;
        return 'записано';
      },
    };
    const secondTool: Tool = {
      name: 'write_two',
      effect: { kind: 'create' },
      description: 'Вторая запись',
      schema: { type: 'object', properties: {} },
      run: () => {
        secondRuns += 1;
        return 'записано';
      },
    };

    const chatFn: AgentChatFn = async () => ({
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'write_one', args: {} },
        { id: 'call_2', name: 'write_two', args: {} },
      ],
      model: 'gemini-4-hydrogen',
    });

    const result = await runAgent({
      userId: USER,
      text: 'сделай два дела',
      tools: [firstTool, secondTool],
      profile: PROFILE,
      chatFn,
      now: NOW,
      clock: () => started + elapsed,
      store: null,
    });

    expect(firstRuns).toBe(1);
    expect(secondRuns).toBe(0);
    expect(result.stopReason).toBe('step_limit');
    expect(result.reply).toContain('Не успел всё за один ход');

    const skipped = result.thread.filter(
      (message) =>
        message.role === 'user' && message.content === 'Не выполнено: ход превысил лимит времени.',
    );
    expect(skipped).toHaveLength(1);
    const meta = skipped[0]?.meta?.[TOOL_RESULT_KEY] as
      | { name?: string; ok?: boolean }
      | undefined;
    expect(meta).toMatchObject({ name: 'write_two', ok: false });

    // Парность вызова и наблюдения сохранена, поэтому синтез успеха не срабатывает.
    const fake = result.thread.filter((message) => message.content.includes('успешно зафиксировано'));
    expect(fake).toHaveLength(0);

    const { trace } = await readTurnTrace(USER);
    expect(trace?.deadlineCause).toBe('tools-skipped');
  });
});
