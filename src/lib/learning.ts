/**
 * Обучение правилам на SQLite (PLAN-AGENT-FIRST T2).
 *
 * Контракт `docs/system/MEMORY.md`: правила поведения — единственный источник
 * в этом файле, а рантайм (Telegram-бот, Mini App, LangGraph-промпт) читает их
 * зеркало. В изоляте файловой системы нет, поэтому зеркало — глава
 * `07_custom_instructions` в SQLite: её же читает движок агента
 * (`loadAgentProfile` → `customInstructions`).
 *
 * Формат главы не меняется: текст правил и хвост `Стиль общения: X`
 * (`reasoning.ts` разбирает его так же). Правило добавляется строкой-пунктом,
 * повтор (без учёта регистра, пунктуации-обёртки и лишних пробелов) не
 * дублируется — иначе `/learn` засоряет директивы эхом.
 *
 * Мёртвые PG-таблицы (`ag.users.custom_instructions`, `ag.evolution_backlog`)
 * здесь не участвуют: прод их не видит.
 */

import { getChapter, upsertChapter } from './dal/docs.js';
import { truncate } from './utils.js';
import { CUSTOM_INSTRUCTIONS_SLUG } from './agent/constants.js';

/** Заголовок главы директив (как в `tools/reasoning.ts`). */
export const DIRECTIVES_TITLE = 'Персональные директивы';

/** Хвост стиля в главе директив. */
export const STYLE_TAIL = 'Стиль общения: ';

/** Предел длины одного правила: длиннее — это уже заметка, а не правило. */
export const LEARN_RULE_MAX_CHARS = 500;

/** Маркер пункта правила в главе. */
const RULE_PREFIX = '- ';

/** Результат записи правила. */
export interface LearnedRuleResult {
  /** Нормализованный текст правила. */
  rule: string;
  /** `false` — правило уже было (регистр/пробелы не важны). */
  added: boolean;
  /** Сколько правил теперь в директивах. */
  count: number;
}

/** Разбор директив: текст правил и стиль (хвост `Стиль общения:`). */
export interface DirectivesSplit {
  instructions: string;
  style: string | null;
}

/** Делит главу на текст правил и хвост стиля; стиль сохраняется как есть. */
export function splitDirectives(content: string): DirectivesSplit {
  const text = String(content ?? '').trim();
  if (!text) return { instructions: '', style: null };
  const tailPrefix = STYLE_TAIL.trimEnd();
  if (text === tailPrefix || text.startsWith(STYLE_TAIL)) {
    const style = text.slice(tailPrefix.length).trim();
    return { instructions: '', style: style || null };
  }
  const markerWithSpace = text.lastIndexOf(`\n${STYLE_TAIL}`);
  const markerExact = markerWithSpace !== -1 ? markerWithSpace : text.lastIndexOf(`\n${tailPrefix}`);
  if (markerExact === -1) return { instructions: text, style: null };
  const tailLine = text.slice(markerExact + 1);
  if (!tailLine.startsWith(STYLE_TAIL) && tailLine !== tailPrefix) {
    return { instructions: text, style: null };
  }
  const style = tailLine.slice(tailPrefix.length).trim();
  return {
    instructions: text.slice(0, markerExact).trim(),
    style: style || null,
  };
}

/** Строки-правила из текста директив (без пустых и без маркера пункта). */
export function listRuleLines(instructions: string): string[] {
  return String(instructions ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => (line.startsWith(RULE_PREFIX) ? line.slice(RULE_PREFIX.length).trim() : line))
    .filter((line) => line !== '');
}

