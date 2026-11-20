/**
 * Backup: экспорт и импорт всех данных пользователя в один JSON-файл.
 *
 * Порт `backend/app/services/backup.py`, но с тремя осознанными отличиями.
 *
 *  - **Один JSON вместо ZIP.** В upstream бэкап — это ZIP с `data.json` и
 *    сгенерированным `notes.md`. Здесь платформа не даёт ни архиваторов, ни
 *    файловой системы: `Buffer`, `zlib` и временные файлы недоступны, а
 *    единственный транспорт — байты, которые отдаёт/принимает бот. Поэтому
 *    формат — самодостаточный JSON-документ: его проще валидировать до записи
 *    в БД, он же и есть «человекочитаемая» копия данных (никакой отдельный
 *    `notes.md` не нужен — те же строки лежат в `tables`).
 *  - **Прямые SQL — осознанное исключение из правила «только DAL» (SPEC §2.5).**
 *    Причины ровно две: (1) экспорт по определению читает ВСЕ строки юзера из
 *    ВСЕХ таблиц, а DAL-функции отдают доменные срезы, а не сырые строки; (2)
 *    импорт переписывает первичные ключи (old id → new id), а DAL всегда
 *    инжектит `user_id` и работает с натуральным id вызывающего. Изоляция при
 *    этом не страдает: каждый запрос здесь содержит `user_id = :uid`, а при
 *    импорте `user_id` принудительно перезаписывается целевым — данные одного
 *    пользователя физически не могут попасть другому.
 *  - **Сырые значения без пересчёта (ADR-003).** Деньги остаются целыми
 *    центами (`*_cents`), `fx_rate` — как есть, json-колонки — как TEXT-JSON
 *    из БД. Бэкап — это снимок, а не миграция: любая «умная» нормализация
 *    сделала бы восстановление необратимым.
 *
 * Что НЕ попадает в бэкап и почему:
 *  - `fx_rates`, `kv` — глобальные таблицы без `user_id` (не данные юзера);
 *  - `llm_usage` — бухгалтерия расходов провайдера, не пользовательские данные;
 *  - `due_jobs` — транзиентный планировщик (после восстановления его дешевле
 *    пересобрать из задач/медикаментов, чем тащить устаревшие запуски);
 *  - квоты (`quota_*`) и BYOK (`byok_*`) внутри `users` — секреты и лимиты
 *    конкретной инсталляции: они привязаны к ключам продукта и не переносимы.
 *
 * Импорт работает в двух режимах:
 *  - `merge` (по умолчанию) — добавляет строки рядом с существующими, ремапит
 *    id и ссылки; конфликты UNIQUE (например, счёт с тем же именем и валютой)
 *    пропускаются построчно и попадают в `skipped`;
 *  - `replace` — сначала удаляет все строки пользователя (в обратном порядке
 *    зависимостей), затем вставляет бэкап. Строка `users` не удаляется:
 *    профиль обновляется через `updateUser`.
 *
 * Самовосстановление ссылок: `tasks.parent_id` и `notes.merged_into` смотрят
 * на ту же таблицу, поэтому пишутся вторым проходом (id потомка ещё не
 * известен на момент вставки родителя). `mentions.source_id` полиморфен —
 * таблица выбирается по `source_type`.
 */

import { db, sql } from 'sdk/db';
import type { RunResult, Sql } from 'sdk/db';
import { getTableDef } from './db/tables.js';
import { ensureUser, updateUser } from './dal/users.js';
import type { UserPatch } from './dal/users.js';
import { withTransaction } from './dal/finances.js';
import { nowIso } from './utils.js';

// ---------------------------------------------------------------------------
// Константы и типы
// ---------------------------------------------------------------------------

/**
 * Метка формата: чужие/битые файлы отсекаются до записи в БД.
 *
 * Значение не переименовывается вместе с продуктом: по нему `importBackup`
 * узнаёт файл, и уже скачанные бэкапы (`tokio-backup-*.json`) обязаны
 * восстанавливаться. Это идентификатор формата, а не название бота.
 */
