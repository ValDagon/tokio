/**
 * `src/lib/backup.ts` — экспорт и импорт всех данных пользователя одним JSON.
 *
 * Что здесь важно проверить (и что легко сломать незаметно):
 *  - формат файла: метка/версия/профиль, ровно те таблицы, что переживают
 *    перенос (без `fx_rates`/`kv`/`llm_usage`/`due_jobs` и без квот/BYOK);
 *  - снимок — это снимок: деньги, курсы и json-поля уезжают и возвращаются
 *    байт-в-байт, без «умного» пересчёта (ADR-003);
 *  - импорт переписывает первичные ключи и все ссылки на них, включая
 *    само-ссылки (`tasks.parent_id`, `notes.merged_into`) и полиморфный
 *    `mentions.source_id`;
 *  - `merge` не падает на конфликтах UNIQUE — строка уходит в `skipped`,
 *    битые необязательные ссылки обнуляются с `warnings`;
 *  - `replace` чистит данные целевого юзера и не трогает чужие;
 *  - изоляция: `user_id` из файла игнорируется — пишем всегда целевому юзеру.
 *
 * Транспорт — `db.all`/`db.get`/`db.run` (сырые строки snake_case, как в SQLite),
 * поэтому и проверки идут по сырым строкам, без доменных мапперов.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { ensureUser, getUser, updateUser } from '../src/lib/dal/users';
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  BACKUP_VERSION,
  PROFILE_COLUMNS,
  BackupError,
  exportUserData,
  exportUserDataJson,
  importBackup,
  parseBackupFile,
  restoreFromJson,
  stringifyBackup,
} from '../src/lib/backup';
import type { BackupFile } from '../src/lib/backup';

type Row = Record<string, unknown>;

const USER = 1;
const TARGET = 3;

// ---------------------------------------------------------------------------
// Фикстуры БД
// ---------------------------------------------------------------------------

async function insertRow(table: string, values: Row): Promise<number> {
  const columns = Object.keys(values);
  if (columns.length === 0) throw new Error(`insertRow: no columns for "${table}"`);

  const params: Row = {};
  const placeholders = columns.map((column, index) => {
    params[`p${index}`] = values[column];
    return `:p${index}`;
  });

  const result = await db.run(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${placeholders.join(', ')})`,
    params,
  );
  return Number(result.lastInsertRowid);
}

async function rowsOf(table: string, userId: number): Promise<Row[]> {
  return db.all<Row>(`SELECT * FROM "${table}" WHERE user_id = :uid ORDER BY id`, { uid: userId });
}

async function rowOf(table: string, where: Row): Promise<Row | null> {
  const keys = Object.keys(where);
  const params: Row = {};
  const clause = keys
    .map((column, index) => {
      params[`p${index}`] = where[column];
      return `"${column}" = :p${index}`;
    })
    .join(' AND ');

  return db.get<Row>(`SELECT * FROM "${table}" WHERE ${clause} LIMIT 1`, params);
}

async function countRows(table: string, userId: number): Promise<number> {
  const row = await db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM "${table}" WHERE user_id = :uid`,
    { uid: userId },
  );
  return Number(row?.c ?? 0);
}

/**
 * Полный набор данных пользователя: по строке в каждой переносимой таблице
 * плюс пара связей, которые проверяют ремап (родитель/ребёнок, перевод,
 * заметка→сообщение, сущность→упоминание→связь).
 */
