/**
 * Живая индикация хода агента: «печатает…» плюс эфемерная строка прогресса.
 *
 * Зачем: агентный ход идёт десятки секунд, а Telegram показывает «печатает…»
 * только пять. Без живой строки пользователь видит тишину и не понимает,
 * работает бот или умер.
 *
 * Что здесь есть:
 *  - `typing()` — `sendChatAction typing`; вызывается сразу на старте хода и
 *    перед обращением к модели, пока строка прогресса ещё не открыта, но не
 *    чаще раза в `TYPING_REFRESH_MS` — иначе старт и первая стадия `model`
 *    шлют один и тот же сигнал дважды;
 *  - `onProgress(event)` — хук движка (`AgentProgressEvent`): на медленной
 *    стадии (>= 8 с), на тяжёлом инструменте и на любом ходе пользователя с
 *    медленной историей (прошлый ход дольше 8 с или был дедлайн) показывает
 *    одну строку «⏳ Думаю…» / «⏳ Считаю расходы…», обновляет её не чаще раза в
 *    2 с и продлевает «печатает…» на каждом возврате модели, пока строка видна;
 *  - `finish()` — успех: строка исчезает (эфемерная гаснет сама, обычная
 *    удаляется);
 *  - `fail(text)` — сбой: строка заменяется честным текстом ошибки, чтобы
 *    индикатор никогда не висел.
 *
 * Платформенное ограничение: в изоляте нет `setTimeout`, поэтому окно в 8 с
 * нельзя отсчитать само по себе — оно проверяется на границах стадий, которые
 * присылает движок. Ход, у которого единственный вызов модели оказался долгим и
 * финальным, границ внутри окна не даёт, поэтому строка открывается заранее:
 * по медленной истории ходов этого пользователя и на заведомо тяжёлом
 * инструменте, а движок на возврате модели присылает стадию ещё раз, чтобы её
 * продлить. Это предел платформы, а не забытый таймер.
 *
 * Все вызовы Bot API обёрнуты: падение индикации не ломает ход.
 */

import { api } from 'sdk';

import type { AgentProgressEvent } from '../lib/agent/engine.js';
import { PROGRESS_SHOW_AFTER_MS } from '../lib/agent/engine.js';
import { kvDelete, kvGetJson, kvSetJson, patchTurnTrace, readTurnTrace } from '../lib/dal/misc.js';
import { safeEdit, safeSendMessage } from './formatting.js';
import { getMainKeyboard } from './keyboards.js';

/**
 * Через сколько миллисекунд хода показываем строку прогресса.
 *
 * Живёт в движке (`lib/agent/engine.ts`): по тому же порогу он решает, повторять
 * ли стадию `model` после возврата модели. Здесь — реэкспорт, чтобы у индикатора
 * и у движка не разъехались два числа.
 */
export { PROGRESS_SHOW_AFTER_MS };

/** Минимальный интервал между правками строки. */
export const PROGRESS_UPDATE_EVERY_MS = 2_000;

/**
 * Через сколько миллисекунд «печатает…» отправляется повторно.
 *
 * Telegram гасит индикатор через 5 с, поэтому `begin()` и первая стадия
 * `model` — один и тот же сигнал, если между ними нет пяти секунд: второй
 * `sendChatAction` в узком месте перед отправкой ответа ничего не добавляет.
 */
export const TYPING_REFRESH_MS = 5_000;

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

/**
 * Инструменты, которые заведомо идут долго: собирают картину дня, инбокс,
 * прогноз или траты за период и читают много строк. Их стадия открывает строку
 * сразу, не дожидаясь окна `PROGRESS_SHOW_AFTER_MS`: пользователь видит, что
 * бот действительно работает, а не молчит до первой правки.
 */
export const HEAVY_TOOLS: ReadonlySet<string> = new Set([
  'synthesize_life_context',
  'get_inbox_digest',
  'get_runway_forecast',
  'query_spending',
  'list_transactions',
  'triage_tasks',
  'auto_detect_tasks',
  'search_notes',
]);

/**
 * Был ли прошлый ход этого пользователя медленным.
 *
 * Читается в начале хода, до `startTurnTrace` движка, поэтому в `kv` ещё лежит
 * крошка **прошлого** хода: её `startedAt` и `updatedAt` (последняя метка —
 * `send`) дают фактическую длительность. Счётчик `deadlineTurns` — второй
 * признак: ход, упёршийся в бюджет, медленный по определению. Оба поля живут в
 * `turn_stats:v1` / `turn_trace:v1`, новых записей индикатор не заводит.
 */