export const BACKUP_FORMAT = 'tokio-backup';

/** Версия формата. Растёт при несовместимом изменении структуры. */
export const BACKUP_VERSION = 1;

/**
 * Порядок таблиц: родители раньше детей. Тот же порядок используется при
 * экспорте (для стабильного диффа), импорте (ссылки уже видны) и в обратном
 * виде — при очистке в режиме `replace`.
 */
export const BACKUP_TABLES = [
  'task_categories',
  'task_subcategories',
  'tasks',
  'accounts',
  'fin_categories',
  'transactions',
  'budgets',
  'liabilities',
  'doc_chapters',
  'messages',
  'notes',
  'entities',
  'mentions',
  'relations',
  'medications',
  'medication_logs',
  'evolution_items',
  'agent_state',
] as const;

export type BackupTableName = (typeof BACKUP_TABLES)[number];

/** Колонки профиля, которые переживают экспорт/импорт. */
export const PROFILE_COLUMNS = [
  'name',
  'base_currency',
  'timezone',
  'summary_time',
  'low_stimulation_mode',
] as const;

/** Сырая строка таблицы (snake_case, как в SQLite) — без преобразований. */
export type BackupRow = Record<string, unknown>;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** Чей это снимок — только для информации; импорт пишет в переданного юзера. */
  userId: number;
  /** Профиль без квот и BYOK; `null`, если строки `users` не было. */
  profile: BackupRow | null;
  /** Таблица → строки в порядке экспорта. */
  tables: Record<string, BackupRow[]>;
  /** Таблица → количество строк (дублирует длины массивов, читается глазами). */
  counts: Record<string, number>;
  fx_rates?: BackupRow[];
}

export type BackupMode = 'merge' | 'replace';

export interface ImportOptions {
  /** `merge` (по умолчанию) — долить; `replace` — заменить данные юзера. */
  mode?: BackupMode;
}

export interface TableImportStats {
  inserted: number;
  skipped: number;
}

export interface ImportResult {
  mode: BackupMode;
  /** Пользователь, в чьи данные писали. */
  userId: number;
  /** Автор снимка (может отличаться при переносе данных). */
  sourceUserId: number;
  /** Профиль обновлён (были непустые поля). */
  profileUpdated: boolean;
  tables: Record<string, TableImportStats>;
  /** Строки, которые не удалось вставить (конфликт UNIQUE, битая ссылка). */
  skipped: Array<{ table: string; reason: string }>;
  /** Неразрушающие замечания: обнулённые (но nullable) ссылки, лишние таблицы. */
  warnings: string[];
}

/** Ошибка формата бэкапа — до записи в БД. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

// ---------------------------------------------------------------------------
// Инфраструктура
// ---------------------------------------------------------------------------

/** Идентификатор таблицы/колонки в кавычках: только из наших же TableDef. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function joinSql(parts: readonly Sql[], separator: string): Sql {
  const first = parts[0];
  if (!first) throw new BackupError('backup: cannot join an empty sql list');
  return parts
    .slice(1)
    .reduce<Sql>((acc, part) => sql`${acc}${sql.raw(separator)}${part}`, first);
}

function assertUserId(userId: number): number {
  if (typeof userId !== 'number' || !Number.isFinite(userId)) {
    throw new BackupError('backup: userId is required');
  }
  return userId;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Положительный целочисленный id из любого представления; иначе `null`. */
function toId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

/** Идентификатор для ремапа ссылок: число или UUID-строка. */
function toIdKey(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    if (Number.isInteger(num) && String(num) === trimmed) return num;
    return trimmed;
  }
  return null;
}

/** Значение из JSON → значение, пригодное для параметра SQL. */
function toSqlValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** Человекочитаемая причина отказа строки. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const text = error.message.trim();
    return text === '' ? error.name : text;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

