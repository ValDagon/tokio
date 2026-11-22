/**
 * Авторизация REST-эндпоинтов Mini App (T16).
 *
 * Платформа tgcloud передаёт проверенный `initData` вторым аргументом
 * (`ctx`); эндпоинты берут из него Telegram user id. Для локального CLI/тестов
 * разрешён fallback на `input.userId` / `input.user_id`, но только если это
 * положительное целое — легаси-дефолт `999999999` из `rpc.ts` сюда сознательно
 * НЕ переносится (SPEC §2: «NO legacy 999999999 fallback»).
 *
 * HMAC-проверка `initData` здесь не реализована: в `config.ts` (см.
 * `AppConfig`) нет и не может быть bot token — платформа хранит
 * Telegram-секрет у себя и сама верифицирует `initData` перед вызовом
 * эндпоинта. Городить неработающую проверку без ключа значило бы падать на
 * каждом запросе; вместо этого доверяем `ctx.initData.user.id` и структурно
 * валидируем его тип (объявленному типу не верим — он приходит из рантайма).
 */

import { EndpointError } from 'sdk';
import { getConfig } from './config.js';
import { getUser } from './dal/users.js';
import { t, type LocaleCode } from './i18n.js';
import { getOverlay, isPublicOpenAccessEnabled } from './overlay.js';

/** Контекст вызова эндпоинта: то, что платформа кладёт вторым аргументом. */
export type EndpointCtx = {
  initData?: { user?: { id?: number; first_name?: string; username?: string } };
};

/** Структурная форма `initData` — id может прийти числом или строкой. */
export interface InitDataLike {
  user?: { id?: number | string; first_name?: string; username?: string };
}

/** Приводит «что угодно» к положительному целому id; иначе `null`. */
function toUserId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Telegram user id без исключения: `null`, если id нет/он невалиден.
 * Сначала проверенный `ctx.initData`, затем fallback для локального запуска.
 */
export function readUserId(
  input: Record<string, unknown>,
  ctx?: { initData?: InitDataLike },
): number | null {
  const fromInitData = toUserId(ctx?.initData?.user?.id);
  if (fromInitData !== null) return fromInitData;

  if (!input || typeof input !== 'object') return null;
  return toUserId(input.userId) ?? toUserId(input.user_id);
}

/** User id или `EndpointError('Unauthorized')` — первый вызов любого эндпоинта. */
export function requireUserId(
  input: Record<string, unknown>,
  ctx?: { initData?: InitDataLike },
): number {
  const userId = readUserId(input, ctx);
  if (userId === null) {
    throw new EndpointError('Unauthorized', { code: 'UNAUTHORIZED' });
  }
  return userId;
}

// ---------------------------------------------------------------------------
// Проверка доступа (Whitelist / Admin / Multi-tenant Gate)
// ---------------------------------------------------------------------------

export type AccessEventKind = 'message' | 'callback';

export interface AccessAllowed {
  allowed: true;
}

export interface AccessDenied {
  allowed: false;
  reply?: string;
  alert?: boolean;
}

export type AccessResult = AccessAllowed | AccessDenied;

export const ACCESS_UNCONFIGURED_MESSAGE = 'Доступ временно заблокирован: список доступа не настроен.';
export const ACCESS_UNCONFIGURED_ALERT = 'Доступ не настроен.';
export const ACCESS_DENIED_MESSAGE = '⛔ Доступ закрыт (приватный инстанс).';
export const ACCESS_DENIED_ALERT = 'Доступ ограничен.';

export function getAccessDeniedMessage(locale: LocaleCode = 'ru'): string {
  return getOverlay().manifest.brand.accessDeniedMessage[locale] ?? t(locale, 'access.denied');
}

export function isProduction(): boolean {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const raw = `${env.APP_ENV ?? env.NODE_ENV ?? ''}`.trim().toLowerCase();
  return raw === 'production' || raw === 'prod';
}

/**
 * Проверяет права доступа пользователя.
 *
 * Семантика:
 *  0. `features.publicOpenAccess === true` в оверлее → доступ открыт всем
 *     (явный режим публичного инстанса; по умолчанию флага нет и он читается
 *     как `false`, поэтому личный бот остаётся закрытым);
 *  1. список = `betaWhitelist ∪ adminIds` из конфига;
 *  2. список пуст + production → отказ «список не настроен» (fail-closed);
 *  3. список пуст + не production → доступ открыт (локальная разработка);
 *  4. список непуст (Personal Bot mode):
 *     - если userId в списке (adminIds или betaWhitelist) → доступ открыт;
 *     - если пользователь уже существует в таблице users SQLite (одобрен/приглашён) → доступ открыт;
 *     - иначе → приватный отказ ('⛔ Доступ закрыт (приватный инстанс).').
 */
export async function checkAccess(
  userId: number,
  options: { kind: AccessEventKind } = { kind: 'message' },
): Promise<AccessResult> {
  // Явный открытый режим: только оверлей, только строгое `true`.
  // Отсутствующий флаг — это `false`, поэтому fail-closed личного бота не слабеет.
  if (isPublicOpenAccessEnabled()) {
    return { allowed: true };
  }

  const config = await getConfig();
  const allowedIds = new Set<number>([...config.betaWhitelist, ...config.adminIds]);
  const isCallback = options.kind === 'callback';

  if (allowedIds.size === 0) {
    if (isProduction()) {
      return isCallback
        ? { allowed: false, reply: ACCESS_UNCONFIGURED_ALERT, alert: true }
        : { allowed: false, reply: ACCESS_UNCONFIGURED_MESSAGE };
    }
    return { allowed: true };
  }

  if (allowedIds.has(userId)) {
    return { allowed: true };
  }

  // Pre-approved or already registered users in SQLite users table
  const existing = await getUser(userId);
  if (existing) {
    return { allowed: true };
  }

  return isCallback
    ? { allowed: false, reply: ACCESS_DENIED_ALERT, alert: true }
    : { allowed: false, reply: getAccessDeniedMessage() };
}