async function slowTurnHistory(userId: number): Promise<boolean> {
  try {
    const { trace, stats } = await readTurnTrace(userId);
    if (Math.max(0, Number(stats?.deadlineTurns) || 0) > 0) return true;
    if (!trace) return false;
    const startedAtMs = Date.parse(trace.startedAt);
    const updatedAtMs = Date.parse(trace.updatedAt);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(updatedAtMs)) return false;
    return updatedAtMs - startedAtMs >= PROGRESS_SHOW_AFTER_MS;
  } catch {
    // диагностика — украшение: без неё ход идёт по общему окну
    return false;
  }
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
  /**
   * Хук движка: стадия прогона.
   * `true` — строка прогресса открыта: движок повторит стадию на возврате
   * модели, чтобы индикатор её продлил.
   */
  onProgress(event: AgentProgressEvent): Promise<boolean>;
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
  /** Когда «печатает…» ушло в последний раз: повтор не чаще `TYPING_REFRESH_MS`. */
  let lastTypingAt = 0;
  let closed = false;
  /**
   * Прошлый ход этого пользователя шёл дольше порога: строка открывается на
   * первой же границе стадии, а не после окна. Иначе долгий финальный вызов без
   * инструментов снова оставил бы её вспышкой на возврате модели.
   */
  let slowHistory = false;

  const typing = async (): Promise<void> => {
    // Отметка ставится и на отказе: индикатор — украшение, а повторять упавший
    // запрос на каждой стадии дороже, чем потерять одну «печатает…».
    lastTypingAt = now();
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
    // Медленная история читается до `startTurnTrace` движка: крошка в `kv` ещё
    // принадлежит прошлому ходу этого пользователя.
    slowHistory = await slowTurnHistory(userId);
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
        // Крошка хода: оба способа отправки отказали — строка не появится.
        await patchTurnTrace(userId, { indicator: 'unavailable' });
        return;
      }
    }
    // Без id строку нельзя ни обновить, ни погасить — считаем способ недоступным.
    if (messageId === null) {
      unavailable = true;
      await patchTurnTrace(userId, { indicator: 'unavailable' });
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
    // Крошка хода: строка реально показана — по ней /diagnostics отличит
    // «индикатор отказал» от «строку не успели открыть».
    await patchTurnTrace(userId, { indicator: 'shown' });
  };

  const update = async (text: string): Promise<void> => {
    if (messageId === null) return;
    try {
      await api.editMessageText({ chat_id: chatId, message_id: messageId, text });
      shownText = text;
      shownAt = now();
    } catch {
      // Правка отказала (эфемерную строку могли погасить, сервер — отдохнуть).
      // `visible` не сбрасываем: осиротевшая строка осталась бы в чате, —
      // вместо этого продлеваем индикатор «печатает…», чтобы ход не молчал до
      // конца. Сетевой вызов случается только на отказе.
      await typing();
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

  const onProgress = async (event: AgentProgressEvent): Promise<boolean> => {
    if (closed) return false;
    try {
      // «Печатает…» уходит, только пока строки нет: открытая строка «⏳ …» уже
      // и есть индикатор хода. Повторный `sendChatAction` на каждой стадии
      // модели — лишний сетевой вызов в узком месте (резерв отправки ответа —
      // `REPLY_RESERVE_MS = 4 с`), поэтому при видимой строке её вместо
      // действия продлевает правка ниже. Первая стадия модели идёт сразу за
      // `begin()`: порог `TYPING_REFRESH_MS` не даёт ей отправить второй
      // `sendChatAction` в ту же секунду.
      const modelStage = event.stage === 'model';
      if (modelStage && !visible && now() - lastTypingAt >= TYPING_REFRESH_MS) await typing();
      if (unavailable) return false;

      const text = progressText(event);
      const elapsed = now() - startedAt;
      if (!visible) {
        // Тяжёлый инструмент и медленная история ходов открывают строку раньше
        // общего окна: у хода без инструментов других границ нет, и строка
        // иначе осталась бы вспышкой на возврате модели.
        const heavyTool =
          event.stage === 'tool' && event.tool !== undefined && HEAVY_TOOLS.has(event.tool);
        if (elapsed < PROGRESS_SHOW_AFTER_MS && !heavyTool && !slowHistory) return visible;
        if (busy) return visible;
        busy = true;
        try {
          await send(text);
        } finally {
          busy = false;
        }
        return visible;
      }
      if (busy) return visible;
      if (text === shownText) {
        // Строку продлевает «печатает…» на возврате модели: правку тем же
        // текстом Telegram отклонил бы как «message is not modified». Порог
        // `TYPING_REFRESH_MS` держит продления редкими.
        if (modelStage && now() - lastTypingAt >= TYPING_REFRESH_MS) await typing();
        return visible;
      }
      // Окно в 2 с защищает от частой смены подписи инструмента; стадия модели
      // — признак живого хода, её правка строку продлевает сразу.
      if (!modelStage && now() - shownAt < PROGRESS_UPDATE_EVERY_MS) return visible;
      busy = true;
      try {
        await update(text);
      } finally {
        busy = false;
      }
      return visible;
    } catch {
      // индикация — украшение: ход не ломается
      return visible;
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
