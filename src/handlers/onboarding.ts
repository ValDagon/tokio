/**
 * Доступ и первый контакт — порт `WhitelistMiddleware` (middlewares.py) и
 * стартового блока `handle_start` (handlers.py), плюс TS-специфичный онбординг.
 *
 * Что здесь есть:
 *  - `checkAccess` — тот же порядок, что у middleware upstream: пустой список
 *    доступа в production = fail-closed, пустой список в остальных режимах =
 *    доступ открыт (локальная разработка); непустой список пускает только своих;
 *  - `ensureUserProfile` — «первый ли это контакт»: строка `users` создаётся
 *    здесь и только здесь, вместе с дефолтами DDL;
 *  - `startWelcomeText` / `onboardingIntroText` — приветствие и знакомство;
 *  - базовая валюта: клавиатура `onboard:currency:<CODE>` и её разбор;
 *  - `applyMenuButton` — кнопка Mini App слева от поля ввода.
 *
 * Отличия от upstream (осознанные, ADR-002):
 *  - список доступа — объединение `betaWhitelist` и `adminIds` из конфига:
 *    администратор входит всегда, даже если его не вписали в бету;
 *  - адрес Mini App берётся из env `WEBAPP_URL` / `MINIAPP_URL` или оверлея;
 *    без валидного `https://` URL кнопка меню не ставится;
 *  - upstream не умеет ни приглашения подключить свой ключ, ни выбора базовой
 *    валюты при первом входе, поэтому тексты ниже написаны заново: нейтрально и
 *    без обещаний, которых код не выполняет;
 *  - ни одного имени пользователя, банка или города: только нейтральные подписи.
 *
 * Язык. Все пользовательские тексты живут в `locales/{ru,en,sr,ja}.json`
 * (`onboarding.*`) и берутся через `t()`; в этом файле нет ни одной русской
 * строки для пользователя. Локаль берётся из `users.language` (фолбэк —
 * `manifest.defaultLocale` оверлея), поэтому мастер и приветствие отвечают на
 * языке интерфейса, а не на языке разработчика.
 *
 * Фокус мастера — agent-first: обычный текст, голос и фото вместо заучивания
 * slash-команд. Свой ключ модели остаётся необязательной опцией на шаге 7 и
 * упоминается без жаргона и без синтаксиса команды.
 *
 * [public-only] Всё, что ниже блока «Мастер онбординга», есть только в публичной
 * редакции: мастер настройки, его состояние в `users.onboarding_step`, демо-счета и
 * примеры задач/заметок. Личная редакция использует только общую часть файла и не
 * вызывает `sendWizardStep` / `skipOnboarding`. Правило синхронизации — HANDOFF §7.1.
 */

import { api } from 'sdk';

import { createAccount, createLiability, listAccounts, listLiabilities } from '../lib/dal/finances';
import { createNote } from '../lib/dal/notes';
import { createTask } from '../lib/dal/tasks';
import { ensureUser, getUser, updateUser } from '../lib/dal/users';
import { normalizeLocale, t, type LocaleCode } from '../lib/i18n';
import { getAssistantName, getDemoSeed, getOverlay } from '../lib/overlay';
import type { LiabilityQueue, OnboardingStep, UserRow } from '../lib/types';
import { nowIso } from '../lib/utils';

import { safeAnswer, safeEdit } from './formatting';
import { getMainKeyboard, webAppUrl } from './keyboards';
import type { InlineKeyboardMarkup } from './keyboards';

// ---------------------------------------------------------------------------
// Режим запуска
// ---------------------------------------------------------------------------

export {
  checkAccess,
  isProduction,
  ACCESS_DENIED_MESSAGE,
  ACCESS_DENIED_ALERT,
  ACCESS_UNCONFIGURED_MESSAGE,
  ACCESS_UNCONFIGURED_ALERT,
  type AccessEventKind,
  type AccessAllowed,
  type AccessDenied,
  type AccessResult,
} from '../lib/auth.js';

// ---------------------------------------------------------------------------
// Профиль пользователя
// ---------------------------------------------------------------------------

export interface ProfileState {
  user: UserRow;
  /** `true` — строки `users` ещё не было: это первый контакт. */
  isNew: boolean;
}

