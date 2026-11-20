/**
 * Форматирование сообщений для Telegram — порт `backend/app/bot/formatting.py`.
 *
 * Что здесь есть:
 *  - `safeSendMessage` / `safeAnswer` / `safeEdit` — отправка с HTML-разметкой,
 *    фолбэком на plain text при 400 и немедленным ретраем при flood control.
 *
 * Чистые помощники (`markdownToTelegramHtml` — 18-шаговый конвейер,
 * `splitMessageChunks`, таблицы) переехали в `lib/markdown.ts` и ре-экспортируются
 * отсюда: в `handlers/` платформа разрешает только имена типов апдейтов, поэтому
 * модуль из `lib/` не смог бы импортировать их в рантайме (см. `build.mjs`).
 *
 * Отличия от upstream (осознанные, ADR-003):
 *  - `html.escape(quote=False)` из Python экранирует только `& < >`; общий
 *    `lib/utils.escapeHtml` экранирует ещё и кавычки — поэтому здесь свой вариант;
 *  - в изоляте нет `setTimeout`: при `RetryAfter` (429) повторяем сразу, без сна.
 */

import { api as sdkApi, BotApiError } from 'sdk';

import { markdownToTelegramHtml, splitMessageChunks } from '../lib/markdown.js';
import { noteReply } from '../lib/reply_turn.js';
import type { ReplyMarkup } from './keyboards';

// Ре-экспорт перенесённых чистых помощников: `router.ts`, `ingest.ts` и тесты
// продолжают импортировать их из этого модуля.
export {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TARGET_CHUNK_LENGTH,
  PROTECTED_SPLIT_TAGS_PATTERN,
  escapeAmpLtGt,
  formatQuotePreview,
  isNumericOrCurrency,
  isNumericColumn,
  truncateCell,
  renderProportionalTable,
  renderAsciiTable,
  isTableDelimiterRow,
  splitTableRow,
  cleanTableCell,
  findProtectedSpans,
  markdownToTelegramHtml,
  splitMessageChunks,
} from '../lib/markdown.js';


// ---------------------------------------------------------------------------
// Безопасная отправка
// ---------------------------------------------------------------------------

/** Отправка одного сообщения: платформенный `api.sendMessage` или тестовая заглушка. */
export type SendFn = (params: Record<string, unknown>) => Promise<unknown>;

export interface SafeSendOptions {
  /** Клавиатура; прикрепляется только к последнему чанку. */
  replyMarkup?: ReplyMarkup | null;
  /** Текст уже в Telegram HTML (не конвертировать Markdown). */
  isHtml?: boolean;
  /** Сколько попыток на чанк. */
  maxRetries?: number;
  /** Тестовая подмена отправки: мок `api` — Proxy, spyOn на нём невозможен. */
  send?: SendFn;
  /** Дополнительные параметры Bot API (`link_preview_options`, `disable_notification`…). */
  params?: Record<string, unknown>;
  /** Оставить reply-клавиатуру видимой: только `/start` и `/menu`. */
  keepReplyKeyboard?: boolean;
}

const defaultSend: SendFn = (params) => sdkApi.sendMessage(params) as Promise<unknown>;

/** `BotApiError` из платформы либо структурно такой же объект (мок, другой инстанс модуля). */
interface BotApiErrorLike {
  code: number;
  description: string;
  method?: string;
  parameters?: Record<string, unknown>;
}

function asBotApiError(error: unknown): BotApiErrorLike | null {
  if (error instanceof BotApiError) return error as unknown as BotApiErrorLike;
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Partial<BotApiErrorLike>;
  if (typeof candidate.code === 'number' && typeof candidate.description === 'string') {
    return candidate as BotApiErrorLike;
  }
  return null;
}

function isRetryAfter(error: BotApiErrorLike): boolean {
  return error.code === 429;
}

/** Запрос отклонён из-за разметки/сущностей — повторяем без `parse_mode`. */
function isEntityParseFailure(error: BotApiErrorLike): boolean {
  if (error.code !== 400) return false;
  const description = error.description.toLowerCase();
  return (
    description.includes("can't parse entities") ||
    description.includes('unsupported start tag') ||
    description.includes('unclosed') ||
    description.includes('entity')
  );
}

/**
 * Политика reply-клавиатуры — единственное место, где решается, показывать
 * сетку разделов или сворачивать её.
 *
 * Платформа: отсутствие `reply_markup` клавиатуру НЕ убирает, клиент держит
 * последнюю. Убирает только `remove_keyboard: true`.
 */
export interface ReplyMarkupPolicy {
  /** `true` — оставить reply-клавиатуру как есть (только `/start` и `/menu`). */
  keepReplyKeyboard?: boolean;
  /**
   * `false` — не добавлять `remove_keyboard` (правка сообщения: Bot API ждёт
   * там только inline-клавиатуру). По умолчанию `true`.
   */
  collapse?: boolean;
}

/** Свести любую разметку к политике: inline не трогаем, reply сворачиваем. */
export function resolveReplyMarkup(
  markup: ReplyMarkup | null | undefined,
  options: ReplyMarkupPolicy = {},
): ReplyMarkup | null {
  if (markup && 'inline_keyboard' in markup) return markup;
  if (options.keepReplyKeyboard === true) return markup ?? null;
  if (options.collapse === false) return null;
  return { remove_keyboard: true };
}