/** Профиль пользователя: только переживающие перенос колонки. */
async function exportProfile(userId: number): Promise<BackupRow | null> {
  const row = await db.get<BackupRow>(sql`
    SELECT ${sql.raw(PROFILE_COLUMNS.map(quoteIdent).join(', '))}
      FROM users WHERE id = ${userId} LIMIT 1
  `);
  if (!row) return null;
  const profile: BackupRow = {};
  for (const column of PROFILE_COLUMNS) profile[column] = row[column] ?? null;
  return profile;
}

/** Есть ли у таблицы автоинкрементный `id` (для стабильного порядка строк). */
function hasAutoId(tableName: string): boolean {
  return getTableDef(tableName).columns.id !== undefined;
}

/** Полный снимок данных пользователя. */
export async function exportUserData(userId: number): Promise<BackupFile> {
  const uid = assertUserId(userId);

  const profile = await exportProfile(uid);
  const tables: Record<string, BackupRow[]> = {};
  const counts: Record<string, number> = {};

  for (const tableName of BACKUP_TABLES) {
    // Порядок строк фиксирован: по id там, где он есть (иначе — как вернула БД).
    const order = hasAutoId(tableName) ? sql` ORDER BY id` : sql.raw('');
    const rows = await db.all<BackupRow>(sql`
      SELECT * FROM ${sql.raw(quoteIdent(tableName))}
       WHERE user_id = ${uid}${order}
    `);
    tables[tableName] = rows;
    counts[tableName] = rows.length;
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: nowIso(),
    userId: uid,
    profile,
    tables,
    counts,
  };
}

/** Снимок в строку JSON — то, что уходит пользователю файлом. */
export function stringifyBackup(backup: BackupFile, pretty = false): string {
  return JSON.stringify(backup, null, pretty ? 2 : 0);
}

/** Экспорт сразу в JSON-строку (частый случай: отдать файл в бот). */
export async function exportUserDataJson(userId: number, pretty = false): Promise<string> {
  return stringifyBackup(await exportUserData(userId), pretty);
}

// ---------------------------------------------------------------------------
// Валидация
// ---------------------------------------------------------------------------

/**
 * Разбирает и проверяет бэкап. Бросает `BackupError` на битом JSON, чужом
 * формате или несовместимой (более новой) версии. Неизвестные будущие таблицы
 * не ломают импорт старым кодом — они отбрасываются.
 */
