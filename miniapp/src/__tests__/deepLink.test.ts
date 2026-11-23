import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStartParam, readInitialStartParam } from '../deepLink';

function stubWindow(value: {
  location?: { search?: string };
  Telegram?: {
    WebApp?: {
      initDataUnsafe?: {
        start_param?: string;
      };
    };
  };
}): void {
  vi.stubGlobal('window', value);
}

describe('parseStartParam', () => {
  it('parses today and tasks routes', () => {
    expect(parseStartParam('today')).toEqual({ tab: 'today' });
    expect(parseStartParam('TODAY')).toEqual({ tab: 'today' });
    expect(parseStartParam('  tasks  ')).toEqual({ tab: 'tasks' });
    expect(parseStartParam('Tasks')).toEqual({ tab: 'tasks' });
    expect(parseStartParam('task_42')).toEqual({ tab: 'tasks', taskId: '42' });
    expect(parseStartParam('TASK_Abc-99')).toEqual({ tab: 'tasks', taskId: 'Abc-99' });
  });

  it('parses finances, liabilities queues, and bank routes preserving bank casing', () => {
    expect(parseStartParam('finances')).toEqual({ tab: 'finances' });
    expect(parseStartParam('BALANCE')).toEqual({ tab: 'finances' });
    expect(parseStartParam('debts')).toEqual({ tab: 'finances', liabilityQueue: 'bank' });
    expect(parseStartParam('Liabilities')).toEqual({ tab: 'finances', liabilityQueue: 'bank' });

    expect(parseStartParam('queue_bank')).toEqual({ tab: 'finances', liabilityQueue: 'bank' });
    expect(parseStartParam('QUEUE_1')).toEqual({ tab: 'finances', liabilityQueue: 'queue_1' });
    expect(parseStartParam('queue_2')).toEqual({ tab: 'finances', liabilityQueue: 'queue_2' });
    expect(parseStartParam('queue_3')).toEqual({ tab: 'finances', liabilityQueue: 'queue_3' });
    expect(parseStartParam('Queue_Investors')).toEqual({
      tab: 'finances',
      liabilityQueue: 'investors',
    });

    expect(parseStartParam('fin_MainCard')).toEqual({ tab: 'finances', bankName: 'MainCard' });
    expect(parseStartParam('FIN_SavingsBank')).toEqual({
      tab: 'finances',
      bankName: 'SavingsBank',
    });
    expect(parseStartParam('bank_Основной.Счёт')).toEqual({
      tab: 'finances',
      bankName: 'Основной.Счёт',
    });
    expect(parseStartParam('BANK_Cash_EUR')).toEqual({ tab: 'finances', bankName: 'Cash_EUR' });
  });

  it('parses notes, inbox, raw, and numeric note deep links', () => {
    expect(parseStartParam('inbox')).toEqual({ tab: 'notes' });
    expect(parseStartParam('INBOX')).toEqual({ tab: 'notes' });
    expect(parseStartParam('raw')).toEqual({ tab: 'notes', noteCol: 'raw' });
    expect(parseStartParam('RAW')).toEqual({ tab: 'notes', noteCol: 'raw' });
    expect(parseStartParam('notes')).toEqual({ tab: 'notes' });
    expect(parseStartParam('Notes')).toEqual({ tab: 'notes' });
    expect(parseStartParam('note_123')).toEqual({ tab: 'notes', noteId: '123' });
    expect(parseStartParam('NOTE_7')).toEqual({ tab: 'notes', noteId: '7' });
  });

  it('parses assistant, system, meds, docs, skills, backlog, diagnostics, and dossier routes', () => {
    expect(parseStartParam('system')).toEqual({ tab: 'assistant' });
    expect(parseStartParam('ASSISTANT')).toEqual({ tab: 'assistant' });
    expect(parseStartParam('Meds')).toEqual({ tab: 'assistant' });
    expect(parseStartParam('DOCS')).toEqual({ tab: 'assistant' });
    expect(parseStartParam('skills')).toEqual({ tab: 'assistant', systemSection: 'skills' });
    expect(parseStartParam('BACKLOG')).toEqual({ tab: 'assistant', systemSection: 'skills' });
    expect(parseStartParam('diagnostics')).toEqual({ tab: 'assistant', systemSection: 'diagnostics' });
    expect(parseStartParam('dossier')).toEqual({ tab: 'assistant', openDossier: true });
    expect(parseStartParam('DoSsIeR')).toEqual({ tab: 'assistant', openDossier: true });
  });

  it('returns null for empty, malformed, or unknown params', () => {
    expect(parseStartParam(null)).toBeNull();
    expect(parseStartParam(undefined)).toBeNull();
    expect(parseStartParam('')).toBeNull();
    expect(parseStartParam('   ')).toBeNull();
    expect(parseStartParam('unknown_route')).toBeNull();
    expect(parseStartParam('task_')).toBeNull();
    expect(parseStartParam('task_   ')).toBeNull();
    expect(parseStartParam('fin_')).toBeNull();
    expect(parseStartParam('bank_')).toBeNull();
    expect(parseStartParam('bank_   ')).toBeNull();
    expect(parseStartParam('note_')).toBeNull();
    expect(parseStartParam('note_abc')).toBeNull();
    expect(parseStartParam('note_-5')).toBeNull();
    expect(parseStartParam('note_12a')).toBeNull();
  });
});

describe('readInitialStartParam', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null safely when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    expect(readInitialStartParam()).toBeNull();
  });

  it('prefers initDataUnsafe.start_param over query parameters', () => {
    stubWindow({
      location: { search: '?startapp=notes&tgWebAppStartParam=tasks' },
      Telegram: {
        WebApp: {
          initDataUnsafe: {
            start_param: 'fin_MainCard',
          },
        },
      },
    });

    expect(readInitialStartParam()).toBe('fin_MainCard');
  });

  it('falls back to ?startapp= when initDataUnsafe.start_param is absent or blank', () => {
    stubWindow({
      location: { search: '?startapp=queue_1&tgWebAppStartParam=dossier' },
      Telegram: {
        WebApp: {
          initDataUnsafe: {
            start_param: '   ',
          },
        },
      },
    });

    expect(readInitialStartParam()).toBe('queue_1');
  });

  it('falls back to ?tgWebAppStartParam= when start_param and startapp are absent', () => {
    stubWindow({
      location: { search: '?foo=bar&tgWebAppStartParam=dossier' },
    });

    expect(readInitialStartParam()).toBe('dossier');
  });

  it('returns null when no start parameter is present', () => {
    stubWindow({
      location: { search: '?foo=bar' },
      Telegram: {},
    });

    expect(readInitialStartParam()).toBeNull();
  });
});