async function seedUser(userId = USER): Promise<void> {
  const taskCategory = await insertRow('task_categories', { user_id: userId, name: 'Work' });
  const taskSubcategory = await insertRow('task_subcategories', {
    user_id: userId,
    category_id: taskCategory,
    name: 'Deep work',
  });
  const parentTask = await insertRow('tasks', {
    user_id: userId,
    category_id: taskCategory,
    subcategory_id: taskSubcategory,
    title: 'Parent task',
  });
  await insertRow('tasks', { user_id: userId, title: 'Child task', parent_id: parentTask });

  const mainAccount = await insertRow('accounts', {
    user_id: userId,
    name: 'Main',
    currency: 'EUR',
    envelope: 'reserved',
    current_balance_cents: 100_000,
  });
  const savingsAccount = await insertRow('accounts', {
    user_id: userId,
    name: 'Savings',
    currency: 'EUR',
  });

  const foodCategory = await insertRow('fin_categories', { user_id: userId, name: 'Food' });

  await insertRow('transactions', {
    user_id: userId,
    kind: 'expense',
    account_id: mainAccount,
    to_account_id: savingsAccount,
    category_id: foodCategory,
    amount_cents: 1234,
    currency: 'USD',
    fx_rate: 1.17,
    amount_eur_cents: 1055,
    description: 'coffee',
    occurred_at: '2026-01-02T10:00:00.000Z',
  });

  await insertRow('budgets', {
    user_id: userId,
    category_id: foodCategory,
    month: '2026-01',
    limit_amount_eur_cents: 50_000,
  });

  await insertRow('liabilities', {
    user_id: userId,
    name: 'Loan',
    account_id: mainAccount,
    amount_cents: 250_000,
  });

  await insertRow('doc_chapters', {
    user_id: userId,
    slug: '01_finances',
    filename: '01_finances.md',
    title: 'Finances',
    content: '# Finances',
    is_pinned: 1,
  });

  const message = await insertRow('messages', {
    user_id: userId,
    role: 'user',
    content: 'hello',
  });

  const note = await insertRow('notes', {
    user_id: userId,
    raw_text: 'note one',
    source_message_id: message,
    metadata: '{"k":"v"}',
  });
  await insertRow('notes', { user_id: userId, raw_text: 'merged note', merged_into: note });

  const person = await insertRow('entities', { user_id: userId, kind: 'person', name: 'Anna' });
  const org = await insertRow('entities', { user_id: userId, kind: 'org', name: 'Acme' });

  await insertRow('mentions', {
    user_id: userId,
    entity_id: person,
    source_type: 'note',
    source_id: note,
    at: '2026-01-02T10:00:00.000Z',
  });

  await insertRow('relations', {
    user_id: userId,
    subject_id: person,
    predicate: 'works_at',
    object_id: org,
    valid_from: '2026-01-01T00:00:00.000Z',
  });

  const medication = await insertRow('medications', {
    user_id: userId,
    name: 'Vitamin D',
    times: '["08:00"]',
  });
  await insertRow('medication_logs', {
    user_id: userId,
    medication_id: medication,
    scheduled_time: '08:00',
    date: '2026-01-02',
  });

  await insertRow('evolution_items', {
    user_id: userId,
    title: 'Export backup',
    raw_input: 'make it one file',
  });

  await insertRow('agent_state', {
    user_id: userId,
    thread: '[{"role":"user","content":"hi"}]',
    updated_at: '2026-01-02T10:00:00.000Z',
  });
}

/** Минимальный корректный файл бэкапа — для точечных сценариев импорта. */
function makeFile(tables: Record<string, Row[]>, extra: Partial<BackupFile> = {}): BackupFile {
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(tables)) counts[name] = rows.length;

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    userId: 999,
    profile: null,
    tables,
    counts,
    ...extra,
  };
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

