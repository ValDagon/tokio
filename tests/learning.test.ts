/**
 * Обучение правилам на SQLite (PLAN-AGENT-FIRST T2).
 *
 * Держим контракт MEMORY.md:
 *  - правило живёт в главе `07_custom_instructions`, её читает движок агента
 *    как `customInstructions` (рантайм-зеркало файла MEMORY.md);
 *  - повтор правила (регистр, пробелы, пунктуация) не дублируется;
 *  - хвост «Стиль общения: X» сохраняется при дозаписи;
 *  - `/learn` без правила даёт подсказку, а не пустую запись;
 *  - правила каждого пользователя изолированы.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { CUSTOM_INSTRUCTIONS_SLUG } from '../src/lib/agent/constants';
import { reasoningTools } from '../src/lib/agent/tools/reasoning';
import type { Tool, ToolContext, ToolOutcome } from '../src/lib/agent/registry';
import { createChapter, getChapter } from '../src/lib/dal/docs';
import { ensureUser } from '../src/lib/dal/users';
import {
  LEARN_RULE_MAX_CHARS,
  formatLearnedRuleReply,
  listLearnedRules,
  parseLearnCommand,
  rememberRule,
  ruleKey,
  splitDirectives,
} from '../src/lib/learning';

const USER_A = 1;
const USER_B = 2;

const CTX_A: ToolContext = {
  userId: USER_A,
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  now: new Date('2026-03-15T10:00:00.000Z'),
};

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
});

// ---------------------------------------------------------------------------
// Разбор команды
// ---------------------------------------------------------------------------

describe('parseLearnCommand', () => {
  it('выделяет правило из /learn и русских алиасов', () => {
    expect(parseLearnCommand('/learn не предлагать задачи по воскресеньям')).toBe(
      'не предлагать задачи по воскресеньям',
    );
    expect(parseLearnCommand('/запомни: встречи всегда в Хобби')).toBe('встречи всегда в Хобби');
    expect(parseLearnCommand('/learn@tokio_bot отвечай короче')).toBe('отвечай короче');
  });

  it('без правила или не про обучение — null', () => {
    expect(parseLearnCommand('/learn')).toBeNull();
    expect(parseLearnCommand('/learn   ')).toBeNull();
    expect(parseLearnCommand('просто мысль')).toBeNull();
    expect(parseLearnCommand('')).toBeNull();
  });

  it('длинное правило обрезается до лимита', () => {
    const parsed = parseLearnCommand(`/learn ${'а'.repeat(LEARN_RULE_MAX_CHARS + 50)}`);
    expect(parsed).not.toBeNull();
    expect((parsed ?? '').length).toBeLessThanOrEqual(LEARN_RULE_MAX_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Запись и чтение
// ---------------------------------------------------------------------------

describe('rememberRule', () => {
  it('создаёт главу директив и читает правило движком', async () => {
    const result = await rememberRule(USER_A, 'не предлагать задачи по воскресеньям');

    expect(result).toEqual({ rule: 'не предлагать задачи по воскресеньям', added: true, count: 1 });

    const chapter = await getChapter(USER_A, CUSTOM_INSTRUCTIONS_SLUG);
    expect(chapter?.content).toContain('- не предлагать задачи по воскресеньям');
    expect(chapter?.content).toContain('Стиль общения: mentor');
    expect(chapter?.isPinned).toBe(true);
  });

  it('повтор не дублируется: регистр, пробелы и пунктуация не важны', async () => {
    await rememberRule(USER_A, 'Отвечай коротко.');
    const again = await rememberRule(USER_A, '  отвечай   коротко  ');

    expect(again.added).toBe(false);
    expect(again.count).toBe(1);
    expect(await listLearnedRules(USER_A)).toEqual(['Отвечай коротко.']);
  });

  it('сохраняет существующий стиль общения и правила', async () => {
    await createChapter(USER_A, {
      slug: CUSTOM_INSTRUCTIONS_SLUG,
      title: 'Персональные директивы',
      content: '- старое правило\n\nСтиль общения: calm_partner',
      isPinned: true,
    });

    await rememberRule(USER_A, 'новое правило');

    const chapter = await getChapter(USER_A, CUSTOM_INSTRUCTIONS_SLUG);
    expect(chapter?.content).toBe('- старое правило\n- новое правило\n\nСтиль общения: calm_partner');
    expect(await listLearnedRules(USER_A)).toEqual(['старое правило', 'новое правило']);
  });

  it('правила изолированы по пользователям', async () => {
    await rememberRule(USER_A, 'правило А');

    expect(await listLearnedRules(USER_B)).toEqual([]);
    expect(await getChapter(USER_B, CUSTOM_INSTRUCTIONS_SLUG)).toBeNull();
  });

  it('пустое правило — ошибка, а не пустая запись', async () => {
    await expect(rememberRule(USER_A, '   ')).rejects.toThrow(/empty/);
    expect(await getChapter(USER_A, CUSTOM_INSTRUCTIONS_SLUG)).toBeNull();
  });

  it('ответ в чат честно различает новое и повтор', async () => {
    const first = await rememberRule(USER_A, 'Отвечай коротко');
    expect(formatLearnedRuleReply(first)).toContain('Запомнил');
    const second = await rememberRule(USER_A, 'Отвечай коротко');
    expect(formatLearnedRuleReply(second)).toContain('уже записано');
  });
});

// ---------------------------------------------------------------------------
// Хелперы формата
// ---------------------------------------------------------------------------

describe('формат директив', () => {
  it('splitDirectives отделяет стиль и сохраняет текст правил', () => {
    expect(splitDirectives('- a\n- b\n\nСтиль общения: strategist')).toEqual({
      instructions: '- a\n- b',
      style: 'strategist',
    });
    expect(splitDirectives('- a')).toEqual({ instructions: '- a', style: null });
  });

  it('ruleKey игнорирует маркер пункта и хвостовую пунктуацию', () => {
    expect(ruleKey('- Не предлагать.')).toBe(ruleKey('не предлагать'));
  });
});

// ---------------------------------------------------------------------------
// Тулза агента
// ---------------------------------------------------------------------------

describe('remember_rule (агентская тулза)', () => {
  function toolByName(name: string): Tool {
    const found = reasoningTools.find((tool) => tool.name === name);
    if (!found) throw new Error(`тулза ${name} не зарегистрирована`);
    return found;
  }

  async function run(args: Record<string, unknown>): Promise<ToolOutcome> {
    const outcome = await toolByName('remember_rule').run(args, CTX_A);
    return typeof outcome === 'string' ? { ok: true, content: outcome } : outcome;
  }

  it('записывает правило и возвращает данные для шага', async () => {
    const outcome = await run({ rule: 'встречи всегда вносить в Хобби' });

    expect(outcome.ok).toBe(true);
    expect(outcome.data).toMatchObject({ added: true, count: 1 });
    expect(await listLearnedRules(USER_A)).toEqual(['встречи всегда вносить в Хобби']);
  });

  it('без текста правила отвечает ok:false', async () => {
    const outcome = await run({});

    expect(outcome.ok).toBe(false);
    expect(await getChapter(USER_A, CUSTOM_INSTRUCTIONS_SLUG)).toBeNull();
  });
});
