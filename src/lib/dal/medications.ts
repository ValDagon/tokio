/**
 * DAL: медикаменты и журнал приёмов.
 *
 * Две таблицы (§2.4):
 *  - `medications` — расписание пользователя (`times` — json-массив `HH:MM`,
 *    `frequency`, `instructions`, опциональный `stock_count` + `refill_threshold`);
 *  - `medication_logs` — факты приёма/пропуска на конкретную дату и время.
 *
 * Инварианты, которые держит этот модуль (в upstream их держал Postgres
 * constraint `UNIQUE (medication_id, date, scheduled_time)`):
 *  - внешних ключей на платформе нет, поэтому владение медикаментом проверяется
 *    вручную (`user_id` в WHERE) до любой записи в лог;
 *  - UNIQUE в `medication_logs` глобальный, а не по пользователю — поэтому все
 *    запросы к логам дополнительно ограничены `user_id`;
 *  - двойной «принял» идемпотентен: запись в лог делается `INSERT OR IGNORE`
 *    (первая запись побеждает), остаток списывается только когда строка лога
 *    реально создана — иначе повторный тап по кнопке съедал бы упаковку;
 *  - `GREATEST(0, stock_count - 1)` из upstream = `max(0, …)` в SQLite, чтобы
 *    остаток никогда не уходил в минус.
 *
 * Даты приёма — локальные для пользователя (`YYYY-MM-DD`); вызывающий передаёт
 * их явно (`dateKey(now, user.timezone)`), по умолчанию берётся дата в UTC.
 */

import { db, sql } from 'sdk/db';
import type {
  IsoDate,
  IsoTimestamp,
  MedicationFrequency,
  MedicationLogRow,
  MedicationLogStatus,
  MedicationRow,
  TimeOfDay,
} from '../../types.js';
import { dateKey, formatTimeOfDay, nowIso, parseTimeOfDay } from '../utils.js';

/** Расписание по умолчанию, если пользователь не указал ни одного времени. */
export const DEFAULT_TIMES: readonly TimeOfDay[] = ['09:00'];

/** Частота по умолчанию (как в upstream `create_user_medication`). */
export const DEFAULT_FREQUENCY: MedicationFrequency = 'daily';

// ---------------------------------------------------------------------------
// Нормализация входа
// ---------------------------------------------------------------------------

/** Строгий разбор времени: `'8:05'` → `'08:05'`, мусор — ошибка. */
export function normalizeTimeOfDay(value: string): TimeOfDay {
  const minutes = parseTimeOfDay(String(value ?? ''));
  if (minutes === null) throw new Error(`medications: invalid time "${String(value)}"`);
  return formatTimeOfDay(minutes);
}

/**
 * Нормализует список времён приёма: `HH:MM`, без дублей, по возрастанию.
 * Пустой список → `['09:00']` (как в upstream).
 */
export function normalizeTimes(times: readonly string[] | null | undefined): TimeOfDay[] {
  const seen = new Set<TimeOfDay>();
  for (const raw of times ?? []) {
    seen.add(normalizeTimeOfDay(raw));
  }
  if (seen.size === 0) return [...DEFAULT_TIMES];
  return [...seen].sort();
}

/** Мягкий разбор json-колонки `times`: мусор пропускаем, пусто → дефолт. */
function parseTimes(raw: unknown): TimeOfDay[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = null;
    }
  }
  const kept: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      if (parseTimeOfDay(item) === null) continue;
      kept.push(item.trim());
    }
  }
  return normalizeTimes(kept);
}

/** Любая дата (`Date`, полный ISO, `YYYY-MM-DD`) → `YYYY-MM-DD`. */
export function normalizeDate(date?: IsoDate | Date | null): IsoDate {
  if (date === undefined || date === null) return dateKey();
  if (date instanceof Date) return dateKey(date);
  const day = String(date).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`medications: invalid date "${String(date)}"`);
  }
  return day;
}

// ---------------------------------------------------------------------------
// Строки БД ↔ доменные объекты
// ---------------------------------------------------------------------------

