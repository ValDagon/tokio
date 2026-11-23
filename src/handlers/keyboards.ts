/**
 * Клавиатуры бота — порт `backend/app/bot/keyboards.py`.
 *
 * Что здесь есть:
 *  - `getMainKeyboard` — эргономичная reply-клавиатура 4×2 (быстрые разделы);
 *  - `getOpenAppInlineKeyboard` — inline-кнопка запуска Mini App (`web_app`);
 *  - `getActionKeyboard` — «Отменить / Изменить» для только что записанного;
 *  - `getDashboardInlineKeyboard` — inline-дашборд: быстрые задачи, навигация,
 *    `🔄 Обновить`, `🚀 Открыть`, опционально `📥 Бэкап`;
 *  - `getInboxItemKeyboard` — «В задачу / В инбокс / Отменить» для новой заметки.
 *
 * Отличия от upstream (осознанные, ADR-002):
 *  - `WEBAPP_URL` / `MINIAPP_URL` из env переопределяет `brand.miniAppUrl` из оверлея;
 *    если env задан, но не начинается с `https://` (или `process.env` недоступен),
 *    а в оверлее нет валидного `https://` URL — `webAppUrl()` возвращает `null`,
 *    и `web_app`-кнопки не появляются;
 *  - ни одного имени банка/города/пользователя: только нейтральные подписи.
 */

import { getOverlay } from '../lib/overlay.js';
import { t, type LocaleCode } from '../lib/i18n.js';

// ---------------------------------------------------------------------------
// Типы разметки (подмножество Bot API, нужное боту)
// ---------------------------------------------------------------------------

/** Inline-кнопка: `callback_data`, `url` ИЛИ `web_app`. */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