/** Локаль пользователя: `users.language`, иначе дефолт оверлея. */
export function resolveUserLocale(user?: UserRow | null): LocaleCode {
  return normalizeLocale(user?.language, getOverlay().manifest.defaultLocale);
}

/** Локаль пользователя по id — для обработчиков, у которых нет строки `users`. */
export async function loadUserLocale(userId: number): Promise<LocaleCode> {
  return resolveUserLocale(await getUser(userId));
}

/**
 * Читает профиль; если его нет — создаёт с дефолтами DDL.
 *
 * Имя пишется только при первом создании: повторный вход не перезаписывает то,
 * что пользователь уже сохранил (паритет `INSERT … ON CONFLICT DO NOTHING`).
 */
export async function ensureUserProfile(
  userId: number,
  name?: string | null,
  languageCode?: string | null,
): Promise<ProfileState> {
  const existing = await getUser(userId);
  if (existing) return { user: existing, isNew: false };

  const overlay = getOverlay();
  const created = await ensureUser(userId, name ?? undefined);
  const onboardingStep: OnboardingStep = overlay.manifest.features.onboardingWizard
    ? 'new'
    : 'completed';
  const language = normalizeLocale(languageCode, overlay.manifest.defaultLocale);
  const updated = (await updateUser(userId, { onboardingStep, language })) ?? created;
  return { user: updated, isNew: true };
}

// ---------------------------------------------------------------------------
// Базовая валюта
// ---------------------------------------------------------------------------

/**
 * Нейтральный список ISO-кодов для первого выбора. Не привязан к стране,
 * банку или конкретному пользователю: остальные коды можно выбрать в дашборде.
 */
export const BASE_CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'RUB',
  'RSD',
  'UAH',
  'KZT',
  'TRY',
  'GEL',
] as const;

export type BaseCurrency = (typeof BASE_CURRENCIES)[number];

/** Префикс callback-данных выбора валюты. */
export const BASE_CURRENCY_CALLBACK_PREFIX = 'onboard:currency:';

/** Кнопки выбора базовой валюты — по три в ряд. */
export function baseCurrencyKeyboard(): InlineKeyboardMarkup {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < BASE_CURRENCIES.length; index += 3) {
    rows.push(
      BASE_CURRENCIES.slice(index, index + 3).map((code) => ({
        text: code,
        callback_data: `${BASE_CURRENCY_CALLBACK_PREFIX}${code}`,
      })),
    );
  }
  return { inline_keyboard: rows };
}

/**
 * Разбирает `callback_data` выбора валюты.
 *
 * Возвращает `null` для чужих данных и для кода вне списка: значение из кнопки
 * не должно попадать в БД без проверки.
 */
export function parseBaseCurrencyChoice(data: string | null | undefined): BaseCurrency | null {
  if (typeof data !== 'string') return null;
  if (!data.startsWith(BASE_CURRENCY_CALLBACK_PREFIX)) return null;
  const code = data.slice(BASE_CURRENCY_CALLBACK_PREFIX.length).trim().toUpperCase();
  return (BASE_CURRENCIES as readonly string[]).includes(code) ? (code as BaseCurrency) : null;
}

/** Обновляет базовую валюту; `null` — пользователя ещё нет (тогда создаём). */
export async function setBaseCurrency(userId: number, code: string): Promise<UserRow | null> {
  const normalized = code.trim().toUpperCase();
  if (!(BASE_CURRENCIES as readonly string[]).includes(normalized)) return null;

  const updated = await updateUser(userId, { baseCurrency: normalized });
  if (updated) return updated;
  await ensureUser(userId);
  return updateUser(userId, { baseCurrency: normalized });
}

// ---------------------------------------------------------------------------
// Тексты онбординга
// ---------------------------------------------------------------------------

/**
 * Приглашение подключить свой ключ модели.
 *
 * Формулировки намеренно скромные: ключ опционален, хранится зашифрованным, без
 * него всё работает на общем ключе продукта с общим лимитом. Ни жаргона, ни
 * синтаксиса команды: `{{key}}`-подстановок здесь нет, только понятное «можно
 * позже через /help».
 */
