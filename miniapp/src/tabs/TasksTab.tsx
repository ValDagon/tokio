import React, { useState } from 'react';
import {
  Plus,
  X,
  Calendar,
  CalendarCheck,
  Repeat,
  ArrowUpDown,
  Sparkles,
  Check,
  Clock,
  FileText,
  ChevronDown,
  ChevronRight,
  Trash2,
  SlidersHorizontal,
  Pencil,
} from 'lucide-react';
import type { Task, Category } from '../types';
import {
  formatTaskDate,
  getOverdueBadgeText,
  formatRecurrence,
  formatTaskCreatedDate,
  type TaskDayGroup,
} from '../utils';
import { useI18n } from '../i18n/index';

export type TaskSortOption = 'smart' | 'due_date' | 'created_desc' | 'created_asc' | 'alpha';
export type TaskFilterOption = 'all' | 'overdue' | 'dated' | 'recurring';

export interface TasksTabProps {
  tasks: Task[];
  categories: Category[];
  selectedCategory: string | null;
  setSelectedCategory: (cat: string | null) => void;
  selectedSubcategory: string | null;
  setSelectedSubcategory: (subcat: string | null) => void;
  setNewTaskCat: (cat: string) => void;
  setNewTaskSubcat: (subcat: string) => void;
  isAddingCat: boolean;
  setIsAddingCat: (val: boolean) => void;
  newCatName: string;
  setNewCatName: (val: string) => void;
  handleAddCategory: (e: React.FormEvent) => void;
  handleCreateTask: (e?: React.FormEvent) => void;
  isTaskFormExpanded: boolean;
  setIsTaskFormExpanded: (val: boolean) => void;
  newTaskTitle: string;
  setNewTaskTitle: (val: string) => void;
  isSubmittingTask: boolean;
  newTaskCat: string;
  newTaskSubcat: string;
  showSteps: boolean;
  setShowSteps: (val: boolean) => void;
  steps: string[];
  setSteps: (steps: string[]) => void;
  totalOverdueCount: number;
  taskFilter: TaskFilterOption;
  setTaskFilter: (filter: TaskFilterOption) => void;
  taskSort: TaskSortOption;
  setTaskSort: (sort: TaskSortOption) => void;
  processedTasks: Task[];
  taskDayGroups: TaskDayGroup[];
  expandedTasks: Set<string>;
  toggleTaskExpanded: (taskId: string) => void;
  handleToggleTask: (task: Task) => void;
  handleDeleteTask: (taskId: string) => void;
  handleToggleStep: (task: Task, stepIdx: number) => void;
  activeInlineDay: string | null;
  setActiveInlineDay: (dayId: string | null) => void;
  inlineTaskText: string;
  setInlineTaskText: (text: string) => void;
  isSubmittingInline: boolean;
  handleCreateInlineTask: (group: TaskDayGroup) => void;
  completedTasks: Task[];
  showCompleted: boolean;
  setShowCompleted: (val: boolean) => void;
  triggerHaptic: (type?: 'light' | 'medium' | 'success') => void;
  handleRescheduleTaskToday?: (task: Task) => void;
  activeEvents?: Task[];
  newTaskItemType?: 'task' | 'event';
  setNewTaskItemType?: (type: 'task' | 'event') => void;
  handleToggleItemType?: (task: Task) => void;
  onUpdateTask?: (
    taskId: string,
    updates: {
      title?: string;
      notes?: string;
      category_id?: string;
      due_at?: string | null;
      item_type?: 'task' | 'event';
    }
  ) => Promise<void>;
}

