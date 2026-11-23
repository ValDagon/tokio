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
import { getChapter } from '../../dal/docs';
import {
  createManualSkillDraft,
  listAllUserSkills,
  parseSkillSpec,
  recordSkillView,
} from '../../evolution';
import {
  formatLearnedRuleReply,
  listRuleLines,
  rememberRule,
  saveDirectives,
  splitDirectives,
} from '../../learning';
import { findOverlaySkill, getOverlaySkills } from '../../overlay';
import { listLiabilities } from '../../dal/finances';
import { listDoses, listMedications } from '../../dal/medications';
import {
  getEntity,
  listEntities,
  listEntityRelationsBidirectional,
  matchesEntityQuery,
  normalizeEntityName,
  readLastModelFailure,
  readTurnTrace,
} from '../../dal/misc';
import { listNotes } from '../../dal/notes';
import { listCategories, listTasks } from '../../dal/tasks';
import { getUser } from '../../dal/users';
import { dateKey, formatMoney, sumCents } from '../../utils';
import { turnTraceView, type TurnTraceView } from '../../summary';
import {
  CUSTOM_INSTRUCTIONS_SLUG,
  computeWorkloadMetrics,
  evaluateExecutiveOverload,
  formatOverloadReasons,
} from '../constants';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry';
import { asText, errorText, fail, snippet } from './tasks';

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

const STYLES: readonly string[] = ['mentor', 'strategist', 'calm_partner', 'concise'];

interface DirectivesState {
  instructions: string;
  style: string;
}

