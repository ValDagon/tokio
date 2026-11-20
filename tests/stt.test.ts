/**
 * `src/lib/stt.ts` — распознавание речи через Gemini (нативный endpoint).
 *
 * Что проверяем:
 *  - base64 считается руками (на платформе нет ни `Buffer`, ни `btoa`) и
 *    совпадает с эталонными векторами RFC 4648, включая длинные буферы, где
 *    строка собирается порциями;
 *  - MIME берётся из имени файла, явный MIME его перебивает;
 *  - запрос уходит на native `:generateContent` с `inline_data`, ключ — в
 *    заголовке `x-goog-api-key`, температура 0;
 *  - отказы моделей (429/5xx/пустой транскрипт/сетевая ошибка) уводят на
 *    следующую модель цепочки, 400 — сразу наружу;
 *  - учёт токенов пишется в `llm_usage` с `purpose = 'stt'` и только когда
 *    есть `userId` и `track !== false`.
 *
 * Сеть всегда мок: `fetch` из `sdk/fetch` подменён `tests/mocks/sdk.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, fetch, makeResponse, resetDb, resetFetch, setFetchMock, sql, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';
import { ensureUser } from '../src/lib/dal/users';
import { GEMINI_NATIVE_BASE, GeminiError } from '../src/lib/gemini';
import {
  DEFAULT_STT_LANGUAGE,
  DEFAULT_STT_MIME_TYPE,
  STT_PURPOSE,
  buildTranscriptionBody,
  buildTranscriptionPrompt,
  bytesToBase64,
  extensionOf,
  extractTranscript,
  mimeTypeForFilename,
  normalizeTranscript,
  transcribeAudio,
  transcriptionUrl,
  tryTranscribe,
} from '../src/lib/stt';

const USER = 1;
const PRODUCT_KEY = 'product-key';
const MODELS = ['model-a', 'model-b'] as const;

/** Тело ответа `:generateContent`. */
function nativeResponse(
  text: unknown = 'привет',
  usage: Record<string, unknown> = {
    promptTokenCount: 100,
    candidatesTokenCount: 50,
    totalTokenCount: 150,
  },
): Record<string, unknown> {
  const parts = text === null ? [] : [{ text }];
  return {
    candidates: [{ content: { parts }, finishReason: 'STOP' }],
    usageMetadata: usage,
  };
}

/** Тело запроса N-го вызова fetch. */
function sentBody(index: number): Record<string, unknown> {
  const call = fetch.calls[index];
  expect(call).toBeDefined();
  return JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>;
}

/** Заголовки N-го вызова fetch. */
function sentHeaders(index: number): Record<string, string> {
  const call = fetch.calls[index];
  expect(call).toBeDefined();
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

/** Аудио-часть тела запроса. */
function inlinePart(index = 0): { mime_type?: string; data?: string } {
  const contents = sentBody(index).contents as Array<{ parts: Array<Record<string, unknown>> }>;
  return contents[0]?.parts[0]?.inline_data as { mime_type?: string; data?: string };
}

/** Сколько строк учёта в `llm_usage`. */
async function usageRows(): Promise<Array<Record<string, unknown>>> {
  return db.all<Record<string, unknown>>(sql`SELECT * FROM llm_usage ORDER BY id`);
}

/** Ловит ожидаемое исключение и отдаёт его типизированным. */
async function rejection(promise: Promise<unknown>): Promise<GeminiError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GeminiError);
  return error as GeminiError;
}

/** Аудио «как из Telegram»: непустой буфер. */
function audioBytes(length = 6): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = i + 1;
  return bytes;
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetFetch();
  resetConfigCache();
  setConfigOverrides({
    geminiApiKey: PRODUCT_KEY,
    masterKey: 'master-key-for-tests',
    geminiModels: [...MODELS],
  });
  // Fallback-тесты сознательно гоняют отказы — их предупреждения не нужны в выводе.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetConfigCache();
});

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

