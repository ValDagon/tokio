// Листовой модуль без зависимостей от движка и тулз: на него ссылаются
// `prompts.ts`, `engine.ts` и `tools/*`. Вынесено сюда, чтобы `tools/*` не
// тянули `prompts.ts`/`engine.ts` — обратная дуга через `tools/index.ts`
// ломала регистрацию реестра при прямом импорте `tools/reasoning.ts`.

import { dateKey, fromIso, parseTimeOfDay, zonedParts } from '../utils.js';

export const CUSTOM_INSTRUCTIONS_SLUG = '07_custom_instructions';

/** Предел длины цитаты/исходного сообщения при ответе (reply) в Telegram. */
export const MAX_REPLY_CONTEXT_CHARS = 800;

/**
 * Оборачивает запрос пользователя контекстом сообщения, на которое он отвечает.
 * Хелпер в листовом модуле, чтобы `router` и `ingest` не создавали циклических импортов.
 */
export function formatAgentQueryWithReply(userText: string, replyContext?: string): string {
  const trimmed = typeof replyContext === 'string' ? replyContext.trim() : '';
  if (!trimmed) return userText;
  return `[Контекст сообщения, на которое отвечает пользователь:\n«${trimmed}»]\n\n${userText}`;
}

const FALLBACK_TIMEZONE = 'UTC';
const pad2 = (value: number): string => String(value).padStart(2, '0');

export interface ExecutiveOverloadThresholds {
  enabled?: boolean;
  overdueTaskCount?: number;
  activeTodoCount?: number;
  nightStartHour?: number;
  nightEndHour?: number;
}

export interface ExecutiveOverloadInput {
  lowStimulationMode?: boolean;
  timezone?: string;
  now?: Date;
  overdueTaskCount?: number;
  activeTodoCount?: number;
  missedMedsCount?: number;
  userText?: string;
  thresholds?: ExecutiveOverloadThresholds;
}

export interface ExecutiveOverloadFactors {
  wipOverload: boolean;
  circadianOrTherapyLoad: boolean;
  emotionalDistressMarker: boolean;
}

export interface ExecutiveOverloadState {
  isOverloaded: boolean;
  shieldEnabled: boolean;
  lowStimulationMode: boolean;
  isNightWindow: boolean;
  activeFactorCount: number;
  factors: ExecutiveOverloadFactors;
  matchedMarkers: string[];
  localHour: number;
  overdueTaskCount: number;
  activeTodoCount: number;
  missedMedsCount: number;
}

export interface WorkloadMetrics {
  activeTodoCount: number;
  overdueTaskCount: number;
  missedMedsCount: number;
}

const OVERLOAD_MARKERS: readonly string[] = [
  'не могу начать',
  'перегруз',
  'все навалилось',
  'ступор',
  'сил нет',
  'голова кругом',
  'не знаю за что хвататься',
  'прокрастин',
  'выгорел',
  'выгорание',
  'абулия',
  'паралич',
  'тяжело начать',
  'опускаются руки',
  'overwhelmed',
  'paralyzed',
  'burnout',
  "can't start",
];

