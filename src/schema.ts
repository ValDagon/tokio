/**
 * Platform schema: what the tgcloud deploy passes to `migrate`.
 *
 * Single source of truth for the table layout is `src/db/tables.ts`. This module
 * converts those descriptors into the platform's declarative `table()` DSL, while
 * `src/db/ddl.ts` turns the very same descriptors into `CREATE TABLE` statements for
 * local tests — one definition, two adapters, no schema drift.
 */

import {
  index,
  integer,
  primaryKey,
  real,
  sql,
  table,
  text,
  uniqueIndex,
  type Column,
  type Table,
} from 'sdk/db';
import {
  TABLES,
  TABLES_BY_NAME,
  indexName,
  uniqueName,
  type ColumnDef,
  type TableDef,
} from './lib/db/tables.js';

/** TableDef column → platform column descriptor. */
export function buildColumn(name: string, def: ColumnDef): Column {
  let col: Column = def.type === 'integer' ? integer(name) : def.type === 'real' ? real(name) : text(name);

  if (def.pk) {
    col = col.primaryKey(def.autoincrement ? { autoIncrement: true } : {});
  } else {
    if (def.notNull) col = col.notNull();
    if (def.unique) col = col.unique();
  }
  if ('default' in def && def.default !== undefined) {
    col = col.default(def.default);
  }
  return col;
}

function buildColumns(def: TableDef): Record<string, Column> {
  const columns: Record<string, Column> = {};
  for (const [name, columnDef] of Object.entries(def.columns)) {
    columns[name] = buildColumn(name, columnDef);
  }
  return columns;
}

function requireColumns(def: TableDef, columns: readonly string[], where: string): void {
  for (const column of columns) {
    if (!(column in def.columns)) {
      throw new Error(`schema: table "${def.name}" — unknown column "${column}" in ${where}`);
    }
  }
}

/**
 * [edition-specific] В личной редакции в реестре схемы есть ещё два надгробия —
 * `edge_cache` и `inbox_queue` с `.deprecated()`: в её базе эти таблицы реально
 * были (остатки прежнего шлюза) и удалены 12.11.2026, HANDOFF §7.9. В публичной
 * БД их никогда не было, поэтому объявлять здесь нечего — `migrate` и так
 * говорит «в синхроне». Файл различается между редакциями осознанно, строка
 * есть в списке `scripts/check_bot_drift.sh`.
 */

/** TableDef → платформенный дескриптор `table()` (колонки + индексы + PK). */
export function buildTable(def: TableDef): Table {
  const columns = buildColumns(def);
  const built = table(def.name, columns, (t: any) => {
    const extras: Record<string, unknown> = {};

    for (const idx of def.indexes ?? []) {
      requireColumns(def, idx.columns, 'indexes');
      const name = idx.name ?? indexName(def.name, idx.columns);
      const cols = idx.columns.map((column) => (t && t[column]) || columns[column]!) as Column[];
      const builtIndex = (idx.unique ? uniqueIndex(name) : index(name)).on(...cols);
      // Partial index: the condition is raw SQL, exactly like in ddl.ts.
      extras[name] = idx.where ? builtIndex.where(sql.raw(idx.where)) : builtIndex;
    }

    for (const uq of def.uniqueConstraints ?? []) {
      requireColumns(def, uq.columns, 'uniqueConstraints');
      const name = uq.name ?? uniqueName(def.name, uq.columns);
      // Composite UNIQUE is emitted as a unique index: the platform's constraint
      // surface has an optional `.on()`, an index does not.
      extras[name] = uniqueIndex(name).on(
        ...uq.columns.map((column) => (t && t[column]) || columns[column]!),
      );
    }

    if (def.primaryKey) {
      requireColumns(def, def.primaryKey, 'primaryKey');
      extras[`pk_${def.name}`] = primaryKey({
        columns: def.primaryKey.map((column) => (t && t[column]) || columns[column]!) as Column[],
      });
    }

    return extras;
  });

  return built as Table;
}

// ---------------------------------------------------------------------------
// Top-level named table exports (required by `tgcloud migrate`)
// ---------------------------------------------------------------------------

export const users = buildTable(TABLES_BY_NAME.users!);
export const task_categories = buildTable(TABLES_BY_NAME.task_categories!);
export const taskCategories = task_categories;
export const task_subcategories = buildTable(TABLES_BY_NAME.task_subcategories!);
export const taskSubcategories = task_subcategories;
export const tasks = buildTable(TABLES_BY_NAME.tasks!);
export const accounts = buildTable(TABLES_BY_NAME.accounts!);
export const doc_chapters = buildTable(TABLES_BY_NAME.doc_chapters!);
export const docChapters = doc_chapters;
export const fin_categories = buildTable(TABLES_BY_NAME.fin_categories!);
export const finCategories = fin_categories;
export const transactions = buildTable(TABLES_BY_NAME.transactions!);
export const budgets = buildTable(TABLES_BY_NAME.budgets!);
export const liabilities = buildTable(TABLES_BY_NAME.liabilities!);
export const fx_rates = buildTable(TABLES_BY_NAME.fx_rates!);
export const fxRates = fx_rates;
export const notes = buildTable(TABLES_BY_NAME.notes!);
export const entities = buildTable(TABLES_BY_NAME.entities!);
export const mentions = buildTable(TABLES_BY_NAME.mentions!);
export const relations = buildTable(TABLES_BY_NAME.relations!);
export const messages = buildTable(TABLES_BY_NAME.messages!);
export const agent_state = buildTable(TABLES_BY_NAME.agent_state!);
export const agentState = agent_state;
export const llm_usage = buildTable(TABLES_BY_NAME.llm_usage!);
export const llmUsage = llm_usage;
export const medications = buildTable(TABLES_BY_NAME.medications!);
export const medication_logs = buildTable(TABLES_BY_NAME.medication_logs!);
export const medicationLogs = medication_logs;
export const due_jobs = buildTable(TABLES_BY_NAME.due_jobs!);
export const dueJobs = due_jobs;
export const kv = buildTable(TABLES_BY_NAME.kv!);
export const evolution_items = buildTable(TABLES_BY_NAME.evolution_items!);
export const evolutionItems = evolution_items;
export const feedback = buildTable(TABLES_BY_NAME.feedback!);

/** Tables deployed by this project, keyed by their SQL name. */
export const tables: Record<string, Table> = {
  users,
  task_categories,
  task_subcategories,
  tasks,
  accounts,
  doc_chapters,
  fin_categories,
  transactions,
  budgets,
  liabilities,
  fx_rates,
  notes,
  entities,
  mentions,
  relations,
  messages,
  agent_state,
  llm_usage,
  medications,
  medication_logs,
  due_jobs,
  kv,
  evolution_items,
  feedback,
};

export default tables;