export function parseBackupFile(input: unknown): BackupFile {
  let raw: unknown = input;

  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      throw new BackupError(`backup: invalid JSON (${reasonOf(error)})`);
    }
  }

  if (!isPlainObject(raw)) throw new BackupError('backup: file must be a JSON object');

  const format = raw.format;
  if (format !== BACKUP_FORMAT) {
    throw new BackupError(`backup: unknown format ${JSON.stringify(format ?? null)}`);
  }

  const version = toId(raw.version);
  if (version === null || version < 1) throw new BackupError('backup: missing version');
  if (version > BACKUP_VERSION) {
    throw new BackupError(`backup: version ${version} is newer than supported ${BACKUP_VERSION}`);
  }

  if (!isPlainObject(raw.tables)) throw new BackupError('backup: "tables" must be an object');

  const tables: Record<string, BackupRow[]> = {};
  for (const [tableName, rows] of Object.entries(raw.tables)) {
    if (!Array.isArray(rows)) throw new BackupError(`backup: table "${tableName}" must be an array`);
    tables[tableName] = rows.filter(isPlainObject);
  }

  const profile = isPlainObject(raw.profile) ? raw.profile : null;
  const sourceUserId = toId(raw.userId);
  const fxRates = Array.isArray((raw as any).fx_rates)
    ? ((raw as any).fx_rates as unknown[]).filter(isPlainObject)
    : undefined;

  return {
    format: BACKUP_FORMAT,
    version,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    userId: sourceUserId ?? 0,
    profile,
    tables,
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    ...(fxRates ? { fx_rates: fxRates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Ремап ссылок
// ---------------------------------------------------------------------------

interface RefRule {
  column: string;
  /** Таблица, на которую смотрит ссылка (для `dynamic` — вычисляется по строке). */
  table: string;
  /** Ссылка обязательна: не нашли цель — строку пропускаем. */
  required?: boolean;
  /** Ссылка на свою же таблицу: пишется вторым проходом. */
  self?: boolean;
  /** Полиморфная ссылка (`mentions.source_id`): таблица зависит от `source_type`. */
  dynamic?: boolean;
}

/**
 * Все внешние ссылки юзерских таблиц. Совпадает со схемой `tables.ts`:
 * FK на платформе запрещены, поэтому целостность держит импорт.
 */
const REF_RULES: Readonly<Record<string, readonly RefRule[]>> = {
  task_subcategories: [{ column: 'category_id', table: 'task_categories', required: true }],
  tasks: [
    { column: 'category_id', table: 'task_categories' },
    { column: 'subcategory_id', table: 'task_subcategories' },
    { column: 'parent_id', table: 'tasks', self: true },
  ],
  transactions: [
    { column: 'account_id', table: 'accounts', required: true },
    { column: 'to_account_id', table: 'accounts' },
    { column: 'category_id', table: 'fin_categories' },
  ],
  budgets: [{ column: 'category_id', table: 'fin_categories', required: true }],
  liabilities: [{ column: 'account_id', table: 'accounts' }],
  notes: [
    { column: 'source_message_id', table: 'messages' },
    { column: 'merged_into', table: 'notes', self: true },
  ],
  mentions: [
    { column: 'entity_id', table: 'entities', required: true },
    { column: 'source_id', table: 'mentions', dynamic: true },
  ],
  relations: [
    { column: 'subject_id', table: 'entities', required: true },
    { column: 'object_id', table: 'entities', required: true },
    { column: 'source_id', table: 'entities' },
  ],
  medication_logs: [{ column: 'medication_id', table: 'medications', required: true }],
};

/** `mentions.source_type` → таблица, в которой лежит `source_id`. */
const MENTION_SOURCE_TABLES: Readonly<Record<string, BackupTableName>> = {
  note: 'notes',
  message: 'messages',
  transaction: 'transactions',
  task: 'tasks',
};

type IdMap = Map<string | number, number>;

interface DeferredRef {
  table: string;
  column: string;
  newId: number;
  oldValue: string | number;
}

interface PreparedRow {
  values: Record<string, unknown>;
  deferred: Array<{ column: string; oldValue: string | number }>;
}

// ---------------------------------------------------------------------------
// Импорт
// ---------------------------------------------------------------------------

/** Собирает значения строки: whitelist колонок, `user_id` целевого юзера, ремап ссылок. */
function prepareRow(
  tableName: string,
  row: BackupRow,
  uid: number,
  maps: ReadonlyMap<string, IdMap>,
  warnings: string[],
): PreparedRow | { skip: string } {
  const def = getTableDef(tableName);
  const values: Record<string, unknown> = {};

  for (const column of Object.keys(row)) {
    if (column === 'id' || column === 'user_id') continue;
    if (!Object.hasOwn(def.columns, column)) continue;
    values[column] = toSqlValue(row[column]);
  }

  // Конвертация полей-сумм из float в cents (при импорте с Supabase/старых бэкапов)
  if (tableName === 'accounts') {
    if (row.current_balance !== undefined && values.current_balance_cents === undefined) {
      values.current_balance_cents = Math.round(Number(row.current_balance) * 100);
    }
    if (row.initial_balance !== undefined && values.initial_balance_cents === undefined) {
      values.initial_balance_cents = Math.round(Number(row.initial_balance) * 100);
    }
  } else if (tableName === 'transactions') {
    if (row.amount !== undefined && values.amount_cents === undefined) {
      values.amount_cents = Math.round(Number(row.amount) * 100);
    }
    if (row.amount_eur !== undefined && values.amount_eur_cents === undefined) {
      values.amount_eur_cents = Math.round(Number(row.amount_eur) * 100);
    }
  } else if (tableName === 'liabilities') {
    if (row.amount !== undefined && values.amount_cents === undefined) {
      values.amount_cents = Math.round(Number(row.amount) * 100);
    }
    if (row.amount_eur !== undefined && values.amount_eur_cents === undefined) {
      values.amount_eur_cents = Math.round(Number(row.amount_eur) * 100);
    }
    if (row.monthly_payment !== undefined && values.monthly_payment_cents === undefined) {
      values.monthly_payment_cents = Math.round(Number(row.monthly_payment) * 100);
    }
  } else if (tableName === 'budgets') {
    if (row.limit_amount_eur !== undefined && values.limit_amount_eur_cents === undefined) {
      values.limit_amount_eur_cents = Math.round(Number(row.limit_amount_eur) * 100);
    }
  } else if (tableName === 'tasks') {
    if (row.description !== undefined && values.notes === undefined) {
      values.notes = toSqlValue(row.description);
    }
    if (row.due_date !== undefined && values.due_at === undefined) {
      values.due_at = toSqlValue(row.due_date);
    }
  }

  // Изоляция: куда бы ни указывал файл, пишем в целевого пользователя.
  values.user_id = uid;

  const deferred: PreparedRow['deferred'] = [];

  for (const rule of REF_RULES[tableName] ?? []) {
    const oldValue = toIdKey(row[rule.column]);
    if (oldValue === null) {
      if (rule.column in values) values[rule.column] = null;
      continue;
    }

    if (rule.dynamic) {
      const sourceType = typeof row.source_type === 'string' ? row.source_type : '';
      const targetTable = MENTION_SOURCE_TABLES[sourceType];
      const mapped = targetTable ? maps.get(targetTable)?.get(oldValue) : undefined;
      if (mapped === undefined) {
        values[rule.column] = null;
        if (targetTable) {
          warnings.push(`${tableName}.${rule.column}: source ${sourceType}#${oldValue} not found, set NULL`);
        } else {
          warnings.push(`${tableName}.${rule.column}: unknown source_type "${sourceType}", set NULL`);
        }
        continue;
      }
      values[rule.column] = mapped;
      continue;
    }

    if (rule.self) {
      // Своя таблица: id появится только после вставки — вторым проходом.
      deferred.push({ column: rule.column, oldValue });
      values[rule.column] = null;
      continue;
    }

    const mapped = maps.get(rule.table)?.get(oldValue);
    if (mapped === undefined) {
      if (rule.required) {
        return { skip: `${rule.column} → ${rule.table}.#${oldValue} not found` };
      }
      values[rule.column] = null;
      warnings.push(`${tableName}.${rule.column}: ${rule.table}.#${oldValue} not found, set NULL`);
      continue;
    }
    values[rule.column] = mapped;
  }

  return { values, deferred };
}

/** Одна вставка с whitelist колонок; идентификаторы — через `sql.raw`. */
async function insertRow(tableName: string, values: BackupRow): Promise<number> {
  const columns = Object.keys(values);
  if (columns.length === 0) throw new BackupError(`backup: nothing to insert into "${tableName}"`);

  const valuesSql = columns.map((column) => sql`${values[column]}`);
  const result: RunResult = await db.run(sql`
    INSERT INTO ${sql.raw(quoteIdent(tableName))}
      (${sql.raw(columns.map(quoteIdent).join(', '))})
    VALUES (${joinSql(valuesSql, ', ')})
  `);

  return Number(result.lastInsertRowid ?? 0);
}

/** Профиль: `ensureUser` (строка должна быть) + частичный патч непустыми полями. */
async function importProfile(
  uid: number,
  profile: BackupRow | null,
  docChaptersRows?: BackupRow[],
): Promise<boolean> {
  await ensureUser(uid);
  if (!profile) return false;

  const patch: UserPatch = {};

  if (Object.hasOwn(profile, 'name') && (profile.name === null || typeof profile.name === 'string')) {
    patch.name = profile.name as string | null;
  }
  if (typeof profile.base_currency === 'string' && profile.base_currency.trim() !== '') {
    patch.baseCurrency = profile.base_currency;
  }
  if (typeof profile.timezone === 'string' && profile.timezone.trim() !== '') {
    patch.timezone = profile.timezone;
  }
  if (typeof profile.summary_time === 'string' && profile.summary_time.trim() !== '') {
    patch.summaryTime = profile.summary_time;
  }
  if (profile.low_stimulation_mode !== undefined && profile.low_stimulation_mode !== null) {
    const raw = profile.low_stimulation_mode;
    patch.lowStimulationMode =
      raw === true || raw === 1 || raw === '1' || raw === 'true' ? true : false;
  }

  let updated = false;
  if (Object.keys(patch).length > 0) {
    const res = await updateUser(uid, patch);
    if (res !== null) updated = true;
  }

  if (typeof profile.custom_instructions === 'string' && profile.custom_instructions.trim() !== '') {
    const hasDocChapter = Array.isArray(docChaptersRows) && docChaptersRows.some((r) => r.slug === '07_custom_instructions');
    if (!hasDocChapter) {
      const now = nowIso();
      await db.run(sql`
        INSERT INTO doc_chapters (user_id, slug, filename, title, content, is_pinned, created_at, updated_at)
        VALUES (${uid}, '07_custom_instructions', '07_custom_instructions.md', 'Персонализация', ${profile.custom_instructions}, 1, ${now}, ${now})
        ON CONFLICT (user_id, slug) DO UPDATE SET
          content = excluded.content,
          is_pinned = 1,
          updated_at = excluded.updated_at
      `);
      updated = true;
    }
  }

  if (typeof profile.role === 'string' && profile.role.trim() !== '') {
    const now = nowIso();
    await db.run(sql`
      INSERT INTO kv ("key", value, updated_at)
      VALUES (${`user_role_${uid}`}, ${profile.role}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
  }

  return updated;
}

/** Удаление всех строк юзера в обратном порядке зависимостей (режим `replace`). */
async function clearUserData(uid: number): Promise<void> {
  for (const tableName of [...BACKUP_TABLES].reverse()) {
    await db.run(sql`
      DELETE FROM ${sql.raw(quoteIdent(tableName))} WHERE user_id = ${uid}
    `);
  }
}

/**
 * Импорт бэкапа в данные пользователя.
 *
 * Все операции идут одной транзакцией: в `replace` это защищает от «стёрли,
 * но не долили», в `merge` — от полуприменённого файла. Строки, которые не
 * вставились (UNIQUE-конфликт с уже существующими данными, обязательная
 * ссылка на отсутствующую цель), не отменяют импорт: они попадают в `skipped`.
 */
export async function importBackup(
  userId: number,
  input: unknown,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const uid = assertUserId(userId);
  const backup = parseBackupFile(input);
  const mode: BackupMode = options.mode ?? 'merge';

  const result: ImportResult = {
    mode,
    userId: uid,
    sourceUserId: backup.userId,
    profileUpdated: false,
    tables: {},
    skipped: [],
    warnings: [],
  };

  const maps = new Map<string, IdMap>();
  for (const tableName of BACKUP_TABLES) maps.set(tableName, new Map<string | number, number>());

  // Таблицы, которых нет в этой версии кода (более новый бэкап) — игнорируем.
  for (const tableName of Object.keys(backup.tables)) {
    if (tableName === 'fx_rates') continue;
    if (!(BACKUP_TABLES as readonly string[]).includes(tableName)) {
      result.warnings.push(`unknown table "${tableName}" ignored`);
    }
  }

  await withTransaction(async () => {
    result.profileUpdated = await importProfile(uid, backup.profile, backup.tables.doc_chapters);

    if (mode === 'replace') await clearUserData(uid);

    for (const tableName of BACKUP_TABLES) {
      const stats: TableImportStats = { inserted: 0, skipped: 0 };
      result.tables[tableName] = stats;

      const rows = backup.tables[tableName] ?? [];
      if (rows.length === 0) continue;

      if (tableName === 'agent_state') {
        result.tables[tableName] = await importAgentState(uid, rows, result);
        continue;
      }

      const idMap = maps.get(tableName) as IdMap;
      const deferred: DeferredRef[] = [];

      for (const row of rows) {
        const prepared = prepareRow(tableName, row, uid, maps, result.warnings);
        if ('skip' in prepared) {
          stats.skipped += 1;
          result.skipped.push({ table: tableName, reason: prepared.skip });
          continue;
        }

        let newId: number;
        try {
          newId = await insertRow(tableName, prepared.values);
        } catch (error) {
          stats.skipped += 1;
          result.skipped.push({ table: tableName, reason: reasonOf(error) });
          continue;
        }

        const oldId = toIdKey(row.id);
        if (oldId !== null && newId > 0) idMap.set(oldId, newId);
        for (const ref of prepared.deferred) {
          deferred.push({ table: tableName, column: ref.column, newId, oldValue: ref.oldValue });
        }
        stats.inserted += 1;
      }

      // Второй проход: ссылки на свою таблицу (родитель мог быть ниже в файле).
      for (const ref of deferred) {
        const mapped = idMap.get(ref.oldValue);
        if (mapped === undefined) {
          result.warnings.push(
            `${ref.table}.${ref.column}: #${ref.oldValue} not found, set NULL (row #${ref.newId})`,
          );
          continue;
        }
        await db.run(sql`
          UPDATE ${sql.raw(quoteIdent(ref.table))}
             SET ${sql`${sql.raw(quoteIdent(ref.column))} = ${mapped}`}
           WHERE id = ${ref.newId} AND user_id = ${uid}
        `);
      }
    }

    // FX rates: support both tables.fx_rates and top-level fx_rates
    const fxRows = backup.tables.fx_rates ?? backup.fx_rates ?? [];
    if (Array.isArray(fxRows) && fxRows.length > 0) {
      let fxCount = 0;
      for (const row of fxRows) {
        if (row && typeof row.date === 'string' && typeof row.base === 'string' && row.rates !== undefined) {
          const ratesStr = typeof row.rates === 'string' ? row.rates : JSON.stringify(row.rates);
          const updated = typeof row.updated_at === 'string' ? row.updated_at : nowIso();
          await db.run(sql`
            INSERT INTO fx_rates (date, base, rates, updated_at)
            VALUES (${row.date}, ${row.base}, ${ratesStr}, ${updated})
            ON CONFLICT (date, base) DO UPDATE SET
              rates = excluded.rates,
              updated_at = excluded.updated_at
          `);
          fxCount++;
        }
      }
      result.tables['fx_rates'] = { inserted: fxCount, skipped: 0 };
    }
  });

  return result;
}

