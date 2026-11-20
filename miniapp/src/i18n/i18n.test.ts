import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_LOCALES,
  LOCALE_MESSAGES,
  LOCALE_BCP47,
  normalizeLocale,
  translate,
  formatNumber,
  formatDate,
  formatCurrency,
  type LocaleCode,
} from './core';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenKeys(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = String(value ?? '');
    }
  }
  return result;
}

function extractPlaceholders(str: string): string[] {
  const matches = str.match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set(matches)].sort();
}

const CYRILLIC_RE = /[\u0400-\u04FF]/;

describe('miniapp i18n', () => {
  it('has 100% key parity and non-empty values across all 4 locales', () => {
    const baseKeys = flattenKeys(LOCALE_MESSAGES.ru as unknown as Record<string, unknown>);
    const baseKeyList = Object.keys(baseKeys).sort();
    expect(baseKeyList.length).toBeGreaterThan(100);

    for (const loc of SUPPORTED_LOCALES) {
      const flat = flattenKeys(LOCALE_MESSAGES[loc] as unknown as Record<string, unknown>);
      const keys = Object.keys(flat).sort();
      expect(keys, `Key mismatch for locale ${loc}`).toEqual(baseKeyList);

      for (const k of keys) {
        expect(flat[k].trim().length, `Empty value for ${loc}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  it('has 100% placeholder parity across all 4 locales', () => {
    const baseKeys = flattenKeys(LOCALE_MESSAGES.ru as unknown as Record<string, unknown>);
    for (const loc of SUPPORTED_LOCALES) {
      if (loc === 'ru') continue;
      const flat = flattenKeys(LOCALE_MESSAGES[loc] as unknown as Record<string, unknown>);
      for (const [k, baseVal] of Object.entries(baseKeys)) {
        const expected = extractPlaceholders(baseVal);
        const actual = extractPlaceholders(flat[k]);
        expect(actual, `Placeholder mismatch at ${loc}.${k}`).toEqual(expected);
      }
    }
  });

  it('has zero Cyrillic characters in en, sr, and ja locales', () => {
    const nonCyrillicLocales: LocaleCode[] = ['en', 'sr', 'ja'];
    for (const loc of nonCyrillicLocales) {
      const flat = flattenKeys(LOCALE_MESSAGES[loc] as unknown as Record<string, unknown>);
      for (const [k, val] of Object.entries(flat)) {
        expect(CYRILLIC_RE.test(val), `Unexpected Cyrillic in ${loc}.${k}: ${val}`).toBe(false);
      }
    }
  });

  it('normalizes locale codes properly', () => {
    expect(normalizeLocale('ru-RU')).toBe('ru');
    expect(normalizeLocale('en_US')).toBe('en');
    expect(normalizeLocale('sr-Latn')).toBe('sr');
    expect(normalizeLocale('sr-RS')).toBe('sr');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('jp')).toBe('ja');
    expect(normalizeLocale('fr-FR', 'en')).toBe('en');
    expect(normalizeLocale(undefined)).toBe('ru');
  });

  it('interpolates variables in translate()', () => {
    expect(translate('en', 'tasks.allCount', { count: 12 })).toBe('All (12)');
    expect(translate('sr', 'tasks.allCount', { count: 5 })).toBe('Sve (5)');
    expect(translate('ja', 'tasks.allCount', { count: 3 })).toBe('すべて (3)');
  });

  it('formats numbers, dates, and currencies using locale BCP47 tags', () => {
    expect(LOCALE_BCP47.sr).toBe('sr-Latn');
    expect(LOCALE_BCP47.ja).toBe('ja-JP');

    const numEn = formatNumber('en', 1234.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(numEn).toContain('1');
    expect(numEn).toContain('234');

    const currEur = formatCurrency('en', 420, 'EUR', { maximumFractionDigits: 0 });
    expect(currEur).toBe('420 €');

    const currUsd = formatCurrency('en', 99, 'USD', { maximumFractionDigits: 0 });
    expect(currUsd).toBe('$99');

    const dateJa = formatDate('ja', '2026-05-10T12:00:00Z', { month: 'short', day: 'numeric' });
    expect(dateJa.length).toBeGreaterThan(0);
  });
});