/** Reply-кнопка (текст отправляется в чат как обычное сообщение). */
export interface KeyboardButton {
  text: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface ReplyKeyboardMarkup {
  keyboard: KeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
  selective?: boolean;
}

/**
 * Сворачивание reply-клавиатуры.
 *
 * Важно: отсутствие `reply_markup` клавиатуру НЕ убирает — клиент продолжает
 * показывать последнюю. Убирает её только `remove_keyboard: true`.
 */
export interface ReplyKeyboardRemove {
  remove_keyboard: true;
  selective?: boolean;
}

/** Любая разметка, которую можно положить в `reply_markup`. */
export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove;

// ---------------------------------------------------------------------------
// Подписи быстрых разделов
// ---------------------------------------------------------------------------

export const KEYBOARD_STATUS = '📊 Сводка';
export const KEYBOARD_BALANCE = '💰 Баланс';
export const KEYBOARD_DEBTS = '💳 Долги';
export const KEYBOARD_TASKS = '🎯 Задачи';
export const KEYBOARD_MEDS = '💊 Аптечка';
export const KEYBOARD_DIGEST = '☀️ Дайджест';
export const KEYBOARD_INBOX = '📥 Инбокс';
export const KEYBOARD_NEW = '🧹 Новая сессия';
export const KEYBOARD_HELP = 'ℹ️ Помощь';
export const KEYBOARD_SKILLS = '🧩 Скиллы';
export const KEYBOARD_DIAGNOSTICS = '🩺 Диагностика';
export const KEYBOARD_TRIAGE = '🧠 Разобрать';
export const KEYBOARD_COMMANDS = '⌨️ Команды ›';
export const KEYBOARD_BACKLOG = '📋 Бэклог';
export const KEYBOARD_BACKUP = '📥 Бэкап';
export const KEYBOARD_BYOK = '🔑 Ключ';
export const KEYBOARD_LANG = '🌐 Язык';
export const KEYBOARD_BACK = '← Назад';

/** Подпись кнопки запуска дашборда. */
export const OPEN_APP_LABEL = '🚀 Открыть';

// ---------------------------------------------------------------------------
// Адрес Mini App
// ---------------------------------------------------------------------------

/**
 * Возвращает URL Mini App: `WEBAPP_URL` / `MINIAPP_URL` из окружения
 * переопределяет адрес из оверлея (`brand.miniAppUrl`).
 *
 * Если переменная окружения задана, но не является `https://`-адресом
 * (или `process.env` недоступен), возвращает `null`.
 */
export function webAppUrl(): string | null {
  if (typeof process === 'undefined' || !process.env) return null;
  const raw = process.env.WEBAPP_URL ?? process.env.MINIAPP_URL;
  if (raw !== undefined) {
    const url = raw.trim();
    if (!url.startsWith('https://')) return null;
    return url;
  }
  const overlayUrl = getOverlay().manifest.brand.miniAppUrl?.trim();
  if (overlayUrl && overlayUrl.startsWith('https://')) {
    return overlayUrl;
  }
  return null;
}

/**
 * URL Mini App с опциональным query-параметром `startapp` для deep-link навигации.
 * Возвращает `null`, если `webAppUrl()` не сконфигурирован.
 */
export function webAppDeepLinkUrl(startParam?: string): string | null {
  const base = webAppUrl();
  if (!base) return null;
  const trimmed = startParam?.trim();
  if (!trimmed) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}startapp=${encodeURIComponent(trimmed)}`;
}

/** Inline-кнопка открытия Mini App (с опциональным `startapp`); `null`, если URL не сконфигурирован. */
export function buildOpenAppButton(
  startParam?: string,
  label?: string,
  locale: LocaleCode = 'ru',
): InlineKeyboardButton | null {
  const url = webAppDeepLinkUrl(startParam);
  if (!url) return null;
  return { text: label ?? t(locale, 'keyboards.inApp'), web_app: { url } };
}

/** Однорядная inline-клавиатура «Отменить» + опциональная кнопка «📱 В приложении». */
export function buildUndoWithAppKeyboard(
  undoCallbackData: string,
  startParam?: string,
  undoLabel: string = '🗑️ Отменить',
): InlineKeyboardMarkup {
  const row: InlineKeyboardButton[] = [{ text: undoLabel, callback_data: undoCallbackData }];
  const appBtn = buildOpenAppButton(startParam);
  if (appBtn) row.push(appBtn);
  return { inline_keyboard: [row] };
}

export interface AgentStepLike {
  ok: boolean;
  action: { name: string; args?: Record<string, unknown> } | null;
  data?: unknown;
}

const FINANCE_DEEP_LINK_TOOLS = new Set([
  'add_expense',
  'add_income',
  'add_transfer',
  'add_exchange',
  'set_budget',
  'set_account_balance',
  'adjust_account_balance',
  'update_account',
  'delete_account',
  'edit_last_transaction',
  'delete_transaction',
  'can_i_afford',
]);

function isPositiveInt(val: unknown): val is number {
  return typeof val === 'number' && Number.isInteger(val) && val > 0;
}

type StepClassification =
  | { kind: 'draft'; skillId: number }
  | { kind: 'deepLink'; startParam: string };

function classifyAgentStep(step: AgentStepLike | undefined): StepClassification | null {
  if (!step || !step.ok || !step.action) return null;
  const name = step.action.name;
  const data =
    step.data && typeof step.data === 'object'
      ? (step.data as Record<string, unknown>)
      : undefined;

  if (name === 'draft_skill') {
    return isPositiveInt(data?.skill_id) ? { kind: 'draft', skillId: data.skill_id } : null;
  }
  if (name === 'add_task' || name === 'update_task' || name === 'complete_task') {
    return isPositiveInt(data?.task_id) ? { kind: 'deepLink', startParam: `task_${data.task_id}` } : null;
  }
  if (name === 'add_note' || name === 'edit_note' || name === 'move_note') {
    return isPositiveInt(data?.note_id) ? { kind: 'deepLink', startParam: `note_${data.note_id}` } : null;
  }
  if (
    name === 'mark_liability_paid' ||
    name === 'link_liability_account' ||
    name === 'add_liability' ||
    name === 'update_liability' ||
    name === 'delete_liability'
  ) {
    return { kind: 'deepLink', startParam: 'debts' };
  }
  if (FINANCE_DEEP_LINK_TOOLS.has(name)) {
    return { kind: 'deepLink', startParam: 'finances' };
  }
  return null;
}

function findLastClassifiedStep(steps: ReadonlyArray<AgentStepLike>): StepClassification | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const classified = classifyAgentStep(steps[i]);
    if (classified) return classified;
  }
  return null;
}

/**
 * Определяет `startapp`-параметр deep-link для последнего успешного мутирующего шага агента
 * (или `can_i_afford`). Read-only запросы возвращают `null`.
 */
export function resolveAgentStartAppParam(
  steps: ReadonlyArray<AgentStepLike>,
): string | null {
  const last = findLastClassifiedStep(steps);
  if (!last) return null;
  return last.kind === 'draft' ? 'skills' : last.startParam;
}

/**
 * Строит inline-клавиатуру для ответа агента:
 *  - если последний мутирующий шаг — `draft_skill`, возвращает кнопки
 *    подтверждения `[✅ Включить #id | 🚫 Отклонить]` (+ `[📱 В приложении]`);
 *  - иначе однорядную кнопку deep-link на целевой раздел/запись Mini App.
 */
export function buildAgentDeepLinkKeyboard(
  steps: ReadonlyArray<AgentStepLike>,
  locale: LocaleCode = 'ru',
): InlineKeyboardMarkup | undefined {
  const last = findLastClassifiedStep(steps);
  if (!last) return undefined;
  if (last.kind === 'draft') {
    const rows: InlineKeyboardButton[][] = [
      [
        {
          text: t(locale, 'skills.btnActivate', { id: last.skillId }),
          callback_data: `skills:activate:${last.skillId}`,
        },
        { text: t(locale, 'skills.btnReject'), callback_data: `skills:reject:${last.skillId}` },
      ],
    ];
    const appBtn = buildOpenAppButton('skills', undefined, locale);
    if (appBtn) rows.push([appBtn]);
    return { inline_keyboard: rows };
  }

  const btn = buildOpenAppButton(last.startParam, undefined, locale);
  if (!btn) return undefined;
  return { inline_keyboard: [[btn]] };
}

// ---------------------------------------------------------------------------
// Построители
// ---------------------------------------------------------------------------

/**
 * Слой 1: компактный «Главный экран» (2×3).
 *
 * `one_time_keyboard: true` (без `is_persistent`): после нажатия клавиатура
 * сворачивается до иконки `⊞` в поле ввода и в любой момент раскрывается в 1 клик.
 */
export function getMainKeyboard(locale: LocaleCode = 'ru'): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [
        { text: t(locale, 'keyboards.newSession') },
        { text: t(locale, 'keyboards.skills') },
        { text: t(locale, 'keyboards.status') },
      ],
      [
        { text: t(locale, 'keyboards.diagnostics') },
        { text: t(locale, 'keyboards.triage') },
        { text: t(locale, 'keyboards.commands') },
      ],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: t(locale, 'keyboards.mainPlaceholder'),
  };
}

