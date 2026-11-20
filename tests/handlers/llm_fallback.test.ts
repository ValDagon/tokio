/**
 * LLMFALLBACK — извинение за сбой модели не идёт рядом с настоящим ответом.
 *
 * 13.11 в 10:10 пользователь получил «Не удалось получить ответ от модели…»,
 * а следом — готовую сводку, которую в том же ходе собрал детерминированный
 * путь. Заглушка теперь откладывается до конца хода (`lib/reply_turn.ts`) и
 * уходит только если за ход не было ни одного другого ответа.
 *
 * Движок и напоминания подменены: проверяется решение хендлера, а не модель.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runAgentMock, digestMock, dueRemindersMock, medsMock, liabilityMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  digestMock: vi.fn(),
  dueRemindersMock: vi.fn(),
  medsMock: vi.fn(),
  liabilityMock: vi.fn(),
}));

vi.mock('../../src/lib/agent/engine.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runAgent: runAgentMock };
});
vi.mock('../../src/lib/agent/engine', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runAgent: runAgentMock };
});
vi.mock('../../src/lib/reminders.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    deliverDueReminders: dueRemindersMock,
    deliverLiabilityWarnings: liabilityMock,
    deliverMedicationReminders: medsMock,
    deliverMorningDigest: digestMock,
  };
});

import { api, callsOf, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache } from '../../src/lib/config';
import { ensureUser } from '../../src/lib/dal/users';
import { LLM_ERROR_TEXT } from '../../src/lib/agent/engine';
import {
  beginReplyTurn,
  deferReplyNotice,
  endReplyTurn,
  noteReply,
} from '../../src/lib/reply_turn';
import handleUpdate from '../../src/handlers/message';
import type { Message } from '../../src/handlers/message';

const USER = 731;
const CHAT = 731;

const NO_DELIVERY = { delivered: 0, skipped: 0, failed: 0 };

const LLM_ERROR_RUN = {
  reply: LLM_ERROR_TEXT,
  mode: 'auto',
  steps: [],
  stopReason: 'llm_error',
  thread: [],
};

function msg(text: string): Message {
  return {
    message_id: 11,
    chat: { id: CHAT },
    from: { id: USER, first_name: 'Алекс' },
    text,
  };
}

const sentTexts = (): string[] =>
  callsOf('sendMessage').map((call) => String(call.params.text ?? ''));

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  await ensureUser(USER, 'Алекс');

  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue(LLM_ERROR_RUN);
  for (const mock of [digestMock, dueRemindersMock, medsMock, liabilityMock]) {
    mock.mockReset();
    mock.mockResolvedValue(NO_DELIVERY);
  }
});

describe('lib/reply_turn: семантика хода', () => {
  it('без открытого хода заглушка отправляется сразу (прежнее поведение)', () => {
    expect(deferReplyNotice(CHAT, LLM_ERROR_TEXT)).toBe(false);
  });

  it('ответ в ходе отменяет отложенную заглушку', () => {
    beginReplyTurn();
    expect(deferReplyNotice(CHAT, LLM_ERROR_TEXT)).toBe(true);
    noteReply();
    expect(endReplyTurn()).toEqual([]);
  });

  it('молчащий ход возвращает заглушку к отправке', () => {
    beginReplyTurn();
    deferReplyNotice(CHAT, LLM_ERROR_TEXT);
    expect(endReplyTurn()).toEqual([{ chatId: CHAT, text: LLM_ERROR_TEXT }]);
  });
});

describe('LLMFALLBACK: сбой модели и детерминированный ответ в одном ходе', () => {
  it('сводка доставлена, извинения нет', async () => {
    const deliver = api.sendMessage as unknown as (
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    digestMock.mockImplementation(async () => {
      await deliver({ chat_id: CHAT, text: '☀️ **Доброе утро! Сводка на пятницу.**' });
      return { delivered: 1, skipped: 0, failed: 0 };
    });

    await handleUpdate(msg('что там по деньгам?'));

    const texts = sentTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Доброе утро');
    expect(texts.join('\n')).not.toContain(LLM_ERROR_TEXT);
  });

  it('без другого ответа вместо извинения приходит детерминированный ответ', async () => {
    await handleUpdate(msg('что там по деньгам?'));

    const texts = sentTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Модель сейчас недоступна');
    expect(texts[0]).toContain('Вот что я знаю без неё');
    expect(texts.join('\n')).not.toContain(LLM_ERROR_TEXT);
  });
});

describe('LLMFALLBACK: сводка по запросу отличается от плановой', () => {
  it('несёт строку с местным временем запроса', async () => {
    await handleUpdate(msg('дайджест'));

    const texts = sentTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('🕐 Запрошено вручную в');
  });
});
