import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMinutes,
  dateKey,
  escapeHtml,
  formatCents,
  formatDate,
  formatDateTime,
  formatMoney,
  formatTimeOfDay,
  fromCents,
  fromIso,
  isSameLocalDay,
  monthKey,
  normalizeWhitespace,
  parseAmountToCents,
  parseTimeOfDay,
  slugify,
  startOfLocalDay,
  sumCents,
  timeKey,
  toCents,
  toIso,
  truncate,
  zoneOffsetMs,
  zonedParts,
} from '../src/lib/utils';

describe('деньги: разбор пользовательского ввода', () => {
  it('четыре базовых кейса из спеки', () => {
    expect(parseAmountToCents('1 234,56')).toBe(123456);
    expect(parseAmountToCents('1234.56')).toBe(123456);
    expect(parseAmountToCents('0,5')).toBe(50);
    expect(parseAmountToCents('-10')).toBe(-1000);
  });

  it('разделители тысяч в обеих нотациях и символы валют', () => {
    expect(parseAmountToCents('1.234,56')).toBe(123456);
    expect(parseAmountToCents('1,234.56')).toBe(123456);
    expect(parseAmountToCents('€1 234,56')).toBe(123456);
    expect(parseAmountToCents('1\u00A0234\u00A056,78')).toBe(12345678);
    expect(parseAmountToCents('  +42 ')).toBe(4200);
  });

  it('три цифры после разделителя — это разделитель тысяч', () => {
    expect(parseAmountToCents('1,234')).toBe(123400);
    expect(parseAmountToCents('1.234')).toBe(123400);
    expect(parseAmountToCents('1.234.567')).toBe(123456700);
    expect(parseAmountToCents('10,999')).toBe(1099900);
  });

  it('мусор и пустая строка — ошибка, а не NaN', () => {
    expect(() => parseAmountToCents('')).toThrow(/empty/);
    expect(() => parseAmountToCents('руб')).toThrow(/not a number/);
    expect(() => parseAmountToCents('9'.repeat(20))).toThrow(/too large/);
  });

  it('чистое число трактуется как единицы валюты', () => {
    expect(parseAmountToCents(12.34)).toBe(1234);
    expect(parseAmountToCents(-0.5)).toBe(-50);
    expect(toCents(1.005)).toBe(101);
    expect(fromCents(123456)).toBeCloseTo(1234.56, 2);
  });
});

describe('деньги: отображение', () => {
  it('formatCents группирует разряды и держит два знака', () => {
    expect(formatCents(123456)).toBe('1 234,56');
    expect(formatCents(-50)).toBe('-0,50');
    expect(formatCents(0)).toBe('0,00');
    expect(formatCents(123456, { withSign: true })).toBe('+1 234,56');
    expect(formatCents(1_234_567_89)).toBe('1 234 567,89');
  });

  it('formatMoney подставляет символ, а неизвестный код пишет после суммы', () => {
    expect(formatMoney(123456, 'EUR')).toBe('€1 234,56');
    expect(formatMoney(123456, 'usd')).toBe('$1 234,56');
    expect(formatMoney(100, 'RSD')).toBe('1,00 дин');
    expect(formatMoney(100, 'XYZ')).toBe('1,00 XYZ');
  });

  it('sumCents складывает целые центы', () => {
    expect(sumCents([100, 250, -50])).toBe(300);
    expect(sumCents([])).toBe(0);
  });
});

