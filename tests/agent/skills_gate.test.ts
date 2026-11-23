/**
 * MU-7/MU-9 (фазы B и D): включение скилла принадлежит только владельцу.
 *
 * Главный инвариант: сгенерированный текст физически не попадает в системный
 * промпт ни в одном состоянии, кроме `active`, и включение видно только
 * следующему прогону. Второй инвариант: у одного ключа никогда не бывает двух
 * активных версий, а бюджет промпта запрещает включение, а не режет текст.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { kvGet, kvSet } from '../../src/lib/dal/misc';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  SKILL_PROMPT_BUDGET,
  activateSkill,
  skillPromptChars,
  addItem,
  buildSkillSpec,
  rejectSkill,
  resolveItem,
  listActiveSkills,
  listItems,
  parseSkillSpec,
} from '../../src/lib/evolution';
import {
  SKILL_BLOCK_PREAMBLE,
  buildSystemPrompt,
  renderSkillBlock,
  type AgentProfile,
} from '../../src/lib/agent/prompts';
import { loadAgentProfile, runAgent } from '../../src/lib/agent/engine';
import type { AgentChatFn } from '../../src/lib/agent/engine';

const USER = 711;
const OTHER = 712;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

function body(tag = 'search_notes'): string {
  return [
    '## When to Use',
    `Когда агент повторяет вызов ${tag} с неверными аргументами.`,
    '',
    '## Procedure',
    '1. Прочитай описание инструмента.',
    '2. Проверь обязательные поля один раз.',
    '3. Вызови инструмент и прочитай наблюдение.',
    '',
    '## Pitfalls',
    '- Не повторять тот же вызов без изменений.',
    '',
    '## Verification',
    '- Вызов вернул данные, в ответе есть результат.',
  ].join('\n');
}

async function makeSkill(options: {
  userId?: number;
  key?: string;
  version?: number;
  originFailure?: string | null;
  supersedes?: number | null;
  text?: string;
}): Promise<number> {
  const item = await addItem(options.userId ?? USER, {
    rawInput: `Сигнатура: ${options.originFailure ?? 'agent|none|tool_error|search_notes'}`,
    title: `Скилл: ${options.key ?? 'agent-tool-error-search-notes'} v${options.version ?? 1}`,
    category: 'skill',
    spec: buildSkillSpec({
      key: options.key ?? 'agent-tool-error-search-notes',
      version: options.version ?? 1,
      originFailure: options.originFailure ?? 'agent|none|tool_error|search_notes',
      supersedes: options.supersedes ?? null,
      body: options.text ?? body(),
    }),
  });
  return item.id;
}

function profileWith(activeSkills: Awaited<ReturnType<typeof listActiveSkills>>): Partial<AgentProfile> {
  return { userName: 'Иван', timezone: 'Europe/Belgrade', baseCurrency: 'EUR', activeSkills };
}

describe('промпт: только active', () => {
  it('pending не попадает в промпт', async () => {
    const id = await makeSkill({});
    expect((await listItems(USER, { status: 'pending' }))[0]?.id).toBe(id);

    const skills = await listActiveSkills(USER);
    expect(skills).toHaveLength(0);

    const prompt = buildSystemPrompt({ profile: profileWith(skills) });
    expect(prompt).not.toContain('БИБЛИОТЕКА ПРОЦЕДУР');
    expect(prompt).not.toContain('Прочитай описание инструмента');
  });

  it('active виден и живёт в отдельном блоке, а не в директивах', async () => {
    const id = await makeSkill({});
    expect((await activateSkill(USER, id)).ok).toBe(true);

    const skills = await listActiveSkills(USER);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe(id);

    const prompt = buildSystemPrompt({
      profile: {
        ...profileWith(skills),
        customInstructions: 'Отвечай коротко.',
      },
    });
    expect(prompt).toContain('БИБЛИОТЕКА ПРОЦЕДУР');
    expect(prompt).toContain('agent-tool-error-search-notes (v1)');
    expect(prompt).toContain('Прочитай описание инструмента');
    // Личные директивы остаются своим блоком и не смешиваются со скиллами.
    expect(prompt).toContain('ВЫСШИЕ ПОЛЬЗОВАТЕЛЬСКИЕ ДИРЕКТИВЫ');
    const skillBlock = renderSkillBlock(skills);
    expect(prompt.indexOf('БИБЛИОТЕКА ПРОЦЕДУР')).toBeLessThan(
      prompt.indexOf('ВЫСШИЕ ПОЛЬЗОВАТЕЛЬСКИЕ ДИРЕКТИВЫ'),
    );
    expect(skillBlock).not.toContain('Отвечай коротко');
  });

  it('rejected не попадает в промпт', async () => {
    const id = await makeSkill({});
    expect((await rejectSkill(USER, id)).ok).toBe(true);

    expect(await listActiveSkills(USER)).toHaveLength(0);
    const prompt = buildSystemPrompt({ profile: profileWith([]) });
    expect(prompt).not.toContain('Прочитай описание инструмента');
  });

  it('повреждённая спека не грузится и не включается', async () => {
    const broken = await addItem(USER, {
      rawInput: 'Сигнатура: agent|none|tool_error|search_notes',
      category: 'skill',
      spec: '{"format":"lifeos.skill.v1","key":"k","version":1,"body":"## When to Use\\nтолько это"}',
    });
    expect((await activateSkill(USER, broken.id)).ok).toBe(false);
    expect(await listActiveSkills(USER)).toHaveLength(0);
  });
});

describe('решение владельца', () => {
  it('включение и отклонение — только для своей строки', async () => {
    const id = await makeSkill({ userId: USER });
    expect((await activateSkill(OTHER, id)).ok).toBe(false);
    expect((await rejectSkill(OTHER, id)).ok).toBe(false);
    expect((await listActiveSkills(OTHER)).length).toBe(0);
  });

  it('запрещённые переходы не меняют статус', async () => {
    const id = await makeSkill({});
    await activateSkill(USER, id);

    // Повторная активация уже включённого — не ошибка состояния, а явный отказ
    expect((await activateSkill(USER, id)).ok).toBe(false);
    // Включённый скилл можно отключить (отклонить)
    expect((await rejectSkill(USER, id)).ok).toBe(true);
    // Повторно отклонить уже отклонённый — отказ
    expect((await rejectSkill(USER, id)).ok).toBe(false);

    const rejection = await makeSkill({ key: 'agent-other', originFailure: 'agent|none|step_limit|-' });
    await rejectSkill(USER, rejection);
    expect((await activateSkill(USER, rejection)).ok).toBe(false);
  });

  it('бюджет промпта запрещает включение, а не обрезает текст', async () => {
    const bigBody = (tag: string, size: number): string => {
      const base = body(tag);
      if (base.length >= size) return base;
      return base.replace('## Pitfalls', `${'w'.repeat(size - base.length - 2)}\n\n## Pitfalls`);
    };

    const first = await makeSkill({ key: 'agent-a', text: bigBody('a', 3900) });
    expect((await activateSkill(USER, first)).ok).toBe(true);

    // Второй скилл тоже по 3 900: вместе они выходят за общий бюджет 6 000.
    const second = await makeSkill({ key: 'agent-b', text: bigBody('b', 3900) });
    const refused = await activateSkill(USER, second);

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain(String(SKILL_PROMPT_BUDGET));
    expect(await listActiveSkills(USER)).toHaveLength(1);

    // Текст не порезан: включённый скилл остался целиком, отклонённый ждёт решения.
    const active = await listActiveSkills(USER);
    expect(active[0]?.body.length).toBe(3900);
    expect((await listItems(USER)).find((item) => item.id === second)?.status).toBe('pending');
  });

  it('скилл длиннее индивидуального лимита включить нельзя', async () => {
    const tooBig = await makeSkill({
      key: 'agent-c',
      text: body().replace('## Pitfalls', `${'w'.repeat(4100)}\n\n## Pitfalls`),
    });
    const result = await activateSkill(USER, tooBig);
    expect(result.ok).toBe(false);
    expect(await listActiveSkills(USER)).toHaveLength(0);
  });

  it('две активные версии одного ключа невозможны', async () => {
    const v1 = await makeSkill({ version: 1 });
    expect((await activateSkill(USER, v1)).ok).toBe(true);

    const v2 = await makeSkill({ version: 2, supersedes: v1 });
    const activated = await activateSkill(USER, v2);
    expect(activated.ok).toBe(true);
    if (activated.ok) expect(activated.item.status).toBe('active');

    const rows = await listItems(USER);
    expect(rows.find((row) => row.id === v1)?.status).toBe('superseded');
    expect(rows.find((row) => row.id === v2)?.status).toBe('active');

    const active = await listActiveSkills(USER);
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(2);
  });

  it('повторная активация прежней версии — ручной откат', async () => {
    const v1 = await makeSkill({ version: 1 });
    await activateSkill(USER, v1);
    const v2 = await makeSkill({ version: 2, supersedes: v1 });
    await activateSkill(USER, v2);

    expect((await activateSkill(USER, v1)).ok).toBe(true);
    const rows = await listItems(USER);
    expect(rows.find((row) => row.id === v1)?.status).toBe('active');
    expect(rows.find((row) => row.id === v2)?.status).toBe('superseded');
    // Оба тела сохранены: история не теряется.
    expect(parseSkillSpec(rows.find((row) => row.id === v2)?.spec ?? null)?.body).toBe(body());
  });

  it('отклонённая ревизия оставляет прежнюю версию включённой', async () => {
    const v1 = await makeSkill({ version: 1 });
    await activateSkill(USER, v1);
    const v2 = await makeSkill({ version: 2, supersedes: v1 });

    expect((await rejectSkill(USER, v2)).ok).toBe(true);
    const active = await listActiveSkills(USER);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(v1);
  });

  it('ожидающая ревизия не меняет промпт', async () => {
    const v1 = await makeSkill({ version: 1, text: body('old') });
    await activateSkill(USER, v1);
    await makeSkill({ version: 2, supersedes: v1, text: body('new') });

    const prompt = buildSystemPrompt({ profile: profileWith(await listActiveSkills(USER)) });
    expect(prompt).toContain(body('old').split('\n')[1] as string);
    expect(prompt).not.toContain(body('new').split('\n')[1] as string);
  });

  it('resolveItem не подменяет активацию: статус ставится только явной командой', async () => {
    const id = await makeSkill({});
    const direct = await resolveItem(USER, id, 'shipped');
    expect(direct?.status).toBe('shipped');
    expect(await listActiveSkills(USER)).toHaveLength(0);
  });
});

describe('заморозка профиля на прогон', () => {
  it('включение посреди прогона видно только следующему прогону', async () => {
    const id = await makeSkill({});
    const prompts: string[] = [];

    const chat: AgentChatFn = async (request) => {
      prompts.push(request.systemPrompt);
      if (prompts.length === 1) {
        // Владелец включает скилл прямо между шагами прогона.
        expect((await activateSkill(USER, id)).ok).toBe(true);
        // Неизвестный инструмент не рвёт прогон — цикл идёт на второй шаг.
        return { content: 'Thought: проверяю\nAction: no_such_tool\nAction Input: {}', toolCalls: [] };
      }
      return { content: 'Final Answer: готово', toolCalls: [] };
    };

    const first = await runAgent({
      userId: USER,
      text: 'сделай что-нибудь',
      profile: profileWith([]),
      store: null,
      chatFn: chat,
    });

    expect(prompts).toHaveLength(2);
    expect(first.appliedSkillIds).toEqual([]);
    // Промпт внутри прогона не менялся: включение не подмешалось на втором шаге.
    for (const prompt of prompts) expect(prompt).not.toContain('БИБЛИОТЕКА ПРОЦЕДУР');

    // А следующий прогон читает профиль заново — скилл уже в промпте.
    let observed = '';
    await runAgent({
      userId: USER,
      text: 'следующий прогон',
      profile: await loadAgentProfile(USER),
      store: null,
      chatFn: async (request) => {
        observed = request.systemPrompt;
        return { content: 'Final Answer: ок', toolCalls: [] };
      },
    });
    expect(observed).toContain('БИБЛИОТЕКА ПРОЦЕДУР');
    expect(observed).toContain('agent-tool-error-search-notes');
  });
});

describe('инварианты активации', () => {
  it('две одновременные активации одного ключа не оставляют две active-строки', async () => {
    const first = await makeSkill({ version: 1, text: body('первая') });
    const second = await makeSkill({ version: 2, text: body('вторая'), supersedes: first });

    const [left, right] = await Promise.all([
      activateSkill(USER, first),
      activateSkill(USER, second),
    ]);

    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);

    const rows = await listItems(USER);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
  });

  it('просроченный claim не блокирует включение навсегда', async () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await kvSet(`skill_activate:v1:${USER}`, stale);

    const id = await makeSkill({});
    const result = await activateSkill(USER, id);
    expect(result.ok).toBe(true);
    expect(await kvGet(`skill_activate:v1:${USER}`)).toBeNull();
  });

  it('бюджет меряет ровно тот текст, который уходит в промпт', async () => {
    const fit = (tag: string, size: number): string => {
      const base = body(tag);
      return base.replace('## Pitfalls', `${'y'.repeat(size - base.length - 2)}\n\n## Pitfalls`);
    };

    const first = await makeSkill({ key: 'agent-a', text: fit('a', 2900) });
    const second = await makeSkill({ key: 'agent-b', text: fit('b', 2900) });
    expect((await activateSkill(USER, first)).ok).toBe(true);
    expect((await activateSkill(USER, second)).ok).toBe(true);

    const active = await listActiveSkills(USER);
    expect(skillPromptChars(active)).toBeLessThanOrEqual(SKILL_PROMPT_BUDGET);
    expect(renderSkillBlock(active).length).toBe(
      SKILL_BLOCK_PREAMBLE.length + 1 + skillPromptChars(active),
    );
  });
});
