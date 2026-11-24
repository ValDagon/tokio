import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EndpointError, db, resetDb, sql, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import rpcEndpoint from '../../src/endpoints/rpc';
import fastStateEndpoint from '../../src/endpoints/getFastState';
import { createAccount, createLiability, createTransaction, getAccount, listAccounts, listCategories, listTransactions } from '../../src/lib/dal/finances';
import { setRates } from '../../src/lib/dal/fx';
import { financeTools } from '../../src/lib/agent/tools/finances';
import { ensureUser, getUser } from '../../src/lib/dal/users';
import { setConfigOverrides } from '../../src/lib/config';
import { getAgentState, saveThread } from '../../src/lib/dal/agentState';
import { addItem, buildSkillSpec } from '../../src/lib/evolution';
import { createNote, getNote } from '../../src/lib/dal/notes';
import { appendReflection } from '../../src/lib/diary';
import { getOverlay } from '../../src/lib/overlay';
import { saveUserPrefs, captureSettingsState, buildPresetPayloadFromState } from '../../src/lib/prefs';
import { createTask, ensureSystemCategories } from '../../src/lib/dal/tasks';

import type { ToolContext, ToolOutcome } from '../../src/lib/agent/registry';
import type { LiabilityQueue } from '../../src/lib/types';

const TEST_USER = 777000111;
const mockCtx = {
  initData: {
    user: { id: TEST_USER },
  },
};

