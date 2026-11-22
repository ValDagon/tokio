/**
 * DAL: курсы валют.
 *
 * `fx_rates` — единственная ГЛОБАЛЬНАЯ таблица финансов (см. `src/db/tables.ts`):
 * у неё нет `user_id`, курсы общие для всех пользователей, поэтому в этом модуле
 * нет обязательного параметра userId.
 *
 * Модель курса (как в upstream `backend/app/services/fx.py`):
 *  - `base` — базовая валюта (по умолчанию EUR);
 *  - `rates[X]` — сколько единиц X дают за 1 единицу базовой валюты.
 *    `{ USD: 1.08 }` при базе EUR означает «1 EUR = 1.08 USD».
 *
 * Следствия:
 *  - сумма в X → базовая: `amount / rates[X]`;
 *  - сумма в базовой → X: `amount * rates[X]`;
 *  - X → Y: `amount * rates[X] / rates[Y]` (через базовую, одно округление).
 *
 * Деньги — целые центы. `convert()` — чистая синхронная функция: курсы
 * передаются явно, никакого I/O. Если курса нет, а валюта не базовая —
 * бросаем ошибку: молчаливая подстановка 1.0 искажает суммы (в upstream это
 * FALLBACK_RATES, здесь источник курсов — данные пользователя/БД).
 */

import { db, sql } from 'sdk/db';
import type { Cents, CurrencyCode, FxRateRow, IsoDate } from '../../types.js';

/** Базовая валюта хранения курсов. */
export const BASE_CURRENCY = 'EUR';

/** Таблица курсов: `{ USD: 1.08, … }` — единиц валюты за 1 базовую. */
export type RateTable = Readonly<Record<string, number>>;

/** Синонимы стейблкоинов: в upstream считаются долларом. */
const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  USDT: 'USD',
  USDC: 'USD',
};

// ---------------------------------------------------------------------------
// Коды валют и даты
// ---------------------------------------------------------------------------

/** `'usdt '` → `'USD'`; пустая строка — ошибка. */
export function normalizeCurrency(code: CurrencyCode): string {
  const normalized = String(code ?? '')
    .trim()
    .toUpperCase();
  if (!normalized) throw new Error('fx: currency code is required');
  return CURRENCY_ALIASES[normalized] ?? normalized;
}

/** Сегодняшняя дата в UTC, `YYYY-MM-DD`. */
export function todayIso(): IsoDate {
  return new Date().toISOString().slice(0, 10);
}

/** Приводит дату (`2026-11-06` или полный ISO) к `YYYY-MM-DD`. */
export function normalizeDate(date: IsoDate | Date): IsoDate {
  const raw = date instanceof Date ? date.toISOString() : String(date ?? '').trim();
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`fx: invalid date "${String(date)}"`);
  return day;
}

// ---------------------------------------------------------------------------
// Разбор/сборка таблицы курсов
// ---------------------------------------------------------------------------

/** Проверяет и нормализует таблицу курсов (ключи — коды валют, значения > 0). */
export function toRateTable(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const rate = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    try {
      out[normalizeCurrency(key)] = rate;
    } catch {
      // мусорный ключ — просто пропускаем
    }
  }
  return out;
}