export const TasksTab: React.FC<TasksTabProps> = ({
  tasks,
  categories,
  selectedCategory,
  setSelectedCategory,
  selectedSubcategory,
  setSelectedSubcategory,
  setNewTaskCat,
  setNewTaskSubcat,
  isAddingCat,
  setIsAddingCat,
  newCatName,
  setNewCatName,
  handleAddCategory,
  handleCreateTask,
  isTaskFormExpanded,
  setIsTaskFormExpanded,
  newTaskTitle,
  setNewTaskTitle,
  isSubmittingTask,
  newTaskCat,
  newTaskSubcat,
  showSteps,
  setShowSteps,
  steps,
  setSteps,
  totalOverdueCount,
  taskFilter,
  setTaskFilter,
  taskSort,
  setTaskSort,
  processedTasks,
  taskDayGroups,
  expandedTasks,
  toggleTaskExpanded,
  handleToggleTask,
  handleDeleteTask,
  handleToggleStep,
  activeInlineDay,
  setActiveInlineDay,
  inlineTaskText,
  setInlineTaskText,
  isSubmittingInline,
  handleCreateInlineTask,
  completedTasks,
  showCompleted,
  setShowCompleted,
  triggerHaptic,
  handleRescheduleTaskToday,
  activeEvents,
  newTaskItemType,
  setNewTaskItemType,
  handleToggleItemType,
  onUpdateTask,
}) => {
  const { locale, t } = useI18n();
  const [showFilterPopover, setShowFilterPopover] = useState(false);
  const [isOverdueExpanded, setIsOverdueExpanded] = useState(false);
  const [isDistantExpanded, setIsDistantExpanded] = useState(false);
  const [referenceNow] = useState(() => Date.now());
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editItemType, setEditItemType] = useState<'task' | 'event'>('task');
  const [isSavingTaskEdit, setIsSavingTaskEdit] = useState(false);

  const openEditTaskModal = (task: Task) => {
    triggerHaptic('light');
    setEditingTask(task);
    setEditTitle(task.title);
    setEditNotes(task.notes || '');
    setEditCategoryId(task.category_id || '');
    setEditDueDate(task.due_at ? task.due_at.slice(0, 10) : '');
    setEditItemType(task.item_type === 'event' ? 'event' : 'task');
  };

  const handleSaveTaskEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask || !onUpdateTask) return;
    const cleanTitle = editTitle.trim();
    if (!cleanTitle || isSavingTaskEdit) return;
    try {
      setIsSavingTaskEdit(true);
      triggerHaptic('medium');
      await onUpdateTask(editingTask.id, {
        title: cleanTitle,
        notes: editNotes.trim() || undefined,
        category_id: editCategoryId || undefined,
        due_at: editDueDate.trim() ? `${editDueDate.trim()}T12:00:00.000Z` : null,
        item_type: editItemType,
      });
      triggerHaptic('success');
      setEditingTask(null);
    } finally {
      setIsSavingTaskEdit(false);
    }
  };

  // Separate overdue and distant groups from regular groups
  const overdueGroup = taskDayGroups.find((g) => g.id === 'overdue');
  const regularGroups = taskDayGroups.filter((g) => g.id !== 'overdue' && !g.isDistant);
  const distantGroups = taskDayGroups.filter((g) => g.isDistant);
  const totalDistantTasksCount = distantGroups.reduce((acc, g) => acc + g.tasks.length, 0);
  const isActuallyOverdueExpanded = isOverdueExpanded || taskFilter === 'overdue';

  // Helper to render individual task card
  const renderTaskCard = (task: Task, forceOverdue = false) => {
    const isExpanded = expandedTasks.has(task.id);
    const hasSteps = task.steps && task.steps.length > 0;
    const completedCount = task.steps?.filter((s) => s.status === 'done').length || 0;
    const progressPercent = hasSteps ? Math.round((completedCount / task.steps.length) * 100) : 0;

    const dueTime = task.due_at ? new Date(task.due_at).getTime() : null;
    const remindTime = task.remind_at ? new Date(task.remind_at).getTime() : null;
    const isDueOverdue = dueTime !== null && dueTime < referenceNow && task.status === 'todo';
    const isRemindOverdue = remindTime !== null && remindTime < referenceNow && task.status === 'todo';
    const isOverdue = forceOverdue || isDueOverdue || isRemindOverdue;
    const overdueBadge = isOverdue ? getOverdueBadgeText(task, referenceNow, locale) : null;
    const recurrenceLabel = formatRecurrence(task.recurrence, locale);

    const formattedDueDate = task.due_at ? formatTaskDate(task.due_at, isDueOverdue, locale) : null;
    const formattedRemindDate = task.remind_at ? formatTaskDate(task.remind_at, isRemindOverdue, locale) : null;

    // Show reminder badge ONLY if set AND differs from the due date (avoid duplicate labels)
    const showDistinctReminder = Boolean(
      formattedRemindDate &&
      (!formattedDueDate || (task.due_at !== task.remind_at && formattedDueDate !== formattedRemindDate))
    );

    return (
      <div key={task.id} className={`task-card ${isOverdue ? 'is-overdue' : ''}`}>
        <div className="task-main">
          <button
            type="button"
            className="checkbox-btn"
            role="checkbox"
            aria-checked={task.status === 'done'}
            aria-label={task.status === 'done' ? t('tasks.markUndone', { title: task.title }) : t('tasks.markDone', { title: task.title })}
            onClick={() => handleToggleTask(task)}
          >
            {task.status === 'done' && <Check size={14} strokeWidth={1.75} />}
          </button>

          <div className="task-info">
            <span className="task-title">{task.title}</span>

            <div className="task-meta">
              {/* 1-tap item type toggle chip */}
              {handleToggleItemType && (
                <button
                  type="button"
                  className={`task-type-chip ${task.item_type === 'event' ? 'is-event' : 'is-task'}`}
                  title={
                    task.item_type === 'event'
                      ? t('tasks.switchToTaskTitle')
                      : t('tasks.switchToEventTitle')
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleItemType(task);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    fontSize: 11,
                    padding: '2px 7px',
                    borderRadius: 10,
                    border:
                      task.item_type === 'event'
                        ? '1px solid rgba(99, 102, 241, 0.4)'
                        : '1px solid var(--border-hairline)',
                    background:
                      task.item_type === 'event'
                        ? 'rgba(99, 102, 241, 0.15)'
                        : 'var(--bg-surface-elevated)',
                    color: task.item_type === 'event' ? '#818cf8' : 'var(--text-muted)',
                    cursor: 'pointer',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {task.item_type === 'event' ? t('tasks.eventItemChip') : t('tasks.taskItemChip')}
                </button>
              )}

              {/* Overdue highlight badge */}
              {overdueBadge && (
                <span className="badge-overdue tabular-nums">
                  <Clock size={11} strokeWidth={1.75} />
                  {overdueBadge}
                </span>
              )}

              {/* Category badge */}
              {task.category_name && (
                <span className="task-cat-badge">
                  {task.category_name}
                  {task.subcategory_name && ` · ${task.subcategory_name}`}
                </span>
              )}

              {/* Recurrence badge */}
              {recurrenceLabel && (
                <span className="badge-recurrence">
                  <Repeat size={11} strokeWidth={1.75} />
                  {recurrenceLabel}
                </span>
              )}

              {/* Due date badge */}
              {formattedDueDate && (
                <span className={`badge-due-date ${isDueOverdue ? 'badge-overdue' : ''} tabular-nums`}>
                  <Calendar size={11} strokeWidth={1.75} />
                  {isDueOverdue ? t('tasks.dueOverduePrefix') : t('tasks.duePrefix')}
                  {formattedDueDate}
                </span>
              )}

              {/* Reminder badge (only when different from due date or when due date is absent) */}
              {showDistinctReminder && formattedRemindDate && (
                <span className={`badge-reminder ${isRemindOverdue ? 'badge-overdue' : ''} tabular-nums`}>
                  <Clock size={11} strokeWidth={1.75} />
                  {isRemindOverdue ? t('tasks.remindOverduePrefix') : t('tasks.remindPrefix')}
                  {formattedRemindDate}
                </span>
              )}

              {/* Creation date for tasks without deadlines */}
              {!task.due_at && !task.remind_at && task.created_at && (
                <span className="tabular-nums" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {formatTaskCreatedDate(task.created_at, locale)}
                </span>
              )}
            </div>

            {/* Notes block */}
            {task.notes && (
              <div className="task-notes-block">
                <FileText size={12} strokeWidth={1.75} className="task-notes-icon" />
                <span>{task.notes}</span>
              </div>
            )}

            {/* Subtasks progress indicator */}
            {hasSteps && (
              <div
                className="task-steps-summary"
                onClick={() => toggleTaskExpanded(task.id)}
              >
                <div className="steps-progress-track">
                  <div
                    className="steps-progress-bar"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <span className="steps-progress-text tabular-nums">
                  {t('tasks.stepsProgress', { done: completedCount, total: task.steps.length, pct: progressPercent })}
                </span>
                {isExpanded ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
              </div>
            )}
          </div>

          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {/* 1-tap Reschedule Today button on overdue tasks */}
            {isOverdue && handleRescheduleTaskToday && (
              <button
                type="button"
                className="btn-reschedule-today"
                onClick={(e) => {
                  e.stopPropagation();
                  triggerHaptic('medium');
                  handleRescheduleTaskToday(task);
                }}
                title={t('tasks.rescheduleTodayTitle')}
                aria-label={t('tasks.rescheduleTodayAria', { title: task.title })}
              >
                <CalendarCheck size={13} strokeWidth={1.75} />
                <span>{t('tasks.rescheduleToday')}</span>
              </button>
            )}

            {onUpdateTask && (
              <button
                type="button"
                className="btn-link"
                onClick={(e) => {
                  e.stopPropagation();
                  openEditTaskModal(task);
                }}
                style={{ padding: 6, opacity: 0.7 }}
                title={t('tasks.editTask')}
                aria-label={t('tasks.editTask')}
              >
                <Pencil size={14} strokeWidth={1.75} />
              </button>
            )}

            <button
              type="button"
              className="btn-link"
              onClick={() => handleDeleteTask(task.id)}
              style={{ padding: 6, opacity: 0.6 }}
              title={t('tasks.deleteTask')}
              aria-label={t('tasks.deleteTask')}
            >
              <Trash2 size={15} strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* Subtasks Accordion */}
        {hasSteps && isExpanded && (
          <div className="steps-accordion">
            {task.steps.map((step, idx) => (
              <div key={step.id || idx} className="step-row">
                <button
                  type="button"
                  className={`step-checkbox ${step.status === 'done' ? 'checked' : ''}`}
                  role="checkbox"
                  aria-checked={step.status === 'done'}
                  aria-label={step.status === 'done' ? t('tasks.markSubtaskUndone', { title: step.title }) : t('tasks.markSubtaskDone', { title: step.title })}
                  onClick={() => handleToggleStep(task, idx)}
                >
                  {step.status === 'done' && <Check size={12} strokeWidth={1.75} />}
                </button>
                <span className={`step-title ${step.status === 'done' ? 'done' : ''}`}>
                  {step.title}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Categories Horizontal Bar */}
      <div className="categories-bar">
        <button
          type="button"
          className={`category-chip ${selectedCategory === null ? 'active' : ''} tabular-nums`}
          onClick={() => {
            triggerHaptic('light');
            setSelectedCategory(null);
            setSelectedSubcategory(null);
          }}
        >
          {t('tasks.allCount', { count: tasks.length })}
        </button>
        {categories.map((cat) => {
          const count = tasks.filter((t) => t.category_name === cat.name).length;
          const isSelected = selectedCategory === cat.name;
          return (
            <button
              key={cat.id}
              type="button"
              className={`category-chip ${isSelected ? 'active' : ''} tabular-nums`}
              onClick={() => {
                triggerHaptic('light');
                if (isSelected) {
                  setSelectedCategory(null);
                  setSelectedSubcategory(null);
                } else {
                  setSelectedCategory(cat.name);
                  setSelectedSubcategory(null);
                  setNewTaskCat(cat.name);
                  setNewTaskSubcat('');
                }
              }}
            >
              {cat.name} {count > 0 && `(${count})`}
            </button>
          );
        })}
        <button
          type="button"
          className="category-chip"
          style={{ borderStyle: 'dashed' }}
          onClick={() => setIsAddingCat(true)}
        >
          {t('tasks.addCategory')}
        </button>
      </div>

      {/* Secondary Subcategories Chips Bar */}
      {(() => {
        const activeCatObj = categories.find((c) => c.name === selectedCategory);
        if (!activeCatObj || !activeCatObj.subcategories || activeCatObj.subcategories.length === 0) return null;
        return (
          <div className="subcategories-bar" style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 0 10px', scrollbarWidth: 'none' }}>
            <button
              type="button"
              className={`subcategory-chip ${selectedSubcategory === null ? 'active' : ''}`}
              style={{
                fontSize: '11px',
                padding: '3px 9px',
                borderRadius: '12px',
                border: selectedSubcategory === null ? '1px solid var(--accent-color)' : '1px solid var(--border-hairline)',
                background: selectedSubcategory === null ? 'var(--accent-subtle)' : 'transparent',
                color: selectedSubcategory === null ? 'var(--accent-color)' : 'var(--text-muted)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              onClick={() => { triggerHaptic('light'); setSelectedSubcategory(null); }}
            >
              {t('tasks.allInCategory', { name: activeCatObj.name })}
            </button>
            {activeCatObj.subcategories.map((sub) => {
              const subCount = tasks.filter(
                (t) => t.category_name === activeCatObj.name && (t.subcategory_name === sub.name || t.subcategory_id === sub.id)
              ).length;
              const isSubActive = selectedSubcategory === sub.name;
              return (
                <button
                  key={sub.id}
                  type="button"
                  className={`subcategory-chip ${isSubActive ? 'active' : ''} tabular-nums`}
                  style={{
                    fontSize: '11px',
                    padding: '3px 9px',
                    borderRadius: '12px',
                    border: isSubActive ? '1px solid var(--accent-color)' : '1px solid var(--border-hairline)',
                    background: isSubActive ? 'var(--accent-color)' : 'var(--bg-surface-elevated)',
                    color: isSubActive ? 'var(--accent-text)' : 'var(--text-primary)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                  onClick={() => {
                    triggerHaptic('light');
                    setSelectedSubcategory(isSubActive ? null : sub.name);
                  }}
                >
                  {sub.name} {subCount > 0 && `(${subCount})`}
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* Add Category Inline Modal */}
      {isAddingCat && (
        <form onSubmit={handleAddCategory} className="task-form" style={{ marginTop: 0 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className="input-field"
              aria-label={t('tasks.categoryNamePlaceholder')}
              placeholder={t('tasks.categoryNamePlaceholder')}
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn-primary" style={{ padding: '0 16px' }}>
              {t('tasks.addBtn')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setIsAddingCat(false)}
            >
              {t('tasks.cancelBtn')}
            </button>
          </div>
        </form>
      )}

      {/* 1. Unified Control Bar: Quick Add Task + Compact Filter & Sort Button */}
      {!isTaskFormExpanded ? (
        <div className="tasks-unified-bar">
          <form
            onSubmit={handleCreateTask}
            className="task-form collapsed"
            style={{ margin: 0 }}
          >
            <div className="task-input-bar">
              <input
                type="text"
                className="input-field task-title-input"
                aria-label={t('tasks.createTaskTitle')}
                placeholder={t('tasks.addTaskPlaceholder')}
                value={newTaskTitle}
                onFocus={() => setIsTaskFormExpanded(true)}
                onChange={(e) => {
                  setNewTaskTitle(e.target.value);
                  if (e.target.value.trim() && !isTaskFormExpanded) {
                    setIsTaskFormExpanded(true);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleCreateTask();
                  }
                }}
              />
              <button
                type="button"
                className="btn-create-task"
                disabled={isSubmittingTask || !newTaskTitle.trim()}
                onClick={(e) => {
                  e.preventDefault();
                  handleCreateTask();
                }}
                title={t('tasks.createTaskTitle')}
                aria-label={t('tasks.createTaskTitle')}
              >
                <Plus size={16} strokeWidth={1.75} />
              </button>
            </div>
          </form>

          <div className="filter-popover-wrap">
            <button
              type="button"
              className={`btn-filter-trigger ${taskFilter !== 'all' || taskSort !== 'smart' ? 'has-active' : ''}`}
              onClick={() => {
                triggerHaptic('light');
                setShowFilterPopover((prev) => !prev);
              }}
              title={t('tasks.filterSortTitle')}
              aria-label={t('tasks.filterSortTitle')}
            >
              <SlidersHorizontal size={16} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={handleCreateTask}
          className="task-form expanded"
        >
          <div className="task-input-bar">
            <input
              type="text"
              className="input-field task-title-input"
              aria-label={t('tasks.createTaskTitle')}
              placeholder={t('tasks.addTaskPlaceholder')}
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCreateTask();
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="btn-create-task"
              disabled={isSubmittingTask || !newTaskTitle.trim()}
              onClick={(e) => {
                e.preventDefault();
                handleCreateTask();
              }}
              title={t('tasks.createTaskTitle')}
              aria-label={t('tasks.createTaskTitle')}
            >
              <Plus size={16} strokeWidth={1.75} />
            </button>
          </div>

          <div className="task-form-controls">
            {setNewTaskItemType && (
              <div
                style={{
                  display: 'inline-flex',
                  borderRadius: 8,
                  background: 'var(--bg-surface-elevated)',
                  border: '1px solid var(--border-hairline)',
                  padding: 2,
                  gap: 2,
                  flexShrink: 0,
                }}
              >
                <button
                  type="button"
                  style={{
                    padding: '3px 8px',
                    fontSize: 11.5,
                    borderRadius: 6,
                    border: 'none',
                    cursor: 'pointer',
                    background: newTaskItemType === 'task' ? 'var(--accent-color)' : 'transparent',
                    color: newTaskItemType === 'task' ? 'var(--accent-text)' : 'var(--text-muted)',
                    fontWeight: newTaskItemType === 'task' ? 600 : 400,
                  }}
                  onClick={() => {
                    triggerHaptic('light');
                    setNewTaskItemType('task');
                  }}
                >
                  {t('tasks.taskItemChip')}
                </button>
                <button
                  type="button"
                  style={{
                    padding: '3px 8px',
                    fontSize: 11.5,
                    borderRadius: 6,
                    border: 'none',
                    cursor: 'pointer',
                    background: newTaskItemType === 'event' ? '#6366f1' : 'transparent',
                    color: newTaskItemType === 'event' ? '#ffffff' : 'var(--text-muted)',
                    fontWeight: newTaskItemType === 'event' ? 600 : 400,
                  }}
                  onClick={() => {
                    triggerHaptic('light');
                    setNewTaskItemType('event');
                  }}
                >
                  {t('tasks.eventItemChip')}
                </button>
              </div>
            )}

            <select
              className="select-field"
              aria-label={t('tasks.categoryNamePlaceholder')}
              value={newTaskCat}
              onChange={(e) => {
                setNewTaskCat(e.target.value);
                setNewTaskSubcat('');
              }}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>

            {(() => {
              const catInForm = categories.find((c) => c.name === newTaskCat);
              if (!catInForm || !catInForm.subcategories || catInForm.subcategories.length === 0) return null;
              return (
                <select
                  className="select-field"
                  aria-label={t('tasks.noSubcategory')}
                  value={newTaskSubcat}
                  onChange={(e) => setNewTaskSubcat(e.target.value)}
                  style={{ maxWidth: 140, fontSize: 12 }}
                >
                  <option value="">{t('tasks.noSubcategory')}</option>
                  {catInForm.subcategories.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              );
            })()}

            <button
              type="button"
              className="btn-link"
              onClick={() => setShowSteps(!showSteps)}
              style={{ fontSize: 12.5 }}
            >
              {showSteps ? t('tasks.hideSteps') : t('tasks.splitSteps')}
            </button>

            <div style={{ flex: 1 }} />

            <button
              type="button"
              className="btn-link"
              style={{ fontSize: 12, opacity: 0.7 }}
              onClick={() => {
                setIsTaskFormExpanded(false);
                setShowSteps(false);
              }}
            >
              {t('tasks.collapse')}
            </button>
          </div>

          {/* Atomic Subtasks decomposition */}
          {showSteps && (
            <div className="steps-container">
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {t('tasks.microStepsHint')}
              </span>
              {steps.map((st, idx) => (
                <input
                  key={idx}
                  type="text"
                  className="input-field"
                  style={{ fontSize: 12.5, padding: '6px 10px' }}
                  aria-label={t('tasks.microStepAria', { n: idx + 1 })}
                  placeholder={t('tasks.stepN', { n: idx + 1 })}
                  value={st}
                  onChange={(e) => {
                    const copy = [...steps];
                    copy[idx] = e.target.value;
                    setSteps(copy);
                  }}
                />
              ))}
              <button
                type="button"
                className="btn-link"
                style={{ alignSelf: 'flex-start', fontSize: 11.5 }}
                onClick={() => setSteps([...steps, ''])}
              >
                {t('tasks.addMoreStep')}
              </button>
            </div>
          )}
        </form>
      )}

      {/* Filter & Sort Popover Panel */}
      {showFilterPopover && (
        <div className="filter-popover-panel">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('tasks.filterAndOrder')}</span>
            <span className="tasks-count-label tabular-nums" style={{ fontSize: 12 }}>
              {t('tasks.tasksCountLabel', { count: processedTasks.length })}
            </span>
          </div>

          <div className="tasks-filter-chips">
            <button
              type="button"
              className={`filter-chip ${taskFilter === 'all' ? 'active' : ''} tabular-nums`}
              onClick={() => { triggerHaptic('light'); setTaskFilter('all'); }}
            >
              {t('tasks.allCount', { count: tasks.length })}
            </button>
            {totalOverdueCount > 0 && (
              <button
                type="button"
                className={`filter-chip chip-overdue ${taskFilter === 'overdue' ? 'active' : ''} tabular-nums`}
                onClick={() => { triggerHaptic('light'); setTaskFilter('overdue'); }}
              >
                <Clock size={12} strokeWidth={1.75} />
                {t('tasks.requireAttention', { count: totalOverdueCount })}
              </button>
            )}
            <button
              type="button"
              className={`filter-chip ${taskFilter === 'dated' ? 'active' : ''}`}
              onClick={() => { triggerHaptic('light'); setTaskFilter('dated'); }}
            >
              <Calendar size={12} strokeWidth={1.75} />
              {t('tasks.dated')}
            </button>
            <button
              type="button"
              className={`filter-chip ${taskFilter === 'recurring' ? 'active' : ''}`}
              onClick={() => { triggerHaptic('light'); setTaskFilter('recurring'); }}
            >
              <Repeat size={12} strokeWidth={1.75} />
              {t('tasks.recurring')}
            </button>
          </div>

          <div className="tasks-sort-row" style={{ marginTop: 2 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('tasks.sortLabel')}</span>
            <div className="sort-select-wrapper">
              <ArrowUpDown size={13} strokeWidth={1.75} />
              <select
                value={taskSort}
                aria-label={t('tasks.sortAria')}
                onChange={(e) => {
                  triggerHaptic('light');
                  setTaskSort(e.target.value as TaskSortOption);
                }}
              >
                <option value="smart">{t('tasks.sortSmart')}</option>
                <option value="due_date">{t('tasks.sortDueDate')}</option>
                <option value="created_desc">{t('tasks.sortCreatedDesc')}</option>
                <option value="created_asc">{t('tasks.sortCreatedAsc')}</option>
                <option value="alpha">{t('tasks.sortAlpha')}</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* 2. Tasks List */}
      <div className="tasks-list">
        {/* Calm Accordion */}
        {overdueGroup && overdueGroup.tasks.length > 0 && (
          <div className="attention-accordion">
            <button
              type="button"
              className="attention-accordion-header"
              onClick={() => {
                triggerHaptic('light');
                setIsOverdueExpanded((v) => !v);
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Clock size={16} strokeWidth={1.75} color="var(--attention-warm)" />
                <span className="tabular-nums">{t('tasks.needActualization', { count: overdueGroup.tasks.length })}</span>
              </div>
              {isActuallyOverdueExpanded ? (
                <ChevronDown size={16} strokeWidth={1.75} />
              ) : (
                <ChevronRight size={16} strokeWidth={1.75} />
              )}
            </button>

            {isActuallyOverdueExpanded && (
              <div className="tasks-day-items" style={{ padding: '8px 10px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {overdueGroup.tasks.map((task) => renderTaskCard(task, true))}
              </div>
            )}
          </div>
        )}

        {/* Dedicated Section: 📅 Расписание / Мероприятия */}
        {activeEvents && activeEvents.length > 0 && (
          <div
            className="events-dedicated-section"
            style={{
              marginBottom: 12,
              padding: '10px 12px',
              borderRadius: 14,
              background: 'var(--bg-surface)',
              border: '1px solid rgba(99, 102, 241, 0.25)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#818cf8',
                }}
              >
                <Calendar size={15} strokeWidth={1.75} />
                <span>{t('tasks.scheduleEvents', { count: activeEvents.length })}</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeEvents.map((eventTask) => renderTaskCard(eventTask))}
            </div>
          </div>
        )}

        {/* Regular Day Groups & Empty State */}
        {regularGroups.length === 0 && distantGroups.length === 0 && (!overdueGroup || overdueGroup.tasks.length === 0) && (!activeEvents || activeEvents.length === 0) ? (
          <div className="empty-state">
            <Sparkles size={32} strokeWidth={1.75} color="var(--accent-color)" />
            <p>
              {taskFilter === 'overdue'
                ? t('tasks.emptyOverdue')
                : taskFilter !== 'all'
                ? t('tasks.emptyFilter')
                : t('tasks.emptyAll')}
            </p>
          </div>
        ) : (
          <>
            {regularGroups.map((group) => (
              <div key={group.id} className="tasks-day-group">
                <div className="tasks-day-header">
                  <div className="tasks-day-title-wrap">
                    <h3 className="tasks-day-title">
                      {group.title}
                    </h3>
                    <span className="tasks-day-count tabular-nums">{group.tasks.length}</span>
                  </div>
                </div>

                <div className="tasks-day-items">
                  {group.tasks.map((task) => renderTaskCard(task, false))}

                  {/* Inline task add row */}
                  {activeInlineDay === group.id ? (
                    <form
                      className="tasks-day-inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleCreateInlineTask(group);
                      }}
                    >
                      <span className="tasks-day-add-circle active" />
                      <input
                        type="text"
                        className="tasks-day-inline-input"
                        aria-label={t('tasks.newTaskInGroup', { group: group.title })}
                        placeholder={t('tasks.newTaskInGroup', { group: group.title })}
                        value={inlineTaskText}
                        onChange={(e) => setInlineTaskText(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setActiveInlineDay(null);
                            setInlineTaskText('');
                          }
                        }}
                      />
                      {inlineTaskText.trim() && (
                        <button
                          type="submit"
                          className="tasks-day-inline-submit"
                          disabled={isSubmittingInline}
                          title={t('tasks.createTaskTitle')}
                          aria-label={t('tasks.createTaskTitle')}
                        >
                          <Plus size={14} strokeWidth={1.75} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-link tasks-day-inline-cancel"
                        onClick={() => {
                          setActiveInlineDay(null);
                          setInlineTaskText('');
                        }}
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                      >
                        <X size={14} strokeWidth={1.75} />
                      </button>
                    </form>
                  ) : (
                    <div
                      className="tasks-day-add-placeholder"
                      onClick={() => {
                        triggerHaptic('light');
                        setActiveInlineDay(group.id);
                        setInlineTaskText('');
                      }}
                      title={t('tasks.addTaskInGroupTitle', { group: group.title })}
                    >
                      <span className="tasks-day-add-circle" />
                      <span className="tasks-day-add-label">{t('tasks.newTaskPlaceholder')}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {distantGroups.length > 0 && (
              <div className="distant-horizon-accordion">
                <button
                  type="button"
                  className="distant-horizon-header"
                  onClick={() => {
                    triggerHaptic('light');
                    setIsDistantExpanded((prev) => !prev);
                  }}
                  aria-expanded={isDistantExpanded}
                >
                  <div className="distant-horizon-title-wrap">
                    <Calendar size={15} strokeWidth={1.75} className="distant-horizon-icon" />
                    <span className="distant-horizon-title">{t('tasks.distantHorizon')}</span>
                    <span className="distant-horizon-count tabular-nums">{totalDistantTasksCount}</span>
                  </div>
                  {isDistantExpanded ? (
                    <ChevronDown size={16} strokeWidth={1.75} />
                  ) : (
                    <ChevronRight size={16} strokeWidth={1.75} />
                  )}
                </button>

                {isDistantExpanded && (
                  <div className="distant-horizon-content">
                    {distantGroups.map((group) => (
                      <div key={group.id} className="tasks-day-group">
                        <div className="tasks-day-header">
                          <div className="tasks-day-title-wrap">
                            <h3 className="tasks-day-title">
                              {group.title}
                            </h3>
                            <span className="tasks-day-count tabular-nums">{group.tasks.length}</span>
                          </div>
                        </div>

                        <div className="tasks-day-items">
                          {group.tasks.map((task) => renderTaskCard(task, false))}

                          {/* Inline task add row */}
                          {activeInlineDay === group.id ? (
                            <form
                              className="tasks-day-inline-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                handleCreateInlineTask(group);
                              }}
                            >
                              <span className="tasks-day-add-circle active" />
                              <input
                                type="text"
                                className="tasks-day-inline-input"
                                aria-label={t('tasks.newTaskInGroup', { group: group.title })}
                                placeholder={t('tasks.newTaskInGroup', { group: group.title })}
                                value={inlineTaskText}
                                onChange={(e) => setInlineTaskText(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    setActiveInlineDay(null);
                                    setInlineTaskText('');
                                  }
                                }}
                              />
                              {inlineTaskText.trim() && (
                                <button
                                  type="submit"
                                  className="tasks-day-inline-submit"
                                  disabled={isSubmittingInline}
                                  title={t('tasks.createTaskTitle')}
                                  aria-label={t('tasks.createTaskTitle')}
                                >
                                  <Plus size={14} strokeWidth={1.75} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn-link tasks-day-inline-cancel"
                                onClick={() => {
                                  setActiveInlineDay(null);
                                  setInlineTaskText('');
                                }}
                                title={t('common.cancel')}
                                aria-label={t('common.cancel')}
                              >
                                <X size={14} strokeWidth={1.75} />
                              </button>
                            </form>
                          ) : (
                            <div
                              className="tasks-day-add-placeholder"
                              onClick={() => {
                                triggerHaptic('light');
                                setActiveInlineDay(group.id);
                                setInlineTaskText('');
                              }}
                              title={t('tasks.addTaskInGroupTitle', { group: group.title })}
                            >
                              <span className="tasks-day-add-circle" />
                              <span className="tasks-day-add-label">{t('tasks.newTaskPlaceholder')}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Completed Tasks Accordion */}
        {completedTasks.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn-link"
              onClick={() => setShowCompleted(!showCompleted)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'center' }}
            >
              <Calendar size={14} strokeWidth={1.75} />
              <span className="tabular-nums">{t('tasks.completedCount', { count: completedTasks.length })}</span>
              {showCompleted ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
            </button>

            {showCompleted && (
              <div className="tasks-list" style={{ marginTop: 8, opacity: 0.7 }}>
                {completedTasks.map((task) => (
                  <div key={task.id} className="task-card">
                    <div className="task-main">
                      <button
                        type="button"
                        className="checkbox-btn checked"
                        role="checkbox"
                        aria-checked={true}
                        aria-label={t('tasks.markUndone', { title: task.title })}
                        onClick={() => handleToggleTask(task)}
                      >
                        <Check size={14} strokeWidth={1.75} />
                      </button>
                      <div className="task-info">
                        <span className="task-title done">{task.title}</span>
                      </div>
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => handleDeleteTask(task.id)}
                        style={{ padding: 4 }}
                        aria-label={t('tasks.deleteTask')}
                      >
                        <Trash2 size={15} strokeWidth={1.75} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Edit Task Bottom-Sheet Modal */}
        {editingTask && (
          <div
            className="sheet-overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) setEditingTask(null);
            }}
          >
            <div className="sheet-panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14.5, fontWeight: 600 }}>{t('tasks.editTaskTitle')}</span>
                <button
                  type="button"
                  className="btn-link"
                  aria-label={t('common.close')}
                  onClick={() => setEditingTask(null)}
                >
                  <X size={18} />
                </button>
              </div>
              <form onSubmit={handleSaveTaskEdit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    {t('tasks.titleLabel')}
                  </label>
                  <input
                    type="text"
                    required
                    className="input-field"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                      {t('tasks.dueDateLabel')}
                    </label>
                    <input
                      type="date"
                      className="input-field"
                      value={editDueDate}
                      onChange={(e) => setEditDueDate(e.target.value)}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                      {t('tasks.typeLabel')}
                    </label>
                    <select
                      className="input-field"
                      value={editItemType}
                      onChange={(e) => setEditItemType(e.target.value === 'event' ? 'event' : 'task')}
                    >
                      <option value="task">{t('tasks.typeTask')}</option>
                      <option value="event">{t('tasks.typeEvent')}</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    {t('tasks.categoryLabel')}
                  </label>
                  <select
                    className="input-field"
                    value={editCategoryId}
                    onChange={(e) => setEditCategoryId(e.target.value)}
                  >
                    <option value="">{t('common.none')}</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    {t('tasks.notesLabel')}
                  </label>
                  <textarea
                    rows={3}
                    className="input-field"
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ padding: '8px 14px', fontSize: 13 }}
                    onClick={() => setEditingTask(null)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingTaskEdit || !editTitle.trim()}
                    className="btn-primary"
                    style={{ padding: '8px 18px', fontSize: 13 }}
                  >
                    {isSavingTaskEdit ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </>
  );
};
