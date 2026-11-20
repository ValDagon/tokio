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
  const text = String(content ?? '');
  const marker = text.lastIndexOf(`\n${STYLE_TAIL}`);
  if (marker === -1) return { instructions: text.trim(), style: null };
  return {
    instructions: text.slice(0, marker).trim(),
    style: text.slice(marker + STYLE_TAIL.length + 1).trim(),
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
  return style ? `${body}\n\n${STYLE_TAIL}${style}` : body;
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
