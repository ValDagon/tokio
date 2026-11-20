import type {
  Task,
  Category,
  UserSettings,
  Account,
  FinanceSummary,
  RunwayInfo,
  TransactionItem,
  Note,
  Medication,
  Liability,
  TrashData,
  DocChapterSummary,
  DocChapterDetail,
  StepUpdateResponse,
  TelegramWebAppInitData,
  OnboardingPayload,
  AdminInviteItem,
  AdminDashboardData,
  AccessInfo,
  CreateAccountPayload,
  UpdateAccountPayload,
  BackupRestoreResponse,
  UiConfig,
} from './types';

export type { UiConfig } from './types';
export { getCurrencySymbol } from './utils';
import { getActiveLocale, translate } from './i18n/core';

// Access Telegram WebApp global
declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        initDataUnsafe?: TelegramWebAppInitData;
        ready: () => void;
        expand: () => void;
        close: () => void;
        showAlert?: (message: string, callback?: () => void) => void;
        showConfirm?: (message: string, callback?: (confirmed: boolean) => void) => void;
        BackButton?: {
          isVisible: boolean;
          show: () => void;
          hide: () => void;
          onClick: (callback: () => void) => void;
          offClick: (callback: () => void) => void;
        };
        Serverless?: {
          call: (
            endpoint: string,
            params: Record<string, unknown>,
            callback: (
              err: { message?: string; type?: string; parameters?: Record<string, unknown> } | null,
              result: unknown
            ) => void
          ) => void;
        };
        setHeaderColor?: (color: string) => void;
        setBackgroundColor?: (color: string) => void;
        setBottomBarColor?: (color: string) => void;
        requestFullscreen?: () => void;
        disableVerticalSwipes?: () => void;
        isFullscreen?: boolean;
        safeAreaInset?: { top: number; bottom: number; left: number; right: number };
        contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
        onEvent?: (eventType: string, eventHandler: () => void) => void;
        offEvent?: (eventType: string, eventHandler: () => void) => void;
        HapticFeedback?: {
          impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
          notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
        };
        themeParams?: {
          bg_color?: string;
          text_color?: string;
          hint_color?: string;
          button_color?: string;
          button_text_color?: string;
          secondary_bg_color?: string;
        };
      };
    };
  }
}

export class AuthError extends Error {}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  skipCache?: boolean;
}

const CACHE_PREFIX = 'edge_cache:';

function getLocalCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function setLocalCache(key: string, data: unknown): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(data));
  } catch {
    // quota exceeded or storage disabled
  }
}

/**
 * Resolve Telegram initData. Some launch paths (e.g. reply-keyboard buttons, slow SDK load)
 * leave `WebApp.initData` empty, while the raw data is still present in the URL hash or storage.
 */
export const resolveInitData = (): string => {
  const fromSdk = window.Telegram?.WebApp?.initData;
  if (fromSdk) {
    try {
      sessionStorage.setItem('tg_init_data', fromSdk);
      localStorage.setItem('tg_init_data', fromSdk);
    } catch { /* storage unavailable */ }
    return fromSdk;
  }
  try {
    const hash = window.location.hash.replace(/^#/, '');
    const fromHash = new URLSearchParams(hash).get('tgWebAppData');
    if (fromHash) {
      sessionStorage.setItem('tg_init_data', fromHash);
      localStorage.setItem('tg_init_data', fromHash);
      return fromHash;
    }
    return (
      sessionStorage.getItem('tg_init_data') ||
      localStorage.getItem('tg_init_data') ||
      ''
    );
  } catch {
    return '';
  }
};

function encodeInitDataForAuth(initData: string): string {
  try {
    return btoa(initData);
  } catch {
    try {
      return btoa(encodeURIComponent(initData));
    } catch {
      return initData;
    }
  }
}

export const getHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const initData = resolveInitData();
  if (initData) {
    headers['X-Telegram-Init-Data'] = initData;
    headers['Authorization'] = `TMA ${encodeInitDataForAuth(initData)}`;
  }
  return headers;
};

export const triggerHaptic = (style: 'light' | 'medium' | 'success' = 'light') => {
  if (style === 'success') {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
  } else {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(style);
  }
};

