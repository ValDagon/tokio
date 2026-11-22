/**
 * T0b — монополия шаблонов снята (`docs/system/PLAN-AGENT-FIRST.md`).
 *
 * Раньше ворота перед агентом были эвристикой: `hasTriggerVerbs(text) ||
 * isAgentTrigger(text)`, то есть агент получал только сообщение с глаголом
 * операции или с `?` на конце. Теперь единственное условие — `!forwarded`,
 * а инбокс остаётся fallback'ом, когда агент промолчал и не применил ни один
 * инструмент (`tryAgentAutonomousStep` → `false`).
 *
 * Движок подменён моком: проверяется решение хендлера, а не модель.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

vi.mock('../../src/lib/agent/engine.js', () => ({ runAgent: runAgentMock }));
vi.mock('../../src/lib/agent/engine', () => ({ runAgent: runAgentMock }));

import { api, callsOf, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache } from '../../src/lib/config';
import { ensureAccounts } from '../../src/lib/dal/finances';
import { listFailureAggregates } from '../../src/lib/evolution';
import { ensureUser } from '../../src/lib/dal/users';
import { parseFinancialIntent } from '../../src/lib/financial-parser';
import { listNotes } from '../../src/lib/dal/notes';
import * as sttModule from '../../src/lib/stt';
import { handlePhotoMessage, handleVoiceMessage, smartIngest } from '../../src/handlers/ingest';

const USER = 424242;
const CHAT = 424242;

/** Агент промолчал и ничего не применил — ровно тот случай, где нужен инбокс. */
const SILENT_RUN = {
  reply: '',
  mode: 'auto',
  steps: [],
  stopReason: 'empty_reply',
  thread: [],
};

const sentTexts = (): string[] =>
  callsOf('sendMessage').map((call) => String(call.params.text ?? ''));

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue(SILENT_RUN);

  // Счета с деньгами: финансовый fast-path исполняется по-настоящему, и
  // «обменял 100 eur» не должен упираться в отказ «минуса не бывает».
  await ensureUser(USER, 'Test User');
  await ensureAccounts(USER, [{ name: 'Наличные', currency: 'EUR', initialBalanceCents: 20000 }]);
});

describe('T0b — свободный текст доходит до агента', () => {
  it('вопрос без `?` на конце всё равно доходит до агента', async () => {
    const text = 'что у меня по деньгам в этом месяце';
    expect(text.endsWith('?')).toBe(false);

    await smartIngest({ userId: USER, chatId: CHAT, text, forwarded: false });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0][0]).toMatchObject({ userId: USER, text });
  });

  it('молчание агента отправляет мысль в инбокс', async () => {
    const text = 'сохрани мысль: купить лампу для кухни';

    await smartIngest({ userId: USER, chatId: CHAT, text, forwarded: false });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const notes = await listNotes(USER);
    expect(notes.map((note) => note.rawText).join('\n')).toContain(text);
    expect(sentTexts().join('\n')).toContain('инбокс');
  });

  it('финансовая инструкция без цифр не превращается в заметку молча', async () => {
    const text =
      'Все что было на Freedom, пока с Bybit. На Bybit только долларовый счет, ' +
      'сконвертируй суммы (с округлением в большую сторону)';

    await smartIngest({ userId: USER, chatId: CHAT, text, forwarded: false });

    const sent = sentTexts().join('\n');
    expect(sent).not.toContain('Заметка сохранена');
    expect(sent).toContain('Денежную операцию не выполнил');
    expect(sent).toContain('Наличные (EUR)');

    // Входящее не теряется: текст лежит в инбоксе со своей отменой.
    const notes = await listNotes(USER);
    expect(notes.map((note) => note.rawText).join('\n')).toContain('сконвертируй');

    const failures = await listFailureAggregates(USER);
    expect(failures.some((item) => item.reason === 'parse_failed')).toBe(true);
  });

  it('просьба перевести текст не считается денежной инструкцией', async () => {
    const text = 'переведи эту мысль на английский: не забыть про лампу';

    await smartIngest({ userId: USER, chatId: CHAT, text, forwarded: false });

    expect(sentTexts().join('\n')).not.toContain('Денежную операцию');
  });

  it('пересланное сообщение к агенту не идёт', async () => {
    await smartIngest({
      userId: USER,
      chatId: CHAT,
      text: 'что у меня по деньгам в этом месяце',
      forwarded: true,
    });

    expect(runAgentMock).not.toHaveBeenCalled();
  });
});

