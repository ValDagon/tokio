/**
 * Интеграционные и юнит-тесты Волны 1 (`PLAN-CHAT-CONFIG.md`):
 *  - `prefs.ts` (read-only чтение, 10-шаговый откат, сброс, пресеты);
 *  - условный гейт `confirmWhen` в `engine.ts` + детерминированный `"да"`;
 *  - передача `preferredModel` / `modelProvider` / `maxSteps` / `temperature` / `assistantName` / кастомных персон / скрытия встроенных скиллов в движок и промпт;
 *  - все 11 тулз `configTools` + `create_account` + `update_medication(refill_threshold)`;
 *  - кириллическая нечувствительность к регистру и безопасная отвязка при удалении категорий.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { CUSTOM_INSTRUCTIONS_SLUG } from '../../../src/lib/agent/constants';
import { runAgent, type AgentChatFn, type AgentChatRequest, type AgentThreadStore } from '../../../src/lib/agent/engine';
import { buildSystemPrompt } from '../../../src/lib/agent/prompts';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import { configTools } from '../../../src/lib/agent/tools/config';
import { financeTools } from '../../../src/lib/agent/tools/finances';
import { medicationTools } from '../../../src/lib/agent/tools/medications';
import { reasoningTools } from '../../../src/lib/agent/tools/reasoning';
import { resetConfigCache, setConfigOverrides } from '../../../src/lib/config';
import { sealByok } from '../../../src/lib/crypto';
import { getOverlay } from '../../../src/lib/overlay';
import { upsertChapter, getChapter } from '../../../src/lib/dal/docs';
import {
  createAccount,
  createCategory as createFinCategory,
  createTransaction,
  listAccounts,
  listTransactions,
  setBudget,
} from '../../../src/lib/dal/finances';
import { createMedication, listMedications } from '../../../src/lib/dal/medications';
import { createCategory as createTaskCategory, createTask, getTask } from '../../../src/lib/dal/tasks';
import { ensureUser, getUser, updateUser } from '../../../src/lib/dal/users';
import { createManualSkillDraft, listAllUserSkills } from '../../../src/lib/evolution';
import { parseBalanceDeclaration, parseFinancialIntent } from '../../../src/lib/financial-parser';
import {
  DEFAULT_OVERLOAD_OVERDUE_THRESHOLD,
  MAX_PREFS_HISTORY,
  buildSettingsPrefsSummary,
  captureSettingsState,
  countActiveAiRoutines,
  evaluateRoutineSchedule,
  formatSettingsDiff,
  isInQuietHours,
  loadPrefsHistory,
  loadUserPrefs,
  normalizeMiniAppPrefs,
  parseWeekdaysInput,
  pushPrefsSnapshot,
  resetSettingsSection,
  resolveEffectiveUiConfig,
  rollbackSettings,
  saveUserPrefs,
} from '../../../src/lib/prefs';
import type { AgentMessage } from '../../../src/types';

const USER = 77001;
const OTHER = 77002;
const NOW = new Date('2026-11-24T12:00:00Z');
const CTX: ToolContext = {
  userId: USER,
  timezone: 'UTC',
  baseCurrency: 'EUR',
  now: NOW,
};

function tool(list: readonly Tool[], name: string): Tool {
  const found = list.find((t) => t.name === name);
  if (!found) throw new Error(`tool "${name}" not found`);
  return found;
}

async function runToolCall(
  list: readonly Tool[],
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = CTX,
): Promise<ToolOutcome> {
  const res = await tool(list, name).run(args, ctx);
  return typeof res === 'string' ? { ok: true, content: res } : res;
}

function memoryThreadStore(initial: AgentMessage[] = []): {
  store: AgentThreadStore;
  read: () => AgentMessage[];
} {
  let saved = [...initial];
  return {
    store: {
      async load() {
        return saved.map((m) => ({ ...m }));
      },
      async save(_userId, next) {
        saved = [...next];
      },
      async clear() {
        saved = [];
      },
    },
    read: () => saved,
  };
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetConfigCache();
  setConfigOverrides({
    geminiApiKey: 'AIzaSyTestProductKey1234567890abcdef',
    masterKey: 'master-key-for-config-tests-32chars',
  });
  await ensureUser(USER, 'Alex');
  await ensureUser(OTHER, 'Other');
});

afterEach(() => {
  resetConfigCache();
});

describe('prefs.ts: read-only, 10-step rollback & reset', () => {
  it('чтение user_prefs и captureSettingsState ничего не пишет в kv', async () => {
    const before = await db.all<{ key: string }>(`SELECT "key" FROM kv`);
    expect(before).toEqual([]);

    const prefs = await loadUserPrefs(999999);
    const history = await loadPrefsHistory(999999);
    const state = await captureSettingsState(999999);

    expect(prefs).toEqual({});
    expect(history).toEqual([]);
    expect(state.profile.timezone).toBe('UTC');

    const after = await db.all<{ key: string }>(`SELECT "key" FROM kv`);
    expect(after).toEqual([]);
  });

  it('кольцевой буфер истории хранит не более 10 снимков и откатывает профиль + prefs + стиль', async () => {
    for (let i = 1; i <= 12; i += 1) {
      const snap = await captureSettingsState(USER);
      await pushPrefsSnapshot(USER, `Шаг ${i}`, snap);
      await saveUserPrefs(USER, { assistantName: `Bot${i}` });
      await updateUser(USER, { timezone: i % 2 === 0 ? 'Europe/Belgrade' : 'Europe/Berlin' });
    }

    const history = await loadPrefsHistory(USER);
    expect(history).toHaveLength(MAX_PREFS_HISTORY);
    expect(history[0]?.summary).toBe('Шаг 3');
    expect(history[history.length - 1]?.summary).toBe('Шаг 12');

    const rolled = await rollbackSettings(USER, 2);
    expect(rolled.ok).toBe(true);
    expect(rolled.restoredSummary).toBe('Шаг 11');
    expect(rolled.after.prefs.assistantName).toBe('Bot10');
    expect(rolled.remainingHistory).toBe(8);
  });

  it('resetSettingsSection сохраняет снимок до сброса и позволяет откатить сам сброс', async () => {
    await saveUserPrefs(USER, { assistantName: 'Atlas', ai: { maxSteps: 14, temperature: 0.2 } });
    const resetRes = await resetSettingsSection(USER, 'all');
    expect(resetRes.after.assistantName).toBeUndefined();
    expect(resetRes.after.ai).toBeUndefined();

    const undone = await rollbackSettings(USER, 1);
    expect(undone.ok).toBe(true);
    expect(undone.after.prefs.assistantName).toBe('Atlas');
    expect(undone.after.prefs.ai?.maxSteps).toBe(14);
  });
});

describe('get_settings, update_settings & presets', () => {
  it('update_settings жёстко запрещает секреты (любой регистр) и проверяет наличие ключа провайдера', async () => {
    const secretRejected = await runToolCall(configTools, 'update_settings', {
      api_key: 'AIzaSySecretInChat',
    });
    expect(secretRejected.ok).toBe(false);
    expect(secretRejected.content).toContain('/byok');

    const camelSecretRejected = await runToolCall(configTools, 'update_settings', {
      masterKey: 'secret',
      timezone: 'Europe/Belgrade',
    });
    expect(camelSecretRejected.ok).toBe(false);
    expect((await getUser(USER))?.timezone).toBe('UTC');

    const missingKey = await runToolCall(configTools, 'update_settings', {
      model_provider: 'openai',
    });
    expect(missingKey.ok).toBe(false);
    expect(missingKey.content).toContain('нет доступного API-ключа');
  });

  it('update_settings меняет профиль/AI с diff и manage_presets сохраняет/применяет пресет', async () => {
    const updated = await runToolCall(configTools, 'update_settings', {
      language: 'en',
      timezone: 'Europe/Belgrade',
      base_currency: 'USD',
      summary_time: '8:30',
      low_stimulation_mode: true,
      assistant_name: 'Nova',
      max_steps: 12,
      temperature: 0.3,
    });
    expect(updated.ok).toBe(true);
    expect(updated.content).toContain('UTC → Europe/Belgrade');
    expect(updated.content).toContain('07:00 → 08:30');

    const savedPreset = await runToolCall(configTools, 'manage_presets', {
      action: 'save',
      name: 'Отпуск',
      description: 'Спокойный режим',
    });
    expect(savedPreset.ok).toBe(true);

    // Меняем настройки после сохранения пресета
    await runToolCall(configTools, 'update_settings', {
      timezone: 'UTC',
      low_stimulation_mode: false,
      assistant_name: 'default',
    });
    expect((await getUser(USER))?.timezone).toBe('UTC');

    // Применяем пресет «Отпуск» обратно
    const applied = await runToolCall(configTools, 'manage_presets', {
      action: 'apply',
      name: 'Отпуск',
    });
    expect(applied.ok).toBe(true);
    expect((await getUser(USER))?.timezone).toBe('Europe/Belgrade');
    expect((await getUser(USER))?.lowStimulationMode).toBe(true);
    expect((await loadUserPrefs(USER)).assistantName).toBe('Nova');

    const snapshot = await runToolCall(configTools, 'get_settings', {});
    expect(snapshot.ok).toBe(true);
    expect(snapshot.content).toContain('Nova');
    expect(snapshot.content).toContain('Отпуск');

    // Повторное сохранение кириллического пресета обновляет его на месте без дубликата
    await runToolCall(configTools, 'manage_presets', {
      action: 'save',
      name: 'Отпуск',
      description: 'Обновлённое описание',
    });
    const listPresetsRes = await runToolCall(configTools, 'manage_presets', { action: 'list' });
    expect((listPresetsRes.data as { presets: unknown[] }).presets).toHaveLength(1);

    // Пресет с недоступным ключом провайдера не применяется (защита от блокировки)
    const prefsWithBadPreset = await loadUserPrefs(USER);
    await saveUserPrefs(USER, {
      ...prefsWithBadPreset,
      presets: {
        ...(prefsWithBadPreset.presets ?? {}),
        locked: {
          id: 'locked',
          name: 'Locked',
          snapshot: { profile: { modelProvider: 'anthropic' } },
          updatedAt: NOW.toISOString(),
        },
      },
    });
    const blockedApply = await runToolCall(configTools, 'manage_presets', {
      action: 'apply',
      name: 'Locked',
    });
    expect(blockedApply.ok).toBe(false);
    expect(blockedApply.content).toContain('нет доступного API-ключа');
  });
});

describe('conditional confirmWhen gate & engine overrides via runAgent', () => {
  it('рутинный update_settings идёт без confirm, а смена preferred_model требует «да» и исполняется движком', async () => {
    const nowMs = NOW.getTime();
    const { store } = memoryThreadStore();

    // 1. Рутинное изменение (timezone) выполняется сразу
    let calls1 = 0;
    const routineChat: AgentChatFn = async () => {
      calls1 += 1;
      if (calls1 === 1) {
        return {
          content: '',
          toolCalls: [{ id: 't1', name: 'update_settings', args: { timezone: 'Europe/Belgrade' } }],
        };
      }
      return { content: 'Таймзона обновлена.', toolCalls: [] };
    };
    const r1 = await runAgent({
      userId: USER,
      text: 'поставь таймзону Белград',
      mode: 'action',
      store,
      chatFn: routineChat,
      now: NOW,
      clock: () => nowMs,
    });
    expect(r1.stopReason).toBe('final');
    expect((await getUser(USER))?.timezone).toBe('Europe/Belgrade');

    // 2. Критичное изменение (preferred_model) упирается в confirm
    const modelChat: AgentChatFn = async () => ({
      content: '',
      toolCalls: [{ id: 't2', name: 'update_settings', args: { preferred_model: 'gemini-3.8-flash' } }],
    });
    const r2 = await runAgent({
      userId: USER,
      text: 'переключи модель на gemini-3.8-flash',
      mode: 'action',
      store,
      chatFn: modelChat,
      now: NOW,
      clock: () => nowMs + 1000,
    });
    expect(r2.stopReason).toBe('confirm');
    expect((await loadUserPrefs(USER)).ai?.preferredModel).toBeUndefined();

    // 3. На «да» движок исполняет именно сохранённый вызов без участия модели
    const requests: AgentChatRequest[] = [];
    const confirmChat: AgentChatFn = async (req) => {
      requests.push(req);
      return { content: 'Готово!', toolCalls: [] };
    };
    const r3 = await runAgent({
      userId: USER,
      text: 'да',
      mode: 'action',
      store,
      chatFn: confirmChat,
      now: NOW,
      clock: () => nowMs + 2000,
    });
    expect(r3.stopReason).toBe('final');
    expect((await loadUserPrefs(USER)).ai?.preferredModel).toBe('gemini-3.8-flash');

    // 4. Следующий ход получает preferredModel, provider (если задан BYOK), maxSteps и temperature
    const sealed = await sealByok(USER, 'sk-openai-key-for-test-123456');
    await updateUser(USER, { byok: sealed, modelProvider: 'openai' });
    await runToolCall(configTools, 'update_settings', { max_steps: 11, temperature: 0.25 });

    const captured: AgentChatRequest[] = [];
    await runAgent({
      userId: USER,
      text: 'проверь параметры',
      mode: 'action',
      store,
      chatFn: async (req) => {
        captured.push(req);
        return { content: 'Ок.', toolCalls: [] };
      },
      now: NOW,
      clock: () => nowMs + 3000,
    });
    expect(captured[0]?.provider).toBe('openai');
    expect(captured[0]?.model).toBe('gemini-3.8-flash');
    expect(captured[0]?.temperature).toBe(0.25);
  });

  it('manage_skills activate требует confirm и срабатывает на «да»', async () => {
    const draft = await createManualSkillDraft(USER, {
      key: 'morning-check',
      title: 'Утренний чек',
      whenToUse: 'Утром',
      procedure: '1. Проверь задачи.',
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const { store } = memoryThreadStore();
    const nowMs = NOW.getTime();
    const r1 = await runAgent({
      userId: USER,
      text: 'активируй скилл morning-check',
      mode: 'action',
      store,
      chatFn: async () => ({
        content: '',
        toolCalls: [{ id: 's1', name: 'manage_skills', args: { action: 'activate', skill_id: String(draft.item.id) } }],
      }),
      now: NOW,
      clock: () => nowMs,
    });
    expect(r1.stopReason).toBe('confirm');
    expect((await listAllUserSkills(USER))[0]?.row.status).toBe('pending');

    const r2 = await runAgent({
      userId: USER,
      text: 'да',
      mode: 'action',
      store,
      chatFn: async () => ({ content: 'Скилл включён.', toolCalls: [] }),
      now: NOW,
      clock: () => nowMs + 1000,
    });
    expect(r2.stopReason).toBe('final');
    expect((await listAllUserSkills(USER))[0]?.row.status).toBe('active');
  });

  it('manage_session(reset_thread) действительно оставляет тред пустым после завершения runAgent', async () => {
    const { store, read } = memoryThreadStore([{ role: 'user', content: 'старое сообщение' }]);
    const res = await runAgent({
      userId: USER,
      text: 'сбрось контекст беседы',
      mode: 'action',
      store,
      chatFn: async (req) => {
        if (
          req.messages.some(
            (m) => typeof m.content === 'string' && m.content.includes('Контекст диалога сброшен'),
          )
        ) {
          return { content: 'Контекст очищен!', toolCalls: [] };
        }
        return {
          content: '',
          toolCalls: [{ id: 'rs1', name: 'manage_session', args: { action: 'reset_thread' } }],
        };
      },
      now: NOW,
    });
    expect(res.stopReason).toBe('final');
    expect(res.thread).toEqual([]);
    expect(read()).toEqual([]);
  });
});

describe('мозг бота: правила, кастомные персоны, встроенные скиллы, доки и бэклог', () => {
  it('кастомная персона, имя ассистента и отключённый встроенный скилл отражаются в buildSystemPrompt', async () => {
    const upserted = await runToolCall(configTools, 'manage_personas', {
      action: 'upsert',
      id: 'architect',
      name: 'Системный архитектор',
      instructions: 'Разбирай всё через системные ограничения и чёткие инварианты.',
      activate: true,
    });
    expect(upserted.ok).toBe(true);

    // update_custom_directives принимает кастомную персону без ошибки
    const updDir = await runToolCall(reasoningTools, 'update_custom_directives', {
      instructions: '- Проверяй факты сначала.',
      persona_style: 'architect',
    });
    expect(updDir.ok).toBe(true);

    // Отключение встроенного скилла и установка имени ассистента
    await runToolCall(configTools, 'update_settings', { assistant_name: 'Jarvis' });
    const toggled = await runToolCall(configTools, 'manage_skills', {
      action: 'toggle_builtin',
      builtin_id: 'inbox-triage',
      enabled: false,
      confirm: true,
    });
    expect(toggled.ok).toBe(true);

    const listRes = await runToolCall(reasoningTools, 'list_skills', {});
    expect(listRes.content).toContain('inbox-triage');
    expect(listRes.content).toContain('[отключён]');

    const prefs = await loadUserPrefs(USER);
    const prompt = buildSystemPrompt({
      locale: 'ru',
      profile: {
        userName: 'Alex',
        timezone: 'Europe/Belgrade',
        baseCurrency: 'EUR',
        personaStyle: 'architect',
        customInstructions: '- Проверяй факты сначала.',
        assistantName: prefs.assistantName ?? null,
        customPersonas: prefs.brain?.customPersonas ?? null,
        disabledBuiltinSkills: prefs.brain?.disabledBuiltinSkills ?? null,
      },
      now: NOW,
    });

    expect(prompt).toContain('«Jarvis»');
    expect(prompt).toContain('Системный архитектор: Разбирай всё через системные ограничения');
    expect(prompt).not.toContain('- inbox-triage');

    // Обновление директив БЕЗ указания persona_style сохраняет активную кастомную персону
    const updKeep = await runToolCall(reasoningTools, 'update_custom_directives', {
      instructions: '- Проверяй факты сначала.\n- Пиши структурно.',
    });
    expect(updKeep.ok).toBe(true);
    expect((await captureSettingsState(USER)).directives.style).toBe('architect');
    const dirRead = await runToolCall(reasoningTools, 'get_custom_directives', {});
    expect(dirRead.content).toContain('architect');
    const disabledRead = await runToolCall(reasoningTools, 'read_skill', {
      name_or_id: 'inbox-triage',
    });
    expect((disabledRead.data as { status?: string }).status).toBe('disabled');

    // Встроенную персону удалить нельзя
    const delBuiltin = await runToolCall(configTools, 'manage_personas', {
      action: 'delete',
      id: 'mentor',
      confirm: true,
    });
    expect(delBuiltin.ok).toBe(false);

    // Удаление активной кастомной персоны возвращает стиль к mentor
    const delCustom = await runToolCall(configTools, 'manage_personas', {
      action: 'delete',
      id: 'architect',
      confirm: true,
    });
    expect(delCustom.ok).toBe(true);
    expect((await captureSettingsState(USER)).directives.style).toBe('mentor');
  });

  it('manage_docs защищает 07_custom_instructions и работает с обычными главами; manage_backlog игнорирует скиллы', async () => {
    await upsertChapter(USER, {
      slug: CUSTOM_INSTRUCTIONS_SLUG,
      title: 'Персональные директивы',
      content: '- Тест\n\nСтиль общения: mentor',
      isPinned: true,
    });

    const blocked = await runToolCall(configTools, 'manage_docs', {
      action: 'update',
      slug: CUSTOM_INSTRUCTIONS_SLUG,
      content: 'overwrite',
      confirm: true,
    });
    expect(blocked.ok).toBe(false);

    const updatedDoc = await runToolCall(configTools, 'manage_docs', {
      action: 'update',
      slug: '09_custom_notes',
      title: 'Личные принципы',
      content: '# Личные принципы\nДелай шаг в 2 минуты.',
      confirm: true,
    });
    expect(updatedDoc.ok).toBe(true);
    expect((await getChapter(USER, '09_custom_notes'))?.title).toBe('Личные принципы');

    const addedIdea = await runToolCall(configTools, 'manage_backlog', {
      action: 'add',
      category: 'idea',
      title: 'Добавить недельный дайджест',
      priority: 'high',
    });
    expect(addedIdea.ok).toBe(true);

    const draft = await createManualSkillDraft(USER, {
      key: 'skill-not-backlog',
      title: 'Скилл',
      whenToUse: 'Всегда',
      procedure: '1. Тест',
    });
    if (!draft.ok) throw new Error('expected draft');
    const blockedSkill = await runToolCall(configTools, 'manage_backlog', {
      action: 'delete',
      item_id: draft.item.id,
      confirm: true,
    });
    expect(blockedSkill.ok).toBe(false);
  });
});

describe('категории, подкатегории, create_account и refill_threshold', () => {
  it('manage_categories поддерживает кириллицу и безопасно отвязывает задачи и транзакции без удаления данных', async () => {
    // 1. Категория и подкатегория задач + задача
    await runToolCall(configTools, 'manage_categories', {
      target: 'task_category',
      action: 'create',
      name: 'Работа',
    });
    await runToolCall(configTools, 'manage_categories', {
      target: 'task_subcategory',
      action: 'create',
      parent_category: 'работа',
      name: 'Код-ревью',
    });
    const renamed = await runToolCall(configTools, 'manage_categories', {
      target: 'task_category',
      action: 'rename',
      name: 'работа',
      new_name: 'Проекты',
    });
    expect(renamed.ok).toBe(true);

    const taskCat = await createTaskCategory(USER, 'Временная');
    const task = await createTask(USER, { title: 'Не потерять задачу', categoryId: taskCat.id });

    const delTaskCat = await runToolCall(configTools, 'manage_categories', {
      target: 'task_category',
      action: 'delete',
      name: 'временная',
      confirm: true,
    });
    expect(delTaskCat.ok).toBe(true);
    expect(delTaskCat.content).toContain('отвязано задач: 1');
    const survivingTask = await getTask(USER, task.id);
    expect(survivingTask).not.toBeNull();
    expect(survivingTask?.categoryId).toBeNull();

    // 2. Финансовая категория + транзакция + бюджет
    const acc = await createAccount(USER, { name: 'Main', currency: 'EUR', initialBalanceCents: 10000 });
    const finCat = await createFinCategory(USER, { name: 'Кафе', kind: 'expense' });
    await createTransaction(USER, {
      kind: 'expense',
      accountId: acc.id,
      categoryId: finCat.id,
      amountCents: 500,
      currency: 'EUR',
      description: 'Кофе',
    });
    await setBudget(USER, { categoryId: finCat.id, month: '2026-11', limitAmountEurCents: 20000 });

    const delFinCat = await runToolCall(configTools, 'manage_categories', {
      target: 'fin_category',
      action: 'delete',
      name: 'кафе',
      confirm: true,
    });
    expect(delFinCat.ok).toBe(true);
    expect(delFinCat.content).toContain('отвязано операций: 1');
    const txs = await listTransactions(USER, { limit: 10 });
    expect(txs).toHaveLength(1);
    expect(txs[0]?.categoryId).toBeNull();
  });

  it('create_account создаёт счёт явно, а update_medication обновляет refill_threshold', async () => {
    const accRes = await runToolCall(financeTools, 'create_account', {
      name: 'Revolut',
      currency: 'EUR',
      initial_balance: '250.50',
      envelope: 'reserved',
    });
    expect(accRes.ok).toBe(true);
    const accounts = await listAccounts(USER);
    expect(accounts.some((a) => a.name === 'Revolut' && a.currentBalanceCents === 25050 && a.envelope === 'reserved')).toBe(true);

    await createMedication(USER, { name: 'Магний', dosage: '400 мг', times: ['21:00'], stockCount: 20 });
    const medRes = await runToolCall(medicationTools, 'update_medication', {
      name: 'Магний',
      refill_threshold: 7,
    });
    expect(medRes.ok).toBe(true);
    expect(medRes.content).toContain('порог пополнения: 7 шт.');
    const meds = await listMedications(USER);
    expect(meds[0]?.refillThreshold).toBe(7);
  });
});

describe('Волна 2: конфиг поведения, финансов, дневника и проактивности', () => {
  it('evaluateRoutineSchedule, isInQuietHours и parseWeekdaysInput корректно считают окна', () => {
    expect(parseWeekdaysInput('пн, ср, пт')).toEqual([0, 2, 4]);
    expect(parseWeekdaysInput('будни')).toEqual([0, 1, 2, 3, 4]);
    expect(parseWeekdaysInput('выходные')).toEqual([5, 6]);

    const qh = { enabled: true, start: '23:00', end: '07:00' };
    expect(isInQuietHours(new Date('2026-11-24T23:30:00.000Z'), 'UTC', qh)).toBe(true);
    expect(isInQuietHours(new Date('2026-11-25T06:59:00.000Z'), 'UTC', qh)).toBe(true);
    expect(isInQuietHours(new Date('2026-11-25T07:00:00.000Z'), 'UTC', qh)).toBe(false);
    expect(isInQuietHours(new Date('2026-11-25T15:00:00.000Z'), 'UTC', qh)).toBe(false);

    // Ночной wraparound + monthly на 31-е число в коротком месяце (апрель -> 30-е)
    const nightRoutine = {
      id: 'night_check',
      name: 'Ночная сверка',
      enabled: true,
      kind: 'text' as const,
      schedule: 'weekly' as const,
      time: '23:00',
      weekdays: [0], // понедельник (2026-11-23)
      windowMinutes: 180,
      message: 'Сверка',
      updatedAt: NOW.toISOString(),
    };
    const afterMidnightTue = new Date('2026-11-24T00:30:00.000Z');
    const evalNight = evaluateRoutineSchedule(nightRoutine, afterMidnightTue, 'UTC');
    expect(evalNight.due).toBe(true);
    expect(evalNight.triggerDayKey).toBe('2026-11-23');

    const monthlyRoutine = {
      id: 'rent_reminder',
      name: 'Аренда',
      enabled: true,
      kind: 'text' as const,
      schedule: 'monthly' as const,
      time: '10:00',
      dayOfMonth: 31,
      message: 'Пора платить',
      updatedAt: NOW.toISOString(),
    };
    const evalApril30 = evaluateRoutineSchedule(
      monthlyRoutine,
      new Date('2026-04-30T10:30:00.000Z'),
      'UTC',
    );
    expect(evalApril30.due).toBe(true);
    expect(evalApril30.triggerDayKey).toBe('2026-04-30');
  });

  it('update_settings / get_settings обновляют СДВГ, финансы, дневник и проактивность, пресеты их сохраняют', async () => {
    const invalidNight = await runToolCall(configTools, 'update_settings', {
      overload_night_start_hour: 22,
      overload_night_end_hour: 22,
    });
    expect(invalidNight.ok).toBe(false);

    const badDigest = await runToolCall(configTools, 'update_settings', {
      morning_digest_sections: 'focus,unknown_section',
    });
    expect(badDigest.ok).toBe(false);

    const updated = await runToolCall(configTools, 'update_settings', {
      overload_shield_enabled: false,
      overload_overdue_threshold: 5,
      overload_active_todo_threshold: 20,
      overload_night_start_hour: 22,
      overload_night_end_hour: 7,
      focus_limit: 5,
      stale_after_days: 4,
      finance_alias_account: 'Основная карта',
      finance_alias_patterns: 'основной, зарплата',
      finance_default_currency: 'EUR',
      finance_default_account: 'Основная карта',
      finance_reserve_eur: 1500,
      runway_daily_burn_override_eur: 45,
      runway_horizon_days: 14,
      diary_sections: 'Фокус, Благодарность, Заметки',
      diary_include_tasks: false,
      diary_header_template: '# Запись {date} ({weekday})',
      quiet_hours_enabled: true,
      quiet_hours_start: '23:00',
      quiet_hours_end: '07:30',
      morning_digest_window_minutes: 240,
      morning_digest_sections: 'focus, finance',
      liability_warning_days: 5,
      liability_review_enabled: false,
      medication_reminder_window_minutes: 90,
      nightly_consolidation_hour: 4,
      nightly_consolidation_note_limit: 40,
    });
    expect(updated.ok).toBe(true);
    expect(updated.content).toContain('СДВГ-щит');
    expect(updated.content).toContain('Лимит фокуса дня');
    expect(updated.content).toContain('Финансовый резерв (EUR)');
    expect(updated.content).toContain('Тихие часы');

    // Пользовательский алиас из prefs работает в финансовом парсере
    await createAccount(USER, { name: 'Основная карта', currency: 'EUR', initialBalanceCents: 10000 });
    await createAccount(USER, { name: 'Наличные', currency: 'EUR', initialBalanceCents: 5000 });
    const prefs = await loadUserPrefs(USER);
    const parsedBal = parseBalanceDeclaration('основной 300 евро', 'EUR', prefs.finance);
    expect(parsedBal?.account).toBe('Основная карта');
    const parsedTx = parseFinancialIntent('потратил 12 евро кофе', 'EUR', prefs.finance);
    expect(parsedTx?.account).toBe('Основная карта');

    // Секции get_settings отображают настройки
    const got = await runToolCall(configTools, 'get_settings', { section: 'all' });
    expect(got.ok).toBe(true);
    expect(got.content).toContain('Основная карта');
    expect(got.content).toContain('1500 €');
    expect(got.content).toContain('23:00–07:30');

    // Сохранение и восстановление Wave 2 через пресет + откат
    await runToolCall(configTools, 'manage_presets', { action: 'save', name: 'Глубокий режим' });
    const resetAdhd = await runToolCall(configTools, 'reset_or_rollback_settings', {
      action: 'reset',
      section: 'adhd',
      confirm: true,
    });
    expect(resetAdhd.ok).toBe(true);
    expect((await loadUserPrefs(USER)).adhd).toBeUndefined();

    const restored = await runToolCall(configTools, 'manage_presets', {
      action: 'apply',
      name: 'Глубокий режим',
    });
    expect(restored.ok).toBe(true);
    const afterRestore = await loadUserPrefs(USER);
    expect(afterRestore.adhd?.focusLimit).toBe(5);
    expect(afterRestore.adhd?.overloadShield?.overdueTaskCount ?? DEFAULT_OVERLOAD_OVERDUE_THRESHOLD).toBe(5);
    expect(afterRestore.finance?.reserveCents).toBe(150_000);
    expect(afterRestore.proactive?.quietHours?.enabled).toBe(true);

    // Снятие алиаса и сброс резерва нулём
    const clearedAlias = await runToolCall(configTools, 'update_settings', {
      finance_alias_account: 'Основная карта',
      finance_alias_patterns: '',
      finance_reserve_eur: 0,
      runway_horizon_days: 0,
    });
    expect(clearedAlias.ok).toBe(true);
    const afterClear = await loadUserPrefs(USER);
    expect(afterClear.finance?.accountAliases).toBeUndefined();
    expect(afterClear.finance?.reserveCents).toBeUndefined();
    expect(afterClear.finance?.runway?.horizonDays).toBeUndefined();
  });

  it('manage_routines: CRUD, allow_writes confirmWhen, bypass guard, лимит 3 AI и preview без deadlock', async () => {
    const metaTool = tool(configTools, 'manage_routines');
    expect(metaTool.confirmWhen?.({ action: 'upsert', kind: 'text' })).toBe(false);
    expect(metaTool.confirmWhen?.({ action: 'upsert', kind: 'ai', tool_access: 'read-only' })).toBe(false);
    expect(metaTool.confirmWhen?.({ action: 'upsert', kind: 'ai', tool_access: 'allow_writes' })).toBe(true);
    expect(metaTool.confirmWhen?.({ action: 'delete', id: 'water' })).toBe(true);

    // 1. Создание лёгкой text-рутины без подтверждения
    const water = await runToolCall(configTools, 'manage_routines', {
      action: 'upsert',
      name: 'Вода и пауза',
      kind: 'text',
      schedule: 'weekly',
      weekdays: 'будни',
      time: '15:00',
      message: 'Выпей стакан воды и разомни спину.',
    });
    expect(water.ok).toBe(true);
    expect(water.content).toContain('добавлена');

    // 2. Preview для text и summary работает
    const previewWater = await runToolCall(configTools, 'manage_routines', {
      action: 'preview',
      name: 'Вода и пауза',
    });
    expect(previewWater.ok).toBe(true);
    expect(previewWater.content).toContain('Выпей стакан воды');

    // 3. AI-рутина с allow_writes в runAgent требует "да", а редактирование без tool_access блокируется
    const seenPrompts: string[] = [];
    const allowChat: AgentChatFn = async () => ({
      content: '',
      toolCalls: [
        {
          id: 'r1',
          name: 'manage_routines',
          args: {
            action: 'upsert',
            id: 'ai_writes',
            name: 'AI Планировщик',
            kind: 'ai',
            schedule: 'daily',
            time: '19:00',
            prompt: 'Разбери входящие заметки',
            tool_access: 'allow_writes',
          },
        },
      ],
    });
    const store = memoryThreadStore();
    const firstTurn = await runAgent({
      userId: USER,
      text: 'Создай AI рутину с записью',
      tools: configTools,
      store: store.store,
      chatFn: allowChat,
    });
    expect(firstTurn.stopReason).toBe('confirm');
    expect((await loadUserPrefs(USER)).proactive?.routines?.ai_writes).toBeUndefined();

    const confirmTurn = await runAgent({
      userId: USER,
      text: 'да',
      tools: configTools,
      store: store.store,
      chatFn: async (req) => {
        seenPrompts.push(req.systemPrompt);
        return { content: 'Создал AI-рутину.', toolCalls: [] };
      },
    });
    expect(confirmTurn.stopReason).toBe('final');
    const afterConfirm = await loadUserPrefs(USER);
    expect(afterConfirm.proactive?.routines?.ai_writes?.toolAccess).toBe('allow_writes');

    // Защита от обхода confirmWhen: изменение существующей allow_writes рутины без tool_access (или с tool_access: null) запрещено
    const bypassAttempt = await runToolCall(configTools, 'manage_routines', {
      action: 'upsert',
      id: 'ai_writes',
      prompt: 'Новый промпт без явного tool_access',
    });
    expect(bypassAttempt.ok).toBe(false);
    expect(bypassAttempt.content).toContain('tool_access');

    const nullBypassAttempt = await runToolCall(configTools, 'manage_routines', {
      action: 'upsert',
      id: 'ai_writes',
      prompt: 'Новый промпт с tool_access: null',
      tool_access: null,
    });
    expect(nullBypassAttempt.ok).toBe(false);
    expect(nullBypassAttempt.content).toContain('tool_access');

    // 4. Dry preview для AI НЕ запускает LLM
    const previewAi = await runToolCall(configTools, 'manage_routines', {
      action: 'preview',
      id: 'ai_writes',
    });
    expect(previewAi.ok).toBe(true);
    expect(previewAi.content).toContain('Dry-preview AI-рутины');
    expect(previewAi.content).toContain('allow_writes');

    // 5. Лимит: не более 3 активных AI-рутин
    expect((await runToolCall(configTools, 'manage_routines', {
      action: 'upsert',
      id: 'ai_2',
      name: 'AI 2',
      kind: 'ai',
      schedule: 'daily',
      time: '10:00',
      prompt: 'Промпт 2',
    })).ok).toBe(true);
    expect((await runToolCall(configTools, 'manage_routines', {
      action: 'upsert',
      id: 'ai_3',
      name: 'AI 3',
      kind: 'ai',
      schedule: 'daily',
      time: '12:00',
      prompt: 'Промпт 3',
    })).ok).toBe(true);
    expect(countActiveAiRoutines((await loadUserPrefs(USER)).proactive?.routines)).toBe(3);

    const fourthAi = await runToolCall(configTools, 'manage_routines', {
      action: 'upsert',
      id: 'ai_4',
      name: 'AI 4',
      kind: 'ai',
      schedule: 'daily',
      time: '14:00',
      prompt: 'Промпт 4',
    });
    expect(fourthAi.ok).toBe(false);
    expect(fourthAi.content).toContain('3 активных AI-рутин');

    // Пауза одной AI-рутины освобождает слот для новой, а попытка resume сверх лимита отклоняется
    expect((await runToolCall(configTools, 'manage_routines', { action: 'pause', id: 'ai_2' })).ok).toBe(true);
    expect((await runToolCall(configTools, 'manage_routines', {
      action: 'upsert',
      id: 'ai_4',
      name: 'AI 4',
      kind: 'ai',
      schedule: 'daily',
      time: '14:00',
      prompt: 'Промпт 4',
    })).ok).toBe(true);
    const overflowResume = await runToolCall(configTools, 'manage_routines', { action: 'resume', id: 'ai_2' });
    expect(overflowResume.ok).toBe(false);

    // Сброс секции routines оставляет тихие часы нетронутыми
    await runToolCall(configTools, 'update_settings', { quiet_hours_enabled: true });
    const resetRoutines = await runToolCall(configTools, 'reset_or_rollback_settings', {
      action: 'reset',
      section: 'routines',
    });
    expect(resetRoutines.ok).toBe(true);
    const afterReset = await loadUserPrefs(USER);
    expect(afterReset.proactive?.routines).toBeUndefined();
    expect(afterReset.proactive?.quietHours?.enabled).toBe(true);
  });

  it('runAgent(background: true): вырезает destroy/manage_routines/reset и блокирует confirmWhen-тулзы', async () => {
    const store = memoryThreadStore();
    const seenToolNames: string[][] = [];
    let calls = 0;

    const bgRes = await runAgent({
      userId: USER,
      text: 'Проверь и почисти старые данные',
      tools: configTools,
      store: store.store,
      background: true,
      backgroundDirective: 'ТЕСТОВАЯ ФОНОВАЯ ДИРЕКТИВА',
      toolAccess: 'full',
      chatFn: async (req) => {
        calls += 1;
        seenToolNames.push((req.tools ?? []).map((t) => t.name));
        expect(req.systemPrompt).toContain('ТЕСТОВАЯ ФОНОВАЯ ДИРЕКТИВА');
        if (calls === 1) {
          return {
            content: '',
            toolCalls: [
              // update_settings с preferred_model требует confirmWhen -> в фоне должен быть заблокирован даже с confirm: true
              { id: 'c1', name: 'update_settings', args: { preferred_model: 'gpt-4o', confirm: true } },
            ],
          };
        }
        return { content: 'Готово без запрещённых вызовов.', toolCalls: [] };
      },
    });

    expect(seenToolNames[0]).not.toContain('manage_routines');
    expect(seenToolNames[0]).not.toContain('reset_or_rollback_settings');
    expect(bgRes.steps[0]?.ok).toBe(false);
    expect(bgRes.steps[0]?.observation).toContain('подтверждения');
    expect((await loadUserPrefs(USER)).ai?.preferredModel).toBeUndefined();
    expect(store.read()).toHaveLength(0);

    // Проверка текстового ReAct-фолбэка в фоне с подброшенным confirm: true
    let textCalls = 0;
    const textBgRes = await runAgent({
      userId: USER,
      text: 'Смени модель через текстовый вызов',
      tools: configTools,
      store: store.store,
      background: true,
      toolAccess: 'full',
      chatFn: async () => {
        textCalls += 1;
        if (textCalls === 1) {
          return {
            content:
              'Thought: пробую сменить модель\nAction: update_settings\nAction Input: {"preferred_model": "gpt-4o", "confirm": true}',
            toolCalls: [],
          };
        }
        return { content: 'Final Answer: Не удалось.', toolCalls: [] };
      },
    });
    expect(textBgRes.steps[0]?.ok).toBe(false);
    expect(textBgRes.steps[0]?.observation).toContain('подтверждения');
    expect((await loadUserPrefs(USER)).ai?.preferredModel).toBeUndefined();
  });

  it('normalizeMiniAppPrefs, resolveEffectiveUiConfig, buildSettingsPrefsSummary и configTools (Волна 3)', async () => {
    // 1. Нормализация вкладок (алиас assistant -> system, дубли, анти-локаут) и ролей счетов
    const normTabs = normalizeMiniAppPrefs({
      tabs: ['finances', 'assistant', 'finances', 'unknown', 'today'],
      accountThemes: [
        { pattern: 'Main Card', theme: 'primary', shortName: 'Main', roleLabel: 'Daily spend' },
        { pattern: 'main card', theme: 'secondary', shortName: 'Duplicate' },
        { pattern: 'EmptyOnly' },
      ],
    });
    expect(normTabs?.tabs).toEqual(['finances', 'system', 'today']);
    expect(normTabs?.accountThemes).toHaveLength(1);

    const antiLockout = normalizeMiniAppPrefs({ tabs: ['today', 'tasks'] });
    expect(antiLockout?.tabs).toEqual(['today', 'tasks', 'system']);

    // 2. resolveEffectiveUiConfig: дефолты оверлея против оверрайдов UserPrefs
    const manifest = getOverlay().manifest;
    const defaultUi = resolveEffectiveUiConfig(manifest, {}, 'en');
    expect(defaultUi.brand.assistantName).toBe(manifest.brand.assistantName);
    expect(defaultUi.miniapp.tabs).toEqual(manifest.miniapp.tabs);

    const populatedPrefs = await saveUserPrefs(USER, {
      assistantName: 'Nova',
      adhd: { focusLimit: 2, staleAfterDays: 4 },
      finance: {
        reserveCents: 25_000,
        accountAliases: [{ account: 'Travel Card', patterns: ['travel', 'tc'] }],
      },
      brain: {
        customPersonas: {
          coach: {
            id: 'coach',
            name: 'Coach',
            description: 'Calm coach',
            instructions: 'Be concise.',
            updatedAt: '2026-11-24T12:00:00Z',
          },
        },
      },
      proactive: {
        routines: {
          morning: {
            id: 'morning',
            name: 'Morning ping',
            enabled: true,
            kind: 'text',
            schedule: 'daily',
            time: '09:00',
            message: 'Start slow',
            updatedAt: '2026-11-24T12:00:00Z',
          },
        },
      },
      miniapp: {
        tabs: ['today', 'finances', 'system'],
        accountThemes: [
          { pattern: 'Travel Card', theme: 'secondary', shortName: 'Travel', roleLabel: 'Trips' },
        ],
      },
    });

    const effectiveUi = resolveEffectiveUiConfig(manifest, populatedPrefs, 'en');
    expect(effectiveUi.brand.assistantName).toBe('Nova');
    expect(effectiveUi.brand.localizedNames.ru).toBe('Nova');
    expect(effectiveUi.finance.reserveAmount).toBe(250);
    expect(effectiveUi.finance.accountAliases[0]?.account).toBe('Travel Card');
    expect(effectiveUi.miniapp.tabs).toEqual(['today', 'finances', 'system']);
    expect(effectiveUi.miniapp.accountThemes[0]).toMatchObject({
      pattern: 'Travel Card',
      theme: 'secondary',
      shortName: 'Travel',
      roleLabel: 'Trips',
    });
    expect(effectiveUi.adhd.focusLimit).toBe(2);
    expect(effectiveUi.personas.map((p) => p.id)).toEqual(['coach']);
    expect(effectiveUi.summary).toEqual({
      activeRoutinesCount: 1,
      totalRoutinesCount: 1,
      presetsCount: 0,
    });

    // 3. buildSettingsPrefsSummary: modelProvider='gemini' по умолчанию не даёт ложного has_overrides
    const defaultSnap = await captureSettingsState(OTHER);
    const geminiDefaultSummary = buildSettingsPrefsSummary(
      { ...defaultSnap, profile: { ...defaultSnap.profile, modelProvider: 'gemini' } },
      0,
    );
    expect(geminiDefaultSummary.prefs_summary.has_overrides).toBe(false);

    const snap = await captureSettingsState(USER);
    const summary = buildSettingsPrefsSummary(snap, 2);
    expect(summary.assistant_name).toBe('Nova');
    expect(summary.prefs_summary.has_overrides).toBe(true);
    expect(summary.prefs_summary.history_count).toBe(2);
    expect(summary.prefs_summary.miniapp).toEqual({
      tabs: ['today', 'finances', 'system'],
      account_themes_count: 1,
    });
    expect(summary.routines).toHaveLength(1);

    // 4. update_settings / get_settings с секцией miniapp
    const badTab = await runToolCall(configTools, 'update_settings', {
      miniapp_tabs: 'today, bogus_tab',
    });
    expect(badTab.ok).toBe(false);

    const noPattern = await runToolCall(configTools, 'update_settings', {
      miniapp_account_theme: 'primary',
    });
    expect(noPattern.ok).toBe(false);

    const updTabs = await runToolCall(configTools, 'update_settings', {
      miniapp_tabs: 'finances, tasks',
    });
    expect(updTabs.ok).toBe(true);
    expect((await loadUserPrefs(USER)).miniapp?.tabs).toEqual(['finances', 'tasks', 'system']);

    const updRole = await runToolCall(configTools, 'update_settings', {
      miniapp_account_pattern: 'Main Card',
      miniapp_account_theme: 'primary',
      miniapp_account_short_name: 'Main',
      miniapp_account_role_label: 'Everyday spending',
    });
    expect(updRole.ok).toBe(true);
    expect((await loadUserPrefs(USER)).miniapp?.accountThemes?.some((a) => a.pattern === 'Main Card')).toBe(true);

    const gotMini = await runToolCall(configTools, 'get_settings', { section: 'miniapp' });
    expect(gotMini.ok).toBe(true);
    expect(gotMini.content).toContain('Main Card');

    // Удаление роли по reset sentinel
    const rmRole = await runToolCall(configTools, 'update_settings', {
      miniapp_account_pattern: 'Main Card',
      miniapp_account_role_label: 'default',
    });
    expect(rmRole.ok).toBe(true);
    expect((await loadUserPrefs(USER)).miniapp?.accountThemes?.some((a) => a.pattern === 'Main Card')).toBe(false);

    // Сброс вкладок к дефолту
    const resetTabs = await runToolCall(configTools, 'update_settings', {
      miniapp_tabs: 'default',
    });
    expect(resetTabs.ok).toBe(true);
    expect((await loadUserPrefs(USER)).miniapp?.tabs).toBeUndefined();

    // Проверка formatSettingsDiff на miniapp
    const snapAfter = await captureSettingsState(USER);
    const diffText = formatSettingsDiff(snap, snapAfter);
    expect(diffText).toContain('Вкладки Mini App');
  });
});
