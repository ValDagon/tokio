/**
 * Реестр инструментов агента (SPEC §3 T11).
 *
 * Реестр — это единственная точка, через которую ReAct-цикл узнаёт о тулзах.
 * Сами тулзы (задачи, заметки, финансы, медикаменты, документация) живут в
 * T12/T13 и регистрируются снаружи (`registerTool`); движок ничего о них не
 * знает, кроме имени, описания и JSON-схемы аргументов.
 *
 * Правила, которые здесь закреплены:
 *  - имя тулзы — стабильный идентификатор в нижнем регистре (`[a-z][a-z0-9_]*`):
 *    модель возвращает его текстом, поэтому регистр и пробелы нормализуются;
 *  - реестр не бросает наружу исключения тулзы: `runTool` всегда возвращает
 *    исход (`ok: false` с текстом ошибки), иначе один упавший инструмент
 *    положил бы весь ReAct-цикл;
 *  - вызов неизвестного инструмента — тоже нормальный исход с подсказкой,
 *    какие имена доступны: модель после этого обычно исправляется сама.
 */

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

import { isInsufficientFundsError } from '../dal/finances.js';

/** Аргументы тулзы после разбора ответа модели. */
export type ToolArgs = Record<string, unknown>;

/** Контекст вызова: чей это запрос и в какой реальности он исполняется. */
export interface ToolContext {
  userId: number;
  timezone: string;
  baseCurrency: string;
  /** Момент вызова — фиксируется один раз на прогон агента. */
  now: Date;
}

/** Результат исполнения тулзы — то, что увидит модель как Observation. */
export interface ToolOutcome {
  ok: boolean;
  /** Текст наблюдения для модели (человекочитаемый, без разметки). */
  content: string;
  /** Структурированные данные — для логов/метаданных шага, модель их не видит. */
  data?: unknown;
  /**
   * Отказ вызван дефектом (исключение тулзы, неизвестное имя), а не
   * бизнес-правилом (валидация аргументов, нехватка средств). Только такие
   * исходы движок журналирует: ожидаемый отказ — не сбой.
   */
  unexpected?: boolean;
}

/**
 * Инструмент агента.
 *
 * `run` может вернуть строку (короткая форма «всё хорошо») или полный исход;
 * исключения разрешены — `runTool` превратит их в `ok: false`.
 */
export interface Tool {
  name: string;
  description: string;
  /** JSON-схема аргументов: попадает в системный промпт. */
  schema?: Record<string, unknown>;
  /**
   * Деструктивное действие (удаление, очистка, сброс). Движок не выполняет его
   * без явного `confirm: true` в аргументах: сначала спрашивает пользователя.
   */
  destructive?: boolean;
  run(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome | string> | ToolOutcome | string;
}

/** Компактное описание тулзы для промпта. */
export interface ToolSummary {
  name: string;
  description: string;
  schema: Record<string, unknown> | null;
}

/** Допустимое имя тулзы: нижний регистр, цифры и подчёркивания. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Реестр — модульный синглтон (в изоляте он живёт в пределах инстанса). */
const registry = new Map<string, Tool>();

// ---------------------------------------------------------------------------
// Нормализация и валидация
// ---------------------------------------------------------------------------

/** `" Add Task "` → `"add_task"`; всё, что не проходит шаблон, — пустая строка. */
export function normalizeToolName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const value = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return TOOL_NAME_PATTERN.test(value) ? value : '';
}

/** Проверяет и нормализует описание тулзы; бросает на явных ошибках программиста. */
export function defineTool(tool: Tool): Tool {
  const name = normalizeToolName(tool?.name);
  if (!name) throw new Error(`agent.registry: invalid tool name "${String(tool?.name)}"`);
  const description = String(tool.description ?? '').trim();
  if (!description) throw new Error(`agent.registry: tool "${name}" has no description`);
  if (typeof tool.run !== 'function') {
    throw new Error(`agent.registry: tool "${name}" has no run()`);
  }

  const schema =
    tool.schema && typeof tool.schema === 'object' && !Array.isArray(tool.schema)
      ? tool.schema
      : undefined;

  return {
    name,
    description,
    ...(schema ? { schema } : {}),
    run: tool.run,
  };
}