/**
 * Ответ модели приходит Markdown'ом (заголовок, GFM-таблица, `**жирный**`).
 * `/ask` конвертировал его в Telegram HTML, а путь ингеста отдавал текст как
 * есть с `isHtml: true` — Telegram показывал сырые `###`, `|` и `**`.
 * Боевой случай: «Какие ближайшие списания?».
 */
describe('ответ модели на вопрос отрендерен', () => {
  const MARKDOWN_REPLY = `### 📅 Ближайшие списания

| Дата | Сервис | Сумма |
| :--- | :--- | :--- |
| **18 ноября** | **Google AI Pro** | 2 490 ₸ |`;

  it('ответ модели с таблицей и заголовком приходит отрендеренным', async () => {
    runAgentMock.mockResolvedValue({
      reply: MARKDOWN_REPLY,
      mode: 'auto',
      steps: [],
      stopReason: 'final',
      thread: [],
    });

    await smartIngest({ userId: USER, chatId: CHAT, text: 'Какие ближайшие списания?', forwarded: false });

    const call = callsOf('sendMessage').at(-1);
    const text = String(call?.params.text ?? '');

    expect(call?.params.parse_mode).toBe('HTML');
    expect(text).not.toContain('###');
    expect(text).not.toContain('|');
    expect(text).not.toContain('**');
    expect(text).not.toContain(':---');
    expect(text).toContain('<b>');
    expect(text).toContain('Google AI Pro');
    expect(text).toContain('2 490 ₸');
  });
});

/**
 * Отмена обмена: шаг `add_exchange` (и любой другой инструмент с
 * `transaction_id` в data) получает кнопку 🗑️ с id out-ноги — `deleteTransaction`
 * откатывает группу целиком.
 */
describe('undo_tx для обмена', () => {
  const EXCHANGE_RUN = {
    reply: 'Обменял 100 EUR → 108 USD.',
    mode: 'action',
    steps: [
      {
        index: 0,
        thought: null,
        action: { name: 'add_exchange', args: {} },
        observation: 'Обменял.',
        ok: true,
        data: { transaction_id: 42, group_id: 'group-1' },
      },
    ],
    stopReason: 'final',
    thread: [],
  };

  it('после успешного add_exchange в разметке есть undo_tx:<id>', async () => {
    // Текст, который финансовый fast-path не разбирает: проверяем именно
    // ветку агентского шага, а не собственный ответ парсера.
    const text = 'сделай обмен 100 eur на 108 usd';
    expect(parseFinancialIntent(text)).toBeNull();

    runAgentMock.mockResolvedValue(EXCHANGE_RUN);

    await smartIngest({ userId: USER, chatId: CHAT, text, forwarded: false });

    const call = callsOf('sendMessage').at(-1);
    const markup = call?.params.reply_markup as
      | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
      | undefined;
    expect(markup?.inline_keyboard[0][0]).toMatchObject({ callback_data: 'undo_tx:42' });
  });
});

/**
 * Та же дверь, что у текста: подпись к фото — тоже вход агента. До T0b её
 * пропускала только эвристика `hasTriggerVerbs || isAgentTrigger`, поэтому
 * «на фото список покупок из магазина» уходило сразу в vision, минуя агента.
 */
