/**
 * MU-4 — последний защитный `catch` в `handleUpdate`
 * (`.scratch/major-update/issues/04-diagnostics-and-update-catch.md`).
 *
 * Контракт, который проверяется снаружи (база + чат):
 *  1. необработанное исключение из тела апдейта не уходит в платформенный 500;
 *  2. причина попадает в журнал нормализованной сигнатурой;
 *  3. входящее сохраняется best-effort **ровно один раз** на `message_id`;
 *  4. пользователь получает честный ответ, а не тишину;
 *  5. отказ самого аварийного пути (БД лежит) не превращает апдейт в исключение.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsOf, db, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache, setConfigOverrides } from '../../src/lib/config';
import { listNotes } from '../../src/lib/dal/notes';
import { ensureUser } from '../../src/lib/dal/users';
import { listFailureAggregates } from '../../src/lib/evolution';
import handleUpdate, {
  UNHANDLED_UPDATE_KIND,
  UNHANDLED_UPDATE_TEXT,
  type CallbackQuery,
  type Message,
} from '../../src/handlers/message';
import {
  registerCallback,
  resetRouterSeams,
  setTextIngestHandler,
} from '../../src/handlers/router';

const USER = 424245;
const CHAT = 424245;

function message(extra: Partial<Message> = {}): Message {
  return {
    message_id: 700,
    chat: { id: CHAT, type: 'private' },
    from: { id: USER, first_name: 'Test' },
    date: 0,
    text: 'мысль, которую нельзя потерять',
    ...extra,
  };
}

function callback(data: string): CallbackQuery {
  return {
    id: 'cb-boom-1',
    from: { id: USER, first_name: 'Test' },
    data,
    message: { message_id: 701, chat: { id: CHAT }, text: 'старый текст' },
  };
}

const sentTexts = (): string[] =>
  callsOf('sendMessage').map((call) => String(call.params.text ?? ''));

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  setConfigOverrides({ betaWhitelist: [USER], adminIds: [USER] });
  resetRouterSeams();
  await ensureUser(USER, 'Test User');
});

afterEach(() => {
  resetRouterSeams();
  vi.restoreAllMocks();
});

describe('handleUpdate: необработанное исключение', () => {
  it('текст: причина в журнал, входящее сохранено, ответ честный', async () => {
    setTextIngestHandler(async () => {
      throw new Error('ingest exploded');
    });

    await expect(handleUpdate(message())).resolves.toBeUndefined();

    const [aggregate] = await listFailureAggregates(USER);
    expect(aggregate).toMatchObject({
      signature: 'router|text|unhandled|-',
      stage: 'router',
      reason: 'unhandled',
      count: 1,
    });
    expect(aggregate?.detail).toBe('ingest exploded');

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.rawText).toBe('мысль, которую нельзя потерять');
    expect(notes[0]?.sourceMessageId).toBe(700);
    expect((notes[0]?.metadata as Record<string, unknown>).kind).toBe(UNHANDLED_UPDATE_KIND);

    expect(sentTexts()).toEqual([UNHANDLED_UPDATE_TEXT]);
  });

  it('входящее сохраняется ровно один раз на message_id', async () => {
    setTextIngestHandler(async () => {
      throw new Error('ingest exploded');
    });

    await handleUpdate(message());
    await handleUpdate(message());

    expect(await listNotes(USER, { column: 'raw' })).toHaveLength(1);
    // Счётчик сбоев при этом честно растёт: событий было два.
    expect((await listFailureAggregates(USER))[0]?.count).toBe(2);
  });

  it('голосовое: file_id сохраняется, сигнатура несёт media voice', async () => {
    registerCallback('boom', async () => {
      throw new Error('voice pipeline exploded');
    });

    const voiceCallback = callback('boom');
    voiceCallback.message = {
      message_id: 702,
      chat: { id: CHAT },
      voice: { file_id: 'VOICE-UNHANDLED', duration: 5 },
    };

    await expect(handleUpdate(voiceCallback)).resolves.toBeUndefined();

    const [note] = await listNotes(USER, { column: 'raw' });
    expect(note?.fileId).toBe('VOICE-UNHANDLED');
    expect(note?.sourceType).toBe('voice');

    const [aggregate] = await listFailureAggregates(USER);
    expect(aggregate?.signature).toBe('router|voice|unhandled|-');
  });

  it('callback: алерт вместо тишины, апдейт не падает', async () => {
    registerCallback('boom', async () => {
      throw new Error('callback exploded');
    });

    await expect(handleUpdate(callback('boom'))).resolves.toBeUndefined();

    const [aggregate] = await listFailureAggregates(USER);
    expect(aggregate?.signature).toBe('router|text|unhandled|-');

    const answers = callsOf('answerCallbackQuery');
    expect(answers[0]?.params.text).toBe(UNHANDLED_UPDATE_TEXT);
    expect(answers[0]?.params.show_alert).toBe(true);
  });

  it('отказ БД на аварийном пути не превращается в исключение', async () => {
    setTextIngestHandler(async () => {
      throw new Error('ingest exploded');
    });
    vi.spyOn(db, 'run').mockRejectedValue(new Error('database is locked'));

    await expect(handleUpdate(message())).resolves.toBeUndefined();

    // Журнал и заметка записаться не смогли, но ответ ушёл.
    expect(sentTexts()).toEqual([UNHANDLED_UPDATE_TEXT]);
  });
});
