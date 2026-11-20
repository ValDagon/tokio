/**
 * Биллинг LLM: прайс, стоимость вызова, учёт расхода и месячные квоты.
 *
 * Порт `backend/app/services/token_tracker.py` с поправкой на платформу:
 * деньги в SQLite хранятся целыми (SPEC §2.4), поэтому стоимость считается в
 * **микро-долларах** (`llm_usage.cost_micros`), а цены задаются как микро-USD
 * за 1M токенов — так арифметика остаётся целочисленной и не накапливает
 * float-погрешность (`Decimal` из Python здесь не нужен).
 *
 * Две независимые вещи, которые легко перепутать:
 *  - `llm_usage` — бухгалтерская история вызовов (токены + стоимость);
 *  - `users.quota_tokens` / `users.quota_month` — быстрый счётчик месячной
 *    продуктовой квоты в токенах. Его двигает только `recordUsage` и только
 *    для пользователей без своего ключа: BYOK-трафик оплачивает сам бета-тестер,
 *    поэтому квоту продукта он не расходует.
 *
 * `quota_limit <= 0` — «без лимита» (дефолт DDL), `byok != null` — безлимит по
 * определению. Обе ветки возвращают `remaining: null`, чтобы вызывающий код не
 * путал «без лимита» с «ноль осталось».
 */

import { monthKey } from './utils.js';
import * as misc from './dal/misc.js';
import * as usersDal from './dal/users.js';
import { getConfig } from './config.js';
import { getAssistantName, getOverlay } from './overlay.js';
import { t, type LocaleCode } from './i18n.js';
import type { ProviderId } from './provider/types.js';
import type { IsoMonth, LlmUsageRow } from '../types.js';

// ---------------------------------------------------------------------------
// Прайс
// ---------------------------------------------------------------------------

/**
 * Цена модели в микро-долларах за 1M токенов.
 *
 * Источник — `PRICING_PER_MILLION` из `token_tracker.py`: там цены в USD,
 * здесь они умножены на 1e6 (0.075 USD → 75 000 µUSD). Набор ключей и
 * дефолт сохранены один в один, чтобы расчёты совпадали с Python-версией.
 */
export interface ModelPricing {
  /** Вход (prompt), µUSD за 1M токенов. */
  inputMicrosPerMillion: number;
  /** Выход (completion), µUSD за 1M токенов. */
  outputMicrosPerMillion: number;
}

/** Дефолтная ставка: всё, чего нет в таблице, считается как Gemini Flash. */
export const DEFAULT_PRICING: ModelPricing = {
  inputMicrosPerMillion: 75_000,
  outputMicrosPerMillion: 300_000,
};

/** Точная копия `PRICING_PER_MILLION` (в µUSD за 1M токенов). */
export const PRICING_PER_MILLION: Readonly<Record<string, ModelPricing>> = {
  'deepseek/deepseek-v4.1-flash': { inputMicrosPerMillion: 140_000, outputMicrosPerMillion: 280_000 },
  'anthropic/claude-haiku-5.5': { inputMicrosPerMillion: 800_000, outputMicrosPerMillion: 4_000_000 },
  'google/gemini-2.5-flash': { inputMicrosPerMillion: 75_000, outputMicrosPerMillion: 300_000 },
  'gemini-2.5-flash': { inputMicrosPerMillion: 75_000, outputMicrosPerMillion: 300_000 },
  'gemini-3.8-flash': { inputMicrosPerMillion: 75_000, outputMicrosPerMillion: 300_000 },
  'gemini-4-hydrogen': { inputMicrosPerMillion: 75_000, outputMicrosPerMillion: 300_000 },
  'gemini-flash-latest': { inputMicrosPerMillion: 75_000, outputMicrosPerMillion: 300_000 },
  'gemini-3-flash-preview': { inputMicrosPerMillion: 75_000, outputMicrosPerMillion: 300_000 },
  // Не-Gemini модели, которые появляются при `LLM_PROVIDER`/BYOK другого провайдера.
  // Без этих ставок расход считался бы по дефолту Gemini Flash и лимит $2 в
  // публичной редакции занижал бы реальную стоимость.
  'gpt-4o-mini': { inputMicrosPerMillion: 150_000, outputMicrosPerMillion: 600_000 },
  'gpt-4o': { inputMicrosPerMillion: 2_500_000, outputMicrosPerMillion: 10_000_000 },
  'deepseek-chat': { inputMicrosPerMillion: 270_000, outputMicrosPerMillion: 1_100_000 },
  'claude-sonnet-4-5': { inputMicrosPerMillion: 3_000_000, outputMicrosPerMillion: 15_000_000 },
  'claude-haiku-4-5': { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 5_000_000 },
  default: DEFAULT_PRICING,
};

