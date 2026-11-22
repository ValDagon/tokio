/**
 * Smoke-тесты сборки тулз (SPEC §3 T12/T13): бочка `agent/tools/index.ts`.
 *
 * Проверяет то, что не видно из тестов отдельных модулей: имена тулз
 * уникальны во всей сборке (иначе модель увидит две разные тулзы под одним
 * именем и ReAct-цикл вызовет не ту), счёт совпадает со спекой и явная
 * регистрация действительно наполняет реестр движка.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { agentTools, registerAllTools } from '../../../src/lib/agent/tools';
import {
  clearTools,
  getTool,
  listToolNames,
  registerTool,
  replaceTool,
} from '../../../src/lib/agent/registry';

describe('agent/tools/index: сборка реестра', () => {
  afterEach(() => {
    clearTools();
  });

  it('имена всех тулз уникальны', () => {
    const names = agentTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('56 тулз: 31 (T13+: финансы/runway/медикаменты) + 21 (T12: задачи/заметки/прочее) + 3 (T2: дневник/разбор) + 1 (T2: обучение)', () => {
    expect(agentTools.length).toBe(56);
  });

  it('каждая тулза валидна: имя, описание, runnable', () => {
    for (const tool of agentTools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.run).toBe('function');
    }
  });

  it('registerAllTools наполняет глобальный реестр целиком и идемпотентно', () => {
    registerAllTools();
    const first = listToolNames();
    expect(first.length).toBe(56);

    registerAllTools(); // повтор — не дублирует
    expect(listToolNames().length).toBe(56);
    expect(getTool('add_task')).not.toBeNull();
    expect(getTool('add_expense')).not.toBeNull();
  });

  it('replaceTool перезаписывает существующее имя (замена в тестах)', () => {
    registerAllTools();
    const replacement = agentTools[0]!;
    replaceTool({ ...replacement, description: 'подменена' });
    expect(getTool(replacement.name)?.description).toBe('подменена');
    expect(listToolNames().length).toBe(56);
  });

  it('registerTool бросает на дубликате (строгий реестр)', () => {
    registerAllTools();
    const dup = agentTools[0]!;
    expect(() => registerTool(dup)).toThrow(/already registered/);
  });
});
