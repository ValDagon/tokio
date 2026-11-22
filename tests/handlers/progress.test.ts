/**
 * Живая индикация хода агента (`handlers/progress.ts`).
 *
 * Что фиксируем на публичных швах (`smartIngest` + мок API):
 *  1. «печатает…» уходит сразу, до первого шага модели;
 *  2. долгий ход (>= 8 с) показывает одну эфемерную строку и обновляет её
 *     не чаще раза в 2 с по стадиям (модель / инструмент с подписью);
 *  3. быстрый ход индикатора не показывает и ничего не удаляет;
 *  4. сбой модели заменяет индикатор честным текстом ошибки, а не оставляет
 *     висеть;
 *  5. если эфемерные сообщения недоступны для обычного чата — обычное сообщение
 *     с правкой и удалением в конце;
 *  6. падение самого индикатора не ломает ход.
 *
 * Движок подменён моком: проверяется хендлер, а не модель. В изоляте нет
 * `setTimeout`, поэтому часы подменяются точечно (`Date.now`), а «медленность»
 * хода задаёт мок движка, сдвигая время перед очередной стадией.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

vi.mock('../../src/lib/agent/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/agent/engine')>();
  return { ...actual, runAgent: runAgentMock };
});
vi.mock('../../src/lib/agent/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/agent/engine')>();
  return { ...actual, runAgent: runAgentMock };
});

import {
  BotApiError,
  api,
  apiCalls,
  callsOf,
  resetApi,
  resetDb,
  sqliteDDL,
} from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache } from '../../src/lib/config';
import { ensureAccounts } from '../../src/lib/dal/finances';
import { ensureUser } from '../../src/lib/dal/users';
import { LLM_ERROR_TEXT } from '../../src/lib/agent/engine';
import { smartIngest } from '../../src/handlers/ingest';
import { startTurnProgress } from '../../src/handlers/progress';

const USER = 707070;
const CHAT = 707070;

/** Фиксированный старт хода: тесты сдвигают его вручную. */
const STARTED_AT = new Date('2026-11-22T10:00:00Z').getTime();

const clock = { now: STARTED_AT };

interface StageEvent {
  afterMs: number;
  stage: 'model' | 'tool';
  tool?: string;
}

const FINAL_RUN = {
  reply: 'Готово: посчитал.',
  mode: 'auto',
  steps: [],
  stopReason: 'final',
  thread: [],
};

/** Мок движка: перед каждой стадией двигает часы и зовёт хук индикатора. */
function scriptTurn(events: readonly StageEvent[], result: Record<string, unknown>): void {
  runAgentMock.mockImplementation(
    async (options: { onProgress?: (event: StageEvent) => Promise<void> }) => {
      for (const event of events) {
        clock.now = STARTED_AT + event.afterMs;
        await options.onProgress?.(event);
      }
      return result;
    },
  );
}

const ephemeralSends = () =>
  callsOf('sendMessage').filter((call) => call.params.ephemeral_message_parameters !== undefined);
const plainSends = () =>
  callsOf('sendMessage').filter((call) => call.params.ephemeral_message_parameters === undefined);
const sentTexts = (): string[] => plainSends().map((call) => String(call.params.text ?? ''));
const typingCalls = () => callsOf('sendChatAction');
const methods = (): string[] => apiCalls.map((call) => call.method);

/** Сервер не знает эфемерных параметров для обычного чата. */
function rejectEphemeralParameter(): void {
  const baseSend = api.sendMessage as (params: Record<string, unknown>) => Promise<unknown>;
  (api as Record<string, unknown>).sendMessage = async (params: Record<string, unknown> = {}) => {
    if (params.ephemeral_message_parameters !== undefined) {
      throw new BotApiError(
        'sendMessage',
        400,
        'Bad Request: unknown parameter ephemeral_message_parameters',
      );
    }
    return baseSend(params);
  };
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  clock.now = STARTED_AT;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue(FINAL_RUN);

  await ensureUser(USER, 'Тест');
  await ensureAccounts(USER, [{ name: 'Наличные', currency: 'EUR', initialBalanceCents: 5000 }]);
});

afterEach(() => {
  delete (api as Record<string, unknown>).sendMessage;
  delete (api as Record<string, unknown>).editMessageText;
  delete (api as Record<string, unknown>).deleteMessage;
  vi.restoreAllMocks();
  resetConfigCache();
});

