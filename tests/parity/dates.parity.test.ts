/**
 * Паритет Python ↔ TS: даты, таймзоны, прибавление дней (ADR-004).
 *
 * Python-референс — `zoneinfo` + `astimezone` + `strftime` (`legacy/backend/app/services/…`).
 * TS-реализация — `zonedParts()`/`dateKey()`/`monthKey()`/`timeKey()`/
 * `formatDate()`/`formatDateTime()`/`addDays()` из `src/lib/utils.ts`.
 *
 * Календарные части и форматирование совпадают полностью (22 кейса, включая
 * переходы DST в Europe/Berlin, Tokyo, New York, Auckland).
 *
 * Единственное расхождение — `addDays()`: TS прибавляет ровно 86 400 000 мс,
 * Python прибавляет `timedelta(days=n)` к aware-дате, то есть считает по
 * настенным часам. На переходе DST это даёт сдвиг в один час (4 кейса из 10,
 * все Europe/Berlin). Расхождение зафиксировано явно.
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateKey,
  formatDate,
  formatDateTime,
  monthKey,
  timeKey,
  zonedParts,
} from '../../src/lib/utils';
import { datesFixture } from './loader';

/**
 * Расхождения `addDays()` vs Python `+ timedelta(days=n)`.
 * Ключ — id кейса, значение — ISO-момент, который реально даёт TS (UTC).
 */
const ADD_DAYS_DIVERGENCES: Readonly<Record<string, string>> = {
  // 25.10.2026, Берлин: переход на зимнее время. Python держит 13:00 по
  // местному (12:00Z + 1 ч), TS прибавляет 24 ч астрономически → 12:00Z.
  'add-days-3': '2026-10-25T12:00:00.000Z',
  'add-days-4': '2026-10-31T12:00:00.000Z',
  // 29.03.2026, Берлин: переход на летнее время. Python держит 12:00 по
  // местному (11:00Z + 1 ч), TS прибавляет 24 ч астрономически → 12:00Z.
  'add-days-5': '2026-03-29T12:00:00.000Z',
  'add-days-6': '2026-03-30T12:00:00.000Z',
};

describe('dates: календарные части и форматирование в таймзоне', () => {
  it('все поля совпадают с Python', () => {
    expect(datesFixture.cases.length).toBeGreaterThan(0);
    for (const testCase of datesFixture.cases) {
      const moment = new Date(testCase.instant);
      const zone = testCase.timeZone;

      expect(zonedParts(moment, zone), `${testCase.id}: parts`).toEqual(testCase.parts);
      expect(dateKey(moment, zone), `${testCase.id}: dateKey`).toBe(testCase.dateKey);
      expect(monthKey(moment, zone), `${testCase.id}: monthKey`).toBe(testCase.monthKey);
      expect(timeKey(moment, zone), `${testCase.id}: timeKey`).toBe(testCase.timeKey);
      expect(formatDate(moment, zone), `${testCase.id}: formatDate`).toBe(testCase.formatDate);
      expect(formatDateTime(moment, zone), `${testCase.id}: formatDateTime`).toBe(
        testCase.formatDateTime,
      );
    }
  });

  it('переходы DST не ломают части суток', () => {
    const dstCases = datesFixture.cases.filter((c) => c.timeZone === 'Europe/Berlin');
    expect(dstCases.length).toBeGreaterThan(0);
    for (const testCase of dstCases) {
      expect(dateKey(new Date(testCase.instant), testCase.timeZone)).toBe(testCase.dateKey);
    }
  });
});

describe('dates: addDays()', () => {
  it('вне переходов DST совпадает с Python', () => {
    const aligned = datesFixture.addDaysCases.filter((c) => !(c.id in ADD_DAYS_DIVERGENCES));
    expect(aligned.length).toBeGreaterThan(0);
    for (const testCase of aligned) {
      const ts = addDays(new Date(testCase.instant), testCase.days).toISOString();
      expect(ts, testCase.id).toBe(new Date(testCase.pythonIso).toISOString());
    }
  });

  it('на переходе DST TS считает астрономические сутки, Python — настенные', () => {
    for (const [id, expectedIso] of Object.entries(ADD_DAYS_DIVERGENCES)) {
      const testCase = datesFixture.addDaysCases.find((c) => c.id === id);
      expect(testCase, `нет кейса ${id} в фикстуре`).toBeDefined();
      if (!testCase) continue;

      // Python-эталон отличается от фактического TS-значения — это и есть предмет фиксации
      expect(new Date(testCase.pythonIso).toISOString(), `${id}: python`).not.toBe(expectedIso);
      expect(addDays(new Date(testCase.instant), testCase.days).toISOString(), `${id}: ts`).toBe(
        expectedIso,
      );
    }
  });

  it('guard: набор DST-расхождений не изменился', () => {
    const actual = datesFixture.addDaysCases
      .filter(
        (c) =>
          addDays(new Date(c.instant), c.days).getTime() !== new Date(c.pythonIso).getTime(),
      )
      .map((c) => c.id)
      .sort();
    expect(actual).toEqual(Object.keys(ADD_DAYS_DIVERGENCES).sort());
  });

  it('UTC и не-DST таймзоны — полный паритет во всех addDays-кейсах', () => {
    for (const testCase of datesFixture.addDaysCases.filter((c) => c.timeZone !== 'Europe/Berlin')) {
      const ts = addDays(new Date(testCase.instant), testCase.days).toISOString();
      expect(ts, testCase.id).toBe(new Date(testCase.pythonIso).toISOString());
    }
  });
});