/**
 * Адрес прямого HTTP-API. В проде его нет: Mini App живёт на том же хосте, что
 * и бот, и ходит через Serverless RPC. Пустая база — норма. Чужой origin
 * (Render) сюда не подставляется: иначе запросы молча уходят в другую базу.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

const API_TIMEOUT_MS = 25000;
const API_MAX_ATTEMPTS = 3;

export const apiFetch = async (path: string, init?: RequestInit): Promise<Response> => {
  const url = path.startsWith('http') ? path : `${API_BASE}${path.startsWith('/') ? path : '/' + path}`;
  const method = (init?.method || 'GET').toUpperCase();
  // Only idempotent requests are retried automatically
  const attempts = method === 'GET' ? API_MAX_ATTEMPTS : 1;
  let lastError: unknown = null;

  const reqHeaders = new Headers(init?.headers);
  const initData = resolveInitData();
  if (initData) {
    if (!reqHeaders.has('X-Telegram-Init-Data')) {
      reqHeaders.set('X-Telegram-Init-Data', initData);
    }
    if (!reqHeaders.has('Authorization') || url.includes('tgcloud.ai')) {
      reqHeaders.set('Authorization', `TMA ${encodeInitDataForAuth(initData)}`);
    }
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, headers: reqHeaders, signal: controller.signal });
      if ([502, 503, 504].includes(res.status) && attempt < attempts) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        let detail = '';
        try { detail = ((await res.clone().json()) as { detail?: string }).detail ?? ''; } catch { /* non-JSON body */ }
        const loc = getActiveLocale();
        const hasInit = resolveInitData() ? translate(loc, 'errors.initDataPresent') : translate(loc, 'errors.initDataMissing');
        throw new AuthError(`${res.status} ${detail} (${hasInit})`);
      }
      return res;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      lastError = err;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const loc = getActiveLocale();
  const reason = lastError instanceof DOMException && lastError.name === 'AbortError'
    ? translate(loc, 'errors.timeoutError')
    : translate(loc, 'errors.networkError');
  throw new Error(reason);
};

/**
 * Helper to ensure an HTTP response is OK, extracting and surfacing FastAPI's `detail` message if available.
 */
export async function ensureOk(res: Response, fallback: string): Promise<Response> {
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (typeof data?.detail === 'string') {
        detail = data.detail.trim();
      } else if (Array.isArray(data?.detail)) {
        detail = data.detail
          .map((item: { msg?: string }) => (typeof item === 'object' && item && 'msg' in item && typeof item.msg === 'string' ? item.msg : JSON.stringify(item)))
          .join(', ');
      } else if (data?.detail && typeof data.detail === 'object') {
        detail = JSON.stringify(data.detail);
      }
    } catch {
      // Body not JSON
    }
    throw new Error(detail ? `${fallback}: ${detail}` : fallback);
  }
  return res;
}

interface ServerlessRpcPayload {
  path: string;
  method: string;
  body?: unknown;
  userId?: number;
  headers?: Record<string, string>;
}

