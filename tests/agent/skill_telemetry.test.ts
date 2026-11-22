/**
 * MU-8 (фаза C): применение скилла измеряется, а не оценивается моделью.
 *
 * Инварианты:
 *  - один прогон = одно применение, а не по одному на LLM-шаг;
 *  - `pending` не получает применений вообще;
 *  - просмотр текста — отдельный счётчик;
 *  - исход прогона классифицируется конечным набором, а неудачный шаг пишется
 *    как совместное событие, а не как «причина сбоя скилла»;
 *  - счётчик ревизии растёт только при совпадении сигнатуры отказа с исходной;
 *  - сбой телеметрии не меняет результат прогона.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  activateSkill,
  addItem,
  buildSkillSpec,
  listActiveSkills,
  recordSkillRun,
  recordSkillView,
  skillUsage,
  type ActiveSkill,
} from '../../src/lib/evolution';
import { kvGet } from '../../src/lib/dal/misc';
import { loadAgentProfile, runAgent } from '../../src/lib/agent/engine';
import type { AgentChatFn } from '../../src/lib/agent/engine';
import type { AgentProfile } from '../../src/lib/agent/prompts';

const USER = 721;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

const ORIGIN = 'agent|none|tool_error|search_notes';

function body(): string {
  return [
    '## When to Use',
    'Когда агент повторяет вызов инструмента с неверными аргументами.',
    '',
    '## Procedure',
    '1. Прочитай описание инструмента.',
    '2. Проверь обязательные поля.',
    '',
    '## Pitfalls',
    '- Не повторять тот же вызов без изменений.',
    '',
    '## Verification',
    '- Вызов вернул данные.',
  ].join('\n');
}

const SKILL: ActiveSkill = {
  id: 41,
  key: 'agent-tool-error-search-notes',
  version: 1,
  originFailure: ORIGIN,
  body: body(),
};

async function seedActiveSkill(): Promise<number> {
  const item = await addItem(USER, {
    rawInput: `Сигнатура: ${ORIGIN}`,
    title: 'Скилл: agent-tool-error-search-notes v1',
    category: 'skill',
    spec: buildSkillSpec({
      key: 'agent-tool-error-search-notes',
      version: 1,
      originFailure: ORIGIN,
      supersedes: null,
      body: body(),
    }),
  });
  const activated = await activateSkill(USER, item.id);
  expect(activated.ok).toBe(true);
  return item.id;
}

function stepCounter(stop: 'final' | 'step_limit', times: number): AgentChatFn {
  let calls = 0;
  return async () => {
    calls += 1;
    if (stop === 'final' && calls === times) return { content: 'Final Answer: готово', toolCalls: [] };
    return { content: 'Thought: проверяю\nAction: no_such_tool\nAction Input: {}', toolCalls: [] };
  };
}

describe('применение: ровно один раз за прогон', () => {
  it('multi-step прогон даёт один инкремент', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);

    const result = await runAgent({
      userId: USER,
      text: 'сделай что-нибудь',
      profile: { activeSkills: [skill as ActiveSkill] },
      store: null,
      chatFn: stepCounter('final', 3),
    });

    expect(result.steps.length).toBeGreaterThan(1);
    expect(result.appliedSkillIds).toEqual([skillId]);
    expect((await skillUsage(USER, skillId)).uses).toBe(1);
  });

  it('второй прогон — второй инкремент, не больше', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);
    const profile: Partial<AgentProfile> = { activeSkills: [skill as ActiveSkill] };

    for (let i = 0; i < 2; i += 1) {
      await runAgent({
        userId: USER,
        text: 'раз',
        profile,
        store: null,
        chatFn: stepCounter('final', 2),
      });
    }

    expect((await skillUsage(USER, skillId)).uses).toBe(2);
    expect(await kvGet(`skill_run:v1:${USER}:${skillId}`)).toBe('2');
  });

  it('pending не получает применений: его нет в профиле', async () => {
    const pending = await addItem(USER, {
      rawInput: `Сигнатура: ${ORIGIN}`,
      title: 'Скилл: agent-tool-error-search-notes v1',
      category: 'skill',
      spec: buildSkillSpec({
        key: 'agent-tool-error-search-notes',
        version: 1,
        originFailure: ORIGIN,
        supersedes: null,
        body: body(),
      }),
    });
    const profile = await loadAgentProfile(USER);
    expect(profile.activeSkills).toEqual([]);

    const result = await runAgent({
      userId: USER,
      text: 'раз',
      profile,
      store: null,
      chatFn: stepCounter('final', 1),
    });

    expect(result.appliedSkillIds).toEqual([]);
    expect((await skillUsage(USER, pending.id)).uses).toBe(0);
  });
});

describe('исход прогона', () => {
  it('final и confirm считаются финальными', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);

    await recordSkillRun(USER, { skills: [skill as ActiveSkill], stopReason: 'final', steps: [] });
    await recordSkillRun(USER, { skills: [skill as ActiveSkill], stopReason: 'confirm', steps: [] });

    const usage = await skillUsage(USER, skillId);
    expect(usage.final).toBe(2);
    expect(usage.failedSteps).toBe(0);
    expect(usage.llmError).toBe(0);
  });

  it('llm_error и исчерпание шагов классифицируются раздельно', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);

    await recordSkillRun(USER, { skills: [skill as ActiveSkill], stopReason: 'llm_error', steps: [] });
    await recordSkillRun(USER, { skills: [skill as ActiveSkill], stopReason: 'step_limit', steps: [] });

    const usage = await skillUsage(USER, skillId);
    expect(usage.llmError).toBe(1);
    expect(usage.failedSteps).toBe(1);
    expect(usage.final).toBe(0);
    expect(usage.lastUsedAt).toBeTruthy();
  });

  it('неудачный шаг — совместное событие, а не причина сбоя скилла', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);

    await recordSkillRun(USER, {
      skills: [skill as ActiveSkill],
      stopReason: 'step_limit',
      steps: [{ ok: false, action: { name: 'search_notes' } }],
    });

    // Событие лежит под сигнатурой шага рядом с применением.
    expect(await kvGet(`skill_run:v1:${USER}:${skillId}:${ORIGIN}`)).toBe('1');
    // Отдельного «счётчика вины скилла» нет: счётчик ревизии — это совпадение
    // сигнатуры отказа прогона с исходной, и он тоже равен единице.
    expect(await kvGet(`skill_fail:v1:${USER}:${skillId}:${ORIGIN}`)).toBe('1');

    const usage = await skillUsage(USER, skillId);
    expect(usage.uses).toBe(1);
    expect(usage.failedSteps).toBe(1);
  });

  it('чужая сигнатура не увеличивает счётчик ревизии', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);

    await recordSkillRun(USER, {
      skills: [skill as ActiveSkill],
      stopReason: 'step_limit',
      steps: [{ ok: false, action: { name: 'create_task' } }],
    });

    expect(await kvGet(`skill_fail:v1:${USER}:${skillId}:${ORIGIN}`)).toBeNull();
    expect(await kvGet(`skill_run:v1:${USER}:${skillId}:agent|none|tool_error|create_task`)).toBe('1');
  });
});

describe('просмотры и namespace', () => {
  it('просмотр растит только свой счётчик', async () => {
    const skillId = await seedActiveSkill();
    await recordSkillView(USER, skillId);
    await recordSkillView(USER, skillId);

    const usage = await skillUsage(USER, skillId);
    expect(usage.views).toBe(2);
    expect(usage.uses).toBe(0);
    expect(await kvGet(`skill_view:v1:${USER}:${skillId}`)).toBe('2');
  });

  it('ключи версионированы и привязаны к пользователю', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);
    await recordSkillRun(USER, { skills: [skill as ActiveSkill], stopReason: 'final', steps: [] });

    expect(await kvGet(`skill_run:v1:${USER}:${skillId}`)).toBe('1');
    expect(await kvGet(`skill_outcome:v1:${USER}:${skillId}:final`)).toBe('1');
    expect(await kvGet(`skill_last:v1:${USER}:${skillId}`)).toBeTruthy();
    expect(await kvGet(`skill_run:v1:${USER + 1}:${skillId}`)).toBeNull();
  });
});

describe('телеметрия не влияет на прогон', () => {
  it('сбой записи в kv не бросает и не меняет ответ', async () => {
    // Таблиц нет вовсе: любой доступ к `kv` упадёт.
    resetDb();

    await expect(
      recordSkillRun(USER, { skills: [SKILL], stopReason: 'final', steps: [] }),
    ).resolves.toBeUndefined();

    const result = await runAgent({
      userId: USER,
      text: 'раз',
      profile: { activeSkills: [SKILL] },
      store: null,
      chatFn: stepCounter('final', 1),
    });
    expect(result.reply).toBe('готово');
    expect(result.appliedSkillIds).toEqual([SKILL.id]);
  });
});

describe('проводка движка: терминальные причины', () => {
  it('llm_error прогона доходит до телеметрии, а не теряется в цикле', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);

    const result = await runAgent({
      userId: USER,
      text: 'раз',
      profile: { activeSkills: [skill as ActiveSkill] },
      store: null,
      chatFn: async () => {
        throw new Error('provider timeout');
      },
    });

    expect(result.stopReason).toBe('llm_error');
    const usage = await skillUsage(USER, skillId);
    expect(usage.uses).toBe(1);
    expect(usage.llmError).toBe(1);
    expect(usage.lastUsedAt).toBeTruthy();
  });

  it('исчерпание шагов пишется как неудачный прогон с сигнатурой шага', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);

    const result = await runAgent({
      userId: USER,
      text: 'раз',
      profile: { activeSkills: [skill as ActiveSkill] },
      store: null,
      maxSteps: 2,
      chatFn: stepCounter('step_limit', 99),
    });

    expect(result.stopReason).toBe('step_limit');
    const usage = await skillUsage(USER, skillId);
    expect(usage.uses).toBe(1);
    expect(usage.failedSteps).toBe(1);
    expect(await kvGet(`skill_run:v1:${USER}:${skillId}:agent|none|tool_error|no_such_tool`)).toBeTruthy();
  });

  it('дедлайн хода не обвиняет скилл: применения есть, сигнатуры отказа нет', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);

    await recordSkillRun(USER, {
      skills: [skill as ActiveSkill],
      stopReason: 'step_limit',
      steps: [],
      deadline: true,
    });

    const usage = await skillUsage(USER, skillId);
    expect(usage.uses).toBe(1);
    expect(await kvGet(`skill_run:v1:${USER}:${skillId}:agent|none|step_limit|none`)).toBeNull();
  });

  it('дедлайн движка доходит до телеметрии как время, а не как отказ скилла', async () => {
    const skillId = await seedActiveSkill();
    const [skill] = await listActiveSkills(USER);
    let clock = 0;
    const chat: AgentChatFn = async () => {
      // Модель ответила уже за бюджетом хода: инструмент не зовём.
      clock += 21_000;
      return { content: 'Thought: проверяю\nAction: no_such_tool\nAction Input: {}', toolCalls: [] };
    };

    const result = await runAgent({
      userId: USER,
      text: 'разбери инбокс',
      profile: { activeSkills: [skill as ActiveSkill] },
      store: null,
      chatFn: chat,
      clock: () => clock,
    });

    expect(result.stopReason).toBe('step_limit');
    expect((await skillUsage(USER, skillId)).uses).toBe(1);
    expect(await kvGet(`skill_run:v1:${USER}:${skillId}:agent|none|step_limit|none`)).toBeNull();
  });
});
