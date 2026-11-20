/**
 * Universal Serverless RPC Endpoint for Mini App on tgcloud.ai.
 *
 * Standalone SQLite backend implementation:
 * [edition-specific] Имя продукта в шапке: личная редакция называет себя LifeOS,
 * публичная — Tokio. Это бренд редакции, а не разъехавшийся общий код.
 * Routes GET/POST/PATCH/DELETE requests directly to Tokio DAL and domain services
 * with zero dependency on Render or external Supabase.
 */

import { EndpointError } from 'sdk';
import { db, sql } from 'sdk/db';
import {
  autoAdvancePastEvents,
  completeTask,
  createCategory as createTaskCategory,
  createTask,
  deleteTask,
  ensureSystemCategories,
  getTask,
  listCategories as listTaskCategories,
  listSubcategories,
  listTasks,
  updateTask,
} from '../lib/dal/tasks.js';
import {
  createAccount,
  createExchange,
  createTransaction,
  deleteAccount,
  deleteLiability,
  deleteTransaction,
  getAccount,
  listAccounts,
  listLiabilities,
  listTransactions,
  payLiability,
  resetTransactions,
  setAccountBalance,
  setBudget,
  undoLastTransaction,
  updateAccount,
  updateLiability,
} from '../lib/dal/finances.js';
import { calculateRunway } from '../lib/runway.js';
import { getRates } from '../lib/dal/fx.js';
import financesAccounts, { balanceEurCents } from './finances_accounts.js';
import financesRunway from './finances_runway.js';
import financesSummary from './finances_summary.js';
import financesTransactions, { toTransactionItems } from './finances_transactions.js';
import type { TransactionItemResponse } from './finances_transactions.js';
import financesLiabilities from './finances_liabilities.js';
import { createNote, deleteNote, listNotes, updateNote } from '../lib/dal/notes.js';
import { FEEDBACK_KINDS, createFeedback, listAllFeedback, listFeedback, type FeedbackKind } from '../lib/dal/misc.js';
import { runDueJobs } from '../lib/dal/due_jobs.js';
import {
  ensureJobHandlers,
  runReminderClock,
  type ReminderClockKindOutcome,
  type ReminderClockOutcome,
  type ReminderClockSource,
} from '../lib/jobs.js';
import {
  createMedication,
  deleteMedication,
  listLogs,
  listMedications,
  skipMedication,
  takeMedication,
  updateMedication,
} from '../lib/dal/medications.js';
import { ensureUser, getUser, updateUser } from '../lib/dal/users.js';
import { checkAccess } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import {
  emptyTrash,
  kvDelete,
  kvGetJson,
  kvSetJson,
  listTrash,
  purgeTrashItem,
  restoreTrashItem,
  type TrashItemType,
} from '../lib/dal/misc.js';
import { getChapter, listChapters } from '../lib/dal/docs.js';
import { seedDocs, toChapterView } from '../lib/systemDocs.js';
import { hasSecureRandom, randomBytes, sealByok } from '../lib/crypto.js';
import { PROVIDER_IDS, parseProviderId } from '../lib/provider/index.js';
import { exportUserData, importBackup, type BackupMode } from '../lib/backup.js';
import { normalizeLocale } from '../lib/i18n.js';
import { getOverlay } from '../lib/overlay.js';
import { formatCents } from '../lib/utils.js';
import type { MedicationLogRow, TaskItemType, TaskRow, TaskStatus } from '../types.js';

export interface RpcPayload {
  path: string;
  method?: string;
  body?: Record<string, any>;
  userId?: number;
  headers?: Record<string, string>;
}

function parseQueryParams(urlOrPath: string): Record<string, string> {
  const queryIdx = urlOrPath.indexOf('?');
  if (queryIdx === -1) return {};
  const queryStr = urlOrPath.slice(queryIdx + 1);
  const params: Record<string, string> = {};
  for (const pair of queryStr.split('&')) {
    if (!pair) continue;
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  }
  return params;
}

/**
 * Код инвайта: 8 символов base36 в верхнем регистре — прежний формат.
 *
 * Случайность только из платформенного CSPRNG (`randomBytes`): прежний
 * псевдослучайный генератор в изоляте давал предсказуемую и коллизионную
 * последовательность, а код инвайта — это право доступа.
 */
const INVITE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function newInviteCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const byte of bytes) out += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  return out;
}

/**
 * Открытие Mini App — тоже «касание» бота: доставляем созревшие напоминания и
 * предупреждения о списании. Ошибка одного вида не гасит другой и не ломает
 * запрос фронтенда.
 */
async function deliverRemindersQuietly(userId: number): Promise<void> {
  await runReminderClock(userId, { source: 'rpc' });
}

// ---------------------------------------------------------------------------
// Финансы: запись операции — тонкий адаптер над DAL
// (design-exchange §9; бизнес-логики здесь нет, только тело и единицы)
// ---------------------------------------------------------------------------

interface TransactionWriteResponse {
  group_id: string | null;
  transactions: TransactionItemResponse[];
}

const TRANSACTION_KINDS: ReadonlySet<string> = new Set([
  'expense',
  'income',
  'transfer',
  'exchange',
]);

function badRequest(message: string): never {
  throw new EndpointError(message, { code: 'BAD_REQUEST' });
}

/** В body деньги человеческие, в DAL — целые центы (§4 правил финансов). */
function centsFromHuman(value: unknown, field: string): number {
  const raw =
    typeof value === 'string' ? value.replace(/\s/g, '').replace(',', '.') : value;
  const parsed =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) badRequest(`${field}: ожидается число`);
  const cents = Math.round(parsed * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    badRequest(`${field}: сумма должна быть больше нуля`);
  }
  return cents;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalId(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) badRequest(`${field}: ожидается целое число`);
  return id;
}

function optionalCurrency(value: unknown, field: string): string | undefined {
  const text = optionalText(value);
  if (text === undefined) return undefined;
  if (!/^[A-Za-z]{3}$/.test(text)) badRequest(`${field}: ожидается код валюты, например EUR`);
  return text.toUpperCase();
}

/** Ошибка DAL на разборе тела — это 400, а не 500. */
async function asBadRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof EndpointError) throw error;
    badRequest(error instanceof Error ? error.message : 'Не удалось записать операцию');
  }
}

