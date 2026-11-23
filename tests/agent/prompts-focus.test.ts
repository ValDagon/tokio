/**
 * Каталог тулз сужается по фокусу запроса (PLAN-AGENT-FIRST T0c).
 *
 * Ось фокуса независима от `AgentMode`: финансовый запрос не должен видеть
 * аптечку, медицинский — деньги и runway. Схема по-прежнему обрезается на 700
 * символах (`renderSchema`), фильтр её не расширяет: он убирает строки, а не
 * удлиняет их.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  detectToolFocus,
  filterToolsByFocus,
} from '../../src/lib/agent/prompts';
import { toolSummaries } from '../../src/lib/agent/registry';
import { TOOL_GROUPS, agentTools } from '../../src/lib/agent/tools/index';

const NOW = new Date('2026-11-06T09:30:00Z');

const summaries = toolSummaries(agentTools);

function catalog(focus: 'finance' | 'medical' | null): string {
  return buildSystemPrompt({ now: NOW, tools: summaries, focus });
}

describe('detectToolFocus', () => {
  it('узнаёт финансовый запрос', () => {
    expect(detectToolFocus('Сколько я потратил в этом месяце')).toBe('finance');
    expect(detectToolFocus('Запиши трату 12 евро на обед')).toBe('finance');
    expect(detectToolFocus('Покажи мои долги и обязательства')).toBe('finance');
    // «долг» — отдельной альтернативой: `\b` в JS не работает после кириллицы.
    expect(detectToolFocus('Покажи мои долги')).toBe('finance');
    expect(detectToolFocus('Сколько осталось по долгу')).toBe('finance');
  });

  it('узнаёт медицинский запрос', () => {
    expect(detectToolFocus('Выпил таблетку от давления')).toBe('medical');
    expect(detectToolFocus('Добавь лекарство магний вечером')).toBe('medical');
  });

  it('не сужает каталог, когда домен не назван или названы оба', () => {
    expect(detectToolFocus('Как дела?')).toBeNull();
    expect(detectToolFocus('')).toBeNull();
    expect(detectToolFocus(null)).toBeNull();
    expect(detectToolFocus('Сколько я потратил на таблетки в аптеке')).toBeNull();
  });

  it('не путает «долго» и «утрату» с финансами', () => {
    expect(detectToolFocus('Долго думал, что делать')).toBeNull();
    expect(detectToolFocus('Как пережить утрату')).toBeNull();
  });
});

describe('каталог по фокусу', () => {
  it('в финансовом фокусе не содержит инструментов аптечки', () => {
    const prompt = catalog('finance');

    expect(prompt).toContain('- get_fin_balances:');
    for (const tool of TOOL_GROUPS.medications) {
      expect(prompt).not.toContain(`- ${tool.name}:`);
    }
  });

  it('в медицинском фокусе не содержит финансовых инструментов и runway', () => {
    const prompt = catalog('medical');

    expect(prompt).toContain('- add_medication:');
    for (const tool of TOOL_GROUPS.finance) {
      expect(prompt).not.toContain(`- ${tool.name}:`);
    }
    for (const tool of TOOL_GROUPS.runway) {
      expect(prompt).not.toContain(`- ${tool.name}:`);
    }
  });

  it('без фокуса отдаёт все 60 инструментов', () => {
    const prompt = catalog(null);

    expect(summaries).toHaveLength(60);
    for (const tool of agentTools) {
      expect(prompt).toContain(`- ${tool.name}:`);
    }
  });

  it('прячет только конфликтующий домен и не расширяет обрезку схемы', () => {
    const filtered = filterToolsByFocus(summaries, 'finance');

    expect(filtered).toHaveLength(summaries.length - TOOL_GROUPS.medications.length);
    expect(filtered.some((tool) => tool.name === 'add_task')).toBe(true);
    expect(filtered.some((tool) => tool.name === 'consult_system_docs')).toBe(true);
  });
});