/**
 * `agent_state` — натуральный PK (`user_id`), ремапить нечего. В `merge` поток
 * диалога заменяется бэкапным: два thread'а не склеить, а бэкап — это снимок
 * состояния, который пользователь и хотел вернуть.
 */
async function importAgentState(
  uid: number,
  rows: BackupRow[],
  result: ImportResult,
): Promise<TableImportStats> {
  const stats: TableImportStats = { inserted: 0, skipped: 0 };
  const row = rows.find((item) => typeof item.thread === 'string' || Array.isArray(item.thread));
  if (!row) {
    stats.skipped = rows.length;
    for (let i = 0; i < rows.length; i += 1) {
      result.skipped.push({ table: 'agent_state', reason: 'row has no thread' });
    }
    return stats;
  }

  const thread =
    typeof row.thread === 'string' ? row.thread : JSON.stringify(row.thread ?? []);
  const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : nowIso();

  await db.run(sql`
    INSERT INTO agent_state (user_id, thread, updated_at)
    VALUES (${uid}, ${thread}, ${updatedAt})
    ON CONFLICT (user_id) DO UPDATE SET
      thread = excluded.thread,
      updated_at = excluded.updated_at
  `);

  stats.inserted = 1;
  return stats;
}

// ---------------------------------------------------------------------------
// Восстановление из файла (частый сценарий «пользователь прислал документ»)
// ---------------------------------------------------------------------------

/**
 * Импорт из сырого текста файла (то, что присылают ботом). Ошибку формата
 * бросает как `BackupError` — вызывающий решает, что сказать пользователю.
 */
export async function restoreFromJson(
  userId: number,
  text: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  return importBackup(userId, text, options);
}