export function byokInvitationText(locale: LocaleCode = 'ru'): string {
  return t(locale, 'onboarding.introOptionalKey');
}

/** Приветствие `/start`: сначала обычная речь, голос и фото, команды — вторичны. */
export function startWelcomeText(locale: LocaleCode = 'ru'): string {
  return t(locale, 'onboarding.startGreeting', { assistantName: getAssistantName(locale) });
}

/** Короткое знакомство: что за бот и как с ним работать. */
export function onboardingIntroText(locale: LocaleCode = 'ru'): string {
  return t(locale, 'onboarding.introText', { assistantName: getAssistantName(locale) });
}

/** Просьба выбрать базовую валюту. */
export function baseCurrencyPromptText(locale: LocaleCode = 'ru'): string {
  return t(locale, 'onboarding.currencyPrompt');
}

export interface OnboardingSendOptions {
  /** Приложить клавиатуру выбора базовой валюты (первый контакт). */
  withCurrencyPrompt?: boolean;
  /** Язык пользователя; по умолчанию — дефолт оверлея. */
  locale?: LocaleCode;
}

/** Отправляет знакомство; при `withCurrencyPrompt` — вместе с выбором валюты. */
export async function sendOnboardingIntro(
  chatId: number,
  options: OnboardingSendOptions = {},
): Promise<void> {
  const locale = options.locale ?? normalizeLocale(null, getOverlay().manifest.defaultLocale);
  const withCurrency = options.withCurrencyPrompt === true;
  const text = withCurrency
    ? `${onboardingIntroText(locale)}\n\n${baseCurrencyPromptText(locale)}`
    : onboardingIntroText(locale);
  await safeAnswer(chatId, text, {
    replyMarkup: withCurrency ? baseCurrencyKeyboard() : null,
  });
}

// ---------------------------------------------------------------------------
// Кнопка меню (Mini App)
// ---------------------------------------------------------------------------

/** Подпись кнопки меню слева от поля ввода (для дефолтной локали оверлея). */
export const MENU_BUTTON_TEXT = getAssistantName();

/**
 * Ставит кнопку меню с Mini App; без `WEBAPP_URL` — молча ничего не делает.
 *
 * Кнопка — украшение, а не функция: её сбой не должен ломать `/start`, поэтому
 * ошибка платформы гасится здесь же.
 */
export async function applyMenuButton(chatId: number, locale?: LocaleCode): Promise<void> {
  const url = webAppUrl();
  if (!url) return;

  try {
    await api.setChatMenuButton({
      chat_id: chatId,
      menu_button: { type: 'web_app', text: getAssistantName(locale), web_app: { url } },
    });
  } catch {
    // Кнопка не поставилась — работаем дальше с обычной клавиатурой.
  }
}

/** Приветствие `/start` целиком: кнопка меню, приветствие, знакомство. */
export async function sendStartGreeting(
  chatId: number,
  options: { withIntro?: boolean; locale?: LocaleCode } = {},
): Promise<void> {
  const locale = options.locale ?? normalizeLocale(null, getOverlay().manifest.defaultLocale);
  await applyMenuButton(chatId, locale);
  // Единственная команда (вместе с `/menu`), которая показывает сетку разделов.
  await safeAnswer(chatId, startWelcomeText(locale), {
    replyMarkup: getMainKeyboard(locale),
    keepReplyKeyboard: true,
  });

  if (options.withIntro === true) {
    await sendOnboardingIntro(chatId, { withCurrencyPrompt: true, locale });
  }
}

// ---------------------------------------------------------------------------
// [public-only] Мастер онбординга — только публичная редакция (HANDOFF §7.1).
// Ниже начинается блок, которого нет в личном боте; всё выше — общий код.
// ---------------------------------------------------------------------------

export type { OnboardingStep } from '../lib/types';

// ---------------------------------------------------------------------------
// Экран приветствия для НОВЫХ пользователей: Вопрос «Обучение или пропуск?»
// ---------------------------------------------------------------------------

