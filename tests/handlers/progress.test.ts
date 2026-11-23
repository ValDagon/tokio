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
import { listNotes } from '../../src/lib/dal/notes';
import { kvGet, kvSetJson, readTurnTrace } from '../../src/lib/dal/misc';
import { beginReplyTurn, endReplyTurn } from '../../src/lib/reply_turn';
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
    // Старт хода и первая стадия модели — один сигнал: стадия пришла в ту же
    // секунду, порог `TYPING_REFRESH_MS` второй `sendChatAction` не пускает.
    expect(typingCalls()).toHaveLength(1);

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

  it('begin() и первая стадия модели дают одно «печатает…»', async () => {
    scriptTurn([{ afterMs: 300, stage: 'model' }], FINAL_RUN);

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    // Порог `TYPING_REFRESH_MS` (5 с): стадия модели через 0,3 с после старта —
    // тот же сигнал, что уже ушёл из `begin()`, второго вызова в узком месте нет.
    expect(typingCalls()).toHaveLength(1);
    // Строки прогресса не было: ход быстрый, показывать нечего.
    expect(ephemeralSends()).toHaveLength(0);
  });

  it('повторная стадия модели при открытой строке не шлёт второе «печатает…»', async () => {
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'add_expense' },
        { afterMs: 11_000, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    // «Печатает…» — только старт хода: первая стадия модели попадает в порог
    // `TYPING_REFRESH_MS`, а когда строка открыта, её продлевает правка.
    expect(typingCalls()).toHaveLength(1);
    // Строка открыта: повтор стадии модели продлевает её правкой, а не вторым
    // sendChatAction в узком месте перед отправкой ответа.
    expect(ephemeralSends()).toHaveLength(1);
    expect(callsOf('editMessageText').at(-1)?.params).toMatchObject({
      chat_id: CHAT,
      text: '⏳ Думаю…',
    });
  });

  it('отказ правки строки возвращает «печатает…», не сбрасывая строку', async () => {
    let editAttempts = 0;
    (api as Record<string, unknown>).editMessageText = async () => {
      editAttempts += 1;
      throw new BotApiError('editMessageText', 500, 'Internal Server Error');
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

    // Правка отказала — вместо тишины до конца хода пользователь получает
    // продление «печатает…» (старт хода + отказ правки).
    expect(editAttempts).toBe(1);
    expect(typingCalls()).toHaveLength(2);
    expect(typingCalls().at(-1)?.params).toMatchObject({ chat_id: CHAT, action: 'typing' });
    // Строку не бросили: в конце хода она погашена, ответ ушёл обычным текстом.
    expect(callsOf('deleteMessage')).toHaveLength(1);
    expect(sentTexts().at(-1)).toBe('Готово: посчитал.');
  });

  it('предел хода: детерминированный ответ уходит, строка индикатора гаснет', async () => {
    // Ход уперся в мягкий дедлайн движка: модели больше не зовём, но ответ
    // пользователь получает — иначе платформа убивает изолят в тишине.
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'get_inbox_digest' },
      ],
      {
        reply:
          '⏱ Не успел всё за один ход и остановился, чтобы успеть ответить.\n\nОстальное — следующим сообщением.',
        mode: 'auto',
        steps: [],
        stopReason: 'step_limit',
        thread: [],
      },
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'разбери инбокс', forwarded: false });

    expect(ephemeralSends()).toHaveLength(1);
    expect(sentTexts().at(-1)).toContain('Остальное — следующим сообщением');
    expect(callsOf('deleteMessage')).toHaveLength(1);
  });

  it('длинный финальный вызов открывает строку на стадии после возврата модели', async () => {
    // Живой замер 22.11.2026: ход 14,5 с, единственный вызов модели — финальный.
    // Стадия «перед вызовом» пришла на 0,2 с (окно 8 с не перешло), поэтому
    // строку открывает та стадия, которую движок шлёт после возврата модели.
    scriptTurn(
      [
        { afterMs: 200, stage: 'model' },
        { afterMs: 14_500, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    const [indicator] = ephemeralSends();
    expect(ephemeralSends()).toHaveLength(1);
    expect(String(indicator?.params.text)).toBe('⏳ Думаю…');
    // Положительная ветка порога: строка открывается только на 14,5 с, поэтому
    // стадия модели после 5 с обязана продлить индикатор ещё раз — иначе
    // пользователь видит 9,5 с тишины.
    expect(typingCalls()).toHaveLength(2);
    // Ответ ушёл обычным сообщением, строка погашена — ничего не висит.
    expect(sentTexts().at(-1)).toBe('Готово: посчитал.');
    expect(callsOf('deleteMessage')).toHaveLength(1);
  });

  it('быстрый ход индикатора не показывает и ничего не удаляет', async () => {
    scriptTurn([{ afterMs: 0, stage: 'model' }], FINAL_RUN);

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    expect(ephemeralSends()).toHaveLength(0);
    expect(callsOf('editMessageText')).toHaveLength(0);
    expect(callsOf('deleteMessage')).toHaveLength(0);
    expect(sentTexts()).toEqual(['Готово: посчитал.']);
  });

  it('сбой модели на вопросе заменяет индикатор честным текстом ошибки', async () => {
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'add_task' },
      ],
      { ...FINAL_RUN, reply: LLM_ERROR_TEXT, stopReason: 'llm_error' },
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'что по деньгам?', forwarded: false });

    // Ход не открыт (`deferReplyNotice` = false) — строка сама становится ответом.
    expect(callsOf('editMessageText').at(-1)?.params.text).toContain('Модель сейчас недоступна');
    // Заглушка не дублируется обычным сообщением и индикатор не остаётся висеть.
    expect(sentTexts()).toHaveLength(0);
    expect(callsOf('deleteMessage')).toHaveLength(0);
  });

  it('внутри открытого хода сбой не спорит с ответом: строка гаснет, заглушка откладывается', async () => {
    beginReplyTurn();
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'add_task' },
      ],
      { ...FINAL_RUN, reply: LLM_ERROR_TEXT, stopReason: 'llm_error' },
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'что по деньгам?', forwarded: false });

    // Строка исчезла, но ошибкой не подменялась: её отправит конец хода, если
    // за ход не будет настоящего ответа (lib/reply_turn.ts).
    expect(ephemeralSends()).toHaveLength(1);
    expect(callsOf('editMessageText')).toHaveLength(0);
    expect(callsOf('deleteMessage')).toHaveLength(1);
    const notices = endReplyTurn();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('Модель сейчас недоступна');
    expect(sentTexts()).toHaveLength(0);
  });

  it('сбой модели на не-вопросе не теряет сообщение: текст уходит в инбокс', async () => {
    beginReplyTurn();
    scriptTurn(
      [{ afterMs: 0, stage: 'model' }, { afterMs: 9_000, stage: 'model' }],
      { ...FINAL_RUN, reply: LLM_ERROR_TEXT, stopReason: 'llm_error' },
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'сохрани мысль: купить лампу', forwarded: false });

    const notes = await listNotes(USER);
    expect(notes.map((note) => note.rawText).join('\n')).toContain('купить лампу');
    expect(ephemeralSends()).toHaveLength(1);
    expect(callsOf('deleteMessage')).toHaveLength(1);
    endReplyTurn();
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

  it('если сервер не вернул id строки, индикатор не висит и не пытается снова', async () => {
    const baseSend = api.sendMessage as (params: Record<string, unknown>) => Promise<unknown>;
    let attempts = 0;
    (api as Record<string, unknown>).sendMessage = async (params: Record<string, unknown> = {}) => {
      if (params.ephemeral_message_parameters !== undefined) {
        attempts += 1;
        return {};
      }
      return baseSend(params);
    };

    const progress = startTurnProgress({ chatId: CHAT, userId: USER, now: () => clock.now });
    clock.now = STARTED_AT + 9_000;
    await progress.onProgress({ stage: 'tool', step: 0, tool: 'add_expense' });
    clock.now = STARTED_AT + 11_000;
    await progress.onProgress({ stage: 'model', step: 1 });
    await progress.finish();

    expect(attempts).toBe(1);
    expect(callsOf('editMessageText')).toHaveLength(0);
    expect(callsOf('deleteMessage')).toHaveLength(0);
  });

  it('begin() гасит строку прошлого хода, убитого платформой', async () => {
    await kvSetJson(`turn_progress:${CHAT}`, { chatId: CHAT, messageId: 777 });

    const progress = startTurnProgress({ chatId: CHAT, userId: USER, now: () => clock.now });
    await progress.begin();

    expect(callsOf('deleteMessage').at(-1)?.params).toMatchObject({
      chat_id: CHAT,
      message_id: 777,
    });
    expect(await kvGet(`turn_progress:${CHAT}`)).toBeNull();
  });

  it('после успешного хода запись об открытой строке убрана', async () => {
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 9_000, stage: 'tool', tool: 'add_expense' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    expect(await kvGet(`turn_progress:${CHAT}`)).toBeNull();
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

  it('крошка хода фиксирует показанную строку', async () => {
    const progress = startTurnProgress({ chatId: CHAT, userId: USER, now: () => clock.now });
    clock.now = STARTED_AT + 9_000;
    await progress.onProgress({ stage: 'tool', step: 0, tool: 'add_expense' });
    await progress.finish();

    const { trace } = await readTurnTrace(USER);
    expect(trace?.indicator).toBe('shown');
  });

  it('крошка хода фиксирует недоступность строки, если отказали оба способа', async () => {
    (api as Record<string, unknown>).sendMessage = async () => {
      throw new BotApiError('sendMessage', 500, 'Internal Server Error');
    };

    const progress = startTurnProgress({ chatId: CHAT, userId: USER, now: () => clock.now });
    clock.now = STARTED_AT + 9_000;
    await progress.onProgress({ stage: 'tool', step: 0, tool: 'add_expense' });
    await progress.finish();

    const { trace } = await readTurnTrace(USER);
    expect(trace?.indicator).toBe('unavailable');
  });

  it('медленная история ходов открывает строку до окна 8 секунд', async () => {
    // Прошлый ход этого пользователя шёл 12 с — крошка прошлого хода ещё в `kv`
    // (`startTurnTrace` движка её перезапишет позже). Строка открывается сразу:
    // у хода без инструментов другой границы до долгого вызова модели нет.
    await kvSetJson(`turn_trace:v1:${USER}`, {
      startedAt: '2026-11-22T09:59:00.000Z',
      updatedAt: '2026-11-22T09:59:12.000Z',
      stage: 'send',
      modelCalls: 1,
      models: ['gemini-4-hydrogen'],
      tools: [],
      deadlineAt: null,
      deadlineCause: null,
      indicator: 'shown',
      stopReason: 'final',
    });
    scriptTurn(
      [
        { afterMs: 200, stage: 'model' },
        { afterMs: 14_500, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    const [indicator] = ephemeralSends();
    expect(ephemeralSends()).toHaveLength(1);
    expect(String(indicator?.params.text)).toBe('⏳ Думаю…');
    // Строка открыта на 0,2 с и живёт до отправки: повтор стадии модели на
    // 14,5 с продлевает её «печатает…» (правка тем же текстом ничего не даёт).
    expect(typingCalls()).toHaveLength(2);
    expect(sentTexts().at(-1)).toBe('Готово: посчитал.');
    expect(callsOf('deleteMessage')).toHaveLength(1);
  });

  it('счётчик дедлайн-ходов тоже считается медленной историей', async () => {
    // Ход, упёршийся в бюджет 26 с, — медленный по определению, даже если
    // крошка прошлого хода уже стёрта или коротка.
    await kvSetJson(`turn_stats:v1:${USER}`, {
      turns: 4,
      deadlineTurns: 1,
      updatedAt: '2026-11-22T09:59:12.000Z',
    });
    scriptTurn([{ afterMs: 300, stage: 'model' }], FINAL_RUN);

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    expect(ephemeralSends()).toHaveLength(1);
    expect(callsOf('deleteMessage')).toHaveLength(1);
  });

  it('быстрый прошлый ход строку заранее не открывает', async () => {
    await kvSetJson(`turn_trace:v1:${USER}`, {
      startedAt: '2026-11-22T09:59:00.000Z',
      updatedAt: '2026-11-22T09:59:02.000Z',
      stage: 'send',
      modelCalls: 1,
      models: ['gemini-4-hydrogen'],
      tools: [],
      deadlineAt: null,
      deadlineCause: null,
      indicator: 'none',
      stopReason: 'final',
    });
    scriptTurn([{ afterMs: 200, stage: 'model' }], FINAL_RUN);

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    // Окно 8 с не пройдено, история короткая, инструментов не было — строки нет.
    expect(ephemeralSends()).toHaveLength(0);
  });

  it('тяжёлый инструмент открывает строку раньше окна 8 секунд', async () => {
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 2_000, stage: 'tool', tool: 'get_inbox_digest' },
        { afterMs: 3_000, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'разбери инбокс', forwarded: false });

    const [indicator] = ephemeralSends();
    expect(ephemeralSends()).toHaveLength(1);
    expect(String(indicator?.params.text)).toBe('⏳ Собираю инбокс…');
    expect(callsOf('deleteMessage')).toHaveLength(1);
  });

  it('лёгкий инструмент до окна 8 секунд строку не открывает', async () => {
    scriptTurn(
      [
        { afterMs: 2_000, stage: 'tool', tool: 'add_expense' },
        { afterMs: 3_000, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'запиши обед 12 евро', forwarded: false });

    expect(ephemeralSends()).toHaveLength(0);
  });

  it('видимая строка продлевается «печатает…» на возврате модели не чаще 5 секунд', async () => {
    await kvSetJson(`turn_trace:v1:${USER}`, {
      startedAt: '2026-11-22T09:59:00.000Z',
      updatedAt: '2026-11-22T09:59:12.000Z',
      stage: 'send',
      modelCalls: 1,
      models: ['gemini-4-hydrogen'],
      tools: [],
      deadlineAt: null,
      deadlineCause: null,
      indicator: 'shown',
      stopReason: 'final',
    });
    scriptTurn(
      [
        { afterMs: 0, stage: 'model' },
        { afterMs: 4_000, stage: 'model' },
        { afterMs: 6_000, stage: 'model' },
      ],
      FINAL_RUN,
    );

    await smartIngest({ userId: USER, chatId: CHAT, text: 'посчитай бюджет', forwarded: false });

    expect(ephemeralSends()).toHaveLength(1);
    // 4 с — внутри порога `TYPING_REFRESH_MS`, продления нет; 6 с — за порогом,
    // «печатает…» уходит ещё раз. Правки тем же текстом нет вовсе.
    expect(typingCalls()).toHaveLength(2);
    expect(callsOf('editMessageText')).toHaveLength(0);
    expect(callsOf('deleteMessage')).toHaveLength(1);
  });
});
