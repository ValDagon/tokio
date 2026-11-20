/**
 * DAL `src/lib/dal/medications.ts` — расписание приёмов и журнал.
 *
 * Что здесь важно зафиксировать (SPEC §2.4):
 *  - времена нормализуются до `HH:MM` и сортируются, пусто → `['09:00']`;
 *  - «принял»/«пропустил» идемпотентны: первая запись побеждает, вторая не
 *    плодит строк и не съедает упаковку;
 *  - остаток списывается только при реально созданной строке лога и только если
 *    `stock_count` отслеживается; ниже нуля не уходит;
 *  - каждая функция видит данные только своего `user_id`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sql, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  DEFAULT_TIMES,
  createMedication,
  deleteMedication,
  getMedication,
  listDoses,
  listLogs,
  listMedications,
  normalizeDate,
  normalizeTimeOfDay,
  normalizeTimes,
  skipMedication,
  takeMedication,
  updateMedication,
} from '../../src/lib/dal/medications';

const USER_A = 1;
const USER_B = 2;
const DAY = '2026-11-06';

async function countRows(table: string): Promise<number> {
  const row = await db.get<{ c: number }>(sql.raw(`SELECT COUNT(*) AS c FROM "${table}"`));
  return Number(row?.c ?? 0);
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('normalizeTimeOfDay / normalizeTimes', () => {
  it('дополняет часы нулём и режет мусор', () => {
    expect(normalizeTimeOfDay('8:05')).toBe('08:05');
    expect(normalizeTimeOfDay(' 21:30 ')).toBe('21:30');
    expect(() => normalizeTimeOfDay('25:00')).toThrow(/invalid time/);
    expect(() => normalizeTimeOfDay('9')).toThrow(/invalid time/);
  });

  it('пустой список превращается в расписание по умолчанию', () => {
    expect(normalizeTimes(undefined)).toEqual([...DEFAULT_TIMES]);
    expect(normalizeTimes(null)).toEqual([...DEFAULT_TIMES]);
    expect(normalizeTimes([])).toEqual([...DEFAULT_TIMES]);
  });

  it('убирает дубли и сортирует по времени', () => {
    expect(normalizeTimes(['20:00', '8:05', '08:05'])).toEqual(['08:05', '20:00']);
  });

  it('отвергает невалидное время во всём списке', () => {
    expect(() => normalizeTimes(['09:00', '99:99'])).toThrow(/invalid time/);
  });
});

describe('normalizeDate', () => {
  it('берёт дату из ISO-строки и Date', () => {
    expect(normalizeDate('2026-11-06T13:45:00.000Z')).toBe('2026-11-06');
    expect(normalizeDate('2026-11-06')).toBe('2026-11-06');
    expect(normalizeDate(new Date('2026-11-06T00:30:00.000Z'))).toBe('2026-11-06');
  });

  it('не принимает человеческий формат даты', () => {
    expect(() => normalizeDate('06.11.2026')).toThrow(/invalid date/);
  });
});

describe('createMedication', () => {
  it('заполняет дефолты', async () => {
    const med = await createMedication(USER_A, { name: '  Магний  ' });

    expect(med.name).toBe('Магний');
    expect(med.times).toEqual(['09:00']);
    expect(med.dosage).toBe('');
    expect(med.frequency).toBe('daily');
    expect(med.instructions).toBeNull();
    expect(med.isActive).toBe(true);
    expect(med.stockCount).toBeNull();
    expect(med.refillThreshold).toBe(0);
    expect(med.createdAt).not.toBeNull();
  });

  it('требует имя', async () => {
    await expect(createMedication(USER_A, { name: '   ' })).rejects.toThrow(/name is required/);
  });

  it('нормализует времена и остаток', async () => {
    const med = await createMedication(USER_A, {
      name: 'Витамин D',
      times: ['20:00', '8:00', '08:00'],
      stockCount: 10,
      refillThreshold: 3,
    });

    expect(med.times).toEqual(['08:00', '20:00']);
    expect(med.stockCount).toBe(10);
    expect(med.refillThreshold).toBe(3);
  });

  it('список показывает только активные, если не попросили иначе', async () => {
    const active = await createMedication(USER_A, { name: 'Активный' });
    const retired = await createMedication(USER_A, { name: 'Отменённый' });
    await updateMedication(USER_A, retired.id, { isActive: false });

    expect((await listMedications(USER_A)).map((m) => m.id)).toEqual([active.id]);
    expect((await listMedications(USER_A, { includeInactive: true })).map((m) => m.id)).toEqual([
      active.id,
      retired.id,
    ]);
  });

  it('не виден другому пользователю', async () => {
    const med = await createMedication(USER_A, { name: 'Магний' });

    expect(await getMedication(USER_B, med.id)).toBeNull();
    expect(await listMedications(USER_B)).toEqual([]);
  });
});

describe('listDoses', () => {
  it('склеивает расписание с логами и оставляет несмеченное pending', async () => {
    const morning = await createMedication(USER_A, { name: 'A', times: ['08:00', '20:00'] });
    await createMedication(USER_A, { name: 'B', times: ['08:00'] });

    const before = await listDoses(USER_A, DAY);
    expect(before.map((dose) => dose.scheduledTime)).toEqual(['08:00', '08:00', '20:00']);
    expect(before.every((dose) => dose.status === 'pending')).toBe(true);

    await takeMedication(USER_A, morning.id, '08:00', DAY);

    const after = await listDoses(USER_A, DAY);
    const taken = after.filter((dose) => dose.status === 'taken');
    expect(taken).toHaveLength(1);
    expect(taken[0]?.medication.id).toBe(morning.id);
    expect(taken[0]?.scheduledTime).toBe('08:00');
    expect(taken[0]?.takenAt).not.toBeNull();
  });

  it('не подмешивает приёмы другого пользователя', async () => {
    const med = await createMedication(USER_A, { name: 'Магний', times: ['09:00'] });
    await takeMedication(USER_A, med.id, '09:00', DAY);

    expect(await listLogs(USER_A, DAY)).toHaveLength(1);
    expect(await listLogs(USER_B, DAY)).toEqual([]);
  });

  it('логи другой даты не влияют на сегодняшнюю карту', async () => {
    const med = await createMedication(USER_A, { name: 'Магний', times: ['09:00'] });
    await takeMedication(USER_A, med.id, '09:00', '2026-11-05');

    const doses = await listDoses(USER_A, DAY);
    expect(doses).toHaveLength(1);
    expect(doses[0]?.status).toBe('pending');
  });
});

describe('takeMedication', () => {
  it('идемпотентен: одна строка лога и одно списание остатка', async () => {
    const med = await createMedication(USER_A, { name: 'Магний', stockCount: 5 });

    const first = await takeMedication(USER_A, med.id, '09:00', DAY);
    expect(first?.status).toBe('taken');
    expect(first?.remainingStock).toBe(4);
    expect(first?.needsRefill).toBe(false);
    expect(first?.notice).toBe('остаток: 4 шт.');

    const second = await takeMedication(USER_A, med.id, '9:00', DAY);
    expect(second?.status).toBe('taken');
    expect(second?.remainingStock).toBe(4);
    expect(second?.log.id).toBe(first?.log.id);

    expect(await listLogs(USER_A, DAY)).toHaveLength(1);
    expect((await getMedication(USER_A, med.id))?.stockCount).toBe(4);
  });

  it('предупреждает о пополнении на пороге', async () => {
    const med = await createMedication(USER_A, {
      name: 'Магний',
      stockCount: 2,
      refillThreshold: 2,
    });

    const action = await takeMedication(USER_A, med.id, '09:00', DAY);

    expect(action?.remainingStock).toBe(1);
    expect(action?.needsRefill).toBe(true);
    expect(action?.notice).toContain('⚠️');
    expect(action?.notice).toContain('1 шт.');
  });

  it('не уводит остаток в минус', async () => {
    const med = await createMedication(USER_A, { name: 'Магний', stockCount: 0, refillThreshold: 0 });

    const action = await takeMedication(USER_A, med.id, '09:00', DAY);

    expect(action?.remainingStock).toBe(0);
    expect((await getMedication(USER_A, med.id))?.stockCount).toBe(0);
  });

  it('не трогает остаток, если он не отслеживается', async () => {
    const med = await createMedication(USER_A, { name: 'Магний' });

    const action = await takeMedication(USER_A, med.id, '09:00', DAY);

    expect(action?.remainingStock).toBeNull();
    expect(action?.needsRefill).toBe(false);
    expect(action?.notice).toBe('');
  });

  it('возвращает null для чужого медикамента и не пишет лог', async () => {
    const med = await createMedication(USER_A, { name: 'Магний' });

    expect(await takeMedication(USER_B, med.id, '09:00', DAY)).toBeNull();
    expect(await countRows('medication_logs')).toBe(0);
  });
});

describe('skipMedication', () => {
  it('идемпотентен, не трогает остаток и молчит в ответе', async () => {
    const med = await createMedication(USER_A, { name: 'Магний', stockCount: 5 });

    const first = await skipMedication(USER_A, med.id, '09:00', DAY);
    expect(first?.status).toBe('skipped');
    expect(first?.notice).toBe('');
    expect(first?.remainingStock).toBe(5);

    const second = await skipMedication(USER_A, med.id, '09:00', DAY);
    expect(second?.log.id).toBe(first?.log.id);
    expect(await listLogs(USER_A, DAY)).toHaveLength(1);
    expect((await getMedication(USER_A, med.id))?.stockCount).toBe(5);
  });

  it('первая запись побеждает: после пропуска «принял» не перезаписывает статус', async () => {
    const med = await createMedication(USER_A, { name: 'Магний', stockCount: 5 });
    await skipMedication(USER_A, med.id, '09:00', DAY);

    const action = await takeMedication(USER_A, med.id, '09:00', DAY);

    expect(action?.status).toBe('skipped');
    expect(action?.notice).toBe('');
    expect((await getMedication(USER_A, med.id))?.stockCount).toBe(5);
  });

  it('возвращает null для чужого медикамента', async () => {
    const med = await createMedication(USER_A, { name: 'Магний' });

    expect(await skipMedication(USER_B, med.id, '09:00', DAY)).toBeNull();
    expect(await countRows('medication_logs')).toBe(0);
  });
});

describe('updateMedication', () => {
  it('накладывает частичный патч, не затирая остальные поля', async () => {
    const med = await createMedication(USER_A, {
      name: 'Магний',
      dosage: '400 мг',
      times: ['09:00'],
      stockCount: 10,
      refillThreshold: 2,
      instructions: 'после еды',
    });

    const updated = await updateMedication(USER_A, med.id, {
      times: ['8:00', '20:00'],
      stockCount: 3,
    });

    expect(updated?.name).toBe('Магний');
    expect(updated?.dosage).toBe('400 мг');
    expect(updated?.times).toEqual(['08:00', '20:00']);
    expect(updated?.stockCount).toBe(3);
    expect(updated?.refillThreshold).toBe(2);
    expect(updated?.instructions).toBe('после еды');
  });

  it('различает «не трогать» (undefined) и «очистить» (null)', async () => {
    const med = await createMedication(USER_A, {
      name: 'Магний',
      stockCount: 10,
      instructions: 'после еды',
    });

    const kept = await updateMedication(USER_A, med.id, { dosage: '200 мг' });
    expect(kept?.stockCount).toBe(10);
    expect(kept?.instructions).toBe('после еды');

    const cleared = await updateMedication(USER_A, med.id, { stockCount: null, instructions: null });
    expect(cleared?.stockCount).toBeNull();
    expect(cleared?.instructions).toBeNull();
  });

  it('переключает активность', async () => {
    const med = await createMedication(USER_A, { name: 'Магний' });

    const off = await updateMedication(USER_A, med.id, { isActive: false });
    expect(off?.isActive).toBe(false);

    const on = await updateMedication(USER_A, med.id, { isActive: true });
    expect(on?.isActive).toBe(true);
  });

  it('не даёт очистить имя', async () => {
    const med = await createMedication(USER_A, { name: 'Магний' });

    await expect(updateMedication(USER_A, med.id, { name: '   ' })).rejects.toThrow(
      /name cannot be empty/,
    );
  });

  it('возвращает null для неизвестного и чужого медикамента', async () => {
    const med = await createMedication(USER_A, { name: 'Магний' });

    expect(await updateMedication(USER_A, 9999, { dosage: '1 мг' })).toBeNull();
    expect(await updateMedication(USER_B, med.id, { dosage: '1 мг' })).toBeNull();
    expect((await getMedication(USER_A, med.id))?.dosage).toBe('');
  });
});

describe('deleteMedication', () => {
  it('удаляет расписание насовсем, но оставляет историю приёмов', async () => {
    const med = await createMedication(USER_A, { name: 'Магний' });
    await takeMedication(USER_A, med.id, '09:00', DAY);

    expect(await deleteMedication(USER_A, med.id)).toBe(true);
    expect(await getMedication(USER_A, med.id)).toBeNull();
    expect(await countRows('medications')).toBe(0);
    expect(await countRows('medication_logs')).toBe(1);

    expect(await deleteMedication(USER_A, med.id)).toBe(false);
  });

  it('не удаляет чужой медикамент', async () => {
    const med = await createMedication(USER_A, { name: 'Магний' });

    expect(await deleteMedication(USER_B, med.id)).toBe(false);
    expect(await getMedication(USER_A, med.id)).not.toBeNull();
  });
});
