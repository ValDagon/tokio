/**
 * T16 — group D: system (usage/digest), medications, docs.
 *
 * Паритет с `legacy/backend/app/api/routes.py` + `legacy/backend/app/api/docs.py`
 * (см. `.scratch/T16-endpoints-spec.md` §4 «Group D», §5 «Tests»).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { recordUsage } from '../../src/lib/dal/misc';
import { DEFAULT_DOC_SEEDS, seedDocs } from '../../src/lib/systemDocs';
import systemUsage from '../../src/endpoints/system_usage';
import systemDigest from '../../src/endpoints/system_digest';
import medicationsCreate from '../../src/endpoints/medications_create';
import medicationsList from '../../src/endpoints/medications_list';
import medicationsTake from '../../src/endpoints/medications_take';
import medicationsSkip from '../../src/endpoints/medications_skip';
import medicationsDelete from '../../src/endpoints/medications_delete';
import docsChapters from '../../src/endpoints/docs_chapters';
import docsChapter from '../../src/endpoints/docs_chapter';
import docsSearch from '../../src/endpoints/docs_search';

const TEST_USER = 777000111;
const mockCtx = { initData: { user: { id: TEST_USER } } };

const UNAUTHORIZED = {
  name: 'EndpointError',
  message: 'Unauthorized',
  parameters: { code: 'UNAUTHORIZED' },
};

describe('T16 endpoints: system, medications, docs', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
  });

  it('без initData эндпоинты группы отдают Unauthorized', async () => {
    const unauthenticated: Array<() => Promise<unknown>> = [
      () => systemUsage({}),
      () => systemDigest({}),
      () => medicationsCreate({ name: 'Тест' }),
      () => medicationsList({}),
      () => medicationsTake({ id: 1 }),
      () => medicationsSkip({ id: 1 }),
      () => medicationsDelete({ id: 1 }),
      () => docsChapters({}),
      () => docsChapter({ slug: '00_overview' }),
      () => docsSearch({ q: 'задачи' }),
    ];

    for (const call of unauthenticated) {
      await expect(call()).rejects.toMatchObject(UNAUTHORIZED);
    }
  });

  it('system_usage отдаёт нули для нового пользователя и считает токены/стоимость', async () => {
    const empty = await systemUsage({}, mockCtx);
    expect(empty).toEqual({
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      total_cost_eur: 0,
    });

    await recordUsage(TEST_USER, {
      model: 'gpt-test',
      promptTokens: 100,
      completionTokens: 50,
      costMicros: 123_456,
    });

    const usage = await systemUsage({}, mockCtx);
    expect(usage).toEqual({
      total_prompt_tokens: 100,
      total_completion_tokens: 50,
      total_tokens: 150,
      total_cost_usd: 0.1235,
      total_cost_eur: 0.1136,
    });
  });

  it('system_digest возвращает непустой текст утреннего дайджеста', async () => {
    const { digest } = await systemDigest({}, mockCtx);
    expect(typeof digest).toBe('string');
    expect(digest.length).toBeGreaterThan(0);
    expect(digest).toContain('Доброе утро');
  });

  it('medications_create сохраняет расписание и отдаёт pending-логи на сегодня', async () => {
    const medication = await medicationsCreate(
      {
        name: 'Витамин D',
        dosage: '1000 МЕ',
        times: ['20:00', '08:00'],
        frequency: 'daily',
      },
      mockCtx,
    );

    expect(medication).toEqual({
      id: expect.stringMatching(/^\d+$/),
      name: 'Витамин D',
      dosage: '1000 МЕ',
      times: ['08:00', '20:00'],
      frequency: 'daily',
      instructions: null,
      is_active: true,
      today_logs: [
        { scheduled_time: '08:00', status: 'pending', taken_at: null },
        { scheduled_time: '20:00', status: 'pending', taken_at: null },
      ],
    });
  });

  it('medications_create применяет дефолты и валидирует вход', async () => {
    const medication = await medicationsCreate({ name: '  Магний  ' }, mockCtx);
    expect(medication.name).toBe('Магний');
    expect(medication.dosage).toBe('');
    expect(medication.times).toEqual(['09:00']);
    expect(medication.frequency).toBe('daily');
    expect(medication.instructions).toBeNull();
    expect(medication.is_active).toBe(true);
    expect(medication.today_logs).toEqual([
      { scheduled_time: '09:00', status: 'pending', taken_at: null },
    ]);

    await expect(medicationsCreate({ name: '   ' }, mockCtx)).rejects.toMatchObject({
      message: 'name is required',
      parameters: { code: 'BAD_REQUEST' },
    });

    await expect(
      medicationsCreate({ name: 'Тест', times: '09:00' }, mockCtx),
    ).rejects.toMatchObject({
      message: 'times must be a list of HH:MM strings',
      parameters: { code: 'BAD_REQUEST' },
    });
  });

  it('medications_take/skip пишут журнал, medications_list их показывает', async () => {
    const medication = await medicationsCreate(
      { name: 'Омега-3', dosage: '1 капсула', times: ['08:00', '20:00'] },
      mockCtx,
    );

    const taken = await medicationsTake(
      { id: medication.id, scheduled_time: '08:00' },
      mockCtx,
    );
    expect(taken).toEqual({ status: 'taken', scheduled_time: '08:00' });

    const skipped = await medicationsSkip(
      { id: medication.id, scheduled_time: '20:00' },
      mockCtx,
    );
    expect(skipped).toEqual({ status: 'skipped', scheduled_time: '20:00' });

    const list = await medicationsList({}, mockCtx);
    expect(list).toHaveLength(1);

    const entry = list[0];
    expect(entry.id).toBe(medication.id);
    expect(entry.name).toBe('Омега-3');
    expect(entry.frequency).toBe('daily');
    expect(entry.is_active).toBe(true);
    expect(entry.times).toEqual(['08:00', '20:00']);
    expect(entry.today_logs).toHaveLength(2);

    const morning = entry.today_logs.find((log) => log.scheduled_time === '08:00');
    expect(morning?.status).toBe('taken');
    expect(typeof morning?.taken_at).toBe('string');

    const evening = entry.today_logs.find((log) => log.scheduled_time === '20:00');
    expect(evening?.status).toBe('skipped');
    expect(evening?.taken_at).toBeNull();
  });

  it('medications_take/skip: 404 для чужого id, 400 для мусорного', async () => {
    await expect(medicationsTake({ id: 999999 }, mockCtx)).rejects.toMatchObject({
      message: 'Medication not found',
      parameters: { code: 'NOT_FOUND' },
    });
    await expect(medicationsSkip({ id: 999999 }, mockCtx)).rejects.toMatchObject({
      message: 'Medication not found',
      parameters: { code: 'NOT_FOUND' },
    });
    await expect(medicationsTake({ id: 'abc' }, mockCtx)).rejects.toMatchObject({
      message: 'Invalid medication id',
      parameters: { code: 'BAD_REQUEST' },
    });
    await expect(medicationsDelete({ id: 0 }, mockCtx)).rejects.toMatchObject({
      message: 'Invalid medication id',
      parameters: { code: 'BAD_REQUEST' },
    });
  });

  it('medications_delete удаляет расписание и всегда отвечает deleted (паритет с upstream)', async () => {
    const medication = await medicationsCreate({ name: 'Цинк' }, mockCtx);

    expect(await medicationsDelete({ id: medication.id }, mockCtx)).toEqual({
      status: 'deleted',
    });
    expect(await medicationsList({}, mockCtx)).toHaveLength(0);

    // Upstream игнорирует результат удаления — для несуществующего id тоже deleted.
    expect(await medicationsDelete({ id: medication.id }, mockCtx)).toEqual({
      status: 'deleted',
    });
  });

  it('docs_chapters отдаёт сводки без контента и секций', async () => {
    const beforeSeed = await docsChapters({}, mockCtx);
    expect(beforeSeed).toEqual([]);

    await seedDocs(TEST_USER);

    const chapters = await docsChapters({}, mockCtx);
    expect(chapters).toHaveLength(DEFAULT_DOC_SEEDS.length);

    const overview = chapters.find((chapter) => chapter.slug === '00_overview');
    expect(overview).toBeDefined();
    expect(overview?.title).toBe('Как устроен ассистент');
    expect(overview?.filename).toBe('00_overview.md');
    expect(overview?.content).toBe('');
    expect(overview?.sections).toEqual([]);
    expect(overview?.sections_count).toBeGreaterThan(0);
    expect(typeof overview?.summary).toBe('string');
  });

  it('docs_chapter отдаёт полный текст и секции, понимает алиас темы', async () => {
    await seedDocs(TEST_USER);

    const chapter = await docsChapter({ slug: '00_overview' }, mockCtx);
    expect(chapter.slug).toBe('00_overview');
    expect(chapter.title).toBe('Как устроен ассистент');
    expect(chapter.content).toContain('# Как устроен ассистент');
    expect(chapter.content).toContain('## Из чего он состоит');
    expect(chapter.sections.length).toBeGreaterThan(0);

    const first = chapter.sections[0];
    expect(first).toMatchObject({
      chapter_slug: '00_overview',
      chapter_title: 'Как устроен ассистент',
      level: 2,
    });
    expect(typeof first.section_title).toBe('string');
    expect(first.section_title.length).toBeGreaterThan(0);
    expect(typeof first.content).toBe('string');

    const byAlias = await docsChapter({ slug: 'обзор' }, mockCtx);
    expect(byAlias.slug).toBe('00_overview');
    expect(byAlias.title).toBe('Как устроен ассистент');
  });

  it('docs_chapter: 404 для неизвестного слага, 400 для пустого', async () => {
    await seedDocs(TEST_USER);

    await expect(docsChapter({ slug: 'nope' }, mockCtx)).rejects.toMatchObject({
      message: "Documentation chapter 'nope' not found",
      parameters: { code: 'NOT_FOUND' },
    });

    await expect(docsChapter({ slug: '   ' }, mockCtx)).rejects.toMatchObject({
      message: 'slug is required',
      parameters: { code: 'BAD_REQUEST' },
    });

    await expect(docsChapter({}, mockCtx)).rejects.toMatchObject({
      message: 'slug is required',
      parameters: { code: 'BAD_REQUEST' },
    });
  });

  it('docs_search возвращает query/topic и непустой текстовый результат', async () => {
    await seedDocs(TEST_USER);

    const plain = await docsSearch({ q: 'финансы' }, mockCtx);
    expect(plain.query).toBe('финансы');
    expect(plain.topic).toBeNull();
    expect(typeof plain.result).toBe('string');
    expect(plain.result.length).toBeGreaterThan(0);

    const withTopic = await docsSearch({ q: 'оглавление', topic: 'финансы' }, mockCtx);
    expect(withTopic.query).toBe('оглавление');
    expect(withTopic.topic).toBe('финансы');
    expect(withTopic.result).toContain('Финансы');

    await expect(docsSearch({}, mockCtx)).rejects.toMatchObject({
      message: 'q is required',
      parameters: { code: 'BAD_REQUEST' },
    });
  });
});
