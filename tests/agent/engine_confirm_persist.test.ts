/**
 * Персист подтверждения необратимого действия (`agent_turn:v1:<uid>`).
 *
 * Зачем: до этого подтверждение жило только в треде и в промпте, поэтому после
 * «да» решение принимала модель — повторить ли вызов, с какими аргументами и не
 * подменить ли инструмент. Теперь право на исполнение уезжает в `kv`, а «да»
 * исполняет движок: ровно тот вызов (имя + аргументы), который видел владелец.
 *
 * Правила, которые проверяются здесь:
 *  1. confirm-ход пишет имя, аргументы и время в `agent_turn:v1:<uid>`;
 *  2. «да» исполняет тулзу даже при `chatFn`, который её не вызывает;
 *  3. подтверждение старше TTL не исполняется никогда;
 *  4. «нет» и новая просьба стирают подтверждение;
 *  5. подтверждение тулзы, которой нет в списке, не исполняется.
 *
 * Confirm-путь идёт через реестр (`runAgent` без `options.tools`), а не через
 * инъекцию тулз: проверяется именно продуктовая цепочка «движок + реестр».
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb, sqliteDDL } from '../mocks/sdk';
import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { createLiability, listLiabilities } from '../../src/lib/dal/finances';
import {
  AGENT_TURN_KEY_PREFIX,
  PENDING_CONFIRM_TTL_MS,
  kvGetJson,
  kvSetJson,
  readAgentTurnState,
  type PendingConfirmation,
} from '../../src/lib/dal/misc';
import { ensureUser } from '../../src/lib/dal/users';
import { runAgent, type AgentChatFn } from '../../src/lib/agent/engine';

const USER = 909090;
const NOW = new Date('2026-11-22T15:00:00Z');
const NOW_MS = NOW.getTime();

const PROFILE = { userName: 'Иван', timezone: 'Europe/Belgrade', baseCurrency: 'EUR' };
const LIABILITY = 'ТЕСТ 1';

function turnKey(userId: number): string {
  return `${AGENT_TURN_KEY_PREFIX}${userId}`;
}

interface StoredTurnState {
  lastTurnAt: string | null;
  confirmation: PendingConfirmation | null;
}

async function rawState(userId: number): Promise<StoredTurnState | null> {
  return kvGetJson<StoredTurnState | null>(turnKey(userId), null);
}

async function seedLiability(): Promise<void> {
  await ensureUser(USER);
  await createLiability(USER, {
    name: LIABILITY,
    amountCents: 100,
    monthlyPaymentCents: 100,
    paymentDay: 5,
  });
}

/** Ход, в котором модель просит удалить обязательство: должен упереться в confirm. */
async function askDelete(): Promise<Awaited<ReturnType<typeof runAgent>>> {
  const chatFn: AgentChatFn = async () => ({
    content: '',
    toolCalls: [{ id: 'call_1', name: 'delete_liability', args: { liability_name: LIABILITY } }],
  });
  return runAgent({
    userId: USER,
    text: `удали обязательство ${LIABILITY}`,
    mode: 'action',
    profile: PROFILE,
    chatFn,
    now: NOW,
    clock: () => NOW_MS,
  });
}

/**
 * Второй ход: `chatFn` НЕ вызывает инструментов. Если удаление всё же случится,
 * это докажет, что решение принял движок, а не модель.
 */
async function replyWith(text: string): Promise<Awaited<ReturnType<typeof runAgent>>> {
  const chatFn: AgentChatFn = async () => ({ content: 'Готово.', toolCalls: [] });
  return runAgent({
    userId: USER,
    text,
    mode: 'action',
    profile: PROFILE,
    chatFn,
    now: NOW,
    clock: () => NOW_MS,
    store: null,
  });
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('подтверждение живёт в kv', () => {
  it('confirm-ход пишет имя и аргументы, вопрос при этом не меняет данные', async () => {
    await seedLiability();

    const result = await askDelete();

    expect(result.stopReason).toBe('confirm');
    expect(result.reply).toContain('delete_liability');
    // Данные не тронуты: вопрос — это вопрос, а не половинчатое удаление.
    expect(await listLiabilities(USER)).toHaveLength(1);

    const stored = await rawState(USER);
    expect(stored?.confirmation?.name).toBe('delete_liability');
    expect(stored?.confirmation?.args).toEqual({ liability_name: LIABILITY });
    // `confirm: true` в `kv` не лежит: это право движка, а не аргумент владельца.
    expect(stored?.confirmation?.args).not.toHaveProperty('confirm');
    expect(Number.isFinite(Date.parse(stored?.confirmation?.createdAt ?? ''))).toBe(true);
    expect(stored?.lastTurnAt).toBe(new Date(NOW_MS).toISOString());
  });

  it('«да» исполняет ровно тот вызов без участия модели и стирает подтверждение', async () => {
    await seedLiability();
    await askDelete();

    const result = await replyWith('да');

    expect(result.stopReason).toBe('final');
    // Модель ответила словами, но шаг с вызовом собрал движок.
    expect(result.steps[0]?.action?.name).toBe('delete_liability');
    expect(result.steps[0]?.ok).toBe(true);
    expect(result.steps[0]?.observation).toContain('🗑️');
    // Данные изменились именно поэтому, а не потому что модель попросила.
    expect(await listLiabilities(USER)).toHaveLength(0);
    // Право одноразовое.
    expect((await rawState(USER))?.confirmation).toBeNull();
    expect((await readAgentTurnState(USER, NOW_MS)).confirmation).toBeNull();
  });

  it('«да» после TTL не исполняет и не бросает', async () => {
    await seedLiability();
    await kvSetJson(turnKey(USER), {
      lastTurnAt: null,
      confirmation: {
        name: 'delete_liability',
        args: { liability_name: LIABILITY },
        createdAt: new Date(NOW_MS - PENDING_CONFIRM_TTL_MS - 60_000).toISOString(),
      },
    });

    const result = await replyWith('да');

    expect(result.stopReason).toBe('final');
    expect(result.steps.filter((step) => step.action !== null)).toHaveLength(0);
    expect(await listLiabilities(USER)).toHaveLength(1);
    // Просроченное право затирается следующей записью, а не ждёт своего часа.
    expect((await rawState(USER))?.confirmation).toBeNull();
  });

  it('«нет» стирает подтверждение, не исполняя его', async () => {
    await seedLiability();
    await askDelete();

    const result = await replyWith('нет');

    expect(result.steps.filter((step) => step.action !== null)).toHaveLength(0);
    expect(await listLiabilities(USER)).toHaveLength(1);
    expect((await rawState(USER))?.confirmation).toBeNull();
  });

  it('новая просьба стирает подтверждение: владелец занят другим', async () => {
    await seedLiability();
    await askDelete();

    const result = await replyWith('покажи мои задачи');

    expect(result.steps.filter((step) => step.action !== null)).toHaveLength(0);
    expect(await listLiabilities(USER)).toHaveLength(1);
    expect((await rawState(USER))?.confirmation).toBeNull();
  });

  it('подтверждение тулзы, которой нет в списке, не исполняется', async () => {
    await seedLiability();
    await kvSetJson(turnKey(USER), {
      lastTurnAt: null,
      confirmation: {
        name: 'no_such_tool_xyz',
        args: { liability_name: LIABILITY },
        createdAt: new Date(NOW_MS).toISOString(),
      },
    });

    const result = await replyWith('да');

    expect(result.steps.filter((step) => step.action !== null)).toHaveLength(0);
    expect(await listLiabilities(USER)).toHaveLength(1);
    expect((await rawState(USER))?.confirmation).toBeNull();
  });
});
