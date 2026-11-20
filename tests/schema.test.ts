import { beforeEach, describe, expect, it } from 'vitest';
import { db, eq } from 'sdk/db';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES, TABLES_BY_NAME, TABLE_NAMES, getTableDef } from '../src/db/tables';
import { createTableSql, createTableStatement, createTableStatements } from '../src/db/ddl';
import * as schemaExports from '../src/schema';
import { tables } from '../src/schema';

const EXPECTED_TABLES = [
  'accounts',
  'agent_state',
  'budgets',
  'doc_chapters',
  'due_jobs',
  'entities',
  'evolution_items',
  'feedback',
  'fin_categories',
  'fx_rates',
  'kv',
  'liabilities',
  'llm_usage',
  'medication_logs',
  'medications',
  'mentions',
  'messages',
  'notes',
  'relations',
  'task_categories',
  'task_subcategories',
  'tasks',
  'transactions',
  'users',
];

interface SqliteMasterRow {
  name: string;
  sql: string | null;
}

describe('схема БД', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
  });

  it('описывает все 24 таблицы ровно по одному разу', () => {
    expect(TABLE_NAMES).toHaveLength(24);
    expect([...TABLE_NAMES].sort()).toEqual(EXPECTED_TABLES);
    expect(new Set(TABLE_NAMES).size).toBe(TABLE_NAMES.length);
  });

  it('DDL создаёт все таблицы в SQLite', async () => {
    const rows = await db.all<SqliteMasterRow>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(rows.map((row) => row.name).sort()).toEqual(EXPECTED_TABLES);
  });

  it('экспортирует каждую таблицу как top-level named export (для tgcloud migrate)', () => {
    for (const name of EXPECTED_TABLES) {
      const exported = (schemaExports as Record<string, any>)[name];
      expect(exported, `top-level named export for table "${name}"`).toBeDefined();
      expect(exported?.name).toBe(name);
      expect(exported?.__table).toBe(true);
    }
    // Проверяем также camelCase алиасы
    expect(schemaExports.taskCategories).toBe(schemaExports.task_categories);
    expect(schemaExports.taskSubcategories).toBe(schemaExports.task_subcategories);
    expect(schemaExports.docChapters).toBe(schemaExports.doc_chapters);
    expect(schemaExports.finCategories).toBe(schemaExports.fin_categories);
    expect(schemaExports.fxRates).toBe(schemaExports.fx_rates);
    expect(schemaExports.agentState).toBe(schemaExports.agent_state);
    expect(schemaExports.llmUsage).toBe(schemaExports.llm_usage);
    expect(schemaExports.medicationLogs).toBe(schemaExports.medication_logs);
    expect(schemaExports.dueJobs).toBe(schemaExports.due_jobs);
    expect(schemaExports.evolutionItems).toBe(schemaExports.evolution_items);
  });

  it('платформенные дескрипторы собираются из тех же TableDef', () => {
    expect(Object.keys(tables).sort()).toEqual(EXPECTED_TABLES);
    for (const name of TABLE_NAMES) {
      const descriptor = tables[name];
      expect(descriptor, `descriptor for ${name}`).toBeDefined();
      expect(descriptor?.name).toBe(name);
      expect(Object.keys(descriptor?.columns ?? {}).sort()).toEqual(
        Object.keys(TABLES_BY_NAME[name]?.columns ?? {}).sort(),
      );
    }
  });

  it('каждая юзерская таблица имеет user_id NOT NULL и индекс, начинающийся с user_id', () => {
    for (const def of TABLES) {
      if (!def.columns.user_id) continue;
      const userColumn = def.columns.user_id;
      // agent_state.user_id — естественный PK: NOT NULL там даёт сам PRIMARY KEY
      expect(userColumn.notNull === true || userColumn.pk === true, `${def.name}.user_id NOT NULL`).toBe(true);
      const covered = (def.indexes ?? []).some((idx) => idx.columns[0] === 'user_id');
      const isPrimaryKey = userColumn.pk === true;
      expect(covered || isPrimaryKey, `${def.name}: индекс по user_id`).toBe(true);
    }
  });

  it('глобальные таблицы живут без user_id', () => {
    expect(TABLES_BY_NAME.kv?.columns.user_id).toBeUndefined();
    expect(TABLES_BY_NAME.fx_rates?.columns.user_id).toBeUndefined();
    expect(TABLES_BY_NAME.fx_rates?.primaryKey).toEqual(['date', 'base']);
  });

  it('категория скилла не требует миграции: колонки те же', async () => {
    // Скилл живёт в существующей `evolution_items`: `category='skill'` — значение
    // текстовой колонки, а версия и origin — внутри `spec`.
    const columns = Object.keys(TABLES_BY_NAME.evolution_items?.columns ?? {});
    expect(columns.sort()).toEqual(
      [
        'id',
        'user_id',
        'category',
        'title',
        'raw_input',
        'spec',
        'status',
        'priority',
        'branch_name',
        'commit_hash',
        'created_at',
        'updated_at',
      ].sort(),
    );

    await db.insert(tables.users).values({ id: 424242, name: 'Скиллы' });
    await db.insert(tables.evolution_items).values({
      user_id: 424242,
      category: 'skill',
      title: 'Скилл: agent-tool-error-search-notes v1',
      raw_input: 'Сигнатура: agent|none|tool_error|search_notes',
      spec: '{"format":"lifeos.skill.v1"}',
      status: 'pending',
    });

    const row = await db
      .select()
      .from(tables.evolution_items)
      .where(eq(tables.evolution_items.user_id, 424242))
      .get();
    expect(row).toMatchObject({ category: 'skill', status: 'pending', priority: 'medium' });
  });

  it('users.id — telegram id, PK без autoincrement', async () => {
    expect(TABLES_BY_NAME.users?.columns.id).toMatchObject({ type: 'integer', pk: true });
    expect(TABLES_BY_NAME.users?.columns.id?.autoincrement).toBeUndefined();

    await db.insert(tables.users).values({ id: 987654321, name: 'Тест' });
    const row = await db.select().from(tables.users).where(eq(tables.users.id, 987654321)).get();
    expect(row).toMatchObject({
      id: 987654321,
      name: 'Тест',
      base_currency: 'EUR',
      timezone: 'UTC',
      summary_time: '07:00',
      low_stimulation_mode: 0,
      quota_tokens: 0,
    });
  });

  it('дефолты срабатывают для задач, заметок и медикаментов', async () => {
    await db.insert(tables.users).values({ id: 1, name: 'A' });
    await db.insert(tables.tasks).values({ user_id: 1, title: 'Первая' });
    await db.insert(tables.notes).values({ user_id: 1, raw_text: 'сырая мысль' });
    await db.insert(tables.medications).values({ user_id: 1, name: 'Магний' });

    const task = await db.select().from(tables.tasks).where(eq(tables.tasks.user_id, 1)).get();
    expect(task).toMatchObject({ status: 'todo', reminder_sent: 0, position: 0 });

    const note = await db.select().from(tables.notes).where(eq(tables.notes.user_id, 1)).get();
    expect(note).toMatchObject({ column: 'raw', source_type: 'text', metadata: '{}' });

    const medication = await db
      .select()
      .from(tables.medications)
      .where(eq(tables.medications.user_id, 1))
      .get();
    expect(medication).toMatchObject({ times: '[]', frequency: 'daily', is_active: 1, refill_threshold: 0 });

    await db.insert(tables.accounts).values({ user_id: 1, name: 'Main', currency: 'EUR' });
    const account = await db.select().from(tables.accounts).where(eq(tables.accounts.user_id, 1)).get();
    expect(account).toMatchObject({ envelope: 'spendable', is_active: 1, current_balance_cents: 0 });
  });

  it('UNIQUE-констрейнты работают (категории и курсы)', async () => {
    await db.insert(tables.users).values({ id: 1, name: 'A' });
    await db.insert(tables.task_categories).values({ user_id: 1, name: 'Работа' });

    await expect(
      db.insert(tables.task_categories).values({ user_id: 1, name: 'Работа' }).run(),
    ).rejects.toThrow(/UNIQUE/);

    await db.insert(tables.fx_rates).values({ date: '2026-11-06', base: 'EUR', rates: '{"USD":1.08}' });
    await expect(
      db.insert(tables.fx_rates).values({ date: '2026-11-06', base: 'EUR', rates: '{"USD":1.09}' }).run(),
    ).rejects.toThrow(/UNIQUE|PRIMARY KEY/);

    // главы документации уникальны в пределах юзера (user_id + slug)
    await db
      .insert(tables.doc_chapters)
      .values({ user_id: 1, slug: 'intro', title: 'Введение', content: 'Текст' });
    await expect(
      db
        .insert(tables.doc_chapters)
        .values({ user_id: 1, slug: 'intro', title: 'Дубль', content: 'Текст' })
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('индексы, включая частичные, создаются', async () => {
    const indexes = await db.all<SqliteMasterRow>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    );
    const byName = new Map(indexes.map((row) => [row.name, row.sql ?? '']));

    expect(byName.has('idx_tasks_user_id_status')).toBe(true);
    expect(byName.has('idx_notes_user_id_column')).toBe(true);
    expect(byName.get('idx_tasks_remind_at_pending')).toContain('WHERE');
    expect(byName.get('idx_tasks_trash')).toContain('deleted_at');
    expect(byName.has('uq_task_categories_user_id_name')).toBe(true);

    const userIndexes = await db.all<{ name: string }>("PRAGMA index_list('users')");
    expect(Array.isArray(userIndexes)).toBe(true);
  });

  it('DDL падает на неизвестной колонке — опечатка не проходит молча', () => {
    const broken = {
      name: 'broken',
      columns: { id: { type: 'integer' as const, pk: true } },
      indexes: [{ columns: ['nope'] }],
    };
    expect(() => createTableSql(broken)).toThrow(/unknown column "nope"/);
    expect(() => createTableStatements([{ ...broken, indexes: [] }])).not.toThrow();
    expect(() => createTableStatements([{ ...broken, indexes: [{ columns: ['nope'] }] }])).toThrow(
      /unknown column "nope"/,
    );
  });

  it('getTableDef не отдаёт несуществующую таблицу', () => {
    expect(getTableDef('users').name).toBe('users');
    expect(() => getTableDef('nope')).toThrow(/unknown table/);
  });
});