/** Находит явные маркеры перегруза/ступора в запросе пользователя (RU/EN). */
export function detectOverloadMarkers(text?: string): string[] {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’`']/g, "'")
    .trim();
  if (!normalized) return [];
  return OVERLOAD_MARKERS.filter((marker) => normalized.includes(marker));
}

function nonNegativeInt(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** Проверяет, просрочена ли задача относительно локальной даты `YYYY-MM-DD`. */
export function isTaskOverdue(
  dueAt: string | null | undefined,
  localDateStr: string,
  timezone: string = FALLBACK_TIMEZONE,
): boolean {
  if (!dueAt) return false;
  const raw = dueAt.trim();
  if (!raw) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw < localDateStr;
  const parsed = fromIso(raw);
  if (!parsed) return false;
  return dateKey(parsed, timezone) < localDateStr;
}

/** Считает активные задачи, просрочку и пропущенные приёмы лекарств (>30 мин от слота). */
export function computeWorkloadMetrics(
  tasks: readonly { dueAt?: string | null }[],
  doses: readonly { status: string; scheduledTime: string }[],
  timezone: string = FALLBACK_TIMEZONE,
  now: Date = new Date(),
): WorkloadMetrics {
  const safeTimezone = timezone.trim() || FALLBACK_TIMEZONE;
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const localParts = zonedParts(safeNow, safeTimezone);
  const localDateStr = dateKey(safeNow, safeTimezone);
  const currentLocalMinutes = localParts.hour * 60 + localParts.minute;

  const activeTodoCount = tasks.length;
  const overdueTaskCount = tasks.reduce(
    (count, task) => (isTaskOverdue(task.dueAt, localDateStr, safeTimezone) ? count + 1 : count),
    0,
  );
  const missedMedsCount = doses.reduce((count, dose) => {
    if (dose.status !== 'pending') return count;
    const scheduledMinutes = parseTimeOfDay(dose.scheduledTime);
    if (scheduledMinutes === null) return count;
    return scheduledMinutes + 30 <= currentLocalMinutes ? count + 1 : count;
  }, 0);

  return { activeTodoCount, overdueTaskCount, missedMedsCount };
}

/** Проверяет, попадает ли локальный час в ночное окно `[startHour, endHour)`. */
export function isLocalHourInWindow(hour: number, startHour: number, endHour: number): boolean {
  const h = Math.trunc(hour);
  const start = Math.min(23, Math.max(0, Math.trunc(startHour)));
  const end = Math.min(23, Math.max(0, Math.trunc(endHour)));
  if (start === end) return false;
  if (start > end) return h >= start || h < end;
  return h >= start && h < end;
}

/**
 * Детерминированно оценивает когнитивный перегруз по трём независимым факторам
 * (WIP, циркадная/терапевтическая нагрузка, речь) и ручному режиму low-stimulation.
 */
export function evaluateExecutiveOverload(
  input: ExecutiveOverloadInput,
): ExecutiveOverloadState {
  const shieldEnabled = input.thresholds?.enabled !== false;
  const lowStimulationMode = Boolean(input.lowStimulationMode);
  const timezone = (input.timezone ?? '').trim() || FALLBACK_TIMEZONE;
  const now =
    input.now instanceof Date && !Number.isNaN(input.now.getTime())
      ? input.now
      : new Date();
  const localHour = zonedParts(now, timezone).hour;

  const overdueTaskCount = nonNegativeInt(input.overdueTaskCount);
  const activeTodoCount = nonNegativeInt(input.activeTodoCount);
  const missedMedsCount = nonNegativeInt(input.missedMedsCount);

  const overdueThreshold = Math.max(1, Math.trunc(input.thresholds?.overdueTaskCount ?? 3));
  const activeTodoThreshold = Math.max(1, Math.trunc(input.thresholds?.activeTodoCount ?? 12));
  const nightStartHour = Math.min(23, Math.max(0, Math.trunc(input.thresholds?.nightStartHour ?? 21)));
  const nightEndHour = Math.min(23, Math.max(0, Math.trunc(input.thresholds?.nightEndHour ?? 6)));

  const wipOverload =
    overdueTaskCount >= overdueThreshold || activeTodoCount >= activeTodoThreshold;
  const isNightWindow = isLocalHourInWindow(localHour, nightStartHour, nightEndHour);
  const circadianOrTherapyLoad = isNightWindow || missedMedsCount >= 1;
  const matchedMarkers = detectOverloadMarkers(input.userText);
  const emotionalDistressMarker = matchedMarkers.length > 0;

  const activeFactorCount = [
    wipOverload,
    circadianOrTherapyLoad,
    emotionalDistressMarker,
  ].filter(Boolean).length;

  const isOverloaded =
    shieldEnabled &&
    (lowStimulationMode ||
      activeFactorCount >= 2 ||
      (emotionalDistressMarker &&
        (overdueTaskCount > 0 || activeTodoCount > 0 || missedMedsCount > 0)));

  return {
    isOverloaded,
    shieldEnabled,
    lowStimulationMode,
    isNightWindow,
    activeFactorCount,
    factors: {
      wipOverload,
      circadianOrTherapyLoad,
      emotionalDistressMarker,
    },
    matchedMarkers,
    localHour,
    overdueTaskCount,
    activeTodoCount,
    missedMedsCount,
  };
}

/** Человекочитаемый список активных факторов перегрузки для промпта и досье. */
export function formatOverloadReasons(
  state: ExecutiveOverloadState | undefined,
  manualCalm: boolean = Boolean(state?.lowStimulationMode),
): string[] {
  const reasons: string[] = [];
  if (manualCalm) reasons.push('ручной спокойный режим (low-stimulation)');
  if (state?.factors.wipOverload) {
    reasons.push(
      `высокий объём дел (активных: ${state.activeTodoCount}, просроченных: ${state.overdueTaskCount})`,
    );
  }
  if (state?.factors.circadianOrTherapyLoad) {
    const parts: string[] = [];
    const nightActive = state.isNightWindow ?? (state.localHour >= 21 || state.localHour < 6);
    if (nightActive) {
      parts.push(`позднее/ночное время (${pad2(state.localHour)}:00)`);
    }
    if (state.missedMedsCount >= 1) {
      parts.push(`неотмеченные приёмы лекарств (${state.missedMedsCount})`);
    }
    reasons.push(parts.join(', ') || 'циркадная или терапевтическая нагрузка');
  }
  if (state?.factors.emotionalDistressMarker) {
    const markers = state.matchedMarkers.length > 0 ? `: ${state.matchedMarkers.join(', ')}` : '';
    reasons.push(`маркеры перегрузки/ступора в запросе${markers}`);
  }
  return reasons;
}
