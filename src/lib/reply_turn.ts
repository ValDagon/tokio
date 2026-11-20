/**
 * Учёт ответов внутри одного апдейта («хода»).
 *
 * Изолят обрабатывает апдейты последовательно, поэтому ход — это одна
 * обрабатываемая единица: `handleUpdate` открывает его, он же закрывает.
 *
 * Зачем: `LLM_ERROR_TEXT` — не ответ, а извинение за его отсутствие. 13.11 в
 * 10:10 пользователь получил «Не удалось получить ответ от модели…», а сразу
 * за ним — полноценную сводку, которую в том же ходе собрал детерминированный
 * путь (`handlers/router.ts`). Два сообщения об одном запросе, одно из которых
 * врёт: ответ ведь был.
 *
 * Поэтому заглушку сбоя не отправляют сразу, а откладывают до конца хода
 * (`deferReplyNotice`). Если за ход ушёл хоть один настоящий ответ — сводка,
 * задача, заметка, напоминание — отложенная заглушка выбрасывается
 * (`endReplyTurn`). Если ход так и промолчал, её отправляет `flushReplyNotices`
 * в `handlers/router.ts`: пользователь должен знать, что модель не ответила.
 */

/** Отложенная заглушка: чат и текст, ждущие конца хода. */
export interface DeferredReplyNotice {
  chatId: number;
  text: string;
}

let turnOpen = false;
let repliesInTurn = 0;
let notices: DeferredReplyNotice[] = [];

/** Открывает ход: счётчик ответов и очередь заглушек обнуляются. */
export function beginReplyTurn(): void {
  turnOpen = true;
  repliesInTurn = 0;
  notices = [];
}

/** Открыт ли ход. Вне `handleUpdate` (юнит-тест, эндпоинт) — нет. */
export function isReplyTurnOpen(): boolean {
  return turnOpen;
}

/**
 * Учитывает ушедший ответ. Ход без открытой скобки игнорирует вызов: заглушку
 * в этом случае отправляют сразу, как раньше.
 */
export function noteReply(count = 1): void {
  if (!turnOpen) return;
  if (!Number.isFinite(count) || count <= 0) return;
  repliesInTurn += Math.trunc(count);
}

/**
 * Откладывает заглушку до конца хода.
 *
 * @returns `true` — заглушка отложена; `false` — ход не открыт, отправляйте
 * её сами немедленно (прежнее поведение).
 */
export function deferReplyNotice(chatId: number, text: string): boolean {
  if (!turnOpen) return false;
  if (!text.trim()) return false;
  notices.push({ chatId, text });
  return true;
}

/**
 * Закрывает ход и возвращает заглушки, которые всё ещё нужны: они уходят
 * только если за ход не было ни одного другого ответа.
 */
export function endReplyTurn(): DeferredReplyNotice[] {
  const pending = turnOpen && repliesInTurn === 0 ? notices : [];
  turnOpen = false;
  repliesInTurn = 0;
  notices = [];
  return pending;
}
