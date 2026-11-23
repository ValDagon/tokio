import { describe, expect, it } from 'vitest';

// Импорт движка обязан сам наполнить реестр — без ручного вызова registerAllTools().
import '../../src/lib/agent/engine';
import { listTools } from '../../src/lib/agent/registry';

describe('agent boot path', () => {
  it('registers all 60 tools on module import', () => {
    const tools = listTools();
    expect(tools.length).toBe(60);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('list_skills')).toBe(true);
    expect(names.has('read_skill')).toBe(true);
    expect(names.has('draft_skill')).toBe(true);
  });
});
