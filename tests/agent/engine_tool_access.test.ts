/**
 * Read-only ход движка (PLAN-AGENT-WRITE-GUARD T4, вторая половина).
 *
 * Хендлер решает, дать ли записи (см. `tests/handlers/ingest_social_gate.test.ts`),
 * а движок обязан обеспечить это физически: в read-only ходе write-тулз нет ни в
 * спеках модели, ни в диспетчере вызовов. Поэтому «незапрошенный» write
 * невозможен даже при ошибке модели — именно этого не хватило 22.11.2026, когда
 * «Привет» получил полный тулсет.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { createNote, listNotes } from '../../src/lib/dal/notes';
import { ensureUser } from '../../src/lib/dal/users';
import { runAgent, type AgentChatFn } from '../../src/lib/agent/engine';

const USER = 616161;
const NOW = new Date('2026-03-15T10:00:00.000Z');
const PROFILE = { userName: 'Иван', timezone: 'Europe/Belgrade', baseCurrency: 'EUR' };

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER);
});

describe('runAgent: read-only ход не выполняет write-тулзы', () => {
  it('нативный delete_note в read-only не выполняется, спеки содержат только чтение', async () => {
    await createNote(USER, 'Я оплатил mtel c Freedom');

    const requests: { tools?: readonly { name: string }[]; systemPrompt: string }[] = [];
    const result = await runAgent({
      userId: USER,
      text: 'привет',
      toolAccess: 'read-only',
      store: null,
      profile: PROFILE,
      now: NOW,
      chatFn: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'delete_note', args: { query: 'mtel' } }],
          };
        }
        return { content: 'Привет! Чем помочь?', toolCalls: [] };
      },
    });

    // Заметка цела: имени write-тулзы нет в тулсете, вызов не выполняется.
    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(await listNotes(USER)).toHaveLength(1);

    const specs = requests[0]?.tools ?? [];
    const names = specs.map((spec) => spec.name);
    expect(names.length).toBe(20);
    expect(names).toContain('list_skills');
    expect(names).toContain('read_skill');
    expect(names).not.toContain('draft_skill');
    expect(names).not.toContain('delete_note');
    expect(names).not.toContain('add_task');
    expect(names).toContain('list_tasks');
    expect(requests[0]?.systemPrompt).toContain('только чтение');
  });

  it('тот же вход без ограничения удаляет заметку — гейт не всеобщий', async () => {
    await createNote(USER, 'Я оплатил mtel c Freedom');

    const chatFn: AgentChatFn = async () => ({
      content: '',
      toolCalls: [{ id: 'c1', name: 'delete_note', args: { query: 'mtel' } }],
    });

    const result = await runAgent({
      userId: USER,
      text: 'удали заметку про mtel',
      store: null,
      profile: PROFILE,
      now: NOW,
      chatFn,
    });

    expect(result.steps[0]).toMatchObject({ ok: true });
    expect(await listNotes(USER)).toHaveLength(0);
  });
});
