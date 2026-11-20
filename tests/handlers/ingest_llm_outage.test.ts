/**
 * Сбой модели не должен быть единственным ответом на вопрос.
 *
 * Раньше на `llm_error` вопрос закрывался заглушкой «Не удалось получить ответ
 * от модели» — даже когда ответ лежит в SQLite и модель для него не нужна.
 * Теперь вместо заглушки уходит детерминированный ответ (сводка/долги/задачи),
 * а заглушка остаётся только для случая, когда детерминированного ответа нет.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const LLM_TEXT = 'Не удалось получить ответ от модели. Попробуйте ещё раз через минуту.';
const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

vi.mock('../../src/lib/agent/engine.js', () => ({
  runAgent: runAgentMock,
  LLM_ERROR_TEXT: 'Не удалось получить ответ от модели. Попробуйте ещё раз через минуту.',
}));
vi.mock('../../src/lib/agent/engine', () => ({
  runAgent: runAgentMock,
  LLM_ERROR_TEXT: 'Не удалось получить ответ от модели. Попробуйте ещё раз через минуту.',
}));

import { callsOf, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache } from '../../src/lib/config';
import { ensureAccounts } from '../../src/lib/dal/finances';
import { kvSetJson } from '../../src/lib/dal/misc';
import { ensureUser } from '../../src/lib/dal/users';
import { smartIngest } from '../../src/handlers/ingest';

const USER = 777001;
const CHAT = 777001;

const OUTAGE_RUN = {
  reply: LLM_TEXT,
  mode: 'auto',
  steps: [],
  stopReason: 'llm_error',
  thread: [],
};

const sentText = (): string => callsOf('sendMessage').map((call) => String(call.params.text ?? '')).join('\n');

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue(OUTAGE_RUN);

  await ensureUser(USER, 'Test User');
  await ensureAccounts(USER, [{ name: 'Наличные', currency: 'EUR', initialBalanceCents: 20000 }]);
});

describe('сбой модели на вопросе', () => {
  it('вопрос про деньги получает сводку, а не заглушку', async () => {
    await smartIngest({ userId: USER, chatId: CHAT, text: 'Куда я потратил деньги?', forwarded: false });

    const text = sentText();
    expect(text).toContain('Модель сейчас недоступна');
    expect(text).toContain('Наличные');
    expect(text).not.toContain(LLM_TEXT);
  });

  it('называет причину отказа, если она известна', async () => {
    await kvSetJson('llm_last_failure', { status: 429, at: '2026-11-14T12:41:00.000Z' });

    await smartIngest({ userId: USER, chatId: CHAT, text: 'Куда я потратил деньги?', forwarded: false });

    expect(sentText()).toContain('лимит запросов');
  });

  it('отдаёт слова провайдера, а не только код 400', async () => {
    await kvSetJson('llm_last_failure', {
      status: 400,
      at: '2026-11-14T12:41:00.000Z',
      detail: 'gemini: model-a answered 400',
      providerBody: '{"error":{"message":"Function call is missing a name"}}',
    });

    await smartIngest({ userId: USER, chatId: CHAT, text: 'Куда я потратил деньги?', forwarded: false });

    const text = sentText();
    expect(text).toContain('ответил 400');
    expect(text).toContain('Function call is missing a name');
  });

  it('вопрос не про данные отдаёт подсказку быстрых разделов вместо заглушки', async () => {
    await smartIngest({ userId: USER, chatId: CHAT, text: 'Как думаешь, что дальше?', forwarded: false });

    const text = sentText();
    expect(text).toContain('Модель сейчас недоступна');
    expect(text).toContain('/summary');
    expect(text).not.toContain(LLM_TEXT);
  });
});
