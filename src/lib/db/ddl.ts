/**
 * TableDef → SQL DDL.
 *
 * Второй адаптер схемы (первый — `src/schema.ts`, декларативный DSL платформы).
 * Нужен локальным тестам: `sqliteDDL(createTableStatements(TABLES))` поднимает
 * in-memory базу ровно с той же структурой, что уедет на платформу.
 *
 * Никаких внешних зависимостей и платформенных модулей — чистый текст.
 */

import type { ColumnDef, TableDef, TableIndexDef } from './tables.js';
import { indexName, uniqueName } from './tables.js';

/** `имя` → `"имя"` (кавычки внутри экранируются). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** SQL-литерал для значения по умолчанию. */
export function literalSql(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`ddl: non-finite default ${String(value)}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

const SQL_TYPES: Record<ColumnDef['type'], string> = {
  integer: 'INTEGER',
  text: 'TEXT',
  real: 'REAL',
};

function columnDefinition(name: string, def: ColumnDef): string {
  const parts = [quoteIdent(name), SQL_TYPES[def.type] ?? 'TEXT'];
  if (def.pk) {
    parts.push('PRIMARY KEY');
    if (def.autoincrement) parts.push('AUTOINCREMENT');
  }
  if (def.notNull && !def.pk) parts.push('NOT NULL');
  if (def.unique) parts.push('UNIQUE');
  if ('default' in def && def.default !== undefined) parts.push(`DEFAULT ${literalSql(def.default)}`);
  return parts.join(' ');
}

function assertColumns(def: TableDef, columns: readonly string[], where: string): void {
  for (const column of columns) {
    if (!(column in def.columns)) {
      throw new Error(`ddl: table "${def.name}" — unknown column "${column}" in ${where}`);
    }
  }
}

/** `CREATE TABLE IF NOT EXISTS …` для одной таблицы. */
export function createTableStatement(def: TableDef): string {
  const inlinePk = Object.entries(def.columns).filter(([, col]) => col.pk);
  if (def.primaryKey && inlinePk.length > 0) {
    throw new Error(`ddl: table "${def.name}" — primaryKey conflicts with a pk column`);
  }
  if (inlinePk.length > 1) {
    throw new Error(`ddl: table "${def.name}" — more than one pk column`);
  }

  const columns = Object.entries(def.columns).map(([name, col]) => columnDefinition(name, col));

  if (def.primaryKey) {
    assertColumns(def, def.primaryKey, 'primaryKey');
    columns.push(`PRIMARY KEY (${def.primaryKey.map(quoteIdent).join(', ')})`);
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(def.name)} (\n  ${columns.join(',\n  ')}\n)`;
}

/** `CREATE [UNIQUE] INDEX IF NOT EXISTS …` для одного индекса. */
export function createIndexStatement(def: TableDef, idx: TableIndexDef): string {
  assertColumns(def, idx.columns, 'indexes');
  if (idx.columns.length === 0) {
    throw new Error(`ddl: table "${def.name}" — an index without columns`);
  }
  const name = idx.name ?? indexName(def.name, idx.columns);
  const unique = idx.unique ? 'UNIQUE ' : '';
  const where = idx.where ? ` WHERE ${idx.where}` : '';
  return (
    `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(name)} ` +
    `ON ${quoteIdent(def.name)} (${idx.columns.map(quoteIdent).join(', ')})${where}`
  );
}

/** Все индексы таблицы: явные + композитные UNIQUE-констрейнты. */
export function createIndexStatements(def: TableDef): string[] {
  const statements: string[] = [];

  for (const idx of def.indexes ?? []) statements.push(createIndexStatement(def, idx));

  for (const uq of def.uniqueConstraints ?? []) {
    assertColumns(def, uq.columns, 'uniqueConstraints');
    if (uq.columns.length === 0) {
      throw new Error(`ddl: table "${def.name}" — a unique constraint without columns`);
    }
    statements.push(
      createIndexStatement(def, {
        name: uq.name ?? uniqueName(def.name, uq.columns),
        columns: uq.columns,
        unique: true,
      }),
    );
  }

  return statements;
}

/** CREATE TABLE + CREATE INDEX для одной таблицы. */
export function createTableSql(def: TableDef): string[] {
  return [createTableStatement(def), ...createIndexStatements(def)];
}

/** Полный DDL для набора таблиц (по умолчанию — вся схема приложения). */
export function createTableStatements(defs: readonly TableDef[]): string[] {
  const statements: string[] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.name)) throw new Error(`ddl: duplicate table "${def.name}"`);
    seen.add(def.name);
    statements.push(...createTableSql(def));
  }
  return statements;
}