describe('bytesToBase64', () => {
  it('кодирует эталонные векторы RFC 4648', () => {
    const encode = (text: string): string =>
      bytesToBase64(new Uint8Array(Array.from(text, (char) => char.charCodeAt(0))));

    expect(encode('')).toBe('');
    expect(encode('f')).toBe('Zg==');
    expect(encode('fo')).toBe('Zm8=');
    expect(encode('foo')).toBe('Zm9v');
    expect(encode('foob')).toBe('Zm9vYg==');
    expect(encode('fooba')).toBe('Zm9vYmE=');
    expect(encode('foobar')).toBe('Zm9vYmFy');
  });

  it('совпадает с Buffer на длинном буфере (склейка порциями)', () => {
    const bytes = new Uint8Array(20_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) % 256;

    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    // Нечётный хвост — отдельная ветка с «=»-паддингом.
    expect(bytesToBase64(bytes.subarray(0, 19_999))).toBe(
      Buffer.from(bytes.subarray(0, 19_999)).toString('base64'),
    );
  });

  it('на пустом входе отдаёт пустую строку', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

describe('mimeTypeForFilename', () => {
  it('берёт расширение из имени файла', () => {
    expect(mimeTypeForFilename('voice.ogg')).toBe('audio/ogg');
    expect(mimeTypeForFilename('voice.oga')).toBe('audio/ogg');
    expect(mimeTypeForFilename('voice.opus')).toBe('audio/ogg');
    expect(mimeTypeForFilename('song.mp3')).toBe('audio/mp3');
    expect(mimeTypeForFilename('note.m4a')).toBe('audio/m4a');
    expect(mimeTypeForFilename('note.wav')).toBe('audio/wav');
    expect(mimeTypeForFilename('circle.mp4')).toBe('video/mp4');
    expect(mimeTypeForFilename('circle.webm')).toBe('audio/webm');
    expect(mimeTypeForFilename('lossless.flac')).toBe('audio/flac');
  });

  it('регистр не важен, неизвестное расширение — Telegram-дефолт', () => {
    expect(mimeTypeForFilename('VOICE.OGG')).toBe('audio/ogg');
    expect(mimeTypeForFilename('mystery.bin')).toBe(DEFAULT_STT_MIME_TYPE);
    expect(mimeTypeForFilename('no-extension')).toBe(DEFAULT_STT_MIME_TYPE);
    expect(DEFAULT_STT_MIME_TYPE).toBe('audio/ogg');
  });
});

describe('extensionOf', () => {
  it('возвращает точку с расширением либо пустую строку', () => {
    expect(extensionOf('a/b/voice.OGG')).toBe('.ogg');
    expect(extensionOf('voice.')).toBe('');
    expect(extensionOf('voice')).toBe('');
    expect(extensionOf('')).toBe('');
    expect(extensionOf('.hidden')).toBe('.hidden');
  });
});

// ---------------------------------------------------------------------------
// Текст
// ---------------------------------------------------------------------------

describe('normalizeTranscript', () => {
  it('приводит CRLF к LF и убирает хвостовые пробелы', () => {
    expect(normalizeTranscript('привет \r\nмир\t')).toBe('привет\nмир');
  });

  it('оставляет не больше одной пустой строки подряд и без краёв', () => {
    expect(normalizeTranscript('\n\nа\n\n\n\nб\n\n')).toBe('а\n\nб');
  });

  it('содержание не трогает: регистр, пунктуация, отступы внутри строк', () => {
    // Края всего текста обрезаются, но отступы второй и следующих строк — часть содержания.
    expect(normalizeTranscript('  Привет, МИР!')).toBe('Привет, МИР!');
    expect(normalizeTranscript('первая\n   вторая строка')).toBe('первая\n   вторая строка');
  });

  it('пустой вход — пустая строка', () => {
    expect(normalizeTranscript('')).toBe('');
    expect(normalizeTranscript('   \n\n  ')).toBe('');
  });
});

describe('buildTranscriptionPrompt', () => {
  it('по умолчанию просит русский и дословный транскрипт', () => {
    const prompt = buildTranscriptionPrompt();
    expect(DEFAULT_STT_LANGUAGE).toBe('ru');
    expect(prompt).toContain('in ru');
    expect(prompt).toContain('verbatim transcript');
    expect(prompt).toContain('Return ONLY');
  });

  it('подставляет переданный язык и игнорирует пустой', () => {
    expect(buildTranscriptionPrompt('en')).toContain('in en');
    expect(buildTranscriptionPrompt('  ')).toContain('in ru');
  });
});

// ---------------------------------------------------------------------------
// Запрос
// ---------------------------------------------------------------------------

describe('transcriptionUrl', () => {
  it('идёт на native-эндпоинт модели с экранированием имени', () => {
    expect(transcriptionUrl('model-a')).toBe(
      `${GEMINI_NATIVE_BASE}/models/model-a:generateContent`,
    );
    expect(transcriptionUrl('publishers/x/models/y')).toBe(
      `${GEMINI_NATIVE_BASE}/models/publishers%2Fx%2Fmodels%2Fy:generateContent`,
    );
  });
});

describe('buildTranscriptionBody', () => {
  it('кладёт аудио-часть первой, текст-инструкцию второй, температуру 0', () => {
    const body = buildTranscriptionBody(audioBytes(3), 'audio/ogg', 'ru');
    const contents = body.contents as Array<{ parts: Array<Record<string, unknown>> }>;

    expect(contents).toHaveLength(1);
    expect(contents[0]?.parts).toHaveLength(2);
    expect(contents[0]?.parts[0]).toEqual({
      inline_data: { mime_type: 'audio/ogg', data: Buffer.from(audioBytes(3)).toString('base64') },
    });
    expect(contents[0]?.parts[1]).toEqual({ text: buildTranscriptionPrompt('ru') });
    expect(body.generationConfig).toEqual({ temperature: 0 });
  });

  it('язык по умолчанию — русский', () => {
    const body = buildTranscriptionBody(audioBytes(2), 'audio/mp3');
    const contents = body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]?.parts[1]).toEqual({ text: buildTranscriptionPrompt(DEFAULT_STT_LANGUAGE) });
  });
});

describe('extractTranscript', () => {
  it('склеивает текстовые части и обрезает края', () => {
    expect(
      extractTranscript({ candidates: [{ content: { parts: [{ text: ' при' }, { text: 'вет ' }] } }] }),
    ).toBe('привет');
  });

  it('без кандидатов или текста — пустая строка', () => {
    expect(extractTranscript(null)).toBe('');
    expect(extractTranscript({})).toBe('');
    expect(extractTranscript({ candidates: [{}] })).toBe('');
    expect(extractTranscript({ candidates: [{ content: { parts: [] } }] })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// transcribeAudio
// ---------------------------------------------------------------------------

describe('transcribeAudio', () => {
  it('распознаёт речь и пишет расход с purpose = stt', async () => {
    setFetchMock((url) => makeResponse(200, nativeResponse('  привет, мир\n'), url));
    await ensureUser(USER);

    const result = await transcribeAudio(audioBytes(), { userId: USER });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe(transcriptionUrl('model-a'));
    expect(fetch.calls[0]?.init?.method).toBe('POST');

    const headers = sentHeaders(0);
    expect(headers['x-goog-api-key']).toBe(PRODUCT_KEY);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe('application/json');

    expect(inlinePart().mime_type).toBe('audio/ogg');
    expect(inlinePart().data).toBe(Buffer.from(audioBytes()).toString('base64'));

    expect(result.text).toBe('привет, мир');
    expect(result.model).toBe('model-a');
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    expect(result.modelsTried).toEqual([]);
    expect(result.byok).toBe(false);
    expect(result.costMicros).toBe(23);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: USER,
      model: 'model-a',
      prompt_tokens: 100,
      completion_tokens: 50,
      cost_micros: 23,
      purpose: STT_PURPOSE,
    });
    expect(result.record?.row?.id).toBe(1);
  });

  it('MIME берётся из имени файла, явный mimeType перебивает', async () => {
    setFetchMock((url) => makeResponse(200, nativeResponse('ок'), url));

    await transcribeAudio(audioBytes(3), { filename: 'voice.m4a' });
    expect(inlinePart(0).mime_type).toBe('audio/m4a');

    await transcribeAudio(audioBytes(3), { filename: 'voice.m4a', mimeType: 'video/mp4' });
    expect(inlinePart(1).mime_type).toBe('video/mp4');
  });

  it('404/429/5xx уводят на следующую модель цепочки', async () => {
    setFetchMock((url) =>
      url.includes('model-a')
        ? makeResponse(429, { error: { message: 'quota' } }, url)
        : makeResponse(200, nativeResponse('готово'), url),
    );

    const result = await transcribeAudio(audioBytes(3), { userId: USER });

    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]?.url).toBe(transcriptionUrl('model-a'));
    expect(fetch.calls[1]?.url).toBe(transcriptionUrl('model-b'));
    expect(result.text).toBe('готово');
    expect(result.model).toBe('model-b');
    expect(result.modelsTried).toEqual(['model-a']);
  });

  it('400 — невосстановимый отказ: сразу наружу, без второй модели', async () => {
    setFetchMock((url) => makeResponse(400, { error: { message: 'bad audio' } }, url));

    const error = await rejection(transcribeAudio(audioBytes(3), { userId: USER }));

    expect(fetch.calls).toHaveLength(1);
    expect(error.status).toBe(400);
    expect(error.model).toBe('model-a');
    expect(error.retryable).toBe(false);
    expect(error.modelsTried).toEqual(['model-a']);
    expect(error.message).toContain('stt: model-a answered 400');
    expect(error.message).toContain('bad audio');
  });

  it('пустой транскрипт — отказ модели, идём к следующей', async () => {
    setFetchMock((url) =>
      url.includes('model-a')
        ? makeResponse(200, nativeResponse('   '), url)
        : makeResponse(200, nativeResponse('вторая модель'), url),
    );

    const result = await transcribeAudio(audioBytes(3), { userId: USER });

    expect(fetch.calls).toHaveLength(2);
    expect(result.text).toBe('вторая модель');
    expect(result.modelsTried).toEqual(['model-a']);
    // Учёт пишется только за успешный вызов — одна строка.
    expect(await usageRows()).toHaveLength(1);
  });

  it('все модели отказали — GeminiError с retryable и цепочкой', async () => {
    setFetchMock((url) => makeResponse(503, { error: { message: 'overloaded' } }, url));

    const error = await rejection(transcribeAudio(audioBytes(3), { userId: USER }));

    expect(fetch.calls).toHaveLength(2);
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.modelsTried).toEqual(['model-a', 'model-b']);
    expect(error.message).toContain('stt: all models failed (model-a, model-b)');
    expect(error.message).toContain('overloaded');
    expect(await usageRows()).toHaveLength(0);
  });

  it('сетевая ошибка — тоже повод попробовать следующую модель', async () => {
    setFetchMock((url) => {
      if (url.includes('model-a')) throw new Error('socket hang up');
      return makeResponse(200, nativeResponse('после сбоя'), url);
    });

    const result = await transcribeAudio(audioBytes(3), { userId: USER });

    expect(fetch.calls).toHaveLength(2);
    expect(result.text).toBe('после сбоя');
    expect(result.modelsTried).toEqual(['model-a']);
  });

  it('сетевая ошибка у всех моделей — retryable без статуса', async () => {
    setFetchMock(() => {
      throw new Error('offline');
    });

    const error = await rejection(transcribeAudio(audioBytes(3), { userId: USER }));

    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.modelsTried).toEqual(['model-a', 'model-b']);
  });

  it('пустые байты — ошибка до сети', async () => {
    const error = await rejection(transcribeAudio(new Uint8Array(0), { userId: USER }));

    expect(fetch.calls).toHaveLength(0);
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('stt: audio data is empty');
  });

  it('track: false не пишет расход, но распознаёт', async () => {
    setFetchMock((url) => makeResponse(200, nativeResponse('тихо'), url));
    await ensureUser(USER);

    const result = await transcribeAudio(audioBytes(3), { userId: USER, track: false });

    expect(result.text).toBe('тихо');
    expect(result.record).toBeNull();
    expect(await usageRows()).toHaveLength(0);
  });

  it('без userId продуктовым ключом работает, но расход не пишет', async () => {
    setFetchMock((url) => makeResponse(200, nativeResponse('без юзера'), url));

    const result = await transcribeAudio(audioBytes(3));

    expect(result.text).toBe('без юзера');
    expect(result.record).toBeNull();
    expect(sentHeaders(0)['x-goog-api-key']).toBe(PRODUCT_KEY);
    expect(await usageRows()).toHaveLength(0);
  });

  it('явная цепочка моделей перебивает конфиг', async () => {
    setFetchMock((url) => makeResponse(200, nativeResponse('своя модель'), url));

    const result = await transcribeAudio(audioBytes(3), { models: ['custom-model'] });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe(transcriptionUrl('custom-model'));
    expect(result.model).toBe('custom-model');
  });

  it('200 с нечитаемым телом — не «отказ модели», а сломанный ответ: наружу', async () => {
    // Как `chatJson`: не-JSON при успешном статусе — не повод менять модель
    // (смена модели не починит прокси/обрезку ответа), сразу ошибка с телом.
    setFetchMock((url) => makeResponse(200, '<html>oops</html>', url));

    const error = await rejection(transcribeAudio(audioBytes(3), { userId: USER }));

    expect(fetch.calls).toHaveLength(1);
    expect(error.status).toBe(200);
    expect(error.retryable).toBe(false);
    expect(error.body).toContain('oops');
    expect(error.message).toContain('stt: model-a answered 200');
  });
});

describe('tryTranscribe', () => {
  it('успех возвращает результат', async () => {
    setFetchMock((url) => makeResponse(200, nativeResponse('мягко'), url));

    const result = await tryTranscribe(audioBytes(3));

    expect(result?.text).toBe('мягко');
  });

  it('любая ошибка — null, исключения не летят', async () => {
    setFetchMock((url) => makeResponse(400, { error: { message: 'nope' } }, url));

    await expect(tryTranscribe(audioBytes(3))).resolves.toBeNull();
    await expect(tryTranscribe(new Uint8Array(0))).resolves.toBeNull();
  });
});