interface MedicationDbRow {
  id: number;
  user_id: number;
  name: string;
  dosage: string | null;
  times: string | null;
  frequency: string | null;
  instructions: string | null;
  is_active: number;
  stock_count: number | null;
  refill_threshold: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface MedicationLogDbRow {
  id: number;
  user_id: number;
  medication_id: number;
  scheduled_time: string;
  date: string;
  status: string;
  taken_at: string | null;
  created_at: string | null;
}

const MEDICATION_COLUMNS = `id, user_id, name, dosage, times, frequency, instructions,
  is_active, stock_count, refill_threshold, created_at, updated_at`;

const LOG_COLUMNS = `id, user_id, medication_id, scheduled_time, date, status, taken_at, created_at`;

function mapMedication(row: MedicationDbRow): MedicationRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    dosage: row.dosage ?? '',
    times: parseTimes(row.times),
    frequency: (row.frequency ?? DEFAULT_FREQUENCY) as MedicationFrequency,
    instructions: row.instructions ?? null,
    isActive: Boolean(row.is_active),
    stockCount: row.stock_count === null || row.stock_count === undefined ? null : Number(row.stock_count),
    refillThreshold: Number(row.refill_threshold ?? 0),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function mapLog(row: MedicationLogDbRow): MedicationLogRow {
  return {
    id: row.id,
    userId: row.user_id,
    medicationId: row.medication_id,
    scheduledTime: row.scheduled_time,
    date: row.date,
    status: row.status as MedicationLogStatus,
    takenAt: row.taken_at ?? null,
    createdAt: row.created_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

/** Список медикаментов пользователя (по умолчанию только активные). */
export async function listMedications(
  userId: number,
  opts: { includeInactive?: boolean } = {},
): Promise<MedicationRow[]> {
  const activeOnly = opts.includeInactive ? sql`` : sql` AND is_active = 1`;
  const rows = await db.all<MedicationDbRow>(sql`
    SELECT ${sql.raw(MEDICATION_COLUMNS)}
      FROM medications
     WHERE user_id = ${userId}${activeOnly}
     ORDER BY name COLLATE NOCASE ASC, id ASC
  `);
  return rows.map(mapMedication);
}

/** Медикамент по id — только если принадлежит пользователю. */
export async function getMedication(
  userId: number,
  medicationId: number,
): Promise<MedicationRow | null> {
  const row = await db.get<MedicationDbRow>(sql`
    SELECT ${sql.raw(MEDICATION_COLUMNS)}
      FROM medications
     WHERE id = ${medicationId} AND user_id = ${userId}
     LIMIT 1
  `);
  return row ? mapMedication(row) : null;
}

/** Логи приёмов пользователя за дату (без привязки к конкретному медикаменту). */
export async function listLogs(
  userId: number,
  date?: IsoDate | Date | null,
): Promise<MedicationLogRow[]> {
  const rows = await db.all<MedicationLogDbRow>(sql`
    SELECT ${sql.raw(LOG_COLUMNS)}
      FROM medication_logs
     WHERE user_id = ${userId} AND date = ${normalizeDate(date)}
     ORDER BY scheduled_time ASC, id ASC
  `);
  return rows.map(mapLog);
}

/** Одна доза: что принимать, когда и что уже отмечено. */
export interface MedicationDose {
  medication: MedicationRow;
  scheduledTime: TimeOfDay;
  /** `pending`, если записи в логе ещё нет. */
  status: MedicationLogStatus;
  takenAt: IsoTimestamp | null;
}

/**
 * Дневная карта приёмов: расписание активных медикаментов × логи за дату.
 * Время без записи в логе — `pending` (так же строит `get_user_medications`).
 */
export async function listDoses(
  userId: number,
  date?: IsoDate | Date | null,
): Promise<MedicationDose[]> {
  const day = normalizeDate(date);
  const [medications, logs] = await Promise.all([
    listMedications(userId),
    listLogs(userId, day),
  ]);

  const byKey = new Map<string, MedicationLogRow>();
  for (const log of logs) byKey.set(`${log.medicationId}|${log.scheduledTime}`, log);

  const doses: MedicationDose[] = [];
  for (const medication of medications) {
    for (const scheduledTime of medication.times) {
      const log = byKey.get(`${medication.id}|${scheduledTime}`);
      doses.push({
        medication,
        scheduledTime,
        status: log ? log.status : 'pending',
        takenAt: log ? log.takenAt : null,
      });
    }
  }

  doses.sort((a, b) => {
    if (a.scheduledTime !== b.scheduledTime) return a.scheduledTime < b.scheduledTime ? -1 : 1;
    return a.medication.name.localeCompare(b.medication.name);
  });
  return doses;
}

// ---------------------------------------------------------------------------
// Запись: расписание
// ---------------------------------------------------------------------------

export interface CreateMedicationInput {
  name: string;
  dosage?: string;
  times?: readonly string[];
  frequency?: MedicationFrequency;
  instructions?: string | null;
  /** `null` — остаток не отслеживается. */
  stockCount?: number | null;
  refillThreshold?: number;
}

/** Создаёт расписание приёма. Времена нормализуются, пусто → `['09:00']`. */
export async function createMedication(
  userId: number,
  input: CreateMedicationInput,
): Promise<MedicationRow> {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('medications.createMedication: name is required');

  const now = nowIso();
  const times = normalizeTimes(input.times);
  const stock = input.stockCount === undefined || input.stockCount === null ? null : Math.max(0, Math.trunc(input.stockCount));
  const threshold = input.refillThreshold === undefined ? 0 : Math.max(0, Math.trunc(input.refillThreshold));

  const created = await db.run(sql`
    INSERT INTO medications (
      user_id, name, dosage, times, frequency, instructions,
      is_active, stock_count, refill_threshold, created_at, updated_at
    ) VALUES (
      ${userId}, ${name}, ${String(input.dosage ?? '').trim()}, ${JSON.stringify(times)},
      ${input.frequency ?? DEFAULT_FREQUENCY}, ${input.instructions ?? null},
      1, ${stock}, ${threshold}, ${now}, ${now}
    )
    RETURNING ${sql.raw(MEDICATION_COLUMNS)}
  `);

  const row = created.rows[0] as unknown as MedicationDbRow | undefined;
  if (!row) throw new Error('medications.createMedication: insert returned no row');
  return mapMedication(row);
}

export interface UpdateMedicationInput {
  name?: string;
  dosage?: string;
  times?: readonly string[];
  frequency?: MedicationFrequency;
  instructions?: string | null;
  isActive?: boolean;
  stockCount?: number | null;
  refillThreshold?: number;
}

/**
 * Частичное обновление расписания. `undefined` — поле не трогаем,
 * `null` — осознанно пишем NULL (для `instructions` и `stockCount`).
 *
 * Читаем-мержим-пишем: собирать динамический `SET` из вложенных sql-фрагментов
 * нельзя (нумерация параметров в таких конструкциях ломается), поэтому патч
 * накладывается в JS на текущую строку, а в БД уходит один UPDATE по всем
 * колонкам.
 */
export async function updateMedication(
  userId: number,
  medicationId: number,
  patch: UpdateMedicationInput,
): Promise<MedicationRow | null> {
  const current = await getMedication(userId, medicationId);
  if (!current) return null;

  let name = current.name;
  if (patch.name !== undefined) {
    name = String(patch.name).trim();
    if (!name) throw new Error('medications.updateMedication: name cannot be empty');
  }

  const dosage = patch.dosage === undefined ? current.dosage : String(patch.dosage).trim();
  const times = patch.times === undefined ? current.times : normalizeTimes(patch.times);
  const frequency = patch.frequency ?? current.frequency;
  const instructions = patch.instructions === undefined ? current.instructions : patch.instructions;
  const isActive = patch.isActive === undefined ? current.isActive : patch.isActive;
  const stockCount =
    patch.stockCount === undefined
      ? current.stockCount
      : patch.stockCount === null
        ? null
        : Math.max(0, Math.trunc(patch.stockCount));
  const refillThreshold =
    patch.refillThreshold === undefined
      ? current.refillThreshold
      : Math.max(0, Math.trunc(patch.refillThreshold));

  const updated = await db.run(sql`
    UPDATE medications
       SET name = ${name},
           dosage = ${dosage},
           times = ${JSON.stringify(times)},
           frequency = ${frequency},
           instructions = ${instructions},
           is_active = ${isActive ? 1 : 0},
           stock_count = ${stockCount},
           refill_threshold = ${refillThreshold},
           updated_at = ${nowIso()}
     WHERE id = ${medicationId} AND user_id = ${userId}
    RETURNING ${sql.raw(MEDICATION_COLUMNS)}
  `);

  const row = updated.rows[0] as unknown as MedicationDbRow | undefined;
  return row ? mapMedication(row) : null;
}

/** Жёсткое удаление расписания (логи приёмов остаются как история). */
export async function deleteMedication(userId: number, medicationId: number): Promise<boolean> {
  const result = await db.run(sql`
    DELETE FROM medications WHERE id = ${medicationId} AND user_id = ${userId}
  `);
  return result.rowsAffected > 0;
}

// ---------------------------------------------------------------------------
// Запись: приёмы
// ---------------------------------------------------------------------------

export interface MedicationAction {
  /** Статус, который реально лежит в логе (первая запись побеждает). */
  status: MedicationLogStatus;
  medication: MedicationRow;
  log: MedicationLogRow;
  /** `null` — остаток не отслеживается. */
  remainingStock: number | null;
  refillThreshold: number;
  /** Пора покупать новую упаковку (остаток ≤ порога). */
  needsRefill: boolean;
  /** Готовая строка для ответа пользователю (пустая для пропуска). */
  notice: string;
}

function buildNotice(remaining: number | null, threshold: number): { notice: string; needsRefill: boolean } {
  if (remaining === null) return { notice: '', needsRefill: false };
  if (remaining <= threshold) {
    return {
      notice: `⚠️ Осталось всего ${remaining} шт.! Пора купить новую упаковку в аптеке.`,
      needsRefill: true,
    };
  }
  return { notice: `остаток: ${remaining} шт.`, needsRefill: false };
}

async function readLog(
  userId: number,
  medicationId: number,
  scheduledTime: TimeOfDay,
  day: IsoDate,
): Promise<MedicationLogRow> {
  const row = await db.get<MedicationLogDbRow>(sql`
    SELECT ${sql.raw(LOG_COLUMNS)}
      FROM medication_logs
     WHERE user_id = ${userId}
       AND medication_id = ${medicationId}
       AND date = ${day}
       AND scheduled_time = ${scheduledTime}
     LIMIT 1
  `);
  if (!row) throw new Error('medications: log row disappeared after write');
  return mapLog(row);
}

/**
 * Отмечает приём. Идемпотентно: повторный вызов не создаёт вторую строку и не
 * списывает остаток второй раз. Возвращает `null`, если медикамент не найден
 * или принадлежит другому пользователю.
 *
 * Остаток списывается только при создании новой строки лога, и только если
 * `stock_count` вообще отслеживается (`IS NOT NULL`), — как в upstream.
 */
export async function takeMedication(
  userId: number,
  medicationId: number,
  scheduledTime: string,
  date?: IsoDate | Date | null,
): Promise<MedicationAction | null> {
  const medication = await getMedication(userId, medicationId);
  if (!medication) return null;

  const time = normalizeTimeOfDay(scheduledTime);
  const day = normalizeDate(date);
  const now = nowIso();

  const inserted = await db.run(sql`
    INSERT OR IGNORE INTO medication_logs (
      user_id, medication_id, scheduled_time, date, status, taken_at, created_at
    ) VALUES (${userId}, ${medicationId}, ${time}, ${day}, 'taken', ${now}, ${now})
  `);
  const created = inserted.rowsAffected > 0;

  let remaining = medication.stockCount;
  let threshold = medication.refillThreshold;

  if (created && medication.stockCount !== null) {
    const updated = await db.get<{ stock_count: number; refill_threshold: number | null }>(sql`
      UPDATE medications
         SET stock_count = max(0, stock_count - 1), updated_at = ${now}
       WHERE id = ${medicationId} AND user_id = ${userId} AND stock_count IS NOT NULL
       RETURNING stock_count, refill_threshold
    `);
    if (updated) {
      remaining = Number(updated.stock_count);
      threshold = Number(updated.refill_threshold ?? medication.refillThreshold);
    }
  }

  const log = await readLog(userId, medicationId, time, day);
  const shown = created ? remaining : medication.stockCount;
  const { notice, needsRefill } = buildNotice(shown, threshold);

  const fresh = (await getMedication(userId, medicationId)) ?? medication;

  return {
    status: log.status,
    medication: fresh,
    log,
    remainingStock: shown,
    refillThreshold: threshold,
    needsRefill: log.status === 'taken' ? needsRefill : false,
    notice: log.status === 'taken' ? notice : '',
  };
}

/**
 * Отмечает пропуск. Идемпотентно, остаток не трогает.
 * Возвращает `null`, если медикамент не найден у пользователя.
 */
export async function skipMedication(
  userId: number,
  medicationId: number,
  scheduledTime: string,
  date?: IsoDate | Date | null,
): Promise<MedicationAction | null> {
  const medication = await getMedication(userId, medicationId);
  if (!medication) return null;

  const time = normalizeTimeOfDay(scheduledTime);
  const day = normalizeDate(date);
  const now = nowIso();

  await db.run(sql`
    INSERT OR IGNORE INTO medication_logs (
      user_id, medication_id, scheduled_time, date, status, created_at
    ) VALUES (${userId}, ${medicationId}, ${time}, ${day}, 'skipped', ${now})
  `);

  const log = await readLog(userId, medicationId, time, day);

  return {
    status: log.status,
    medication,
    log,
    remainingStock: medication.stockCount,
    refillThreshold: medication.refillThreshold,
    needsRefill: false,
    notice: '',
  };
}
