/**
 * Bot API 10.4 — эфемерные подтверждения нажатий кнопок.
 *
 * Сценарии на публичных швах (`routeCallback` / `handleCallbackQuery`):
 *  1. подтверждение нажатия уходит как эфемерное сообщение (`ephemeral_message_parameters`);
 *  2. если API отклонил параметр — graceful fallback на обычный ответ (toast);
 *  3. подтверждение отката платежа («🗑️ Отменить») остаётся обычным: след в логе;
 *  4. гейт доступа не затронут.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotApiError, api, callsOf, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../../src/lib/config';
import { createAccount, createLiability, createTransaction, payLiability } from '../../src/lib/dal/finances';
import { createTask } from '../../src/lib/dal/tasks';
import { ensureUser } from '../../src/lib/dal/users';

import handleCallbackQuery from '../../src/handlers/callback_query';
import { routeCallback } from '../../src/handlers/router';
import type { CallbackQuery } from '../../src/handlers/message';

const USER = 100001;
const CHAT = 100001;
const STRANGER = 999000111;

function cb(data: string, extra: Partial<CallbackQuery> = {}): CallbackQuery {
  return {
    id: 'cb-eph-1',
    from: { id: USER, first_name: 'Алекс' },
    data,
    message: { message_id: 101, chat: { id: CHAT }, text: '📌 Задача: Сдать отчёт' },
    ...extra,
  };
}

const ephemeralSends = () =>
  callsOf('sendMessage').filter((c) => c.params.ephemeral_message_parameters !== undefined);
const plainSends = () =>
  callsOf('sendMessage').filter((c) => c.params.ephemeral_message_parameters === undefined);
const toasts = () =>
  callsOf('answerCallbackQuery').filter((c) => typeof c.params.text === 'string');

/** Имитирует сервер, отклоняющий неизвестный параметр. */
function rejectEphemeralParameter(): void {
  (api as Record<string, unknown>).sendMessage = async (params: Record<string, unknown> = {}) => {
    if (params.ephemeral_message_parameters !== undefined) {
      throw new BotApiError('sendMessage', 400, 'Bad Request: unknown parameter ephemeral_message_parameters');
    }
    return { message_id: 1, date: 0, chat: { id: params.chat_id }, text: params.text };
  };
}

describe('Bot API 10.4 ephemeral callback confirmations', () => {
  beforeEach(async () => {
    resetApi();
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    resetConfigCache();
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [USER] });
    await ensureUser(USER, 'Алекс');
  });

  afterEach(() => {
    delete (api as Record<string, unknown>).sendMessage;
    resetConfigCache();
  });

  it('task_done confirms with an ephemeral message bound to the callback query', async () => {
    const task = await createTask(USER, { title: 'Сдать отчёт', status: 'todo' });
    await routeCallback(cb(`task_done:${task.id}`));

    const [eph] = ephemeralSends();
    expect(eph?.params.text).toBe('✅ Задача выполнена!');
    expect(eph?.params.chat_id).toBe(CHAT);
    expect(eph?.params.ephemeral_message_parameters).toEqual({ callback_query_id: 'cb-eph-1' });
    expect(plainSends()).toHaveLength(0);
    // Спиннер на кнопке гасится ответом без текста.
    expect(callsOf('answerCallbackQuery')).toHaveLength(1);
    expect(toasts()).toHaveLength(0);
  });

  it('falls back to a plain answer when the API rejects the ephemeral parameter', async () => {
    rejectEphemeralParameter();
    const task = await createTask(USER, { title: 'Сдать отчёт', status: 'todo' });
    await routeCallback(cb(`task_done:${task.id}`));

    expect(toasts().map((c) => c.params.text)).toEqual(['✅ Задача выполнена!']);
    expect(callsOf('editMessageText')).toHaveLength(1);
  });

  it('keeps the payment rollback confirmation visible (no ephemeral)', async () => {
    const acc = await createAccount(USER, { name: 'Cash', currency: 'EUR', initialBalanceCents: 10_000 });
    const tx = await createTransaction(USER, {
      kind: 'expense',
      accountId: acc.id,
      amountCents: 2550,
      currency: 'EUR',
      description: 'Обед',
    });
    await handleCallbackQuery(
      cb(`undo_tx:${tx.id}`, {
        message: { message_id: 301, chat: { id: CHAT }, text: '💸 Расход зафиксирован' },
      }),
    );

    expect(ephemeralSends()).toHaveLength(0);
    expect(toasts().map((c) => c.params.text)).toEqual(['🗑️ Запись отменена']);
    const edit = callsOf('editMessageText').at(-1);
    expect(edit?.params.text).toContain('🗑️ Запись отменена и удалена.');
  });

  it('keeps the liability payment rollback visible (no ephemeral)', async () => {
    const acc = await createAccount(USER, { name: 'Main Bank', currency: 'EUR' });
    const liability = await createLiability(USER, {
      name: 'Mobile Carrier',
      currency: 'EUR',
      amountCents: 30000,
      monthlyPaymentCents: 3000,
    });
    const paid = await payLiability(USER, { liabilityId: liability.id, accountId: acc.id });
    const month = new Date().toISOString().slice(0, 7);
    resetApi();
    await routeCallback(cb(`undo_liability:${liability.id}:${month}:${paid.transaction?.id ?? 0}`));
    expect(ephemeralSends()).toHaveLength(0);
    expect(toasts().map((c) => c.params.text)).toEqual(['🗑️ Запись отменена']);
  });

  it('does not touch the access gate: strangers get no ephemeral confirmation', async () => {
    await handleCallbackQuery(cb('task_done:1', { from: { id: STRANGER } }));
    expect(ephemeralSends()).toHaveLength(0);
    expect(callsOf('editMessageText')).toHaveLength(0);
  });
});