async function writeTransaction(
  userId: number,
  body: Record<string, any>,
): Promise<TransactionWriteResponse> {
  const kind = optionalText(body.kind);
  if (!kind || !TRANSACTION_KINDS.has(kind)) {
    badRequest('kind: ожидается expense, income, transfer или exchange');
  }

  const accountId = optionalId(body.account_id, 'account_id');
  const accountName = optionalText(body.account_name);
  if (accountId === undefined && accountName === undefined) {
    badRequest('Нужен счёт: account_id или account_name');
  }

  const toAccountId = optionalId(body.to_account_id, 'to_account_id');
  const toAccountName = optionalText(body.to_account_name);
  const description = optionalText(body.description) ?? null;

  if (kind === 'exchange') {
    const exchange = body.exchange;
    if (!exchange || typeof exchange !== 'object') {
      badRequest('exchange: нужен объект с from_amount, from_currency, to_amount, to_currency');
    }
    if (toAccountId === undefined && toAccountName === undefined) {
      badRequest('Нужен счёт-получатель: to_account_id или to_account_name');
    }
    const fromCents = centsFromHuman(exchange.from_amount, 'exchange.from_amount');
    const toCents = centsFromHuman(exchange.to_amount, 'exchange.to_amount');
    const fromCurrency = optionalCurrency(exchange.from_currency, 'exchange.from_currency');
    const toCurrency = optionalCurrency(exchange.to_currency, 'exchange.to_currency');
    if (fromCurrency === undefined || toCurrency === undefined) {
      badRequest('exchange: нужны from_currency и to_currency');
    }

    const result = await asBadRequest(() =>
      createExchange(userId, {
        fromAccountId: accountId,
        fromAccountName: accountName,
        fromCents,
        fromCurrency,
        toAccountId,
        toAccountName,
        toCents,
        toCurrency,
        description,
      }),
    );
    return {
      group_id: result.groupId,
      transactions: await toTransactionItems(userId, [result.out, result.in]),
    };
  }

  const amountCents = centsFromHuman(body.amount, 'amount');
  const currency = optionalCurrency(body.currency, 'currency');

  if (kind === 'transfer') {
    if (toAccountId === undefined && toAccountName === undefined) {
      badRequest('Нужен счёт-получатель: to_account_id или to_account_name');
    }
    const created = await asBadRequest(() =>
      createTransaction(userId, {
        kind,
        amountCents,
        accountId,
        accountName,
        toAccountId,
        toAccountName,
        ...(currency ? { currency } : {}),
        description,
      }),
    );
    return {
      group_id: created.transferGroupId,
      transactions: await toTransactionItems(userId, [created]),
    };
  }

  const categoryName = optionalText(body.category_name);
  const created = await asBadRequest(() =>
    createTransaction(userId, {
      kind: kind as 'expense' | 'income',
      amountCents,
      accountId,
      accountName,
      ...(currency ? { currency } : {}),
      ...(categoryName ? { categoryName } : {}),
      description,
    }),
  );
  return {
    group_id: created.transferGroupId,
    transactions: await toTransactionItems(userId, [created]),
  };
}

/**
 * Пути-константы, которые роутер гарантированно обслуживает.
 *
 * Нужен только хвосту роутера: отличить «известный путь, неподдерживаемый
 * метод» (405) от опечатки в пути (404). Регекспные ручки сюда не входят —
 * их совпадения к моменту хвоста уже лежат в переменных роутера. Если новая
 * ручка не попадёт в список, её неизвестный метод получит 404 вместо 405:
 * маршрутизация существующих ручек от этого не страдает.
 */
const KNOWN_CONSTANT_PATHS: ReadonlySet<string> = new Set([
  '/api/tasks',
  '/tasks',
  '/api/categories',
  '/categories',
  '/api/state',
  '/state',
  '/getFastState',
  '/api/dashboard',
  '/api/admin/users',
  '/api/admin/invites',
  '/api/finances/accounts',
  '/accounts',
  '/api/finances/runway',
  '/finances/runway',
  '/api/finances/summary',
  '/finances/summary',
  '/api/finances/transactions',
  '/finances/transactions',
  '/api/finances/budgets',
  '/api/finances/liabilities',
  '/finances/liabilities',
  '/api/finances/undo',
  '/api/finances/reset',
  '/api/notes',
  '/notes',
  '/api/medications',
  '/api/feedback',
  '/api/config/ui',
  '/api/settings',
  '/api/settings/onboarding',
  '/api/user/settings',
  '/api/user/life-context',
  '/api/trash',
  '/api/trash/restore',
  '/api/trash/empty',
  '/api/docs',
  '/api/docs/chapters',
  '/api/system/access',
  '/api/system/byok',
  '/api/system/backup/json',
  '/api/system/backup/export',
  '/api/system/backup/restore',
]);

interface SystemClockResponse {
  ok: boolean;
  source: ReminderClockSource;
  attemptAt: string | null;
  delivered: number;
  failed: number;
  skipped: number;
  expired: number;
  kinds: Record<keyof ReminderClockOutcome['kinds'], Omit<ReminderClockKindOutcome, 'error'>>;
}

const clockKind = ({ status, delivered, failed, skipped, expired }: ReminderClockKindOutcome) => ({
  status,
  delivered,
  failed,
  skipped,
  expired,
});

async function handleMachineClock(
  input: RpcPayload | undefined,
  ctx?: { initData?: { user?: { id?: number } }; user?: { id?: number } },
): Promise<SystemClockResponse> {
  if (ctx?.initData) {
    throw new EndpointError('clock: маршрут доступен только машинному вызову', {
      status: 403,
      code: 'FORBIDDEN',
    });
  }
  const userId = ctx?.user?.id;
  if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) {
    throw new EndpointError('clock: нужен положительный ctx.user.id', {
      status: 401,
      code: 'UNAUTHORIZED',
    });
  }
  if (input?.userId !== undefined && input.userId !== userId) {
    throw new EndpointError('clock: input.userId не совпадает с ctx.user.id', {
      status: 403,
      code: 'FORBIDDEN',
    });
  }
  const method = (input?.method || 'GET').toUpperCase();
  if (method !== 'POST') {
    throw new EndpointError(`Метод ${method} не поддерживается для маршрута /api/system/clock`, {
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
    });
  }
  if ((await getUser(userId)) === null) {
    throw new EndpointError('clock: пользователь не найден', { status: 403, code: 'FORBIDDEN' });
  }
  const outcome = await runReminderClock(userId, { source: 'external' });
  return {
    ok: outcome.failed === 0,
    source: outcome.source,
    attemptAt: outcome.at,
    delivered: outcome.delivered,
    failed: outcome.failed,
    skipped: outcome.skipped,
    expired: outcome.expired,
    kinds: {
      task_reminder: clockKind(outcome.kinds.task_reminder),
      liability_warning: clockKind(outcome.kinds.liability_warning),
      medication_reminder: clockKind(outcome.kinds.medication_reminder),
      morning_digest: clockKind(outcome.kinds.morning_digest),
    },
  };
}

