/**
 * DAL таблицы `users` — профиль, настройки, квоты и BYOK.
 *
 * `users.id` — это telegram user id (PK без autoincrement), поэтому отдельного
 * `user_id` в таблице нет: сама строка и есть пользователь.
 *
 * Кодирование значений (SPEC §2.4): булевы — INTEGER 0/1, даты — только ISO-строки
 * (`nowIso()`), `undefined` в параметры не попадает никогда (только `null`).
 * `created_at`/`updated_at` дефолтов в DDL не имеют — их всегда ставит DAL.
 *
 * Обновление профиля — read-merge-write: частичная сборка `SET` через sql-тег
 * невозможна, поэтому строка читается, мержится по присутствующим ключам патча
 * и пишется одним фиксированным `UPDATE` по всем мутабельным колонкам.
 * Квоты (`quota_tokens`, `quota_month`, `quota_limit`) меняются отдельными
 * точечными запросами и `updated_at` не трогают — это высокочастотный bookkeeping.
 */

import { db, sql } from 'sdk/db';
import type {
  CurrencyCode,
  IsoMonth,
  IsoTimestamp,
  LocaleCode,
  OnboardingStep,
  TimeOfDay,
  UserRow,
} from '../../types.js';
import { normalizeLocale } from '../i18n.js';
import type { ProviderId } from '../provider/types.js';
import { monthKey, nowIso } from '../utils.js';

/** Полный список колонок `users` — в одном месте, чтобы не разъезжались SELECT'ы. */
const USER_COLUMNS = `id, name, language, base_currency, timezone, summary_time, low_stimulation_mode,
  quota_month, quota_tokens, quota_limit, byok_ciphertext, byok_nonce, byok_tag, model_provider,
  onboarding_step, onboarding_completed_at, created_at, updated_at`;

// ---------------------------------------------------------------------------
// Строка БД ↔ доменный объект
// ---------------------------------------------------------------------------

