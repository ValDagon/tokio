/**
 * Конфигурация приложения: секреты + нейтральные дефолты.
 *
 * Источники значений (по убыванию приоритета):
 *  1. `setConfigOverrides()` — только для тестов;
 *  2. переменные окружения — локальная разработка;
 *  3. `tgcloud/lib/secrets.js` — файл, который создаётся при деплое и в репозиторий
 *     не попадает (есть только `secrets.example.js`);
 *  4. дефолты этого модуля.
 *
 * Файл `secrets.js` подключается динамическим импортом с переменным спецификатором:
 * при локальных тестах его нет, и это НЕ ошибка — модуль тихо откатывается на env
 * и дефолты. Поэтому тесты не требуют секретов и не падают на их отсутствии.
 *
 * Дефолты намеренно нейтральные (SPEC-ADDENDUM §B): никаких городов/банков/валют
 * конкретного пользователя — таймзона `UTC`, валюта `EUR`, дайджест `07:00`.
 * Реальные значения задаются при онбординге (users.timezone, users.base_currency).
 */

import * as edgeSecretsModule from './secrets.js';
import { DEFAULT_PROVIDER, parseProviderId, type ProviderId } from './provider/index.js';

/** Нейтральная таймзона по умолчанию. */
export const DEFAULT_TIMEZONE = 'UTC';

/** Базовая валюта по умолчанию. */
export const DEFAULT_BASE_CURRENCY = 'EUR';

/** Время утреннего дайджеста по умолчанию. */
export const DEFAULT_SUMMARY_TIME = '07:00';

/** Цепочка fallback-моделей Gemini (от свежей к запасным). */
export const DEFAULT_GEMINI_MODELS: readonly string[] = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];

/** Нейтральная цепочка OpenAI: используется, только если провайдер выбран явно. */
export const DEFAULT_OPENAI_MODELS: readonly string[] = ['gpt-4o-mini', 'gpt-4o'];

/** Нейтральная цепочка DeepSeek. */
export const DEFAULT_DEEPSEEK_MODELS: readonly string[] = ['deepseek-chat'];

/** Нейтральная цепочка Anthropic. */
export const DEFAULT_ANTHROPIC_MODELS: readonly string[] = ['claude-sonnet-4-5', 'claude-haiku-4-5'];

/** Форма `tgcloud/lib/secrets.js`. */
export interface AppSecrets {
  GEMINI_API_KEY?: string;
  MASTER_KEY?: string;
  BETA_WHITELIST?: string | readonly (string | number)[];
  ADMIN_IDS?: string | readonly (string | number)[];
  [key: string]: unknown;
}

export interface AppConfig {
  /** Ключ Gemini API (пустая строка, если не сконфигурирован). */
  geminiApiKey: string;
  /** Ключи остальных провайдеров (пустая строка — провайдер не сконфигурирован). */
  openaiApiKey: string;
  deepseekApiKey: string;
  anthropicApiKey: string;
  /** Провайдер чата по умолчанию (env `LLM_PROVIDER`). */
  chatProvider: ProviderId;
  /** Мастер-ключ для BYOK-шифрования (пустая строка, если не сконфигурирован). */
  masterKey: string;
  /** Telegram user ids бета-тестеров. */
  betaWhitelist: number[];
  /** Telegram user ids администраторов. */
  adminIds: number[];
  /** Таймзона для новых пользователей (дальше живёт в users.timezone). */
  defaultTimezone: string;
  /** Валюта для новых пользователей (дальше живёт в users.base_currency). */
  defaultBaseCurrency: string;
  /** Время утреннего дайджеста для новых пользователей. */
  defaultSummaryTime: string;
  /** Цепочка моделей Gemini: первая — основная, остальные — fallback. */
  geminiModels: string[];
  /** Цепочки остальных провайдеров (порядок тот же: основная → fallback). */
  openaiModels: string[];
  deepseekModels: string[];
  anthropicModels: string[];
  /** Переопределения базовых URL (пустая строка — официальный адрес). */
  openaiBaseUrl: string;
  deepseekBaseUrl: string;
  anthropicBaseUrl: string;
}

// ---------------------------------------------------------------------------
// Секреты
// ---------------------------------------------------------------------------

/**
 * Спецификатор вынесен в переменную осознанно: так сборщик не пытается
 * резолвить несуществующий модуль на этапе сборки, а импорт можно обернуть
 * в try/catch и получить предсказуемый фолбэк.
 */
/**
 * Читает `secrets.js`: статический импорт гарантирует, что в V8 isolate на
 * tgcloud.ai ключи (GEMINI_API_KEY, MASTER_KEY, ADMIN_IDS) загружаются
 * надёжно и синхронно без сбоев `TypeError: Not supported` от dynamic import().
 * В окружении Vitest отдаёт `{}` для изоляции тестов от секретов хоста.
 */
export async function loadSecrets(): Promise<AppSecrets> {
  if (typeof process !== 'undefined' && process.env && process.env.VITEST) {
    return {};
  }
  const secrets = (edgeSecretsModule as { default?: AppSecrets }).default ?? edgeSecretsModule;
  return secrets && typeof secrets === 'object' ? (secrets as AppSecrets) : {};
}

