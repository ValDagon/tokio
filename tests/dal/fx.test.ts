/**
 * DAL `src/lib/dal/fx.ts` — курсы валют.
 *
 * Модель: `rates[X]` — сколько единиц X дают за 1 базовую (EUR).
 * Поэтому X → базовая = amount / rate, базовая → X = amount * rate.
 *
 * `fx_rates` — единственная глобальная таблица финансов (без `user_id`),
 * поэтому изоляции по пользователю здесь нет и быть не должно — проверяем,
 * что таблица действительно общая и UPSERT идёт по PK `date+base`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, sql } from 'sdk/db';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  BASE_CURRENCY,
  convert,
  eurPerUnit,
  getLatestRate,
  getRate,
  getRates,
  hasRate,
  normalizeCurrency,
  normalizeDate,
  parseRates,
  rateOf,
  roundUpToNextNinetyNine,
  setRates,
  toBase,
  toRateTable,
  todayIso,
} from '../../src/lib/dal/fx';

const RATES = { USD: 1.08, GBP: 0.85 } as const;

describe('fx: коды валют и даты', () => {
  it('нормализует регистр, пробелы и стейблкоины', () => {
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(normalizeCurrency('  eur ')).toBe('EUR');
    expect(normalizeCurrency('usdt')).toBe('USD');
    expect(normalizeCurrency('USDC')).toBe('USD');
    expect(normalizeCurrency('bam')).toBe('BAM');
  });

  it('пустой код — ошибка вызывающего', () => {
    expect(() => normalizeCurrency('')).toThrow(/currency code is required/);
    expect(() => normalizeCurrency('   ')).toThrow(/currency code is required/);
  });

  it('todayIso — текущая дата в UTC', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('normalizeDate принимает строку, таймштамп и Date', () => {
    expect(normalizeDate('2026-11-06')).toBe('2026-11-06');
    expect(normalizeDate('2026-11-06T23:15:00.000Z')).toBe('2026-11-06');
    expect(normalizeDate(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02');
    expect(() => normalizeDate('06.11.2026')).toThrow(/invalid date/);
  });
});

describe('fx: разбор таблицы курсов', () => {
  it('пропускает мусорные значения и приводит ключи', () => {
    const table = toRateTable({
      usd: 1.08,
      GBP: '0.85',
      RUB: 0,
      TRY: -3,
      KZT: Number.NaN,
      BAM: null,
    });
    expect(table).toEqual({ USD: 1.08, GBP: 0.85 });
  });

  it('не-объект → пустая таблица', () => {
    expect(toRateTable(null)).toEqual({});
    expect(toRateTable('USD')).toEqual({});
    expect(toRateTable(42)).toEqual({});
  });

  it('parseRates понимает TEXT/json и терпит битый json', () => {
    expect(parseRates('{"USD":1.08,"usdt":1.1}')).toEqual({ USD: 1.1 });
    expect(parseRates({ USD: 1.08 })).toEqual({ USD: 1.08 });
    expect(parseRates('not a json')).toEqual({});
    expect(parseRates('')).toEqual({});
    expect(parseRates(null)).toEqual({});
  });
});

describe('fx: округление конвертации вверх до ,99', () => {
  it('поднимает дробную сумму до ближайшей ,99', () => {
    expect(roundUpToNextNinetyNine(3_023)).toBe(3_099);
    expect(roundUpToNextNinetyNine(50)).toBe(99);
    expect(roundUpToNextNinetyNine(10_001)).toBe(10_099);
  });

  it('не меняет сумму, которая уже ,99 или целая', () => {
    expect(roundUpToNextNinetyNine(3_099)).toBe(3_099);
    expect(roundUpToNextNinetyNine(3_100)).toBe(3_100);
    expect(roundUpToNextNinetyNine(0)).toBe(0);
  });
});

describe('fx: конвертация', () => {
  it('EUR → USD умножает на курс', () => {
    expect(convert(10_000, 'EUR', 'USD', RATES)).toBe(10_800);
  });

  it('USD → EUR делит на курс (одно округление)', () => {
    // 10000 / 1.08 = 9259.259…
    expect(convert(10_000, 'USD', 'EUR', RATES)).toBe(9_259);
  });

  it('кросс-курс идёт через базовую валюту', () => {
    // 10800 USD → 10800 / 1.08 = 10000 EUR → 10000 * 0.85 = 8500 GBP
    expect(convert(10_800, 'USD', 'GBP', RATES)).toBe(8_500);
  });

  it('одинаковая валюта — без изменений', () => {
    expect(convert(1_234, 'EUR', 'EUR', RATES)).toBe(1_234);
    expect(convert(1_234, 'usdt', 'USD', RATES)).toBe(1_234);
  });

  it('USDT считается долларом', () => {
    expect(convert(10_000, 'USDT', 'EUR', RATES)).toBe(convert(10_000, 'USD', 'EUR', RATES));
  });

  it('без курса — ошибка, а не молчаливая единица', () => {
    expect(() => convert(10_000, 'USD', 'EUR', {})).toThrow(/no rate for USD/);
    expect(() => convert(10_000, 'EUR', 'CHF', RATES)).toThrow(/no rate for CHF/);
  });

  it('hasRate / rateOf / eurPerUnit / toBase согласованы', () => {
    expect(hasRate('EUR', RATES)).toBe(true);
    expect(hasRate('usd', RATES)).toBe(true);
    expect(hasRate('CHF', RATES)).toBe(false);

    expect(rateOf('EUR', RATES)).toBe(1);
    expect(rateOf('GBP', RATES)).toBe(0.85);
    expect(() => rateOf('CHF', RATES)).toThrow(/no rate for CHF/);

    // 1 USD = 1 / 1.08 EUR — это и есть fx_rate (amount_eur / amount)
    expect(eurPerUnit('USD', RATES)).toBeCloseTo(1 / 1.08, 10);
    expect(eurPerUnit('EUR', RATES)).toBe(1);

    expect(toBase(10_800, 'USD', RATES)).toBe(10_000);
    expect(BASE_CURRENCY).toBe('EUR');
  });
});

describe('fx: хранение курсов', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
  });

  it('setRates сохраняет и читает курс на дату', async () => {
    const saved = await setRates('2026-11-06', RATES);
    expect(saved.date).toBe('2026-11-06');
    expect(saved.base).toBe('EUR');
    expect(saved.rates).toEqual({ USD: 1.08, GBP: 0.85 });

    const loaded = await getRate('2026-11-06');
    expect(loaded?.rates).toEqual({ USD: 1.08, GBP: 0.85 });
    expect(await getRate('2026-11-05')).toBeNull();
  });

  it('повторный setRates на ту же дату — upsert, а не вторая строка', async () => {
    await setRates('2026-11-06', { USD: 1.08 });
    await setRates('2026-11-06T12:00:00.000Z', { USD: 1.1 });

    const rows = await db.all<{ c: number }>(sql`SELECT COUNT(*) AS c FROM fx_rates`);
    expect(rows[0].c).toBe(1);
    expect((await getRate('2026-11-06'))?.rates).toEqual({ USD: 1.1 });
  });

  it('getLatestRate берёт самую свежую дату, getRates — дату или последнюю', async () => {
    await setRates('2026-11-04', { USD: 1.07 });
    await setRates('2026-11-06', { USD: 1.08 });

    expect((await getLatestRate())?.date).toBe('2026-11-06');
    expect(await getRates('2026-11-04')).toEqual({ USD: 1.07 });
    expect(await getRates()).toEqual({ USD: 1.08 });
    expect(await getRates(null)).toEqual({ USD: 1.08 });
    expect(await getRates('2026-01-01')).toEqual({});
  });

  it('без сохранённых курсов getRates отдаёт пустой объект', async () => {
    expect(await getRates()).toEqual({});
    expect(await getLatestRate()).toBeNull();
  });

  it('пустая таблица курсов — ошибка', async () => {
    await expect(setRates('2026-11-06', {})).rejects.toThrow(/rates table is empty/);
  });
});