describe('даты и таймзоны', () => {
  const instant = new Date('2026-11-05T23:30:00Z');

  it('dateKey зависит от таймзоны пользователя, а не сервера', () => {
    expect(dateKey(instant, 'UTC')).toBe('2026-11-05');
    expect(dateKey(instant, 'Europe/Berlin')).toBe('2026-11-06');
    expect(monthKey(instant, 'Europe/Berlin')).toBe('2026-11');
    expect(timeKey(instant, 'Europe/Berlin')).toBe('00:30');
  });

  it('zonedParts отдаёт полночь как 00, а не 24', () => {
    const midnight = new Date('2026-11-05T00:00:00Z');
    expect(zonedParts(midnight, 'UTC').hour).toBe(0);
    expect(zonedParts(midnight, 'UTC')).toMatchObject({
      year: 2026,
      month: 11,
      day: 5,
      minute: 0,
      second: 0,
    });
  });

  it('кривая таймзона откатывается на UTC, а не падает', () => {
    expect(dateKey(instant, 'Not/AZone')).toBe('2026-11-05');
    expect(timeKey(instant, 'Not/AZone')).toBe('23:30');
  });

  it('zoneOffsetMs учитывает летнее время', () => {
    const summer = new Date('2026-07-15T10:00:00Z');
    const winter = new Date('2026-01-15T10:00:00Z');
    expect(zoneOffsetMs(summer, 'Europe/Berlin')).toBe(7_200_000);
    expect(zoneOffsetMs(winter, 'Europe/Berlin')).toBe(3_600_000);
    expect(zoneOffsetMs(summer, 'UTC')).toBe(0);
  });

  it('startOfLocalDay возвращает момент UTC, равный локальной полуночи', () => {
    expect(startOfLocalDay(new Date('2026-07-15T12:00:00Z'), 'UTC').toISOString()).toBe(
      '2026-07-15T00:00:00.000Z',
    );
    expect(startOfLocalDay(new Date('2026-07-15T12:00:00Z'), 'Europe/Berlin').toISOString()).toBe(
      '2026-07-14T22:00:00.000Z',
    );
  });

  it('isSameLocalDay сравнивает календарные дни в таймзоне', () => {
    const a = new Date('2026-11-05T23:30:00Z');
    const b = new Date('2026-11-06T00:30:00Z');
    expect(isSameLocalDay(a, b, 'UTC')).toBe(false);
    expect(isSameLocalDay(a, b, 'Europe/Berlin')).toBe(true);
  });

  it('форматирование дат и ISO-круговорот', () => {
    const date = new Date('2026-03-09T08:05:00Z');
    expect(formatDate(date, 'UTC')).toBe('09.03.2026');
    expect(formatDateTime(date, 'UTC')).toBe('09.03.2026 08:05');
    expect(toIso(date)).toBe('2026-03-09T08:05:00.000Z');
    expect(fromIso('2026-03-09T08:05:00.000Z')?.getTime()).toBe(date.getTime());
    expect(fromIso(null)).toBeNull();
    expect(fromIso('')).toBeNull();
    expect(fromIso('не дата')).toBeNull();
  });

  it('addDays / addMinutes не мутируют исходную дату', () => {
    const base = new Date('2026-11-06T00:00:00Z');
    expect(addDays(base, 1).toISOString()).toBe('2026-11-07T00:00:00.000Z');
    expect(addMinutes(base, 90).toISOString()).toBe('2026-11-06T01:30:00.000Z');
    expect(base.toISOString()).toBe('2026-11-06T00:00:00.000Z');
  });

  it('время суток: разбор и формат взаимно обратны', () => {
    expect(parseTimeOfDay('07:00')).toBe(420);
    expect(parseTimeOfDay('7:05')).toBe(425);
    expect(parseTimeOfDay(' 23:59 ')).toBe(1439);
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('12:60')).toBeNull();
    expect(parseTimeOfDay('утро')).toBeNull();

    expect(formatTimeOfDay(420)).toBe('07:00');
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(1439)).toBe('23:59');
    expect(formatTimeOfDay(1440)).toBe('00:00');
    expect(formatTimeOfDay(-60)).toBe('23:00');
  });
});

describe('строки', () => {
  it('escapeHtml закрывает все опасные символы', () => {
    expect(escapeHtml('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
    expect(escapeHtml('обычный текст')).toBe('обычный текст');
  });

  it('truncate не превышает лимит', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefghij', 0)).toBe('');
    expect(truncate('abcdefghij', 5, '...')).toBe('ab...');
  });

  it('normalizeWhitespace схлопывает пробелы и неразрывные пробелы', () => {
    expect(normalizeWhitespace('  a \n\t b\u00A0\u00A0c ')).toBe('a b c');
  });

  it('slugify транслитерирует кириллицу', () => {
    expect(slugify('Утренний дайджест')).toBe('utrenniy-daydzhest');
    expect(slugify('  Финансы — 2026!  ')).toBe('finansy-2026');
    expect(slugify('already-slug')).toBe('already-slug');
  });
});