function withMarkup(
  params: Record<string, unknown>,
  markup: ReplyMarkup | null | undefined,
  policy: ReplyMarkupPolicy = {},
): Record<string, unknown> {
  const resolved = resolveReplyMarkup(markup, policy);
  return resolved ? { ...params, reply_markup: resolved } : params;
}

/**
 * Отправляет сообщение с HTML-разметкой, нарезая длинный текст на чанки.
 *
 * Семантика upstream: на 400 про разметку — один фолбэк на raw-чанк без
 * `parse_mode`; на 429 (flood control) — немедленный повтор (сна в изоляте нет).
 */
export async function safeSendMessage(
  chatId: number,
  text: string,
  options: SafeSendOptions = {},
): Promise<unknown | null> {
  const formatted = options.isHtml === true ? text : markdownToTelegramHtml(text);
  const chunks = splitMessageChunks(formatted);
  const rawChunks = options.isHtml === true ? chunks : splitMessageChunks(text);
  const maxRetries = options.maxRetries ?? 3;
  const send = options.send ?? defaultSend;
  const baseParams = options.params ?? {};
  const policy: ReplyMarkupPolicy = { keepReplyKeyboard: options.keepReplyKeyboard === true };

  let lastMessage: unknown | null = null;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] as string;
    const chunkMarkup = index === chunks.length - 1 ? options.replyMarkup : null;
    let sent = false;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        lastMessage = await send(
          withMarkup(
            { chat_id: chatId, text: chunk, parse_mode: 'HTML', ...baseParams },
            chunkMarkup,
            policy,
          ),
        );
        sent = true;
        break;
      } catch (error) {
        const apiError = asBotApiError(error);
        if (apiError && isRetryAfter(apiError)) continue; // сна нет: сразу следующая попытка
        if (apiError && isEntityParseFailure(apiError)) {
          const fallbackText = index < rawChunks.length ? (rawChunks[index] as string) : chunk;
          for (let plainAttempt = 0; plainAttempt < maxRetries; plainAttempt += 1) {
            try {
              lastMessage = await send(
                withMarkup(
                  { chat_id: chatId, text: fallbackText, ...baseParams },
                  chunkMarkup,
                  policy,
                ),
              );
              sent = true;
              break;
            } catch (plainError) {
              const plainApiError = asBotApiError(plainError);
              if (plainApiError && isRetryAfter(plainApiError)) continue;
              break;
            }
          }
          break;
        }
        break; // прочие ошибки Bot API не ретраим
      }
    }

    void sent;
    // Ушедший ответ снимает отложенную заглушку сбоя модели (lib/reply_turn.ts).
    if (sent) noteReply();
  }

  return lastMessage;
}

/** Ответ в тот же чат (upstream `safe_answer`): алиас `safeSendMessage`. */
export async function safeAnswer(
  chatId: number,
  text: string,
  options: SafeSendOptions = {},
): Promise<unknown | null> {
  return safeSendMessage(chatId, text, options);
}

export interface SafeEditOptions {
  replyMarkup?: ReplyMarkup | null;
  isHtml?: boolean;
  maxRetries?: number;
  /** Тестовая подмена редактирования. */
  send?: SendFn;
  params?: Record<string, unknown>;
}

/**
 * Редактирует сообщение с HTML-разметкой.
 * `message is not modified` — не ошибка: возвращаем `null`.
 */
export async function safeEdit(
  chatId: number,
  messageId: number,
  text: string,
  options: SafeEditOptions = {},
): Promise<unknown | null> {
  const formatted = options.isHtml === true ? text : markdownToTelegramHtml(text);
  const maxRetries = options.maxRetries ?? 3;
  const send =
    options.send ?? ((params: Record<string, unknown>) => sdkApi.editMessageText(params) as Promise<unknown>);
  const baseParams = options.params ?? {};
  // Правка сообщения принимает только inline-разметку: reply-клавиатуру здесь
  // не сворачиваем (`remove_keyboard` Bot API отклонит), а просто не передаём.
  const policy: ReplyMarkupPolicy = { collapse: false };

  const isNotModified = (apiError: BotApiErrorLike): boolean =>
    apiError.description.toLowerCase().includes('message is not modified');

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await send(
        withMarkup(
          { chat_id: chatId, message_id: messageId, text: formatted, parse_mode: 'HTML', ...baseParams },
          options.replyMarkup,
          policy,
        ),
      );
    } catch (error) {
      const apiError = asBotApiError(error);
      if (apiError && isRetryAfter(apiError)) continue;
      if (apiError && isNotModified(apiError)) return null;

      if (apiError && isEntityParseFailure(apiError)) {
        for (let plainAttempt = 0; plainAttempt < maxRetries; plainAttempt += 1) {
          try {
            return await send(
              withMarkup(
                { chat_id: chatId, message_id: messageId, text, ...baseParams },
                options.replyMarkup,
                policy,
              ),
            );
          } catch (plainError) {
            const plainApiError = asBotApiError(plainError);
            if (plainApiError && isNotModified(plainApiError)) return null;
            if (plainApiError && isRetryAfter(plainApiError)) continue;
            throw plainError;
          }
        }
        return null;
      }

      throw error;
    }
  }
  return null;
}
