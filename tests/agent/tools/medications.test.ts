/**
 * Тулзы агента: аптечка (SPEC §3 T13).
 *
 * Держим инварианты тулз:
 *  - поиск по имени — сначала точное совпадение, потом подстрока; несколько
 *    совпадений → `ok:false` со списком, а не «угадывание»;
 *  - кривые аргументы дают `ok:false`, а не исключение;
 *  - `log_medication_taken` идемпотентен: повторный «принял» не списывает
 *    вторую дозу;
 *  - `refill_pills` суммируется с текущим остатком;
 *  - `delete_medication` удаляет расписание, но логи приёмов остаются;
 *  - каждый пользователь видит только свои лекарства.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { medicationTools } from '../../../src/lib/agent/tools/medications';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import {
  createMedication,
  listLogs,
  listMedications,
  updateMedication,
} from '../../../src/lib/dal/medications';
import { ensureUser } from '../../../src/lib/dal/users';

const USER_A = 1;
const USER_B = 2;

/** Фиксированный момент: 15 марта, 11:00 по Белграду. */
const NOW = new Date('2026-03-15T10:00:00.000Z');
const TODAY = '2026-03-15';

const CTX_A: ToolContext = {
  userId: USER_A,
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  now: NOW,
};

function contextFor(userId: number): ToolContext {
  return { ...CTX_A, userId };
}

function toolByName(name: string): Tool {
  const found = medicationTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`тулза ${name} не зарегистрирована в medicationTools`);
  return found;
}

async function run(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = CTX_A,
): Promise<ToolOutcome> {
  const outcome = await toolByName(name).run(args, ctx);
  return typeof outcome === 'string' ? { ok: true, content: outcome } : outcome;
}

interface MedicationData {
  medication_id: number;
  name: string;
  dosage: string;
  times: string[];
  frequency: string;
  instructions: string | null;
  stock_count: number | null;
  refill_threshold: number;
  is_active: boolean;
}

interface LogData {
  medication_id: number;
  status: string;
  date: string;
  scheduled_time: string;
  remaining_stock: number | null;
  needs_refill: boolean;
}

interface TodayData {
  date: string;
  doses: Array<{
    medication_id: number;
    name: string;
    dosage: string;
    time: string;
    status: string;
    stock_count: number | null;
  }>;
}

async function seedMagnesium(
  userId: number = USER_A,
  overrides: Partial<Parameters<typeof createMedication>[1]> = {},
) {
  return createMedication(userId, {
    name: 'Магний',
    dosage: '1 таблетка',
    times: ['09:00'],
    stockCount: 10,
    refillThreshold: 2,
    ...overrides,
  });
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
});

// ---------------------------------------------------------------------------
// add_medication
// ---------------------------------------------------------------------------

