import { describe, expect, it } from 'vitest';

// Импорт движка обязан сам наполнить реестр — без ручного вызова registerAllTools().
import '../../src/lib/agent/engine';
import { listTools } from '../../src/lib/agent/registry';

describe('agent boot path', () => {
  it('registers all 57 tools on module import', () => {
    expect(listTools().length).toBe(57);
  });
});
