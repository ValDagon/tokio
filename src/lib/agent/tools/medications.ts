/**
 * Тулзы агента: аптечка и приёмы (SPEC §3 T13, паритет с
 * `backend/app/agent/tools/medications.py`).
 *
 * ADR-003: на границе DAL деньги — только INTEGER cents. Суммы в аргументах
 * тулз приходят десятичной строкой (паритет с upstream float-UX) и парсятся
 * через parseAmountToCents; в content/data — cents (int) или formatCents.
 * (В этом модуле денег нет, но правило общее для всех тулз T13.)
 *
 * Отличия от upstream (задокументированы осознанно, §8):
 *  - `add_medication` не подставляет upstream-дефолты (`instructions='после еды'`,
 *    `refill_threshold=5`) — работают DAL-дефолты (инструкция null, порог 0);
 *  - `log_medication_taken` без `notes`: в `medication_logs` нет такой колонки;
 *  - `delete_medication` удаляет только расписание — логи приёмов остаются
 *    историей (upstream удаляет и их).
 */

import type { MedicationRow } from '../../../types';
import type { UpdateMedicationInput } from '../../dal/medications';
import {
  createMedication,
  deleteMedication,
  listDoses,
  listMedications,
  skipMedication,
  takeMedication,
  updateMedication,
} from '../../dal/medications';
import { dateKey } from '../../utils';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry';

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

const FREQUENCIES: readonly string[] = ['daily', 'weekly', 'as_needed'];

/** Время приёма по умолчанию, если у лекарства пустое расписание (DEFAULT_TIMES в DAL). */
const FALLBACK_TIME = '09:00';

function fail(content: string): ToolOutcome {
  return { ok: false, content };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Целое из аргумента (число или строка); `null` — не разобрать. */
function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

/** Булево из аргумента (модель иногда присылает "true"/"false"). `null` — не разобрать. */
function asBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'да') return true;
    if (lower === 'false' || lower === '0' || lower === 'нет') return false;
  }
  return null;
}

/**
 * Список времён приёма: `undefined` — аргумент не задан; `null` — задан, но
 * невалиден (не массив строк / пусто).
 */
function asTimes(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  const kept: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) kept.push(trimmed);
  }
  return kept.length > 0 ? kept : null;
}

/**
 * Поиск лекарства по имени (паритет с upstream ILIKE-логикой): сначала точное
 * совпадение без регистра, иначе — вхождение подстроки.
 */
async function findMedicationsByName(
  ctx: ToolContext,
  query: string,
  opts: { includeInactive?: boolean } = {},
): Promise<MedicationRow[]> {
  const all = await listMedications(ctx.userId, { includeInactive: opts.includeInactive ?? false });
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const exact = all.filter((medication) => medication.name.trim().toLowerCase() === needle);
  if (exact.length > 0) return exact;
  return all.filter((medication) => medication.name.toLowerCase().includes(needle));
}

/** Единственное совпадение или готовый `ok:false`. */
function pickOne(matches: readonly MedicationRow[], query: string): MedicationRow | ToolOutcome {
  if (matches.length === 0) return fail(`Лекарство «${query}» не найдено.`);
  if (matches.length > 1) {
    const names = matches.map((medication) => medication.name).join(', ');
    return fail(`Найдено несколько: ${names}. Уточните имя.`);
  }
  return matches[0];
}

function isOutcome(value: MedicationRow | ToolOutcome): value is ToolOutcome {
  return typeof (value as ToolOutcome).ok === 'boolean' && typeof (value as ToolOutcome).content === 'string';
}

/** ` (осталось N шт.)` / ` (⚠️ осталось N шт.)`, если остаток отслеживается. */
function stockTag(medication: MedicationRow): string {
  if (medication.stockCount === null) return '';
  const low = medication.stockCount <= medication.refillThreshold;
  return low ? ` (⚠️ осталось ${medication.stockCount} шт.)` : ` (осталось ${medication.stockCount} шт.)`;
}

// ---------------------------------------------------------------------------
// add_medication
// ---------------------------------------------------------------------------

/**
 * Добавляет лекарство в расписание: название, дозировка, времена приёма,
 * частота, инструкция и (опционально) остаток в упаковке.
 */
