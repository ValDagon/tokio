/**
 * STT: распознавание речи из голосовых и видеокружков.
 *
 * Порт `backend/app/services/stt.py` с двумя осознанными отличиями:
 *
 *  - **Только Gemini.** В Python первичен Groq Whisper, а Gemini — резерв.
 *    По SPEC §2.7 Groq-ключ не переносится: остаётся один провайдер, и вся
 *    цепочка моделей строится тем же конфигом, что и чат (`geminiModels`).
 *    Это же убирает семафор на один запрос: без Groq конкуренции нет.
 *  - **Своя native-выкладка запроса.** Аудио передаётся не через
 *    OpenAI-совместимый `/chat/completions`, а через
 *    `${GEMINI_NATIVE_BASE}/models/{model}:generateContent` с `inline_data`:
 *    так байты не кодируются дважды, а ответ модели не оборачивается в
 *    chat-структуру. Ключ, выбор BYOK/продуктового и fallback-политика —
 *    общие, из `lib/gemini.ts`, чтобы поведение не разъезжалось.
 *
 * Пустой транскрипт — это отказ модели (как пустой `content` в чате): идём к
 * следующей модели цепочки. Причину отказа каждой модели собираем в
 * `GeminiError.modelsTried` и в тексте итоговой ошибки.
 *
 * Учёт токенов (`llm_usage.purpose = 'stt'`) — best-effort: сбой учёта не
 * должен отбирать у пользователя распознанный текст.
 */

import { fetch } from 'sdk/fetch';
import type { FetchResponse } from 'sdk/fetch';
import {
  GEMINI_NATIVE_BASE,
  GeminiError,
  resolveApiKey,
  resolveModelChain,
  shouldTryNextModel,
  type ChatUsage,
} from './gemini.js';
import {
  checkSpendLimit,
  estimateCostMicros,
  recordUsage,
  SPEND_LIMIT_EXCEEDED_MESSAGE,
  type UsageRecord,
} from './billing.js';
import { nowIso } from './utils.js';

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/** Назначение вызова в `llm_usage.purpose`. */
export const STT_PURPOSE = 'stt';

/** Язык распознавания по умолчанию (как в upstream `language="ru"`). */
export const DEFAULT_STT_LANGUAGE = 'ru';

/** Расширения → MIME. Набор один в один из `transcribe_audio_gemini`. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mp3',
  '.m4a': 'audio/m4a',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};

/** MIME для неизвестного расширения: Telegram-голосовые всегда OGG/Opus. */
export const DEFAULT_STT_MIME_TYPE = 'audio/ogg';

/** Лимит «хвоста» тела ошибки, который уезжает в сообщение и в лог. */
const ERROR_BODY_LIMIT = 300;

// ---------------------------------------------------------------------------
// base64 без Buffer/btoa
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Размер порции при сборке строки: `chunk += str` на больших массивах дорог. */
const BASE64_CHUNK_SIZE = 8192;

/**
 * Uint8Array → base64 (RFC 4648, с `=`-паддингом).
 *
 * Платформа не даёт ни `Buffer`, ни `btoa`, поэтому кодируем руками. Порции
 * по 8192 символа нужны, чтобы не собирать одну гигантскую строку конкатенацией
 * по одному символу (иначе на голосовом в мегабайт это заметно медленно).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const chunks: string[] = [];
  let chunk = '';

  const pushTriplet = (a: number, b: number, c: number): void => {
    chunk += BASE64_ALPHABET[a >> 2];
    chunk += BASE64_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    chunk += BASE64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)];
    chunk += BASE64_ALPHABET[c & 0x3f];
  };

  const length = source.length;
  const full = length - (length % 3);
  for (let i = 0; i < full; i += 3) {
    pushTriplet(source[i]!, source[i + 1]!, source[i + 2]!);
    if (chunk.length >= BASE64_CHUNK_SIZE) {
      chunks.push(chunk);
      chunk = '';
    }
  }

  const rest = length - full;
  if (rest === 1) {
    const a = source[full]!;
    chunk += BASE64_ALPHABET[a >> 2];
    chunk += BASE64_ALPHABET[(a & 0x03) << 4];
    chunk += '==';
  } else if (rest === 2) {
    const a = source[full]!;
    const b = source[full + 1]!;
    chunk += BASE64_ALPHABET[a >> 2];
    chunk += BASE64_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    chunk += BASE64_ALPHABET[(b & 0x0f) << 2];
    chunk += '=';
  }

  if (chunk) chunks.push(chunk);
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// MIME и текст
// ---------------------------------------------------------------------------

/** Расширение файла (с точкой, в нижнем регистре); нет расширения → `''`. */
export function extensionOf(filename: string): string {
  const name = String(filename ?? '').trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot);
}

