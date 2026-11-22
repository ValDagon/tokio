import type { Liability, Note, Task } from './types';

export type DeepLinkTab = 'today' | 'tasks' | 'finances' | 'notes' | 'assistant';

export type LiabilityQueueKey = Liability['queue'];

export interface DeepLinkTarget {
  tab: DeepLinkTab;
  taskId?: Task['id'];
  liabilityQueue?: LiabilityQueueKey;
  bankName?: string;
  noteCol?: Note['column'];
  noteId?: Note['id'];
  openDossier?: boolean;
}

const QUEUE_PARAM_MAP: Record<string, LiabilityQueueKey> = {
  queue_bank: 'bank',
  queue_1: 'queue_1',
  queue_2: 'queue_2',
  queue_3: 'queue_3',
  queue_investors: 'investors',
};

/**
 * Parse a Telegram Mini App `start_param` / `startapp` token into a navigation target.
 */
export function parseStartParam(raw: string | null | undefined): DeepLinkTarget | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  if (lower === 'today') {
    return { tab: 'today' };
  }

  if (lower === 'tasks') {
    return { tab: 'tasks' };
  }

  if (lower.startsWith('task_')) {
    const taskId = trimmed.slice('task_'.length).trim();
    if (!taskId) return null;
    return { tab: 'tasks', taskId };
  }

  if (lower === 'finances' || lower === 'balance') {
    return { tab: 'finances' };
  }

  if (lower === 'debts' || lower === 'liabilities') {
    return { tab: 'finances', liabilityQueue: 'bank' };
  }

  if (Object.prototype.hasOwnProperty.call(QUEUE_PARAM_MAP, lower)) {
    return { tab: 'finances', liabilityQueue: QUEUE_PARAM_MAP[lower] };
  }

  if (lower.startsWith('fin_') || lower.startsWith('bank_')) {
    const prefixLength = lower.startsWith('fin_') ? 'fin_'.length : 'bank_'.length;
    const bankName = trimmed.slice(prefixLength).trim();
    if (!bankName) return null;
    return { tab: 'finances', bankName };
  }

  if (lower === 'inbox' || lower === 'notes') {
    return { tab: 'notes' };
  }

  if (lower === 'raw') {
    return { tab: 'notes', noteCol: 'raw' };
  }

  if (lower.startsWith('note_')) {
    const noteId = trimmed.slice('note_'.length);
    if (!/^\d+$/.test(noteId)) return null;
    return { tab: 'notes', noteId };
  }

  if (lower === 'system' || lower === 'assistant' || lower === 'meds' || lower === 'docs') {
    return { tab: 'assistant' };
  }

  if (lower === 'dossier') {
    return { tab: 'assistant', openDossier: true };
  }

  return null;
}

/**
 * Read the initial Mini App start parameter from Telegram WebApp SDK or URL query params.
 */
export function readInitialStartParam(): string | null {
  if (typeof window === 'undefined') return null;

  const tgStartParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
  if (typeof tgStartParam === 'string' && tgStartParam.trim().length > 0) {
    return tgStartParam.trim();
  }

  const search = window.location?.search;
  if (search) {
    const params = new URLSearchParams(search);
    const startapp = params.get('startapp');
    if (startapp && startapp.trim().length > 0) {
      return startapp.trim();
    }
    const tgWebAppStartParam = params.get('tgWebAppStartParam');
    if (tgWebAppStartParam && tgWebAppStartParam.trim().length > 0) {
      return tgWebAppStartParam.trim();
    }
  }

  return null;
}