/**
 * Слой 2: «Клавиатура команд» (4×3) — все разделы и системные утилиты + `← Назад`.
 */
export function getCommandsKeyboard(locale: LocaleCode = 'ru'): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [
        { text: t(locale, 'keyboards.balance') },
        { text: t(locale, 'keyboards.debts') },
        { text: t(locale, 'keyboards.tasks') },
      ],
      [
        { text: t(locale, 'keyboards.inbox') },
        { text: t(locale, 'keyboards.digest') },
        { text: t(locale, 'keyboards.meds') },
      ],
      [
        { text: t(locale, 'keyboards.backlog') },
        { text: t(locale, 'keyboards.backup') },
        { text: t(locale, 'keyboards.byok') },
      ],
      [
        { text: t(locale, 'keyboards.lang') },
        { text: t(locale, 'keyboards.help') },
        { text: t(locale, 'keyboards.back') },
      ],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: t(locale, 'keyboards.commandsPlaceholder'),
  };
}

/** Inline-кнопка запуска Mini App; `null`, если `WEBAPP_URL` не сконфигурирован. */
export function getOpenAppInlineKeyboard(
  startParam?: string,
  locale: LocaleCode = 'ru',
): InlineKeyboardMarkup | null {
  const url = webAppDeepLinkUrl(startParam);
  if (!url) return null;
  return {
    inline_keyboard: [[{ text: t(locale, 'keyboards.openApp'), web_app: { url } }]],
  };
}

/** «↩️ Отменить / ✏️ Изменить» для только что записанной сущности. */
export function getActionKeyboard(actionType: string, itemId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '↩️ Отменить', callback_data: `undo:${actionType}:${itemId}` },
        { text: '✏️ Изменить', callback_data: `edit:${actionType}:${itemId}` },
      ],
    ],
  };
}

/** Что нужно от задачи, чтобы построить кнопку быстрого выполнения. */
export interface FocusTaskLike {
  id: number | string;
  title: string;
}

export interface DashboardKeyboardOptions {
  /** Активный раздел дашборда (`status` по умолчанию). */
  activeTab?: string;
  /** До трёх задач «на сегодня» — каждая отдельной кнопкой. */
  focusTasks?: readonly FocusTaskLike[] | null;
  /** Добавить в нижний ряд `📥 Бэкап`. */
  includeBackup?: boolean;
  /** Добавить строку `🧠 Разобрать всё прямо сейчас`. */
  includeTriage?: boolean;
}

/** Максимальная длина заголовка задачи на кнопке (до многоточия). */
const FOCUS_TITLE_LIMIT = 28;

/** Маппинг вкладки inline-дашборда бота в `startapp`-параметр Mini App. */
const DASHBOARD_TAB_START_PARAM: Record<string, string | undefined> = {
  status: undefined,
  balance: 'finances',
  debts: 'debts',
  tasks: 'tasks',
  inbox: 'inbox',
  digest: 'system',
};

