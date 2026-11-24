/**
 * `src/lib/evolution.ts` — fast-path бэклога авто-эволюции.
 *
 * Два независимых слоя:
 *  - распознавание сообщения регуляркой (0 токенов, поэтому важно, чтобы оно
 *    не срабатывало на обычную болтовню);
 *  - CRUD поверх `evolution_items` (запись, фильтр по статусу, изоляция юзеров).
 *
 * Тесты CRUD работают с настоящей sqlite-схемой из мок-SDK — та же схема, что
 * и в проде, поэтому проверяется и маппинг колонок.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import {
  EVOLUTION_TITLE_LENGTH,
  addFromCommand,
  addItem,
  evolutionCategoryLabel,
  formatEvolutionReply,
  getFailureAggregate,
  getItem,
  handleEvolutionCommand,
  isEvolutionCommand,
  listItems,
  parseEvolutionCommand,
  recordFailure,
  removeItem,
  resolveItem,
  activateSkill,
  buildSkillSpec,
  disableSkill,
  listActiveSkills,
  recordSkillRun,
  rejectSkill,
  reviewSkillDrafts,
  skillKeyFromSignature,
  type ActiveSkill,
  type SkillDraftChatFn,
} from '../src/lib/evolution';
import { activateSkillRevision } from '../src/lib/dal/misc';

const USER_A = 1;
const USER_B = 2;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

// ---------------------------------------------------------------------------
// Распознавание
// ---------------------------------------------------------------------------

describe('parseEvolutionCommand', () => {
  it('разбирает префикс с решёткой и двоеточием', () => {
    const command = parseEvolutionCommand('#идея: добавить экспорт в CSV');
    expect(command).not.toBeNull();
    expect(command?.category).toBe('feature');
    expect(command?.title).toBe('добавить экспорт в CSV');
    expect(command?.rawInput).toBe('#идея: добавить экспорт в CSV');
  });

  it('разбирает длинное тире и дефис', () => {
    expect(parseEvolutionCommand('баг — кнопка не нажимается')?.title).toBe(
      'кнопка не нажимается',
    );
    expect(parseEvolutionCommand('фича - тёмная тема')?.title).toBe('тёмная тема');
  });

  it('латинские триггеры не зависят от регистра', () => {
    const bug = parseEvolutionCommand('Bug: падает на пустом сообщении');
    expect(bug?.category).toBe('bug');
    expect(bug?.title).toBe('падает на пустом сообщении');

    expect(parseEvolutionCommand('IDEA: сводка за неделю')?.category).toBe('feature');
    expect(parseEvolutionCommand('Feature: напоминания')?.category).toBe('feature');
  });

  it('понимает фразы-триггеры', () => {
    expect(parseEvolutionCommand('запиши идею: бэкап заметок')?.title).toBe('бэкап заметок');
    expect(parseEvolutionCommand('сделай в боте поиск по тегам')?.title).toBe(
      'поиск по тегам',
    );
    expect(parseEvolutionCommand('добавь в бот голосовые напоминания')?.title).toBe(
      'голосовые напоминания',
    );
    expect(parseEvolutionCommand('предложение: тёмная тема')?.title).toBe('тёмная тема');
  });

  it('баг определяется по первому слову, остальное — фича', () => {
    expect(parseEvolutionCommand('баг: не приходит сводка')?.category).toBe('bug');
    expect(parseEvolutionCommand('улучшение: быстрее поиск')?.category).toBe('feature');
    expect(parseEvolutionCommand('идея: пароль на мини-апп')?.category).toBe('feature');
  });

  it('в заголовок идёт только первая строка сути', () => {
    const command = parseEvolutionCommand('идея: экспорт в CSV\nчтобы открывать в Excel');
    expect(command?.title).toBe('экспорт в CSV');
    expect(command?.rawInput).toContain('Excel');
  });

  it('заголовок ужимается до 100 символов', () => {
    const long = 'очень длинная идея '.repeat(20).trim();
    const title = parseEvolutionCommand(`идея: ${long}`)?.title ?? '';
    expect(title.length).toBeLessThanOrEqual(EVOLUTION_TITLE_LENGTH);
    expect(title.endsWith('…')).toBe(true);
  });

  it('обычные сообщения не считаются командой', () => {
    expect(parseEvolutionCommand('купи хлеб')).toBeNull();
    expect(parseEvolutionCommand('')).toBeNull();
    expect(parseEvolutionCommand('   ')).toBeNull();
    expect(parseEvolutionCommand('идея')).toBeNull();
    expect(parseEvolutionCommand('баг:')).toBeNull();
    expect(isEvolutionCommand('напомни в 9 утра')).toBe(false);
    expect(isEvolutionCommand('идея: напоминания по расписанию')).toBe(true);
  });

  it('подписи категорий и текст ответа — человекочитаемые', () => {
    expect(evolutionCategoryLabel('bug')).toBe('Баг-репорт');
    expect(evolutionCategoryLabel('feature')).toBe('Идея / Фича');

    const reply = formatEvolutionReply({ category: 'bug', title: 'падает кнопка' });
    expect(reply).toContain('падает кнопка');
    expect(reply).toContain('Баг-репорт');
    expect(reply).not.toContain('**');
  });
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('CRUD бэклога', () => {
  it('addItem подставляет дефолты и пишет raw_input', async () => {
    const item = await addItem(USER_A, { rawInput: 'идея: тёмная тема' });

    expect(item.id).toBeGreaterThan(0);
    expect(item.userId).toBe(USER_A);
    expect(item.category).toBe('feature');
    expect(item.status).toBe('pending');
    expect(item.priority).toBe('medium');
    expect(item.title).toBe('идея: тёмная тема');
    expect(item.rawInput).toBe('идея: тёмная тема');
    expect(item.createdAt).toBeTruthy();
  });

  it('addFromCommand переносит категорию и заголовок из разбора', async () => {
    const command = parseEvolutionCommand('баг: падает экспорт');
    expect(command).not.toBeNull();
    if (!command) return;

    const item = await addFromCommand(USER_A, command, { priority: 'high' });
    expect(item.category).toBe('bug');
    expect(item.title).toBe('падает экспорт');
    expect(item.priority).toBe('high');
    expect(item.rawInput).toBe('баг: падает экспорт');
  });

  it('resolveItem закрывает задачу и сохраняет артефакты', async () => {
    const item = await addItem(USER_A, { rawInput: 'идея: экспорт в CSV' });

    const shipped = await resolveItem(USER_A, item.id, 'shipped', {
      branchName: 'feat/csv-export',
      commitHash: 'abc1234',
    });
    expect(shipped).not.toBeNull();
    expect(shipped?.status).toBe('shipped');
    expect(shipped?.branchName).toBe('feat/csv-export');
    expect(shipped?.commitHash).toBe('abc1234');

    const stored = await getItem(USER_A, item.id);
    expect(stored?.status).toBe('shipped');
    expect(stored?.updatedAt).not.toBeNull();
  });

  it('resolveItem не трогает чужой элемент', async () => {
    const item = await addItem(USER_A, { rawInput: 'идея: приватная' });

    expect(await resolveItem(USER_B, item.id, 'rejected')).toBeNull();
    expect(await getItem(USER_B, item.id)).toBeNull();
    expect((await getItem(USER_A, item.id))?.status).toBe('pending');
  });

  it('listItems сортирует свежие сверху и фильтрует по статусу', async () => {
    const first = await addItem(USER_A, { rawInput: 'идея: первая' });
    const second = await addItem(USER_A, { rawInput: 'идея: вторая' });
    const third = await addItem(USER_A, { rawInput: 'идея: третья' });
    await resolveItem(USER_A, second.id, 'shipped');

    const all = await listItems(USER_A);
    expect(all.map((item) => item.id)).toEqual([third.id, second.id, first.id]);

    const pending = await listItems(USER_A, { status: 'pending' });
    expect(pending.map((item) => item.id)).toEqual([third.id, first.id]);

    expect(await listItems(USER_A, { status: 'pending', limit: 1 })).toHaveLength(1);
  });

  it('listItems изолирован по пользователям', async () => {
    await addItem(USER_A, { rawInput: 'идея: для А' });
    await addItem(USER_B, { rawInput: 'идея: для Б' });

    const forA = await listItems(USER_A);
    expect(forA).toHaveLength(1);
    expect(forA[0]?.rawInput).toBe('идея: для А');
  });

  it('removeItem удаляет только свой элемент', async () => {
    const item = await addItem(USER_A, { rawInput: 'идея: удалить меня' });

    expect(await removeItem(USER_B, item.id)).toBe(false);
    expect(await getItem(USER_A, item.id)).not.toBeNull();

    expect(await removeItem(USER_A, item.id)).toBe(true);
    expect(await getItem(USER_A, item.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Полный fast-path
// ---------------------------------------------------------------------------

describe('handleEvolutionCommand', () => {
  it('распознаёт, записывает и возвращает ответ', async () => {
    const result = await handleEvolutionCommand(USER_A, 'баг: не приходит утренняя сводка');

    expect(result).not.toBeNull();
    expect(result?.command.category).toBe('bug');
    expect(result?.command.title).toBe('не приходит утренняя сводка');
    expect(result?.item.id).toBeGreaterThan(0);
    expect(result?.item.category).toBe('bug');
    expect(result?.reply).toContain('не приходит утренняя сводка');

    const stored = await listItems(USER_A);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(result?.item.id);
  });

  it('обычное сообщение не пишет в бэклог и отдаёт null', async () => {
    expect(await handleEvolutionCommand(USER_A, 'напомни купить хлеб')).toBeNull();
    expect(await listItems(USER_A)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MU-5 — повторяющийся сбой сам становится задачей самодиагностики
// ---------------------------------------------------------------------------

describe('порог самодиагностики', () => {
  const SIGNAL = { stage: 'stt', media: 'voice', reason: 'transcription_failed' } as const;
  const SIGNATURE = 'stt|voice|transcription_failed|-';

  async function repeat(times: number, userId = USER_A): Promise<void> {
    for (let i = 0; i < times; i += 1) await recordFailure(userId, SIGNAL);
  }

  it('два сбоя не создают задачу, третий создаёт ровно одну pending/bug', async () => {
    await repeat(2);
    expect(await listItems(USER_A)).toHaveLength(0);

    await repeat(1);

    const items = await listItems(USER_A);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'bug', status: 'pending', priority: 'high' });

    // В записи — сигнатура и счётчик, а не сырое входящее.
    expect(items[0]?.rawInput).toContain('Сигнатура: stt|voice|transcription_failed|-');
    expect(items[0]?.rawInput).toContain('Повторов: 3');
    expect(items[0]?.rawInput).toContain('/diagnostics');

    // Ссылка на задачу лежит в агрегате кластера.
    const aggregate = await getFailureAggregate(USER_A, SIGNATURE);
    expect(aggregate?.evolutionItemId).toBe(items[0]?.id);
  });

  it('четвёртый сбой не создаёт вторую задачу', async () => {
    await repeat(4);

    const items = await listItems(USER_A);
    expect(items).toHaveLength(1);
    expect((await getFailureAggregate(USER_A, SIGNATURE))?.count).toBe(4);
  });

  it('параллельные сбои создают ровно одну задачу', async () => {
    await Promise.all(Array.from({ length: 8 }, () => recordFailure(USER_A, SIGNAL)));

    expect(await listItems(USER_A)).toHaveLength(1);
    expect((await getFailureAggregate(USER_A, SIGNATURE))?.count).toBe(8);
  });

  it('упавшая вставка снимает claim: следующая неудача создаёт задачу', async () => {
    const realRun = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation(async (query, params) => {
      const text = typeof query === 'string' ? query : query.text;
      if (text.includes('INSERT INTO evolution_items')) throw new Error('insert failed');
      return realRun(query, params);
    });

    await repeat(3);
    expect(await listItems(USER_A)).toHaveLength(0);

    vi.restoreAllMocks();

    await repeat(1);
    expect(await listItems(USER_A)).toHaveLength(1);
  });

  it('потеря ссылки после успешной вставки не создаёт вторую задачу', async () => {
    const realRun = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation(async (query, params) => {
      const text = typeof query === 'string' ? query : query.text;
      const values = Object.values(params ?? {});
      const writesRef = values.some(
        (value) => typeof value === 'string' && value.includes('"itemId"'),
      );
      // Задача уже создана, падает только запись ссылки на неё.
      if (text.includes('INSERT INTO kv') && writesRef) throw new Error('kv write failed');
      return realRun(query, params);
    });

    await repeat(3);
    expect(await listItems(USER_A)).toHaveLength(1);

    vi.restoreAllMocks();

    await repeat(1);
    expect(await listItems(USER_A)).toHaveLength(1);
  });

  it('порог у каждого пользователя свой', async () => {
    await repeat(3, USER_A);
    await repeat(2, USER_B);

    expect(await listItems(USER_A)).toHaveLength(1);
    expect(await listItems(USER_B)).toHaveLength(0);
  });

  it('разные сигнатуры дают разные задачи', async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordFailure(USER_A, { stage: 'stt', reason: 'transcription_failed' });
      await recordFailure(USER_A, { stage: 'agent', reason: 'llm_error' });
    }

    const items = await listItems(USER_A);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.rawInput.includes('agent|none|llm_error|-'))).toContain(true);
    expect(items.map((item) => item.rawInput.includes('stt|none|transcription_failed|-'))).toContain(true);
  });
});

// ---------------------------------------------------------------------------
// Скиллы: ключ, переходы, ревизия (MU-6…MU-9)
// ---------------------------------------------------------------------------

const SKILL_ORIGIN = 'agent|none|tool_error|search_notes';

function skillBody(tag = 'первая'): string {
  return [
    '## When to Use',
    `Когда агент повторяет вызов инструмента (${tag} редакция).`,
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

async function createSkill(options: {
  userId?: number;
  key?: string;
  version?: number;
  body?: string;
  origin?: string;
  supersedes?: number | null;
}): Promise<number> {
  const item = await addItem(options.userId ?? USER_A, {
    rawInput: `Сигнатура: ${options.origin ?? SKILL_ORIGIN}`,
    title: `Скилл: ${options.key ?? 'agent-tool-error-search-notes'} v${options.version ?? 1}`,
    category: 'skill',
    spec: buildSkillSpec({
      key: options.key ?? 'agent-tool-error-search-notes',
      version: options.version ?? 1,
      originFailure: options.origin ?? SKILL_ORIGIN,
      supersedes: options.supersedes ?? null,
      body: options.body ?? skillBody(),
    }),
  });
  return item.id;
}

function failingRun(skill: ActiveSkill): Parameters<typeof recordSkillRun>[1] {
  return {
    skills: [skill],
    stopReason: 'step_limit',
    steps: [{ ok: false, action: { name: 'search_notes' } }],
  };
}

describe('скиллы: ключ и категория', () => {
  it('категория skill имеет человеческую подпись', () => {
    expect(evolutionCategoryLabel('skill')).toContain('Скилл');
  });

  it('ключ кластера стабилен и не содержит свободного текста', () => {
    expect(skillKeyFromSignature(SKILL_ORIGIN)).toBe('agent-tool-error-search-notes');
    expect(skillKeyFromSignature('agent|none|tool_error|-')).toBe('agent-tool-error');
    expect(skillKeyFromSignature('agent|none|step_limit|-')).toBe('agent-step-limit');
    expect(skillKeyFromSignature('мусор')).toBe('agent-other');
  });
});

describe('скиллы: переходы статусов', () => {
  it('pending → active → superseded; rejected не включается', async () => {
    const first = await createSkill({});
    expect((await getItem(USER_A, first))?.status).toBe('pending');
    expect((await activateSkill(USER_A, first)).ok).toBe(true);
    expect((await getItem(USER_A, first))?.status).toBe('active');

    const second = await createSkill({ version: 2, supersedes: first, body: skillBody('вторая') });
    expect((await rejectSkill(USER_A, second)).ok).toBe(true);
    expect((await getItem(USER_A, second))?.status).toBe('rejected');
    expect((await getItem(USER_A, first))?.status).toBe('active');
  });

  it('activateSkillRevision вытесняет только активных соседей и не трогает цель', async () => {
    const first = await createSkill({});
    const second = await createSkill({ version: 2, supersedes: first });
    await activateSkill(USER_A, first);
    await resolveItem(USER_A, second, 'shipped');

    const activated = await activateSkillRevision(USER_A, second, [first, second, 99999]);
    expect(activated?.status).toBe('active');
    expect((await getItem(USER_A, first))?.status).toBe('superseded');
    expect((await getItem(USER_A, second))?.status).toBe('active');
  });
});

describe('скиллы: ревизия после трёх неудачных прогонов', () => {
  it('готовит одну pending-ревизию version=2 и сохраняет прежнюю активной', async () => {
    const first = await createSkill({});
    await activateSkill(USER_A, first);
    const [active] = await listActiveSkills(USER_A);
    expect(active?.version).toBe(1);

    for (let i = 0; i < 3; i += 1) await recordSkillRun(USER_A, failingRun(active as ActiveSkill));

    const chatFn: SkillDraftChatFn = async () => skillBody('ревизия');
    const result = await reviewSkillDrafts(USER_A, { chatFn });
    expect(result.kind).toBe('revision');

    const rows = await listItems(USER_A);
    const revision = rows.find((row) => row.id === result.itemId);
    expect(revision?.status).toBe('pending');
    const spec = revision?.spec ? JSON.parse(revision.spec) : null;
    expect(spec.version).toBe(2);
    expect(spec.supersedes).toBe(first);
    expect(spec.originFailure).toBe(SKILL_ORIGIN);

    // До активации действует прежняя версия — единственная активная.
    const activeRows = rows.filter((row) => row.status === 'active');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.id).toBe(first);
  });

  it('повторный проход не создаёт вторую ревизию', async () => {
    const first = await createSkill({});
    await activateSkill(USER_A, first);
    const [active] = await listActiveSkills(USER_A);
    for (let i = 0; i < 3; i += 1) await recordSkillRun(USER_A, failingRun(active as ActiveSkill));

    let calls = 0;
    const chatFn: SkillDraftChatFn = async () => {
      calls += 1;
      return skillBody('ревизия');
    };
    await reviewSkillDrafts(USER_A, { chatFn });
    const again = await reviewSkillDrafts(USER_A, { chatFn });

    expect(calls).toBe(1);
    expect(again.kind).toBe('none');
    const revisions = (await listItems(USER_A)).filter((row) => {
      const spec = row.spec ? JSON.parse(row.spec) : null;
      return spec?.version === 2;
    });
    expect(revisions).toHaveLength(1);
  });

  it('три неудачных прогона другой сигнатуры ревизию не запускают', async () => {
    const first = await createSkill({});
    await activateSkill(USER_A, first);
    const [active] = await listActiveSkills(USER_A);

    for (let i = 0; i < 3; i += 1) {
      await recordSkillRun(USER_A, {
        skills: [active as ActiveSkill],
        stopReason: 'step_limit',
        steps: [{ ok: false, action: { name: 'create_task' } }],
      });
    }

    let calls = 0;
    const chatFn: SkillDraftChatFn = async () => {
      calls += 1;
      return skillBody('ревизия');
    };
    expect((await reviewSkillDrafts(USER_A, { chatFn })).kind).toBe('none');
    expect(calls).toBe(0);
  });

  it('активация ревизии: новая active, прежняя superseded, оба тела сохранены', async () => {
    const first = await createSkill({ body: skillBody('первая') });
    await activateSkill(USER_A, first);
    const [active] = await listActiveSkills(USER_A);
    for (let i = 0; i < 3; i += 1) await recordSkillRun(USER_A, failingRun(active as ActiveSkill));

    const chatFn: SkillDraftChatFn = async () => skillBody('вторая');
    const revision = await reviewSkillDrafts(USER_A, { chatFn });
    expect(revision.itemId).not.toBeNull();

    expect((await activateSkill(USER_A, revision.itemId as number)).ok).toBe(true);
    const rows = await listItems(USER_A);
    expect(rows.find((row) => row.id === first)?.status).toBe('superseded');
    expect(rows.find((row) => row.id === revision.itemId)?.status).toBe('active');
    expect(JSON.parse(rows.find((row) => row.id === first)?.spec ?? '{}').body).toContain('первая');
    expect(JSON.parse(rows.find((row) => row.id === revision.itemId)?.spec ?? '{}').body).toContain(
      'вторая',
    );
  });

  it('ревизия одного пользователя не влияет на другого', async () => {
    const mine = await createSkill({ userId: USER_A });
    await activateSkill(USER_A, mine);
    const theirs = await createSkill({ userId: USER_B });
    await activateSkill(USER_B, theirs);

    const [active] = await listActiveSkills(USER_A);
    for (let i = 0; i < 3; i += 1) await recordSkillRun(USER_A, failingRun(active as ActiveSkill));
    await reviewSkillDrafts(USER_A, { chatFn: async () => skillBody('ревизия') });

    const otherRows = await listItems(USER_B);
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.id).toBe(theirs);
    expect(otherRows[0]?.status).toBe('active');
  });

  it('disableSkill ставит активный скилл на паузу с повторным включением, а rejected остаётся закрытым', async () => {
    const first = await createSkill({ body: skillBody('отключаемый') });
    expect((await activateSkill(USER_A, first)).ok).toBe(true);

    const disabled = await disableSkill(USER_A, first);
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.item.status).toBe('disabled');
    expect(await listActiveSkills(USER_A)).toHaveLength(0);

    // Повторное включение отключённого скилла работает.
    const reactivated = await activateSkill(USER_A, first);
    expect(reactivated.ok).toBe(true);
    expect(await listActiveSkills(USER_A)).toHaveLength(1);

    // Отклонённый скилл по-прежнему не может быть активирован.
    const second = await createSkill({ key: 'rejected-skill', body: skillBody('отклонённый') });
    expect((await rejectSkill(USER_A, second)).ok).toBe(true);
    expect((await activateSkill(USER_A, second)).ok).toBe(false);
  });
});