describe('exportUserData', () => {
  it('пустой пользователь: формат, дефолтный профиль и нулевые counts', async () => {
    await ensureUser(USER);

    const backup = await exportUserData(USER);

    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.userId).toBe(USER);
    expect(backup.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    expect(backup.profile).toEqual({
      name: null,
      base_currency: 'EUR',
      timezone: 'UTC',
      summary_time: '07:00',
      low_stimulation_mode: 0,
    });

    expect(Object.keys(backup.tables).sort()).toEqual([...BACKUP_TABLES].sort());
    for (const table of BACKUP_TABLES) {
      expect(backup.tables[table]).toEqual([]);
      expect(backup.counts[table]).toBe(0);
    }

    // Глобальные/служебные таблицы не принадлежат пользователю и в снимок не идут.
    for (const table of ['fx_rates', 'kv', 'llm_usage', 'due_jobs']) {
      expect(backup.tables[table]).toBeUndefined();
      expect(backup.counts[table]).toBeUndefined();
    }
  });

  it('профиль — только переносимые колонки (квоты и BYOK остаются дома)', async () => {
    await ensureUser(USER);
    await db.run(
      `UPDATE users
          SET quota_month = :month, quota_tokens = :tokens, quota_limit = :limit,
              byok_ciphertext = :ciphertext, byok_nonce = :nonce, byok_tag = :tag,
              name = :name
        WHERE id = :id`,
      {
        month: '2026-01',
        tokens: 5000,
        limit: 1000,
        ciphertext: 'cipher',
        nonce: 'nonce',
        tag: 'tag',
        name: 'Owner',
        id: USER,
      },
    );

    const backup = await exportUserData(USER);

    expect(backup.profile).not.toBeNull();
    expect(Object.keys(backup.profile ?? {}).sort()).toEqual([...PROFILE_COLUMNS].sort());
    expect(backup.profile?.name).toBe('Owner');
    for (const leaked of ['quota_tokens', 'quota_limit', 'quota_month', 'byok_ciphertext']) {
      expect(backup.profile).not.toHaveProperty(leaked);
    }
  });

  it('профиля нет — null; без userId — BackupError', async () => {
    const backup = await exportUserData(777);
    expect(backup.profile).toBeNull();
    expect(backup.userId).toBe(777);
    expect(backup.counts.tasks).toBe(0);

    await expect(exportUserData(Number.NaN)).rejects.toBeInstanceOf(BackupError);
    await expect(exportUserData(Number.NaN)).rejects.toThrow('backup: userId is required');
  });

  it('строки отсортированы по id, снимок в JSON — компактный или pretty', async () => {
    await ensureUser(USER);
    await insertRow('tasks', { user_id: USER, title: 'first' });
    await insertRow('tasks', { user_id: USER, title: 'second' });

    const backup = await exportUserData(USER);
    expect(backup.tables.tasks.map((row) => row.title)).toEqual(['first', 'second']);
    expect(backup.counts.tasks).toBe(2);

    expect(stringifyBackup(backup)).not.toContain('\n');
    expect(stringifyBackup(backup, true)).toContain('\n  "format"');

    const json = JSON.parse(stringifyBackup(backup)) as BackupFile;
    expect(json.format).toBe(BACKUP_FORMAT);
    expect(json.tables.tasks).toHaveLength(2);

    const fromHelper = JSON.parse(await exportUserDataJson(USER, true)) as BackupFile;
    expect(fromHelper.userId).toBe(USER);
  });
});

// ---------------------------------------------------------------------------
// Полный перенос
// ---------------------------------------------------------------------------

