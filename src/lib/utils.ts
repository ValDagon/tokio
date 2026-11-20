/**
 * Общие утилиты: деньги, даты/таймзоны, строки.
 *
 * Правила, которые здесь закреплены:
 *  - деньги никогда не считаются float-арифметикой: разбор строки идёт по
 *    разрядам, наружу всегда целые центы;
 *  - «сегодня» и «который час» определяются в таймзоне пользователя, а не в
 *    таймзоне сервера (изоляты живут в UTC);
 *  - модуль чистый: ни платформенных SDK, ни I/O — только чистые функции.
 */

// ---------------------------------------------------------------------------
// Деньги
// ---------------------------------------------------------------------------

/** Символы валют для отображения; ключ — код ISO-4217. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  RUB: '₽',
  RSD: 'дин',
  UAH: '₴',
  KZT: '₸',
  TRY: '₺',
  GEL: '₾',
};

const MAX_AMOUNT_DIGITS = 15;

/** Группировка разрядов неразрывным пробелом? Нет — обычный пробел, чтобы копипаста не ломалась. */
const THOUSANDS_SEPARATOR = ' ';

/**
 * Разбирает пользовательскую сумму в целые центы.
 *
 * Понимает `1 234,56`, `1234.56`, `0,5`, `-10`, `€1.234,56`, `1,234.56`.
 * Последний разделитель считается десятичным, только если после него 1–2 цифры;
 * иначе это разделитель тысяч (`1,234` → 1234, а не 1,23).
 */
export function parseAmountToCents(input: string | number): number {
  if (typeof input === 'number') return toCents(input);

  let text = String(input).trim();
  if (!text) throw new Error('utils.parseAmountToCents: empty amount');

  // пробелы (в т.ч. неразрывные), апострофы-разделители и всё, кроме цифр/знаков
  text = text.replace(/[\s\u00A0\u202F']/g, '').replace(/[^\d.,+\-]/g, '');

  let sign = 1;
  if (text.startsWith('-')) {
    sign = -1;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (!text || !/\d/.test(text)) throw new Error(`utils.parseAmountToCents: not a number "${input}"`);

  const lastSeparator = Math.max(text.lastIndexOf(','), text.lastIndexOf('.'));
  let intPart = text;
  let fracPart = '';

  if (lastSeparator >= 0) {
    const after = text.slice(lastSeparator + 1).replace(/\D/g, '');
    const isDecimal = after.length === 1 || after.length === 2;
    if (isDecimal) {
      intPart = text.slice(0, lastSeparator).replace(/[.,]/g, '');
      fracPart = after;
    } else {
      // разделитель тысяч: цифры после него — часть целой части, а не дробь
      intPart = text.replace(/[.,]/g, '');
    }
  }

  const digits = intPart.replace(/\D/g, '') || '0';
  if (digits.length > MAX_AMOUNT_DIGITS) {
    throw new Error(`utils.parseAmountToCents: amount too large "${input}"`);
  }

  const centsPart = Number(digits) * 100;
  const padded = fracPart.padEnd(3, '0');
  const fraction = Number(padded.slice(0, 2)) + (Number(padded[2] ?? '0') >= 5 ? 1 : 0);

  const cents = centsPart + fraction;
  return cents === 0 ? 0 : sign * cents;
}

/** Float → центы (только для программных значений, не для пользовательского ввода). */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error(`utils.toCents: not a finite number (${amount})`);
  // `1.005 * 100` в double даёт 100.4999…; toPrecision снимает эту погрешность
  return Math.round(Number((amount * 100).toPrecision(15)));
}

/** Центы → «человеческие» единицы валюты (float, только для отображения/расчётов курса). */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** `123456` → `1 234,56`; `-50` → `-0,50`. */
export function formatCents(cents: number, opts: { withSign?: boolean } = {}): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : opts.withSign && rounded > 0 ? '+' : '';
  const abs = Math.abs(rounded);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
  return `${sign}${grouped},${String(fraction).padStart(2, '0')}`;
}

/** `123456, 'EUR'` → `€1 234,56`; для неизвестных кодов — `1 234,56 XYZ`. */
export function formatMoney(cents: number, currency = 'EUR'): string {
  const code = currency.toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const amount = formatCents(cents);
  if (!symbol) return `${amount} ${code}`;
  if (symbol.length > 1) return `${amount} ${symbol}`;
  return `${symbol}${amount}`;
}

/** Сумма списка сумм в центах. */
export function sumCents(values: readonly number[]): number {
  return values.reduce((total, value) => total + Math.round(value), 0);
}

/**
 * Сумма с символом валюты ПОСЛЕ числа: `3 917,29 ₸`.
 *
 * Отдельная функция, а не правка `formatMoney`: там символ стоит перед числом
 * (`₸3 917,29`), и его формат — часть всех прежних ответов бота. Банковские
 * скриншоты печатают валюту хвостом, поэтому ответ по остатку читается так же,
 * как в приложении, без переучивания остальных вызовов.
 */
export function formatCentsWithSuffix(cents: number, currency: string): string {
  const code = String(currency ?? '').trim().toUpperCase();
  const amount = formatCents(cents);
  if (!code) return amount;
  const symbol = CURRENCY_SYMBOLS[code];
  return `${amount} ${symbol ?? code}`;
}

// ---------------------------------------------------------------------------
// Даты и таймзоны
// ---------------------------------------------------------------------------

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const FALLBACK_TIMEZONE = 'UTC';

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Разбирает момент на календарные части в заданной таймзоне (fallback — UTC). */
export function zonedParts(date: Date, timeZone: string = FALLBACK_TIMEZONE): ZonedParts {
  const read = (zone: string): ZonedParts => {
    const parts = partsFormatter(zone).formatToParts(date);
    const get = (type: string): number => {
      const found = parts.find((part) => part.type === type);
      return found ? Number(found.value) : 0;
    };
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      // en-US + hour12:false отдаёт «24» вместо «00» в полночь
      hour: get('hour') % 24,
      minute: get('minute'),
      second: get('second'),
    };
  };

  try {
    return read(timeZone);
  } catch {
    return read(FALLBACK_TIMEZONE);
  }
}

