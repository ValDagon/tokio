/**
 * T14 — точка входа изолята `handlers/message.ts`.
 *
 * Раньше это был echo-стаб; теперь это диспетчер: платформа отдаёт всё в один
 * хендлер, и он решает, куда идёт апдейт — в `routeMessage` (текст) или в
 * `routeCallback` (нажатие inline-кнопки, пришедшее payload'ом либо внутри
 * `ctx.update.callback_query`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from 'sdk';

import { callsOf, resetApi, resetDb, sqliteDDL } from './mocks/sdk';

import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { resetConfigCache } from '../src/lib/config';
import { kvSetIfAbsent } from '../src/lib/dal/misc';
import { ensureUser } from '../src/lib/dal/users';
import { dateKey } from '../src/lib/utils';
import handleUpdate, { type CallbackQuery, type Message } from '../src/handlers/message';
import {
  INBOX_EMPTY_TEXT,
  resetRouterSeams,
  setTriageHandler,
  TRIAGE_EMPTY_TEXT,
} from '../src/handlers/router';

const USER = 777;
const CHAT = 4242;

function textMessage(text: string | null, extra: Partial<Message> = {}): Message {
  const message: Message = {
    message_id: 1,
    chat: { id: CHAT, type: 'private' },
    from: { id: USER, first_name: 'Алекс' },
    ...extra,
  };
  if (text !== null) message.text = text;
  return message;
}

function callback(data: string): CallbackQuery {
  return {
    id: 'cb-echo',
    from: { id: USER, first_name: 'Алекс' },
    data,
    message: { message_id: 9, chat: { id: CHAT } },
  };
}

const sentTexts = (): string[] =>
  callsOf('sendMessage').map((call) => String(call.params.text ?? ''));

/**
 * Глушит ленивый крон утренней сводки (`deliverMorningDigest` в `handleUpdate`).
 *
 * Сводка созревает в окне `[summary_time, summary_time + 4ч]` (по умолчанию
 * 07:00–11:00) по таймзоне пользователя, поэтому без этой метки любой прогон
 * в утренние часы получает лишний `sendMessage` и ломает диспетчерские
 * проверки. Метка — та же, что прод ставит после отправки
 * (`morning_digest:<user_id>:<YYYY-MM-DD>`), и проверяется до сборки сводки,
 * так что тест детерминирован на любом стенном часе и в любой TZ раннера.
 */
async function markMorningDigestSent(timeZone: string): Promise<void> {
  const day = dateKey(new Date(), timeZone);
  await kvSetIfAbsent(
    `morning_digest:${USER}:${day}`,
    JSON.stringify({ sentAt: new Date().toISOString(), digestDate: day }),
  );
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  resetRouterSeams();
  vi.unstubAllEnvs();
  vi.stubEnv('APP_ENV', '');
  vi.stubEnv('WEBAPP_URL', '');
  const user = await ensureUser(USER, 'Алекс');
  await markMorningDigestSent(user.timezone ?? 'Europe/Berlin');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('handlers/message: диспетчеризация', () => {
  it('текст уходит в routeMessage', async () => {
    await handleUpdate(textMessage('/inbox'), {});

    expect(sentTexts()).toEqual([INBOX_EMPTY_TEXT]);
    expect(callsOf('sendMessage')[0]?.params.chat_id).toBe(CHAT);
  });

  it('без текста и без callback — никаких вызовов Bot API', async () => {
    await handleUpdate({ message_id: 2, chat: { id: CHAT, type: 'private' }, from: { id: USER } }, {});

    expect(callsOf('sendMessage')).toHaveLength(0);
    expect(callsOf('answerCallbackQuery')).toHaveLength(0);
  });

  it('null и undefined — молча выходят', async () => {
    await expect(handleUpdate(null)).resolves.toBeUndefined();
    await expect(handleUpdate(undefined, {})).resolves.toBeUndefined();

    expect(callsOf('sendMessage')).toHaveLength(0);
  });

  it('callback из ctx.update.callback_query идёт в routeCallback', async () => {
    setTriageHandler(async () => ({ count: 0, text: '' }));

    await handleUpdate(textMessage(null), { update: { callback_query: callback('triage:inbox') } });

    expect(callsOf('answerCallbackQuery')).toHaveLength(1);
    const [edit] = callsOf('editMessageText');
    // Текст идёт через markdown-конвейер, поэтому сравниваем подстрокой.
    expect(edit?.params).toMatchObject({ chat_id: CHAT, message_id: 9 });
    expect(String(edit?.params.text ?? '')).toContain('Инбокс пуст');
    expect(TRIAGE_EMPTY_TEXT).toContain('Инбокс пуст');
    expect(sentTexts()).toEqual([]);
  });

  it('callback отдельным payload’ом распознаётся по форме (id + нет chat)', async () => {
    await handleUpdate(callback('triage:inbox'), {});

    // Без шва триажа: алерт, сообщение в чат не уходит.
    expect(callsOf('answerCallbackQuery')).toHaveLength(1);
    expect(callsOf('answerCallbackQuery')[0]?.params.show_alert).toBe(true);
    expect(callsOf('sendMessage')).toHaveLength(0);
  });

  it('ctx.update без callback_query не мешает тексту', async () => {
    await handleUpdate(textMessage('/inbox'), { update: { message: { message_id: 1 } } });

    expect(sentTexts()).toEqual([INBOX_EMPTY_TEXT]);
  });

  it('бот-API доступен как thenable-safe прокси', async () => {
    // Guard against the mock accidentally turning `api` into a thenable: awaiting it
    // would resolve to the proxy itself instead of the method result.
    await expect(api.getMe({})).resolves.toMatchObject({ is_bot: true });
  });
});