export function onboardingPromptText(locale: LocaleCode = 'ru'): string {
  const assistantName = getAssistantName(locale);
  return `👋 **${t(locale, 'onboarding.welcomeTitle')} — ${assistantName}**\n\n${t(locale, 'onboarding.welcomePrompt')}`;
}

export function onboardingPromptKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: t(locale, 'onboarding.btnStart'), callback_data: 'onboard:step:overview' }],
      [{ text: t(locale, 'onboarding.btnSkip'), callback_data: 'onboard:skip' }],
    ],
  };
}

export async function sendOnboardingPrompt(chatId: number, locale: LocaleCode = 'ru'): Promise<void> {
  await safeAnswer(chatId, onboardingPromptText(locale), {
    replyMarkup: onboardingPromptKeyboard(locale),
  });
}

/** Кнопки навигации мастера: «Далее», «Пропустить шаг», «Закрыть». */
function stepNavRow(locale: LocaleCode, next: string): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [{ text: t(locale, 'onboarding.btnNext'), callback_data: next }],
    [
      { text: t(locale, 'onboarding.btnSkipStep'), callback_data: next },
      { text: t(locale, 'onboarding.btnExit'), callback_data: 'onboard:exit' },
    ],
  ];
}

// ---------------------------------------------------------------------------
// Шаг 1: Обзор возможностей
// ---------------------------------------------------------------------------

export function stepOverviewText(locale: LocaleCode = 'ru'): string {
  const assistantName = getAssistantName(locale);
  return (
    `✨ **${t(locale, 'onboarding.stepOverview', { assistantName })}**\n\n` +
    t(locale, 'onboarding.stepOverviewBody')
  );
}

export function stepOverviewKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  return { inline_keyboard: stepNavRow(locale, 'onboard:step:timezone') };
}

// ---------------------------------------------------------------------------
// Шаг 2: Язык и часовой пояс
// ---------------------------------------------------------------------------

export function stepTimezoneText(currentTimezone?: string, locale: LocaleCode = 'ru'): string {
  const current = currentTimezone
    ? `\n\n${t(locale, 'onboarding.currentTimezone', { timezone: currentTimezone })}`
    : '';
  return (
    `🌍 **${t(locale, 'onboarding.stepTimezone')}**\n\n` +
    t(locale, 'onboarding.stepTimezoneBody') +
    current +
    `\n\n${t(locale, 'onboarding.stepTimezoneQuestion')}`
  );
}

export function stepTimezoneKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'UTC+1 (Berlin)', callback_data: 'onboard:tz:Europe/Berlin' },
        { text: 'UTC+2 (Kyiv)', callback_data: 'onboard:tz:Europe/Kyiv' },
      ],
      [
        { text: 'UTC+3 (Moscow)', callback_data: 'onboard:tz:Europe/Moscow' },
        { text: 'UTC+4 (Dubai)', callback_data: 'onboard:tz:Asia/Dubai' },
      ],
      [
        { text: 'UTC+5 (Tashkent)', callback_data: 'onboard:tz:Asia/Tashkent' },
        { text: 'UTC+6 (Almaty)', callback_data: 'onboard:tz:Asia/Almaty' },
      ],
      ...stepNavRow(locale, 'onboard:step:currency'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 3: Базовая валюта
// ---------------------------------------------------------------------------

export function stepCurrencyText(currentCurrency?: string, locale: LocaleCode = 'ru'): string {
  const assistantName = getAssistantName(locale);
  const current = currentCurrency
    ? `\n\n${t(locale, 'onboarding.currentCurrency', { currency: currentCurrency })}`
    : '';
  return (
    `💱 **${t(locale, 'onboarding.stepCurrency')}**\n\n` +
    t(locale, 'onboarding.stepCurrencyBody', { assistantName }) +
    current +
    `\n\n${t(locale, 'onboarding.stepCurrencyQuestion')}`
  );
}

export function stepCurrencyKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < BASE_CURRENCIES.length; index += 3) {
    rows.push(
      BASE_CURRENCIES.slice(index, index + 3).map((code) => ({
        text: code,
        callback_data: `${BASE_CURRENCY_CALLBACK_PREFIX}${code}`,
      })),
    );
  }
  rows.push(...stepNavRow(locale, 'onboard:step:accounts'));
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Шаг 4: Стартовые счета
// ---------------------------------------------------------------------------