/** MIME по имени файла; неизвестное расширение → `audio/ogg`. */
export function mimeTypeForFilename(filename: string): string {
  return MIME_BY_EXTENSION[extensionOf(filename)] ?? DEFAULT_STT_MIME_TYPE;
}

/**
 * Чистка расшифровки.
 *
 * Модели любят добавлять переводы строк CRLF и лишние пустые строки между
 * репликами. Приводим к одному виду: LF, без хвостовых пробелов в строках,
 * не больше одной пустой строки подряд, без пустых строк по краям. Содержание
 * (включая регистр и пунктуацию) не трогаем — это дословный транскрипт.
 */
export function normalizeTranscript(text: string): string {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00A0\u202F]+$/g, ''));

  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Запрос
// ---------------------------------------------------------------------------

/** Промпт распознавания: дословно из upstream, с подстановкой языка. */
export function buildTranscriptionPrompt(language: string = DEFAULT_STT_LANGUAGE): string {
  const lang = String(language ?? '').trim() || DEFAULT_STT_LANGUAGE;
  return (
    `Transcribe this audio recording accurately in ${lang} (Russian if spoken). ` +
    'Return ONLY the verbatim transcript text without any introductory text, concluding notes, ' +
    'timestamps, or extra commentary.'
  );
}

export interface TranscribeOptions {
  /** Чей ключ тратить и в чью квоту писать (BYOK иначе — продуктовый ключ). */
  userId?: number;
  /** Начать цепочку с этой модели. */
  model?: string;
  /** Явная цепочка моделей (перебивает `model` и конфиг). */
  models?: readonly string[];
  /** Язык распознавания; по умолчанию `ru`. */
  language?: string;
  /** Имя файла: из него берётся MIME (`.ogg`, `.m4a`, …). */
  filename?: string;
  /** Явный MIME (перебивает имя файла). */
  mimeType?: string;
  /** `false` — не писать в `llm_usage` (сухой прогон). */
  track?: boolean;
}

export interface TranscribeResult {
  /** Дословный транскрипт (уже нормализованный по переводам строк). */
  text: string;
  /** Модель, которая распознала. */
  model: string;
  usage: ChatUsage;
  /** Стоимость вызова в µUSD (0 при `track: false`). */
  costMicros: number;
  /** Ответ оплачен ключом пользователя. */
  byok: boolean;
  /** Модели, отказавшие до успеха, по порядку. */
  modelsTried: string[];
  /** Строка `llm_usage`, если учёт писался. */
  record: UsageRecord | null;
}

interface NativePart {
  text?: unknown;
  inline_data?: { mime_type?: unknown; data?: unknown };
  inlineData?: { mimeType?: unknown; data?: unknown };
}

interface NativeResponseBody {
  candidates?: Array<{ content?: { parts?: NativePart[] }; finishReason?: unknown }>;
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    totalTokenCount?: unknown;
  };
  error?: { message?: unknown; status?: unknown };
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Читает тело один раз: у платформенного Response `bodyUsed` необратим. */
async function readBody(response: FetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return String(error);
  }
}

function parseJson(text: string): unknown {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function errorMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const error = (body as NativeResponseBody).error;
    if (error && typeof error.message === 'string') return error.message;
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  return String(body ?? '');
}

/** Адрес native-endpoint'а модели. */
export function transcriptionUrl(model: string): string {
  return `${GEMINI_NATIVE_BASE}/models/${encodeURIComponent(model)}:generateContent`;
}

/** Тело запроса: аудио-часть первой, текст-инструкция второй (как в upstream). */
export function buildTranscriptionBody(
  bytes: Uint8Array,
  mimeType: string,
  language: string = DEFAULT_STT_LANGUAGE,
): Record<string, unknown> {
  return {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mimeType, data: bytesToBase64(bytes) } },
          { text: buildTranscriptionPrompt(language) },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  };
}