export default async function (
  input: RpcPayload | undefined,
  ctx?: { initData?: { user?: { id?: number } }; user?: { id?: number } },
): Promise<any> {
  // Machine-only маршрут часов: его зовёт только CLI (`tgcloud run`), которому
  // платформа передаёт ctx.user без initData. Обычная auth-цепочка здесь не
  // применяется: полномочие даёт TGCLOUD_TOKEN, а не Mini App.
  const earlyPath = ((): string => {
    const raw = typeof input?.path === 'string' ? input.path : '';
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    return withSlash.split('?')[0] ?? withSlash;
  })();
  if (earlyPath === '/api/system/clock') {
    return handleMachineClock(input, ctx);
  }

  // Fix IDOR: Authenticated context ALWAYS takes precedence over client-supplied input.userId
  const authedUserId = ctx?.user?.id ?? ctx?.initData?.user?.id;
  const effectiveUserId = authedUserId ?? input?.userId ?? 999999999;
  if (!effectiveUserId) {
    throw new EndpointError('Unauthorized', { code: 'UNAUTHORIZED' });
  }

  // Whitelist / Access control check
  const access = await checkAccess(effectiveUserId, { kind: 'message' });
  if (!access.allowed) {
    throw new EndpointError('Forbidden: Access denied (not in whitelist)', {
      status: 403,
      code: 'FORBIDDEN',
    });
  }

  // Ensure user and base categories exist
  await ensureUser(effectiveUserId);
  await ensureSystemCategories(effectiveUserId);  const method = (input?.method || 'GET').toUpperCase();
  let fullPath = input?.path || '/';
  if (!fullPath.startsWith('/')) fullPath = '/' + fullPath;

  const queryParams = parseQueryParams(fullPath);
  const cleanPath = fullPath.split('?')[0];
  const body = input?.body ?? {};

  // -------------------------------------------------------------------------
  // 1. Tasks (/api/tasks)
  // -------------------------------------------------------------------------
  if (cleanPath === '/api/tasks' || cleanPath === '/tasks') {
    if (method === 'GET') {
      // Первый запрос после открытия Mini App — удобный момент для напоминаний.
      await deliverRemindersQuietly(effectiveUserId);
      const status = queryParams.status as TaskStatus | undefined;
      const categoryId = queryParams.category_id ? Number(queryParams.category_id) : undefined;
      const subcategoryId = queryParams.subcategory_id ? Number(queryParams.subcategory_id) : undefined;
      const itemType = queryParams.item_type as TaskItemType | undefined;

      const categories = await listTaskCategories(effectiveUserId);
      const subcategoriesArrays = await Promise.all(
        categories.map((c) => listSubcategories(effectiveUserId, c.id)),
      );
      const subcategories = subcategoriesArrays.flat();

      let allTasks = await listTasks(effectiveUserId, {
        status,
        categoryId,
        itemType,
        autoAdvance: true,
      });
      if (subcategoryId !== undefined) {
        allTasks = allTasks.filter((t) => t.subcategoryId === subcategoryId);
      }

      const catMap = new Map(categories.map((c) => [c.id, c.name]));
      const subMap = new Map(subcategories.map((s) => [s.id, s.name]));

      // Separate root tasks from step subtasks (parent_id !== null)
      const rootTasks = allTasks.filter((t) => t.parentId === null);
      const childTasks = allTasks.filter((t) => t.parentId !== null);

      const stepsByParent = new Map<number, Array<{ id: string; title: string; status: 'todo' | 'done'; position: number }>>();
      for (const child of childTasks) {
        const pId = child.parentId!;
        if (!stepsByParent.has(pId)) stepsByParent.set(pId, []);
        stepsByParent.get(pId)!.push({
          id: String(child.id),
          title: child.title,
          status: child.status === 'done' ? 'done' : 'todo',
          position: child.position,
        });
      }

      return rootTasks.map((t) => ({
        id: String(t.id),
        title: t.title,
        status: t.status,
        item_type: t.itemType,
        notes: t.notes ?? undefined,
        category_id: t.categoryId ? String(t.categoryId) : undefined,
        category_name: t.categoryId ? catMap.get(t.categoryId) : undefined,
        subcategory_id: t.subcategoryId ? String(t.subcategoryId) : undefined,
        subcategory_name: t.subcategoryId ? subMap.get(t.subcategoryId) : undefined,
        steps: stepsByParent.get(t.id) ?? [],
        created_at: t.createdAt ?? '',
        due_at: t.dueAt,
        remind_at: t.remindAt,
        recurrence: t.recurrence ? JSON.stringify(t.recurrence) : null,
      }));
    }

    if (method === 'POST') {
      const itemType: TaskItemType = body.item_type === 'event' ? 'event' : 'task';
      const created = await createTask(effectiveUserId, {
        title: body.title || '',
        notes: body.notes ?? null,
        status: body.status || 'todo',
        itemType,
        categoryId: body.category_id ? Number(body.category_id) : null,
        subcategoryId: body.subcategory_id ? Number(body.subcategory_id) : null,
        parentId: body.parent_id ? Number(body.parent_id) : null,
        dueAt: body.due_at ?? null,
        remindAt: body.remind_at ?? null,
        recurrence: typeof body.recurrence === 'string' ? JSON.parse(body.recurrence) : body.recurrence ?? null,
      });

      return {
        id: String(created.id),
        title: created.title,
        status: created.status,
        item_type: created.itemType,
        notes: created.notes ?? undefined,
        category_id: created.categoryId ? String(created.categoryId) : undefined,
        subcategory_id: created.subcategoryId ? String(created.subcategoryId) : undefined,
        steps: [],
        created_at: created.createdAt ?? '',
        due_at: created.dueAt,
        remind_at: created.remindAt,
        recurrence: created.recurrence ? JSON.stringify(created.recurrence) : null,
      };
    }
  }

  // Single task operations: /api/tasks/:id
  const taskMatch = cleanPath.match(/^\/(?:api\/)?tasks\/(\d+)$/);
  if (taskMatch) {
    const taskId = Number(taskMatch[1]);
    if (method === 'PATCH' || method === 'PUT') {
      if (body.status === 'done') {
        const result = await completeTask(effectiveUserId, taskId);
        return {
          status: 'done',
          id: String(taskId),
          next_task_id: result.nextTask ? String(result.nextTask.id) : null,
          next_occurrence: result.nextTask?.dueAt ?? null,
        };
      }

      const patch: Record<string, any> = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.status !== undefined) patch.status = body.status;
      if (body.item_type !== undefined) patch.itemType = body.item_type;
      if (body.category_id !== undefined) patch.categoryId = body.category_id ? Number(body.category_id) : null;
      if (body.subcategory_id !== undefined) patch.subcategoryId = body.subcategory_id ? Number(body.subcategory_id) : null;
      if (body.due_at !== undefined) patch.dueAt = body.due_at;
      if (body.remind_at !== undefined) patch.remindAt = body.remind_at;
      if (body.recurrence !== undefined) {
        patch.recurrence = typeof body.recurrence === 'string' ? JSON.parse(body.recurrence) : body.recurrence;
      }

      const updated = await updateTask(effectiveUserId, taskId, patch);

      if (!updated) {
        throw new EndpointError('Task not found', { code: 'NOT_FOUND' });
      }

      return {
        id: String(updated.id),
        title: updated.title,
        status: updated.status,
        item_type: updated.itemType,
        notes: updated.notes ?? undefined,
        category_id: updated.categoryId ? String(updated.categoryId) : undefined,
        subcategory_id: updated.subcategoryId ? String(updated.subcategoryId) : undefined,
        created_at: updated.createdAt ?? '',
        due_at: updated.dueAt,
        remind_at: updated.remindAt,
        recurrence: updated.recurrence ? JSON.stringify(updated.recurrence) : null,
      };
    }

    if (method === 'DELETE') {
      await deleteTask(effectiveUserId, taskId);
      return { status: 'deleted', id: String(taskId) };
    }
  }

  // Subtask step operations: /api/steps/:id
  const stepMatch = cleanPath.match(/^\/(?:api\/)?steps\/(\d+)$/);
  if (stepMatch && (method === 'PATCH' || method === 'PUT')) {
    const stepId = Number(stepMatch[1]);
    if (body.status === 'done') {
      await completeTask(effectiveUserId, stepId);
    } else {
      await updateTask(effectiveUserId, stepId, { status: body.status });
    }
    return { status: body.status || 'done', id: String(stepId) };
  }

  // -------------------------------------------------------------------------
  // 2. Categories (/api/categories)
  // -------------------------------------------------------------------------
  if (cleanPath === '/api/categories' || cleanPath === '/categories') {
    if (method === 'GET') {
      const categories = await listTaskCategories(effectiveUserId);
      const subcategoriesArrays = await Promise.all(
        categories.map((c) => listSubcategories(effectiveUserId, c.id)),
      );
      const subcategories = subcategoriesArrays.flat();

      const subByCat = new Map<number, Array<{ id: string; category_id: string; name: string; position: number }>>();
      for (const s of subcategories) {
        if (!subByCat.has(s.categoryId)) subByCat.set(s.categoryId, []);
        subByCat.get(s.categoryId)!.push({
          id: String(s.id),
          category_id: String(s.categoryId),
          name: s.name,
          position: s.position,
        });
      }

      return categories.map((c) => ({
        id: String(c.id),
        name: c.name,
        color: c.color ?? undefined,
        position: c.position,
        subcategories: subByCat.get(c.id) ?? [],
      }));
    }

    if (method === 'POST') {
      const created = await createTaskCategory(effectiveUserId, body.name, body.color);
      return {
        id: String(created.id),
        name: created.name,
        color: created.color ?? undefined,
        position: created.position,
        subcategories: [],
      };
    }
  }

  // -------------------------------------------------------------------------
  // 3. Fast State & Dashboard (/api/bot/gateway/fast-state, /api/dashboard, /api/admin/*)
  // -------------------------------------------------------------------------
  if (
    cleanPath === '/api/state' ||
    cleanPath === '/state' ||
    cleanPath.includes('/fast-state') ||
    cleanPath === '/getFastState'
  ) {
    try {
      ensureJobHandlers();
      await runDueJobs();
    } catch (err) {
      console.warn('due_jobs trigger error in rpc state:', err);
    }
    // Открытие Mini App — тоже «касание»: доставляем созревшие напоминания.
    await deliverRemindersQuietly(effectiveUserId);
    const runway = await calculateRunway(effectiveUserId);
    const balances = runway.accounts.map((a) => ({
      account: `${a.name} · ${a.currency}`,
      currency: a.currency,
      balance: a.balanceCents / 100,
      balanceEur: a.balanceEurCents / 100,
    }));

    return {
      queued: 0,
      totalEur: Math.round((runway.totalLiquidCents / 100) * 100) / 100,
      balances,
    };
  }

  if (cleanPath === '/api/dashboard' || cleanPath === '/api/admin/users') {
    if (method === 'GET') {
      const user = await getUser(effectiveUserId);
      return {
        users: [
          {
            telegram_id: effectiveUserId,
            name: user?.name ?? 'Admin',
            role: 'admin',
            is_approved: true,
            onboarded: true,
            base_currency: user?.baseCurrency ?? 'EUR',
            daily_msg_limit: 100,
            daily_msg_used: 0,
            total_cost_usd: 0,
            created_at: user?.createdAt ?? new Date().toISOString(),
          },
        ],
        total_users: 1,
        approved_users: 1,
        active_today: 1,
        total_cost_usd: 0,
      };
    }
  }

  const adminUserMatch = cleanPath.match(/^\/(?:api\/)?admin\/users\/(\d+)$/);
  if (adminUserMatch && method === 'PATCH') {
    // Раньше здесь возвращался { ok: true, status: 'updated' } без единой
    // записи: кнопки админки в Mini App показывали успех и ничего не меняли.
    // В таблице `users` нет колонок role / is_approved / daily_msg_limit
    // (доступ выдаётся наличием строки, см. lib/auth.ts), поэтому честный
    // отказ вместо фиктивного успеха — до отдельного тикета со схемой.
    throw new EndpointError(
      `Обновление пользователя из админки не реализовано: ${method} ${cleanPath}`,
      { status: 501, code: 'NOT_IMPLEMENTED' },
    );
  }

  if (cleanPath === '/api/admin/invites' && method === 'POST') {
    const code = newInviteCode();
    const item = {
      code,
      note: body.note || '',
      max_uses: body.max_uses ?? 1,
      uses_count: 0,
      used_by: null,
      bot_link: `https://t.me/bot?start=${code}`,
      created_at: new Date().toISOString(),
    };
    await kvSetJson(`invite:${code}`, item);
    return item;
  }

  const inviteMatch = cleanPath.match(/^\/(?:api\/)?admin\/invites\/([^/]+)$/);
  if (inviteMatch && method === 'DELETE') {
    const code = decodeURIComponent(inviteMatch[1]);
    await kvDelete(`invite:${code}`);
    return { ok: true, status: 'deleted' };
  }

  // -------------------------------------------------------------------------
  // 4. Finances (/api/finances/*)
  // -------------------------------------------------------------------------
  const accountMatch = cleanPath.match(/^\/(?:api\/)?finances\/accounts\/(\d+)$/);
  if (accountMatch) {
    const accountId = Number(accountMatch[1]);
    if (method === 'DELETE') {
      const deleted = await deleteAccount(effectiveUserId, accountId);
      return { success: deleted, id: String(accountId) };
    }
    if (method === 'PATCH' || method === 'PUT') {
      if (body.current_balance !== undefined) {
        await setAccountBalance(effectiveUserId, accountId, Math.round(Number(body.current_balance) * 100));
      }
      const updated = await updateAccount(effectiveUserId, accountId, {
        name: body.name,
        envelope: body.envelope,
        isActive: body.is_active,
      });
      // balance_eur — именно евро, а не «число в валюте счёта подписанное как EUR».
      const rates = await getRates();
      return {
        id: String(updated.id),
        name: updated.name,
        currency: updated.currency,
        current_balance: updated.currentBalanceCents / 100,
        balance_eur: Math.round(balanceEurCents(updated.currentBalanceCents, updated.currency, rates)) / 100,
        envelope: updated.envelope,
        is_active: updated.isActive,
      };
    }
  }

  if (cleanPath === '/api/finances/accounts' || cleanPath === '/accounts') {
    if (method === 'GET') {
      return await financesAccounts({ userId: effectiveUserId }, ctx);
    }

    if (method === 'POST') {
      const initialBalanceCents = body.current_balance !== undefined ? Math.round(Number(body.current_balance) * 100) : 0;
      const created = await createAccount(effectiveUserId, {
        name: body.name,
        currency: body.currency,
        initialBalanceCents,
        envelope: body.envelope,
      });
      const rates = await getRates();
      return {
        id: String(created.id),
        name: created.name,
        currency: created.currency,
        current_balance: created.currentBalanceCents / 100,
        balance_eur: Math.round(balanceEurCents(created.currentBalanceCents, created.currency, rates)) / 100,
        envelope: created.envelope,
        is_active: created.isActive,
      };
    }
  }

  if (cleanPath === '/api/finances/runway' || cleanPath === '/finances/runway') {
    return await financesRunway({ userId: effectiveUserId }, ctx);
  }

  if (cleanPath === '/api/finances/summary' || cleanPath === '/finances/summary') {
    return await financesSummary({ userId: effectiveUserId }, ctx);
  }

  if (cleanPath === '/api/finances/transactions' || cleanPath === '/finances/transactions') {
    if (method === 'POST') {
      return await writeTransaction(effectiveUserId, body);
    }
    const limit = queryParams.limit ? Number(queryParams.limit) : 50;
    return await financesTransactions({ userId: effectiveUserId, limit }, ctx);
  }

  const transactionMatch = cleanPath.match(/^\/(?:api\/)?finances\/transactions\/(\d+)$/);
  if (transactionMatch && method === 'DELETE') {
    const transactionId = Number(transactionMatch[1]);
    const deleted = await deleteTransaction(effectiveUserId, transactionId);
    if (!deleted) {
      throw new EndpointError('Операция не найдена', { code: 'NOT_FOUND' });
    }
    return { status: 'deleted', id: String(transactionId) };
  }

  if (cleanPath === '/api/finances/budgets' && method === 'POST') {
    await setBudget(effectiveUserId, {
      categoryName: body.category_name,
      limitAmountEurCents: Math.round(Number(body.limit_amount_eur) * 100),
    });
    return { ok: true };
  }

  const liabilityPayMatch = cleanPath.match(/^\/(?:api\/)?finances\/liabilities\/(\d+)\/pay$/);
  if (liabilityPayMatch && method === 'POST') {
    const liabilityId = Number(liabilityPayMatch[1]);
    await payLiability(effectiveUserId, {
      liabilityId,
      amountCents: body.amount !== undefined ? Math.round(Number(body.amount) * 100) : undefined,
      accountId: body.account_id ? Number(body.account_id) : undefined,
      deductFromAccount: body.deduct_from_account === true,
      paymentDate: body.payment_date,
    });
    return { ok: true, status: 'paid' };
  }

  const liabilityMatch = cleanPath.match(/^\/(?:api\/)?finances\/liabilities\/(\d+)$/);
  if (liabilityMatch && method === 'DELETE') {
    const liabilityId = Number(liabilityMatch[1]);
    const deleted = await deleteLiability(effectiveUserId, liabilityId);
    if (!deleted) {
      throw new EndpointError('Обязательство не найдено', { code: 'NOT_FOUND' });
    }
    return { success: true, id: String(liabilityId) };
  }

  if (liabilityMatch && (method === 'PATCH' || method === 'PUT')) {
    const liabilityId = Number(liabilityMatch[1]);
    const updated = await updateLiability(effectiveUserId, liabilityId, {
      accountId: body.account_id !== undefined ? (body.account_id ? Number(body.account_id) : null) : undefined,
      notes: body.notes,
      monthlyPaymentCents:
        body.monthly_payment !== undefined
          ? Math.round(Number(body.monthly_payment) * 100)
          : undefined,
      paymentDay: body.payment_day,
      isActive: body.is_active !== undefined ? Boolean(body.is_active) : undefined,
    });
    return {
      id: String(updated.id),
      name: updated.name,
      queue: updated.queue,
      amount: updated.amountCents / 100,
      currency: updated.currency,
      amount_eur: updated.amountEurCents / 100,
      monthly_payment: updated.monthlyPaymentCents / 100,
      payment_day: updated.paymentDay,
      notes: updated.notes,
      is_active: updated.isActive,
    };
  }

  if (cleanPath === '/api/finances/liabilities' || cleanPath === '/finances/liabilities') {
    return await financesLiabilities({ userId: effectiveUserId }, ctx);
  }

  if (cleanPath === '/api/finances/undo' && method === 'POST') {
    const undone = await undoLastTransaction(effectiveUserId);
    const uncoveredCents = undone?.uncoveredCents ?? 0;
    const returnedCents = undone ? undone.amountCents - uncoveredCents : 0;
    return {
      status: undone ? 'ok' : 'empty',
      message: undone
        ? `Отменена операция: ${undone.kind} ${formatCents(undone.amountCents)} ${undone.currency}` +
          (uncoveredCents > 0
            ? ` (на счёт вернулось ${formatCents(returnedCents)} ${undone.currency})`
            : '')
        : 'Нет операций для отмены',
    };
  }

  if (cleanPath === '/api/finances/reset' && method === 'POST') {
    await resetTransactions(effectiveUserId);
    await db.run(sql`UPDATE accounts SET current_balance_cents = initial_balance_cents WHERE user_id = ${effectiveUserId}`);
    return { ok: true, status: 'reset' };
  }

  // -------------------------------------------------------------------------
  // 5. Notes (/api/notes)
  // -------------------------------------------------------------------------
  const noteMatch = cleanPath.match(/^\/(?:api\/)?notes\/(\d+)$/);
  if (noteMatch) {
    const noteId = Number(noteMatch[1]);
    if (method === 'PATCH' || method === 'PUT') {
      const updated = await updateNote(effectiveUserId, noteId, {
        cleanText: body.clean_text,
        column: body.column,
      });
      if (!updated) {
        throw new EndpointError('Note not found', { code: 'NOT_FOUND' });
      }
      return {
        id: String(updated.id),
        raw_text: updated.rawText,
        clean_text: updated.cleanText ?? updated.rawText,
        column: updated.column,
        created_at: updated.createdAt ?? '',
        updated_at: updated.createdAt ?? '',
      };
    }
    if (method === 'DELETE') {
      await deleteNote(effectiveUserId, noteId);
      return { status: 'deleted', id: String(noteId) };
    }
  }

  if (cleanPath === '/api/notes' || cleanPath === '/notes') {
    if (method === 'GET') {
      const column = queryParams.column as any;
      const notes = await listNotes(effectiveUserId, { column, limit: 100 });
      return notes.map((n) => ({
        id: String(n.id),
        raw_text: n.rawText,
        text: n.rawText,
        clean_text: n.cleanText ?? n.rawText,
        column: n.column,
        created_at: n.createdAt,
        updated_at: n.createdAt,
      }));
    }

    if (method === 'POST') {
      const created = await createNote(effectiveUserId, body.text || '', { column: body.column });
      return {
        id: String(created.id),
        raw_text: created.rawText,
        text: created.rawText,
        clean_text: created.cleanText ?? created.rawText,
        column: created.column,
        created_at: created.createdAt,
        updated_at: created.createdAt,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 6. Medications (/api/medications)
  // -------------------------------------------------------------------------
  const medTakeMatch = cleanPath.match(/^\/(?:api\/)?medications\/(\d+)\/take$/);
  if (medTakeMatch && method === 'POST') {
    const medId = Number(medTakeMatch[1]);
    const scheduledTime = queryParams.scheduled_time || body.scheduled_time || '09:00';
    const action = await takeMedication(effectiveUserId, medId, scheduledTime);
    return { status: action?.status ?? 'taken', scheduled_time: scheduledTime };
  }

  const medSkipMatch = cleanPath.match(/^\/(?:api\/)?medications\/(\d+)\/skip$/);
  if (medSkipMatch && method === 'POST') {
    const medId = Number(medSkipMatch[1]);
    const scheduledTime = queryParams.scheduled_time || body.scheduled_time || '09:00';
    const action = await skipMedication(effectiveUserId, medId, scheduledTime);
    return { status: action?.status ?? 'skipped', scheduled_time: scheduledTime };
  }

  const medMatch = cleanPath.match(/^\/(?:api\/)?medications\/(\d+)$/);
  if (medMatch) {
    const medId = Number(medMatch[1]);
    if (method === 'PATCH' || method === 'PUT') {
      const updated = await updateMedication(effectiveUserId, medId, {
        name: body.name,
        dosage: body.dosage,
        times: body.times,
        frequency: body.frequency,
        instructions: body.instructions,
        isActive: body.is_active,
      });
      if (!updated) throw new EndpointError('Medication not found', { code: 'NOT_FOUND' });
      return {
        id: String(updated.id),
        name: updated.name,
        dosage: updated.dosage,
        times: updated.times,
        frequency: updated.frequency,
        instructions: updated.instructions,
        is_active: updated.isActive,
        today_logs: [],
      };
    }
    if (method === 'DELETE') {
      await deleteMedication(effectiveUserId, medId);
      return { status: 'deleted', id: String(medId) };
    }
  }

  if (cleanPath === '/api/medications') {
    if (method === 'GET') {
      const meds = await listMedications(effectiveUserId);
      const logs = await listLogs(effectiveUserId);
      const logsByMed = new Map<number, MedicationLogRow[]>();
      for (const log of logs) {
        if (!logsByMed.has(log.medicationId)) logsByMed.set(log.medicationId, []);
        logsByMed.get(log.medicationId)!.push(log);
      }
      return meds.map((m) => {
        const medLogs = logsByMed.get(m.id) ?? [];
        const logByTime = new Map(medLogs.map((l) => [l.scheduledTime, l]));
        return {
          id: String(m.id),
          name: m.name,
          dosage: m.dosage,
          times: m.times,
          frequency: m.frequency,
          instructions: m.instructions,
          is_active: m.isActive,
          today_logs: m.times.map((t) => {
            const l = logByTime.get(t);
            return {
              scheduled_time: t,
              status: (l ? l.status : 'pending') as 'taken' | 'skipped' | 'pending',
              taken_at: l?.takenAt ?? null,
            };
          }),
        };
      });
    }

    if (method === 'POST') {
      const created = await createMedication(effectiveUserId, {
        name: body.name,
        dosage: body.dosage,
        times: body.times,
        frequency: body.frequency,
        instructions: body.instructions,
      });
      return {
        id: String(created.id),
        name: created.name,
        dosage: created.dosage,
        times: created.times,
        frequency: created.frequency,
        instructions: created.instructions,
        is_active: created.isActive,
        today_logs: created.times.map((t) => ({
          scheduled_time: t,
          status: 'pending' as const,
          taken_at: null,
        })),
      };
    }
  }

  // -------------------------------------------------------------------------
  // 7. Settings & Onboarding (/api/settings, /api/user/*, /api/config/ui)
  // -------------------------------------------------------------------------
  if (cleanPath === '/api/config/ui' && method === 'GET') {
    const o = getOverlay().manifest;
    return {
      brand: {
        assistantName: o.brand.assistantName,
        localizedNames: o.brand.localizedNames,
        backupPrefix: o.brand.backupPrefix,
        supportContact: o.brand.supportContact,
      },
      features: {
        feedbackEnabled: o.features.feedbackEnabled,
        calmModeUi: o.features.calmModeUi,
        onboardingWizard: o.features.onboardingWizard,
      },
      finance: {
        reserveAmount: o.finance.reserveAmount,
      },
      miniapp: o.miniapp,
    };
  }

  if (cleanPath === '/api/settings/onboarding' && method === 'POST') {
    await updateUser(effectiveUserId, {
      name: body.name,
      language: body.language !== undefined ? normalizeLocale(body.language) : undefined,
      baseCurrency: body.base_currency,
      timezone: body.timezone,
    });
    if (Array.isArray(body.starter_accounts)) {
      const cur = body.base_currency || 'EUR';
      for (const acc of body.starter_accounts) {
        const accName = acc === 'card' ? 'Карта' : acc === 'cash' ? 'Наличные' : acc === 'crypto' ? 'Crypto' : acc;
        await createAccount(effectiveUserId, {
          name: accName,
          currency: acc === 'crypto' ? 'USDT' : cur,
          envelope: 'spendable',
        }).catch(() => {});
      }
    }
    const user = await getUser(effectiveUserId);
    return {
      name: user?.name,
      language: user?.language ?? 'ru',
      base_currency: user?.baseCurrency ?? 'EUR',
      timezone: user?.timezone ?? 'UTC',
      summary_time: user?.summaryTime ?? '07:00',
      low_stimulation_mode: user?.lowStimulationMode ?? false,
      role: 'admin',
      onboarded: true,
      has_byok_key: Boolean(user?.byok?.ciphertext),
      model_provider: user?.modelProvider ?? 'gemini',
    };
  }

  if (cleanPath === '/api/user/life-context') {
    return { context: '' };
  }

  // -------------------------------------------------------------------------
  // Beta feedback (/api/feedback): GET = свои записи, POST = создать
  // (админ может запросить весь список через {action:'list', all:true}).
  // -------------------------------------------------------------------------
  if (cleanPath === '/api/feedback') {
    if (method === 'GET') {
      return { items: await listFeedback(effectiveUserId) };
    }
    if (body.action === 'list') {
      const config = await getConfig();
      if (!config.adminIds.includes(effectiveUserId)) {
        throw new EndpointError('Admin only', { code: 'FORBIDDEN' });
      }
      return { items: await listAllFeedback() };
    }
    const rawKind = body.kind;
    const feedbackKind: FeedbackKind =
      rawKind === undefined || rawKind === null || rawKind === '' ? 'feedback' : (rawKind as FeedbackKind);
    if (!FEEDBACK_KINDS.includes(feedbackKind)) {
      throw new EndpointError('Invalid kind', { code: 'BAD_REQUEST' });
    }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      throw new EndpointError('Invalid text', { code: 'BAD_REQUEST' });
    }
    const createdFeedback = await createFeedback(
      effectiveUserId,
      feedbackKind,
      body.text,
      typeof body.context === 'string' ? body.context : null,
    );
    return { item: createdFeedback };
  }

  if (cleanPath === '/api/settings' || cleanPath === '/api/user/settings') {
    if (method === 'GET') {
      const user = await getUser(effectiveUserId);
      return {
        name: user?.name,
        language: user?.language ?? 'ru',
        base_currency: user?.baseCurrency ?? 'EUR',
        timezone: user?.timezone ?? 'UTC',
        summary_time: user?.summaryTime ?? '07:00',
        low_stimulation_mode: user?.lowStimulationMode ?? false,
        role: 'admin',
        onboarded: true,
        has_byok_key: Boolean(user?.byok?.ciphertext),
        model_provider: user?.modelProvider ?? 'gemini',
      };
    }
    if (method === 'PATCH' || method === 'PUT') {
      const updated = await updateUser(effectiveUserId, {
        name: body.name,
        language: body.language !== undefined ? normalizeLocale(body.language) : undefined,
        baseCurrency: body.base_currency,
        timezone: body.timezone,
        summaryTime: body.summary_time,
        lowStimulationMode: body.low_stimulation_mode,
      });
      return {
        name: updated?.name,
        language: updated?.language ?? 'ru',
        base_currency: updated?.baseCurrency,
        timezone: updated?.timezone,
        summary_time: updated?.summaryTime,
        low_stimulation_mode: updated?.lowStimulationMode,
        role: 'admin',
        onboarded: true,
        has_byok_key: Boolean(updated?.byok?.ciphertext),
        model_provider: updated?.modelProvider ?? 'gemini',
      };
    }
  }

  // -------------------------------------------------------------------------
  // 8. Trash (/api/trash/*)
  // -------------------------------------------------------------------------
  if (cleanPath === '/api/trash/restore' && method === 'POST') {
    const success = await restoreTrashItem(
      effectiveUserId,
      body.item_type === 'note' ? 'note' : 'task',
      Number(body.item_id),
    );
    return { status: 'ok', success };
  }

  if (cleanPath === '/api/trash/empty' && method === 'POST') {
    const purgeRes = await emptyTrash(effectiveUserId);
    return {
      status: 'ok',
      tasks_purged: purgeRes.tasksPurged,
      notes_purged: purgeRes.notesPurged,
    };
  }

  const trashItemMatch = cleanPath.match(/^\/(?:api\/)?trash\/([a-zA-Z0-9_-]+)\/(\d+)$/);
  if (trashItemMatch && method === 'DELETE') {
    const itemType = trashItemMatch[1] as TrashItemType;
    const itemId = Number(trashItemMatch[2]);
    await purgeTrashItem(effectiveUserId, itemType, itemId);
    return { status: 'deleted', item_type: itemType, item_id: String(itemId) };
  }

  if (cleanPath === '/api/trash') {
    if (method === 'GET') {
      const trash = await listTrash(effectiveUserId);
      return {
        tasks: trash.tasks.map((t) => ({
          id: String(t.id),
          title: t.title,
          notes: t.notes,
          status: t.status,
          category_id: t.categoryId ? String(t.categoryId) : null,
          category_name: t.categoryName,
          steps_count: t.stepsCount,
          created_at: t.createdAt,
          deleted_at: t.deletedAt,
          days_remaining: t.daysRemaining,
        })),
        notes: trash.notes.map((n) => ({
          id: String(n.id),
          raw_text: n.rawText,
          clean_text: n.cleanText,
          column: n.column,
          created_at: n.createdAt,
          deleted_at: n.deletedAt,
          days_remaining: n.daysRemaining,
        })),
        total_count: trash.totalCount,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 9. Docs Chapters (/api/docs/chapters/*)
  // -------------------------------------------------------------------------
  const chapterDetailMatch = cleanPath.match(/^\/(?:api\/)?docs\/chapters\/([^/]+)$/);
  if (chapterDetailMatch && method === 'GET') {
    const slug = decodeURIComponent(chapterDetailMatch[1]);
    let chapter = await getChapter(effectiveUserId, slug);
    if (!chapter) {
      await seedDocs(effectiveUserId);
      chapter = await getChapter(effectiveUserId, slug);
    }
    if (!chapter) {
      throw new EndpointError('Chapter not found', { code: 'NOT_FOUND' });
    }
    const view = toChapterView(chapter);
    return {
      slug: view.slug,
      filename: view.filename ?? '',
      title: view.title,
      summary: view.summary,
      content: view.content,
      sections: view.sections.map((s) => ({
        chapter_slug: s.chapterSlug,
        chapter_title: s.chapterTitle,
        section_title: s.sectionTitle,
        level: s.level,
        content: s.content,
      })),
    };
  }

  if (cleanPath === '/api/docs/chapters' || cleanPath === '/api/docs') {
    let chapters = await listChapters(effectiveUserId);
    if (chapters.length === 0) {
      await seedDocs(effectiveUserId);
      chapters = await listChapters(effectiveUserId);
    }
    return chapters.map((c) => {
      const view = toChapterView(c);
      return {
        slug: c.slug,
        filename: c.filename ?? '',
        title: c.title,
        summary: view.summary,
        sections_count: view.sections.length,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 10. System, BYOK & Backup (/api/system/*)
  // -------------------------------------------------------------------------
  const accessDeleteMatch = cleanPath.match(/^\/(?:api\/)?system\/access\/([^/]+)$/);
  if (accessDeleteMatch && method === 'DELETE') {
    const accessId = decodeURIComponent(accessDeleteMatch[1]);
    await kvDelete(`access:${accessId}`);
    return { status: 'deleted', id: accessId };
  }

  if (cleanPath === '/api/system/access') {
    if (method === 'GET') {
      const user = await getUser(effectiveUserId);
      return {
        role: 'admin',
        is_approved: true,
        onboarded: true,
        daily_msg_limit: 100,
        daily_msg_used: 0,
        has_byok_key: Boolean(user?.byok?.ciphertext),
        model_provider: user?.modelProvider ?? 'gemini',
      };
    }
    if (method === 'POST') {
      const id = body.code || String(Date.now());
      await kvSetJson(`access:${id}`, body);
      return { status: 'ok', id };
    }
  }

  if (cleanPath === '/api/system/byok') {
    if (method === 'GET') {
      const user = await getUser(effectiveUserId);
      return {
        has_key: Boolean(user?.byok?.ciphertext),
        status: user?.byok?.ciphertext ? 'configured' : 'not_configured',
        provider: user?.modelProvider ?? 'gemini',
        csprng_available: hasSecureRandom(),
      };
    }
    if (method === 'POST') {
      const apiKey = String(body.api_key ?? body.apiKey ?? body.key ?? '').trim();
      if (!apiKey) {
        throw new EndpointError('API key is required', { code: 'BAD_REQUEST' });
      }
      const rawProvider = body.provider ?? body.model_provider;
      const provider = parseProviderId(rawProvider);
      if (rawProvider !== undefined && rawProvider !== null && String(rawProvider).trim() !== '' && provider === null) {
        throw new EndpointError(
          `Unknown model provider. Supported: ${PROVIDER_IDS.join(', ')}`,
          { code: 'BAD_REQUEST' },
        );
      }
      if (!hasSecureRandom()) {
        throw new EndpointError(
          'Не удалось безопасно сохранить API-ключ: платформа не предоставляет криптографический генератор случайных чисел. Текущий ключ не изменён.',
          { status: 503, code: 'CSPRNG_UNAVAILABLE' },
        );
      }
      const sealed = await sealByok(effectiveUserId, apiKey);
      await updateUser(effectiveUserId, { byok: sealed, modelProvider: provider ?? 'gemini' });
      return { status: 'ok', message: 'BYOK key saved successfully' };
    }
    if (method === 'DELETE') {
      await updateUser(effectiveUserId, { byok: null, modelProvider: null });
      return { status: 'ok', message: 'BYOK key cleared' };
    }
  }

  if (cleanPath === '/api/system/backup/json' || cleanPath === '/api/system/backup/export') {
    const data = await exportUserData(effectiveUserId);
    return data;
  }

  if (cleanPath === '/api/system/backup/restore' && method === 'POST') {
    const payload = (body && typeof (body as any).tables === 'object') ? body : ((body as any).data ?? body);
    const mode = ((body as any).mode === 'replace' || (payload && (payload as any).mode === 'replace') ? 'replace' : 'merge') as BackupMode;
    const result = await importBackup(effectiveUserId, payload, { mode });
    return {
      status: 'ok',
      restored: Object.fromEntries(Object.entries(result.tables).map(([k, v]) => [k, v.inserted])),
      skipped: result.skipped,
      warnings: result.warnings,
      message: `Restored ${Object.values(result.tables).reduce((sum, v) => sum + v.inserted, 0)} items`,
    };
  }

  // Хвост роутера. Раньше здесь стоял `return { ok: true, path: cleanPath }`:
  // любая опечатка в Mini App выглядела успешным запросом, а для GET ещё и
  // кэшировалась как «данные». Теперь, как в REST: неизвестный путь — 404,
  // известный путь с неподдерживаемым методом — 405.
  const matchedPattern = [
    taskMatch,
    stepMatch,
    adminUserMatch,
    inviteMatch,
    accountMatch,
    transactionMatch,
    liabilityPayMatch,
    liabilityMatch,
    noteMatch,
    medTakeMatch,
    medSkipMatch,
    medMatch,
    trashItemMatch,
    chapterDetailMatch,
    accessDeleteMatch,
  ].some((match) => match !== null);

  if (matchedPattern || cleanPath.includes('/fast-state') || KNOWN_CONSTANT_PATHS.has(cleanPath)) {
    throw new EndpointError(`Метод ${method} не поддерживается для маршрута ${cleanPath}`, {
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
    });
  }

  throw new EndpointError(`Маршрут не найден: ${method} ${cleanPath}`, {
    status: 404,
    code: 'NOT_FOUND',
  });
}