function readEnv(): Record<string, string | undefined> {
  if (typeof process === 'undefined' || !process.env) return {};
  return process.env as Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Разбор значений
// ---------------------------------------------------------------------------

/**
 * Список Telegram id из строки/массива: `'123, 456 789'` → `[123, 456, 789]`.
 * Мусор и дубликаты отбрасываются, порядок сохраняется.
 */
export function parseIds(input: string | number | readonly (string | number)[] | null | undefined): number[] {
  if (input === null || input === undefined) return [];
  const chunks = Array.isArray(input) ? input : [input];
  const result: number[] = [];
  for (const chunk of chunks) {
    for (const token of String(chunk).split(/[^\d-]+/)) {
      if (!token) continue;
      const id = Number(token);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (!result.includes(id)) result.push(id);
    }
  }
  return result;
}

/** Цепочка моделей из строки `'a, b c'`; пустая строка → дефолтная цепочка. */
export function parseModelChain(
  input: string | readonly string[] | null | undefined,
  fallback: readonly string[] = DEFAULT_GEMINI_MODELS,
): string[] {
  if (input === null || input === undefined) return [...fallback];
  const chunks = Array.isArray(input) ? input : [input];
  const models: string[] = [];
  for (const chunk of chunks) {
    for (const token of String(chunk).split(/[\s,]+/)) {
      const model = token.trim();
      if (model && !models.includes(model)) models.push(model);
    }
  }
  return models.length > 0 ? models : [...fallback];
}

function pick(env: Record<string, string | undefined>, key: string, fromSecrets: unknown, fallback: string): string {
  const envValue = env[key];
  if (typeof envValue === 'string' && envValue.trim()) return envValue.trim();
  if (typeof fromSecrets === 'string' && fromSecrets.trim()) return fromSecrets.trim();
  return fallback;
}

/** Собирает конфиг из секретов и окружения. Чистая функция — удобно тестировать. */
export function buildConfig(
  secrets: AppSecrets = {},
  env: Record<string, string | undefined> = {},
): AppConfig {
  const models = parseModelChain(env.GEMINI_MODELS ?? (secrets.GEMINI_MODELS as string | undefined));

  return {
    geminiApiKey: pick(env, 'GEMINI_API_KEY', secrets.GEMINI_API_KEY, ''),
    openaiApiKey: pick(env, 'OPENAI_API_KEY', secrets.OPENAI_API_KEY, ''),
    deepseekApiKey: pick(env, 'DEEPSEEK_API_KEY', secrets.DEEPSEEK_API_KEY, ''),
    anthropicApiKey: pick(env, 'ANTHROPIC_API_KEY', secrets.ANTHROPIC_API_KEY, ''),
    chatProvider:
      parseProviderId(pick(env, 'LLM_PROVIDER', secrets.LLM_PROVIDER, '')) ?? DEFAULT_PROVIDER,
    masterKey: pick(env, 'MASTER_KEY', secrets.MASTER_KEY, ''),
    betaWhitelist: parseIds(env.BETA_WHITELIST ?? secrets.BETA_WHITELIST),
    adminIds: parseIds(env.ADMIN_IDS ?? secrets.ADMIN_IDS),
    defaultTimezone: pick(env, 'APP_TIMEZONE', secrets.APP_TIMEZONE, DEFAULT_TIMEZONE),
    defaultBaseCurrency: pick(env, 'APP_BASE_CURRENCY', secrets.APP_BASE_CURRENCY, DEFAULT_BASE_CURRENCY).toUpperCase(),
    defaultSummaryTime: pick(env, 'APP_SUMMARY_TIME', secrets.APP_SUMMARY_TIME, DEFAULT_SUMMARY_TIME),
    geminiModels: models,
    openaiModels: parseModelChain(
      env.OPENAI_MODELS ?? (secrets.OPENAI_MODELS as string | undefined),
      DEFAULT_OPENAI_MODELS,
    ),
    deepseekModels: parseModelChain(
      env.DEEPSEEK_MODELS ?? (secrets.DEEPSEEK_MODELS as string | undefined),
      DEFAULT_DEEPSEEK_MODELS,
    ),
    anthropicModels: parseModelChain(
      env.ANTHROPIC_MODELS ?? (secrets.ANTHROPIC_MODELS as string | undefined),
      DEFAULT_ANTHROPIC_MODELS,
    ),
    openaiBaseUrl: pick(env, 'OPENAI_BASE_URL', secrets.OPENAI_BASE_URL, ''),
    deepseekBaseUrl: pick(env, 'DEEPSEEK_BASE_URL', secrets.DEEPSEEK_BASE_URL, ''),
    anthropicBaseUrl: pick(env, 'ANTHROPIC_BASE_URL', secrets.ANTHROPIC_BASE_URL, ''),
  };
}

// ---------------------------------------------------------------------------
// Кэш и тестовые переопределения
// ---------------------------------------------------------------------------

let cachedBase: AppConfig | null = null;
let pending: Promise<AppConfig> | null = null;
let overrides: Partial<AppConfig> = {};

function applyOverrides(base: AppConfig): AppConfig {
  if (Object.keys(overrides).length === 0) return base;
  return { ...base, ...overrides };
}

async function loadBaseConfig(): Promise<AppConfig> {
  if (cachedBase) return cachedBase;
  if (!pending) {
    pending = (async () => {
      const secrets = await loadSecrets();
      return buildConfig(secrets, readEnv());
    })().then((config) => {
      cachedBase = config;
      return config;
    });
  }
  return pending;
}

/** Конфиг приложения (кэшируется после первого чтения). */
export async function getConfig(): Promise<AppConfig> {
  const base = await loadBaseConfig();
  return applyOverrides(base);
}

/** Тестовые переопределения поверх загруженного конфига (мержатся). */
export function setConfigOverrides(partial: Partial<AppConfig> | null): void {
  if (partial === null) {
    overrides = {};
    return;
  }
  overrides = { ...overrides, ...partial };
}

/** Сбросить кэш и переопределения (например, между тестами). */
export function resetConfigCache(): void {
  cachedBase = null;
  pending = null;
  overrides = {};
}

/** Первая модель цепочки. */
export function primaryModel(config: AppConfig): string {
  return config.geminiModels[0] ?? DEFAULT_GEMINI_MODELS[0]!;
}