/** Разбор главы директив: текст + хвост «Стиль общения: X» (ADR: в `users` колонки нет). */
function parseDirectives(content: string): DirectivesState {
  const { instructions, style } = splitDirectives(content);
  return {
    instructions,
    style: style && STYLES.includes(style) ? style : 'mentor',
  };
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
    await saveDirectives(ctx.userId, instructions, style);

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
// read_turn_log — агент читает собственный журнал хода
// ---------------------------------------------------------------------------

/**
 * Ключи и токены в тексте отказа.
 *
 * `detail` движок пишет из `error.message` провайдера, а туда попадают эхо
 * запроса, URL с `?key=…` и заголовки. Наблюдение инструмента уходит модели,
 * поэтому значения ключей вычищаются до ответа: владелец читает этот текст
 * глазами, и секрет не должен ни разу попасть в контекст модели.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Ключи провайдеров: `sk-…`, `gsk_…`.
  [/\b(?:sk|pk|rk|gsk)[-_][A-Za-z0-9_-]{8,}/g, '[ключ скрыт]'],
  // Google/Gemini: `AIza…`.
  [/\bAIza[0-9A-Za-z_-]{10,}/g, '[ключ скрыт]'],
  // Токен Telegram-бота: `<id>:<секрет>`.
  [/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[токен скрыт]'],
  // `Authorization: Bearer <секрет>`.
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [секрет скрыт]'],
  // `?key=…`, `&api_key=…` в URL провайдера.
  [/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, '$1[секрет скрыт]'],
  // `api_key=…`, `token: …`, `authorization=…`.
  [
    /\b(?:api[_-]?key|apikey|access[_-]?token|token|authorization)\b\s*[:=]\s*\S{6,}/gi,
    '[секрет скрыт]',
  ],
];

/** Вырезает из текста значения ключей; сам текст остаётся читаемым. */
function redactSecrets(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

/** Последний отказ модели из `kv` — без сырого тела провайдера. */
interface TurnLogFailure {
  status: number;
  at: string | null;
  detail: string | null;
}

/** Счётчики ходов: сколько всего и сколько упёрлось в дедлайн. */
interface TurnLogStats {
  turns: number;
  deadlineTurns: number;
  updatedAt: string | null;
}

/**
 * Отказ модели в виде, пригодном модели-читателю. Движок кладёт в запись ещё и
 * `providerBody` — сырое тело ответа провайдера; в наблюдение оно не едет,
 * потому что там бывает эхо запроса. `detail` уже обрезан движком и
 * дополнительно вычищается здесь. Само чтение — по пользователю, из DAL:
 * ключ и фолбэк на старый глобальный живут в одном месте.
 */
async function readLastModelFailureView(userId: number): Promise<TurnLogFailure | null> {
  try {
    const raw = await readLastModelFailure(userId);
    if (!raw) return null;
    const record = raw as Record<string, unknown>;

    const status = Number(record.status);
    const at = typeof record.at === 'string' && record.at.trim() ? record.at.trim() : null;
    const detailText = typeof record.detail === 'string' ? record.detail : '';
    const detail = detailText.trim()
      ? redactSecrets(detailText.replace(/\s+/g, ' ').trim()).slice(0, 200)
      : null;

    const hasStatus = Number.isFinite(status);
    if (!hasStatus && !at && !detail) return null;
    return { status: hasStatus ? Math.trunc(status) : 0, at, detail };
  } catch {
    // журнал отказов — украшение диагностики: его сбой не повод падать
    return null;
  }
}

/** Счётчики ходов в проверенном виде; отсутствующая запись — `null`. */
function turnStatsView(
  stats: Awaited<ReturnType<typeof readTurnTrace>>['stats'],
): TurnLogStats | null {
  if (!stats) return null;
  return {
    turns: Math.max(0, Math.trunc(Number(stats.turns)) || 0),
    deadlineTurns: Math.max(0, Math.trunc(Number(stats.deadlineTurns)) || 0),
    updatedAt:
      typeof stats.updatedAt === 'string' && stats.updatedAt.trim()
        ? stats.updatedAt.trim()
        : null,
  };
}

/** Длительность хода по меткам крошки; нечитаемые метки — `null`. */
function traceDurationMs(trace: TurnTraceView): number | null {
  const startedAt = Date.parse(trace.startedAt);
  const updatedAt = Date.parse(trace.updatedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt) || updatedAt < startedAt) return null;
  return updatedAt - startedAt;
}

/**
 * `read_turn_log`: последний ход пользователя из его крошки.
 *
 * Зачем: 23.11.2026 владелец спросил «а почему ты не можешь сам читать логи
 * сессий моих в боте?» — ни один из 56 инструментов не читал собственный
 * журнал, поэтому на «почему ты молчал» агент отвечал догадками, а разбирать
 * причину приходилось снаружи, руками читая `kv`. Инструмент только
 * читает `turn_trace:v1` / `turn_stats:v1` и последний отказ модели по
 * пользователю (`llm_last_failure:<uid>`, старый глобальный ключ — короткий
 * фолбэк) и ничего не пишет; пустой или битый журнал — честный ответ
 * «читать нечего», а не ошибка.
 */
async function readTurnLog(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  // Владелец — только из контекста: аргумент `user_id` модель может подставить
  // любой, и тогда чужой журнал стал бы доступен. Аргументы игнорируются.
  try {
    const [{ trace: rawTrace, stats: rawStats }, lastFailure] = await Promise.all([
      readTurnTrace(ctx.userId),
      readLastModelFailureView(ctx.userId),
    ]);
    const view = turnTraceView(rawTrace);
    // Скаляр в `kv` (`turn_trace:v1` = 42) `normalizeTrace` разворачивает в
    // пустой объект: формально запись есть, фактически — ни одного поля хода.
    // Без этой проверки инструмент печатал бы «журнал из прочерков» вместо
    // честного «читать нечего».
    const trace = view && (view.startedAt || view.updatedAt || view.stage) ? view : null;
    const stats = turnStatsView(rawStats);
    const data = { userId: ctx.userId, trace, stats, lastFailure };

    // Отказ модели — единственный факт, который переживает отсутствие крошки:
    // ход мог умереть до первой записи, и тогда именно он и есть ответ на
    // «почему ты молчал». Поэтому строка строится до раннего выхода.
    const failureLine = lastFailure
      ? `⚠️ Последний отказ модели: статус ${lastFailure.status}` +
        (lastFailure.at ? ` в ${lastFailure.at}` : '') +
        (lastFailure.detail ? ` — ${lastFailure.detail}` : '')
      : null;

    if (!trace && !stats) {
      return {
        ok: true,
        content: [
          '📭 Журнала ходов нет: бот ещё не записал ни одного хода этого пользователя (ключи turn_trace:v1 и turn_stats:v1 пусты). Читать нечего — это не ошибка.',
          ...(failureLine ? [failureLine] : []),
        ].join('\n'),
        data,
      };
    }

    const lines: string[] = ['🧾 Журнал последнего хода:'];
    if (trace) {
      const duration = traceDurationMs(trace);
      lines.push(`• Начат: ${trace.startedAt || '—'}`);
      lines.push(
        `• Обновлён: ${trace.updatedAt || '—'}` +
          (duration === null ? '' : ` (длительность ${Math.round(duration / 100) / 10} с)`),
      );
      lines.push(`• Стадия: ${trace.stage || '—'} · вызовов модели: ${trace.modelCalls}`);
      lines.push(`• Модели: ${trace.models.length > 0 ? trace.models.join(', ') : '—'}`);
      lines.push(`• Инструменты: ${trace.tools.length > 0 ? trace.tools.join(', ') : '—'}`);
      lines.push(
        `• Дедлайн: ${
          trace.deadlineCause
            ? `${trace.deadlineCause}${trace.deadlineAt ? ` (${trace.deadlineAt})` : ''}`
            : 'нет'
        }`,
      );
      lines.push(`• Индикатор «⏳ …»: ${trace.indicator}`);
      lines.push(`• Причина остановки: ${trace.stopReason ?? '—'}`);
    } else {
      lines.push('• Крошки последнего хода нет (ключ turn_trace:v1 пуст).');
    }

    lines.push(
      stats
        ? `📊 Ходов всего: ${stats.turns} · из них по дедлайну: ${stats.deadlineTurns}`
        : '📊 Счётчика ходов нет (ключ turn_stats:v1 пуст).',
    );

    if (failureLine) lines.push(failureLine);
    else lines.push('⚠️ Отказов модели в журнале нет.');

    return { ok: true, content: lines.join('\n'), data };
  } catch (error) {
    return fail(`Не удалось прочитать журнал хода: ${errorText(error)}`);
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

// ---------------------------------------------------------------------------
// list_skills / read_skill / draft_skill (Runtime Markdown Skills + SQLite)
// ---------------------------------------------------------------------------

async function listSkillsTool(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const builtin = getOverlaySkills();
    const [userSkills, directives] = await Promise.all([
      listAllUserSkills(ctx.userId),
      readDirectives(ctx),
    ]);
    const rulesCount = listRuleLines(directives.instructions).length;

    const lines: string[] = [
      `Стиль общения: ${directives.style} · Запомненных правил (/learn): ${rulesCount}`,
      '',
      `Встроенные доменные скиллы (.md, ${builtin.length} шт.):`,
    ];
    if (builtin.length === 0) {
      lines.push('— нет встроенных скиллов');
    } else {
      for (const s of builtin) {
        lines.push(`- ${s.id} (${s.name}): ${s.description}`);
      }
    }

    lines.push('');
    lines.push(`Пользовательские скиллы (SQLite, ${userSkills.length} шт.):`);
    if (userSkills.length === 0) {
      lines.push('— пока нет черновиков или включённых процедур');
    } else {
      for (const entry of userSkills) {
        const key = entry.spec?.key ?? `#${entry.row.id}`;
        const version = entry.spec ? `v${entry.spec.version}` : 'v?';
        const title = entry.row.title ? ` — ${entry.row.title}` : '';
        lines.push(
          `- #${entry.row.id} ${key} ${version} [${entry.row.status}]${title} (применений: ${entry.usage.uses}, просмотров: ${entry.usage.views})`,
        );
      }
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        persona_style: directives.style,
        rules_count: rulesCount,
        builtin_skills: builtin.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          triggers: s.triggers ?? [],
        })),
        user_skills: userSkills.map((entry) => ({
          id: entry.row.id,
          key: entry.spec?.key ?? null,
          title: entry.row.title ?? null,
          status: entry.row.status,
          version: entry.spec?.version ?? null,
          uses: entry.usage.uses,
          views: entry.usage.views,
        })),
      },
    };
  } catch (error) {
    return fail(`Не удалось получить список скиллов: ${errorText(error)}`);
  }
}