describe('Standalone Serverless Endpoints (rpc & fastState)', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    setConfigOverrides({ masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('создаёт задачу и событие через POST /api/tasks и возвращает их через GET', async () => {
    const taskRes = await rpcEndpoint(
      {
        path: '/api/tasks',
        method: 'POST',
        body: {
          title: 'Купить молоко',
          item_type: 'task',
        },
      },
      mockCtx,
    );
    expect(taskRes.title).toBe('Купить молоко');
    expect(taskRes.item_type).toBe('task');
    expect(taskRes.status).toBe('todo');

    const eventRes = await rpcEndpoint(
      {
        path: '/api/tasks',
        method: 'POST',
        body: {
          title: 'Воскресное служение',
          item_type: 'event',
          due_at: '2026-11-08T10:00:00.000Z',
          recurrence: JSON.stringify({ freq: 'weekly' }),
        },
      },
      mockCtx,
    );
    expect(eventRes.title).toBe('Воскресное служение');
    expect(eventRes.item_type).toBe('event');

    const listRes = await rpcEndpoint(
      {
        path: '/api/tasks',
        method: 'GET',
      },
      mockCtx,
    );
    expect(Array.isArray(listRes)).toBe(true);
    expect(listRes.length).toBe(2);

    const eventItem = listRes.find((item: any) => item.id === eventRes.id);
    expect(eventItem).toBeDefined();
    expect(eventItem.item_type).toBe('event');

    const onlyEvents = await rpcEndpoint(
      {
        path: '/api/tasks?item_type=event',
        method: 'GET',
      },
      mockCtx,
    );
    expect(onlyEvents.length).toBe(1);
    expect(onlyEvents[0].title).toBe('Воскресное служение');
  });

  it('завершает повторяющееся событие через PATCH /api/tasks/:id', async () => {
    const event = await rpcEndpoint(
      {
        path: '/api/tasks',
        method: 'POST',
        body: {
          title: 'Еженедельный разбор',
          item_type: 'event',
          due_at: '2026-11-01T18:00:00.000Z',
          recurrence: JSON.stringify({ freq: 'weekly' }),
        },
      },
      mockCtx,
    );

    const patchRes = await rpcEndpoint(
      {
        path: `/api/tasks/${event.id}`,
        method: 'PATCH',
        body: { status: 'done' },
      },
      mockCtx,
    );

    expect(patchRes.status).toBe('done');
    expect(patchRes.next_task_id).toBeDefined();
    expect(patchRes.next_task_id).not.toBeNull();
  });

  it('удаляет задачу через DELETE /api/tasks/:id и помещает в корзину', async () => {
    const task = await rpcEndpoint(
      {
        path: '/api/tasks',
        method: 'POST',
        body: { title: 'Удаляемая задача' },
      },
      mockCtx,
    );

    const delRes = await rpcEndpoint(
      {
        path: `/api/tasks/${task.id}`,
        method: 'DELETE',
      },
      mockCtx,
    );
    expect(delRes.status).toBe('deleted');

    const trash = await rpcEndpoint(
      {
        path: '/api/trash',
        method: 'GET',
      },
      mockCtx,
    );
    expect(trash.tasks.some((t: any) => t.id === task.id)).toBe(true);
  });

  it('создаёт и возвращает категории через GET/POST /api/categories', async () => {
    const createdCat = await rpcEndpoint(
      {
        path: '/api/categories',
        method: 'POST',
        body: { name: 'Спецпроект', color: '#ff5500' },
      },
      mockCtx,
    );
    expect(createdCat.name).toBe('Спецпроект');
    expect(createdCat.color).toBe('#ff5500');

    const cats = await rpcEndpoint(
      {
        path: '/api/categories',
        method: 'GET',
      },
      mockCtx,
    );
    expect(Array.isArray(cats)).toBe(true);
    expect(cats.some((c: any) => c.name === 'Спецпроект')).toBe(true);
  });

  it('возвращает дашборд через GET /api/dashboard', async () => {
    const dashboard = await rpcEndpoint(
      {
        path: '/api/dashboard',
        method: 'GET',
      },
      mockCtx,
    );
    expect(dashboard.total_users).toBe(1);
    expect(dashboard.users[0].telegram_id).toBe(TEST_USER);
  });

  it('возвращает состояние счетов через getFastState', async () => {
    await createAccount(TEST_USER, {
      name: 'Основная карта',
      currency: 'EUR',
      initialBalanceCents: 150000,
      envelope: 'spendable',
    });

    const state = await fastStateEndpoint({ userId: TEST_USER }, mockCtx);
    expect(state.queued).toBe(0);
    expect(state.totalEur).toBe(1500);
    expect(state.balances.length).toBe(1);
    expect(state.balances[0].balance).toBe(1500);
  });

  it('управляет счетами: POST и PATCH /api/finances/accounts', async () => {
    const newAccount = await rpcEndpoint(
      {
        path: '/api/finances/accounts',
        method: 'POST',
        body: {
          name: 'AlphaBank',
          currency: 'USD',
          current_balance: 250.5,
          envelope: 'spendable',
        },
      },
      mockCtx,
    );
    expect(newAccount.name).toBe('AlphaBank');
    expect(newAccount.currency).toBe('USD');
    expect(newAccount.current_balance).toBe(250.5);

    const patchedAccount = await rpcEndpoint(
      {
        path: `/api/finances/accounts/${newAccount.id}`,
        method: 'PATCH',
        body: {
          name: 'AlphaBank USD',
          current_balance: 300,
          envelope: 'reserved',
        },
      },
      mockCtx,
    );
    expect(patchedAccount.name).toBe('AlphaBank USD');
    expect(patchedAccount.current_balance).toBe(300);
    expect(patchedAccount.envelope).toBe('reserved');
  });

  it('отдаёт balance_eur именно в евро, а не в валюте счёта (POST и PATCH)', async () => {
    // Один курс: 1.25 USD за 1 EUR. 250.50 USD = 200.40 EUR, 300 USD = 240 EUR.
    await db.run(
      sql`INSERT INTO fx_rates (date, base, rates) VALUES ('2026-11-13', 'EUR', '{"USD":1.25}')`,
    );

    const created = await rpcEndpoint(
      {
        path: '/api/finances/accounts',
        method: 'POST',
        body: { name: 'CryptoX', currency: 'USD', current_balance: 250.5, envelope: 'spendable' },
      },
      mockCtx,
    );
    expect(created.current_balance).toBe(250.5);
    expect(created.balance_eur).toBe(200.4);

    const patched = await rpcEndpoint(
      {
        path: `/api/finances/accounts/${created.id}`,
        method: 'PATCH',
        body: { current_balance: 300 },
      },
      mockCtx,
    );
    expect(patched.current_balance).toBe(300);
    expect(patched.balance_eur).toBe(240);

    const listed = (await rpcEndpoint({ path: '/api/finances/accounts' }, mockCtx)) as Array<{
      id: string;
      balance_eur: number;
    }>;
    expect(listed.find((a) => a.id === created.id)?.balance_eur).toBe(240);
  });

  it('поддерживает undo и reset финансов', async () => {
    const acc = await createAccount(TEST_USER, {
      name: 'Депозит',
      currency: 'EUR',
      initialBalanceCents: 10000,
      envelope: 'spendable',
    });

    const undoEmpty = await rpcEndpoint(
      {
        path: '/api/finances/undo',
        method: 'POST',
      },
      mockCtx,
    );
    expect(undoEmpty.status).toBe('empty');

    const resetRes = await rpcEndpoint(
      {
        path: '/api/finances/reset',
        method: 'POST',
      },
      mockCtx,
    );
    expect(resetRes.status).toBe('reset');
  });

  // §9: сырое деление на 100 печатало `10.5`; текст обязан идти через formatCents.
  it('undo печатает сумму денежным форматом, а не сырым делением', async () => {
    const acc = await createAccount(TEST_USER, {
      name: 'Ровно',
      currency: 'EUR',
      initialBalanceCents: 10000,
      envelope: 'spendable',
    });
    await createTransaction(TEST_USER, {
      kind: 'expense',
      amountCents: 1050,
      accountId: acc.id,
      description: 'Кофе',
    });

    const undone = await rpcEndpoint({ path: '/api/finances/undo', method: 'POST' }, mockCtx);
    expect(undone.status).toBe('ok');
    expect(undone.message).toContain('10,50 EUR');
    expect(undone.message).not.toContain('10.5 ');
  });

  it('управляет обязательствами: POST pay и PATCH liability', async () => {
    const liability = await createLiability(TEST_USER, {
      name: 'Кредит на авто',
      currency: 'EUR',
      amountCents: 50000,
      monthlyPaymentCents: 5000,
      paymentDay: 15,
      queue: 'queue_1',
    });

    const payRes = await rpcEndpoint(
      {
        path: `/api/finances/liabilities/${liability.id}/pay`,
        method: 'POST',
        body: { amount: 50 },
      },
      mockCtx,
    );
    expect(payRes.ok).toBe(true);

    const patchRes = await rpcEndpoint(
      {
        path: `/api/finances/liabilities/${liability.id}`,
        method: 'PATCH',
        body: {
          notes: 'Платим без просрочек',
          monthly_payment: 60,
          payment_day: 20,
        },
      },
      mockCtx,
    );
    expect(patchRes.notes).toBe('Платим без просрочек');
    expect(patchRes.monthly_payment).toBe(60);
    expect(patchRes.payment_day).toBe(20);
  });

  it('выключает обязательство без потери истории и удаляет по DELETE', async () => {
    const liability = await createLiability(TEST_USER, {
      name: 'ЛитРес',
      currency: 'EUR',
      amountCents: 400,
      monthlyPaymentCents: 400,
      paymentDay: 13,
      queue: 'subscription' as unknown as LiabilityQueue,
    });

    const off = await rpcEndpoint(
      {
        path: `/api/finances/liabilities/${liability.id}`,
        method: 'PATCH',
        body: { is_active: false },
      },
      mockCtx,
    );
    expect(off.is_active).toBe(false);

    const listed = await rpcEndpoint({ path: '/api/finances/liabilities', method: 'GET' }, mockCtx);
    expect(listed.map((item: { id: string }) => item.id)).not.toContain(String(liability.id));

    const removed = await rpcEndpoint(
      { path: `/api/finances/liabilities/${liability.id}`, method: 'DELETE' },
      mockCtx,
    );
    expect(removed.success).toBe(true);
    expect(removed.id).toBe(String(liability.id));
  });

  it('управляет заметками: POST, GET, PATCH (raw_text и канонические колонки), DELETE /api/notes', async () => {
    const createdNote = await rpcEndpoint(
      {
        path: '/api/notes',
        method: 'POST',
        body: { text: 'Моя первая мысль', column: 'ideas' },
      },
      mockCtx,
    );
    expect(createdNote.raw_text).toBe('Моя первая мысль');
    expect(createdNote.column).toBe('idea');

    const patchedClean = await rpcEndpoint(
      {
        path: `/api/notes/${createdNote.id}`,
        method: 'PATCH',
        body: { clean_text: 'Отредактированная мысль', column: 'self' },
      },
      mockCtx,
    );
    expect(patchedClean.clean_text).toBe('Отредактированная мысль');
    expect(patchedClean.raw_text).toBe('Моя первая мысль');
    expect(patchedClean.column).toBe('note');

    // Правка только raw_text не затирает clean_text и column.
    const patchedRaw = await rpcEndpoint(
      {
        path: `/api/notes/${createdNote.id}`,
        method: 'PATCH',
        body: { raw_text: 'Обновлённый исходник' },
      },
      mockCtx,
    );
    expect(patchedRaw.raw_text).toBe('Обновлённый исходник');
    expect(patchedRaw.clean_text).toBe('Отредактированная мысль');
    expect(patchedRaw.column).toBe('note');

    // Недеструктивное чтение legacy-строки 'inbox' как 'raw' без мутации SQLite.
    const legacyNote = await createNote(TEST_USER, 'Легаси инбокс', {
      column: 'inbox' as unknown as 'raw',
    });
    const rawList = (await rpcEndpoint(
      { path: '/api/notes?column=raw', method: 'GET' },
      mockCtx,
    )) as Array<{ id: string; column: string }>;
    expect(rawList.some((n) => n.id === String(legacyNote.id) && n.column === 'raw')).toBe(true);
    expect((await getNote(TEST_USER, legacyNote.id))?.column).toBe('inbox');

    const delRes = await rpcEndpoint(
      {
        path: `/api/notes/${createdNote.id}`,
        method: 'DELETE',
      },
      mockCtx,
    );
    expect(delRes.status).toBe('deleted');
  });

  it('управляет медикаментами: GET, POST, PATCH, take, skip, DELETE /api/medications', async () => {
    const med = await rpcEndpoint(
      {
        path: '/api/medications',
        method: 'POST',
        body: {
          name: 'Витамин D3',
          dosage: '2000 ME',
          times: ['09:00', '18:00'],
          frequency: 'daily',
          instructions: 'Во время еды',
        },
      },
      mockCtx,
    );
    expect(med.name).toBe('Витамин D3');
    expect(med.times).toEqual(['09:00', '18:00']);

    const listMeds = await rpcEndpoint(
      {
        path: '/api/medications',
        method: 'GET',
      },
      mockCtx,
    );
    expect(listMeds.length).toBe(1);
    expect(listMeds[0].today_logs.length).toBe(2);

    const takeRes = await rpcEndpoint(
      {
        path: `/api/medications/${med.id}/take?scheduled_time=09:00`,
        method: 'POST',
      },
      mockCtx,
    );
    expect(takeRes.status).toBe('taken');

    const skipRes = await rpcEndpoint(
      {
        path: `/api/medications/${med.id}/skip`,
        method: 'POST',
        body: { scheduled_time: '18:00' },
      },
      mockCtx,
    );
    expect(skipRes.status).toBe('skipped');

    const patchedMed = await rpcEndpoint(
      {
        path: `/api/medications/${med.id}`,
        method: 'PATCH',
        body: { dosage: '4000 ME' },
      },
      mockCtx,
    );
    expect(patchedMed.dosage).toBe('4000 ME');

    const delMed = await rpcEndpoint(
      {
        path: `/api/medications/${med.id}`,
        method: 'DELETE',
      },
      mockCtx,
    );
    expect(delMed.status).toBe('deleted');
  });

  it('полностью поддерживает корзину: restore, purge, empty', async () => {
    const note = await rpcEndpoint(
      {
        path: '/api/notes',
        method: 'POST',
        body: { text: 'Заметка для корзины' },
      },
      mockCtx,
    );
    await rpcEndpoint({ path: `/api/notes/${note.id}`, method: 'DELETE' }, mockCtx);

    const trashBefore = await rpcEndpoint({ path: '/api/trash', method: 'GET' }, mockCtx);
    expect(trashBefore.notes.some((n: any) => n.id === note.id)).toBe(true);

    // Восстановление
    const restoreRes = await rpcEndpoint(
      {
        path: '/api/trash/restore',
        method: 'POST',
        body: { item_type: 'note', item_id: note.id },
      },
      mockCtx,
    );
    expect(restoreRes.status).toBe('ok');

    // Снова удаляем и очищаем полностью
    await rpcEndpoint({ path: `/api/notes/${note.id}`, method: 'DELETE' }, mockCtx);
    const emptyRes = await rpcEndpoint(
      {
        path: '/api/trash/empty',
        method: 'POST',
      },
      mockCtx,
    );
    expect(emptyRes.status).toBe('ok');
    expect(emptyRes.notes_purged).toBeGreaterThan(0);

    const trashAfter = await rpcEndpoint({ path: '/api/trash', method: 'GET' }, mockCtx);
    expect(trashAfter.notes.length).toBe(0);
  });

  it('поддерживает главы документации: GET /api/docs/chapters и /:slug', async () => {
    const chapters = await rpcEndpoint(
      {
        path: '/api/docs/chapters',
        method: 'GET',
      },
      mockCtx,
    );
    expect(Array.isArray(chapters)).toBe(true);
    expect(chapters.length).toBeGreaterThan(0);

    const firstSlug = chapters[0].slug;
    const detail = await rpcEndpoint(
      {
        path: `/api/docs/chapters/${firstSlug}`,
        method: 'GET',
      },
      mockCtx,
    );
    expect(detail.slug).toBe(firstSlug);
    expect(detail.content).toBeDefined();
    expect(Array.isArray(detail.sections)).toBe(true);
  });

  it('поддерживает BYOK, Access и Backup', async () => {
    // Access
    const access = await rpcEndpoint({ path: '/api/system/access', method: 'GET' }, mockCtx);
    expect(access.role).toBe('admin');
    expect(access.has_byok_key).toBe(false);

    // BYOK save & verify
    const saveByok = await rpcEndpoint(
      {
        path: '/api/system/byok',
        method: 'POST',
        body: { api_key: 'AIzaSyFakeTestKeyForGeminiApi123456789' },
      },
      mockCtx,
    );
    expect(saveByok.status).toBe('ok');

    const byokStatus = await rpcEndpoint({ path: '/api/system/byok', method: 'GET' }, mockCtx);
    expect(byokStatus.has_key).toBe(true);
    expect(byokStatus.status).toBe('configured');
    expect(byokStatus.csprng_available).toBe(true);

    // BYOK clear
    const clearByok = await rpcEndpoint({ path: '/api/system/byok', method: 'DELETE' }, mockCtx);
    expect(clearByok.status).toBe('ok');

    // Backup export & restore
    const backupJson = await rpcEndpoint({ path: '/api/system/backup/json', method: 'GET' }, mockCtx);
    expect(backupJson.format).toBe('tokio-backup');
    expect(backupJson.userId).toBe(TEST_USER);

    const restoreRes = await rpcEndpoint(
      {
        path: '/api/system/backup/restore',
        method: 'POST',
        body: { data: backupJson, mode: 'merge' },
      },
      mockCtx,
    );
    expect(restoreRes.status).toBe('ok');
  });

  it('BYOK: без CSPRNG сохранение ключа отклоняется, старый ключ не меняется', async () => {
    const firstKey = 'AIzaSyFirstTestKeyForGeminiApi123456';
    await rpcEndpoint(
      {
        path: '/api/system/byok',
        method: 'POST',
        body: { api_key: firstKey },
      },
      mockCtx,
    );
    const before = (await getUser(TEST_USER))?.byok;
    expect(before?.ciphertext).toBeTruthy();

    let caught: unknown = null;
    vi.stubGlobal('crypto', undefined);
    try {
      await rpcEndpoint(
        {
          path: '/api/system/byok',
          method: 'POST',
          body: { api_key: 'AIzaSySecondTestKeyForGeminiApi987654' },
        },
        mockCtx,
      );
    } catch (error) {
      caught = error;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(caught).toBeInstanceOf(EndpointError);
    const failure = caught as EndpointError;
    expect(failure.message).toContain(
      'платформа не предоставляет криптографический генератор случайных чисел',
    );
    expect(failure.parameters.code).toBe('CSPRNG_UNAVAILABLE');
    expect(failure.parameters.status).toBe(503);

    const after = (await getUser(TEST_USER))?.byok;
    expect(after).toEqual(before);
  });

  it('BYOK: запоминает провайдера ключа и отвергает неизвестного', async () => {
    const saved = await rpcEndpoint(
      {
        path: '/api/system/byok',
        method: 'POST',
        body: { api_key: 'sk-ant-test-key-1234567890', provider: 'anthropic' },
      },
      mockCtx,
    );
    expect(saved.status).toBe('ok');

    const status = await rpcEndpoint({ path: '/api/system/byok', method: 'GET' }, mockCtx);
    expect(status.provider).toBe('anthropic');
    expect((await getUser(TEST_USER))?.modelProvider).toBe('anthropic');

    let caught: unknown = null;
    try {
      await rpcEndpoint(
        {
          path: '/api/system/byok',
          method: 'POST',
          body: { api_key: 'sk-unknown-provider-key', provider: 'junk' },
        },
        mockCtx,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EndpointError);
    expect((caught as EndpointError).parameters.code).toBe('BAD_REQUEST');
    expect((await getUser(TEST_USER))?.modelProvider).toBe('anthropic');

    await rpcEndpoint({ path: '/api/system/byok', method: 'DELETE' }, mockCtx);
    expect((await getUser(TEST_USER))?.modelProvider).toBeNull();
    const cleared = await rpcEndpoint({ path: '/api/system/byok', method: 'GET' }, mockCtx);
    expect(cleared.provider).toBe('gemini');
    expect(cleared.has_key).toBe(false);
  });

  it('устраняет IDOR: context user строго побеждает client-supplied input.userId', async () => {
    const ATTACKER_USER = 999111;
    const task = await rpcEndpoint(
      {
        path: '/api/tasks',
        method: 'POST',
        userId: ATTACKER_USER, // клиент пытается притвориться другим юзером
        body: { title: 'Приватная задача' },
      },
      mockCtx, // но в context авторизован TEST_USER
    );

    // Задача создана для TEST_USER, а не для ATTACKER_USER
    const listAttacker = await rpcEndpoint(
      {
        path: '/api/tasks',
        method: 'GET',
        userId: ATTACKER_USER,
      },
      undefined, // прямой вызов без контекста (как mock attacker)
    );
    expect(listAttacker.some((t: any) => t.id === task.id)).toBe(false);

    const listReal = await rpcEndpoint(
      {
        path: '/api/tasks',
        method: 'GET',
      },
      mockCtx,
    );
    expect(listReal.some((t: any) => t.id === task.id)).toBe(true);
  });

  it('отклоняет доступ для не-whitelist пользователей в Personal Bot режиме (403 Forbidden)', async () => {
    setConfigOverrides({
      masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      adminIds: [100001],
      betaWhitelist: [],
    });

    const STRANGER_USER = 555666777;
    const strangerCtx = {
      initData: {
        user: { id: STRANGER_USER },
      },
    };

    // 1. Попытка вызова RPC от незнакомца отклоняется с 403 Forbidden
    await expect(
      rpcEndpoint({ path: '/api/tasks', method: 'GET' }, strangerCtx),
    ).rejects.toThrow('Forbidden: Access denied (not in whitelist)');

    // 2. Пользователь НЕ создан в таблице users
    const userInDb = await getUser(STRANGER_USER);
    expect(userInDb).toBeNull();

    // 3. Если админ добавил пользователя в users (инвайт/одобрение), RPC начинает работать
    await ensureUser(STRANGER_USER, 'Приглашённый гость');
    const tasksRes = await rpcEndpoint({ path: '/api/tasks', method: 'GET' }, strangerCtx);
    expect(Array.isArray(tasksRes)).toBe(true);

    // 4. Админ 100001 также имеет доступ
    const adminCtx = { initData: { user: { id: 100001 } } };
    const adminRes = await rpcEndpoint({ path: '/api/tasks', method: 'GET' }, adminCtx);
    expect(Array.isArray(adminRes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RPC: запись операций — POST/DELETE /api/finances/transactions
// (design-exchange §9, тикет G). Ручка — тонкий адаптер над DAL, поэтому
// результат обязан совпадать со строками и балансами тула агента.
// ---------------------------------------------------------------------------

const TOOL_NOW = new Date('2026-03-15T10:00:00Z');
const OTHER_USER = 777000222;

interface RpcTransactionItem {
  id: string;
  occurred_at: string;
  kind: string;
  amount: number;
  currency: string;
  amount_eur: number;
  fx_rate: number;
  account_name: string;
  to_account_name: string | null;
  category_name: string | null;
  description: string | null;
}

interface TransactionWriteResponse {
  group_id: string | null;
  transactions: RpcTransactionItem[];
}

async function runFinanceTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const tool = financeTools.find((item) => item.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  const ctx: ToolContext = {
    userId: TEST_USER,
    timezone: 'Europe/Belgrade',
    baseCurrency: 'EUR',
    now: TOOL_NOW,
  };
  const result = await tool.run(args, ctx);
  return typeof result === 'string' ? { ok: true, content: result } : result;
}

describe('RPC: запись операций (/api/finances/transactions)', () => {
  beforeEach(async () => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    // Сбросить утечку переопределений предыдущих тестов (adminIds/whitelist).
    setConfigOverrides(null);
    setConfigOverrides({ masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
    await setRates('2026-03-15', { USD: 1.08 });
  });

  async function seed(userId = TEST_USER) {
    const main = await createAccount(userId, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 100_000,
      envelope: 'spendable',
    });
    const cash = await createAccount(userId, { name: 'Cash', currency: 'EUR' });
    const usd = await createAccount(userId, { name: 'Usd', currency: 'USD' });
    return { main, cash, usd };
  }

  /** Свежий мир для второй половины теста: те же счета, пустая история. */
  async function reseed() {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    await setRates('2026-03-15', { USD: 1.08 });
    return seed();
  }

  /** Строки и балансы без id/дат, чтобы сравнивать RPC с тулом. */
  async function snapshot(userId = TEST_USER) {
    const [rows, accounts, categories] = await Promise.all([
      listTransactions(userId),
      listAccounts(userId, { includeInactive: true }),
      listCategories(userId),
    ]);
    const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

    return {
      rows: rows.map((row) => ({
        kind: row.kind,
        account: accountNames.get(row.accountId) ?? '',
        to_account: row.toAccountId === null ? null : accountNames.get(row.toAccountId) ?? null,
        in_group: row.transferGroupId !== null,
        amount_cents: row.amountCents,
        currency: row.currency,
        amount_eur_cents: row.amountEurCents,
        category: row.categoryId === null ? null : categoryNames.get(row.categoryId) ?? null,
        description: row.description,
      })),
      balances: accounts
        .map((account) => `${account.name} ${account.currency}: ${account.currentBalanceCents}`)
        .sort(),
    };
  }

  async function balanceOf(accountId: number): Promise<number> {
    const account = await getAccount(TEST_USER, accountId);
    if (!account) throw new Error('balanceOf: account not found');
    return account.currentBalanceCents;
  }

  it('расход через RPC даёт ту же строку и баланс, что и add_expense', async () => {
    await seed();
    const viaRpc = (await rpcEndpoint(
      {
        path: '/api/finances/transactions',
        method: 'POST',
        body: {
          kind: 'expense',
          amount: 12.5,
          account_name: 'Main',
          category_name: 'Еда',
          description: 'Обед',
        },
      },
      mockCtx,
    )) as TransactionWriteResponse;

    expect(viaRpc.group_id).toBeNull();
    expect(viaRpc.transactions).toHaveLength(1);
    expect(viaRpc.transactions[0]).toMatchObject({
      kind: 'expense',
      amount: 12.5,
      currency: 'EUR',
      amount_eur: 12.5,
      account_name: 'Main',
      to_account_name: null,
      category_name: 'Еда',
      description: 'Обед',
    });
    const rpcWorld = await snapshot();

    await reseed();
    const toolResult = await runFinanceTool('add_expense', {
      amount: 12.5,
      account_name: 'Main',
      category_name: 'Еда',
      description: 'Обед',
    });
    expect(toolResult.ok).toBe(true);
    expect(rpcWorld).toEqual(await snapshot());
    // в ответе RPC те же поля, что отдаёт GET /api/finances/transactions
    const listed = (await rpcEndpoint({ path: '/api/finances/transactions' }, mockCtx)) as RpcTransactionItem[];
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual(Object.keys(viaRpc.transactions[0]).sort());
  });

  it('доход через RPC даёт ту же строку и баланс, что и add_income', async () => {
    await seed();
    const viaRpc = (await rpcEndpoint(
      {
        path: '/api/finances/transactions',
        method: 'POST',
        body: { kind: 'income', amount: '1 000,00', account_name: 'Main', category_name: 'Зарплата' },
      },
      mockCtx,
    )) as TransactionWriteResponse;

    expect(viaRpc.group_id).toBeNull();
    expect(viaRpc.transactions[0]).toMatchObject({
      kind: 'income',
      amount: 1000,
      currency: 'EUR',
      account_name: 'Main',
      category_name: 'Зарплата',
    });
    const rpcWorld = await snapshot();

    await reseed();
    const toolResult = await runFinanceTool('add_income', {
      amount: 1000,
      account_name: 'Main',
      category_name: 'Зарплата',
    });
    expect(toolResult.ok).toBe(true);
    expect(rpcWorld).toEqual(await snapshot());
  });

  it('перевод через RPC даёт ту же строку и балансы, что и add_transfer', async () => {
    await seed();
    const viaRpc = (await rpcEndpoint(
      {
        path: '/api/finances/transactions',
        method: 'POST',
        body: { kind: 'transfer', amount: 100, account_name: 'Main', to_account_name: 'Cash' },
      },
      mockCtx,
    )) as TransactionWriteResponse;

    expect(viaRpc.transactions).toHaveLength(1);
    expect(viaRpc.group_id).toBeTruthy();
    expect(viaRpc.transactions[0]).toMatchObject({
      kind: 'transfer',
      amount: 100,
      currency: 'EUR',
      account_name: 'Main',
      to_account_name: 'Cash',
    });
    const rpcWorld = await snapshot();

    await reseed();
    const toolResult = await runFinanceTool('add_transfer', {
      amount: 100,
      from_account: 'Main',
      to_account: 'Cash',
    });
    expect(toolResult.ok).toBe(true);
    expect(rpcWorld).toEqual(await snapshot());
  });

  it('обмен через RPC даёт две ноги и балансы, как add_exchange', async () => {
    await seed();
    const viaRpc = (await rpcEndpoint(
      {
        path: '/api/finances/transactions',
        method: 'POST',
        body: {
          kind: 'exchange',
          account_name: 'Main',
          to_account_name: 'Usd',
          exchange: {
            from_amount: 100,
            from_currency: 'EUR',
            to_amount: 108,
            to_currency: 'USD',
          },
        },
      },
      mockCtx,
    )) as TransactionWriteResponse;

    expect(viaRpc.group_id).toBeTruthy();
    expect(viaRpc.transactions).toHaveLength(2);
    expect(viaRpc.transactions[0]).toMatchObject({
      kind: 'exchange',
      amount: -100,
      currency: 'EUR',
      account_name: 'Main',
      to_account_name: 'Usd',
    });
    expect(viaRpc.transactions[1]).toMatchObject({
      kind: 'exchange',
      amount: 108,
      currency: 'USD',
      account_name: 'Usd',
      to_account_name: 'Main',
    });
    const rpcWorld = await snapshot();

    await reseed();
    const toolResult = await runFinanceTool('add_exchange', {
      from_amount: 100,
      from_account: 'Main',
      from_currency: 'EUR',
      to_amount: 108,
      to_account: 'Usd',
      to_currency: 'USD',
    });
    expect(toolResult.ok).toBe(true);
    expect(rpcWorld).toEqual(await snapshot());
  });

  it('DELETE по любой ноге обмена откатывает всю группу', async () => {
    const { main, usd } = await seed();
    const body = {
      kind: 'exchange',
      account_name: 'Main',
      to_account_name: 'Usd',
      exchange: { from_amount: 100, from_currency: 'EUR', to_amount: 108, to_currency: 'USD' },
    };

    // Входящая нога (id больше): группа уходит целиком.
    const first = (await rpcEndpoint(
      { path: '/api/finances/transactions', method: 'POST', body },
      mockCtx,
    )) as TransactionWriteResponse;
    const inbound = first.transactions[1].id;
    const deleted = await rpcEndpoint(
      { path: `/api/finances/transactions/${inbound}`, method: 'DELETE' },
      mockCtx,
    );
    expect(deleted).toEqual({ status: 'deleted', id: inbound });
    expect(await listTransactions(TEST_USER)).toHaveLength(0);
    expect(await balanceOf(main.id)).toBe(100_000);
    expect(await balanceOf(usd.id)).toBe(0);

    // Исходящая нога: тот же результат.
    const second = (await rpcEndpoint(
      { path: '/api/finances/transactions', method: 'POST', body },
      mockCtx,
    )) as TransactionWriteResponse;
    const outbound = second.transactions[0].id;
    await rpcEndpoint({ path: `/api/finances/transactions/${outbound}`, method: 'DELETE' }, mockCtx);
    expect(await listTransactions(TEST_USER)).toHaveLength(0);
    expect(await balanceOf(main.id)).toBe(100_000);
    expect(await balanceOf(usd.id)).toBe(0);
  });

  it('чужая или несуществующая операция — 404 и балансы не двигаются', async () => {
    const { main, usd } = await seed();
    await createAccount(OTHER_USER, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 10_000,
    });
    const foreign = await createTransaction(OTHER_USER, {
      kind: 'expense',
      amountCents: 500,
      accountName: 'Main',
      categoryName: 'Еда',
    });
    const before = await snapshot();

    await expect(
      rpcEndpoint({ path: `/api/finances/transactions/${foreign.id}`, method: 'DELETE' }, mockCtx),
    ).rejects.toMatchObject({ parameters: { code: 'NOT_FOUND' } });
    await expect(
      rpcEndpoint({ path: '/api/finances/transactions/999999', method: 'DELETE' }, mockCtx),
    ).rejects.toMatchObject({ parameters: { code: 'NOT_FOUND' } });

    expect(await snapshot()).toEqual(before);
    expect(await balanceOf(main.id)).toBe(100_000);
    expect(await balanceOf(usd.id)).toBe(0);
    expect(await listTransactions(OTHER_USER)).toHaveLength(1);
  });

  it('ошибки валидации — BAD_REQUEST и ни одной строки', async () => {
    await seed();

    const invalid = [
      { kind: 'bogus', amount: 10, account_name: 'Main' },
      { kind: 'expense', amount: -5, account_name: 'Main' },
      { kind: 'expense', amount: 10, account_name: 'Нет такого счёта' },
      { kind: 'transfer', amount: 10, account_name: 'Main' },
      { kind: 'expense', amount: 10 },
      {
        kind: 'exchange',
        account_name: 'Main',
        to_account_name: 'Usd',
        exchange: { from_amount: 100, from_currency: 'EUR' },
      },
    ];

    for (const body of invalid) {
      await expect(
        rpcEndpoint({ path: '/api/finances/transactions', method: 'POST', body }, mockCtx),
      ).rejects.toMatchObject({ parameters: { code: 'BAD_REQUEST' } });
    }

    expect(await listTransactions(TEST_USER)).toHaveLength(0);
    expect(await balanceOf((await listAccounts(TEST_USER)).find((a) => a.name === 'Main')!.id)).toBe(
      100_000,
    );
  });
});

// ---------------------------------------------------------------------------
// RPC: хвост роутера — неизвестный путь, неподдерживаемый метод, админский
// PATCH (тикет RPC404). Раньше хвост отвечал `{ ok: true, path }` на что
// угодно: опечатка в Mini App выглядела успешно выполненной записью.
// ---------------------------------------------------------------------------

describe('RPC: неизвестные маршруты вместо фиктивного успеха', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    setConfigOverrides({ masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
  });

  async function catchEndpointError(run: Promise<unknown>): Promise<EndpointError> {
    try {
      await run;
    } catch (err) {
      return err as EndpointError;
    }
    throw new Error('ожидалась EndpointError, но эндпоинт ответил успехом');
  }

  it('опечатка в пути — NOT_FOUND с маршрутом в сообщении', async () => {
    for (const method of ['GET', 'POST', 'PATCH'] as const) {
      const error = await catchEndpointError(
        rpcEndpoint({ path: '/api/taskz', method, body: { title: 'Купить молоко' } }, mockCtx),
      );
      expect(error).toBeInstanceOf(EndpointError);
      expect(error.parameters).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(error.message).toContain('/api/taskz');
      expect(error.message).toContain(method);
    }

    // Опечатка в известном префиксе — тоже 404, а не «успех».
    const nested = await catchEndpointError(
      rpcEndpoint({ path: '/api/finances/transactions/extra', method: 'POST' }, mockCtx),
    );
    expect(nested.parameters).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(nested.message).toContain('/api/finances/transactions/extra');
  });

  it('известный путь с неподдерживаемым методом — 405 METHOD_NOT_ALLOWED', async () => {
    const collection = await catchEndpointError(
      rpcEndpoint({ path: '/api/tasks', method: 'DELETE' }, mockCtx),
    );
    expect(collection.parameters).toMatchObject({ code: 'METHOD_NOT_ALLOWED', status: 405 });
    expect(collection.message).toContain('/api/tasks');

    // Ручка-регексп: /api/tasks/:id понимает PATCH/PUT/DELETE, но не GET.
    const item = await catchEndpointError(
      rpcEndpoint({ path: '/api/tasks/42', method: 'GET' }, mockCtx),
    );
    expect(item.parameters).toMatchObject({ code: 'METHOD_NOT_ALLOWED', status: 405 });
    expect(item.message).toContain('/api/tasks/42');

    // Literal-ручка без метода в ветке: /api/finances/budgets знает только POST.
    const budgets = await catchEndpointError(
      rpcEndpoint({ path: '/api/finances/budgets', method: 'GET' }, mockCtx),
    );
    expect(budgets.parameters).toMatchObject({ code: 'METHOD_NOT_ALLOWED', status: 405 });
  });

  it('админский PATCH не притворяется успехом: NOT_IMPLEMENTED и профиль не меняется', async () => {
    await ensureUser(TEST_USER, 'Админ');
    const before = await getUser(TEST_USER);

    const error = await catchEndpointError(
      rpcEndpoint(
        {
          path: `/api/admin/users/${TEST_USER}`,
          method: 'PATCH',
          body: { is_approved: false, daily_msg_limit: 5, role: 'user' },
        },
        mockCtx,
      ),
    );
    expect(error.parameters).toMatchObject({ code: 'NOT_IMPLEMENTED', status: 501 });
    expect(error.message).toContain(`/api/admin/users/${TEST_USER}`);

    expect(await getUser(TEST_USER)).toEqual(before);
  });

  it('POST /api/admin/invites: код прежнего формата и без повторов', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const item = (await rpcEndpoint(
        { path: '/api/admin/invites', method: 'POST', body: { note: 'rng1' } },
        mockCtx,
      )) as { code: string };
      expect(item.code).toMatch(/^[A-Z0-9]{8}$/);
      codes.add(item.code);
    }
    expect(codes.size).toBe(100);
  });

  it('GET /api/user/life-context возвращает реальное досье по данным SQLite', async () => {
    await ensureUser(TEST_USER, 'Тест');
    await createTask(TEST_USER, { title: 'Оплатить аренду квартиры' });
    await createNote(TEST_USER, 'Ключевой принцип фокуса', { column: 'note' });

    const res = (await rpcEndpoint(
      { path: '/api/user/life-context', method: 'GET' },
      mockCtx,
    )) as { context: string };

    expect(res.context).toContain('Оплатить аренду квартиры');
    expect(res.context).toContain('Ключевой принцип фокуса');
  });

  it('GET/PATCH /api/settings и /api/user/settings сохраняют директивы, стиль и summary_time без затирания', async () => {
    await ensureUser(TEST_USER, 'Тест');

    const patch1 = (await rpcEndpoint(
      {
        path: '/api/settings',
        method: 'PATCH',
        body: {
          custom_instructions: '- Отвечай кратко и без воды',
          persona_style: 'strategist',
          summary_time: '08:30',
          model_provider: 'openai',
        },
      },
      mockCtx,
    )) as Record<string, unknown>;
    expect(patch1.custom_instructions).toBe('- Отвечай кратко и без воды');
    expect(patch1.persona_style).toBe('strategist');
    expect(patch1.summary_time).toBe('08:30');
    expect(patch1.model_provider).toBe('openai');

    // Смена только persona_style не затирает custom_instructions!
    const patch2 = (await rpcEndpoint(
      {
        path: '/api/user/settings',
        method: 'PATCH',
        body: { persona_style: 'calm_partner' },
      },
      mockCtx,
    )) as Record<string, unknown>;
    expect(patch2.persona_style).toBe('calm_partner');
    expect(patch2.custom_instructions).toBe('- Отвечай кратко и без воды');

    const getRes = (await rpcEndpoint(
      { path: '/api/user/settings', method: 'GET' },
      mockCtx,
    )) as Record<string, unknown>;
    expect(getRes.custom_instructions).toBe('- Отвечай кратко и без воды');
    expect(getRes.persona_style).toBe('calm_partner');
    expect(getRes.summary_time).toBe('08:30');
    expect(getRes.model_provider).toBe('openai');

    const invalidTime = await catchEndpointError(
      rpcEndpoint(
        { path: '/api/settings', method: 'PATCH', body: { summary_time: '25:99' } },
        mockCtx,
      ),
    );
    expect(invalidTime.parameters).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('GET /api/docs/search ищет по главам документации', async () => {
    const res = (await rpcEndpoint(
      { path: '/api/docs/search?q=finances', method: 'GET' },
      mockCtx,
    )) as { query: string; result: string };
    expect(res.query).toBe('finances');
    expect(res.result.length).toBeGreaterThan(20);
  });

  it('управляет скиллами и бэклогом через /api/skills* и /api/backlog*', async () => {
    const spec = buildSkillSpec({
      key: 'rpc-test-skill',
      version: 1,
      originFailure: null,
      supersedes: null,
      body: '## When to Use\nВсегда.\n\n## Procedure\n1. Сделай.\n\n## Pitfalls\n- Нет.\n\n## Verification\n- Ок.',
    });
    const skillRow = await addItem(TEST_USER, {
      rawInput: 'skill',
      category: 'skill',
      title: 'Тестовый скилл',
      spec,
    });
    const backlogRow = await addItem(TEST_USER, {
      rawInput: 'Починить экспорт',
      category: 'feature',
      title: 'Починить экспорт',
    });

    const skillsRes = (await rpcEndpoint({ path: '/api/skills', method: 'GET' }, mockCtx)) as {
      builtin: Array<{ id: string }>;
      user: Array<{ id: string; key: string; status: string }>;
    };
    expect(skillsRes.builtin.length).toBeGreaterThan(0);
    expect(skillsRes.user.some((s) => s.id === String(skillRow.id) && s.status === 'pending')).toBe(true);

    const activated = (await rpcEndpoint(
      { path: `/api/skills/${skillRow.id}/activate`, method: 'POST' },
      mockCtx,
    )) as { ok: boolean; status: string };
    expect(activated).toEqual({ ok: true, id: String(skillRow.id), status: 'active' });

    const rejected = (await rpcEndpoint(
      { path: `/api/skills/${skillRow.id}/reject`, method: 'POST' },
      mockCtx,
    )) as { ok: boolean; status: string };
    expect(rejected).toEqual({ ok: true, id: String(skillRow.id), status: 'rejected' });

    const backlogRes = (await rpcEndpoint({ path: '/api/backlog', method: 'GET' }, mockCtx)) as {
      items: Array<{ id: string; category: string }>;
    };
    expect(backlogRes.items.some((i) => i.category === 'skill')).toBe(false);
    expect(backlogRes.items.some((i) => i.id === String(backlogRow.id))).toBe(true);

    const resolved = (await rpcEndpoint(
      { path: `/api/backlog/${backlogRow.id}/resolve`, method: 'POST', body: { status: 'done' } },
      mockCtx,
    )) as { ok: boolean; status: string };
    expect(resolved).toEqual({ ok: true, id: String(backlogRow.id), status: 'shipped' });
  });

  it('GET /api/system/diagnostics и POST /api/system/session/reset сбрасывают тред', async () => {
    await ensureUser(TEST_USER, 'Тест');
    await saveThread(TEST_USER, [{ role: 'user', content: 'привет' }]);

    const diag = (await rpcEndpoint(
      { path: '/api/system/diagnostics', method: 'GET' },
      mockCtx,
    )) as { summary_text: string; thread: { count: number }; model_provider: string };
    expect(diag.summary_text.length).toBeGreaterThan(0);
    expect(diag.thread.count).toBe(1);
    expect(diag.model_provider).toBe('gemini');

    const reset = (await rpcEndpoint(
      { path: '/api/system/session/reset', method: 'POST' },
      mockCtx,
    )) as { ok: boolean; status: string };
    expect(reset).toEqual({ ok: true, status: 'reset' });

    const state = await getAgentState(TEST_USER);
    expect(state?.thread.length).toBe(0);
  });

  it('GET/POST /api/finances/fx читает и мерджит курсы валют (POST только для adminIds)', async () => {
    await setRates('2026-11-20', { USD: 1.1, RUB: 105 }, 'EUR');

    const readBefore = (await rpcEndpoint(
      { path: '/api/finances/fx', method: 'GET' },
      mockCtx,
    )) as { date: string; rates: Record<string, number> };
    expect(readBefore.rates.USD).toBe(1.1);

    const forbidden = await catchEndpointError(
      rpcEndpoint(
        {
          path: '/api/finances/fx',
          method: 'POST',
          body: { rates: { rsd: 117 }, date: '2026-11-23' },
        },
        mockCtx,
      ),
    );
    expect(forbidden.parameters).toMatchObject({ code: 'FORBIDDEN', status: 403 });

    setConfigOverrides({
      masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      adminIds: [TEST_USER],
    });

    const updated = (await rpcEndpoint(
      {
        path: '/api/finances/fx',
        method: 'POST',
        body: { rates: { rsd: 117 }, date: '2026-11-23' },
      },
      mockCtx,
    )) as { date: string; base: string; rates: Record<string, number> };
    expect(updated.date).toBe('2026-11-23');
    expect(updated.base).toBe('EUR');
    expect(updated.rates).toMatchObject({ USD: 1.1, RUB: 105, RSD: 117 });

    const fetched = (await rpcEndpoint(
      { path: '/api/finances/fx', method: 'GET' },
      mockCtx,
    )) as { date: string; rates: Record<string, number> };
    expect(fetched.date).toBe('2026-11-23');
    expect(fetched.rates.RSD).toBe(117);

    const invalid = await catchEndpointError(
      rpcEndpoint({ path: '/api/finances/fx', method: 'POST', body: { rates: {} } }, mockCtx),
    );
    expect(invalid.parameters).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('PATCH /api/finances/liabilities/:id валидирует параметры (400/404) и сбрасывает monthly_payment в null', async () => {
    await ensureUser(TEST_USER, 'Тест');
    const missing = await catchEndpointError(
      rpcEndpoint(
        { path: '/api/finances/liabilities/999999', method: 'PATCH', body: { monthly_payment: 100 } },
        mockCtx,
      ),
    );
    expect(missing.parameters).toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const liab = await createLiability(TEST_USER, {
      name: 'Credit Card',
      queue: 'queue_1',
      currency: 'EUR',
      amountCents: 100000,
      monthlyPaymentCents: 10000,
      paymentDay: 15,
    });

    const invalidMonthly = await catchEndpointError(
      rpcEndpoint(
        { path: `/api/finances/liabilities/${liab.id}`, method: 'PATCH', body: { monthly_payment: -50 } },
        mockCtx,
      ),
    );
    expect(invalidMonthly.parameters).toMatchObject({ code: 'BAD_REQUEST' });

    for (const badDay of [0, 32, 'abc']) {
      const invalidDay = await catchEndpointError(
        rpcEndpoint(
          { path: `/api/finances/liabilities/${liab.id}`, method: 'PATCH', body: { payment_day: badDay } },
          mockCtx,
        ),
      );
      expect(invalidDay.parameters, `payment_day=${String(badDay)}`).toMatchObject({ code: 'BAD_REQUEST' });
    }

    const cleared = (await rpcEndpoint(
      {
        path: `/api/finances/liabilities/${liab.id}`,
        method: 'PATCH',
        body: { monthly_payment: null, payment_day: null },
      },
      mockCtx,
    )) as { monthly_payment: number | null; monthly_payment_eur: number | null; payment_day: number | null };
    expect(cleared.monthly_payment).toBeNull();
    expect(cleared.monthly_payment_eur).toBeNull();
    expect(cleared.payment_day).toBeNull();
  });

  it('новые ручки возвращают 405 METHOD_NOT_ALLOWED на неподдерживаемые методы', async () => {
    const checks: Array<{ path: string; method: string }> = [
      { path: '/api/skills', method: 'POST' },
      { path: '/api/skills/1/activate', method: 'GET' },
      { path: '/api/skills/1/reject', method: 'GET' },
      { path: '/api/backlog', method: 'POST' },
      { path: '/api/backlog/1/resolve', method: 'GET' },
      { path: '/api/system/diagnostics', method: 'POST' },
      { path: '/api/system/session/reset', method: 'GET' },
      { path: '/api/finances/fx', method: 'DELETE' },
      { path: '/api/docs/search', method: 'POST' },
      { path: '/api/diary', method: 'POST' },
      { path: '/api/diary/2026-11-24', method: 'DELETE' },
    ];
    for (const req of checks) {
      const err = await catchEndpointError(rpcEndpoint(req, mockCtx));
      expect(err.parameters, `${req.method} ${req.path}`).toMatchObject({
        code: 'METHOD_NOT_ALLOWED',
        status: 405,
      });
    }
  });

  it('GET /api/diary и GET /api/diary/:date отдают список и запись, проверяют формат и 404', async () => {
    await ensureUser(TEST_USER);
    await appendReflection(TEST_USER, 'Мысль в дневник', { date: '2026-11-20', energy: 7 });

    const listRes = (await rpcEndpoint({ path: '/api/diary', method: 'GET' }, mockCtx)) as {
      entries: Array<{ date: string; preview: string; energy: string | null }>;
    };
    expect(listRes.entries).toHaveLength(1);
    expect(listRes.entries[0]).toMatchObject({
      date: '2026-11-20',
      preview: 'Мысль в дневник',
      energy: '7',
    });

    const detailRes = (await rpcEndpoint(
      { path: '/api/diary/2026-11-20', method: 'GET' },
      mockCtx,
    )) as { date: string; content: string };
    expect(detailRes.date).toBe('2026-11-20');
    expect(detailRes.content).toContain('Мысль в дневник');

    const badDate = await catchEndpointError(
      rpcEndpoint({ path: '/api/diary/bad-date', method: 'GET' }, mockCtx),
    );
    expect(badDate.parameters).toMatchObject({ code: 'BAD_REQUEST' });

    const missing = await catchEndpointError(
      rpcEndpoint({ path: '/api/diary/2026-11-19', method: 'GET' }, mockCtx),
    );
    expect(missing.parameters).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('DELETE /api/finances/budgets/:categoryId удаляет лимит, проверяет 400/404 и 405 на GET', async () => {
    await ensureUser(TEST_USER);
    await rpcEndpoint(
      {
        path: '/api/finances/budgets',
        method: 'POST',
        body: { category_name: 'Кафе', limit_amount_eur: 150, month: '2026-11' },
      },
      mockCtx,
    );

    const cats = await listCategories(TEST_USER, 'expense');
    const cafe = cats.find((c) => c.name === 'Кафе');
    expect(cafe).toBeDefined();

    const wrongMethod = await catchEndpointError(
      rpcEndpoint({ path: `/api/finances/budgets/${cafe!.id}`, method: 'GET' }, mockCtx),
    );
    expect(wrongMethod.parameters).toMatchObject({ code: 'METHOD_NOT_ALLOWED', status: 405 });

    const badMonth = await catchEndpointError(
      rpcEndpoint({ path: `/api/finances/budgets/${cafe!.id}?month=2026-13`, method: 'DELETE' }, mockCtx),
    );
    expect(badMonth.parameters).toMatchObject({ code: 'BAD_REQUEST' });

    const deleted = (await rpcEndpoint(
      { path: `/api/finances/budgets/${cafe!.id}?month=2026-11`, method: 'DELETE' },
      mockCtx,
    )) as { deleted: boolean; category_id: string };
    expect(deleted.deleted).toBe(true);
    expect(deleted.category_id).toBe(String(cafe!.id));

    const notFound = await catchEndpointError(
      rpcEndpoint({ path: `/api/finances/budgets/${cafe!.id}?month=2026-11`, method: 'DELETE' }, mockCtx),
    );
    expect(notFound.parameters).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('POST /api/tasks и PATCH /api/tasks/:id возвращают category_name и subcategory_name и сбрасывают при null', async () => {
    await ensureSystemCategories(TEST_USER);
    const cats = (await rpcEndpoint({ path: '/api/categories', method: 'GET' }, mockCtx)) as Array<{
      id: string;
      name: string;
      subcategories: Array<{ id: string; name: string }>;
    }>;
    const hobby = cats.find((c) => c.name === 'Хобби');
    const yt = hobby?.subcategories.find((s) => s.name === 'YouTube');
    const byt = cats.find((c) => c.name === 'Быт');
    const clean = byt?.subcategories.find((s) => s.name === 'Гигиена и уборка');
    expect(hobby && yt && byt && clean).toBeTruthy();

    const created = (await rpcEndpoint(
      {
        path: '/api/tasks',
        method: 'POST',
        body: {
          title: 'Смонтировать выпуск',
          category_id: hobby!.id,
          subcategory_id: yt!.id,
        },
      },
      mockCtx,
    )) as { category_id?: string; category_name?: string; subcategory_id?: string; subcategory_name?: string; id: string };
    expect(created.category_name).toBe('Хобби');
    expect(created.subcategory_id).toBe(yt!.id);
    expect(created.subcategory_name).toBe('YouTube');

    const moved = (await rpcEndpoint(
      {
        path: `/api/tasks/${created.id}`,
        method: 'PATCH',
        body: { category_id: byt!.id, subcategory_id: clean!.id },
      },
      mockCtx,
    )) as { category_name?: string; subcategory_name?: string };
    expect(moved.category_name).toBe('Быт');
    expect(moved.subcategory_name).toBe('Гигиена и уборка');

    const cleared = (await rpcEndpoint(
      {
        path: `/api/tasks/${created.id}`,
        method: 'PATCH',
        body: { subcategory_id: null },
      },
      mockCtx,
    )) as { category_name?: string; subcategory_id?: string; subcategory_name?: string };
    expect(cleared.category_name).toBe('Быт');
    expect(cleared.subcategory_id).toBeUndefined();
    expect(cleared.subcategory_name).toBeUndefined();
  });

  it('GET /api/config/ui применяет оверрайды UserPrefs поверх манифеста оверлея', async () => {
    await ensureUser(TEST_USER, 'Тест');
    const manifest = getOverlay().manifest;

    const baseUi = (await rpcEndpoint({ path: '/api/config/ui', method: 'GET' }, mockCtx)) as {
      brand: { assistantName: string };
      finance: { reserveAmount: number };
      miniapp: { tabs: string[]; accountThemes: Array<{ pattern: string; theme: string }> };
      personas: Array<{ id: string }>;
      summary: { activeRoutinesCount: number; totalRoutinesCount: number; presetsCount: number };
    };
    expect(baseUi.brand.assistantName).toBe(manifest.brand.assistantName);
    expect(baseUi.miniapp.tabs).toEqual(manifest.miniapp.tabs);
    expect(baseUi.personas).toEqual([]);

    await saveUserPrefs(TEST_USER, {
      assistantName: 'Atlas',
      adhd: { focusLimit: 2 },
      finance: {
        reserveCents: 30_000,
        accountAliases: [{ account: 'Main Card', patterns: ['main', 'card'] }],
      },
      brain: {
        customPersonas: {
          zen: {
            id: 'zen',
            name: 'Zen',
            description: 'Calm helper',
            instructions: 'Speak softly.',
            updatedAt: '2026-11-24T12:00:00Z',
          },
        },
      },
      proactive: {
        routines: {
          r1: {
            id: 'r1',
            name: 'Check-in',
            enabled: true,
            kind: 'text',
            schedule: 'daily',
            time: '10:00',
            message: 'Ping',
            updatedAt: '2026-11-24T12:00:00Z',
          },
        },
      },
      miniapp: {
        tabs: ['finances', 'today', 'system'],
        accountThemes: [
          { pattern: 'Main Card', theme: 'primary', shortName: 'Main', roleLabel: 'Daily' },
        ],
      },
    });

    const overriddenUi = (await rpcEndpoint({ path: '/api/config/ui', method: 'GET' }, mockCtx)) as {
      brand: { assistantName: string; localizedNames: Record<string, string> };
      finance: { reserveAmount: number; accountAliases: Array<{ account: string }> };
      miniapp: { tabs: string[]; accountThemes: Array<{ pattern: string; shortName?: string }> };
      adhd: { focusLimit: number | null };
      personas: Array<{ id: string; name: string }>;
      summary: { activeRoutinesCount: number; totalRoutinesCount: number; presetsCount: number };
    };
    expect(overriddenUi.brand.assistantName).toBe('Atlas');
    expect(overriddenUi.brand.localizedNames.ru).toBe('Atlas');
    expect(overriddenUi.finance.reserveAmount).toBe(300);
    expect(overriddenUi.finance.accountAliases[0]?.account).toBe('Main Card');
    expect(overriddenUi.miniapp.tabs).toEqual(['finances', 'today', 'system']);
    expect(overriddenUi.miniapp.accountThemes[0]).toMatchObject({
      pattern: 'Main Card',
      shortName: 'Main',
    });
    expect(overriddenUi.adhd.focusLimit).toBe(2);
    expect(overriddenUi.personas).toHaveLength(1);
    expect(overriddenUi.summary).toEqual({
      activeRoutinesCount: 1,
      totalRoutinesCount: 1,
      presetsCount: 0,
    });
  });

  it('управляет рутинами, пресетами, сбросом, откатом и флагом disabled в /api/skills через RPC', async () => {
    await ensureUser(TEST_USER, 'Тест');
    const baseState = await captureSettingsState(TEST_USER);
    const focusSnapshot = buildPresetPayloadFromState({
      ...baseState,
      profile: { ...baseState.profile, lowStimulationMode: true },
      directives: { ...baseState.directives, style: 'concise' },
      prefs: { ...baseState.prefs, assistantName: 'FocusBot', adhd: { focusLimit: 2 } },
    });
    const openaiSnapshot = buildPresetPayloadFromState({
      ...baseState,
      profile: { ...baseState.profile, modelProvider: 'openai' },
    });

    await saveUserPrefs(TEST_USER, {
      brain: {
        disabledBuiltinSkills: ['daily-focus'],
      },
      proactive: {
        routines: {
          ping: {
            id: 'ping',
            name: 'Утренний пинг',
            enabled: true,
            kind: 'text',
            schedule: 'daily',
            time: '08:30',
            message: 'Доброе утро',
            updatedAt: '2026-11-24T12:00:00Z',
          },
          ai_1: {
            id: 'ai_1',
            name: 'AI 1',
            enabled: true,
            kind: 'ai',
            schedule: 'daily',
            time: '09:00',
            prompt: 'P1',
            updatedAt: '2026-11-24T12:00:00Z',
          },
          ai_2: {
            id: 'ai_2',
            name: 'AI 2',
            enabled: true,
            kind: 'ai',
            schedule: 'daily',
            time: '10:00',
            prompt: 'P2',
            updatedAt: '2026-11-24T12:00:00Z',
          },
          ai_3: {
            id: 'ai_3',
            name: 'AI 3',
            enabled: true,
            kind: 'ai',
            schedule: 'daily',
            time: '11:00',
            prompt: 'P3',
            updatedAt: '2026-11-24T12:00:00Z',
          },
          ai_4: {
            id: 'ai_4',
            name: 'AI 4',
            enabled: false,
            kind: 'ai',
            schedule: 'daily',
            time: '12:00',
            prompt: 'P4',
            updatedAt: '2026-11-24T12:00:00Z',
          },
        },
      },
      presets: {
        sprint: {
          id: 'sprint',
          name: 'Спринт',
          description: 'Фокус-режим',
          snapshot: focusSnapshot,
          updatedAt: '2026-11-24T12:00:00Z',
        },
        needs_openai: {
          id: 'needs_openai',
          name: 'OpenAI Preset',
          snapshot: openaiSnapshot,
          updatedAt: '2026-11-24T12:00:00Z',
        },
      },
    });

    // 1. GET /api/settings возвращает summary, пресеты и рутины без секретов
    const settingsRes = (await rpcEndpoint({ path: '/api/settings', method: 'GET' }, mockCtx)) as {
      prefs_summary: { has_overrides: boolean; history_count: number };
      presets: Array<{ id: string }>;
      routines: Array<{ id: string; enabled: boolean }>;
    };
    expect(settingsRes.prefs_summary.has_overrides).toBe(true);
    expect(settingsRes.presets.map((p) => p.id)).toContain('sprint');
    expect(settingsRes.routines.find((r) => r.id === 'ping')?.enabled).toBe(true);
    expect(JSON.stringify(settingsRes)).not.toContain('masterKey');

    // 2. GET /api/skills помечает отключённые встроенные скиллы
    const skillsRes = (await rpcEndpoint({ path: '/api/skills', method: 'GET' }, mockCtx)) as {
      builtin: Array<{ id: string; disabled?: boolean }>;
    };
    const disabledSkill = skillsRes.builtin.find((s) => s.id === 'daily-focus');
    expect(disabledSkill).toBeDefined();
    expect(disabledSkill?.disabled).toBe(true);

    // 3. PATCH /api/settings/routines/:id — 405 на GET, 404 на неизвестный ID, 400 на лимит 3 AI-рутин, успех на ping
    const routineGetErr = await catchEndpointError(
      rpcEndpoint({ path: '/api/settings/routines/ping', method: 'GET' }, mockCtx),
    );
    expect(routineGetErr.parameters).toMatchObject({ code: 'METHOD_NOT_ALLOWED', status: 405 });

    const routineMissing = await catchEndpointError(
      rpcEndpoint({ path: '/api/settings/routines/unknown_id', method: 'PATCH', body: { enabled: false } }, mockCtx),
    );
    expect(routineMissing.parameters).toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const aiCapErr = await catchEndpointError(
      rpcEndpoint({ path: '/api/settings/routines/ai_4', method: 'PATCH', body: { enabled: true } }, mockCtx),
    );
    expect(aiCapErr.parameters).toMatchObject({ code: 'BAD_REQUEST' });

    const toggledOff = (await rpcEndpoint(
      { path: '/api/settings/routines/ping', method: 'PATCH', body: { enabled: false } },
      mockCtx,
    )) as { ok: boolean; enabled: boolean; settings: { prefs_summary: { history_count: number } } };
    expect(toggledOff.ok).toBe(true);
    expect(toggledOff.enabled).toBe(false);
    expect(toggledOff.settings.prefs_summary.history_count).toBeGreaterThanOrEqual(1);

    // 4. POST /api/settings/presets/:id/apply — проверка ключа провайдера, 404, 405, и применение пресета
    const presetGetErr = await catchEndpointError(
      rpcEndpoint({ path: '/api/settings/presets/sprint/apply', method: 'GET' }, mockCtx),
    );
    expect(presetGetErr.parameters).toMatchObject({ code: 'METHOD_NOT_ALLOWED', status: 405 });

    const missingKeyPreset = await catchEndpointError(
      rpcEndpoint({ path: '/api/settings/presets/needs_openai/apply', method: 'POST' }, mockCtx),
    );
    expect(missingKeyPreset.parameters).toMatchObject({ code: 'BAD_REQUEST' });

    const appliedPreset = (await rpcEndpoint(
      { path: '/api/settings/presets/sprint/apply', method: 'POST' },
      mockCtx,
    )) as { ok: boolean; settings: { assistant_name: string; persona_style: string; low_stimulation_mode: boolean } };
    expect(appliedPreset.ok).toBe(true);
    expect(appliedPreset.settings.assistant_name).toBe('FocusBot');
    expect(appliedPreset.settings.persona_style).toBe('concise');
    expect(appliedPreset.settings.low_stimulation_mode).toBe(true);

    // 5. POST /api/settings/reset и POST /api/settings/rollback
    const badSection = await catchEndpointError(
      rpcEndpoint({ path: '/api/settings/reset', method: 'POST', body: { section: 'invalid' } }, mockCtx),
    );
    expect(badSection.parameters).toMatchObject({ code: 'BAD_REQUEST' });

    const resetRes = (await rpcEndpoint(
      { path: '/api/settings/reset', method: 'POST', body: { section: 'all' } },
      mockCtx,
    )) as { ok: boolean; settings: { assistant_name: string | null; presets: Array<{ id: string }> } };
    expect(resetRes.ok).toBe(true);
    expect(resetRes.settings.assistant_name).toBeNull();
    // Пресеты сохраняются при сбросе all
    expect(resetRes.settings.presets.map((p) => p.id)).toContain('sprint');

    const rolledBack = (await rpcEndpoint(
      { path: '/api/settings/rollback', method: 'POST', body: { steps: 1 } },
      mockCtx,
    )) as { ok: boolean; settings: { assistant_name: string | null } };
    expect(rolledBack.ok).toBe(true);
    expect(rolledBack.settings.assistant_name).toBe('FocusBot');

    // Повторный вызов с неверным шагом -> 400
    const badSteps = await catchEndpointError(
      rpcEndpoint({ path: '/api/settings/rollback', method: 'POST', body: { steps: 99 } }, mockCtx),
    );
    expect(badSteps.parameters).toMatchObject({ code: 'BAD_REQUEST' });

    const arraySteps = await catchEndpointError(
      rpcEndpoint({ path: '/api/settings/rollback', method: 'POST', body: { steps: [2] } }, mockCtx),
    );
    expect(arraySteps.parameters).toMatchObject({ code: 'BAD_REQUEST' });

    // 6. Защита от prototype lookup (constructor) и битого percent-encoding, плюс 403 при whitelist
    const protoRoutine = await catchEndpointError(
      rpcEndpoint(
        { path: '/api/settings/routines/constructor', method: 'PATCH', body: { enabled: true } },
        mockCtx,
      ),
    );
    expect(protoRoutine.parameters).toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const protoPreset = await catchEndpointError(
      rpcEndpoint({ path: '/api/settings/presets/constructor/apply', method: 'POST' }, mockCtx),
    );
    expect(protoPreset.parameters).toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const malformedUri = await catchEndpointError(
      rpcEndpoint(
        { path: '/api/settings/routines/%E0%A4%A', method: 'PATCH', body: { enabled: false } },
        mockCtx,
      ),
    );
    expect(malformedUri.parameters).toMatchObject({ code: 'BAD_REQUEST' });

    setConfigOverrides({
      masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      adminIds: [999999998],
    });
    const deniedConfigUi = await catchEndpointError(
      rpcEndpoint({ path: '/api/config/ui', method: 'GET' }, { initData: { user: { id: 888888887 } } }),
    );
    expect(deniedConfigUi.parameters).toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const deniedReset = await catchEndpointError(
      rpcEndpoint(
        { path: '/api/settings/reset', method: 'POST', body: { section: 'all' } },
        { initData: { user: { id: 888888887 } } },
      ),
    );
    expect(deniedReset.parameters).toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});