export function stepAccountsText(accountsCreated?: string[], locale: LocaleCode = 'ru'): string {
  const feedback =
    accountsCreated && accountsCreated.length > 0
      ? `\n\n${t(locale, 'onboarding.accountsCreated', { accounts: accountsCreated.join(', ') })}`
      : '';
  return (
    `💳 **${t(locale, 'onboarding.stepAccounts')}**\n\n` +
    t(locale, 'onboarding.stepAccountsBody') +
    feedback
  );
}

export function stepAccountsKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: t(locale, 'onboarding.btnPresetCashCard'), callback_data: 'onboard:preset:cash_card' }],
      [{ text: t(locale, 'onboarding.btnPresetFull'), callback_data: 'onboard:preset:full' }],
      ...stepNavRow(locale, 'onboard:step:practice'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 5: Живая практика
// ---------------------------------------------------------------------------

export function stepPracticeText(actionResult?: string, locale: LocaleCode = 'ru'): string {
  const feedback = actionResult
    ? `\n\n${t(locale, 'onboarding.actionResult', { result: actionResult })}`
    : '';
  return (
    `✍️ **${t(locale, 'onboarding.stepPractice')}**\n\n` +
    t(locale, 'onboarding.stepPracticeBody') +
    feedback
  );
}

export function stepPracticeKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: t(locale, 'onboarding.btnSampleTask'), callback_data: 'onboard:action:sample_task' }],
      [{ text: t(locale, 'onboarding.btnSampleNote'), callback_data: 'onboard:action:sample_note' }],
      [{ text: t(locale, 'onboarding.btnDemoSeed'), callback_data: 'onboard:action:seed_demo' }],
      ...stepNavRow(locale, 'onboard:step:notifications'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 6: Уведомления и утренний дайджест
// ---------------------------------------------------------------------------

export function stepNotificationsText(
  currentTime?: string,
  locale: LocaleCode = 'ru',
  actionResult?: string,
): string {
  const assistantName = getAssistantName(locale);
  const current = currentTime
    ? `\n\n${t(locale, 'onboarding.currentDigestTime', { time: currentTime })}`
    : '';
  const feedback = actionResult
    ? `\n\n${t(locale, 'onboarding.actionResult', { result: actionResult })}`
    : '';
  return (
    `⏰ **${t(locale, 'onboarding.stepNotifications')}**\n\n` +
    t(locale, 'onboarding.stepNotificationsBody', { assistantName }) +
    current +
    `\n\n${t(locale, 'onboarding.stepNotificationsQuestion')}` +
    feedback
  );
}

export function stepNotificationsKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '🌅 07:00', callback_data: 'onboard:time:07:00' },
        { text: '☀️ 08:00', callback_data: 'onboard:time:08:00' },
      ],
      [
        { text: '☕ 09:00', callback_data: 'onboard:time:09:00' },
        { text: '🕒 10:00', callback_data: 'onboard:time:10:00' },
      ],
      ...stepNavRow(locale, 'onboard:step:gemini'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 7: как отвечает ассистент (и необязательный свой ключ)
// ---------------------------------------------------------------------------

export function stepGeminiText(locale: LocaleCode = 'ru'): string {
  const features = getOverlay().manifest.features;
  const lines = [t(locale, 'onboarding.stepGeminiBody')];
  if (features.spendLimitEnabled) {
    lines.push(t(locale, 'onboarding.modelSharedLimit', { limitUsd: features.spendLimitUsd }));
  }
  if (features.byokCommand) {
    lines.push(t(locale, 'onboarding.modelOwnKey'));
  }
  return `🤖 **${t(locale, 'onboarding.stepGemini')}**\n\n${lines.join('\n')}`;
}

export function stepGeminiKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: t(locale, 'onboarding.btnFinish'), callback_data: 'onboard:step:final' }],
      ...stepNavRow(locale, 'onboard:step:final'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 8: Финал
// ---------------------------------------------------------------------------

export function stepFinalText(locale: LocaleCode = 'ru'): string {
  const assistantName = getAssistantName(locale);
  return (
    `🚀 **${t(locale, 'onboarding.stepFinal', { assistantName })}**\n\n` +
    t(locale, 'onboarding.stepFinalBody', { assistantName })
  );
}

export function stepFinalKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  const url = webAppUrl();
  const rows: any[] = [];
  if (url) {
    rows.push([{ text: t(locale, 'onboarding.btnOpenApp'), web_app: { url } }]);
  }
  rows.push([
    { text: t(locale, 'onboarding.btnShowSummary'), callback_data: 'onboard:finish_status' },
    { text: t(locale, 'onboarding.btnHelp'), callback_data: 'onboard:finish_help' },
  ]);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Рендер шага мастера
// ---------------------------------------------------------------------------

export function getWizardStepContent(
  step: OnboardingStep,
  user: UserRow,
  actionResult?: string,
): { text: string; keyboard: InlineKeyboardMarkup } {
  const locale = resolveUserLocale(user);
  switch (step) {
    case 'overview':
      return { text: stepOverviewText(locale), keyboard: stepOverviewKeyboard(locale) };
    case 'timezone':
      return {
        text: stepTimezoneText(user.timezone, locale),
        keyboard: stepTimezoneKeyboard(locale),
      };
    case 'currency':
      return {
        text: stepCurrencyText(user.baseCurrency, locale),
        keyboard: stepCurrencyKeyboard(locale),
      };
    case 'accounts':
      return { text: stepAccountsText(undefined, locale), keyboard: stepAccountsKeyboard(locale) };
    case 'practice':
      return {
        text: stepPracticeText(actionResult, locale),
        keyboard: stepPracticeKeyboard(locale),
      };
    case 'notifications':
      return {
        text: stepNotificationsText(user.summaryTime, locale, actionResult),
        keyboard: stepNotificationsKeyboard(locale),
      };
    case 'gemini':
      return { text: stepGeminiText(locale), keyboard: stepGeminiKeyboard(locale) };
    case 'final':
    case 'completed':
      return { text: stepFinalText(locale), keyboard: stepFinalKeyboard(locale) };
    default:
      return { text: stepOverviewText(locale), keyboard: stepOverviewKeyboard(locale) };
  }
}

export async function sendWizardStep(
  chatId: number,
  step: OnboardingStep,
  userId: number,
  messageIdToEdit?: number,
  actionResult?: string,
): Promise<void> {
  const user = (await getUser(userId)) ?? (await ensureUser(userId));
  const { text, keyboard } = getWizardStepContent(step, user, actionResult);

  if (typeof messageIdToEdit === 'number') {
    try {
      await safeEdit(chatId, messageIdToEdit, text, { replyMarkup: keyboard });
      return;
    } catch {
      // Игнорируем ошибку редактирования и отправляем новым сообщением
    }
  }

  await safeAnswer(chatId, text, { replyMarkup: keyboard });
}

// ---------------------------------------------------------------------------
// Создание стартовых счетов и примеров задач/заметок
// ---------------------------------------------------------------------------

export async function createPresetAccounts(
  userId: number,
  preset: 'cash_card' | 'full',
): Promise<string[]> {
  const user = (await getUser(userId)) ?? (await ensureUser(userId));
  const locale = resolveUserLocale(user);
  const baseCurrency = user.baseCurrency || 'EUR';
  const card = t(locale, 'onboarding.accountCard');
  const cash = t(locale, 'onboarding.accountCash');

  if (preset === 'cash_card') {
    await createAccount(userId, { name: card, currency: baseCurrency, envelope: 'spendable' });
    await createAccount(userId, { name: cash, currency: baseCurrency, envelope: 'spendable' });
    return [card, cash];
  }

  const savings = t(locale, 'onboarding.accountSavings');
  const crypto = t(locale, 'onboarding.accountCrypto');
  await createAccount(userId, { name: card, currency: baseCurrency, envelope: 'spendable' });
  await createAccount(userId, { name: savings, currency: baseCurrency, envelope: 'reserved' });
  await createAccount(userId, { name: crypto, currency: 'USD', envelope: 'spendable' });
  return [card, savings, crypto];
}

export async function createSampleTask(userId: number, locale?: LocaleCode): Promise<string> {
  const loc = locale ?? (await loadUserLocale(userId));
  const assistantName = getAssistantName(loc);
  const title = t(loc, 'onboarding.sampleTaskTitle', { assistantName });
  await createTask(userId, {
    title,
    notes: t(loc, 'onboarding.sampleTaskNotes'),
    status: 'todo',
  });
  return t(loc, 'onboarding.sampleTaskResult', { title });
}

export async function createSampleNote(userId: number, locale?: LocaleCode): Promise<string> {
  const loc = locale ?? (await loadUserLocale(userId));
  const assistantName = getAssistantName(loc);
  const text = t(loc, 'onboarding.sampleNoteText', { assistantName });
  const title = t(loc, 'onboarding.sampleNoteTitle');
  await createNote(userId, text, {
    column: 'raw',
    sourceType: 'text',
    metadata: { title, tags: [t(loc, 'onboarding.sampleNoteTag')] },
  });
  return t(loc, 'onboarding.sampleNoteResult', { title });
}

/**
 * Заполняет рабочее пространство пользователя демо-данными из оверлея:
 * счета (без дублирования существующих), обязательства, задачи с напоминанием
 * и поисковые заметки.
 */
export async function seedDemoWorkspace(
  userId: number,
  locale?: LocaleCode,
): Promise<string> {
  const loc = normalizeLocale(locale, getOverlay().manifest.defaultLocale);
  const seed = getDemoSeed(loc);
  const now = new Date();

  const existingAccounts = await listAccounts(userId);
  const accountKeys = new Set(
    existingAccounts.map((a) => `${a.name.trim().toLowerCase()}::${a.currency.toUpperCase()}`),
  );
  for (const acc of seed.accounts) {
    const key = `${acc.name.trim().toLowerCase()}::${acc.currency.toUpperCase()}`;
    if (accountKeys.has(key)) continue;
    await createAccount(userId, {
      name: acc.name,
      currency: acc.currency,
      initialBalanceCents: acc.balanceCents,
      envelope: acc.envelope,
    });
    accountKeys.add(key);
  }

  const existingLiabilities = await listLiabilities(userId, 'active');
  const liabilityNames = new Set(existingLiabilities.map((l) => l.name.trim().toLowerCase()));
  for (const liab of seed.liabilities) {
    if (liabilityNames.has(liab.name.trim().toLowerCase())) continue;
    await createLiability(userId, {
      name: liab.name,
      queue: liab.queue as LiabilityQueue,
      amountCents: liab.amountCents,
      currency: liab.currency,
      monthlyPaymentCents: liab.monthlyPaymentCents,
      paymentDay: liab.paymentDay,
      notes: liab.notes,
    });
    liabilityNames.add(liab.name.trim().toLowerCase());
  }

  for (const task of seed.tasks) {
    const dueAt = new Date(now.getTime() + task.dueOffsetDays * 86_400_000).toISOString();
    const remindAt =
      task.reminderInHours !== null
        ? new Date(now.getTime() + task.reminderInHours * 3_600_000).toISOString()
        : null;
    await createTask(userId, {
      title: task.title,
      notes: task.notes,
      status: 'todo',
      dueAt,
      remindAt,
    });
  }

  for (const note of seed.notes) {
    await createNote(userId, note.rawText, {
      column: note.column,
      sourceType: 'text',
      metadata: { title: note.title, tags: note.tags },
    });
  }

  return t(loc, 'onboarding.demoSeedApplied');
}

// ---------------------------------------------------------------------------
// Пропуск, выход и перезапуск мастера
// ---------------------------------------------------------------------------

export async function skipOnboarding(userId: number): Promise<UserRow | null> {
  return updateUser(userId, {
    onboardingStep: 'skipped',
    onboardingCompletedAt: nowIso(),
  });
}

export async function exitOnboarding(userId: number): Promise<UserRow | null> {
  return updateUser(userId, {
    onboardingStep: 'completed',
    onboardingCompletedAt: nowIso(),
  });
}

export async function restartOnboarding(userId: number): Promise<UserRow | null> {
  return updateUser(userId, {
    onboardingStep: 'overview',
  });
}