/** Текст первого кандидата ответа; `''`, если модель ничего не вернула. */
export function extractTranscript(parsed: NativeResponseBody | null): string {
  const parts = parsed?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part?.text === 'string') texts.push(part.text);
  }
  return texts.join('').trim();
}

/**
 * Распознаёт речь.
 *
 * @param bytes аудио/видео как есть (без base64 — кодируем внутри).
 * @throws {GeminiError} если ни одна модель не дала непустой транскрипт.
 */
export async function transcribeAudio(
  bytes: Uint8Array,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (data.length === 0) {
    throw new GeminiError('stt: audio data is empty', { retryable: false });
  }

  // [public-only] Лимит $2 на общий ключ — только публичная редакция.
  if (typeof options.userId === 'number') {
    const spend = await checkSpendLimit(options.userId);
    if (!spend.allowed) {
      throw new GeminiError(SPEND_LIMIT_EXCEEDED_MESSAGE, { status: 429, retryable: false });
    }
  }

  const chain = await resolveModelChain({ model: options.model, models: options.models });
  const { apiKey, byok } = await resolveApiKey(options.userId);
  const mimeType = String(options.mimeType ?? '').trim() || mimeTypeForFilename(options.filename ?? 'voice.ogg');
  const language = String(options.language ?? '').trim() || DEFAULT_STT_LANGUAGE;
  const body = JSON.stringify(buildTranscriptionBody(data, mimeType, language));

  const modelsTried: string[] = [];
  let lastStatus = 0;
  let lastBody = '';

  for (const model of chain) {
    const url = transcriptionUrl(model);
    let response: FetchResponse;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      });
    } catch (error) {
      // Сетевая ошибка: ответа не было — пробуем следующую модель.
      modelsTried.push(model);
      lastStatus = 0;
      lastBody = error instanceof Error ? error.message : String(error);
      continue;
    }

    const text = await readBody(response);
    const parsed = parseJson(text) as NativeResponseBody | null;

    if (!response.ok || !parsed) {
      modelsTried.push(model);
      lastStatus = response.status;
      lastBody = text;
      if (shouldTryNextModel(response.status)) continue;
      throw new GeminiError(
        `stt: ${model} answered ${response.status}: ${errorMessage(parsed ?? text).slice(0, ERROR_BODY_LIMIT)}`,
        { status: response.status, model, body: text, retryable: false, modelsTried },
      );
    }

    const transcript = normalizeTranscript(extractTranscript(parsed));
    if (!transcript) {
      // Молчание модели — повод попробовать следующую, как пустой content в чате.
      modelsTried.push(model);
      lastStatus = response.status;
      lastBody = text;
      continue;
    }

    const promptTokens = asCount(parsed.usageMetadata?.promptTokenCount);
    const completionTokens = asCount(parsed.usageMetadata?.candidatesTokenCount);
    const totalTokens =
      asCount(parsed.usageMetadata?.totalTokenCount) || promptTokens + completionTokens;
    const usage: ChatUsage = { promptTokens, completionTokens, totalTokens };

    let record: UsageRecord | null = null;
    let costMicros = estimateCostMicros(model, promptTokens, completionTokens);
    if (typeof options.userId === 'number' && options.track !== false) {
      try {
        record = await recordUsage(options.userId, {
          model,
          promptTokens,
          completionTokens,
          costMicros,
          purpose: STT_PURPOSE,
          byok,
        });
        costMicros = record.costMicros;
      } catch (error) {
        console.warn('stt: could not record LLM usage:', error);
      }
    }

    return { text: transcript, model, usage, costMicros, byok, modelsTried, record };
  }

  throw new GeminiError(
    `stt: all models failed (${chain.join(', ')})${lastBody ? `: ${lastBody.slice(0, ERROR_BODY_LIMIT)}` : ''}`,
    {
      status: lastStatus,
      model: chain[chain.length - 1] ?? null,
      body: lastBody,
      retryable: lastStatus === 0 || shouldTryNextModel(lastStatus),
      modelsTried,
    },
  );
}

/** Мягкая версия `transcribeAudio`: любая ошибка → `null` (плюс предупреждение). */
export async function tryTranscribe(
  bytes: Uint8Array,
  options: TranscribeOptions = {},
): Promise<TranscribeResult | null> {
  try {
    return await transcribeAudio(bytes, options);
  } catch (error) {
    console.warn(`stt: transcription failed at ${nowIso()}:`, error);
    return null;
  }
}