/**
 * Ставка модели; неизвестная модель (в т.ч. `''`) — дефолтная.
 *
 * Датированные ID (`claude-sonnet-4-5-20250929`) сопоставляются с базовым
 * ключом по префиксу. Более длинные ключи проверяются первыми, иначе
 * `gpt-4o-mini-…` поймал бы ставку `gpt-4o`.
 */
export function priceForModel(model: string): ModelPricing {
  const key = String(model ?? '').trim();
  const exact = PRICING_PER_MILLION[key];
  if (exact) return exact;

  const patterns = Object.keys(PRICING_PER_MILLION)
    .filter((pattern) => pattern !== 'default')
    .sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    if (key.startsWith(`${pattern}-`)) return PRICING_PER_MILLION[pattern]!;
  }
  return DEFAULT_PRICING;
}

/** Неотрицательное целое из чего угодно (токены из API бывают `null`). */
export function tokenCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Стоимость вызова в микро-долларах.
 *
 * Формула Python: `prompt/1e6*in + completion/1e6*out`. Здесь то же самое, но
 * на целых: сумма µUSD делится на 1M один раз, в конце — округление до
 * ближайшего микро-доллара (стоимость одного вызова меньше 1 µUSD не бывает
 * значимой, а дробные микро-доллары в целочисленную колонку не влезают).
 */
export function estimateCostMicros(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = priceForModel(model);
  const prompt = tokenCount(promptTokens);
  const completion = tokenCount(completionTokens);
  return Math.round(
    (prompt * pricing.inputMicrosPerMillion + completion * pricing.outputMicrosPerMillion) / 1_000_000,
  );
}

// ---------------------------------------------------------------------------
// Пользователь и BYOK
// ---------------------------------------------------------------------------

/** Пользуется ли пользователь своим ключом (и, значит, не тратит квоту). */
export async function isByokUser(userId: number): Promise<boolean> {
  const user = await usersDal.getUser(userId);
  return user !== null && user.byok !== null;
}

// ---------------------------------------------------------------------------
// Запись расхода
// ---------------------------------------------------------------------------

export interface RecordUsageInput {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** `agent` | `summary` | `embedding` | `classifier` | … */
  purpose?: string | null;
  /**
   * Готовая стоимость в µUSD. Если не задана — считается по прайсу модели.
   * Нужна, когда цена известна из другого источника (кэш, служебный вызов).
   */
  costMicros?: number;
  /**
   * Явное переопределение BYOK-детекта. По умолчанию смотрим на
   * `users.byok`: заполнен — вызов бесплатный для продукта.
   */
  byok?: boolean;
}

/** Результат учёта: что посчитали, сколько записали и списали ли квоту. */
export interface UsageRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  byok: boolean;
  /** Строка `llm_usage`; `null` для BYOK-вызова (в бухгалтерию продукта не пишем). */
  row: LlmUsageRow | null;
  /** Списаны ли токены с продуктовой квоты (для BYOK — никогда). */
  charged: boolean;
}

