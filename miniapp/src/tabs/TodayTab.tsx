import React, { useState, useMemo } from 'react';
import {
  Sun,
  CheckCircle2,
  Compass,
  ArrowRight,
  Plus,
  Clock,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { Task, RunwayInfo, Liability } from '../types';
import { getTaskTimeDisplay, getCurrencySymbol } from '../utils';
import { useI18n } from '../i18n/index';

export interface TodayTabProps {
  tasks: Task[];
  runway: RunwayInfo | null;
  liabilities: Liability[];
  handleToggleTask: (task: Task) => void;
  handleToggleStep: (task: Task, stepIdx: number) => void;
  onQuickCapture: (text: string, mode: 'task' | 'note') => Promise<void>;
  onNavigateTab: (tab: 'tasks' | 'finances' | 'notes') => void;
  triggerHaptic: (type?: 'light' | 'medium' | 'success') => void;
  baseCurrency?: string;
  reserveAmount?: number;
}

export const TodayTab: React.FC<TodayTabProps> = ({
  tasks,
  runway,
  liabilities,
  handleToggleTask,
  handleToggleStep,
  onQuickCapture,
  onNavigateTab,
  triggerHaptic,
  baseCurrency,
  reserveAmount = 0,
}) => {
  const { locale, t, formatNumber } = useI18n();
  const [captureMode, setCaptureMode] = useState<'task' | 'note'>('task');
  const [captureText, setCaptureText] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [currentDate] = useState(() => new Date());

  // Sunday Recovery Rule: day 0 is Sunday
  const isSunday = currentDate.getDay() === 0;

  // Strictly filter only tasks scheduled for Today (or overdue from earlier), never future days or undated backlog
  const todayTasks = useMemo(() => {
    const active = tasks.filter((t) => t.status === 'todo');
    const startOfToday = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()).getTime();
    const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;

    const dueTodayOrOverdue = active.filter((t) => {
      const d = t.due_at || t.remind_at;
      if (!d) return false;
      const tMs = new Date(d).getTime();
      // Events appear strictly on the day of the event, never as overdue guilt debt
      if (t.item_type === 'event') {
        return tMs >= startOfToday && tMs < startOfTomorrow;
      }
      return tMs < startOfTomorrow;
    });

    return [...dueTodayOrOverdue].sort((a, b) => {
      if (isSunday) {
        const aIsRecovery = Boolean(
          a.category_name && (/быт/i.test(a.category_name) || /хобби/i.test(a.category_name))
        );
        const bIsRecovery = Boolean(
          b.category_name && (/быт/i.test(b.category_name) || /хобби/i.test(b.category_name))
        );
        if (aIsRecovery !== bIsRecovery) {
          return aIsRecovery ? -1 : 1;
        }
      }

      const getTime = (t: Task) => {
        const d = t.due_at || t.remind_at;
        return d ? new Date(d).getTime() : 0;
      };

      const aTime = getTime(a);
      const bTime = getTime(b);

      // Prefer tasks scheduled specifically for today over older overdue tasks
      const aIsToday = aTime >= startOfToday;
      const bIsToday = bTime >= startOfToday;
      if (aIsToday !== bIsToday) {
        return aIsToday ? -1 : 1;
      }

      return aTime - bTime;
    });
  }, [tasks, isSunday, currentDate]);

  // Top focus task & uncompleted step
  const focusTask = todayTasks[0] || null;
  const uncompletedStepIdx = focusTask?.steps
    ? focusTask.steps.findIndex((s) => s.status === 'todo')
    : -1;
  const hasStep = uncompletedStepIdx !== -1 && focusTask?.steps;
  const heroStepTitle = hasStep && focusTask?.steps
    ? focusTask.steps[uncompletedStepIdx].title
    : focusTask?.title || '';
  const focusTaskTime = focusTask ? getTaskTimeDisplay(focusTask, currentDate.getTime(), locale) : null;

  // Remaining today tasks (excluding focusTask so it is never duplicated below)
  const remainingTodayTasks = useMemo(() => todayTasks.slice(1, 4), [todayTasks]);

  // Next upcoming scheduled unpaid liability
  const nextLiability = useMemo(() => {
    const todayDay = currentDate.getDate();
    const unpaid = liabilities.filter(
      (l) => l.is_active && typeof l.payment_day === 'number' && !l.is_paid_this_month &&
      !(l.notes?.toLowerCase().includes('заморож') || l.notes?.toLowerCase().includes('пауз') || l.notes?.toLowerCase().includes('frozen') || (l as Liability & { is_frozen?: boolean }).is_frozen)
    );
    if (unpaid.length === 0) return null;

    return [...unpaid].sort((a, b) => {
      const aDay = a.payment_day!;
      const bDay = b.payment_day!;
      const aDiff = aDay >= todayDay ? aDay - todayDay : aDay - todayDay + 31;
      const bDiff = bDay >= todayDay ? bDay - todayDay : bDay - todayDay + 31;
      return aDiff - bDiff;
    })[0];
  }, [liabilities, currentDate]);

  // Fast capture handler
  const handleCaptureSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = captureText.trim();
    if (!trimmed || isCapturing) return;

    try {
      setIsCapturing(true);
      triggerHaptic('medium');
      await onQuickCapture(trimmed, captureMode);
      setCaptureText('');
    } finally {
      setIsCapturing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Sunday Recovery Banner */}
      {isSunday && (
        <div className="sunday-recovery-banner">
          <Sun size={20} strokeWidth={1.75} color="var(--accent-emerald)" style={{ flexShrink: 0 }} />
          <span>{t('today.sundayBanner')}</span>
        </div>
      )}

      {/* 1. Primary Hero Card */}
      {focusTask ? (
        <div className="micro-step-hero">
          <div className="micro-step-eyebrow">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Zap size={14} strokeWidth={1.75} />
              <span>{t('today.nextStep')}</span>
            </div>
            <button
              type="button"
              className="btn-link"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12.5,
                color: 'var(--accent-color)',
                fontWeight: 500,
                padding: 0,
              }}
              onClick={() => {
                triggerHaptic('light');
                onNavigateTab('tasks');
              }}
            >
              <span>{t('today.allTasks')}</span>
              <ArrowRight size={13} strokeWidth={1.75} />
            </button>
          </div>

          <div className="micro-step-body">
            <button
              type="button"
              className="checkbox-btn"
              aria-label={
                hasStep
                  ? t('today.markStepDone', { title: heroStepTitle })
                  : t('today.markTaskDone', { title: focusTask.title })
              }
              onClick={() => {
                triggerHaptic('success');
                if (hasStep) {
                  handleToggleStep(focusTask, uncompletedStepIdx);
                } else {
                  handleToggleTask(focusTask);
                }
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="micro-step-title">{heroStepTitle}</div>
              <div className="micro-step-parent" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {hasStep && <span>{t('today.inTask', { title: focusTask.title })}</span>}
                {focusTask.item_type === 'event' && (
                  <span className="task-cat-badge" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', borderColor: 'rgba(99, 102, 241, 0.3)' }}>
                    {t('today.eventBadge')}
                  </span>
                )}
                {focusTask.category_name && (
                  <span className="task-cat-badge">
                    {focusTask.category_name}
                    {focusTask.subcategory_name ? ` · ${focusTask.subcategory_name}` : ''}
                  </span>
                )}
                {focusTaskTime && (
                  <span className={`task-time-text ${focusTaskTime.isPast ? 'is-past' : 'is-upcoming'} tabular-nums`}>
                    <Clock size={11} strokeWidth={1.75} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 2 }} />
                    {focusTaskTime.timeStr}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="micro-step-hero" style={{ padding: '18px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <CheckCircle2 size={24} strokeWidth={1.75} color="var(--accent-emerald)" style={{ flexShrink: 0 }} />
              <div className="micro-step-title" style={{ fontSize: 14, fontWeight: 500 }}>
                {t('today.noTasksToday')}
              </div>
            </div>
            <button
              type="button"
              className="btn-link"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12.5,
                color: 'var(--accent-color)',
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
              onClick={() => {
                triggerHaptic('light');
                onNavigateTab('tasks');
              }}
            >
              <span>{t('today.byDays')}</span>
              <ArrowRight size={13} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}

      {/* 2. Support Block 1 */}
      {remainingTodayTasks.length > 0 && (
        <div className="today-section-card">
          <div className="today-section-header">
            <div className="today-section-title">
              <Compass size={16} strokeWidth={1.75} color="var(--accent-color)" />
              <span className="tabular-nums">{t('today.moreToday', { count: remainingTodayTasks.length })}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {remainingTodayTasks.map((task) => {
              const timeDisplay = getTaskTimeDisplay(task, currentDate.getTime(), locale);
              return (
                <div
                  key={task.id}
                  className="task-card"
                  style={{
                    margin: 0,
                    padding: '9px 12px',
                    background: 'var(--bg-surface)',
                  }}
                >
                  <div className="task-main" style={{ gap: 10 }}>
                    <button
                      type="button"
                      className="checkbox-btn"
                      aria-label={t('today.markTaskDone', { title: task.title })}
                      onClick={() => {
                        triggerHaptic('success');
                        handleToggleTask(task);
                      }}
                    />
                    <div className="task-info" style={{ flex: 1, minWidth: 0 }}>
                      <span className="task-title" style={{ fontSize: 14 }}>
                        {task.title}
                      </span>
                      <div className="task-meta" style={{ marginTop: 2 }}>
                        {task.item_type === 'event' && (
                          <span className="task-cat-badge" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', borderColor: 'rgba(99, 102, 241, 0.3)' }}>
                            {t('today.eventBadge')}
                          </span>
                        )}
                        {task.category_name && (
                          <span className="task-cat-badge">
                            {task.category_name}
                            {task.subcategory_name ? ` · ${task.subcategory_name}` : ''}
                          </span>
                        )}
                        {timeDisplay && (
                          <span className={`task-time-text ${timeDisplay.isPast ? 'is-past' : 'is-upcoming'} tabular-nums`}>
                            <Clock size={11} strokeWidth={1.75} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 2 }} />
                            {timeDisplay.timeStr}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Support Block 2 */}
      {(() => {
        const currSym = getCurrencySymbol(baseCurrency);
        return (
          <div
            className="today-finance-strip"
            onClick={() => {
              triggerHaptic('light');
              onNavigateTab('finances');
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {reserveAmount > 0
                  ? t('today.freeTodayReserve', { reserve: formatNumber(reserveAmount, { maximumFractionDigits: 0 }), currency: currSym })
                  : t('today.freeToday')}
              </span>
              <span className="today-spendable-amount tabular-nums">
                {runway
                  ? t('today.perDay', { amount: formatNumber(Math.round(runway.safe_daily_spend_eur), { maximumFractionDigits: 0 }), currency: currSym })
                  : t('today.openSummary')}
              </span>
            </div>
            <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('today.nearestPayment')}</span>
              <span
                className="tabular-nums"
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: nextLiability ? 'var(--text-primary)' : 'var(--accent-emerald)',
                }}
              >
                {nextLiability
                  ? t('today.dayOfMonth', { day: nextLiability.payment_day ?? '', name: nextLiability.name })
                  : t('today.monthPaymentsClosed')}
              </span>
            </div>
          </div>
        );
      })()}

      {/* 4. Support Block 3 */}
      <div className="today-section-card">
        <div className="today-section-header">
          <div className="today-section-title">
            <Sparkles size={16} strokeWidth={1.75} color="var(--accent-color)" />
            <span>{t('today.quickCapture')}</span>
          </div>
          <div
            style={{
              display: 'inline-flex',
              gap: 3,
              background: 'rgba(255, 255, 255, 0.05)',
              padding: 2,
              borderRadius: 14,
            }}
          >
            <button
              type="button"
              style={{
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 12,
                border: 'none',
                cursor: 'pointer',
                background: captureMode === 'task' ? 'var(--accent-color)' : 'transparent',
                color: captureMode === 'task' ? 'var(--accent-text)' : 'var(--text-secondary)',
                fontWeight: captureMode === 'task' ? 600 : 400,
                transition: 'all var(--transition-speed)',
              }}
              onClick={() => {
                triggerHaptic('light');
                setCaptureMode('task');
              }}
            >
              {t('today.toTask')}
            </button>
            <button
              type="button"
              style={{
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 12,
                border: 'none',
                cursor: 'pointer',
                background: captureMode === 'note' ? 'var(--accent-color)' : 'transparent',
                color: captureMode === 'note' ? 'var(--accent-text)' : 'var(--text-secondary)',
                fontWeight: captureMode === 'note' ? 600 : 400,
                transition: 'all var(--transition-speed)',
              }}
              onClick={() => {
                triggerHaptic('light');
                setCaptureMode('note');
              }}
            >
              {t('today.toInbox')}
            </button>
          </div>
        </div>

        <form onSubmit={handleCaptureSubmit} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            className="input-field"
            placeholder={captureMode === 'task' ? t('today.taskPlaceholder') : t('today.notePlaceholder')}
            value={captureText}
            onChange={(e) => setCaptureText(e.target.value)}
            disabled={isCapturing}
            style={{ flex: 1 }}
          />
          <button
            type="submit"
            className="btn-primary"
            disabled={isCapturing || !captureText.trim()}
            style={{
              minWidth: 40,
              height: 40,
              padding: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            title={captureMode === 'task' ? t('today.createTask') : t('today.saveNote')}
            aria-label={captureMode === 'task' ? t('today.createTask') : t('today.saveNote')}
          >
            <Plus size={16} strokeWidth={1.75} />
          </button>
        </form>
      </div>
    </div>
  );
};
