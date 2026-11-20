/**
 * Runtime i18n helper for the bot (V8 isolate compatible, zero node:fs).
 *
 * Imports ONLY `./i18n.generated.js` (compiled from `locales/{ru,en,sr,ja}.json`
 * by `scripts/compile-runtime-assets.mjs`) and `type { LocaleCode }` from `./types.js`.
 * Must NOT import `overlay.ts` or `handlers/` to keep the bundle graph acyclic.
 */

import { COMPILED_LOCALES } from './i18n.generated.js';
import type { LocaleCode } from './types.js';

export type { LocaleCode };

export const SUPPORTED_LOCALES = ['ru', 'en', 'sr', 'ja'] as const;

export type KeyboardButtonKey =
  | 'status'
  | 'balance'
  | 'debts'
  | 'tasks'
  | 'meds'
  | 'digest'
  | 'inbox'
  | 'newSession'
  | 'help';

export type LocaleCatalog = Record<string, unknown>;

const INTL_TAGS: Record<LocaleCode, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  sr: 'sr-Latn',
  ja: 'ja-JP',
};

const catalogs = COMPILED_LOCALES as Record<LocaleCode, LocaleCatalog>;

/**
 * Normalizes any raw locale / Telegram `language_code` to one of the 4 supported locales.
 * - `en*` -> `'en'`
 * - `sr*` / `hr*` / `bs*` -> `'sr'`
 * - `ja*` -> `'ja'`
 * - `ru*` / `uk*` / `be*` -> `'ru'`
 * - anything else -> `fallback` (default `'ru'`)
 */
export function normalizeLocale(
  raw?: string | null,
  fallback: LocaleCode = 'ru',
): LocaleCode {
  if (typeof raw !== 'string') return fallback;
  const code = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!code) return fallback;
  const primary = code.split('-')[0] ?? '';
  if (primary === 'en') return 'en';
  if (primary === 'sr' || primary === 'hr' || primary === 'bs') return 'sr';
  if (primary === 'ja') return 'ja';
  if (primary === 'ru' || primary === 'uk' || primary === 'be') return 'ru';
  return fallback;
}

/** Maps a `LocaleCode` to its BCP-47 `Intl` locale tag. */
export function intlLocaleTag(locale: LocaleCode): string {
  return INTL_TAGS[locale] ?? 'ru-RU';
}

/** Resolves a dotted key path (e.g. `'keyboards.status'`) in a nested catalog object. */
function lookupKey(catalog: LocaleCatalog | undefined, key: string): string | undefined {
  if (!catalog || typeof catalog !== 'object') return undefined;
  const parts = key.split('.');
  let current: unknown = catalog;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined;
}

/** Interpolates `{{param}}` placeholders in a template string. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Translates a dotted key for the given locale with fallback chain:
 * `locale` -> `'en'` -> `'ru'` -> `key`.
 */
export function t(
  locale: LocaleCode | null | undefined,
  key: string,
  params?: Record<string, string | number>,
): string {
  const loc = normalizeLocale(locale, 'ru');
  const template =
    lookupKey(catalogs[loc], key) ??
    lookupKey(catalogs.en, key) ??
    lookupKey(catalogs.ru, key) ??
    key;
  return interpolate(template, params);
}

/**
 * Pluralized translation using `Intl.PluralRules`.
 * Looks up `${keyBase}_${rule}` (e.g. `plural.tasks_one`, `plural.tasks_few`),
 * falling back to `${keyBase}_other`, and auto-injects `count` into params.
 */
export function tPlural(
  locale: LocaleCode | null | undefined,
  keyBase: string,
  count: number,
  params?: Record<string, string | number>,
): string {
  const loc = normalizeLocale(locale, 'ru');
  const tag = intlLocaleTag(loc);
  let rule: Intl.LDMLPluralRule = 'other';
  try {
    rule = new Intl.PluralRules(tag).select(count);
  } catch {
    rule = count === 1 ? 'one' : 'other';
  }
  const mergedParams: Record<string, string | number> = { count, ...(params ?? {}) };
  const exactKey = `${keyBase}_${rule}`;
  const fallbackKey = `${keyBase}_other`;

  const template =
    lookupKey(catalogs[loc], exactKey) ??
    lookupKey(catalogs[loc], fallbackKey) ??
    lookupKey(catalogs.en, exactKey) ??
    lookupKey(catalogs.en, fallbackKey) ??
    lookupKey(catalogs.ru, exactKey) ??
    lookupKey(catalogs.ru, fallbackKey) ??
    exactKey;

  return interpolate(template, mergedParams);
}

/** Formats a number according to the user's locale. */
export function formatLocaleNumber(
  locale: LocaleCode,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  const loc = normalizeLocale(locale, 'ru');
  try {
    return new Intl.NumberFormat(intlLocaleTag(loc), options).format(value);
  } catch {
    return String(value);
  }
}

/** Formats a Date according to the user's locale and optional IANA time zone. */
export function formatLocaleDate(
  locale: LocaleCode,
  date: Date,
  timeZone?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const loc = normalizeLocale(locale, 'ru');
  const fmtOptions: Intl.DateTimeFormatOptions = {
    ...(options ?? { day: '2-digit', month: '2-digit', year: 'numeric' }),
    ...(timeZone ? { timeZone } : {}),
  };
  try {
    return new Intl.DateTimeFormat(intlLocaleTag(loc), fmtOptions).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Returns all unique button labels across all 4 locales for a given keyboard button key.
 * Useful for routing reply-keyboard taps regardless of which locale was active when the keyboard was sent.
 */
export function getAllKeyboardLabels(buttonKey: KeyboardButtonKey): string[] {
  const labels = new Set<string>();
  const fullKey = `keyboards.${buttonKey}`;
  for (const loc of SUPPORTED_LOCALES) {
    const label = lookupKey(catalogs[loc], fullKey);
    if (label) labels.add(label);
  }
  return [...labels];
}

/** Returns the raw compiled catalog object for a given locale. */
export function getLocaleCatalog(locale: LocaleCode): LocaleCatalog {
  const loc = normalizeLocale(locale, 'ru');
  return catalogs[loc] ?? {};
}

function collectLeafKeys(obj: unknown, prefix: string, out: Set<string>): void {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      out.add(path);
    } else if (v && typeof v === 'object') {
      collectLeafKeys(v, path, out);
    }
  }
}

/** Returns a sorted list of all dotted translation keys across all compiled catalogs. */
export function getAllLocaleKeys(): string[] {
  const keys = new Set<string>();
  for (const loc of SUPPORTED_LOCALES) {
    collectLeafKeys(catalogs[loc], '', keys);
  }
  return [...keys].sort();
}