/**
 * Смещение таймзоны относительно UTC в миллисекундах для конкретного момента
 * (учитывает DST). Восточные зоны дают положительное значение.
 */
export function zoneOffsetMs(date: Date, timeZone: string = FALLBACK_TIMEZONE): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Локальная дата `YYYY-MM-DD`. */
export function dateKey(date: Date = new Date(), timeZone: string = FALLBACK_TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** Локальный месяц `YYYY-MM`. */
export function monthKey(date: Date = new Date(), timeZone: string = FALLBACK_TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}`;
}

/** Локальное время `HH:MM`. */
export function timeKey(date: Date = new Date(), timeZone: string = FALLBACK_TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** `06.11.2026` в таймзоне пользователя. */
export function formatDate(date: Date, timeZone: string = FALLBACK_TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  return `${pad2(parts.day)}.${pad2(parts.month)}.${parts.year}`;
}

/** `06.11.2026 09:30`. */
export function formatDateTime(date: Date, timeZone: string = FALLBACK_TIMEZONE): string {
  return `${formatDate(date, timeZone)} ${timeKey(date, timeZone)}`;
}

/** ISO-8601 (UTC) из Date. */
export function toIso(date: Date): string {
  return date.toISOString();
}

/** ISO-8601 → Date; null/пусто → null. */
export function fromIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Начало локальных суток в виде момента UTC. */
export function startOfLocalDay(date: Date = new Date(), timeZone: string = FALLBACK_TIMEZONE): Date {
  const parts = zonedParts(date, timeZone);
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day);
  const first = new Date(naive - zoneOffsetMs(date, timeZone));
  // второй проход — на случай перехода через границу DST
  return new Date(naive - zoneOffsetMs(first, timeZone));
}

/** Прибавить дни (по UTC-шкале; для календарной арифметики от локального дня). */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Прибавить минуты. */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** Один и тот же календарный день в таймзоне пользователя? */
export function isSameLocalDay(
  a: Date,
  b: Date,
  timeZone: string = FALLBACK_TIMEZONE,
): boolean {
  return dateKey(a, timeZone) === dateKey(b, timeZone);
}

/** `'07:00'` → 420 минут с начала суток; кривое значение → null. */
export function parseTimeOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 420 → `'07:00'` (по модулю суток). */
export function formatTimeOfDay(minutes: number): string {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Строки
// ---------------------------------------------------------------------------

/** HTML-escape для Telegram parse_mode=HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Обрезать до `max` символов, добавив многоточие. */
export function truncate(value: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max <= ellipsis.length) return value.slice(0, max);
  return `${value.slice(0, max - ellipsis.length).trimEnd()}${ellipsis}`;
}

/** Схлопнуть все пробельные последовательности в один пробел. */
export function normalizeWhitespace(value: string): string {
  return value.replace(/[\s\u00A0\u202F]+/g, ' ').trim();
}

const TRANSLITERATION: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** `«Утренний дайджест»` → `utrenniy-daydzhest`. */
export function slugify(value: string): string {
  const lower = normalizeWhitespace(value).toLowerCase();
  let transliterated = '';
  for (const char of lower) {
    transliterated += TRANSLITERATION[char] ?? char;
  }
  return transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