describe('живая индикация хода агента', () => {
  it('долгий ход показывает индикатор, обновляет его и гасит в конце', async () => {
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'add_expense' },
        { afterMs: 11_000, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    // «Печатает…» — первый вызов хода, до обращения к модели.
    expect(apiCalls[0]?.method).toBe('sendChatAction');
    expect(apiCalls[0]?.params).toMatchObject({ chat_id: CHAT, action: 'typing' });
    // Перед каждым вызовом модели — снова «печатает…» (старт + две стадии модели).
    expect(typingCalls()).toHaveLength(3);

    // Одна эфемерная строка: появляется на медленной стадии с подписью инструмента.
    const [indicator] = ephemeralSends();
    expect(ephemeralSends()).toHaveLength(1);
    expect(String(indicator?.params.text)).toBe('⏳ Считаю расходы…');
    expect(indicator?.params.ephemeral_message_parameters).toEqual({ receiver_user_id: USER });

    // Обновление не чаще раза в 2 с: к стадии модели текст сменился на «Думаю».
    const edit = callsOf('editMessageText').at(-1);
    expect(edit?.params).toMatchObject({ chat_id: CHAT, text: '⏳ Думаю…' });
    const indicatorId = edit?.params.message_id;
    expect(typeof indicatorId).toBe('number');

    // Ответ ушёл обычным сообщением, а индикатор удалён — ничего не висит.
    expect(sentTexts().at(-1)).toBe('Готово: посчитал.');
    expect(callsOf('deleteMessage')).toHaveLength(1);
    expect(callsOf('deleteMessage')[0]?.params).toMatchObject({
      chat_id: CHAT,
      message_id: indicatorId,
    });

    // Индикатор закрыт раньше ответа не был: удаление — последний шаг.
    const tail = methods().slice(-2);
    expect(tail).toEqual(['sendMessage', 'deleteMessage']);
  });

  it('быстрый ход индикатора не показывает и ничего не удаляет', async () => {
    scriptTurn([{ afterMs: 0, stage: 'model' }], FINAL_RUN);

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    expect(ephemeralSends()).toHaveLength(0);
    expect(callsOf('editMessageText')).toHaveLength(0);
    expect(callsOf('deleteMessage')).toHaveLength(0);
    expect(sentTexts()).toEqual(['Готово: посчитал.']);
  });

  it('сбой модели заменяет индикатор честным текстом ошибки', async () => {
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'add_task' },
      ],
      { ...FINAL_RUN, reply: LLM_ERROR_TEXT, stopReason: 'llm_error' },
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    expect(callsOf('editMessageText').at(-1)?.params.text).toBe(LLM_ERROR_TEXT);
    // Заглушка не дублируется обычным сообщением и индикатор не остаётся висеть.
    expect(sentTexts()).toHaveLength(0);
    expect(callsOf('deleteMessage')).toHaveLength(0);
  });

  it('без эфемерных сообщений — обычная строка, правка и удаление', async () => {
    rejectEphemeralParameter();
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'add_expense' },
        { afterMs: 11_000, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    const indicator = plainSends()[0];
    expect(String(indicator?.params.text)).toBe('⏳ Считаю расходы…');
    const edit = callsOf('editMessageText').at(-1);
    expect(edit?.params).toMatchObject({ chat_id: CHAT, text: '⏳ Думаю…' });
    expect(callsOf('deleteMessage').at(-1)?.params).toMatchObject({
      chat_id: CHAT,
      message_id: edit?.params.message_id,
    });
    expect(sentTexts().at(-1)).toBe('Готово: посчитал.');
  });

  it('обновляет строку не чаще раза в 2 секунды', async () => {
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'add_expense' },
        { afterMs: 9_500, stage: 'tool', tool: 'add_task' },
        { afterMs: 11_000, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    expect(ephemeralSends()).toHaveLength(1);
    expect(callsOf('editMessageText')).toHaveLength(1);
  });

  it('параллельные стадии батча открывают одну строку', async () => {
    const progress = startTurnProgress({ chatId: CHAT, userId: USER, now: () => clock.now });
    clock.now = STARTED_AT + 9_000;

    await Promise.all([
      progress.onProgress({ stage: 'tool', step: 0, tool: 'add_expense' }),
      progress.onProgress({ stage: 'tool', step: 0, tool: 'add_task' }),
    ]);

    expect(ephemeralSends()).toHaveLength(1);
    await progress.finish();
    expect(callsOf('deleteMessage')).toHaveLength(1);
  });

  it('падение индикатора не ломает ход', async () => {
    const baseSend = api.sendMessage as (params: Record<string, unknown>) => Promise<unknown>;
    (api as Record<string, unknown>).sendMessage = async (params: Record<string, unknown> = {}) => {
      if (String(params.text ?? '').startsWith('⏳')) {
        throw new BotApiError('sendMessage', 500, 'Internal Server Error');
      }
      return baseSend(params);
    };
    (api as Record<string, unknown>).editMessageText = async () => {
      throw new BotApiError('editMessageText', 500, 'Internal Server Error');
    };
    (api as Record<string, unknown>).deleteMessage = async () => {
      throw new BotApiError('deleteMessage', 500, 'Internal Server Error');
    };
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'add_expense' },
        { afterMs: 11_000, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    expect(sentTexts()).toContain('Готово: посчитал.');
  });
});