/**
 * Учитывает один вызов модели.
 *
 * Не бросает на отсутствующего пользователя: сервисный вызов вполне может
 * случиться до `ensureUser` (например, фоновый прогрев). В этом случае строка
 * в `llm_usage` появится, а квота не сдвинется — `addUsage` просто не найдёт
 * строку `users`.
 *
 * Ошибки БД не глотаются: вызывающий код (gemini-клиент) сам решает, считать
 * ли сбой учёта фатальным. По умолчанию — нет, поэтому там стоит try/catch.
 */
export async function recordUsage(userId: number, input: RecordUsageInput): Promise<UsageRecord> {
  const model = String(input.model ?? '').trim();
  if (!model) throw new Error('billing.recordUsage: model is required');

  const promptTokens = tokenCount(input.promptTokens);
  const completionTokens = tokenCount(input.completionTokens);
  const costMicros = Math.max(
    0,
    Math.trunc(input.costMicros ?? estimateCostMicros(model, promptTokens, completionTokens)),
  );

  const user = await usersDal.getUser(userId);
  const byok = input.byok ?? (user !== null && user.byok !== null);

  if (byok) {
    return {
      model,
      promptTokens,
      completionTokens,
      costMicros,
      byok: true,
      row: null,
      charged: false,
    };
  }

  const row = await misc.recordUsage(userId, {
    model,
    promptTokens,
    completionTokens,
    costMicros,
    purpose: input.purpose ?? 'agent',
  });

  const charged = user !== null;
  if (charged) await usersDal.addUsage(userId, promptTokens + completionTokens);

  return { model, promptTokens, completionTokens, costMicros, byok: false, row, charged };
}

/** Расход за месяц (`YYYY-MM`, по умолчанию текущий) — сводка из `llm_usage`. */
export async function getMonthUsage(userId: number, month?: IsoMonth): Promise<misc.UsageTotals> {
  return misc.monthUsage(userId, month);
}

/** Расход за всё время — сводка из `llm_usage`. */
export async function getTotalUsage(userId: number): Promise<misc.UsageTotals> {
  return misc.totalUsage(userId);
}

// ---------------------------------------------------------------------------
// Квоты
// ---------------------------------------------------------------------------

export type QuotaReason = 'byok' | 'unlimited' | 'ok' | 'exhausted';

/** Состояние квоты пользователя на текущий месяц. */
export interface QuotaStatus {
  /** Можно ли выполнить вызов. */
  allowed: boolean;
  /** Трафик идёт по ключу пользователя. */
  byok: boolean;
  /** Месячный лимит в токенах; `0` — без лимита. */
  limit: number;
  /** Израсходовано в текущем месяце (токены). */
  used: number;
  /** Сколько осталось; `null` — лимита нет. */
  remaining: number | null;
  reason: QuotaReason;
  /** Месяц, к которому относится счётчик. */
  month: IsoMonth;
}

/**
 * Проверяет, укладывается ли пользователь в месячную квоту.
 *
 * @param userId telegram id; отсутствие строки — ошибка (квоту не с чем сверять)
 * @param tokens сколько токенов собирается потратить вызывающий (0 — «просто
 *               покажи состояние»); отрицательные значения игнорируются
 */
export async function checkQuota(userId: number, tokens = 0): Promise<QuotaStatus> {
  const user = await usersDal.getUser(userId);
  if (!user) throw new Error(`billing.checkQuota: user ${userId} not found`);

  const month = monthKey();
  // Счётчик в `users` сбрасывается лениво при первой записи нового месяца,
  // поэтому «прошломесячные» токены считаем нулём, не дожидаясь `addUsage`.
  const used = user.quotaMonth === month ? tokenCount(user.quotaTokens) : 0;
  const planned = tokenCount(tokens);

  if (user.byok !== null) {
    return { allowed: true, byok: true, limit: user.quotaLimit, used, remaining: null, reason: 'byok', month };
  }

  if (user.quotaLimit <= 0) {
    return { allowed: true, byok: false, limit: 0, used, remaining: null, reason: 'unlimited', month };
  }

  const remaining = Math.max(0, user.quotaLimit - used);
  const allowed = used + planned <= user.quotaLimit;
  return {
    allowed,
    byok: false,
    limit: user.quotaLimit,
    used,
    remaining,
    reason: allowed ? 'ok' : 'exhausted',
    month,
  };
}

