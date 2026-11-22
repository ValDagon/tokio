/**
 * Живая индикация хода агента: «печатает…» плюс эфемерная строка прогресса.
 *
 * Зачем: агентный ход идёт десятки секунд, а Telegram показывает «печатает…»
 * только пять. Без живой строки пользователь видит тишину и не понимает,
 * работает бот или умер.
 *
 * Что здесь есть:
 *  - `typing()` — `sendChatAction typing`; вызывается сразу на старте хода и
 *    движком перед каждым обращением к модели;
 *  - `onProgress(event)` — хук движка (`AgentProgressEvent`): на медленной
 *    стадии (>= 8 с) показывает одну строку «⏳ Думаю…» / «⏳ Считаю расходы…»
 *    и обновляет её не чаще раза в 2 с;
 *  - `finish()` — успех: строка исчезает (эфемерная гаснет сама, обычная
 *    удаляется);
 *  - `fail(text)` — сбой: строка заменяется честным текстом ошибки, чтобы
 *    индикатор никогда не висел.
 *
 * Платформенное ограничение: в изоляте нет `setTimeout`, поэтому окно в 8 с
 * нельзя отсчитать само по себе — оно проверяется на границах стадий, которые
 * присылает движок. Один долгий вызов модели без инструментов покажет строку
 * только на следующей стадии; это честный предел платформы, а не забытый таймер.
 *
 * Все вызовы Bot API обёрнуты: падение индикации не ломает ход.
 */

import { api } from 'sdk';

import type { AgentProgressEvent } from '../lib/agent/engine.js';
import { kvDelete, kvGetJson, kvSetJson } from '../lib/dal/misc.js';
import { safeEdit, safeSendMessage } from './formatting.js';
import { getMainKeyboard } from './keyboards.js';

/** Через сколько миллисекунд хода показываем строку прогресса. */
export const PROGRESS_SHOW_AFTER_MS = 8_000;

/** Минимальный интервал между правками строки. */
export const PROGRESS_UPDATE_EVERY_MS = 2_000;

/** Текст стадии «модель думает». */
export const THINKING_TEXT = '⏳ Думаю…';

/**
 * Человеческие подписи инструментов: имя тулзы ничего не говорит человеку.
 * Неизвестная тулза получает нейтральную подпись, а не техническое имя.
 */
const TOOL_LABELS: Record<string, string> = {
  // Деньги
  add_expense: 'Считаю расходы',
  add_income: 'Считаю доходы',
  add_transfer: 'Перевожу между счетами',
  add_exchange: 'Считаю по курсу',
  get_fin_balances: 'Смотрю остатки',
  get_fx_rates: 'Проверяю курсы',
  set_fx_rate: 'Сохраняю курс',
  query_spending: 'Разбираю траты',
  get_runway_forecast: 'Считаю запас денег',
  can_i_afford: 'Проверяю, по карману ли',
  set_account_balance: 'Свожу баланс',
  adjust_account_balance: 'Правлю баланс',
  set_budget: 'Ставлю бюджет',
  edit_last_transaction: 'Правлю последнюю запись',
  undo_last_transaction: 'Отменяю запись',
  // Задачи и напоминания
  add_task: 'Записываю задачу',
  add_tasks_batch: 'Разбираю список дел',
  complete_task: 'Закрываю задачу',
  update_task: 'Обновляю задачу',
  list_tasks: 'Смотрю задачи',
  triage_tasks: 'Разбираю задачи',
  set_reminder: 'Ставлю напоминание',
  auto_detect_tasks: 'Ищу задачи в тексте',
  // Заметки и инбокс
  add_note: 'Сохраняю заметку',
  search_notes: 'Ищу в заметках',
  edit_note: 'Правлю заметку',
  get_inbox_digest: 'Собираю инбокс',
  // Обязательства
  mark_liability_paid: 'Отмечаю платёж',
  get_liabilities: 'Смотрю обязательства',
  // Аптечка
  add_medication: 'Записываю лекарство',
  get_medications_today: 'Смотрю аптечку',
  log_medication_taken: 'Отмечаю приём',
  // Память
  remember_rule: 'Запоминаю правило',
  synthesize_life_context: 'Собираю картину',
};

/** Строка прогресса для стадии: «⏳ Думаю…» или «⏳ Считаю расходы…». */
export function progressText(event: AgentProgressEvent): string {
  if (event.stage === 'model') return THINKING_TEXT;
  const label = event.tool ? TOOL_LABELS[event.tool] : undefined;
  return label ? `⏳ ${label}…` : '⏳ Выполняю действие…';
}

export interface TurnProgressOptions {
  chatId: number;
  /** Кому показать эфемерную строку (`receiver_user_id`). */
  userId: number;
  /** Часы; подменяются в тестах — в изоляте нет таймеров. */
  now?: () => number;
}

export interface TurnProgress {
  /**
   * Начало хода: гасит строку от прошлого, убитого платформой хода (в изоляте
   * нет фоновой уборки) и отправляет «печатает…».
   */
  begin(): Promise<void>;
  /** «Печатает…» перед каждым обращением к модели. */
  typing(): Promise<void>;
  /** Хук движка: стадия прогона. */
  onProgress(event: AgentProgressEvent): Promise<void>;
  /** Успех: строка исчезает. */
  finish(): Promise<void>;
  /**
   * Сбой: строка заменяется честным текстом ошибки.
   * `true` — текст уже показан пользователю (отдельное сообщение не нужно).
   */
  fail(text: string): Promise<boolean>;
}

function messageIdOf(result: unknown): number | null {
  if (typeof result !== 'object' || result === null) return null;
  const id = (result as { message_id?: unknown }).message_id;
  return typeof id === 'number' ? id : null;
}