/** Ключ сравнения: регистр, пробелы и хвостовая пунктуация не важны. */
export function ruleKey(rule: string): string {
  return String(rule ?? '')
    .trim()
    .replace(/^[-–—*•]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .replace(/[.!;,]+$/u, '')
    .toLowerCase();
}

/** Собирает главу обратно: правила пунктами + сохранённый хвост стиля. */
function joinDirectives(rules: readonly string[], style: string | null): string {
  const body = rules.map((rule) => `${RULE_PREFIX}${rule}`).join('\n');
  return formatDirectivesChapter(body, style);
}

/** Форматирует свободный текст директив и опциональный хвост стиля в единый Markdown главы `07_custom_instructions`. */
export function formatDirectivesChapter(instructions: string, style: string | null): string {
  const cleanInst = String(instructions ?? '').trim();
  const cleanStyle = typeof style === 'string' ? style.trim() : '';
  if (cleanInst && cleanStyle) return `${cleanInst}\n\n${STYLE_TAIL}${cleanStyle}`;
  if (cleanStyle) return `${STYLE_TAIL}${cleanStyle}`;
  return cleanInst;
}

/** Сохраняет директивы и стиль общения в главу `07_custom_instructions`. */
export async function saveDirectives(
  userId: number,
  instructions: string,
  style: string | null,
): Promise<{ instructions: string; style: string | null }> {
  const cleanInst = String(instructions ?? '').trim();
  const cleanStyle = typeof style === 'string' && style.trim() ? style.trim() : null;
  await upsertChapter(userId, {
    slug: CUSTOM_INSTRUCTIONS_SLUG,
    title: DIRECTIVES_TITLE,
    content: formatDirectivesChapter(cleanInst, cleanStyle),
    isPinned: true,
  });
  return { instructions: cleanInst, style: cleanStyle };
}

/** Обновляет только стиль общения в `07_custom_instructions`, не затирая существующие правила и директивы. */
export async function setPersonaStyle(userId: number, style: string): Promise<string> {
  const cleanStyle = String(style ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!cleanStyle) throw new Error('learning.setPersonaStyle: style is empty');
  const chapter = await getChapter(userId, CUSTOM_INSTRUCTIONS_SLUG);
  const { instructions } = splitDirectives(chapter?.content ?? '');
  await saveDirectives(userId, instructions, cleanStyle);
  return cleanStyle;
}

/**
 * Текст правила из команды `/learn <правило>` (или `/запомни …`).
 * `null` — это не команда обучения или правило пустое.
 */
export function parseLearnCommand(text: string): string | null {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const match = /^(?:\/|)(?:learn|запомни|правило|rule)(?:@[\w_]+)?(?![a-zа-яё0-9_])[\s:—-]*(.*)$/isu.exec(value);
  if (!match) return null;
  const rule = (match[1] ?? '').trim();
  return rule === '' ? null : truncate(rule, LEARN_RULE_MAX_CHARS);
}

/** Правила пользователя из SQLite-главы директив. */
export async function listLearnedRules(userId: number): Promise<string[]> {
  const chapter = await getChapter(userId, CUSTOM_INSTRUCTIONS_SLUG);
  if (!chapter) return [];
  return listRuleLines(splitDirectives(chapter.content).instructions);
}

/**
 * Запоминает правило в SQLite-директивах. Повтор не добавляет вторую строку:
 * пользователь получает честное «уже знаю», а не эхо в промпте.
 *
 * @throws если правило пустое после нормализации
 */
export async function rememberRule(userId: number, rule: string): Promise<LearnedRuleResult> {
  const clean = truncate(String(rule ?? '').trim(), LEARN_RULE_MAX_CHARS);
  if (clean === '') throw new Error('learning.rememberRule: rule is empty');

  const chapter = await getChapter(userId, CUSTOM_INSTRUCTIONS_SLUG);
  const { instructions, style } = splitDirectives(chapter?.content ?? '');
  const rules = listRuleLines(instructions);

  const key = ruleKey(clean);
  if (rules.some((existing) => ruleKey(existing) === key)) {
    return { rule: clean, added: false, count: rules.length };
  }

  const next = [...rules, clean];
  await upsertChapter(userId, {
    slug: CUSTOM_INSTRUCTIONS_SLUG,
    title: DIRECTIVES_TITLE,
    content: joinDirectives(next, style ?? 'mentor'),
    isPinned: true,
  });

  return { rule: clean, added: true, count: next.length };
}

/** Текст-подтверждение для чата (plain text, разметку навешивает слой bot). */
export function formatLearnedRuleReply(result: LearnedRuleResult): string {
  return result.added
    ? `📌 Запомнил правило: «${result.rule}».\nБуду учитывать его во всех ответах (всего правил: ${result.count}).`
    : `📌 Это правило уже записано: «${result.rule}».\nНичего не дублирую (всего правил: ${result.count}).`;
}

/** Подсказка, если команда пришла без текста правила. */
export const LEARN_USAGE_TEXT =
  'Напишите правило после команды, например:\n/learn не предлагать мне задачи по воскресеньям';

/** Ответ, когда правил ещё нет. */
export const NO_RULES_TEXT = 'Персональных правил пока нет. Добавьте первое: /learn <правило>.';

export interface RuleSelector {
  /** 1-based номер правила из `listLearnedRules`. */
  index?: number;
  /** Подстрока или точный текст правила для поиска без учёта регистра. */
  match?: string;
}

export interface RuleMutationResult {
  ok: boolean;
  error?: string;
  previous?: string;
  rule?: string;
  removed?: string;
  count: number;
  rules: string[];
}

type ResolvedRuleMatch =
  | { ok: true; index: number; rules: string[]; style: string | null }
  | { ok: false; error: string; rules: string[] };

async function resolveRuleMatch(
  userId: number,
  selector: RuleSelector,
): Promise<ResolvedRuleMatch> {
  const chapter = await getChapter(userId, CUSTOM_INSTRUCTIONS_SLUG);
  const { instructions, style } = splitDirectives(chapter?.content ?? '');
  const rules = listRuleLines(instructions);
  if (rules.length === 0) {
    return { ok: false, error: 'Список персональных правил пуст.', rules };
  }

  if (typeof selector.index === 'number' && Number.isFinite(selector.index)) {
    const idx = Math.trunc(selector.index) - 1;
    if (idx < 0 || idx >= rules.length) {
      return {
        ok: false,
        error: `Правило #${Math.trunc(selector.index)} не найдено (всего правил: ${rules.length}).`,
        rules,
      };
    }
    return { ok: true, index: idx, rules, style };
  }

  const rawMatch = typeof selector.match === 'string' ? selector.match.trim() : '';
  if (!rawMatch) {
    return {
      ok: false,
      error: 'Укажите номер правила (index, с 1) или фрагмент текста (match).',
      rules,
    };
  }

  const needleKey = ruleKey(rawMatch);
  const exactIdx = rules.findIndex((rule) => ruleKey(rule) === needleKey);
  if (exactIdx !== -1) {
    return { ok: true, index: exactIdx, rules, style };
  }

  const needle = rawMatch.toLowerCase();
  const matches = rules
    .map((rule, idx) => ({ rule, idx }))
    .filter((entry) => entry.rule.toLowerCase().includes(needle));

  if (matches.length === 0) {
    return {
      ok: false,
      error: `Правило по запросу «${rawMatch}» не найдено.`,
      rules,
    };
  }
  if (matches.length > 1) {
    const list = matches.map((m) => `${m.idx + 1}. ${m.rule}`).join('\n');
    return {
      ok: false,
      error: `Найдено несколько правил по «${rawMatch}» — уточните номер (index):\n${list}`,
      rules,
    };
  }
  return { ok: true, index: matches[0]!.idx, rules, style };
}

/** Точечное редактирование одного правила `/learn`, сохраняя остальные правила и стиль общения. */
export async function editRule(
  userId: number,
  selector: RuleSelector,
  nextRule: string,
): Promise<RuleMutationResult> {
  const clean = truncate(String(nextRule ?? '').trim(), LEARN_RULE_MAX_CHARS);
  if (!clean) {
    const current = await listLearnedRules(userId);
    return {
      ok: false,
      error: 'Новый текст правила не может быть пустым.',
      count: current.length,
      rules: current,
    };
  }

  const resolved = await resolveRuleMatch(userId, selector);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, count: resolved.rules.length, rules: resolved.rules };
  }

  const nextKey = ruleKey(clean);
  const duplicate = resolved.rules.some(
    (existing, idx) => idx !== resolved.index && ruleKey(existing) === nextKey,
  );
  if (duplicate) {
    return {
      ok: false,
      error: `Такое правило уже есть в списке: «${clean}».`,
      count: resolved.rules.length,
      rules: resolved.rules,
    };
  }

  const previous = resolved.rules[resolved.index]!;
  const nextRules = [...resolved.rules];
  nextRules[resolved.index] = clean;

  await upsertChapter(userId, {
    slug: CUSTOM_INSTRUCTIONS_SLUG,
    title: DIRECTIVES_TITLE,
    content: joinDirectives(nextRules, resolved.style),
    isPinned: true,
  });

  return { ok: true, previous, rule: clean, count: nextRules.length, rules: nextRules };
}

/** Точечное удаление одного правила `/learn` с сохранением остальных правил и стиля общения. */
export async function removeRule(
  userId: number,
  selector: RuleSelector,
): Promise<RuleMutationResult> {
  const resolved = await resolveRuleMatch(userId, selector);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, count: resolved.rules.length, rules: resolved.rules };
  }

  const removed = resolved.rules[resolved.index]!;
  const nextRules = resolved.rules.filter((_, idx) => idx !== resolved.index);

  await upsertChapter(userId, {
    slug: CUSTOM_INSTRUCTIONS_SLUG,
    title: DIRECTIVES_TITLE,
    content: joinDirectives(nextRules, resolved.style),
    isPinned: true,
  });

  return { ok: true, removed, count: nextRules.length, rules: nextRules };
}