// ---------------------------------------------------------------------------
// Лимит расхода общего ключа (2 USD на пользователя)
// [public-only] Приветственный лимит есть только в публичной редакции; см. HANDOFF §7.1.
// ---------------------------------------------------------------------------

/** Лимит расхода общего ключа по умолчанию: 2 USD в микро-долларах. */
export const DEFAULT_USER_SPEND_LIMIT_MICROS = 2_000_000;

export function spendLimitExceededMessage(locale: LocaleCode = 'ru'): string {
  const overlay = getOverlay();
  return t(locale, 'billing.spendLimitExceeded', {
    assistantName: getAssistantName(locale),
    limitUsd: overlay.manifest.features.spendLimitUsd.toFixed(2),
  });
}

export const SPEND_LIMIT_EXCEEDED_MESSAGE = spendLimitExceededMessage('ru');

export type SpendLimitReason = 'owner' | 'admin' | 'byok' | 'ok' | 'exhausted' | 'disabled';

export interface SpendLimitStatus {
  allowed: boolean;
  totalCostMicros: number;
  limitMicros: number;
  remainingMicros: number | null;
  isOwnerOrAdmin: boolean;
  hasByok: boolean;
  reason: SpendLimitReason;
}

/**
 * Проверяет, укладывается ли пользователь в лимит расхода на общий ключ.
 * Админы из config.adminIds и пользователи со своим BYOK-ключом не ограничиваются.
 *
 * BYOK освобождает только от расхода **своего** провайдера: ключ Gemini не
 * оплачивает вызовы продукта к OpenAI/Anthropic. Легаси-записи без провайдера
 * считаются Gemini.
 */
export async function checkSpendLimit(
  userId: number,
  provider: ProviderId = 'gemini',
): Promise<SpendLimitStatus> {
  const overlay = getOverlay();
  if (!overlay.manifest.features.spendLimitEnabled) {
    return {
      allowed: true,
      totalCostMicros: 0,
      limitMicros: 0,
      remainingMicros: null,
      isOwnerOrAdmin: false,
      hasByok: false,
      reason: 'disabled',
    };
  }

  const limitMicros = Math.round(overlay.manifest.features.spendLimitUsd * 1_000_000);
  const config = await getConfig();
  const isAdmin = config.adminIds.includes(userId);

  if (isAdmin) {
    const totals = await misc.totalUsage(userId);
    return {
      allowed: true,
      totalCostMicros: totals.costMicros,
      limitMicros,
      remainingMicros: null,
      isOwnerOrAdmin: true,
      hasByok: false,
      reason: 'admin',
    };
  }

  const user = await usersDal.getUser(userId);
  const byokProvider = user?.modelProvider ?? 'gemini';
  const hasByok =
    user !== null &&
    user.byok !== null &&
    Boolean(user.byok.ciphertext) &&
    byokProvider === provider;
  if (hasByok) {
    const totals = await misc.totalUsage(userId);
    return {
      allowed: true,
      totalCostMicros: totals.costMicros,
      limitMicros,
      remainingMicros: null,
      isOwnerOrAdmin: false,
      hasByok: true,
      reason: 'byok',
    };
  }

  const totals = await misc.totalUsage(userId);
  const remaining = Math.max(0, limitMicros - totals.costMicros);
  const allowed = totals.costMicros < limitMicros;

  return {
    allowed,
    totalCostMicros: totals.costMicros,
    limitMicros,
    remainingMicros: remaining,
    isOwnerOrAdmin: false,
    hasByok: false,
    reason: allowed ? 'ok' : 'exhausted',
  };
}
