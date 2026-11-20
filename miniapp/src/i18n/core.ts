import ru from './locales/ru.json';
import en from './locales/en.json';
import sr from './locales/sr.json';
import ja from './locales/ja.json';

export const SUPPORTED_LOCALES = ['ru', 'en', 'sr', 'ja'] as const;
export type LocaleCode = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_STORAGE_KEY = 'tokio_locale';

export const LOCALE_BCP47: Record<LocaleCode, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  sr: 'sr-Latn',
  ja: 'ja-JP',
};

export const LOCALE_LABELS: Record<LocaleCode, string> = {
  ru: 'RU',
  en: 'EN',
  sr: 'SR',
  ja: 'JA',
};

export type LocaleDict = typeof ru;

export const LOCALE_MESSAGES: Record<LocaleCode, LocaleDict> = {
  ru,
  en,
  sr,
  ja,
};

export function normalizeLocale(raw?: string | null, fallback: LocaleCode = 'ru'): LocaleCode {
  if (!raw || typeof raw !== 'string') return fallback;
  const cleaned = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!cleaned) return fallback;
  const base = cleaned.split('-')[0];
  if (base === 'ru' || base === 'uk' || base === 'be') return 'ru';
  if (base === 'en') return 'en';
  if (base === 'sr' || base === 'sh' || base === 'bs' || base === 'hr') return 'sr';
  if (base === 'ja' || base === 'jp') return 'ja';
  if ((SUPPORTED_LOCALES as readonly string[]).includes(base)) {
    return base as LocaleCode;
  }
  return fallback;
}

export function getStoredLocale(): LocaleCode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) return null;
    const normalized = normalizeLocale(raw, 'ru');
    return (SUPPORTED_LOCALES as readonly string[]).includes(raw.trim().toLowerCase())
      ? normalized
      : normalizeLocale(raw, 'ru');
  } catch {
    return null;
  }
}

export function setStoredLocale(locale: LocaleCode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // storage unavailable
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

export function detectInitialLocale(settingsLanguage?: string | null): LocaleCode {
  if (settingsLanguage) {
    return normalizeLocale(settingsLanguage, 'ru');
  }
  const stored = getStoredLocale();
  if (stored) {
    return stored;
  }
  if (typeof window !== 'undefined') {
    const tgLang = window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
    if (tgLang) {
      return normalizeLocale(tgLang, 'ru');
    }
  }
  return 'ru';
}

export function getActiveLocale(): LocaleCode {
  return getStoredLocale() || 'ru';
}

function resolveKey(dict: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split('.');
  let current: unknown = dict;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export function translate(
  locale: LocaleCode,
  key: string,
  vars?: Record<string, string | number>
): string {
  const dict = LOCALE_MESSAGES[locale] as unknown as Record<string, unknown>;
  let template = resolveKey(dict, key);
  if (template === undefined && locale !== 'en') {
    template = resolveKey(LOCALE_MESSAGES.en as unknown as Record<string, unknown>, key);
  }
  if (template === undefined && locale !== 'ru') {
    template = resolveKey(LOCALE_MESSAGES.ru as unknown as Record<string, unknown>, key);
  }
  if (template === undefined) {
    return key;
  }
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const val = vars[name];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

export function formatNumber(
  locale: LocaleCode,
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  const bcp47 = LOCALE_BCP47[locale] || 'ru-RU';
  try {
    return new Intl.NumberFormat(bcp47, options).format(value);
  } catch {
    return String(value);
  }
}

export function formatDate(
  locale: LocaleCode,
  date: Date | string | number,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const bcp47 = LOCALE_BCP47[locale] || 'ru-RU';
  try {
    return new Intl.DateTimeFormat(bcp47, options).format(d);
  } catch {
    return d.toISOString();
  }
}

export function formatCurrency(
  locale: LocaleCode,
  amount: number,
  currency: string = 'EUR',
  options?: Intl.NumberFormatOptions
): string {
  const code = (currency || 'EUR').trim().toUpperCase();
  const formatted = formatNumber(locale, amount, options);
  switch (code) {
    case 'EUR':
      return `${formatted} €`;
    case 'RUB':
      return `${formatted} ₽`;
    case 'USD':
      return `$${formatted}`;
    case 'KZT':
      return `${formatted} ₸`;
    case 'TRY':
      return `${formatted} ₺`;
    default:
      return `${formatted} ${code}`;
  }
}
