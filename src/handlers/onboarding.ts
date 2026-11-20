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
 *  - upstream не умеет ни BYOK-приглашения, ни выбора базовой валюты при первом
 *    входе, поэтому тексты ниже написаны заново: нейтрально и без обещаний,
 *    которых код не выполняет;
 *  - ни одного имени пользователя, банка или города: только нейтральные подписи.
 *
 * [public-only] Всё, что ниже блока «Мастер онбординга», есть только в публичной
 * редакции: мастер настройки, его состояние в `users.onboarding_step`, демо-счета и
 * примеры задач/заметок. Личная редакция использует только общую часть файла и не
 * вызывает `sendWizardStep` / `skipOnboarding`. Правило синхронизации — HANDOFF §7.1.
 */

import { api } from 'sdk';

import { getConfig } from '../lib/config';
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
 * него всё работает на общем ключе продукта с общим лимитом.
 */
export function byokInvitationText(): string {
  return (
    '🔑 **Свой ключ модели.** Можно подключить личный API-ключ: тогда запросы ' +
    'идут через твой лимит, а не через общий ключ продукта. Ключ хранится на ' +
    'сервере только в зашифрованном виде и никогда не показывается в чате. ' +
    'Своего ключа нет — всё работает на общем ключе, просто с общим лимитом.'
  );
}

/** Приветствие `/start` (структура upstream, нейтральные название и тексты). */
export function startWelcomeText(locale: LocaleCode = 'ru'): string {
  const assistantName = getAssistantName(locale);
  return (
    `Привет! Я **«${assistantName}»** — твой личный внешний когнитивный каркас.\n\n` +
    'Я работаю в режиме быстрого просмотра данных и тихого умного накопителя мыслей.\n\n' +
    '**Быстрые сводки через команды или клавиатуру внизу:**\n' +
    '• /status — 📊 Общая сводка (балансы, обязательства, фокус задач)\n' +
    '• /balance — 💰 Балансы по всем счетам и расходы за месяц\n' +
    '• /debts — 💳 Кредиты, долги и график выплат\n' +
    '• /tasks — 🎯 Список открытых задач\n' +
    '• /meds — 💊 Препараты и витамины на сегодня\n' +
    '• /inbox — 📥 Накопившиеся мысли и заметки для разбора\n' +
    '• /digest — ☀️ Утренняя сводка дня с напутствием\n' +
    '• /backup — 📦 Скачать полный бэкап данных\n' +
    '• /help — ℹ️ Справка по всем возможностям\n\n' +
    '**Как со мной общаться:**\n' +
    '• 🎙 **Голос и текст** — наговаривай или пиши любые мысли, траты и идеи. ' +
    'Я тихо сохраню их в инбокс.\n' +
    '• 🧠 **Глубокий разбор** — прямо в диалоге с ассистентом.\n' +
    `• 🚀 **Кнопка «${assistantName}»** (слева у поля ввода) открывает визуальный дашборд.\n` +
    '• 💬 Для прямого вопроса агенту в Telegram используй: `/ask <вопрос>`.'
  );
}

/** Короткое знакомство: что за бот и как с ним работать. */
export function onboardingIntroText(locale: LocaleCode = 'ru'): string {
  const assistantName = getAssistantName(locale);
  return (
    `👋 Мы ещё не знакомы: я ${assistantName} — личный ассистент по деньгам, задачам и ресурсу.\n\n` +
    'Пиши или наговаривай мысли, траты и идеи — я тихо складываю их в инбокс ' +
    'и помогаю навести в них порядок. Быстрые разделы — на клавиатуре ' +
    'внизу, полный список команд — /help.\n\n' +
    byokInvitationText()
  );
}

/** Просьба выбрать базовую валюту. */
export function baseCurrencyPromptText(): string {
  return (
    '💱 **Выбери базовую валюту** — в ней я буду считать итоги, балансы и расходы. ' +
    'Потом её можно поменять: достаточно нажать другую кнопку здесь же или ' +
    'изменить настройку в дашборде.'
  );
}

export interface OnboardingSendOptions {
  /** Приложить клавиатуру выбора базовой валюты (первый контакт). */
  withCurrencyPrompt?: boolean;
}

/** Отправляет знакомство; при `withCurrencyPrompt` — вместе с выбором валюты. */
export async function sendOnboardingIntro(
  chatId: number,
  options: OnboardingSendOptions = {},
): Promise<void> {
  const withCurrency = options.withCurrencyPrompt === true;
  const text = withCurrency
    ? `${onboardingIntroText()}\n\n${baseCurrencyPromptText()}`
    : onboardingIntroText();
  await safeAnswer(chatId, text, {
    replyMarkup: withCurrency ? baseCurrencyKeyboard() : null,
  });
}