/**
 * Inline-дашборд:
 *  1. до трёх кнопок `✅ N. <задача>` (`dash_done:<tab>:<id>`);
 *  2. опционально `🧠 Разобрать всё прямо сейчас` (`triage:inbox`);
 *  3. навигация: Сводка / Баланс / Долги;
 *  4. навигация: Задачи / Инбокс / Дайджест (активный раздел — `• … •`);
 *  5. утилиты: `🔄 Обновить`, `🚀 Открыть` (если есть `WEBAPP_URL`),
 *     опционально `📥 Бэкап`.
 */
export function getDashboardInlineKeyboard(
  options: DashboardKeyboardOptions = {},
): InlineKeyboardMarkup {
  const activeTab = options.activeTab ?? 'status';
  const rows: InlineKeyboardButton[][] = [];

  const focusTasks = options.focusTasks ?? [];
  for (let index = 0; index < Math.min(focusTasks.length, 3); index += 1) {
    const task = focusTasks[index] as FocusTaskLike;
    const title = task.title ?? '';
    // Паритет с upstream: заголовок режется до 28 символов БЕЗ trimEnd,
    // поэтому пробел перед «…» может остаться — так и было в оригинале.
    const shortTitle = title.length > FOCUS_TITLE_LIMIT ? `${title.slice(0, FOCUS_TITLE_LIMIT)}…` : title;
    rows.push([
      {
        text: `✅ ${index + 1}. ${shortTitle}`,
        callback_data: `dash_done:${activeTab}:${String(task.id ?? '')}`,
      },
    ]);
  }

  if (options.includeTriage === true) {
    rows.push([{ text: '🧠 Разобрать всё прямо сейчас', callback_data: 'triage:inbox' }]);
  }

  const navRow = (items: ReadonlyArray<readonly [string, string]>): InlineKeyboardButton[] =>
    items.map(([key, label]) => ({
      text: key === activeTab ? `• ${label} •` : label,
      callback_data: `nav:${key}`,
    }));

  rows.push(
    navRow([
      ['status', KEYBOARD_STATUS],
      ['balance', KEYBOARD_BALANCE],
      ['debts', KEYBOARD_DEBTS],
    ]),
  );
  rows.push(
    navRow([
      ['tasks', KEYBOARD_TASKS],
      ['inbox', KEYBOARD_INBOX],
      ['digest', KEYBOARD_DIGEST],
    ]),
  );

  const utilityRow: InlineKeyboardButton[] = [
    { text: '🔄 Обновить', callback_data: `nav:${activeTab}` },
  ];
  const url = webAppDeepLinkUrl(DASHBOARD_TAB_START_PARAM[activeTab]);
  if (url) utilityRow.push({ text: OPEN_APP_LABEL, web_app: { url } });
  if (options.includeBackup === true) {
    utilityRow.push({ text: '📥 Бэкап', callback_data: 'backup:download' });
  }
  rows.push(utilityRow);

  return { inline_keyboard: rows };
}

/** Клавиатура новой заметки инбокса: в задачу / оставить в инбоксе / отменить. */
export function getInboxItemKeyboard(noteId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '🎯 В задачу', callback_data: `inbox_to_task:${noteId}` },
        { text: '📥 В инбокс', callback_data: `inbox_to_inbox:${noteId}` },
      ],
      [{ text: '🗑 Отменить', callback_data: `inbox_undo:${noteId}` }],
    ],
  };
}

/** Одна inline-кнопка скачивания бэкапа (под дайджестом и в дашборде). */
export function getBackupInlineKeyboard(locale: LocaleCode = 'ru'): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: t(locale, 'keyboards.backupDownload'), callback_data: 'backup:download' }]],
  };
}

/**
 * Inline-кнопки экрана скиллов: только для ожидающих решения черновиков (`pending`, до 5 шт.)
 * + опциональная кнопка перехода в Mini App (`startapp=skills`).
 */
export function buildSkillsInlineKeyboard(
  pendingSkillIds: readonly number[],
  locale: LocaleCode = 'ru',
): InlineKeyboardMarkup | undefined {
  const rows: InlineKeyboardButton[][] = [];
  for (const id of pendingSkillIds.slice(0, 5)) {
    rows.push([
      { text: t(locale, 'skills.btnShow', { id }), callback_data: `skills:show:${id}` },
      { text: t(locale, 'skills.btnActivate', { id }), callback_data: `skills:activate:${id}` },
      { text: t(locale, 'skills.btnReject'), callback_data: `skills:reject:${id}` },
    ]);
  }
  const appBtn = buildOpenAppButton('skills', undefined, locale);
  if (appBtn) rows.push([appBtn]);
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

/** Одна inline-кнопка запуска разбора инбокса (под списком входящих). */
export function getTriageInlineKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: '🧠 Разобрать всё прямо сейчас', callback_data: 'triage:inbox' }]],
  };
}