describe('add_medication', () => {
  it('добавляет лекарство целиком и печатает расписание и запас', async () => {
    const outcome = await run('add_medication', {
      name: 'Витамин D3',
      dosage: '2000 ME',
      times: ['09:00', '21:00'],
      stock_count: 30,
      refill_threshold: 5,
    });

    expect(outcome.ok).toBe(true);
    const data = outcome.data as MedicationData;
    expect(data.name).toBe('Витамин D3');
    expect(data.dosage).toBe('2000 ME');
    expect(data.times).toEqual(['09:00', '21:00']);
    expect(data.frequency).toBe('daily');
    expect(data.stock_count).toBe(30);
    expect(data.refill_threshold).toBe(5);

    expect(outcome.content).toContain('💊 Добавил лекарство: «Витамин D3» 2000 ME');
    expect(outcome.content).toContain('приём: 09:00, 21:00 (daily)');
    expect(outcome.content).toContain('запас: 30 шт.');
    expect(outcome.content).not.toContain('порог пополнения');

    const stored = await listMedications(USER_A);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'Витамин D3', stockCount: 30 });
  });

  it('сообщает о пороге, если остаток уже ниже него', async () => {
    const outcome = await run('add_medication', {
      name: 'Магний',
      times: ['09:00'],
      stock_count: 3,
      refill_threshold: 5,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('порог пополнения: 5 шт.');
    expect((outcome.data as MedicationData).stock_count).toBe(3);
  });

  it('без времён приёма подставляет 09:00 из DAL-дефолтов', async () => {
    const outcome = await run('add_medication', { name: 'Магний' });

    expect(outcome.ok).toBe(true);
    const data = outcome.data as MedicationData;
    expect(data.times).toEqual(['09:00']);
    expect(data.frequency).toBe('daily');
    expect(data.stock_count).toBeNull();
    expect(outcome.content).not.toContain('запас:');
  });

  it('без названия — ok:false', async () => {
    await expect(run('add_medication', {})).resolves.toMatchObject({ ok: false });
    const outcome = await run('add_medication', { dosage: '1 таблетка' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Укажите название лекарства');
  });

  it('кривые times / frequency / stock_count — ok:false без исключения', async () => {
    const badTimes = await run('add_medication', { name: 'Магний', times: '09:00' });
    expect(badTimes.ok).toBe(false);
    expect(badTimes.content).toContain('список строк');

    const badFrequency = await run('add_medication', { name: 'Магний', frequency: 'hourly' });
    expect(badFrequency.ok).toBe(false);
    expect(badFrequency.content).toContain('frequency');

    const badStock = await run('add_medication', { name: 'Магний', stock_count: 'много' });
    expect(badStock.ok).toBe(false);
    expect(badStock.content).toContain('stock_count');
  });
});

// ---------------------------------------------------------------------------
// log_medication_taken
// ---------------------------------------------------------------------------

describe('log_medication_taken', () => {
  it('отмечает приём и списывает одну дозу', async () => {
    await seedMagnesium();

    const outcome = await run('log_medication_taken', { medication_name: 'маг' });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as LogData;
    expect(data.status).toBe('taken');
    expect(data.date).toBe(TODAY);
    expect(data.scheduled_time).toBe('09:00');
    expect(data.remaining_stock).toBe(9);
    expect(data.needs_refill).toBe(false);

    expect(outcome.content).toContain('✅ Магний: приём отмечен.');
    expect(outcome.content).toContain('остаток: 9 шт.');

    const [stored] = await listMedications(USER_A);
    expect(stored.stockCount).toBe(9);
  });

  it('повторный «принял» идемпотентен и не ест упаковку дважды', async () => {
    await seedMagnesium();

    const first = await run('log_medication_taken', { medication_name: 'Магний' });
    const second = await run('log_medication_taken', { medication_name: 'Магний' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second.data as LogData).remaining_stock).toBe(9);

    const [stored] = await listMedications(USER_A);
    expect(stored.stockCount).toBe(9);
    expect(await listLogs(USER_A, TODAY)).toHaveLength(1);
  });

  it('status=skipped пишет пропуск и не трогает остаток', async () => {
    await seedMagnesium();

    const outcome = await run('log_medication_taken', {
      medication_name: 'Магний',
      status: 'skipped',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('⏭ Магний: приём пропущен.');
    expect((outcome.data as LogData).status).toBe('skipped');

    const [stored] = await listMedications(USER_A);
    expect(stored.stockCount).toBe(10);

    const logs = await listLogs(USER_A, TODAY);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 'skipped', scheduledTime: '09:00' });
  });

  it('не найденное лекарство и невалидный статус — ok:false', async () => {
    await seedMagnesium();

    const missing = await run('log_medication_taken', { medication_name: 'Ибупрофен' });
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain('не найдено');

    const badStatus = await run('log_medication_taken', {
      medication_name: 'Магний',
      status: 'eaten',
    });
    expect(badStatus.ok).toBe(false);

    const noName = await run('log_medication_taken', {});
    expect(noName.ok).toBe(false);
  });

  it('неоднозначное имя — ok:false со списком совпадений', async () => {
    await seedMagnesium(USER_A, { name: 'Магний B6' });
    await seedMagnesium(USER_A, { name: 'Магний цитрат' });

    const outcome = await run('log_medication_taken', { medication_name: 'магний' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Найдено несколько');
    expect(outcome.content).toContain('Магний B6');
    expect(outcome.content).toContain('Магний цитрат');
  });
});

// ---------------------------------------------------------------------------
// get_medications_today
// ---------------------------------------------------------------------------

describe('get_medications_today', () => {
  it('показывает статусы доз и остаток', async () => {
    await seedMagnesium(USER_A, { times: ['09:00', '21:00'] });
    await run('log_medication_taken', { medication_name: 'Магний', scheduled_time: '09:00' });

    const outcome = await run('get_medications_today', {});
    expect(outcome.ok).toBe(true);

    const data = outcome.data as TodayData;
    expect(data.date).toBe(TODAY);
    expect(data.doses).toHaveLength(2);
    expect(data.doses[0]).toMatchObject({ name: 'Магний', time: '09:00', status: 'taken' });
    expect(data.doses[1]).toMatchObject({ name: 'Магний', time: '21:00', status: 'pending' });

    expect(outcome.content).toContain('💊 Лекарства на сегодня:');
    expect(outcome.content).toContain('✅ Магний 1 таблетка — 09:00 (осталось 9 шт.)');
    expect(outcome.content).toContain('⏳ Магний 1 таблетка — 21:00 (осталось 9 шт.)');
  });

  it('пустая аптечка и изоляция пользователей', async () => {
    await seedMagnesium(USER_A);

    const outcome = await run('get_medications_today', {}, contextFor(USER_B));
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe('На сегодня лекарств не запланировано.');
    expect((outcome.data as TodayData).doses).toEqual([]);
  });

  it('неактивное лекарство не попадает в дневное расписание', async () => {
    const medication = await seedMagnesium();
    await updateMedication(USER_A, medication.id, { isActive: false });

    const outcome = await run('get_medications_today', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe('На сегодня лекарств не запланировано.');
  });
});

// ---------------------------------------------------------------------------
// update_medication
// ---------------------------------------------------------------------------

describe('update_medication', () => {
  it('refill_pills прибавляется к текущему остатку', async () => {
    await seedMagnesium(USER_A, { stockCount: 30, refillThreshold: 5 });

    const outcome = await run('update_medication', { name: 'Магний', refill_pills: 10 });
    expect(outcome.ok).toBe(true);

    expect((outcome.data as MedicationData).stock_count).toBe(40);
    expect(outcome.content).toContain('пополнен запас на +10 шт. (всего: 40 шт.)');

    const [stored] = await listMedications(USER_A);
    expect(stored.stockCount).toBe(40);
  });

  it('refill_pills без отслеживаемого остатка стартует с нуля', async () => {
    await seedMagnesium(USER_A, { stockCount: null, refillThreshold: 0 });

    const outcome = await run('update_medication', { name: 'Магний', refill_pills: 12 });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as MedicationData).stock_count).toBe(12);
  });

  it('stock_count заменяет остаток, dosage и times обновляются', async () => {
    await seedMagnesium();

    const outcome = await run('update_medication', {
      name: 'Магний',
      dosage: '2 таблетки',
      times: ['08:30', '20:30'],
      stock_count: '7',
    });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as MedicationData;
    expect(data.dosage).toBe('2 таблетки');
    expect(data.times).toEqual(['08:30', '20:30']);
    expect(data.stock_count).toBe(7);
    expect(outcome.content).toContain('Обновил «Магний»');
  });

  it('is_active=false ставит на паузу, но лекарство остаётся доступным для правки', async () => {
    await seedMagnesium();

    const paused = await run('update_medication', { name: 'Магний', is_active: 'false' });
    expect(paused.ok).toBe(true);
    expect((paused.data as MedicationData).is_active).toBe(false);
    expect(paused.content).toContain('на паузе');

    const edited = await run('update_medication', { name: 'Магний', dosage: '1 капсула' });
    expect(edited.ok).toBe(true);
    expect((edited.data as MedicationData).dosage).toBe('1 капсула');
  });

  it('ничего не передали — ok:false', async () => {
    await seedMagnesium();

    const outcome = await run('update_medication', { name: 'Магний' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Нечего обновлять');
  });

  it('кривые поля и отсутствие имени — ok:false', async () => {
    await seedMagnesium();

    const noName = await run('update_medication', { dosage: '1 таблетка' });
    expect(noName.ok).toBe(false);

    const badFrequency = await run('update_medication', { name: 'Магний', frequency: 'hourly' });
    expect(badFrequency.ok).toBe(false);

    const badTimes = await run('update_medication', { name: 'Магний', times: '09:00' });
    expect(badTimes.ok).toBe(false);

    const badStock = await run('update_medication', { name: 'Магний', stock_count: 'abc' });
    expect(badStock.ok).toBe(false);

    const badRefill = await run('update_medication', { name: 'Магний', refill_pills: 0 });
    expect(badRefill.ok).toBe(false);

    const missing = await run('update_medication', { name: 'Ибупрофен', dosage: '1' });
    expect(missing.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// delete_medication
// ---------------------------------------------------------------------------

describe('delete_medication', () => {
  it('удаляет расписание, но сохраняет историю приёмов', async () => {
    await seedMagnesium();
    await run('log_medication_taken', { medication_name: 'Магний' });

    const outcome = await run('delete_medication', { name: 'Магний' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Удалил лекарство «Магний»');
    expect(outcome.content).toContain('История приёмов сохранена');

    expect(await listMedications(USER_A)).toEqual([]);
    expect(await listMedications(USER_A, { includeInactive: true })).toEqual([]);
    expect(await listLogs(USER_A, TODAY)).toHaveLength(1);
  });

  it('удаляет и лекарство на паузе', async () => {
    const medication = await seedMagnesium();
    await updateMedication(USER_A, medication.id, { isActive: false });

    const outcome = await run('delete_medication', { name: 'Магний' });
    expect(outcome.ok).toBe(true);
    expect(await listMedications(USER_A, { includeInactive: true })).toEqual([]);
  });

  it('не найдено и неоднозначно — ok:false', async () => {
    await seedMagnesium(USER_A, { name: 'Магний B6' });
    await seedMagnesium(USER_A, { name: 'Магний цитрат' });

    const missing = await run('delete_medication', { name: 'Ибупрофен' });
    expect(missing.ok).toBe(false);

    const ambiguous = await run('delete_medication', { name: 'магний' });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.content).toContain('Найдено несколько');

    const noName = await run('delete_medication', {});
    expect(noName.ok).toBe(false);

    expect(await listMedications(USER_A)).toHaveLength(2);
  });

  it('чужое лекарство не удаляется', async () => {
    await seedMagnesium(USER_B);

    const outcome = await run('delete_medication', { name: 'Магний' }, contextFor(USER_A));
    expect(outcome.ok).toBe(false);
    expect(await listMedications(USER_B)).toHaveLength(1);
  });
});