async function addMedication(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const name = asText(args.name);
  if (!name) return fail('Укажите название лекарства (name).');

  const times = asTimes(args.times);
  if (times === null) {
    return fail('Времена приёма (times) — список строк вида "HH:MM", например ["09:00", "21:00"].');
  }

  let frequency: string | undefined;
  if (args.frequency !== undefined && args.frequency !== null) {
    const raw = asText(args.frequency);
    if (!raw || !FREQUENCIES.includes(raw.toLowerCase())) {
      return fail('frequency может быть "daily", "weekly" или "as_needed".');
    }
    frequency = raw.toLowerCase();
  }

  let stockCount: number | null | undefined;
  if (args.stock_count !== undefined && args.stock_count !== null) {
    const parsed = asInt(args.stock_count);
    if (parsed === null) return fail('stock_count должен быть целым числом.');
    stockCount = parsed;
  }

  let refillThreshold: number | undefined;
  if (args.refill_threshold !== undefined && args.refill_threshold !== null) {
    const parsed = asInt(args.refill_threshold);
    if (parsed === null) return fail('refill_threshold должен быть целым числом.');
    refillThreshold = parsed;
  }

  try {
    const medication = await createMedication(ctx.userId, {
      name,
      ...(args.dosage === undefined ? {} : { dosage: String(args.dosage ?? '').trim() }),
      ...(times === undefined ? {} : { times }),
      ...(frequency === undefined ? {} : { frequency: frequency as MedicationRow['frequency'] }),
      ...(args.instructions === undefined
        ? {}
        : { instructions: asText(args.instructions) }),
      ...(stockCount === undefined ? {} : { stockCount }),
      ...(refillThreshold === undefined ? {} : { refillThreshold }),
    });

    let content = `💊 Добавил лекарство: «${medication.name}»`;
    if (medication.dosage) content += ` ${medication.dosage}`;
    content += ` — приём: ${medication.times.join(', ')} (${medication.frequency})`;
    if (medication.stockCount !== null) {
      content += `, запас: ${medication.stockCount} шт.`;
      if (medication.stockCount <= medication.refillThreshold) {
        content += ` (порог пополнения: ${medication.refillThreshold} шт.)`;
      }
    }
    content += '.';

    return {
      ok: true,
      content,
      data: {
        medication_id: medication.id,
        name: medication.name,
        dosage: medication.dosage,
        times: [...medication.times],
        frequency: medication.frequency,
        stock_count: medication.stockCount,
        refill_threshold: medication.refillThreshold,
      },
    };
  } catch (error) {
    return fail(`Не удалось добавить лекарство: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// log_medication_taken
// ---------------------------------------------------------------------------

/**
 * Отмечает приём лекарства или пропуск за сегодня; списывает одну дозу из
 * остатка упаковки (если остаток отслеживается).
 */
async function logMedicationTaken(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.medication_name);
  if (!query) return fail('Укажите название лекарства (medication_name).');

  const rawStatus = args.status === undefined || args.status === null ? 'taken' : asText(args.status);
  const status = rawStatus?.toLowerCase();
  if (status !== 'taken' && status !== 'skipped') {
    return fail('status может быть "taken" (принял) или "skipped" (пропустил).');
  }

  try {
    const found = pickOne(await findMedicationsByName(ctx, query), query);
    if (isOutcome(found)) return found;

    const time = asText(args.scheduled_time) ?? found.times[0] ?? FALLBACK_TIME;
    const day = dateKey(ctx.now, ctx.timezone);

    const action =
      status === 'taken'
        ? await takeMedication(ctx.userId, found.id, time, day)
        : await skipMedication(ctx.userId, found.id, time, day);
    if (!action) return fail(`Лекарство «${query}» не найдено.`);

    const name = action.medication.name;
    const content =
      status === 'taken'
        ? `✅ ${name}: приём отмечен.${action.notice ? ` ${action.notice}` : ''}`
        : `⏭ ${name}: приём пропущен.`;

    return {
      ok: true,
      content,
      data: {
        medication_id: action.medication.id,
        status: action.status,
        date: action.log.date,
        scheduled_time: action.log.scheduledTime,
        remaining_stock: action.remainingStock,
        needs_refill: action.needsRefill,
      },
    };
  } catch (error) {
    return fail(`Не удалось отметить приём: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// get_medications_today
// ---------------------------------------------------------------------------

const DOSE_ICONS: Record<string, string> = {
  taken: '✅',
  skipped: '⏭',
  pending: '⏳',
};

/** Сегодняшнее расписание лекарств и что уже принято. */
async function getMedicationsToday(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const day = dateKey(ctx.now, ctx.timezone);
    const doses = await listDoses(ctx.userId, day);
    if (doses.length === 0) {
      return {
        ok: true,
        content: 'На сегодня лекарств не запланировано.',
        data: { date: day, doses: [] },
      };
    }

    const lines: string[] = ['💊 Лекарства на сегодня:'];
    for (const dose of doses) {
      const icon = DOSE_ICONS[dose.status] ?? '⏳';
      const dosage = dose.medication.dosage ? ` ${dose.medication.dosage}` : '';
      lines.push(
        `${icon} ${dose.medication.name}${dosage} — ${dose.scheduledTime}${stockTag(dose.medication)}`,
      );
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        date: day,
        doses: doses.map((dose) => ({
          medication_id: dose.medication.id,
          name: dose.medication.name,
          dosage: dose.medication.dosage,
          time: dose.scheduledTime,
          status: dose.status,
          taken_at: dose.takenAt,
          stock_count: dose.medication.stockCount,
        })),
      },
    };
  } catch (error) {
    return fail(`Не удалось получить расписание: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// update_medication
// ---------------------------------------------------------------------------

/**
 * Обновляет параметры лекарства: дозировку, время приёма, инструкцию, частоту,
 * остаток (точно или пополнением) и статус активности.
 */
async function updateMedicationTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.name);
  if (!query) return fail('Укажите название лекарства (name).');

  try {
    // Пауза не мешает правке: ищем и неактивные, приоритет — активному
    // (паритет с upstream `ORDER BY is_active DESC, updated_at DESC`).
    const matches = await findMedicationsByName(ctx, query, { includeInactive: true });
    const activeFirst = [...matches].sort((a, b) => Number(b.isActive) - Number(a.isActive));
    const medication = activeFirst[0];
    if (!medication) return fail(`Лекарство «${query}» не найдено.`);

    const patch: UpdateMedicationInput = {};
    const changes: string[] = [];

    if (args.dosage !== undefined) {
      const dosage = String(args.dosage ?? '').trim();
      patch.dosage = dosage;
      changes.push(`дозировка: ${dosage || '—'}`);
    }

    const times = asTimes(args.times);
    if (times === null) {
      return fail('Времена приёма (times) — список строк вида "HH:MM", например ["09:00", "21:00"].');
    }
    if (times !== undefined) {
      patch.times = times;
      changes.push(`время приёма: ${times.join(', ')}`);
    }

    if (args.instructions !== undefined) {
      const instructions = asText(args.instructions);
      patch.instructions = instructions;
      changes.push(`инструкция: ${instructions ?? '—'}`);
    }

    if (args.frequency !== undefined) {
      const frequency = asText(args.frequency);
      if (!frequency || !FREQUENCIES.includes(frequency.toLowerCase())) {
        return fail('frequency может быть "daily", "weekly" или "as_needed".');
      }
      patch.frequency = frequency.toLowerCase() as MedicationRow['frequency'];
      changes.push(`частота: ${frequency.toLowerCase()}`);
    }

    let stockTouched = false;
    if (args.stock_count !== undefined && args.stock_count !== null) {
      const stock = asInt(args.stock_count);
      if (stock === null) return fail('stock_count должен быть целым числом.');
      patch.stockCount = Math.max(0, stock);
      changes.push(`остаток: ${patch.stockCount} шт.`);
      stockTouched = true;
    }

    if (!stockTouched && args.refill_pills !== undefined && args.refill_pills !== null) {
      const pills = asInt(args.refill_pills);
      if (pills === null) return fail('refill_pills должен быть целым числом.');
      if (pills <= 0) return fail('refill_pills должен быть больше нуля.');
      const total = (medication.stockCount ?? 0) + pills;
      patch.stockCount = total;
      changes.push(`пополнен запас на +${pills} шт. (всего: ${total} шт.)`);
    }

    if (args.is_active !== undefined && args.is_active !== null) {
      const active = asBool(args.is_active);
      if (active === null) return fail('is_active должен быть true или false.');
      patch.isActive = active;
      changes.push(active ? 'активен' : 'на паузе');
    }

    if (changes.length === 0) {
      return fail('Нечего обновлять — передайте хотя бы одно поле.');
    }

    const updated = await updateMedication(ctx.userId, medication.id, patch);
    if (!updated) return fail(`Лекарство «${query}» не найдено.`);

    return {
      ok: true,
      content: `Обновил «${updated.name}»: ${changes.join(', ')}.`,
      data: {
        medication_id: updated.id,
        name: updated.name,
        dosage: updated.dosage,
        times: [...updated.times],
        frequency: updated.frequency,
        instructions: updated.instructions,
        stock_count: updated.stockCount,
        refill_threshold: updated.refillThreshold,
        is_active: updated.isActive,
      },
    };
  } catch (error) {
    return fail(`Не удалось обновить лекарство: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// delete_medication
// ---------------------------------------------------------------------------

/**
 * Удаляет лекарство из аптечки. История приёмов остаётся как данные.
 */
async function deleteMedicationTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.name);
  if (!query) return fail('Укажите название лекарства (name).');

  try {
    // Активные ищем первыми; если такого нет — даём удалить и лекарство на паузе
    // (upstream вообще не фильтрует по активности).
    let matches = await findMedicationsByName(ctx, query);
    if (matches.length === 0) {
      matches = await findMedicationsByName(ctx, query, { includeInactive: true });
    }

    const found = pickOne(matches, query);
    if (isOutcome(found)) return found;

    const deleted = await deleteMedication(ctx.userId, found.id);
    if (!deleted) return fail(`Лекарство «${query}» не найдено.`);

    return {
      ok: true,
      content: `Удалил лекарство «${found.name}». История приёмов сохранена.`,
      data: { medication_id: found.id, name: found.name, deleted: true },
    };
  } catch (error) {
    return fail(`Не удалось удалить лекарство: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

/** Константы, не фабрики: реестр регистрирует их как есть. */
export const medicationTools: Tool[] = [
  {
    name: 'add_medication',
    description:
      'Добавляет лекарство в расписание приёма: название, дозировка, время приёма, инструкция и (опционально) остаток в упаковке.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название препарата, например «Витамин D3».' },
        dosage: { type: 'string', description: 'Дозировка, например «2000 ME» или «1 капсула».' },
        times: {
          type: 'array',
          items: { type: 'string' },
          description: 'Времена приёма в формате "HH:MM", например ["09:00", "21:00"].',
        },
        instructions: { type: 'string', description: 'Инструкция к приёму: «после еды», «натощак».' },
        frequency: {
          type: 'string',
          enum: ['daily', 'weekly', 'as_needed'],
          description: 'Частота приёма.',
        },
        stock_count: { type: 'integer', description: 'Сколько доз в упаковке (для учёта остатка).' },
        refill_threshold: {
          type: 'integer',
          description: 'Порог остатка, при котором пора покупать новую упаковку.',
        },
      },
      required: ['name'],
    },
    run: addMedication,
  },
  {
    name: 'log_medication_taken',
    description:
      'Фиксирует приём лекарства или пропуск за сегодня и списывает одну дозу из остатка упаковки.',
    schema: {
      type: 'object',
      properties: {
        medication_name: {
          type: 'string',
          description: 'Название препарата (или его часть) для поиска.',
        },
        status: {
          type: 'string',
          enum: ['taken', 'skipped'],
          description: 'taken — принял (по умолчанию), skipped — пропустил.',
        },
        scheduled_time: {
          type: 'string',
          description: 'Время приёма "HH:MM"; по умолчанию — первое время из расписания.',
        },
      },
      required: ['medication_name'],
    },
    run: logMedicationTaken,
  },
  {
    name: 'get_medications_today',
    description: 'Показывает сегодняшнее расписание лекарств и что уже принято, пропущено или ждёт.',
    schema: { type: 'object', properties: {}, required: [] },
    run: getMedicationsToday,
  },
  {
    name: 'update_medication',
    description:
      'Обновляет лекарство: дозировку, время приёма, инструкцию, частоту, остаток (точно или пополнением) и статус активности.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название лекарства (или его часть) для поиска.' },
        dosage: { type: 'string', description: 'Новая дозировка.' },
        times: {
          type: 'array',
          items: { type: 'string' },
          description: 'Новое расписание приёма в формате "HH:MM".',
        },
        instructions: { type: 'string', description: 'Новая инструкция к приёму.' },
        frequency: {
          type: 'string',
          enum: ['daily', 'weekly', 'as_needed'],
          description: 'Новая частота приёма.',
        },
        stock_count: { type: 'integer', description: 'Установить точный остаток доз в упаковке.' },
        refill_pills: {
          type: 'integer',
          description: 'Сколько доз докупили — прибавится к текущему остатку.',
        },
        is_active: { type: 'boolean', description: 'true — принимать, false — поставить на паузу.' },
      },
      required: ['name'],
    },
    run: updateMedicationTool,
  },
  {
    name: 'delete_medication',
    description: 'Удаляет лекарство из аптечки (история приёмов при этом сохраняется).',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название лекарства (или его часть) для удаления.' },
      },
      required: ['name'],
    },
    run: deleteMedicationTool,
  },
];