interface UserDbRow {
  id: number;
  name: string | null;
  language: string | null;
  base_currency: string;
  timezone: string;
  summary_time: string;
  low_stimulation_mode: number | null;
  quota_month: string | null;
  quota_tokens: number | null;
  quota_limit: number | null;
  byok_ciphertext: string | null;
  byok_nonce: string | null;
  byok_tag: string | null;
  model_provider: string | null;
  onboarding_step: string | null;
  onboarding_completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** INTEGER 0/1 (или строка) → boolean. */
function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

function mapUser(row: UserDbRow): UserRow {
  return {
    id: Number(row.id),
    name: row.name ?? null,
    language: normalizeLocale(row.language, 'ru'),
    baseCurrency: (row.base_currency ?? 'EUR') as CurrencyCode,
    timezone: row.timezone ?? 'UTC',
    summaryTime: (row.summary_time ?? '07:00') as TimeOfDay,
    lowStimulationMode: toBool(row.low_stimulation_mode),
    quotaMonth: (row.quota_month ?? null) as IsoMonth | null,
    quotaTokens: Number(row.quota_tokens ?? 0),
    quotaLimit: Number(row.quota_limit ?? 0),
    byok:
      row.byok_ciphertext === null
        ? null
        : {
            ciphertext: row.byok_ciphertext,
            nonce: row.byok_nonce ?? '',
            tag: row.byok_tag ?? '',
          },
    modelProvider: (row.model_provider ?? null) as ProviderId | null,
    onboardingStep: (row.onboarding_step ?? 'new') as OnboardingStep,
    onboardingCompletedAt: (row.onboarding_completed_at ?? null) as IsoTimestamp | null,
    createdAt: (row.created_at ?? null) as IsoTimestamp | null,
    updatedAt: (row.updated_at ?? null) as IsoTimestamp | null,
  };
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

/** Пользователь по telegram id; `null`, если строки нет. */
export async function getUser(userId: number): Promise<UserRow | null> {
  const row = await db.get<UserDbRow>(sql`
    SELECT ${sql.raw(USER_COLUMNS)} FROM users WHERE id = ${userId} LIMIT 1
  `);
  return row ? mapUser(row) : null;
}

// ---------------------------------------------------------------------------
// Создание
// ---------------------------------------------------------------------------

/**
 * Гарантирует наличие строки пользователя (паритет Python `ensure_user`).
 *
 * `ON CONFLICT DO NOTHING`: повторный вызов ничего не меняет и, в частности,
 * НЕ перезаписывает имя, уже сохранённое пользователем. Колонки с дефолтами
 * (EUR / UTC / 07:00 / 0) заполняет DDL.
 */
export async function ensureUser(userId: number, name?: string): Promise<UserRow> {
  const now = nowIso();
  await db.run(sql`
    INSERT INTO users (id, name, created_at, updated_at)
    VALUES (${userId}, ${name ?? null}, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
  `);

  const row = await getUser(userId);
  if (!row) throw new Error('users.ensureUser: failed to read the user row back');
  return row;
}

// ---------------------------------------------------------------------------
// Обновление профиля
// ---------------------------------------------------------------------------

/** Частичный патч профиля: отсутствие ключа ≠ `null`. */
export interface UserPatch {
  name?: string | null;
  language?: LocaleCode;
  baseCurrency?: string;
  timezone?: string;
  summaryTime?: string;
  lowStimulationMode?: boolean;
  /** `null` — явная очистка BYOK; отсутствие ключа — ключ не трогаем. */
  byok?: { ciphertext: string; nonce: string; tag?: string } | null;
  /** Провайдер BYOK-ключа; `null` — очистить (легаси = Gemini). */
  modelProvider?: ProviderId | null;
  onboardingStep?: OnboardingStep;
  onboardingCompletedAt?: string | null;
}

/**
 * Частичное обновление профиля (read-merge-write).
 *
 * Возвращает `null`, если пользователя нет (UPDATE в этом случае не выполняется).
 * Пустой патч тоже не пишет в БД — возвращается текущая строка как есть.
 */
export async function updateUser(userId: number, patch: UserPatch): Promise<UserRow | null> {
  const current = await getUser(userId);
  if (!current) return null;

  let name = current.name;
  let language = current.language;
  let baseCurrency = current.baseCurrency;
  let timezone = current.timezone;
  let summaryTime = current.summaryTime;
  let lowStimulationMode = current.lowStimulationMode;
  let byok = current.byok;
  let modelProvider = current.modelProvider;
  let onboardingStep = current.onboardingStep;
  let onboardingCompletedAt = current.onboardingCompletedAt;
  let touched = false;

  if (Object.hasOwn(patch, 'name')) {
    name = patch.name ?? null;
    touched = true;
  }
  if (typeof patch.language === 'string') {
    language = normalizeLocale(patch.language, current.language);
    touched = true;
  }
  if (typeof patch.baseCurrency === 'string') {
    baseCurrency = patch.baseCurrency;
    touched = true;
  }
  if (typeof patch.timezone === 'string') {
    timezone = patch.timezone;
    touched = true;
  }
  if (typeof patch.summaryTime === 'string') {
    summaryTime = patch.summaryTime;
    touched = true;
  }
  if (typeof patch.lowStimulationMode === 'boolean') {
    lowStimulationMode = patch.lowStimulationMode;
    touched = true;
  }
  if (Object.hasOwn(patch, 'byok')) {
    byok = patch.byok
      ? { ciphertext: patch.byok.ciphertext, nonce: patch.byok.nonce, tag: patch.byok.tag ?? '' }
      : null;
    touched = true;
  }
  if (Object.hasOwn(patch, 'modelProvider')) {
    modelProvider = patch.modelProvider ?? null;
    touched = true;
  }
  if (typeof patch.onboardingStep === 'string') {
    onboardingStep = patch.onboardingStep;
    touched = true;
  }
  if (Object.hasOwn(patch, 'onboardingCompletedAt')) {
    onboardingCompletedAt = patch.onboardingCompletedAt ?? null;
    touched = true;
  }

  if (!touched) return current;

  await db.run(sql`
    UPDATE users SET
      name = ${name},
      language = ${language},
      base_currency = ${baseCurrency},
      timezone = ${timezone},
      summary_time = ${summaryTime},
      low_stimulation_mode = ${lowStimulationMode ? 1 : 0},
      byok_ciphertext = ${byok?.ciphertext ?? null},
      byok_nonce = ${byok?.nonce ?? null},
      byok_tag = ${byok?.tag ?? null},
      model_provider = ${modelProvider},
      onboarding_step = ${onboardingStep},
      onboarding_completed_at = ${onboardingCompletedAt},
      updated_at = ${nowIso()}
    WHERE id = ${userId}
  `);

  return getUser(userId);
}

// ---------------------------------------------------------------------------
// Квоты (без изменения updated_at)
// ---------------------------------------------------------------------------

/**
 * Начисляет израсходованные токены за текущий месяц.
 *
 * Один атомарный UPDATE без предварительного чтения: если `quota_month` уже
 * текущий — счётчик инкрементируется, если месяц сменился (или NULL — `CASE NULL = x`
 * не совпадает) — счётчик сбрасывается в `tokens`.
 */
export async function addUsage(userId: number, tokens: number): Promise<void> {
  const month = monthKey();
  await db.run(sql`
    UPDATE users
       SET quota_tokens = CASE WHEN quota_month = ${month} THEN quota_tokens + ${tokens} ELSE ${tokens} END,
           quota_month = ${month}
     WHERE id = ${userId}
  `);
}

/** Месячный лимит токенов пользователя. */
export async function setMonthlyQuota(userId: number, limit: number): Promise<void> {
  await db.run(sql`UPDATE users SET quota_limit = ${limit} WHERE id = ${userId}`);
}
