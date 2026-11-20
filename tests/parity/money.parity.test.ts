/**
 * Паритет Python ↔ TS: деньги (ADR-004).
 *
 * Python-референс — `legacy/backend/app/services/fx.py` и встроенный `round(x, 2)`.
 * TS-реализация — `toCents()` (`src/lib/utils.ts`) и `convert()` (`src/lib/dal/fx.ts`).
 *
 * Главная известная разница — режим округления на границе float → центы:
 *  - Python `round()` — банковское округление (half-to-even): `round(2.675, 2) = 2.67`,
 *    `round(0.125, 2) = 0.12`;
 *  - TS `toCents()` — арифметическое half-up после `toPrecision(15)`:
 *    `toCents(2.675) = 268`, `toCents(0.125) = 13`.
 *
 * Эти расхождения НЕ подгоняются: они зафиксированы явными ожиданиями и
 * guard-тестом, который упадёт, если набор расхождений изменится. Причина —
 * осознанный выбор TS (деньги не должны «терять» цент на .5), см. ADR-003.
 */

import { describe, expect, it } from 'vitest';
import { toCents } from '../../src/lib/utils';
import { convert } from '../../src/lib/dal/fx';
import type { RateTable } from '../../src/lib/dal/fx';
import { moneyFixture } from './loader';

const rates: RateTable = moneyFixture.rates;

/**
 * Расхождения `toCents(amount)` vs `int(round(amount, 2) * 100)`.
 * Ключ — id кейса фикстуры, значение — центы, которые реально даёт TS.
 */
const ROUND_DIVERGENCES: Readonly<Record<string, number>> = {
  'round2-2.675': 268, // Python 2.67 (267) — 2.675 в float это 2.67499…, но toPrecision(15) чинит до 2.68
  'round2-1.005': 101, // Python 1.00 (100) — 1.005 в float это 1.00499…
  'round2-0.125': 13, // Python 0.12 (12) — ровно половина, banker's уводит к чётному
  'round2-0.015': 2, // Python 0.01 (1) — 0.015 в float это 0.014999…
  'round2-5.555': 556, // Python 5.55 (555) — 5.555 в float это 5.554999…
  'round2-1.115': 112, // Python 1.11 (111) — 1.115 в float это 1.114999…
  'round2--12.345': -1234, // Python -12.35 (-1235) — Math.round(-1234.5) округляет к +∞
};

/**
 * Расхождения `convert(toCents(amount), currency, 'EUR')` vs `convert_to_eur(amount, currency)`.
 * Значение — центы EUR, которые реально даёт TS.
 */
const CONVERT_DIVERGENCES: Readonly<Record<string, number>> = {
  // py: round(10.005 / 1.08, 2) = 9.26 → 926; ts: toCents(10.005)=1001, round(1001/1.08)=927
  'convert-0-USD-10.005': 927,
  // py: round(0.005 / 1.08, 2) = 0.0 → 0; ts: toCents(0.005)=1, round(1/1.08)=1
  'convert-2-USD-0.005': 1,
  // py: round(-7.775, 2) = -7.78 → -778; ts: Math.round(-777.5) = -777 (к +∞)
  'convert-13-EUR--7.775': -777,
};

describe('money: round(x, 2) → целые центы', () => {
  it('вне границ .5 полностью совпадает с Python', () => {
    const aligned = moneyFixture.roundCases.filter((c) => !(c.id in ROUND_DIVERGENCES));
    expect(aligned.length).toBeGreaterThan(0);
    for (const testCase of aligned) {
      expect(toCents(testCase.amount), testCase.id).toBe(testCase.pythonRound2Cents);
    }
  });

  it('на границах .5 Python — banker\'s, TS — half-up', () => {
    for (const [id, expectedCents] of Object.entries(ROUND_DIVERGENCES)) {
      const testCase = moneyFixture.roundCases.find((c) => c.id === id);
      expect(testCase, `нет кейса ${id} в фикстуре`).toBeDefined();
      if (!testCase) continue;

      // Python остаётся эталоном в фикстуре
      expect(testCase.pythonRound2Cents, `${id}: python`).not.toBe(expectedCents);
      // TS фиксируем отдельно
      expect(toCents(testCase.amount), `${id}: ts`).toBe(expectedCents);
    }
  });

  it('guard: набор расхождений округления не изменился', () => {
    const actual = moneyFixture.roundCases
      .filter((c) => toCents(c.amount) !== c.pythonRound2Cents)
      .map((c) => c.id)
      .sort();
    expect(actual).toEqual(Object.keys(ROUND_DIVERGENCES).sort());
  });
});

describe('money: convert(amountCents, currency, EUR)', () => {
  it('вне границ float→cents полностью совпадает с Python', () => {
    const aligned = moneyFixture.convertCases.filter((c) => !(c.id in CONVERT_DIVERGENCES));
    expect(aligned.length).toBeGreaterThan(0);
    for (const testCase of aligned) {
      const tsCents = convert(toCents(testCase.amount), testCase.currency, 'EUR', rates);
      expect(tsCents, testCase.id).toBe(testCase.pythonEurCents);
    }
  });

  it('на границах float→cents расхождения зафиксированы', () => {
    for (const [id, expectedCents] of Object.entries(CONVERT_DIVERGENCES)) {
      const testCase = moneyFixture.convertCases.find((c) => c.id === id);
      expect(testCase, `нет кейса ${id} в фикстуре`).toBeDefined();
      if (!testCase) continue;

      expect(testCase.pythonEurCents, `${id}: python`).not.toBe(expectedCents);
      const tsCents = convert(toCents(testCase.amount), testCase.currency, 'EUR', rates);
      expect(tsCents, `${id}: ts`).toBe(expectedCents);
    }
  });

  it('guard: набор расхождений конвертации не изменился', () => {
    const actual = moneyFixture.convertCases
      .filter((c) => convert(toCents(c.amount), c.currency, 'EUR', rates) !== c.pythonEurCents)
      .map((c) => c.id)
      .sort();
    expect(actual).toEqual(Object.keys(CONVERT_DIVERGENCES).sort());
  });

  it('конвертация в ту же валюту — тождество', () => {
    for (const testCase of moneyFixture.convertCases.filter((c) => c.currency === 'EUR')) {
      const cents = toCents(testCase.amount);
      expect(convert(cents, 'EUR', 'EUR', rates), testCase.id).toBe(Math.round(cents));
    }
  });
});
