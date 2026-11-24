import { describe, expect, it } from 'vitest';

// Импорт движка обязан сам наполнить реестр — без ручного вызова registerAllTools().
import '../../src/lib/agent/engine';
import { listTools } from '../../src/lib/agent/registry';

describe('agent boot path', () => {
  it('registers all 75 tools on module import', () => {
    const tools = listTools();
    expect(tools.length).toBe(75);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('list_skills')).toBe(true);
    expect(names.has('manage_routines')).toBe(true);
    expect(names.has('read_skill')).toBe(true);
    expect(names.has('draft_skill')).toBe(true);
    expect(names.has('delete_budget')).toBe(true);
    expect(names.has('get_budget_plan')).toBe(true);
    expect(names.has('get_settings')).toBe(true);
    expect(names.has('update_settings')).toBe(true);
    expect(names.has('create_account')).toBe(true);
  });
});