/** Ключ `kv` с открытой строкой прогресса: по нему гасится строка мёртвого хода. */
const staleKey = (chatId: number): string => `turn_progress:${chatId}`;

interface StaleProgress {
  chatId: number;
  messageId: number;
}

/**
 * Гасит строку прошлого хода, который платформа убила по лимиту времени.
 *
 * Без этого обычная строка (фолбэк без эфемерных сообщений) остаётся в чате
 * навсегда: убитый изолят не выполняет ни `finish()`, ни `finally`. Уборка идёт
 * в начале следующего хода этого чата, других фоновых процессов в изоляте нет.
 */
async function sweepStaleProgress(chatId: number): Promise<void> {
  try {
    const stale = await kvGetJson<StaleProgress | null>(staleKey(chatId), null);
    if (!stale || typeof stale.messageId !== 'number') return;
    try {
      await api.deleteMessage({ chat_id: chatId, message_id: stale.messageId });
    } catch {
      // Строка уже исчезла (эфемерная погасла сама) — запись всё равно чистим.
    }
    await kvDelete(staleKey(chatId));
  } catch {
    // Уборка — украшение: сбой хранилища не должен ломать ход
  }
}

/**
 * Заводит индикатор хода. Ничего не отправляет сам: первый вызов — `begin()`.
 *
 * Разметку строки держим обычным текстом (без `parse_mode`): это служебная
 * строка, а не ответ, и лишний HTML-конвейер здесь только добавил бы отказов.
 */
export function startTurnProgress(options: TurnProgressOptions): TurnProgress {
  const { chatId, userId } = options;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  let visible = false;
  /** Оба способа отправки отказали: больше не пытаемся, ход идёт дальше. */
  let unavailable = false;
  /** Параллельные стадии батча не должны открыть две строки сразу. */
  let busy = false;
  let messageId: number | null = null;
  let shownText = '';
  let shownAt = 0;
  let closed = false;

  const typing = async (): Promise<void> => {
    try {
      await api.sendChatAction({ chat_id: chatId, action: 'typing' });
    } catch {
      // «печатает…» — украшение: сбой не должен ломать ход
    }
  };

  /** Запоминает открытую строку, чтобы следующий ход мог её погасить. */
  const remember = async (id: number | null): Promise<void> => {
    if (id === null) return;
    try {
      await kvSetJson(staleKey(chatId), { chatId, messageId: id } satisfies StaleProgress);
    } catch {
      // уборка — украшение
    }
  };

  const forget = async (): Promise<void> => {
    try {
      await kvDelete(staleKey(chatId));
    } catch {
      // уборка — украшение
    }
  };

  const begin = async (): Promise<void> => {
    await sweepStaleProgress(chatId);
    await typing();
  };

  const send = async (text: string): Promise<void> => {
    try {
      // Bot API 10.4: эфемерное сообщение видит только адресат и чат не засоряется.
      const sent = await api.sendMessage({
        chat_id: chatId,
        text,
        ephemeral_message_parameters: { receiver_user_id: userId },
      });
      messageId = messageIdOf(sent);
    } catch {
      try {
        const sent = await api.sendMessage({ chat_id: chatId, text });
        messageId = messageIdOf(sent);
      } catch {
        unavailable = true;
        return;
      }
    }
    // Без id строку нельзя ни обновить, ни погасить — считаем способ недоступным.
    if (messageId === null) {
      unavailable = true;
      return;
    }
    if (closed) {
      // Ход закончился, пока шла отправка: строка не должна остаться висеть.
      await hide();
      return;
    }
    visible = true;
    shownText = text;
    shownAt = now();
    await remember(messageId);
  };

  const update = async (text: string): Promise<void> => {
    if (messageId === null) return;
    try {
      await api.editMessageText({ chat_id: chatId, message_id: messageId, text });
      shownText = text;
      shownAt = now();
    } catch {
      // Устаревшая стадия в строке лучше, чем упавший ход
    }
  };

  const hide = async (): Promise<void> => {
    if (messageId === null) return;
    try {
      await api.deleteMessage({ chat_id: chatId, message_id: messageId });
    } catch {
      // Эфемерная строка гаснет сама; обычная могла уже исчезнуть
    }
    await forget();
  };

  const onProgress = async (event: AgentProgressEvent): Promise<void> => {
    if (closed) return;
    try {
      if (event.stage === 'model') await typing();
      if (unavailable) return;

      const text = progressText(event);
      const elapsed = now() - startedAt;
      if (!visible) {
        if (elapsed < PROGRESS_SHOW_AFTER_MS || busy) return;
        busy = true;
        try {
          await send(text);
        } finally {
          busy = false;
        }
        return;
      }
      if (text === shownText || busy) return;
      if (now() - shownAt < PROGRESS_UPDATE_EVERY_MS) return;
      busy = true;
      try {
        await update(text);
      } finally {
        busy = false;
      }
    } catch {
      // индикация — украшение: ход не ломается
    }
  };

  const finish = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (!visible) return;
    try {
      await hide();
    } catch {
      // см. `hide`
    }
  };

  const fail = async (text: string): Promise<boolean> => {
    if (closed) return false;
    if (!visible) {
      closed = true;
      return false;
    }
    closed = true;
    if (messageId !== null) {
      try {
        await safeEdit(chatId, messageId, text);
        return true;
      } catch {
        // Эфемерную строку правка могла не принять: гасим и говорим обычным текстом.
        await hide();
      }
    }
    try {
      // Клавиатура разделов возвращается явно, как в прежних ответах о сбое.
      await safeSendMessage(chatId, text, { replyMarkup: getMainKeyboard() });
      return true;
    } catch {
      return false;
    }
  };

  return { begin, typing, onProgress, finish, fail };
}
