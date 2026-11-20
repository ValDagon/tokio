/**
 * MU-6 (фаза A): черновик скилла только в `pending`.
 *
 * Фиксируем контракт петли на входе:
 *  - подходящий agent-кластер даёт ровно один вызов модели за касание;
 *  - тело обязано иметь четыре секции в порядке и не превышать лимит;
 *  - медиа- и инфраструктурные кластеры модель не вызывают;
 *  - дедупликация по origin не даёт второго черновика;
 *  - ошибка модели не создаёт строку и не блокирует следующую попытку.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import {
  SKILL_BODY_LIMIT,
  buildSkillSpec,
  getFailureAggregate,
  listItems,
  normalizeSkillBody,
  parseSkillSpec,
  recordFailure,
  reviewSkillDrafts,
  validateSkillBody,
} from '../src/lib/evolution';
import type { SkillDraftChatFn } from '../src/lib/evolution';

const USER = 701;
const OTHER = 702;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

/** Валидное тело: четыре секции в требуемом порядке. */
function body(extra = ''): string {
  return [
    '## When to Use',
    'Когда агент повторяет вызов инструмента с неверными аргументами.',
    '',
    '## Procedure',
    '1. Прочитай описание инструмента и обязательные поля.',
    '2. Сверь аргументы с описанием один раз.',
    '3. Вызови инструмент и проверь наблюдение.',
    extra,
    '',
    '## Pitfalls',
    '- Не повторять тот же вызов без изменений.',
    '',
    '## Verification',
    '- Вызов вернул результат без ошибки, ответ содержит данные.',
  ]
    .filter(Boolean)
    .join('\n');
}

function countingChat(reply: string | (() => string)): { fn: SkillDraftChatFn; calls: string[] } {
  const calls: string[] = [];
  const fn: SkillDraftChatFn = async (request) => {
    calls.push(request.user);
    return typeof reply === 'function' ? reply() : reply;
  };
  return { fn, calls };
}

async function seedToolFailures(
  userId: number,
  tool: string,
  times: number,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await recordFailure(userId, { stage: 'agent', reason: 'tool_error', tool });
  }
}

describe('validateSkillBody', () => {
  it('принимает тело с четырьмя секциями', () => {
    expect(validateSkillBody(body())).toEqual({ ok: true });
  });

  it('требует все четыре секции', () => {
    const withoutPitfalls = body().replace('## Pitfalls', '## Notes');
    const result = validateSkillBody(withoutPitfalls);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Pitfalls');
  });

  it('требует непустую Verification', () => {
    const empty = '## When to Use\nx\n## Procedure\ny\n## Pitfalls\nz\n## Verification\n';
    const result = validateSkillBody(empty);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Verification');
  });

  it('проверяет порядок секций', () => {
    const swapped = [
      '## Procedure',
      '1. шаг',
      '## When to Use',
      'когда',
      '## Pitfalls',
      'нет',
      '## Verification',
      'проверено',
    ].join('\n');
    expect(validateSkillBody(swapped).ok).toBe(false);
  });

  it('отвергает оценочные формулировки', () => {
    for (const word of ['качество ответа выросло', 'стало улучшилось']) {
      const text = body(`Дополнительно: ${word}.`);
      const result = validateSkillBody(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('оценочная');
    }
  });

  it('отвергает тело длиннее лимита, а не обрезает его', () => {
    const long = body('x'.repeat(SKILL_BODY_LIMIT));
    const result = validateSkillBody(long);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(SKILL_BODY_LIMIT));
  });
});

describe('normalizeSkillBody', () => {
  it('снимает обёртку из ``` и предисловие', () => {
    const raw = ['Вот процедура:', '```markdown', body(), '```'].join('\n');
    const normalized = normalizeSkillBody(raw);
    expect(normalized.startsWith('## When to Use')).toBe(true);
    expect(validateSkillBody(normalized).ok).toBe(true);
  });
});