/** json-колонка `rates` (TEXT) → объект. Битый json → пустая таблица. */
export function parseRates(raw: unknown): Record<string, number> {
  if (raw && typeof raw === 'object') return toRateTable(raw);
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    return toRateTable(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

interface FxRateDbRow {
  date: string;
  base: string;
  rates: string | null;
  updated_at: string | null;
}

function mapFxRate(row: FxRateDbRow): FxRateRow {
  return {
    date: row.date,
    base: row.base,
    rates: parseRates(row.rates),
    updatedAt: row.updated_at ?? null,
  };
}

/** Курс на конкретную дату; `null`, если записи нет. */
export async function getRate(
  date: IsoDate | Date,
  base: CurrencyCode = BASE_CURRENCY,
): Promise<FxRateRow | null> {
  const row = await db.get<FxRateDbRow>(
    sql`SELECT date, base, rates, updated_at FROM fx_rates
        WHERE date = ${normalizeDate(date)} AND base = ${normalizeCurrency(base)}
        LIMIT 1`,
  );
  return row ? mapFxRate(row) : null;
}

/** Самый свежий сохранённый курс (по убыванию даты). */
export async function getLatestRate(base: CurrencyCode = BASE_CURRENCY): Promise<FxRateRow | null> {
  const row = await db.get<FxRateDbRow>(
    sql`SELECT date, base, rates, updated_at FROM fx_rates
        WHERE base = ${normalizeCurrency(base)}
        ORDER BY date DESC
        LIMIT 1`,
  );
  return row ? mapFxRate(row) : null;
}

/**
 * Готовая таблица курсов: на дату, а без даты — самая свежая.
 * Пустой объект, если курсов ещё нет (вызывающий сам решает, что делать).
 */
export async function getRates(
  date?: IsoDate | Date | null,
  base: CurrencyCode = BASE_CURRENCY,
): Promise<Record<string, number>> {
  const row = date ? await getRate(date, base) : await getLatestRate(base);
  return row ? { ...row.rates } : {};
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

/**
 * Сохраняет курсы на дату (upsert по PK `date+base`).
 * `rates` — единицы валюты за 1 базовую; ключ базовой валюты не обязателен.
 */
export async function setRates(
  date: IsoDate | Date,
  rates: RateTable,
  base: CurrencyCode = BASE_CURRENCY,
): Promise<FxRateRow> {
  const day = normalizeDate(date);
  const baseCurrency = normalizeCurrency(base);
  const table = toRateTable(rates);
  if (Object.keys(table).length === 0) throw new Error('fx.setRates: rates table is empty');

  const now = new Date().toISOString();
  await db.run(sql`
    INSERT INTO fx_rates (date, base, rates, updated_at)
    VALUES (${day}, ${baseCurrency}, ${JSON.stringify(table)}, ${now})
    ON CONFLICT (date, base) DO UPDATE SET
      rates = excluded.rates,
      updated_at = excluded.updated_at
  `);

  const saved = await getRate(day, baseCurrency);
  if (!saved) throw new Error('fx.setRates: failed to read back the saved rates');
  return saved;
}

// ---------------------------------------------------------------------------
// Конвертация (чистые функции)
// ---------------------------------------------------------------------------

/**
 * Сумма в EUR-центах по курсу на момент чтения; `null`, если курса валюты нет.
 *
 * Нужна там, где в строке БД лежит сохранённый `amount_eur_cents`: он устаревает
 * вместе с курсом, и один и тот же платёж показывался двумя разными суммами в
 * `/liabilities` (сохранённая) и в `/runway` (живая).
 */
export function toEurCents(cents: number, currency: CurrencyCode, rates: RateTable): number | null {
  const code = normalizeCurrency(currency);
  if (code === BASE_CURRENCY) return Math.round(cents);
  if (!hasRate(code, rates)) return null;
  try {
    return convert(cents, code, BASE_CURRENCY, rates);
  } catch {
    return null;
  }
}

/** Есть ли курс для валюты (с учётом базовой — она всегда 1). */
export function hasRate(currency: CurrencyCode, rates: RateTable): boolean {
  const code = normalizeCurrency(currency);
  if (code === BASE_CURRENCY) return true;
  const rate = rates[code];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
}

/**
 * Курс «1 базовая = rate единиц валюты».
 * Для базовой валюты — 1; для неизвестной — ошибка.
 */
export function rateOf(currency: CurrencyCode, rates: RateTable): number {
  const code = normalizeCurrency(currency);
  if (code === BASE_CURRENCY) return 1;
  const rate = rates[code];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`fx: no rate for ${code}`);
  }
  return rate;
}

/**
 * Конвертация целых центов между валютами через базовую.
 * Округление одно — на последнем шаге (никакой накопленной погрешности).
 */
export function convert(
  amountCents: Cents,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: RateTable,
): Cents {
  if (!Number.isFinite(amountCents)) throw new Error('fx.convert: amount must be a finite number');
  const fromCode = normalizeCurrency(from);
  const toCode = normalizeCurrency(to);
  if (fromCode === toCode) return Math.round(amountCents);

  const fromRate = rateOf(fromCode, rates);
  const toRate = rateOf(toCode, rates);
  // rates[X] — единиц X за 1 базовую: X → базовая делим на fromRate,
  // базовая → Y умножаем на toRate.
  return Math.round((amountCents * toRate) / fromRate);
}

/**
 * Округление конвертации вверх до ближайшей суммы вида `x,99`.
 *
 * Решение владельца (22.11.2026): при обмене валюты сумма зачисления округляется
 * только вверх, чтобы обмен никогда не терял деньги на округлении:
 * 30,23 → 30,99; 0,50 → 0,99. Сумма, уже кратная `,99` или целому числу, не
 * меняется — иначе точный перевод получал бы лишние 99 копеек.
 *
 * Округление применяется ТОЛЬКО к конвертации; расходы, доходы и переводы
 * в одной валюте остаются точными.
 */
export function roundUpToNextNinetyNine(cents: Cents): Cents {
  if (!Number.isFinite(cents)) throw new Error('fx.roundUpToNextNinetyNine: finite amount required');
  const value = Math.round(cents);
  if (value <= 0) return 0;
  const rest = value % 100;
  if (rest === 99 || rest === 0) return value;
  return Math.floor(value / 100) * 100 + 99;
}

/**
 * Множитель для `transactions.fx_rate`: сколько базовой валюты в 1 единице.
 * В upstream `fx_rate = amount_eur / amount`, то есть 1 / rate.
 */
export function eurPerUnit(currency: CurrencyCode, rates: RateTable): number {
  const code = normalizeCurrency(currency);
  if (code === BASE_CURRENCY) return 1;
  return 1 / rateOf(code, rates);
}

/** Сумма в базовой валюте (короткий алиас для `convert(..., BASE_CURRENCY, ...)`). */
export function toBase(amountCents: Cents, currency: CurrencyCode, rates: RateTable): Cents {
  return convert(amountCents, currency, BASE_CURRENCY, rates);
}