async function readSkillTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const raw =
    typeof args.name_or_id === 'number' && Number.isFinite(args.name_or_id)
      ? String(Math.trunc(args.name_or_id))
      : asText(args.name_or_id);
  if (!raw) return fail('Укажите имя или ID скилла (name_or_id).');

  try {
    const builtin = findOverlaySkill(raw);
    if (builtin) {
      return {
        ok: true,
        content: `# ${builtin.name}\n${builtin.description}\n\n${builtin.body}`,
        data: {
          source: 'overlay',
          id: builtin.id,
          name: builtin.name,
          description: builtin.description,
          status: 'active',
          body_md: builtin.body,
        },
      };
    }

    const userSkills = await listAllUserSkills(ctx.userId);
    const cleaned = raw.replace(/^#/, '').trim();
    const numericId = /^\d+$/.test(cleaned) ? Number.parseInt(cleaned, 10) : null;
    const lower = cleaned.toLowerCase();

    const matched = userSkills.find((entry) => {
      if (numericId !== null && entry.row.id === numericId) return true;
      if (entry.spec?.key.toLowerCase() === lower) return true;
      if (entry.row.title && entry.row.title.trim().toLowerCase() === lower) return true;
      return false;
    });

    if (!matched) {
      return fail(`Скилл «${raw}» не найден. Вызови list_skills, чтобы увидеть доступные.`);
    }

    await recordSkillView(ctx.userId, matched.row.id);
    const spec = matched.spec ?? parseSkillSpec(matched.row.spec);
    const bodyMd = spec?.body ?? matched.row.rawInput;
    const name = spec?.key ?? `#${matched.row.id}`;
    const title = matched.row.title ?? name;

    return {
      ok: true,
      content: `# ${title} (${name} v${spec?.version ?? '?'} · ${matched.row.status})\n\n${bodyMd}`,
      data: {
        source: 'sqlite',
        id: matched.row.id,
        name,
        description: title,
        status: matched.row.status,
        body_md: bodyMd,
      },
    };
  } catch (error) {
    return fail(`Не удалось прочитать скилл: ${errorText(error)}`);
  }
}