describe('importBackup: merge в другого пользователя', () => {
  it('переносит снимок, ремапит id и ссылки, не пересчитывает деньги', async () => {
    await ensureUser(USER);
    await updateUser(USER, {
      name: 'Owner',
      baseCurrency: 'USD',
      timezone: 'Europe/Berlin',
      summaryTime: '08:30',
      lowStimulationMode: true,
    });
    await seedUser(USER);

    // Целевой юзер уже с данными: новые id обязаны быть больше старых,
    // иначе тест не отличит «переписали» от «скопировали как есть».
    await ensureUser(TARGET);
    await insertRow('tasks', { user_id: TARGET, title: 'Existing task' });
    await insertRow('messages', { user_id: TARGET, role: 'user', content: 'existing msg' });
    await insertRow('notes', { user_id: TARGET, raw_text: 'old note' });

    const backup = await exportUserData(USER);
    const result = await importBackup(TARGET, backup);

    expect(result.mode).toBe('merge');
    expect(result.userId).toBe(TARGET);
    expect(result.sourceUserId).toBe(USER);
    expect(result.profileUpdated).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([]);

    for (const table of BACKUP_TABLES) {
      expect(result.tables[table]).toEqual({ inserted: backup.counts[table], skipped: 0 });
    }

    // Профиль переносится, но не квоты.
    const profile = await getUser(TARGET);
    expect(profile).not.toBeNull();
    expect(profile?.name).toBe('Owner');
    expect(profile?.baseCurrency).toBe('USD');
    expect(profile?.timezone).toBe('Europe/Berlin');
    expect(profile?.summaryTime).toBe('08:30');
    expect(profile?.lowStimulationMode).toBe(true);

    // Изоляция: все перенесённые строки принадлежат целевому юзеру.
    for (const table of BACKUP_TABLES) {
      if (table === 'agent_state') continue;
      const rows = await rowsOf(table, TARGET);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.user_id).toBe(TARGET);
    }

    // --- ремап ссылок -------------------------------------------------------
    const parent = await rowOf('tasks', { user_id: TARGET, title: 'Parent task' });
    const child = await rowOf('tasks', { user_id: TARGET, title: 'Child task' });
    expect(parent).not.toBeNull();
    expect(child).not.toBeNull();
    expect(child?.parent_id).toBe(parent?.id);
    expect(child?.parent_id).not.toBe(1);
    expect(parent?.category_id).toBeTypeOf('number');
    expect(parent?.subcategory_id).toBeTypeOf('number');

    const mainAccount = await rowOf('accounts', { user_id: TARGET, name: 'Main' });
    const savingsAccount = await rowOf('accounts', { user_id: TARGET, name: 'Savings' });
    const foodCategory = await rowOf('fin_categories', { user_id: TARGET, name: 'Food' });

    const transaction = await rowOf('transactions', { user_id: TARGET });
    expect(transaction).not.toBeNull();
    expect(transaction?.account_id).toBe(mainAccount?.id);
    expect(transaction?.to_account_id).toBe(savingsAccount?.id);
    expect(transaction?.category_id).toBe(foodCategory?.id);
    // ADR-003: суммы и курсы — как были, без пересчёта.
    expect(transaction?.amount_cents).toBe(1234);
    expect(transaction?.fx_rate).toBe(1.17);
    expect(transaction?.amount_eur_cents).toBe(1055);
    expect(transaction?.currency).toBe('USD');

    // Конверт счёта и json-поля — тоже сырые.
    expect(mainAccount?.envelope).toBe('reserved');
    const chapter = await rowOf('doc_chapters', { user_id: TARGET, slug: '01_finances' });
    expect(chapter?.is_pinned).toBe(1);

    const notes = await rowsOf('notes', TARGET);
    expect(notes).toHaveLength(3); // «old note» + две из бэкапа
    const mergedNote = notes.find((row) => row.raw_text === 'merged note');
    const baseNote = notes.find((row) => row.raw_text === 'note one');
    expect(baseNote?.metadata).toBe('{"k":"v"}');
    expect(mergedNote?.merged_into).toBe(baseNote?.id);
    expect(mergedNote?.merged_into).not.toBe(1);

    const message = await rowOf('messages', { user_id: TARGET, content: 'hello' });
    expect(baseNote?.source_message_id).toBe(message?.id);

    // Полиморфный mentions.source_id: таблица выбирается по source_type.
    const mention = await rowOf('mentions', { user_id: TARGET });
    expect(mention?.source_type).toBe('note');
    expect(mention?.source_id).toBe(baseNote?.id);

    const person = await rowOf('entities', { user_id: TARGET, name: 'Anna' });
    const org = await rowOf('entities', { user_id: TARGET, name: 'Acme' });
    const relation = await rowOf('relations', { user_id: TARGET });
    expect(relation?.subject_id).toBe(person?.id);
    expect(relation?.object_id).toBe(org?.id);
    expect(mention?.entity_id).toBe(person?.id);

    const medication = await rowOf('medications', { user_id: TARGET, name: 'Vitamin D' });
    const log = await rowOf('medication_logs', { user_id: TARGET });
    expect(log?.medication_id).toBe(medication?.id);
    expect(medication?.times).toBe('["08:00"]');

    const state = await rowOf('agent_state', { user_id: TARGET });
    expect(state?.thread).toBe('[{"role":"user","content":"hi"}]');

    // --- чужой пользователь не тронут --------------------------------------
    expect(await countRows('tasks', USER)).toBe(2);
    expect(await countRows('accounts', USER)).toBe(2);
    expect(await countRows('notes', USER)).toBe(2);
    const owner = await getUser(USER);
    expect(owner?.name).toBe('Owner');
  });

  it('повторный merge: конфликты UNIQUE уходят в skipped, остальное доливается', async () => {
    await ensureUser(TARGET);
    const backup = makeFile(
      {
        task_categories: [{ id: 1, user_id: 999, name: 'Work' }],
        task_subcategories: [{ id: 2, user_id: 999, category_id: 1, name: 'Deep work' }],
        tasks: [
          { id: 3, user_id: 999, category_id: 1, title: 'Parent task' },
          { id: 4, user_id: 999, parent_id: 3, title: 'Child task' },
        ],
        accounts: [
          { id: 5, user_id: 999, name: 'Main', currency: 'EUR' },
          { id: 6, user_id: 999, name: 'Savings', currency: 'EUR' },
        ],
        fin_categories: [{ id: 7, user_id: 999, name: 'Food' }],
        transactions: [
          {
            id: 8,
            user_id: 999,
            kind: 'expense',
            account_id: 5,
            category_id: 7,
            amount_cents: 100,
            currency: 'EUR',
            amount_eur_cents: 100,
            occurred_at: '2026-01-02T10:00:00.000Z',
          },
        ],
        budgets: [{ id: 9, user_id: 999, category_id: 7, month: '2026-01', limit_amount_eur_cents: 1 }],
        doc_chapters: [
          { id: 10, user_id: 999, slug: '01_finances', title: 'Finances', content: '# Finances' },
        ],
        messages: [{ id: 11, user_id: 999, role: 'user', content: 'hello' }],
        notes: [{ id: 12, user_id: 999, raw_text: 'note one' }],
        entities: [
          { id: 13, user_id: 999, kind: 'person', name: 'Anna' },
          { id: 14, user_id: 999, kind: 'org', name: 'Acme' },
        ],
        mentions: [
          { id: 15, user_id: 999, entity_id: 13, source_type: 'note', source_id: 12, at: 'x' },
        ],
        relations: [
          {
            id: 16,
            user_id: 999,
            subject_id: 13,
            predicate: 'works_at',
            object_id: 14,
            valid_from: '2026-01-01T00:00:00.000Z',
          },
        ],
        medications: [{ id: 17, user_id: 999, name: 'Vitamin D' }],
        medication_logs: [
          { id: 18, user_id: 999, medication_id: 17, scheduled_time: '08:00', date: '2026-01-02' },
        ],
        evolution_items: [{ id: 19, user_id: 999, title: 'Idea', raw_input: 'do it' }],
      },
    );

    const first = await importBackup(TARGET, backup, { mode: 'merge' });
    expect(first.skipped).toEqual([]);

    const second = await importBackup(TARGET, backup, { mode: 'merge' });

    // UNIQUE(user_id, name, currency), (user_id, slug) и т.п. — построчный skip.
    expect(second.tables.accounts).toEqual({ inserted: 0, skipped: 2 });
    expect(second.tables.doc_chapters).toEqual({ inserted: 0, skipped: 1 });
    expect(second.tables.task_categories).toEqual({ inserted: 0, skipped: 1 });
    expect(second.tables.fin_categories).toEqual({ inserted: 0, skipped: 1 });
    expect(second.tables.entities).toEqual({ inserted: 0, skipped: 2 });

    // Задачи и заметки UNIQUE не имеют — доливаются рядом со старыми.
    expect(second.tables.tasks).toEqual({ inserted: 2, skipped: 0 });
    expect(second.tables.notes).toEqual({ inserted: 1, skipped: 0 });

    const accountSkip = second.skipped.find((item) => item.table === 'accounts');
    expect(accountSkip?.reason).toContain('UNIQUE constraint failed');

    // Категория не вставилась → у задачи она обнулена, но строка жива.
    expect(second.warnings.some((warning) => warning.startsWith('tasks.category_id:'))).toBe(true);

    expect(await countRows('accounts', TARGET)).toBe(2);
    expect(await countRows('tasks', TARGET)).toBe(4);
  });

  it('replace: чистит данные целевого юзера, оставляет строку users и чужие данные', async () => {
    await ensureUser(USER);
    await updateUser(USER, { name: 'Owner' });
    await seedUser(USER);
    const backup = await exportUserData(USER);

    await ensureUser(TARGET);
    await insertRow('tasks', { user_id: TARGET, title: 'Extra task' });
    await insertRow('accounts', { user_id: TARGET, name: 'Old account', currency: 'EUR' });

    const result = await importBackup(TARGET, backup, { mode: 'replace' });

    expect(result.mode).toBe('replace');
    expect(result.profileUpdated).toBe(true);

    const tasks = await rowsOf('tasks', TARGET);
    expect(tasks.map((row) => row.title).sort()).toEqual(['Child task', 'Parent task']);

    const accounts = await rowsOf('accounts', TARGET);
    expect(accounts.map((row) => row.name).sort()).toEqual(['Main', 'Savings']);

    // Строка users не удаляется — профиль просто обновляется.
    expect(await getUser(TARGET)).not.toBeNull();
    expect((await getUser(TARGET))?.name).toBe('Owner');

    // Чужой пользователь цел.
    expect(await countRows('tasks', USER)).toBe(2);
    expect(await countRows('accounts', USER)).toBe(2);
  });

  it('user_id из файла игнорируется — пишем целевому пользователю', async () => {
    const file = makeFile({
      tasks: [{ id: 1, user_id: 999, title: 'From file' }],
    });

    const result = await importBackup(TARGET, file);

    expect(result.sourceUserId).toBe(999);
    expect(result.tables.tasks).toEqual({ inserted: 1, skipped: 0 });

    const rows = await rowsOf('tasks', TARGET);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(TARGET);
    expect(await countRows('tasks', 999)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Профиль
// ---------------------------------------------------------------------------

describe('importBackup: профиль', () => {
  it('пустой профиль и мусорные поля ничего не меняют', async () => {
    await ensureUser(TARGET);

    const empty = await importBackup(TARGET, makeFile({}, { profile: {} }));
    expect(empty.profileUpdated).toBe(false);

    const junk = await importBackup(
      TARGET,
      makeFile(
        {},
        {
          profile: {
            base_currency: 42,
            timezone: '',
            summary_time: '   ',
            low_stimulation_mode: null,
          },
        },
      ),
    );
    expect(junk.profileUpdated).toBe(false);

    const user = await getUser(TARGET);
    expect(user?.baseCurrency).toBe('EUR');
    expect(user?.timezone).toBe('UTC');
    expect(user?.summaryTime).toBe('07:00');
  });

  it('явный null в name — это значение, а не «не трогать»', async () => {
    await ensureUser(TARGET);
    await updateUser(TARGET, { name: 'Old name' });

    const result = await importBackup(TARGET, makeFile({}, { profile: { name: null } }));

    expect(result.profileUpdated).toBe(true);
    expect((await getUser(TARGET))?.name).toBeNull();
  });

  it('low_stimulation_mode приводится к boolean, «0» выключает режим', async () => {
    await ensureUser(TARGET);

    const on = await importBackup(
      TARGET,
      makeFile({}, { profile: { low_stimulation_mode: '1' } }),
    );
    expect(on.profileUpdated).toBe(true);
    expect((await getUser(TARGET))?.lowStimulationMode).toBe(true);

    const off = await importBackup(TARGET, makeFile({}, { profile: { low_stimulation_mode: 0 } }));
    expect(off.profileUpdated).toBe(true);
    expect((await getUser(TARGET))?.lowStimulationMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Битые ссылки и незнакомые таблицы
// ---------------------------------------------------------------------------

describe('importBackup: ссылки', () => {
  it('необязательные ссылки обнуляются с warning, обязательные — skip строки', async () => {
    const file = makeFile({
      accounts: [{ id: 10, user_id: 999, name: 'Main', currency: 'EUR' }],
      fin_categories: [],
      entities: [{ id: 20, user_id: 999, kind: 'person', name: 'Anna' }],
      notes: [
        { id: 30, user_id: 999, raw_text: 'n1' },
        { id: 31, user_id: 999, raw_text: 'n2', merged_into: 99 },
      ],
      transactions: [
        {
          id: 40,
          user_id: 999,
          kind: 'expense',
          account_id: 10,
          category_id: 99,
          amount_cents: 100,
          currency: 'EUR',
          amount_eur_cents: 100,
          occurred_at: '2026-01-02T10:00:00.000Z',
        },
      ],
      mentions: [
        { id: 50, user_id: 999, entity_id: 20, source_type: 'note', source_id: 99, at: 'x' },
        { id: 51, user_id: 999, entity_id: 20, source_type: 'weird', source_id: 1, at: 'x' },
      ],
      medication_logs: [
        { id: 60, user_id: 999, medication_id: 99, scheduled_time: '08:00', date: '2026-01-02' },
      ],
    });

    const result = await importBackup(TARGET, file);

    // Обязательная ссылка (medication_id) — строка не вставлена.
    expect(result.skipped).toEqual([
      { table: 'medication_logs', reason: 'medication_id → medications.#99 not found' },
    ]);
    expect(result.tables.medication_logs).toEqual({ inserted: 0, skipped: 1 });

    // Необязательные — строка жива, поле обнулено.
    expect(result.tables.transactions).toEqual({ inserted: 1, skipped: 0 });
    const transaction = await rowOf('transactions', { user_id: TARGET });
    expect(transaction?.category_id).toBeNull();
    expect(transaction?.account_id).toBeTypeOf('number');

    expect(result.warnings).toContain(
      'transactions.category_id: fin_categories.#99 not found, set NULL',
    );
    expect(result.warnings.some((w) => /^notes\.merged_into: #99 not found, set NULL \(row #\d+\)$/.test(w))).toBe(true);
    expect(result.warnings).toContain('mentions.source_id: source note#99 not found, set NULL');
    expect(result.warnings).toContain('mentions.source_id: unknown source_type "weird", set NULL');

    const notes = await rowsOf('notes', TARGET);
    expect(notes).toHaveLength(2);
    expect(notes.find((row) => row.raw_text === 'n2')?.merged_into).toBeNull();

    const mentions = await rowsOf('mentions', TARGET);
    expect(mentions).toHaveLength(2);
    for (const mention of mentions) expect(mention.source_id).toBeNull();
  });

  it('незнакомые таблицы и колонки не ломают импорт', async () => {
    const file = makeFile({
      tasks: [{ id: 1, user_id: 999, title: 'From file', bogus: 'ignored' }],
      mystery: [{ id: 1, whatever: true }],
    });

    const result = await importBackup(TARGET, file);

    expect(result.warnings).toEqual(['unknown table "mystery" ignored']);
    expect(result.tables.mystery).toBeUndefined();
    expect(result.tables.tasks).toEqual({ inserted: 1, skipped: 0 });

    const rows = await rowsOf('tasks', TARGET);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('From file');
    expect(rows[0]).not.toHaveProperty('bogus');
  });
});

// ---------------------------------------------------------------------------
// agent_state
// ---------------------------------------------------------------------------

describe('importBackup: agent_state', () => {
  it('thread-массив сериализуется, а merge перезаписывает поток', async () => {
    const file = makeFile({
      agent_state: [{ user_id: 999, thread: [{ role: 'user', content: 'hi' }] }],
    });

    const result = await importBackup(TARGET, file);
    expect(result.tables.agent_state).toEqual({ inserted: 1, skipped: 0 });

    let state = await rowOf('agent_state', { user_id: TARGET });
    expect(state?.thread).toBe('[{"role":"user","content":"hi"}]');

    await importBackup(TARGET, makeFile({ agent_state: [{ thread: '["second"]' }] }));
    state = await rowOf('agent_state', { user_id: TARGET });
    expect(state?.thread).toBe('["second"]');
    expect(await countRows('agent_state', TARGET)).toBe(1);
  });

  it('строка без thread пропускается с причиной', async () => {
    const result = await importBackup(TARGET, makeFile({ agent_state: [{ foo: 1 }] }));

    expect(result.tables.agent_state).toEqual({ inserted: 0, skipped: 1 });
    expect(result.skipped).toEqual([{ table: 'agent_state', reason: 'row has no thread' }]);
    expect(await rowOf('agent_state', { user_id: TARGET })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Валидация файла
// ---------------------------------------------------------------------------

describe('parseBackupFile', () => {
  it('понимает строку и объект, пересчитывает counts', () => {
    const fromString = parseBackupFile(
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        userId: 42,
        profile: { name: 'Owner' },
        tables: { tasks: [{ title: 'a' }, { title: 'b' }] },
      }),
    );

    expect(fromString.format).toBe(BACKUP_FORMAT);
    expect(fromString.userId).toBe(42);
    expect(fromString.exportedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(fromString.profile).toEqual({ name: 'Owner' });
    expect(fromString.counts).toEqual({ tasks: 2 });

    // Не-объекты в массиве строк — мусор, а не строки таблицы.
    const filtered = parseBackupFile({
      format: BACKUP_FORMAT,
      version: 1,
      tables: { tasks: [1, 'x', null, { title: 'a' }] },
    });
    expect(filtered.tables.tasks).toEqual([{ title: 'a' }]);
    expect(filtered.counts).toEqual({ tasks: 1 });

    const minimal = parseBackupFile({ format: BACKUP_FORMAT, version: 1, tables: {} });
    expect(minimal.userId).toBe(0);
    expect(minimal.exportedAt).toBe('');
    expect(minimal.profile).toBeNull();
    expect(minimal.counts).toEqual({});
  });

  it('отсекает битый JSON, чужой формат и несовместимые версии', () => {
    expect(() => parseBackupFile('{oops')).toThrow(BackupError);
    expect(() => parseBackupFile('{oops')).toThrow(/invalid JSON/);
    expect(() => parseBackupFile('[]')).toThrow('backup: file must be a JSON object');
    expect(() => parseBackupFile(42)).toThrow('backup: file must be a JSON object');
    expect(() => parseBackupFile({ format: 'other', version: 1, tables: {} })).toThrow(
      /unknown format/,
    );
    expect(() => parseBackupFile({ format: BACKUP_FORMAT, tables: {} })).toThrow(
      'backup: missing version',
    );
    expect(() => parseBackupFile({ format: BACKUP_FORMAT, version: 0, tables: {} })).toThrow(
      'backup: missing version',
    );
    expect(() => parseBackupFile({ format: BACKUP_FORMAT, version: 'abc', tables: {} })).toThrow(
      'backup: missing version',
    );
    expect(() => parseBackupFile({ format: BACKUP_FORMAT, version: '2', tables: {} })).toThrow(
      /version 2 is newer than supported 1/,
    );
    expect(() => parseBackupFile({ format: BACKUP_FORMAT, version: 1 })).toThrow(
      'backup: "tables" must be an object',
    );
    expect(() =>
      parseBackupFile({ format: BACKUP_FORMAT, version: 1, tables: { tasks: 'nope' } }),
    ).toThrow('backup: table "tasks" must be an array');
  });
});

// ---------------------------------------------------------------------------
// Восстановление из присланного файла
// ---------------------------------------------------------------------------

describe('restoreFromJson', () => {
  it('импортирует текст файла так же, как объект', async () => {
    await ensureUser(USER);
    await seedUser(USER);
    const text = await exportUserDataJson(USER);

    const result = await restoreFromJson(TARGET, text);

    expect(result.userId).toBe(TARGET);
    expect(result.sourceUserId).toBe(USER);
    expect(result.tables.tasks).toEqual({ inserted: 2, skipped: 0 });
    expect(await countRows('tasks', TARGET)).toBe(2);
    expect(await countRows('tasks', USER)).toBe(2);
  });

  it('на не-бэкапе бросает BackupError, ничего не записав', async () => {
    await ensureUser(TARGET);

    await expect(restoreFromJson(TARGET, 'не json')).rejects.toBeInstanceOf(BackupError);
    await expect(restoreFromJson(TARGET, JSON.stringify({ hello: 'world' }))).rejects.toThrow(
      /unknown format/,
    );
    expect(await countRows('tasks', TARGET)).toBe(0);
  });
});
