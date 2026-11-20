/**
 * Тулзы агента: глубокое рассуждение и персональные директивы (SPEC §3 T12,
 * паритет с `backend/app/agent/tools/reasoning.py`).
 *
 * `synthesize_life_context` — NotebookLM-режим: собирает досье из реальных
 * данных пользователя (заметки, сырой буфер, граф знаний, обязательства,
 * задачи, препараты). Ничего не выдумывает, только читает DAL.
 *
 * Отличия от upstream (осознанно, SPEC §8):
 *  - ADR-003: деньги — целые центы, никакой FX-математики. Вместо одного
 *    float-итога «~X EUR» печатаются посуммовые суммы по валютам
 *    (`formatMoney`), регулярные платежи — тоже в центах своей валюты;
 *  - в TS нет русского парсинга и `ZoneInfo`: всё время — из `ctx`;
 *  - заметки берутся из колонок `note` (upstream `self | useful`) и `idea`
 *    (`ideas`), архив в порте отдельной колонкой не существует;
 *  - KG-фолбэк досье: `listEntities` сортирует по имени, поэтому в порте
 *    сущности пересортировываются в JS по `createdAt` DESC; связи берутся
 *    только активные (`listRelations` фильтрует `valid_to IS NULL`);
 *  - `persona_style` не хранится отдельной колонкой (в `users` её нет): стиль
 *    дописывается в главу директив хвостом «Стиль общения: X» и читается оттуда;
 *    кэш директив в памяти не портирован;
 *  - директивы живут в главе документации `07_custom_instructions`
 *    (заголовок «Персональные директивы»), запись — через `upsertChapter`.
 */

import type { NoteRow, RelationRow, TaskRow } from '../../../types';
import { DEFAULT_TIMEZONE } from '../../config';
import { getChapter, upsertChapter } from '../../dal/docs';
import { listLiabilities } from '../../dal/finances';
import { listDoses, listMedications } from '../../dal/medications';
import {
  getEntity,
  listEntities,
  listEntityRelationsBidirectional,
  matchesEntityQuery,
  normalizeEntityName,
} from '../../dal/misc';
import { listNotes } from '../../dal/notes';
import { listCategories, listTasks } from '../../dal/tasks';
import { getUser } from '../../dal/users';
import { dateKey, formatMoney, sumCents } from '../../utils';
import {
  CUSTOM_INSTRUCTIONS_SLUG,
  computeWorkloadMetrics,
  evaluateExecutiveOverload,
  formatOverloadReasons,
} from '../constants';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry';
import { asText, errorText, fail, snippet } from './tasks';
import { formatLearnedRuleReply, rememberRule } from '../../learning';

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

/** Текст заметки для досье: `clean_text` приоритетнее `raw_text`. */
function noteText(note: NoteRow): string {
  return (note.cleanText ?? note.rawText ?? '').trim();
}

interface DossierKgRow {
  entity: string;
  kind: string;
  description: string;
  relation: string;
}

/** Первая активная связь сущности (исходящая или входящая). */
async function firstRelation(
  userId: number,
  entityId: number,
  entityName?: string,
): Promise<string> {
  let relations: RelationRow[];
  try {
    relations = await listEntityRelationsBidirectional(userId, entityId);
  } catch {
    return '';
  }
  if (relations.length === 0) return '';

  const relation = relations.find((item) => item.subjectId === entityId) ?? relations[0];
  if (!relation) return '';

  if (relation.subjectId === entityId) {
    let targetName = '';
    try {
      const target = await getEntity(userId, relation.objectId);
      targetName = target ? target.name : '';
    } catch {
      targetName = '';
    }
    return targetName ? `${relation.predicate} ${targetName}` : relation.predicate;
  }

  let sourceName = '';
  try {
    const source = await getEntity(userId, relation.subjectId);
    sourceName = source ? source.name : '';
  } catch {
    sourceName = '';
  }
  let resolvedEntityName = entityName?.trim() ?? '';
  if (!resolvedEntityName) {
    try {
      const self = await getEntity(userId, entityId);
      resolvedEntityName = self ? self.name : '';
    } catch {
      resolvedEntityName = '';
    }
  }
  if (sourceName && resolvedEntityName) {
    return `${sourceName} — ${relation.predicate} → ${resolvedEntityName}`;
  }
  return sourceName ? `${sourceName} — ${relation.predicate}` : `← ${relation.predicate}`;
}