// ---------------------------------------------------------------------------
// Регистрация
// ---------------------------------------------------------------------------

/** Регистрирует тулзу; повторная регистрация того же имени — ошибка. */
export function registerTool(tool: Tool): Tool {
  const defined = defineTool(tool);
  if (registry.has(defined.name)) {
    throw new Error(`agent.registry: tool "${defined.name}" is already registered`);
  }
  registry.set(defined.name, defined);
  return defined;
}

/**
 * Регистрирует набор тулз атомарно: если хоть одна невалидна или дублируется,
 * реестр остаётся нетронутым.
 */
export function registerTools(tools: readonly Tool[]): Tool[] {
  const prepared: Tool[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const defined = defineTool(tool);
    if (seen.has(defined.name) || registry.has(defined.name)) {
      throw new Error(`agent.registry: duplicate tool "${defined.name}"`);
    }
    seen.add(defined.name);
    prepared.push(defined);
  }

  for (const tool of prepared) registry.set(tool.name, tool);
  return prepared;
}

/** Заменяет тулзу с тем же именем (удобно для переопределения в тестах). */
export function replaceTool(tool: Tool): Tool {
  const defined = defineTool(tool);
  registry.set(defined.name, defined);
  return defined;
}

/** Убирает тулзу из реестра. `true`, если она там была. */
export function unregisterTool(name: string): boolean {
  return registry.delete(normalizeToolName(name));
}

/** Полная очистка реестра (тесты и переинициализация изолята). */
export function clearTools(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Доступ
// ---------------------------------------------------------------------------

/** Тулза по имени (регистр и пробелы нормализуются). */
export function getTool(name: string): Tool | null {
  const key = normalizeToolName(name);
  return key ? (registry.get(key) ?? null) : null;
}

/** Все зарегистрированные тулзы в порядке регистрации. */
export function listTools(): Tool[] {
  return [...registry.values()];
}

/** Имена всех тулз — для подсказки модели при неизвестном инструменте. */
export function listToolNames(): string[] {
  return [...registry.keys()];
}

/** Компактные описания для системного промпта. */
export function toolSummaries(tools: readonly Tool[] = listTools()): ToolSummary[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.schema ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

function asOutcome(value: ToolOutcome | string): ToolOutcome {
  if (typeof value === 'string') return { ok: true, content: value };
  if (value && typeof value === 'object') {
    return {
      ok: value.ok !== false,
      content: typeof value.content === 'string' ? value.content : '',
      ...(value.data === undefined ? {} : { data: value.data }),
    };
  }
  return { ok: true, content: '' };
}

/**
 * Исполняет тулзу и никогда не бросает: неизвестное имя, исключение и
 * нестроковый результат сводятся к `ToolOutcome`.
 */
export async function runTool(
  name: string,
  args: ToolArgs,
  ctx: ToolContext,
  tools: readonly Tool[] = listTools(),
): Promise<ToolOutcome> {
  const tool = tools.find((candidate) => candidate.name === normalizeToolName(name)) ?? null;

  if (!tool) {
    const available = tools.map((candidate) => candidate.name).join(', ') || '—';
    return {
      ok: false,
      unexpected: true,
      content: `Инструмент «${String(name)}» не найден. Доступные инструменты: ${available}.`,
    };
  }

  try {
    return asOutcome(await tool.run(args ?? {}, ctx));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      // Отказ по средствам — правило, а не дефект: его видит пользователь, и
      // журнал сбоев он не должен пополнять.
      unexpected: !isInsufficientFundsError(error),
      content: `Инструмент «${tool.name}» завершился ошибкой: ${message}`,
    };
  }
}