function callServerlessRpc<T>(payload: ServerlessRpcPayload): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const serverless = window.Telegram?.WebApp?.Serverless;
    if (!serverless || typeof serverless.call !== 'function') {
      reject(new Error('Serverless.call not available'));
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error('Serverless RPC timeout'));
    }, 15000);

    try {
      serverless.call('rpc', payload as unknown as Record<string, unknown>, (err, result) => {
        clearTimeout(timer);
        if (err) {
          reject(new Error(err.message || 'Serverless RPC error'));
          return;
        }
        resolve(result as T);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

/**
 * Universal request engine:
 * 1. Prioritizes Telegram Serverless RPC ('rpc' endpoint) on V8 Edge.
 * 2. Falls back to direct FastAPI fetch via API_BASE if Serverless is unavailable.
 * 3. Falls back to localStorage cache for GET requests when offline.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const normPath = path.startsWith('/') ? path : '/' + path;

  // 1. Priority: Try Telegram Serverless RPC on Edge
  const serverless = window.Telegram?.WebApp?.Serverless;
  if (serverless && typeof serverless.call === 'function') {
    try {
      const initData = resolveInitData();
      const headers = getHeaders();
      const userId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;

      const rpcResult = await callServerlessRpc<T>({
        path: normPath,
        method,
        body: options.body,
        userId,
        headers: {
          ...headers,
          ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
        },
      });

      // Cache successful GET responses in localStorage for instant reload
      if (method === 'GET' && !options.skipCache && rpcResult !== undefined) {
        setLocalCache(normPath, rpcResult);
      }
      return rpcResult;
    } catch (err) {
      console.warn('Serverless RPC call failed, falling back to direct API fetch:', err);
    }
  }

  // 2. Direct fetch to FastAPI backend
  try {
    const fetchInit: RequestInit = {
      method,
      headers: {
        ...getHeaders(),
        ...options.headers,
      },
    };
    if (options.body !== undefined && method !== 'GET') {
      fetchInit.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    let res: Response;
    if (API_BASE.includes('tgcloud.ai')) {
      const initData = resolveInitData();
      res = await apiFetch('/api/rpc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getHeaders(),
          ...options.headers,
        },
        body: JSON.stringify({
          path: normPath,
          method,
          body: options.body,
          userId: window.Telegram?.WebApp?.initDataUnsafe?.user?.id,
          headers: {
            ...getHeaders(),
            ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
          },
        }),
      });
    } else {
      res = await apiFetch(normPath, fetchInit);
    }
    await ensureOk(res, `Request failed: ${method} ${normPath}`);

    const text = await res.text();
    if (!text || !text.trim()) {
      return {} as T;
    }

    const data = JSON.parse(text) as T;
    if (method === 'GET' && !options.skipCache) {
      setLocalCache(normPath, data);
    }
    return data;
  } catch (err) {
    // 3. Fallback to localStorage cache for GET if network or backend fails
    if (method === 'GET') {
      const cached = getLocalCache<T>(normPath);
      if (cached !== null) {
        return cached;
      }
    }
    throw err;
  }
}

// --- Categories ---

export async function fetchCategories(): Promise<Category[]> {
  return request<Category[]>('/api/categories');
}

export async function createCategory(name: string, color?: string): Promise<Category> {
  return request<Category>('/api/categories', {
    method: 'POST',
    body: { name, color },
  });
}

// --- Tasks ---

export async function fetchTasks(
  categoryId?: string,
  status: string = 'todo',
  subcategoryId?: string
): Promise<Task[]> {
  const params = new URLSearchParams();
  if (categoryId) params.append('category_id', categoryId);
  if (subcategoryId) params.append('subcategory_id', subcategoryId);
  if (status) params.append('status', status);

  const qs = params.toString();
  return request<Task[]>(qs ? `/api/tasks?${qs}` : '/api/tasks');
}

export async function createTask(data: {
  title: string;
  item_type?: 'task' | 'event';
  category_id?: string;
  category_name?: string;
  subcategory_id?: string;
  subcategory_name?: string;
  notes?: string;
  steps?: string[];
  due_at?: string;
  remind_at?: string;
  recurrence?: string;
}): Promise<Task> {
  return request<Task>('/api/tasks', {
    method: 'POST',
    body: data,
  });
}

export async function updateTask(
  taskId: string,
  updates: {
    title?: string;
    item_type?: 'task' | 'event';
    status?: string;
    notes?: string;
    category_id?: string;
    subcategory_id?: string;
    due_at?: string | null;
    remind_at?: string | null;
    recurrence?: string | null;
  }
): Promise<void> {
  await request<void>(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: updates,
  });
}

export async function deleteTask(taskId: string): Promise<void> {
  await request<void>(`/api/tasks/${taskId}`, {
    method: 'DELETE',
  });
}

// --- User Settings & Life Context ---

export async function fetchSettings(): Promise<UserSettings> {
  try {
    return await request<UserSettings>('/api/settings');
  } catch {
    return await request<UserSettings>('/api/user/settings');
  }
}

export async function updateSettings(updates: Partial<UserSettings>): Promise<UserSettings> {
  try {
    return await request<UserSettings>('/api/settings', {
      method: 'PUT',
      body: updates,
    });
  } catch {
    return await request<UserSettings>('/api/user/settings', {
      method: 'PATCH',
      body: updates,
    });
  }
}

export async function completeOnboarding(payload: OnboardingPayload): Promise<UserSettings> {
  return request<UserSettings>('/api/settings/onboarding', {
    method: 'POST',
    body: payload,
  });
}

// --- Admin Access & Invites Management ---

export async function fetchAdminUsers(): Promise<AdminDashboardData> {
  return request<AdminDashboardData>('/api/admin/users');
}

export async function createAdminInvite(note: string, maxUses: number = 1): Promise<AdminInviteItem> {
  return request<AdminInviteItem>('/api/admin/invites', {
    method: 'POST',
    body: { note, max_uses: maxUses },
  });
}

export async function deleteAdminInvite(code: string): Promise<void> {
  await request<void>(`/api/admin/invites/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  });
}

export async function updateAdminUser(
  telegramId: number,
  patch: { is_approved?: boolean; daily_msg_limit?: number; role?: string }
): Promise<void> {
  await request<void>(`/api/admin/users/${telegramId}`, {
    method: 'PATCH',
    body: patch,
  });
}

export async function fetchLifeContext(topic?: string, depth: number = 1): Promise<{ context: string }> {
  const params = new URLSearchParams();
  if (topic) params.append('topic', topic);
  if (depth > 1) params.append('depth', String(depth));
  const qs = params.toString();
  return request<{ context: string }>(qs ? `/api/user/life-context?${qs}` : '/api/user/life-context');
}

// --- Finances ---

export async function fetchAccounts(): Promise<Account[]> {
  return request<Account[]>('/api/finances/accounts');
}

export async function createAccount(payload: CreateAccountPayload): Promise<Account> {
  return request<Account>('/api/finances/accounts', {
    method: 'POST',
    body: payload,
  });
}

export async function updateAccount(
  accountId: string,
  payload: UpdateAccountPayload
): Promise<Account> {
  return request<Account>(`/api/finances/accounts/${accountId}`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function fetchFinanceSummary(): Promise<FinanceSummary> {
  return request<FinanceSummary>('/api/finances/summary');
}

export async function fetchRunway(): Promise<RunwayInfo> {
  return request<RunwayInfo>('/api/finances/runway');
}

export async function fetchTransactions(limit: number = 50): Promise<TransactionItem[]> {
  return request<TransactionItem[]>(`/api/finances/transactions?limit=${limit}`);
}

export async function setBudget(categoryName: string, limitAmountEur: number): Promise<void> {
  await request<void>('/api/finances/budgets', {
    method: 'POST',
    body: { category_name: categoryName, limit_amount_eur: limitAmountEur },
  });
}

export async function fetchLiabilities(): Promise<Liability[]> {
  return request<Liability[]>('/api/finances/liabilities');
}

export async function payLiability(
  liabilityId: string,
  data: { amount?: number; account_id?: string; deduct_from_account?: boolean; payment_date?: string } = {}
): Promise<void> {
  await request<void>(`/api/finances/liabilities/${liabilityId}/pay`, {
    method: 'POST',
    body: data,
  });
}

export async function updateLiability(
  liabilityId: string,
  data: { account_id?: string | null; notes?: string | null; monthly_payment?: number | null; payment_day?: number | null }
): Promise<Liability> {
  return request<Liability>(`/api/finances/liabilities/${liabilityId}`, {
    method: 'PATCH',
    body: data,
  });
}

export async function undoLastTransaction(): Promise<{ status: string; message: string }> {
  return request<{ status: string; message: string }>('/api/finances/undo', {
    method: 'POST',
  });
}

export async function resetFinances(): Promise<void> {
  await request<void>('/api/finances/reset', {
    method: 'POST',
  });
}

// --- Notes ---

export async function fetchNotes(column?: string): Promise<Note[]> {
  const url = column ? `/api/notes?column=${encodeURIComponent(column)}` : '/api/notes';
  return request<Note[]>(url);
}

export async function createNote(text: string, column: string = 'inbox'): Promise<Note> {
  return request<Note>('/api/notes', {
    method: 'POST',
    body: { text, column },
  });
}

export async function updateNote(
  noteId: string,
  updates: { clean_text?: string; column?: string }
): Promise<Note> {
  return request<Note>(`/api/notes/${noteId}`, {
    method: 'PATCH',
    body: updates,
  });
}

export async function deleteNote(noteId: string): Promise<void> {
  await request<void>(`/api/notes/${noteId}`, {
    method: 'DELETE',
  });
}

// --- Medications ---

export async function fetchMedications(): Promise<Medication[]> {
  return request<Medication[]>('/api/medications');
}

export async function createMedication(data: {
  name: string;
  dosage: string;
  times?: string[];
  frequency?: string;
  instructions?: string;
}): Promise<Medication> {
  return request<Medication>('/api/medications', {
    method: 'POST',
    body: data,
  });
}

export async function takeMedication(
  medId: string,
  scheduledTime?: string
): Promise<{ status: string; scheduled_time: string }> {
  const url = scheduledTime
    ? `/api/medications/${medId}/take?scheduled_time=${encodeURIComponent(scheduledTime)}`
    : `/api/medications/${medId}/take`;
  return request<{ status: string; scheduled_time: string }>(url, {
    method: 'POST',
  });
}

export async function skipMedication(
  medId: string,
  scheduledTime?: string
): Promise<{ status: string; scheduled_time: string }> {
  const url = scheduledTime
    ? `/api/medications/${medId}/skip?scheduled_time=${encodeURIComponent(scheduledTime)}`
    : `/api/medications/${medId}/skip`;
  return request<{ status: string; scheduled_time: string }>(url, {
    method: 'POST',
  });
}

export async function deleteMedication(medId: string): Promise<void> {
  await request<void>(`/api/medications/${medId}`, {
    method: 'DELETE',
  });
}

export async function updateStepStatus(stepId: string, status: string): Promise<StepUpdateResponse> {
  return request<StepUpdateResponse>(`/api/steps/${stepId}`, {
    method: 'PATCH',
    body: { status },
  });
}

// --- Trash & Recycle Bin ---

export async function fetchTrash(): Promise<TrashData> {
  return request<TrashData>('/api/trash');
}

export async function restoreTrashItem(itemType: 'task' | 'note', itemId: string): Promise<void> {
  await request<void>('/api/trash/restore', {
    method: 'POST',
    body: { item_type: itemType, item_id: itemId },
  });
}

export async function deleteTrashItemPermanently(itemType: 'task' | 'note', itemId: string): Promise<void> {
  await request<void>(`/api/trash/${itemType}/${itemId}`, {
    method: 'DELETE',
  });
}

export async function emptyTrash(): Promise<{ status: string; tasks_purged: number; notes_purged: number }> {
  return request<{ status: string; tasks_purged: number; notes_purged: number }>('/api/trash/empty', {
    method: 'POST',
  });
}

// --- Documentation Chapters ---

export async function fetchDocChapters(): Promise<DocChapterSummary[]> {
  return request<DocChapterSummary[]>('/api/docs/chapters');
}

export async function fetchDocChapterDetail(slug: string): Promise<DocChapterDetail> {
  return request<DocChapterDetail>(`/api/docs/chapters/${encodeURIComponent(slug)}`);
}

// --- System, BYOK & Backup ---

export async function fetchAccessInfo(): Promise<AccessInfo> {
  return request<AccessInfo>('/api/system/access');
}

export async function saveByokKey(apiKey: string): Promise<{ status: string; message?: string }> {
  return request<{ status: string; message?: string }>('/api/system/byok', {
    method: 'POST',
    body: { api_key: apiKey },
  });
}

export async function clearByokKey(): Promise<{ status: string; message?: string }> {
  return request<{ status: string; message?: string }>('/api/system/byok', {
    method: 'DELETE',
  });
}

export async function exportBackupJson(): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>('/api/system/backup/json');
}

export const DEFAULT_UI_CONFIG: UiConfig = {
  brand: {
    assistantName: 'Tokio',
    backupPrefix: 'tokio-backup',
    supportContact: '',
  },
  features: {
    feedbackEnabled: true,
    calmModeUi: true,
    onboardingWizard: true,
  },
  finance: {
    reserveAmount: 0,
  },
  miniapp: {
    tabs: ['today', 'tasks', 'finances', 'notes', 'system'],
    accountThemes: [],
  },
};

export async function fetchUiConfig(): Promise<UiConfig> {
  try {
    const raw = await request<Partial<UiConfig>>('/api/config/ui', { skipCache: true });
    return {
      brand: {
        ...DEFAULT_UI_CONFIG.brand,
        ...(raw?.brand || {}),
      },
      features: {
        ...DEFAULT_UI_CONFIG.features,
        ...(raw?.features || {}),
      },
      finance: {
        ...DEFAULT_UI_CONFIG.finance,
        ...(raw?.finance || {}),
      },
      miniapp: {
        tabs: Array.isArray(raw?.miniapp?.tabs) && raw.miniapp.tabs.length > 0
          ? raw.miniapp.tabs
          : DEFAULT_UI_CONFIG.miniapp.tabs,
        accountThemes: Array.isArray(raw?.miniapp?.accountThemes)
          ? raw.miniapp.accountThemes
          : DEFAULT_UI_CONFIG.miniapp.accountThemes,
      },
    };
  } catch {
    return DEFAULT_UI_CONFIG;
  }
}

export async function restoreBackupJson(
  data: Record<string, unknown>,
  mode: 'merge' | 'replace' = 'merge'
): Promise<BackupRestoreResponse> {
  return request<BackupRestoreResponse>('/api/system/backup/restore', {
    method: 'POST',
    body: { data, mode },
  });
}