describe('T0b — подпись к фото доходит до агента без триггерного слова', () => {
  /** Агент применил инструмент — хендлер считает шаг обработанным. */
  const HANDLED_RUN = {
    reply: 'Готово.',
    mode: 'action',
    steps: [
      {
        index: 0,
        thought: null,
        action: { name: 'add_expense', args: {} },
        observation: 'Записал.',
        ok: true,
      },
    ],
    stopReason: 'final',
    thread: [],
  };

  const PHOTO = [{ file_id: 'file-1', width: 100, height: 100 }];
  const CAPTION = 'на фото список покупок из магазина';

  it('подпись без глагола-триггера и без `?` доходит до агента', async () => {
    runAgentMock.mockResolvedValue(HANDLED_RUN);
    expect(CAPTION.endsWith('?')).toBe(false);

    await handlePhotoMessage(USER, CHAT, PHOTO, CAPTION);

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0][0]).toMatchObject({ userId: USER, text: CAPTION });
  });

  it('пересланное фото к агенту не идёт', async () => {
    runAgentMock.mockResolvedValue(HANDLED_RUN);

    await handlePhotoMessage(USER, CHAT, PHOTO, CAPTION, 7, true);

    expect(runAgentMock).not.toHaveBeenCalled();
  });
});

describe('Slice 3 — ?startapp= deep-link кнопки после шагов агента', () => {
  const WEBAPP = 'https://mini.example.com/app';

  beforeEach(() => {
    vi.stubEnv('WEBAPP_URL', WEBAPP);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('add_task добавляет кнопку ?startapp=task_<id>', async () => {
    runAgentMock.mockResolvedValue({
      reply: 'Задача создана.',
      mode: 'action',
      steps: [
        {
          index: 0,
          thought: null,
          action: { name: 'add_task', args: {} },
          observation: 'ok',
          ok: true,
          data: { task_id: 42 },
        },
      ],
      stopReason: 'final',
      thread: [],
    });

    await smartIngest({ userId: USER, chatId: CHAT, text: 'добавь задачу купить молоко', forwarded: false });

    const call = callsOf('sendMessage').at(-1);
    expect(call?.params.reply_markup).toEqual({
      inline_keyboard: [[{ text: '📱 В приложении', web_app: { url: `${WEBAPP}?startapp=task_42` } }]],
    });
  });

  it('add_note добавляет кнопку ?startapp=note_<id>', async () => {
    runAgentMock.mockResolvedValue({
      reply: 'Заметка сохранена.',
      mode: 'action',
      steps: [
        {
          index: 0,
          thought: null,
          action: { name: 'add_note', args: {} },
          observation: 'ok',
          ok: true,
          data: { note_id: 19 },
        },
      ],
      stopReason: 'final',
      thread: [],
    });

    await smartIngest({ userId: USER, chatId: CHAT, text: 'запиши заметку про отпуск', forwarded: false });

    const call = callsOf('sendMessage').at(-1);
    expect(call?.params.reply_markup).toEqual({
      inline_keyboard: [[{ text: '📱 В приложении', web_app: { url: `${WEBAPP}?startapp=note_19` } }]],
    });
  });

  it('can_i_afford (включая вопрос с `?`) добавляет кнопку ?startapp=finances', async () => {
    runAgentMock.mockResolvedValue({
      reply: 'Да, бюджет позволяет.',
      mode: 'auto',
      steps: [
        {
          index: 0,
          thought: null,
          action: { name: 'can_i_afford', args: { amount: 50, currency: 'EUR' } },
          observation: 'ok',
          ok: true,
        },
      ],
      stopReason: 'final',
      thread: [],
    });

    await smartIngest({ userId: USER, chatId: CHAT, text: 'Могу ли я позволить себе кроссовки за 50 евро?', forwarded: false });

    const call = callsOf('sendMessage').at(-1);
    expect(call?.params.reply_markup).toEqual({
      inline_keyboard: [[{ text: '📱 В приложении', web_app: { url: `${WEBAPP}?startapp=finances` } }]],
    });
  });

  it('read-only запрос list_tasks не добавляет inline deep-link кнопку (сворачивает reply-клавиатуру)', async () => {
    runAgentMock.mockResolvedValue({
      reply: 'Твои задачи на сегодня.',
      mode: 'auto',
      steps: [
        {
          index: 0,
          thought: null,
          action: { name: 'list_tasks', args: {} },
          observation: 'ok',
          ok: true,
        },
      ],
      stopReason: 'final',
      thread: [],
    });

    await smartIngest({ userId: USER, chatId: CHAT, text: 'Какие у меня задачи?', forwarded: false });

    const call = callsOf('sendMessage').at(-1);
    expect(call?.params.reply_markup).toEqual({ remove_keyboard: true });
  });

  it('add_expense и add_exchange сохраняют undo_tx:<id> + ?startapp=finances', async () => {
    const expenseText = 'раздели вчерашний ужин поровну с другом';
    expect(parseFinancialIntent(expenseText)).toBeNull();

    runAgentMock.mockResolvedValue({
      reply: 'Записал расход.',
      mode: 'action',
      steps: [
        {
          index: 0,
          thought: null,
          action: { name: 'add_expense', args: {} },
          observation: 'ok',
          ok: true,
          data: { transaction_id: 77 },
        },
      ],
      stopReason: 'final',
      thread: [],
    });

    await smartIngest({ userId: USER, chatId: CHAT, text: expenseText, forwarded: false });

    expect(callsOf('sendMessage').at(-1)?.params.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '🗑️ Отменить', callback_data: 'undo_tx:77' },
          { text: '📱 В приложении', web_app: { url: `${WEBAPP}?startapp=finances` } },
        ],
      ],
    });

    const exchangeText = 'сделай обмен 100 eur на 108 usd';
    expect(parseFinancialIntent(exchangeText)).toBeNull();

    runAgentMock.mockResolvedValue({
      reply: 'Обменял 100 EUR → 108 USD.',
      mode: 'action',
      steps: [
        {
          index: 0,
          thought: null,
          action: { name: 'add_exchange', args: {} },
          observation: 'ok',
          ok: true,
          data: { transaction_id: 88, group_id: 'group-2' },
        },
      ],
      stopReason: 'final',
      thread: [],
    });

    await smartIngest({ userId: USER, chatId: CHAT, text: exchangeText, forwarded: false });

    expect(callsOf('sendMessage').at(-1)?.params.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '🗑️ Отменить', callback_data: 'undo_tx:88' },
          { text: '📱 В приложении', web_app: { url: `${WEBAPP}?startapp=finances` } },
        ],
      ],
    });
  });
});

