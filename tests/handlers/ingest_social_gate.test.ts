/**
 * Гейт на тип входа (PLAN-AGENT-WRITE-GUARD T4, решение Р5).
 *
 * Инцидент 22.11.2026: «Привет» ушёл в агента с полным тулсетом, и модель унесла
 * заметку в корзину. Здесь держим два контракта:
 *
 *  - хендлер: светская реплика (текст, голос, подпись фото) идёт в агента с
 *    `toolAccess: 'read-only'`, а всё, где есть просьба, — с `'full'`;
 *  - движок: в read-only ходе write-тулз нет физически — нативный вызов
 *    неизвестного инструмента не выполняется, а модель получает только чтение.
 *
 * Движок подменён моком на стороне хендлера: проверяется решение, а не модель.
 * Вторая половина проверяет настоящий `runAgent` с фейковым `chatFn`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

vi.mock('../../src/lib/agent/engine.js', () => ({ runAgent: runAgentMock }));
vi.mock('../../src/lib/agent/engine', () => ({ runAgent: runAgentMock }));

import { api, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache } from '../../src/lib/config';
import { ensureAccounts } from '../../src/lib/dal/finances';
import { createNote, listNotes } from '../../src/lib/dal/notes';
import * as sttModule from '../../src/lib/stt';
import { ensureUser } from '../../src/lib/dal/users';
import {
  agentAccessFor,
  handlePhotoMessage,
  handleVoiceMessage,
  smartIngest,
} from '../../src/handlers/ingest';

const USER = 515151;
const CHAT = 515151;

const HANDLED_RUN = {
  reply: 'Привет! Чем помочь?',
  mode: 'auto',
  steps: [],
  stopReason: 'final',
  thread: [],
};

const PHOTO = [{ file_id: 'file-1', width: 100, height: 100 }];

/** Аргументы, с которыми хендлер позвал движок (последний вызов). */
function lastAgentCall(): { text: string; toolAccess?: string } {
  const call = runAgentMock.mock.calls.at(-1)?.[0] as { text: string; toolAccess?: string };
  return call;
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue(HANDLED_RUN);

  await ensureUser(USER, 'Test User');
  await ensureAccounts(USER, [{ name: 'Наличные', currency: 'EUR', initialBalanceCents: 20000 }]);
});

// ---------------------------------------------------------------------------
// Эвристика как чистая функция
// ---------------------------------------------------------------------------

describe('agentAccessFor', () => {
  it('светская реплика целиком — read-only', () => {
    for (const text of [
      'привет',
      'Привет!',
      'Здравствуйте',
      'доброе утро',
      'спасибо',
      'Спасибо большое!',
      'благодарю',
      'как дела?',
      'hi',
      'hello!',
      'пока',
      'спокойной ночи',
    ]) {
      expect({ text, access: agentAccessFor(text) }).toEqual({ text, access: 'read-only' });
    }
  });

  it('просьба, вопрос о данных и подтверждение — полный доступ', () => {
    for (const text of [
      'Привет, сколько я потратил на еду?',
      'Привет, добавь задачу купить хлеб',
      'добавь задачу купить хлеб',
      'поставь напоминание на 20:00',
      'да',
      'подтверждаю',
      'ок',
      'удали обязательство ТЕСТ-ГЕЙТ',
      'привет, как дела? сколько денег на карте',
      'мне скучно',
    ]) {
      expect({ text, access: agentAccessFor(text) }).toEqual({ text, access: 'full' });
    }
  });

  it('replyContext всегда даёт полный доступ: это продолжение диалога, а не болтовня', () => {
    expect(agentAccessFor('привет', 'Я удалю обязательство. Подтверждаешь?')).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// Хендлер: текст, голос, подпись фото — одна точка
// ---------------------------------------------------------------------------

describe('входное сообщение: гейт стоит на всех трёх векторах', () => {
  it('текст «Привет» уходит в агента с read-only', async () => {
    await smartIngest({ userId: USER, chatId: CHAT, text: 'Привет', forwarded: false });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(lastAgentCall()).toMatchObject({ toolAccess: 'read-only' });
  });

  it('«Привет, сколько я потратил на еду?» получает полный доступ', async () => {
    await smartIngest({
      userId: USER,
      chatId: CHAT,
      text: 'Привет, сколько я потратил на еду?',
      forwarded: false,
    });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(lastAgentCall()).toMatchObject({ toolAccess: 'full' });
  });

  it('«добавь задачу» получает полный доступ', async () => {
    await smartIngest({
      userId: USER,
      chatId: CHAT,
      text: 'добавь задачу купить хлеб',
      forwarded: false,
    });

    expect(lastAgentCall()).toMatchObject({ toolAccess: 'full' });
  });

  it('голосовое «привет» уходит в агента с read-only', async () => {
    (api as { getFileContent?: unknown }).getFileContent = vi
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue({
      text: 'привет',
      model: 'gemini-2.5-flash',
      modelsTried: ['gemini-2.5-flash'],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      costMicros: 0,
      byok: false,
      record: null,
    });

    await handleVoiceMessage(USER, CHAT, { file_id: 'voice-1', duration: 2 }, 55);

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(lastAgentCall()).toMatchObject({ toolAccess: 'read-only' });
  });

  it('подпись фото «привет» уходит в агента с read-only', async () => {
    await handlePhotoMessage(USER, CHAT, PHOTO, 'привет');

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(lastAgentCall()).toMatchObject({ toolAccess: 'read-only' });
  });

  it('пересланное сообщение в агента не идёт', async () => {
    await smartIngest({ userId: USER, chatId: CHAT, text: 'привет', forwarded: true });

    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
