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
  requiresConfirmation,
  type Tool,
} from '../../../src/lib/agent/registry';

describe('agent/tools/index: сборка реестра', () => {
  afterEach(() => {
    clearTools();
  });

  it('имена всех тулз уникальны', () => {
    const names = agentTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('75 тулз: 62 прежних + 12 config + create_account', () => {
    expect(agentTools.length).toBe(75);
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
    expect(first.length).toBe(75);

    registerAllTools(); // повтор — не дублирует
    expect(listToolNames().length).toBe(75);
    expect(getTool('add_task')).not.toBeNull();
    expect(getTool('add_expense')).not.toBeNull();
  });

  it('replaceTool перезаписывает существующее имя (замена в тестах)', () => {
    registerAllTools();
    const replacement = agentTools[0]!;
    replaceTool({ ...replacement, description: 'подменена' });
    expect(getTool(replacement.name)?.description).toBe('подменена');
    expect(listToolNames().length).toBe(75);
  });

  it('registerTool бросает на дубликате (строгий реестр)', () => {
    registerAllTools();
    const dup = agentTools[0]!;
    expect(() => registerTool(dup)).toThrow(/already registered/);
  });

  // Класс эффекта — единственный источник истины для гейта подтверждения.
  // Раньше `defineTool` возвращал тулзу без флага `destructive`, поэтому
  // `needsConfirmation` через реестр не срабатывал ни для одной тулзы: тесты
  // подавали инструмент в `options.tools` и дефекта не видели.
  it('реестр сохраняет класс эффекта каждой тулзы', () => {
    registerAllTools();

    expect(getTool('reset_finance_history')?.effect).toEqual({ kind: 'destroy', bulk: true });
    expect(getTool('clear_trash')?.effect).toEqual({ kind: 'destroy', bulk: true });
    expect(getTool('delete_liability')?.effect).toEqual({ kind: 'destroy' });
    expect(getTool('delete_note')?.effect).toEqual({ kind: 'destroy', recovery: 'trash' });
    expect(getTool('add_task')?.effect).toEqual({ kind: 'create' });
    expect(getTool('list_tasks')?.effect).toEqual({ kind: 'read' });

    for (const tool of agentTools) {
      expect({ tool: tool.name, effect: getTool(tool.name)?.effect }).toEqual({
        tool: tool.name,
        effect: tool.effect,
      });
    }
  });

  it('гейт подтверждения выводится из класса через реестр', () => {
    registerAllTools();

    expect(requiresConfirmation(getTool('delete_liability')!.effect)).toBe(true);
    expect(requiresConfirmation(getTool('reset_finance_history')!.effect)).toBe(true);
    expect(requiresConfirmation(getTool('clear_trash')!.effect)).toBe(true);
    expect(requiresConfirmation(getTool('delete_note')!.effect)).toBe(false);
    expect(requiresConfirmation(getTool('delete_task')!.effect)).toBe(false);
  });

  it('тулза без классификации не регистрируется', () => {
    const bare = {
      name: 'bare_tool',
      description: 'Тулза без класса эффекта — реестр обязан отказаться',
      run: () => 'нет',
    };
    expect(() => registerTool(bare as unknown as Tool)).toThrow(/effect classification/);
  });
});
