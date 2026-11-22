/**
 * Экспирация треда (`THREAD_STALE_AFTER_MS`).
 *
 * Зачем: незакрытая инструкция жила в треде бесконечно, и через час простоя
 * «мне скучно» поднимало старую просьбу — вплоть до удаления, которого владелец
 * уже не помнит. Граница — час без нового хода: просьба, вызовы, наблюдения и
 * вопрос подтверждения часовой давности новому ходу не наследуются.
 *
 * Правила, которые проверяются здесь:
 *  1. разрыв час и больше — `chatFn` не видит старую просьбу и её хвост;
 *  2. разрыв 5 минут — история цела, обычная многошаговая работа продолжается;
 *  3. старое подтверждение не исполняется, даже если лежит в `kv`;
 *  4. хвост с вопросом подтверждения (маркер `confirmPrompt`) срезается всегда.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb, sqliteDDL } from '../mocks/sdk';
import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { createLiability, listLiabilities } from '../../src/lib/dal/finances';
import { AGENT_TURN_KEY_PREFIX, kvSetJson, patchAgentTurnState } from '../../src/lib/dal/misc';
import { ensureUser } from '../../src/lib/dal/users';
import {
  THREAD_STALE_AFTER_MS,
  runAgent,
  type AgentChatFn,
  type AgentChatRequest,
  type AgentThreadStore,
} from '../../src/lib/agent/engine';
import {
  CONFIRM_PROMPT_KEY,
  observationMeta,
  toolCallsMeta,
} from '../../src/lib/agent/sanitize';
import type { AgentMessage } from '../../src/types';

const USER = 707070;
const NOW = new Date('2026-11-22T16:00:00Z');
const NOW_MS = NOW.getTime();
const PROFILE = { userName: 'Иван', timezone: 'Europe/Belgrade', baseCurrency: 'EUR' };
const LIABILITY = 'ТЕСТ 1';

/** Тред в памяти: историю задаём вручную, запись не нужна. */
function memoryStore(thread: AgentMessage[]): AgentThreadStore {
  let saved: AgentMessage[] = [];
  return {
    async load() {
      return thread.map((message) => ({ ...message }));
    },
    async save(_userId, next) {
      saved = [...next];
    },
    async clear() {
      saved = [];
    },
  };
}

/** Просьба, вызов удаления и наблюдение — без финального ответа. */
function unfinishedThread(): AgentMessage[] {
  return [
    { role: 'user', content: `удали обязательство ${LIABILITY}` },
    {
      role: 'assistant',
      content: 'Thought: удалю.',
      meta: toolCallsMeta([
        { id: 'call_1', name: 'delete_liability', args: { liability_name: LIABILITY } },
      ]),
    },
    {
      role: 'user',
      content: `Требуется подтверждение пользователя: delete_liability. Действие не выполнено.`,
      meta: observationMeta({ id: 'call_1', name: 'delete_liability', ok: false }),
    },
  ];
}

/** Ход, который запоминает, какую историю увидела модель. */
function capturingChat(reply = 'Готово.'): { fn: AgentChatFn; seen: () => AgentChatRequest[] } {
  const seen: AgentChatRequest[] = [];
  const fn: AgentChatFn = async (request) => {
    seen.push(request);
    return { content: reply, toolCalls: [] };
  };
  return { fn, seen: () => seen };
}

async function staleState(ageMs: number, confirmation: boolean): Promise<void> {
  await patchAgentTurnState(
    USER,
    {
      lastTurnAt: new Date(NOW_MS - ageMs).toISOString(),
      ...(confirmation
        ? {
            confirmation: {
              name: 'delete_liability',
              args: { liability_name: LIABILITY },
              createdAt: new Date(NOW_MS - ageMs).toISOString(),
            },
          }
        : {}),
    },
    NOW_MS,
  );
}

function historyText(requests: readonly AgentChatRequest[]): string {
  return JSON.stringify(requests.map((request) => request.messages));
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('экспирация треда', () => {
  it('после часа простоя старая просьба не наследуется, а подтверждение не исполняется', async () => {
    await ensureUser(USER);
    await createLiability(USER, {
      name: LIABILITY,
      amountCents: 100,
      monthlyPaymentCents: 100,
      paymentDay: 5,
    });
    await staleState(THREAD_STALE_AFTER_MS + 60_000, true);
    const chat = capturingChat();

    const result = await runAgent({
      userId: USER,
      text: 'мне скучно',
      mode: 'action',
      profile: PROFILE,
      chatFn: chat.fn,
      store: memoryStore(unfinishedThread()),
      now: NOW,
      clock: () => NOW_MS,
    });

    // Старая инструкция и её наблюдение не доехали до модели.
    expect(historyText(chat.seen())).not.toContain(LIABILITY);
    expect(historyText(chat.seen())).not.toContain('delete_liability');
    // Ни модель, ни движок не исполнили старое удаление.
    expect(result.steps.filter((step) => step.action !== null)).toHaveLength(0);
    expect(await listLiabilities(USER)).toHaveLength(1);
  });

  it('разрыв 5 минут — история сохранена целиком', async () => {
    await ensureUser(USER);
    await staleState(5 * 60_000, false);
    const chat = capturingChat();

    await runAgent({
      userId: USER,
      text: 'а что с моим обязательством?',
      mode: 'action',
      profile: PROFILE,
      chatFn: chat.fn,
      store: memoryStore(unfinishedThread()),
      now: NOW,
      clock: () => NOW_MS,
    });

    // Многошаговая работа в пределах часа не режется.
    expect(historyText(chat.seen())).toContain(LIABILITY);
    expect(historyText(chat.seen())).toContain('Требуется подтверждение');
  });

  it('вопрос подтверждения срезается всегда: он не закрывает просьбу', async () => {
    await ensureUser(USER);
    await createLiability(USER, {
      name: LIABILITY,
      amountCents: 100,
      monthlyPaymentCents: 100,
      paymentDay: 5,
    });
    const thread: AgentMessage[] = [
      ...unfinishedThread(),
      {
        role: 'assistant',
        content: `⚠️ Подтвердите действие: delete_liability ${LIABILITY}`,
        meta: { [CONFIRM_PROMPT_KEY]: 'delete_liability' },
      },
    ];
    await staleState(THREAD_STALE_AFTER_MS + 60_000, false);
    // Просроченное право ещё лежит в `kv` строкой, но исполнять его нельзя.
    await kvSetJson(`${AGENT_TURN_KEY_PREFIX}${USER}`, {
      lastTurnAt: new Date(NOW_MS - THREAD_STALE_AFTER_MS - 60_000).toISOString(),
      confirmation: {
        name: 'delete_liability',
        args: { liability_name: LIABILITY },
        createdAt: new Date(NOW_MS - THREAD_STALE_AFTER_MS - 60_000).toISOString(),
      },
    });
    const chat = capturingChat();

    const result = await runAgent({
      userId: USER,
      text: 'да',
      mode: 'action',
      profile: PROFILE,
      chatFn: chat.fn,
      store: memoryStore(thread),
      now: NOW,
      clock: () => NOW_MS,
    });

    expect(historyText(chat.seen())).not.toContain(LIABILITY);
    expect(historyText(chat.seen())).not.toContain('Подтвердите действие');
    expect(result.steps.filter((step) => step.action !== null)).toHaveLength(0);
    expect(await listLiabilities(USER)).toHaveLength(1);
  });
});