/**
 * KG-блок досье: при наличии темы — сущности, чьё имя/алиасы/описание содержит тему;
 * иначе — шесть самых свежих сущностей пользователя.
 */
async function dossierKnowledge(
  ctx: ToolContext,
  topic: string | null,
  limit: number,
): Promise<DossierKgRow[]> {
  const entities = await listEntities(ctx.userId, { limit: 200 });

  const byFreshness = (): typeof entities =>
    [...entities].sort((a, b) => {
      const left = a.createdAt ?? '';
      const right = b.createdAt ?? '';
      return right.localeCompare(left);
    });

  let picked = entities;
  if (topic) {
    const needle = normalizeEntityName(topic);
    if (needle) {
      picked = entities.filter((entity) => matchesEntityQuery(entity, needle));
    }
  }
  // Upstream: пустой тематический ответ KG → топ свежих сущностей.
  if (picked.length === 0) picked = byFreshness();

  const rows: DossierKgRow[] = [];
  for (const entity of picked) {
    if (rows.length >= limit) break;
    rows.push({
      entity: entity.name,
      kind: entity.kind,
      description: entity.description ?? '',
      relation: await firstRelation(ctx.userId, entity.id, entity.name),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// synthesize_life_context
// ---------------------------------------------------------------------------

async function synthesizeLifeContext(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const topic = asText(args.topic);

  try {
    // 1. Заметки: «о себе» и «идеи», свежие сверху; с темой — подстрочный фильтр.
    const allNotes = await listNotes(ctx.userId, { limit: 500 });
    const richNotes = allNotes.filter((note) => note.column === 'note' || note.column === 'idea');

    let notes: NoteRow[];
    if (topic) {
      const needle = topic.toLowerCase();
      notes = richNotes
        .filter((note) => `${note.rawText ?? ''}\n${note.cleanText ?? ''}`.toLowerCase().includes(needle))
        .slice(0, 6);
    } else {
      const priority = (note: NoteRow): number => (note.column === 'note' ? 1 : 2);
      notes = [...richNotes]
        .sort((a, b) => priority(a) - priority(b))
        .slice(0, 6);
    }

    // 1.1 Сырой буфер.
    const rawNotes = await listNotes(ctx.userId, { column: 'raw', limit: 5 });

    // 2. Граф знаний.
    const kgRows = await dossierKnowledge(ctx, topic, 6);

    // 3. Обязательства (ADR-003: посуммовые центы по валютам).
    const liabilities = await listLiabilities(ctx.userId, 'active');

    // 4. Активные задачи верхнего уровня (полная выборка для WIP/просрочки, срез 6 для показа).
    const now = ctx.now instanceof Date && !Number.isNaN(ctx.now.getTime()) ? ctx.now : new Date();
    const user = await getUser(ctx.userId);
    const timezone = ctx.timezone?.trim() || user?.timezone?.trim() || DEFAULT_TIMEZONE;
    const localDateStr = dateKey(now, timezone);

    const allTodoTasks: TaskRow[] = await listTasks(ctx.userId, {
      status: 'todo',
      parentId: null,
      autoAdvance: false,
      limit: 500,
    });
    const tasks = allTodoTasks.slice(0, 6);
    const categories = await listCategories(ctx.userId);
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

    // 5. Препараты и дозы на сегодня.
    const [medications, doses] = await Promise.all([
      listMedications(ctx.userId),
      listDoses(ctx.userId, localDateStr),
    ]);

    const { activeTodoCount, overdueTaskCount, missedMedsCount } = computeWorkloadMetrics(
      allTodoTasks,
      doses,
      timezone,
      now,
    );
    const executiveOverload = evaluateExecutiveOverload({
      lowStimulationMode: Boolean(user?.lowStimulationMode),
      timezone,
      now,
      overdueTaskCount,
      activeTodoCount,
      missedMedsCount,
      userText: topic ?? undefined,
    });

    const sections: string[] = ['💾 **Срез реальных данных из вашей базы:**'];

    if (notes.length > 0) {
      sections.push('\n📝 **Заметки и мысли:**');
      for (const note of notes) {
        sections.push(`• [${note.column}] ${noteText(note)}`);
      }
    }

    if (rawNotes.length > 0) {
      sections.push('\n📥 **Свежие мысли и инбокс (raw / inbox):**');
      for (const note of rawNotes) {
        sections.push(`• [${note.column}] ${snippet(noteText(note), 100)}`);
      }
    }

    if (kgRows.length > 0) {
      sections.push('\n🧠 **Связи, проекты и ключевые сущности:**');
      for (const row of kgRows) {
        const desc = row.description?.trim() ? `: ${row.description.trim()}` : '';
        const relation = row.relation ? ` -> ${row.relation}` : '';
        sections.push(
          `• ${row.entity} (${row.kind || 'сущность'})${desc}${relation}`,
        );
      }
    }

    if (liabilities.length > 0) {
      const byCurrency = new Map<string, number[]>();
      for (const liability of liabilities) {
        const bucket = byCurrency.get(liability.currency) ?? [];
        bucket.push(liability.amountCents);
        byCurrency.set(liability.currency, bucket);
      }
      const totals = [...byCurrency.entries()]
        .map(([currency, cents]) => formatMoney(sumCents(cents), currency))
        .join(', ');

      const payments = liabilities
        .filter((liability) => liability.monthlyPaymentCents > 0)
        .map(
          (liability) =>
            `${liability.name}: ${formatMoney(liability.monthlyPaymentCents, liability.currency)} (день ${liability.paymentDay ?? '—'})`,
        );

      sections.push('\n💳 **Финансовые обязательства:**');
      sections.push(`• Общий объём долгов/кредитов: ~${totals}`);
      if (payments.length > 0) {
        sections.push(`• Регулярные платежи: ${payments.join('; ')}`);
      }
    }

    if (tasks.length > 0) {
      sections.push('\n✅ **Текущие задачи и фокус:**');
      for (const task of tasks) {
        const name = task.categoryId !== null ? categoryNames.get(task.categoryId) : undefined;
        const category = name ? ` [${name}]` : '';
        sections.push(`• ${task.title}${category}`);
      }
    }

    if (medications.length > 0) {
      sections.push('\n💊 **Приём препаратов:**');
      for (const medication of medications) {
        const times = medication.times.length > 0 ? ` в ${medication.times.join(', ')}` : '';
        sections.push(`• ${medication.name} (${medication.dosage || '—'})${times}`);
      }
    }

    const overloadReasons = formatOverloadReasons(executiveOverload);
    sections.push('\n### СДВГ-статус и когнитивная нагрузка');
    sections.push(
      `• Режим: ${executiveOverload.isOverloaded ? 'ПЕРЕГРУЗ / ЩИТ АКТИВЕН' : 'Норма'}`,
    );
    sections.push(
      `• Активные задачи: ${executiveOverload.activeTodoCount}, просроченные: ${executiveOverload.overdueTaskCount}, пропущенные приёмы лекарств: ${executiveOverload.missedMedsCount}`,
    );
    sections.push(
      overloadReasons.length > 0
        ? `• Активные факторы: ${overloadReasons.join('; ')}`
        : '• Активные факторы: не выявлены',
    );
    if (executiveOverload.isOverloaded) {
      sections.push(
        '• Правило коучинга: сужай действие до ОДНОГО конкретного физического микро-шага длительностью ≤ 2 минут без давления и чувства вины.',
      );
    }
    sections.push(
      '• Строгое правило: не переноси, не редактируй и не удаляй задачи пользователя в БД автоматически без явной просьбы по конкретной задаче.',
    );

    return {
      ok: true,
      content: sections.join('\n'),
      data: {
        topic,
        notes: notes.length,
        raw_notes: rawNotes.length,
        knowledge: kgRows.length,
        liabilities: liabilities.length,
        tasks: tasks.length,
        medications: medications.length,
        executiveOverload,
      },
    };
  } catch (error) {
    return fail(`Не удалось собрать контекст жизни: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// update_custom_directives / get_custom_directives
// ---------------------------------------------------------------------------

const DIRECTIVES_TITLE = 'Персональные директивы';
const STYLE_TAIL = 'Стиль общения: ';
const STYLES: readonly string[] = ['mentor', 'strategist', 'calm_partner', 'concise'];

interface DirectivesState {
  instructions: string;
  style: string;
}

/** Разбор главы директив: текст + хвост «Стиль общения: X» (ADR: в `users` колонки нет). */
function parseDirectives(content: string): DirectivesState {
  const trimmed = content.trim();
  const marker = trimmed.lastIndexOf(`\n${STYLE_TAIL}`);
  if (marker === -1) return { instructions: trimmed, style: 'mentor' };
  const style = trimmed.slice(marker + STYLE_TAIL.length + 1).trim();
  const instructions = trimmed.slice(0, marker).trim();
  return { instructions, style: STYLES.includes(style) ? style : 'mentor' };
}

async function readDirectives(ctx: ToolContext): Promise<DirectivesState> {
  const chapter = await getChapter(ctx.userId, CUSTOM_INSTRUCTIONS_SLUG);
  return parseDirectives(chapter?.content ?? '');
}

async function updateCustomDirectives(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const instructions = asText(args.instructions);
  if (!instructions) return fail('Укажите новые директивы (instructions).');

  const requestedStyle = asText(args.persona_style);
  if (requestedStyle !== null && !STYLES.includes(requestedStyle)) {
    return fail(
      `Неизвестный стиль «${requestedStyle}». Доступные: ${STYLES.join(', ')}.`,
    );
  }

  try {
    const existing = await readDirectives(ctx);
    const style = requestedStyle ?? existing.style;
    const content = `${instructions}\n\n${STYLE_TAIL}${style}`;

    await upsertChapter(ctx.userId, {
      slug: CUSTOM_INSTRUCTIONS_SLUG,
      title: DIRECTIVES_TITLE,
      content,
      isPinned: true,
    });

    return {
      ok: true,
      content: `✨ Системный промпт и правила поведения обновлены:\n«${instructions}»\nЯ теперь руководствуюсь этими указаниями во всех наших диалогах.`,
      data: { slug: CUSTOM_INSTRUCTIONS_SLUG, style },
    };
  } catch (error) {
    return fail(`Не удалось обновить персональные директивы: ${errorText(error)}`);
  }
}

async function getCustomDirectives(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const { instructions, style } = await readDirectives(ctx);
    if (!instructions) {
      return {
        ok: true,
        content:
          'Персональных директив пока не задано. Действуют стандартные настройки заботливого когнитивного ментора (ADHD-friendly).',
        data: { style, instructions: '' },
      };
    }

    return {
      ok: true,
      content: `🎯 Текущие системные директивы (стиль: ${style}):\n«${instructions}»`,
      data: { style, instructions },
    };
  } catch (error) {
    return fail(`Не удалось прочитать персональные директивы: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

/** Запомнить правило поведения (рантайм-зеркало MEMORY.md в SQLite-директивах). */
async function rememberRuleTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const rule = asText(args.rule);
  if (!rule) return fail('Укажите правило (rule).');

  try {
    const result = await rememberRule(ctx.userId, rule);
    return {
      ok: true,
      content: formatLearnedRuleReply(result),
      data: { rule: result.rule, added: result.added, count: result.count },
    };
  } catch (error) {
    return fail(`Не удалось запомнить правило: ${errorText(error)}`);
  }
}

export const reasoningTools: Tool[] = [
  {
    name: 'synthesize_life_context',
    description:
      'NotebookLM-режим: собирает источники и факты из жизни пользователя (заметки, память, финансы, задачи, препараты) для глубокого рассуждения. Вызывай, когда просят порассуждать о жизни, ситуации, стратегии, привычках, решениях или планах.',
    schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'Конкретная тема или вопрос («финансы», «проекты», «самочувствие», «цели») либо не указывать для общей картины.',
        },
      },
      required: [],
    },
    run: synthesizeLifeContext,
  },
  {
    name: 'update_custom_directives',
    description:
      'Обновляет персональные директивы (системный промпт поведения) в главе документации «Персональные директивы».',
    schema: {
      type: 'object',
      properties: {
        instructions: { type: 'string', description: 'Новые правила поведения и стиль общения.' },
        persona_style: {
          type: 'string',
          description: 'Стиль: mentor, strategist, calm_partner, concise.',
        },
      },
      required: ['instructions'],
    },
    run: updateCustomDirectives,
  },
  {
    name: 'get_custom_directives',
    description: 'Показывает текущие персональные директивы (системный промпт поведения).',
    schema: { type: 'object', properties: {}, required: [] },
    run: getCustomDirectives,
  },
  {
    name: 'remember_rule',
    description:
      'Запоминает постоянное правило или предпочтение пользователя в персональных директивах. Используй, когда просят «запомни», «всегда», «больше не предлагай».',
    schema: {
      type: 'object',
      properties: {
        rule: { type: 'string', description: 'Правило одной фразой, как его формулирует пользователь.' },
      },
      required: ['rule'],
    },
    run: rememberRuleTool,
  },
];