describe('отсутствие цензуры ответа агента на утверждениях без `?`', () => {
  it('сообщение без `?` отдаёт осмысленный текстовый ответ или запрос подтверждения и не сваливается в инбокс', async () => {
    const text = 'Sail Research надо удалить из обязательств, я отказался';
    runAgentMock.mockResolvedValue({
      reply: 'Хорошо, уточни — удалить подписку Sail Research навсегда?',
      mode: 'action',
      steps: [],
      stopReason: 'confirm',
      thread: [],
    });

    await smartIngest({ userId: USER, chatId: CHAT, text, forwarded: false });

    const call = callsOf('sendMessage').at(-1);
    expect(String(call?.params.text ?? '')).toContain('Sail Research');
    expect(String(call?.params.text ?? '')).not.toContain('инбокс');
    expect(await listNotes(USER)).toHaveLength(0);
  });

  it('delete_liability ведёт на раздел ?startapp=debts и не цепляет undo_tx', async () => {
    vi.stubEnv('WEBAPP_URL', 'https://mini.example.com/app');
    try {
      runAgentMock.mockResolvedValue({
        reply: 'Удалил обязательство Sail Research.',
        mode: 'action',
        steps: [
          {
            index: 0,
            thought: null,
            action: { name: 'delete_liability', args: { liability_name: 'Sail Research' } },
            observation: '🗑️ Удалил обязательство «Sail Research».',
            ok: true,
            data: { liability_id: 103, name: 'Sail Research', deleted: true },
          },
        ],
        stopReason: 'final',
        thread: [],
      });

      await smartIngest({
        userId: USER,
        chatId: CHAT,
        text: 'Sail Research надо удалить из обязательств, я отказался',
        forwarded: false,
      });

      const call = callsOf('sendMessage').at(-1);
      expect(String(call?.params.text ?? '')).toContain('Удалил обязательство Sail Research');
      expect(call?.params.reply_markup).toEqual({
        inline_keyboard: [
          [{ text: '📱 В приложении', web_app: { url: 'https://mini.example.com/app?startapp=debts' } }],
        ],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('короткая финансовая фраза («500 кофе» / «потратил 15 eur на обед») идёт сначала агенту, а не перехватывается regex-парсером', async () => {
    const shortPhrase = '500 кофе';
    expect(parseFinancialIntent(shortPhrase)).not.toBeNull();

    runAgentMock.mockResolvedValue({
      reply: '☕ Записал 500 EUR за кофе.',
      mode: 'action',
      steps: [
        {
          index: 0,
          thought: null,
          action: { name: 'add_expense', args: { amount: 500, description: 'кофе' } },
          observation: 'Расход записан.',
          ok: true,
          data: { transaction_id: 91 },
        },
      ],
      stopReason: 'final',
      thread: [],
    });

    await smartIngest({ userId: USER, chatId: CHAT, text: shortPhrase, forwarded: false });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0][0]).toMatchObject({ userId: USER, text: shortPhrase });
    expect(callsOf('sendMessage').at(-1)?.params.text).toContain('☕ Записал 500 EUR за кофе.');
  });
});

describe('проброс replyContext (цитата/реплай) в агента', () => {
  afterEach(() => {
    delete (api as { getFileContent?: unknown }).getFileContent;
    vi.restoreAllMocks();
  });

  it('smartIngest передаёт цитату в runAgent, а при empty_reply сохраняет в инбокс только текст пользователя', async () => {
    const replyContext = 'Под платежи ближайших 12 дн. не хватает ~93 €';
    runAgentMock.mockResolvedValueOnce({
      reply: 'Давай разберём, как закрыть дефицит 93 €.',
      mode: 'thought_partner',
      steps: [],
      stopReason: 'final',
      thread: [],
    });

    await smartIngest({
      userId: USER,
      chatId: CHAT,
      text: 'Давай обсудим.',
      forwarded: false,
      replyContext,
    });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const agentArg = runAgentMock.mock.calls[0][0] as { text: string };
    expect(agentArg.text).toContain(replyContext);
    expect(agentArg.text).toContain('Давай обсудим.');

    // При молчании агента в инбокс попадает только чистый текст пользователя, без обёртки.
    runAgentMock.mockResolvedValueOnce(SILENT_RUN);
    await smartIngest({
      userId: USER,
      chatId: CHAT,
      text: 'Запомни просто мысль',
      forwarded: false,
      replyContext,
    });
    const notes = await listNotes(USER);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.rawText).toBe('Запомни просто мысль');
    expect(notes[0]?.rawText).not.toContain('Контекст сообщения');
  });

  it('голосовой реплай тоже передаёт replyContext в runAgent', async () => {
    (api as { getFileContent?: unknown }).getFileContent = vi
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue({
      text: 'Давай перенесём оплату',
      model: 'gemini-2.5-flash',
      modelsTried: ['gemini-2.5-flash'],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      costMicros: 0,
      byok: false,
      record: null,
    });
    runAgentMock.mockResolvedValueOnce({
      reply: 'Перенёс срок оплаты.',
      mode: 'action',
      steps: [],
      stopReason: 'final',
      thread: [],
    });

    await handleVoiceMessage(
      USER,
      CHAT,
      { file_id: 'voice-reply-1', duration: 3 },
      55,
      'GeForce NOW — 19,99 USD (20-е число)',
    );

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const agentArg = runAgentMock.mock.calls[0][0] as { text: string };
    expect(agentArg.text).toContain('GeForce NOW — 19,99 USD (20-е число)');
    expect(agentArg.text).toContain('Давай перенесём оплату');
  });
});