// ---------------------------------------------------------------------------
// Кнопка меню (Mini App)
// ---------------------------------------------------------------------------

/** Подпись кнопки меню слева от поля ввода. */
export const MENU_BUTTON_TEXT = getAssistantName();

/**
 * Ставит кнопку меню сMini App; без `WEBAPP_URL` — молча ничего не делает.
 *
 * Кнопка — украшение, а не функция: её сбой не должен ломать `/start`, поэтому
 * ошибка платформы гасится здесь же.
 */
export async function applyMenuButton(chatId: number): Promise<void> {
  const url = webAppUrl();
  if (!url) return;

  try {
    await api.setChatMenuButton({
      chat_id: chatId,
      menu_button: { type: 'web_app', text: MENU_BUTTON_TEXT, web_app: { url } },
    });
  } catch {
    // Кнопка не поставилась — работаем дальше с обычной клавиатурой.
  }
}

/** Приветствие `/start` целиком: кнопка меню, приветствие, знакомство. */
export async function sendStartGreeting(
  chatId: number,
  options: { withIntro?: boolean } = {},
): Promise<void> {
  await applyMenuButton(chatId);
  // Единственная команда (вместе с `/menu`), которая показывает сетку разделов.
  await safeAnswer(chatId, startWelcomeText(), {
    replyMarkup: getMainKeyboard(),
    keepReplyKeyboard: true,
  });

  if (options.withIntro === true) {
    await sendOnboardingIntro(chatId, { withCurrencyPrompt: true });
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
  return (
    `👋 **Добро пожаловать в ${assistantName}!**\n\n` +
    'Я твой личный внешний когнитивный каркас: помогу навести порядок в задачах, финансах и мыслях без стресса и когнитивного перегруза.\n\n' +
    t(locale, 'onboarding.welcomePrompt')
  );
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

// ---------------------------------------------------------------------------
// Шаг 1: Обзор возможностей
// ---------------------------------------------------------------------------

export function stepOverviewText(locale: LocaleCode = 'ru'): string {
  const assistantName = getAssistantName(locale);
  return (
    `✨ **${t(locale, 'onboarding.stepOverview', { assistantName })}**\n\n` +
    'Я тихо беру рутину на себя:\n' +
    '• 📥 **Инбокс мыслей:** пиши или наговаривай голосом — вычищу слова-паразиты и сохраню суть.\n' +
    '• 🎯 **СДВГ-фокус задач:** 1 главная цель + 3 компактных дела в день (Треугольник 1+3).\n' +
    '• 💰 **Финансы:** мультивалютные счета, учет расходов и графики кредитов.\n' +
    '• 🧾 **Фото и чеки:** фотографируй чек — я распознаю сумму и добавлю в расходы.\n' +
    '• 📱 **Mini App:** удобный визуальный дашборд прямо в Telegram.'
  );
}

export function stepOverviewKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '➡️ Далее', callback_data: 'onboard:step:timezone' }],
      [
        { text: '⏩ Пропустить шаг', callback_data: 'onboard:step:timezone' },
        { text: '❌ Выйти', callback_data: 'onboard:exit' },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 2: Язык и часовой пояс
// ---------------------------------------------------------------------------

export function stepTimezoneText(currentTimezone?: string): string {
  const current = currentTimezone ? `\n\nТекущий пояс: **${currentTimezone}**` : '';
  return (
    '🌍 **Шаг 2 из 7: Часовой пояс**\n\n' +
    'Таймзона нужна, чтобы вовремя присылать утренний дайджест и не беспокоить напоминаниями ночью.' +
    current +
    '\n\nВыбери свой часовой пояс:'
  );
}

export function stepTimezoneKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'UTC+1 (Берлин)', callback_data: 'onboard:tz:Europe/Berlin' },
        { text: 'UTC+2 (Киев)', callback_data: 'onboard:tz:Europe/Kyiv' },
      ],
      [
        { text: 'UTC+3 (Москва)', callback_data: 'onboard:tz:Europe/Moscow' },
        { text: 'UTC+4 (Дубай)', callback_data: 'onboard:tz:Asia/Dubai' },
      ],
      [
        { text: 'UTC+5 (Ташкент)', callback_data: 'onboard:tz:Asia/Tashkent' },
        { text: 'UTC+6 (Алматы)', callback_data: 'onboard:tz:Asia/Almaty' },
      ],
      [{ text: '➡️ Далее', callback_data: 'onboard:step:currency' }],
      [
        { text: '⏩ Пропустить шаг', callback_data: 'onboard:step:currency' },
        { text: '❌ Выйти', callback_data: 'onboard:exit' },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 3: Базовая валюта
// ---------------------------------------------------------------------------

export function stepCurrencyText(currentCurrency?: string, locale: LocaleCode = 'ru'): string {
  const assistantName = getAssistantName(locale);
  const current = currentCurrency ? `\n\nТекущая валюта: **${currentCurrency}**` : '';
  return (
    `💱 **${t(locale, 'onboarding.stepCurrency')}**\n\n` +
    `В этой валюте ${assistantName} считает общие балансы, расходы за месяц и финансовый резерв (Runway).` +
    current +
    '\n\nВыбери основную валюту:'
  );
}

export function stepCurrencyKeyboard(): InlineKeyboardMarkup {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < BASE_CURRENCIES.length; index += 3) {
    rows.push(
      BASE_CURRENCIES.slice(index, index + 3).map((code) => ({
        text: code,
        callback_data: `${BASE_CURRENCY_CALLBACK_PREFIX}${code}`,
      })),
    );
  }
  rows.push([{ text: '➡️ Далее', callback_data: 'onboard:step:accounts' }]);
  rows.push([
    { text: '⏩ Пропустить шаг', callback_data: 'onboard:step:accounts' },
    { text: '❌ Выйти', callback_data: 'onboard:exit' },
  ]);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Шаг 4: Стартовые счета
// ---------------------------------------------------------------------------

export function stepAccountsText(accountsCreated?: string[]): string {
  const feedback =
    accountsCreated && accountsCreated.length > 0
      ? `\n\n✅ **Созданы счета:** ${accountsCreated.join(', ')}.`
      : '';
  return (
    '💳 **Шаг 4 из 7: Стартовые счета**\n\n' +
    'Чтобы вести учёт денег, создай базовые счета в один клик. Позже в Mini App можно настроить любые другие:' +
    feedback
  );
}

export function stepAccountsKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '💳 Наличные + Карта', callback_data: 'onboard:preset:cash_card' }],
      [{ text: '🏦 Карта + Банк + Крипта', callback_data: 'onboard:preset:full' }],
      [{ text: '➡️ Далее', callback_data: 'onboard:step:practice' }],
      [
        { text: '⏩ Пропустить шаг', callback_data: 'onboard:step:practice' },
        { text: '❌ Выйти', callback_data: 'onboard:exit' },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 5: Живая практика
// ---------------------------------------------------------------------------

export function stepPracticeText(actionResult?: string): string {
  const feedback = actionResult ? `\n\n✅ ${actionResult}` : '';
  return (
    '✍️ **Шаг 5 из 7: Живая практика**\n\n' +
    'Попробуй отправить мне любое сообщение прямо сейчас:\n' +
    '• Мысль или идею: `идея для проекта` (или голосовое)\n' +
    '• Трату: `обед 15` или `кофе 3.5`\n' +
    '• Задачу: `купить молоко завтра`\n\n' +
    'Либо создай тестовую задачу или заметку кнопкой ниже:' +
    feedback
  );
}

export function stepPracticeKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🎯 Создать тестовую задачу', callback_data: 'onboard:action:sample_task' }],
      [{ text: '📝 Создать тестовую заметку', callback_data: 'onboard:action:sample_note' }],
      [{ text: t(locale, 'onboarding.btnDemoSeed'), callback_data: 'onboard:action:seed_demo' }],
      [{ text: '➡️ Далее', callback_data: 'onboard:step:notifications' }],
      [
        { text: '⏩ Пропустить шаг', callback_data: 'onboard:step:notifications' },
        { text: '❌ Выйти', callback_data: 'onboard:exit' },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 6: Уведомления и утренний дайджест
// ---------------------------------------------------------------------------

export function stepNotificationsText(currentTime?: string, locale: LocaleCode = 'ru'): string {
  const assistantName = getAssistantName(locale);
  const current = currentTime ? `\n\nТекущее время дайджеста: **${currentTime}**` : '';
  return (
    `⏰ **${t(locale, 'onboarding.stepNotifications')}**\n\n` +
    `Каждое утро ${assistantName} может присылать короткую утреннюю сводку: задачи дня, балансы счетов и напоминания.` +
    current +
    '\n\nВ какое время присылать утренний дайджест?'
  );
}

export function stepNotificationsKeyboard(): InlineKeyboardMarkup {
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
      [{ text: '➡️ Далее', callback_data: 'onboard:step:gemini' }],
      [
        { text: '⏩ Пропустить шаг', callback_data: 'onboard:step:gemini' },
        { text: '❌ Выйти', callback_data: 'onboard:exit' },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Шаг 7: Gemini-ключ и лимиты
// ---------------------------------------------------------------------------

export function stepGeminiText(): string {
  return (
    '🔑 **Шаг 7 из 7: ИИ-модель и Gemini-ключ**\n\n' +
    '• По умолчанию бот работает на **общем ключе владельца** с приветственным лимитом **$2.00** на пользователя.\n' +
    '• Этого хватает на тысячи сообщений, голосовых транскрипций и чеков.\n' +
    '• При желании ты можешь подключить личный бесплатный ключ Google Gemini API (BYOK): он снимет любые лимиты.\n\n' +
    'Команда для подключения своего ключа: `/byok <ваш_ключ>` (или в Mini App).'
  );
}

export function stepGeminiKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🎉 Завершить настройку', callback_data: 'onboard:step:final' }],
      [
        { text: '⏩ Пропустить шаг', callback_data: 'onboard:step:final' },
        { text: '❌ Выйти', callback_data: 'onboard:exit' },
      ],
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
    `${assistantName} готов к работе. Что делать дальше:\n` +
    '• 🎙 Наговаривай голосовые или пиши мысли — я сохраню их в инбокс.\n' +
    '• 📊 Используй команды и клавиатуру внизу (/status, /tasks, /balance).\n' +
    '• 📱 Открой Mini App по кнопке ниже для визуального дашборда.\n\n' +
    'Если понадобится помощь или захочешь пройти обучение заново — напиши /help.'
  );
}

export function stepFinalKeyboard(): InlineKeyboardMarkup {
  const url = webAppUrl();
  const rows: any[] = [];
  if (url) {
    rows.push([{ text: '📱 Открыть Mini App', web_app: { url } }]);
  }
  rows.push([
    { text: '📊 Показать сводку', callback_data: 'onboard:finish_status' },
    { text: 'ℹ️ Помощь', callback_data: 'onboard:finish_help' },
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
  switch (step) {
    case 'overview':
      return { text: stepOverviewText(), keyboard: stepOverviewKeyboard() };
    case 'timezone':
      return { text: stepTimezoneText(user.timezone), keyboard: stepTimezoneKeyboard() };
    case 'currency':
      return { text: stepCurrencyText(user.baseCurrency), keyboard: stepCurrencyKeyboard() };
    case 'accounts':
      return { text: stepAccountsText(), keyboard: stepAccountsKeyboard() };
    case 'practice':
      return { text: stepPracticeText(actionResult), keyboard: stepPracticeKeyboard() };
    case 'notifications':
      return { text: stepNotificationsText(user.summaryTime), keyboard: stepNotificationsKeyboard() };
    case 'gemini':
      return { text: stepGeminiText(), keyboard: stepGeminiKeyboard() };
    case 'final':
    case 'completed':
      return { text: stepFinalText(), keyboard: stepFinalKeyboard() };
    default:
      return { text: stepOverviewText(), keyboard: stepOverviewKeyboard() };
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
  const baseCurrency = user.baseCurrency || 'EUR';

  if (preset === 'cash_card') {
    await createAccount(userId, { name: 'Карта', currency: baseCurrency, envelope: 'spendable' });
    await createAccount(userId, { name: 'Наличные', currency: baseCurrency, envelope: 'spendable' });
    return ['Карта', 'Наличные'];
  }

  await createAccount(userId, { name: 'Карта', currency: baseCurrency, envelope: 'spendable' });
  await createAccount(userId, { name: 'Накопительный', currency: baseCurrency, envelope: 'reserved' });
  await createAccount(userId, { name: 'Крипта', currency: 'USD', envelope: 'spendable' });
  return ['Карта', 'Накопительный', 'Крипта'];
}

export async function createSampleTask(userId: number, locale: LocaleCode = 'ru'): Promise<string> {
  const assistantName = getAssistantName(locale);
  await createTask(userId, {
    title: `Попробовать ${assistantName} в действии 🚀`,
    notes: 'Первая задача, созданная в мастере онбординга',
    status: 'todo',
  });
  return `Создана тестовая задача: «Попробовать ${assistantName} в действии 🚀».`;
}

export async function createSampleNote(userId: number, locale: LocaleCode = 'ru'): Promise<string> {
  const assistantName = getAssistantName(locale);
  await createNote(userId, `💡 Моя первая мысль в ${assistantName}: всё гениальное просто!`, {
    column: 'raw',
    sourceType: 'text',
    metadata: { title: 'Первая мысль', tags: ['онбординг'] },
  });
  return `Сохранена тестовая заметка в инбокс: «Моя первая мысль в ${assistantName}».`;
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