async function draftSkillTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const key = asText(args.key);
  const title = asText(args.title);
  const whenToUse = asText(args.when_to_use);
  const procedure = asText(args.procedure);
  const pitfalls = asText(args.pitfalls) ?? undefined;
  const verification = asText(args.verification) ?? undefined;

  if (!key || !title || !whenToUse || !procedure) {
    return fail('Для создания черновика скилла нужны key, title, when_to_use и procedure.');
  }

  try {
    const result = await createManualSkillDraft(ctx.userId, {
      key,
      title,
      whenToUse,
      procedure,
      pitfalls,
      verification,
    });
    if (!result.ok) return fail(result.error);

    return {
      ok: true,
      content:
        `🧩 Черновик скилла #${result.item.id} (${result.spec.key} v${result.spec.version}) создан в статусе pending.\n` +
        'Активируется только по явному подтверждению владельца (/skills activate или кнопка под ответом).',
      data: {
        skill_id: result.item.id,
        key: result.spec.key,
        title: result.item.title ?? title,
        status: 'pending',
        requires_approval: true,
      },
    };
  } catch (error) {
    return fail(`Не удалось создать черновик скилла: ${errorText(error)}`);
  }
}

export const reasoningTools: Tool[] = [
  {
    name: 'synthesize_life_context',
    effect: { kind: 'read' },
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
    // Перезапись без истории: прежний текст директив не сохраняется —
    // наблюдение содержит только новые. Класс `mutate` по
    // PLAN-AGENT-WRITE-GUARD §4: защита здесь — входной гейт (светская
    // реплика не получает write-тулсет) и явная просьба владельца.
    effect: { kind: 'mutate' },
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
    effect: { kind: 'read' },
    description: 'Показывает текущие персональные директивы (системный промпт поведения).',
    schema: { type: 'object', properties: {}, required: [] },
    run: getCustomDirectives,
  },
  {
    name: 'remember_rule',
    effect: { kind: 'mutate' },
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
  {
    name: 'read_turn_log',
    effect: { kind: 'read' },
    description:
      'Показывает собственный журнал последнего хода: когда начался и закончился, до какой стадии дошёл, какие модели и инструменты вызывались, почему сработал дедлайн, что стало с индикатором «⏳ …» и почему ход остановился, плюс счётчики ходов и последний отказ модели. Вызывай, когда спрашивают «почему ты молчал», «почему так долго думал», «что с тобой было». Только чтение: ничего не пишет.',
    schema: { type: 'object', properties: {}, required: [] },
    run: readTurnLog,
  },
  {
    name: 'list_skills',
    effect: { kind: 'read' },
    description:
      'Показывает все доступные доменные .md-скиллы оверлея, пользовательские процедурные скиллы (active/pending) и текущий стиль общения. Только чтение.',
    schema: { type: 'object', properties: {}, required: [] },
    run: listSkillsTool,
  },
  {
    name: 'read_skill',
    effect: { kind: 'read' },
    description:
      'Загружает полный Markdown-регламент скилла по id/имени (встроенного .md или пользовательского в SQLite). Вызывай перед выполнением подходящего доменного скилла.',
    schema: {
      type: 'object',
      properties: {
        name_or_id: {
          type: 'string',
          description: 'Идентификатор или имя скилла (например, daily-focus, inbox-triage, или числовой ID из SQLite).',
        },
      },
      required: ['name_or_id'],
    },
    run: readSkillTool,
  },
  {
    name: 'draft_skill',
    effect: { kind: 'create' },
    description:
      'Создаёт новый черновик процедурного скилла (status=pending) по просьбе пользователя. Никогда не активирует сам — активацию подтверждает только пользователь.',
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Короткий ключ латиницей в kebab-case (например, weekly-review).' },
        title: { type: 'string', description: 'Краткое название скилла.' },
        when_to_use: { type: 'string', description: 'Когда применять этот скилл (секция When to Use).' },
        procedure: { type: 'string', description: 'Пошаговая процедура выполнения (секция Procedure).' },
        pitfalls: { type: 'string', description: 'Опционально: частые ошибки и ограничения (секция Pitfalls).' },
        verification: { type: 'string', description: 'Опционально: как проверить результат (секция Verification).' },
      },
      required: ['key', 'title', 'when_to_use', 'procedure'],
    },
    run: draftSkillTool,
  },
];