describe('разбор спеки', () => {
  it('читает key/version/originFailure/body', () => {
    const spec = buildSkillSpec({
      key: 'agent-tool-error',
      version: 2,
      originFailure: 'agent|none|tool_error|search_notes',
      supersedes: 11,
      body: body(),
    });
    const parsed = parseSkillSpec(spec);
    expect(parsed?.key).toBe('agent-tool-error');
    expect(parsed?.version).toBe(2);
    expect(parsed?.originFailure).toBe('agent|none|tool_error|search_notes');
    expect(parsed?.supersedes).toBe(11);
    expect(parsed?.body).toContain('## Verification');
  });

  it('чужой формат и мусор — null', () => {
    expect(parseSkillSpec(null)).toBeNull();
    expect(parseSkillSpec('не json')).toBeNull();
    expect(parseSkillSpec(JSON.stringify({ format: 'other', key: 'k', version: 1, body: 'x' }))).toBeNull();
  });
});

describe('reviewSkillDrafts: генерация', () => {
  it('создаёт один pending-черновик и делает один вызов модели', async () => {
    await seedToolFailures(USER, 'search_notes', 3);

    const { fn, calls } = countingChat(body());
    const result = await reviewSkillDrafts(USER, { chatFn: fn });

    expect(result.kind).toBe('draft');
    expect(calls).toHaveLength(1);

    const skills = (await listItems(USER, { status: 'pending' })).filter(
      (item) => item.category === 'skill',
    );
    expect(skills).toHaveLength(1);
    const spec = parseSkillSpec(skills[0]?.spec ?? null);
    expect(spec?.key).toBe('agent-tool-error-search-notes');
    expect(spec?.version).toBe(1);
    expect(spec?.originFailure).toBe('agent|none|tool_error|search_notes');
    expect(spec?.body.length).toBeLessThanOrEqual(SKILL_BODY_LIMIT);
    expect(validateSkillBody(spec?.body ?? '').ok).toBe(true);
  });

  it('в raw_input нет сырого входящего — только сигнатура и счётчик', async () => {
    await seedToolFailures(USER, 'search_notes', 3);
    const { fn } = countingChat(body());
    await reviewSkillDrafts(USER, { chatFn: fn });

    const [draft] = (await listItems(USER)).filter((item) => item.category === 'skill');
    expect(draft?.rawInput).toContain('Сигнатура: agent|none|tool_error|search_notes');
    expect(draft?.rawInput).toContain('Повторов: 3');
    expect(draft?.rawInput).not.toContain('потратил');
  });

  it('второе касание не создаёт второй черновик и не зовёт модель', async () => {
    await seedToolFailures(USER, 'search_notes', 3);
    const first = countingChat(body());
    await reviewSkillDrafts(USER, { chatFn: first.fn });

    const second = countingChat(body('Другой вариант.'));
    const result = await reviewSkillDrafts(USER, { chatFn: second.fn });

    expect(result.kind).toBe('none');
    expect(second.calls).toHaveLength(0);
    const skills = (await listItems(USER)).filter((item) => item.category === 'skill');
    expect(skills).toHaveLength(1);
  });

  it('выбирает самый частый кластер и не более одного за касание', async () => {
    await seedToolFailures(USER, 'search_notes', 3);
    await seedToolFailures(USER, 'create_task', 5);

    const { fn, calls } = countingChat(body());
    await reviewSkillDrafts(USER, { chatFn: fn });

    expect(calls).toHaveLength(1);
    const skills = (await listItems(USER)).filter((item) => item.category === 'skill');
    expect(skills).toHaveLength(1);
    expect(parseSkillSpec(skills[0]?.spec ?? null)?.key).toBe('agent-tool-error-create-task');
  });

  it('невалидный ответ модели не создаёт строку и повторяется на следующем касании', async () => {
    await seedToolFailures(USER, 'search_notes', 3);

    const broken = countingChat('## When to Use\nтолько одна секция');
    const failed = await reviewSkillDrafts(USER, { chatFn: broken.fn });
    expect(failed.kind).toBe('failed');
    expect((await listItems(USER)).filter((item) => item.category === 'skill')).toHaveLength(0);
    expect(
      (await getFailureAggregate(USER, { stage: 'evolution', reason: 'parse_failed' }))?.count,
    ).toBe(1);

    const good = countingChat(body());
    const retried = await reviewSkillDrafts(USER, { chatFn: good.fn });
    expect(retried.kind).toBe('draft');
    expect(good.calls).toHaveLength(1);
  });

  it('сбой модели уходит в журнал и не блокирует следующую попытку', async () => {
    await seedToolFailures(USER, 'search_notes', 3);

    const failing: SkillDraftChatFn = async () => {
      throw new Error('provider timeout');
    };
    const failed = await reviewSkillDrafts(USER, { chatFn: failing });
    expect(failed.kind).toBe('failed');
    expect((await getFailureAggregate(USER, { stage: 'evolution', reason: 'llm_error' }))?.count).toBe(
      1,
    );

    const good = countingChat(body());
    expect((await reviewSkillDrafts(USER, { chatFn: good.fn })).kind).toBe('draft');
  });

  it('тело длиннее лимита моделью не принимается', async () => {
    await seedToolFailures(USER, 'search_notes', 3);
    const { fn } = countingChat(body('y'.repeat(SKILL_BODY_LIMIT)));
    const result = await reviewSkillDrafts(USER, { chatFn: fn });
    expect(result.kind).toBe('failed');
    expect((await listItems(USER)).filter((item) => item.category === 'skill')).toHaveLength(0);
  });

  it('медиа-кластер модель не вызывает и остаётся bug-задачей', async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordFailure(USER, {
        stage: 'ingest',
        media: 'voice',
        reason: 'transcription_failed',
      });
    }
    const { fn, calls } = countingChat(body());
    const result = await reviewSkillDrafts(USER, { chatFn: fn });

    expect(result.kind).toBe('none');
    expect(calls).toHaveLength(0);
    expect((await listItems(USER)).filter((item) => item.category === 'skill')).toHaveLength(0);
  });

  it('llm_error — инфраструктура, а не повод для скилла', async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordFailure(USER, { stage: 'agent', reason: 'llm_error' });
    }
    const { fn, calls } = countingChat(body());
    const result = await reviewSkillDrafts(USER, { chatFn: fn });

    expect(result.kind).toBe('none');
    expect(calls).toHaveLength(0);
  });

  it('ниже порога модель не вызывается', async () => {
    await seedToolFailures(USER, 'search_notes', 2);
    const { fn, calls } = countingChat(body());
    expect((await reviewSkillDrafts(USER, { chatFn: fn })).kind).toBe('none');
    expect(calls).toHaveLength(0);
  });

  it('пользователи изолированы', async () => {
    await seedToolFailures(USER, 'search_notes', 3);
    const { fn, calls } = countingChat(body());
    const result = await reviewSkillDrafts(OTHER, { chatFn: fn });
    expect(result.kind).toBe('none');
    expect(calls).toHaveLength(0);
  });
});

describe('reviewSkillDrafts: параллельные проходы', () => {
  it('два одновременных обзора не создают два черновика', async () => {
    await seedToolFailures(USER, 'search_notes', 3);

    let calls = 0;
    const chatFn: SkillDraftChatFn = async () => {
      calls += 1;
      return body();
    };

    await Promise.all([
      reviewSkillDrafts(USER, { chatFn }),
      reviewSkillDrafts(USER, { chatFn }),
    ]);

    const skills = (await listItems(USER)).filter((item) => item.category === 'skill');
    expect(skills.length).toBeLessThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('существующий pending по тому же origin не пересоздаётся', async () => {
    await seedToolFailures(USER, 'search_notes', 3);
    const { fn } = countingChat(body());
    const first = await reviewSkillDrafts(USER, { chatFn: fn });
    expect(first.kind).toBe('draft');

    // Второй проход того же касания видит уже готовый черновик и модель не зовёт.
    const second = countingChat(body('вторая редакция'));
    expect((await reviewSkillDrafts(USER, { chatFn: second.fn })).kind).toBe('none');
    expect(second.calls).toHaveLength(0);
    expect((await listItems(USER)).filter((item) => item.category === 'skill')).toHaveLength(1);
  });
});
