/**
 * Загрузка golden-master фикстур паритета Python ↔ TS.
 *
 * Фикстуры генерирует `tests/parity/generate.py` (Python-референс из `backend/`).
 * Здесь только чтение и типы: никакой логики, чтобы тесты оставались тонкими.
 */

import { readFileSync } from 'node:fs';
import type { AccountEnvelope, LiabilityQueue } from '../../src/types';

function load<T>(name: string): T {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// Деньги
// ---------------------------------------------------------------------------

export interface MoneyRoundCase {
  id: string;
  amount: number;
  /** Python `round(amount, 2)`. */
  pythonRound2: number;
  /** `int(round(amount, 2) * 100)` — «эталонные» центы Python. */
  pythonRound2Cents: number;
}

export interface MoneyConvertCase {
  id: string;
  amount: number;
  /** `int(round(amount, 2) * 100)` уже в центах входа. */
  amountCents: number;
  currency: string;
  /** Python `convert_to_eur(amount, currency)`. */
  pythonEur: number;
  pythonEurCents: number;
}

export interface MoneyFixture {
  generatedBy: string;
  reference: string;
  now: string;
  rates: Record<string, number>;
  roundCases: MoneyRoundCase[];
  convertCases: MoneyConvertCase[];
}

// ---------------------------------------------------------------------------
// Даты и таймзоны
// ---------------------------------------------------------------------------

export interface ZonedPartsFixture {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ZonedCase {
  id: string;
  instant: string;
  timeZone: string;
  parts: ZonedPartsFixture;
  dateKey: string;
  monthKey: string;
  timeKey: string;
  formatDate: string;
  formatDateTime: string;
}

export interface AddDaysCase {
  id: string;
  instant: string;
  timeZone: string;
  days: number;
  /** Python `(dt.astimezone(tz) + timedelta(days=n)).isoformat()` — wall-clock. */
  pythonIso: string;
}

export interface DatesFixture {
  generatedBy: string;
  reference: string;
  now: string;
  cases: ZonedCase[];
  addDaysCases: AddDaysCase[];
}

// ---------------------------------------------------------------------------
// Повторы
// ---------------------------------------------------------------------------

export interface RecurrenceCase {
  id: string;
  /** Python-строка правила (`daily`, `weekly:2`, …). */
  pythonRule: string;
  /** То же правило в форме TS `RecurrenceRule`. */
  tsRule: {
    freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
    interval?: number;
    until?: string;
  };
  base: string;
  pythonIso: string | null;
  pythonEpochMs: number | null;
}

export interface RecurrenceFixture {
  generatedBy: string;
  reference: string;
  now: string;
  cases: RecurrenceCase[];
}

// ---------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------

export interface RunwayAccountCase {
  name: string;
  currency: string;
  balanceCents: number;
  envelope: AccountEnvelope;
  /** Как это же имя классифицирует Python (`classify_envelope`). */
  pythonEnvelope: string;
}

export interface RunwayLiabilityCase {
  name: string;
  queue: LiabilityQueue;
  currency: string;
  monthlyCents: number;
  paymentDay: number | null;
  account: string | null;
  paidMonths: string[];
}

export interface RunwayPythonResult {
  horizonDays: number;
  daysRemainingInMonth: number;
  totalLiquidCents: number;
  spendableCents: number;
  reservedCents: number;
  cashReserveCents: number;
  pendingThisMonthCents: number;
  pendingHorizonCents: number;
  reservedGapCents: number;
  totalMonthlyObligationsCents: number;
  netLiquidCents: number;
  dailyBurnCents: number;
  safeDailyCents: number;
  safeWeeklyCents: number;
  safeMonthlyCents: number;
  runwayDays: number;
  runwayWeeks: number;
  alreadyPaid: string[];
  upcoming: Array<{ name: string; paymentDay: number | null }>;
  accountEnvelopes: Record<string, string>;
}

export interface RunwayCase {
  id: string;
  today: string;
  horizonDays: number | null;
  dailyBurnOverrideCents: number;
  accounts: RunwayAccountCase[];
  liabilities: RunwayLiabilityCase[];
  python: RunwayPythonResult;
}

export interface RunwayFixture {
  generatedBy: string;
  reference: string;
  now: string;
  rates: Record<string, number>;
  cases: RunwayCase[];
}

export const moneyFixture = load<MoneyFixture>('money');
export const datesFixture = load<DatesFixture>('dates');
export const recurrenceFixture = load<RecurrenceFixture>('recurrence');
export const runwayFixture = load<RunwayFixture>('runway');
