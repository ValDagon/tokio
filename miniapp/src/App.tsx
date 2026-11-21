import React, { useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  Sparkles,
  Trash2,
  ListTodo,
  Wallet,
  FileText,
  X,
  Clock,
  Brain,
  RotateCcw,
  Compass,
  WifiOff,
} from 'lucide-react';
import type {
  Task,
  Category,
  Account,
  FinanceSummary,
  RunwayInfo,
  TransactionItem,
  Note,
  Medication,
  Liability,
  DocChapterSummary,
  DocChapterDetail,
  TrashData,
  ReaderFontScale,
  UserSettings,
  UiConfig,
} from './types';
import {
  fetchTasks,
  fetchCategories,
  createTask,
  updateTask,
  deleteTask,
  createCategory,
  fetchSettings,
  updateSettings,
  fetchUiConfig,
  DEFAULT_UI_CONFIG,
  fetchAccounts,
  fetchFinanceSummary,
  fetchRunway,
  fetchTransactions,
  setBudget,
  fetchNotes,
  createNote,
  updateNote,
  deleteNote,
  fetchMedications,
  createMedication,
  takeMedication,
  skipMedication,
  deleteMedication,
  fetchLiabilities,
  payLiability,
  updateLiability,
  undoLastTransaction,
  resetFinances,
  fetchLifeContext,
  triggerHaptic,
  updateStepStatus,
  fetchDocChapters,
  fetchDocChapterDetail,
  fetchTrash,
  restoreTrashItem,
  deleteTrashItemPermanently,
  emptyTrash,
  getDataSource,
  subscribeDataSource,
  type ApiSource,
} from './api';
import './App.css';
import { TodayTab, TasksTab, FinancesTab, NotesTab, SystemTab } from './tabs';
import { ReaderSheet } from './components/ReaderSheet';
import { OnboardingModal } from './components/OnboardingModal';
import { useI18n, LOCALE_BCP47, normalizeLocale } from './i18n/index';
import { parseStartParam, readInitialStartParam } from './deepLink';

import {
  groupTasksByDay,
  getTargetDateForGroup,
  getNoteSummary,
  findDocSectionMatches,
  showAlert,
  showConfirm,
  type TaskDayGroup,
} from './utils';

type TaskSortOption = 'smart' | 'due_date' | 'created_desc' | 'created_asc' | 'alpha';
type TaskFilterOption = 'all' | 'overdue' | 'dated' | 'recurring';

interface NoteColumnDef {
  id: Note['column'];
  name: string;
}

interface PersonaPreset {
  id: string;
  title: string;
  desc: string;
  instruction: string;
}

const SUGGESTED_QUESTIONS: readonly string[] = [] as const;

const CALM_MODE_STORAGE_KEY = 'tokio_calm_mode';
const LEGACY_CALM_MODE_STORAGE_KEY = 'ag_calm_mode';

function readStoredCalmMode(): boolean {
  if (typeof window === 'undefined') return false;
  const current = localStorage.getItem(CALM_MODE_STORAGE_KEY);
  if (current !== null) return current === 'true';
  return localStorage.getItem(LEGACY_CALM_MODE_STORAGE_KEY) === 'true';
}

export function App() {
  const { locale, t, applyLocale } = useI18n();
  const [uiConfig, setUiConfig] = useState<UiConfig>(DEFAULT_UI_CONFIG);

  const noteColumns: readonly NoteColumnDef[] = React.useMemo(
    () => [
      { id: 'inbox', name: t('notes.colInbox') },
      { id: 'raw', name: t('notes.colRaw') },
      { id: 'ideas', name: t('notes.colIdeas') },
      { id: 'self', name: t('notes.colSelf') },
      { id: 'useful', name: t('notes.colUseful') },
      { id: 'possible_tasks', name: t('notes.colPossibleTasks') },
      { id: 'archive', name: t('notes.colArchive') },
    ],
    [t]
  );

  const personaPresets: readonly PersonaPreset[] = React.useMemo(
    () => [
      {
        id: 'mentor',
        title: t('personas.mentorTitle'),
        desc: t('personas.mentorDesc'),
        instruction: t('personas.mentorInstruction'),
      },
      {
        id: 'executive',
        title: t('personas.executiveTitle'),
        desc: t('personas.executiveDesc'),
        instruction: t('personas.executiveInstruction'),
      },
      {
        id: 'partner',
        title: t('personas.partnerTitle'),
        desc: t('personas.partnerDesc'),
        instruction: t('personas.partnerInstruction'),
      },
      {
        id: 'socratic',
        title: t('personas.socraticTitle'),
        desc: t('personas.socraticDesc'),
        instruction: t('personas.socraticInstruction'),
      },
    ],
    [t]
  );

  // Tasks state
  const [tasks, setTasks] = useState<Task[]>([]);
  const [completedTasks, setCompletedTasks] = useState<Task[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedSubcategory, setSelectedSubcategory] = useState<string | null>(null);
  const [taskSort, setTaskSort] = useState<TaskSortOption>('smart');
  const [taskFilter, setTaskFilter] = useState<TaskFilterOption>('all');
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [lowStimulation, setLowStimulation] = useState<boolean>(() => readStoredCalmMode());
  const [activeTab, setActiveTab] = useState<'today' | 'tasks' | 'finances' | 'notes' | 'assistant'>('today');

  // Assistant & Directives state
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [customInstructions, setCustomInstructions] = useState('');
  const [personaStyle, setPersonaStyle] = useState('mentor');
  const [isSavingDirectives, setIsSavingDirectives] = useState(false);
  const [directivesSavedMsg, setDirectivesSavedMsg] = useState(false);
  const [lifeContext, setLifeContext] = useState<string>('');
  const [contextDepth, setContextDepth] = useState<number>(1);
  const [loadingContext, setLoadingContext] = useState(false);
  const [copiedPromptIndex, setCopiedPromptIndex] = useState<number | null>(null);

  // Documentation & Reader state
  const [docChapters, setDocChapters] = useState<DocChapterSummary[]>([]);
  const [selectedChapterSlug, setSelectedChapterSlug] = useState<string | null>(null);
  const [initialDocSectionTitle, setInitialDocSectionTitle] = useState<string | null>(null);
  const [chapterDetail, setChapterDetail] = useState<DocChapterDetail | null>(null);
  const [loadingDocs, setLoadingDocs] = useState<boolean>(false);
  const [loadingChapterDetail, setLoadingChapterDetail] = useState<boolean>(false);
  const [docSearchQuery, setDocSearchQuery] = useState<string>('');
  const [activeReaderNoteId, setActiveReaderNoteId] = useState<string | null>(null);
  const [showDossierReader, setShowDossierReader] = useState<boolean>(false);
  const [readerFontScale, setReaderFontScale] = useState<ReaderFontScale>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('ag_reader_font_scale');
      if (saved === 'normal' || saved === 'large' || saved === 'xlarge') return saved;
    }
    return 'normal';
  });

  // New task form state
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskItemType, setNewTaskItemType] = useState<'task' | 'event'>('task');
  const [newTaskCat, setNewTaskCat] = useState('');
  const [newTaskSubcat, setNewTaskSubcat] = useState<string>('');
  const [isSubmittingTask, setIsSubmittingTask] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [steps, setSteps] = useState<string[]>(['', '']);
  const [isTaskFormExpanded, setIsTaskFormExpanded] = useState(false);

  // Add category state
  const [isAddingCat, setIsAddingCat] = useState(false);
  const [newCatName, setNewCatName] = useState('');

  // Show completed toggle
  const [showCompleted, setShowCompleted] = useState(false);

  // Inline day task creation state (iOS Reminders style)
  const [activeInlineDay, setActiveInlineDay] = useState<string | null>(null);
  const [inlineTaskText, setInlineTaskText] = useState('');
  const [isSubmittingInline, setIsSubmittingInline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<ApiSource>(getDataSource());
  useEffect(() => subscribeDataSource(setDataSource), []);

  // Finances state
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeBankName, setActiveBankName] = useState<string | null>(null);
  const [finSummary, setFinSummary] = useState<FinanceSummary | null>(null);
  const [runway, setRunway] = useState<RunwayInfo | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [finLoading, setFinLoading] = useState(false);
  const [budgetModalCategory, setBudgetModalCategory] = useState<string | null>(null);
  const [budgetLimitInput, setBudgetLimitInput] = useState('');
  const [liabilities, setLiabilities] = useState<Liability[]>([]);
  const [activeLiabilityQueue, setActiveLiabilityQueue] = useState<string | null>(null);

  // Notes state
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteCol, setSelectedNoteCol] = useState<string | null>(null);
  const [pendingDeepLinkNoteId, setPendingDeepLinkNoteId] = useState<string | null>(null);
  const [newNoteText, setNewNoteText] = useState('');
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteSearch, setNoteSearch] = useState('');
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [copiedNoteId, setCopiedNoteId] = useState<string | null>(null);

  // Medications state (now inside SystemTab)
  const [medications, setMedications] = useState<Medication[]>([]);
  const [medsLoading, setMedsLoading] = useState(false);
  const [isAddingMed, setIsAddingMed] = useState(false);
  const [newMedName, setNewMedName] = useState('');
  const [newMedDosage, setNewMedDosage] = useState('');
  const [newMedTimes, setNewMedTimes] = useState('09:00');
  const [newMedInstructions, setNewMedInstructions] = useState('');
  const [isSubmittingMed, setIsSubmittingMed] = useState(false);

  // Trash state
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [trashData, setTrashData] = useState<TrashData | null>(null);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashTab, setTrashTab] = useState<'all' | 'tasks' | 'notes'>('all');
  const [isEmptyingTrash, setIsEmptyingTrash] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // Initialize Telegram WebApp & data
  useEffect(() => {
    if (readStoredCalmMode()) {
      document.body.classList.add('low-stimulation');
    }

    const configureTelegram = () => {
      try {
        const wa = window.Telegram?.WebApp;
        if (wa) {
          wa.ready?.();
          wa.expand?.();
          let isFs = false;
          try {
            wa.requestFullscreen?.();
            isFs = true;
          } catch { /* unsupported in older clients */ }
          try { wa.disableVerticalSwipes?.(); } catch { /* unsupported in older clients */ }
          try { wa.setHeaderColor?.('#0c0d10'); } catch { /* ignore */ }
          try { wa.setBackgroundColor?.('#0c0d10'); } catch { /* ignore */ }
          try { wa.setBottomBarColor?.('#0c0d10'); } catch { /* ignore */ }

          document.body.classList.add('in-telegram');
          const isActuallyFs = Boolean(wa.isFullscreen) || isFs;
          if (isActuallyFs) {
            document.body.classList.add('tg-fullscreen');
          }

          const contentTop = wa.contentSafeAreaInset?.top ?? 0;
          const safeTop = wa.safeAreaInset?.top ?? 0;
          const targetTop = isActuallyFs
            ? Math.max(contentTop, safeTop + 44, 96)
            : Math.max(contentTop, safeTop + 14, 52);

          document.documentElement.style.setProperty(
            '--tg-content-safe-area-inset-top',
            `${targetTop}px`
          );
        }
      } catch (e) {
        console.warn('Telegram WebApp init warning:', e);
      }
    };

    configureTelegram();
    const t1 = setTimeout(configureTelegram, 100);
    const t2 = setTimeout(configureTelegram, 350);

    const initialTarget = parseStartParam(readInitialStartParam());
    if (initialTarget) {
      setActiveTab(initialTarget.tab);
      if (initialTarget.taskId) {
        const deepLinkTaskId = initialTarget.taskId;
        setSelectedCategory(null);
        setSelectedSubcategory(null);
        setTaskFilter('all');
        setExpandedTasks(prev => {
          const next = new Set(prev);
          next.add(deepLinkTaskId);
          return next;
        });
      }
      if (initialTarget.liabilityQueue) {
        setActiveLiabilityQueue(initialTarget.liabilityQueue);
      }
      if (initialTarget.bankName) {
        setActiveBankName(initialTarget.bankName);
      }
      if (initialTarget.noteCol) {
        setSelectedNoteCol(initialTarget.noteCol);
      }
      if (initialTarget.noteId) {
        setSelectedNoteCol(null);
        setPendingDeepLinkNoteId(initialTarget.noteId);
      }
      if (initialTarget.openDossier) {
        setShowDossierReader(true);
      }
    }

    const wa = window.Telegram?.WebApp;
    if (wa?.onEvent) {
      wa.onEvent('fullscreenChanged', configureTelegram);
      wa.onEvent('contentSafeAreaChanged', configureTelegram);
      wa.onEvent('safeAreaChanged', configureTelegram);
    }

    loadInitialData();

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      if (wa?.offEvent) {
        wa.offEvent('fullscreenChanged', configureTelegram);
        wa.offEvent('contentSafeAreaChanged', configureTelegram);
        wa.offEvent('safeAreaChanged', configureTelegram);
      }
    };
  }, []);

  // Lazy load tab data
  useEffect(() => {
    if (activeTab === 'finances' && accounts.length === 0) {
      loadFinances();
    } else if (activeTab === 'notes' && notes.length === 0) {
      loadNotes();
    } else if (activeTab === 'assistant') {
      if (userSettings?.role === 'admin') {
        if (!lifeContext) loadAssistantData();
        if (docChapters.length === 0) loadDocsData();
      }
      if (medications.length === 0) loadMedications();
    }
  }, [activeTab, accounts.length, notes.length, medications.length, lifeContext, docChapters.length, userSettings?.role]);

  // Resolve deep-linked note once notes finish loading
  useEffect(() => {
    if (!pendingDeepLinkNoteId || notes.length === 0) return;
    const match = notes.find(n => String(n.id) === pendingDeepLinkNoteId);
    if (match) {
      setActiveReaderNoteId(match.id);
    }
    setPendingDeepLinkNoteId(null);
  }, [pendingDeepLinkNoteId, notes]);

  // Wire Telegram BackButton to close open modals & reader sheet
  useEffect(() => {
    const bb = typeof window !== 'undefined' ? window.Telegram?.WebApp?.BackButton : undefined;
    if (!bb || typeof bb.onClick !== 'function') return;

    const isReaderOpen =
      activeReaderNoteId !== null || selectedChapterSlug !== null || showDossierReader;
    const hasOpenModal = showTrashModal || budgetModalCategory !== null || isReaderOpen;

    if (hasOpenModal) {
      const handleBackClick = () => {
        triggerHaptic('light');
        if (activeReaderNoteId !== null) {
          setActiveReaderNoteId(null);
        } else if (selectedChapterSlug !== null) {
          setSelectedChapterSlug(null);
          setInitialDocSectionTitle(null);
          setChapterDetail(null);
        } else if (showDossierReader) {
          setShowDossierReader(false);
        } else if (showTrashModal) {
          setShowTrashModal(false);
        } else if (budgetModalCategory !== null) {
          setBudgetModalCategory(null);
        }
      };

      try {
        bb.show();
        bb.onClick(handleBackClick);
      } catch (e) {
        console.warn('Telegram BackButton show error:', e);
      }

      return () => {
        try {
          bb.offClick(handleBackClick);
          bb.hide();
        } catch (e) {
          console.warn('Telegram BackButton cleanup error:', e);
        }
      };
    } else {
      try {
        bb.hide();
      } catch {
        /* ignore */
      }
    }
  }, [
    showTrashModal,
    budgetModalCategory,
    activeReaderNoteId,
    selectedChapterSlug,
    showDossierReader,
  ]);

  async function loadInitialData() {
    try {
      setLoading(true);
      setLoadError(null);
      const [cats, todoList, doneList, settings, fetchedUiConfig] = await Promise.all([
        fetchCategories(),
        fetchTasks(undefined, 'todo'),
        fetchTasks(undefined, 'done'),
        fetchSettings(),
        fetchUiConfig(),
      ]);

      setUiConfig(fetchedUiConfig);
      setUserSettings(settings);
      if (settings.language) {
        applyLocale(normalizeLocale(settings.language));
      }
      setCategories(cats);
      if (cats.length > 0 && !newTaskCat) {
        setNewTaskCat(cats[0].name);
      }
      setTasks(todoList);
      setCompletedTasks(doneList);
      setLowStimulation(settings.low_stimulation_mode);
      if (typeof window !== 'undefined') {
        localStorage.setItem(CALM_MODE_STORAGE_KEY, String(settings.low_stimulation_mode));
      }

      // Non-blocking background prefetches for TodayTab & Header
      fetchTrash().then(setTrashData).catch(() => {});
      fetchRunway().then(setRunway).catch(() => {});
      fetchLiabilities().then(setLiabilities).catch(() => {});

      if (settings.custom_instructions) {
        setCustomInstructions(settings.custom_instructions);
      }
      if (settings.persona_style) {
        setPersonaStyle(settings.persona_style);
      }

      if (settings.low_stimulation_mode) {
        document.body.classList.add('low-stimulation');
      } else {
        document.body.classList.remove('low-stimulation');
      }
    } catch (err: unknown) {
      console.error('Failed to load initial data:', err);
      const msg = err instanceof Error ? err.message : t('errors.networkError');
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function loadAssistantData(depth: number = contextDepth) {
    try {
      setLoadingContext(true);
      const res = await fetchLifeContext(undefined, depth);
      setLifeContext(res.context);
    } catch (err) {
      console.error('Failed to load life context:', err);
    } finally {
      setLoadingContext(false);
    }
  }

  async function loadDocsData() {
    try {
      setLoadingDocs(true);
      const data = await fetchDocChapters();
      setDocChapters(data);
    } catch (err) {
      console.error('Failed to load documentation chapters:', err);
    } finally {
      setLoadingDocs(false);
    }
  }

  const handleChangeFontScale = (scale: ReaderFontScale) => {
    setReaderFontScale(scale);
    if (typeof window !== 'undefined') {
      localStorage.setItem('ag_reader_font_scale', scale);
    }
  };

  async function handleToggleChapter(slug: string, sectionTitle?: string) {
    triggerHaptic('light');
    setSelectedChapterSlug(slug);
    setInitialDocSectionTitle(sectionTitle || null);

    const existing = docChapters.find((c) => c.slug === slug);
    if (existing && existing.content && existing.sections && existing.sections.length > 0) {
      setChapterDetail({
        slug: existing.slug,
        filename: existing.filename,
        title: existing.title,
        summary: existing.summary,
        content: existing.content,
        sections: existing.sections,
      });
      return;
    }

    try {
      setLoadingChapterDetail(true);
      const detail = await fetchDocChapterDetail(slug);
      setChapterDetail(detail);
    } catch (err) {
      console.error('Failed to load chapter detail:', err);
    } finally {
      setLoadingChapterDetail(false);
    }
  }

  const handleSaveDirectives = async (extra?: {
    base_currency?: string;
    timezone?: string;
    personal_memory?: string;
  }) => {
    try {
      setIsSavingDirectives(true);
      const updated = await updateSettings({
        custom_instructions: customInstructions,
        persona_style: personaStyle,
        ...(extra || {}),
      });
      setUserSettings(updated);
      triggerHaptic('success');
      setDirectivesSavedMsg(true);
      setTimeout(() => setDirectivesSavedMsg(false), 3000);
    } catch (err) {
      console.error('Failed to save directives:', err);
    } finally {
      setIsSavingDirectives(false);
    }
  };

  const handleCopyPrompt = (text: string, index: number) => {
    navigator.clipboard?.writeText(text);
    triggerHaptic('light');
    setCopiedPromptIndex(index);
    setTimeout(() => setCopiedPromptIndex(null), 2000);
  };

  const suggestedQuestions = SUGGESTED_QUESTIONS;

  async function loadFinances() {
    try {
      setFinLoading(true);
      const [accs, summary, txs, liabs, rw] = await Promise.all([
        fetchAccounts(),
        fetchFinanceSummary(),
        fetchTransactions(40),
        fetchLiabilities(),
        fetchRunway().catch(() => null),
      ]);
      setRunway(rw);
      setAccounts(accs);
      setFinSummary(summary);
      setTransactions(txs);
      setLiabilities(liabs);
    } catch (err) {
      console.error('Failed to load finances:', err);
    } finally {
      setFinLoading(false);
    }
  }

  async function loadNotes() {
    try {
      setNotesLoading(true);
      const data = await fetchNotes();
      setNotes(data);
    } catch (err) {
      console.error('Failed to load notes:', err);
    } finally {
      setNotesLoading(false);
    }
  }

  const toggleLowStimulation = async () => {
    const nextVal = !lowStimulation;
    setLowStimulation(nextVal);
    if (typeof window !== 'undefined') {
      localStorage.setItem(CALM_MODE_STORAGE_KEY, String(nextVal));
    }
    triggerHaptic('medium');
    if (nextVal) {
      document.body.classList.add('low-stimulation');
    } else {
      document.body.classList.remove('low-stimulation');
    }
    try {
      await updateSettings({ low_stimulation_mode: nextVal });
    } catch (err) {
      console.error('Failed to sync low-stimulation mode:', err);
    }
  };

  // --- Task Handlers ---

  const handleToggleTask = async (task: Task) => {
    triggerHaptic('success');
    const isTodo = task.status === 'todo';
    const nextStatus = isTodo ? 'done' : 'todo';

    if (isTodo) {
      setTasks(tasks.filter(t => t.id !== task.id));
      setCompletedTasks([{ ...task, status: 'done' }, ...completedTasks]);
    } else {
      setCompletedTasks(completedTasks.filter(t => t.id !== task.id));
      setTasks([{ ...task, status: 'todo' }, ...tasks]);
    }

    try {
      await updateTask(task.id, { status: nextStatus });
    } catch (err) {
      console.error('Failed to update task:', err);
      loadInitialData();
    }
  };

  const handleToggleStep = async (task: Task, stepIndex: number) => {
    triggerHaptic('light');
    const step = task.steps[stepIndex];
    if (!step) return;

    const nextStatus = step.status === 'todo' ? 'done' : 'todo';
    const updatedSteps = [...task.steps];
    updatedSteps[stepIndex] = { ...step, status: nextStatus };

    setTasks(tasks.map(t => (t.id === task.id ? { ...t, steps: updatedSteps } : t)));

    try {
      if (step.id) {
        await updateStepStatus(step.id, nextStatus);
      }
    } catch (err) {
      console.error('Failed to update step:', err);
    }
  };

  const handleRescheduleTaskToday = async (task: Task) => {
    triggerHaptic('success');
    const now = new Date();
    const todayIso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).toISOString();

    setTasks(prev =>
      prev.map(t =>
        t.id === task.id
          ? {
              ...t,
              due_at: todayIso,
              remind_at: t.remind_at ? todayIso : null,
            }
          : t
      )
    );

    try {
      await updateTask(task.id, {
        due_at: todayIso,
        ...(task.remind_at ? { remind_at: todayIso } : {}),
      });
    } catch (err) {
      console.error('Failed to reschedule task to today:', err);
      loadInitialData();
    }
  };

  const handleQuickCapture = async (text: string, mode: 'task' | 'note') => {
    const trimmed = text.trim();
    if (!trimmed) return;
    triggerHaptic('medium');

    if (mode === 'task') {
      const now = new Date();
      const todayIso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).toISOString();
      const defaultCat = categories[0]?.name || t('tasks.defaultCategory');
      const catObj = categories.find(c => c.name === defaultCat);
      const created = await createTask({
        title: trimmed,
        category_name: defaultCat,
        category_id: catObj?.id,
        due_at: todayIso,
      });
      setTasks(prev => [created, ...prev]);
      triggerHaptic('success');
    } else {
      const created = await createNote(trimmed, 'inbox');
      setNotes(prev => [created, ...prev]);
      triggerHaptic('success');
    }
  };

  const handleConvertNoteToTask = async (note: Note) => {
    triggerHaptic('medium');
    const rawBody = (note.clean_text || note.raw_text || '').trim();
    const summaryTitle = getNoteSummary(rawBody, locale);
    const catToUse = selectedCategory || (categories.length > 0 ? categories[0].name : t('tasks.defaultCategory'));
    const catObj = categories.find(c => c.name === catToUse);

    try {
      const createdTask = await createTask({
        title: summaryTitle,
        category_name: catToUse,
        category_id: catObj?.id,
        notes: rawBody.length > summaryTitle.length ? rawBody : undefined,
      });
      setTasks(prev => [createdTask, ...prev]);
      setNotes(prev => prev.map(n => (n.id === note.id ? { ...n, column: 'archive' } : n)));
      await updateNote(note.id, { column: 'archive' });
      triggerHaptic('success');
    } catch (err) {
      console.error('Failed to convert note to task:', err);
      await showAlert(t('tasks.errConvertNote'));
    }
  };

  const handleCreateTask = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const title = newTaskTitle.trim();
    if (!title) {
      triggerHaptic('light');
      return;
    }
    if (isSubmittingTask) return;

    setIsSubmittingTask(true);
    triggerHaptic('medium');
    const filteredSteps = steps.map(s => s.trim()).filter(Boolean);
    const catToUse = newTaskCat || (categories.length > 0 ? categories[0].name : t('tasks.defaultCategory'));
    const catObj = categories.find(c => c.name === catToUse);
    const subcatObj = catObj?.subcategories?.find(s => s.id === newTaskSubcat || s.name === newTaskSubcat);

    try {
      const created = await createTask({
        title,
        item_type: newTaskItemType,
        category_name: catToUse,
        category_id: catObj?.id,
        subcategory_id: subcatObj?.id,
        subcategory_name: subcatObj?.name,
        steps: filteredSteps.length > 0 ? filteredSteps : undefined,
      });

      setTasks(prev => [created, ...prev]);
      setNewTaskTitle('');
      setNewTaskItemType('task');
      setNewTaskSubcat('');
      setSteps(['', '']);
      setShowSteps(false);
      setIsTaskFormExpanded(false);
      triggerHaptic('success');
    } catch (err: unknown) {
      console.error('Failed to create task:', err);
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      await showAlert(t('tasks.errCreateTask', { msg }));
    } finally {
      setIsSubmittingTask(false);
    }
  };

  const handleToggleItemType = async (task: Task) => {
    triggerHaptic('medium');
    const newType: 'task' | 'event' = task.item_type === 'event' ? 'task' : 'event';
    setTasks(prev => prev.map(t => (t.id === task.id ? { ...t, item_type: newType } : t)));
    try {
      await updateTask(task.id, { item_type: newType });
    } catch (err) {
      console.error('Failed to toggle item type:', err);
      loadInitialData();
    }
  };

  const handleCreateInlineTask = async (group: TaskDayGroup) => {
    const title = inlineTaskText.trim();
    if (!title || isSubmittingInline) return;

    setIsSubmittingInline(true);
    triggerHaptic('medium');

    const targetDueAt = getTargetDateForGroup(group.id, group.dateKey);
    const catToUse = selectedCategory || newTaskCat || (categories.length > 0 ? categories[0].name : t('tasks.defaultCategory'));
    const catObj = categories.find(c => c.name === catToUse);
    const subcatObj = catObj?.subcategories?.find(s => s.name === selectedSubcategory || s.id === selectedSubcategory);

    try {
      const created = await createTask({
        title,
        category_name: catToUse,
        category_id: catObj?.id,
        subcategory_id: subcatObj?.id,
        subcategory_name: subcatObj?.name,
        due_at: targetDueAt,
      });

      setTasks(prev => [created, ...prev]);
      setInlineTaskText('');
      triggerHaptic('success');
    } catch (err: unknown) {
      console.error('Failed to create inline task:', err);
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      await showAlert(t('tasks.errCreateTask', { msg }));
    } finally {
      setIsSubmittingInline(false);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    triggerHaptic('light');
    setTasks(tasks.filter(t => t.id !== taskId));
    setCompletedTasks(completedTasks.filter(t => t.id !== taskId));
    try {
      await deleteTask(taskId);
      fetchTrash().then(setTrashData).catch(() => {});
    } catch (err) {
      console.error('Failed to delete task:', err);
      loadInitialData();
    }
  };

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) return;

    try {
      const cat = await createCategory(newCatName.trim());
      setCategories([...categories, cat]);
      setNewCatName('');
      setIsAddingCat(false);
      setNewTaskCat(cat.name);
    } catch (err) {
      console.error('Failed to create category:', err);
    }
  };

  const toggleTaskExpanded = (taskId: string) => {
    triggerHaptic('light');
    const next = new Set(expandedTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    setExpandedTasks(next);
  };

  // --- Finance Handlers ---

  const handleSaveBudget = async () => {
    if (!budgetModalCategory || !budgetLimitInput) return;
    const limit = parseFloat(budgetLimitInput);
    if (isNaN(limit) || limit <= 0) return;

    triggerHaptic('medium');
    try {
      await setBudget(budgetModalCategory, limit);
      setBudgetModalCategory(null);
      setBudgetLimitInput('');
      await loadFinances();
    } catch (err) {
      console.error('Failed to set budget:', err);
    }
  };

  // --- Note Handlers ---

  const handleCreateNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNoteText.trim()) return;

    triggerHaptic('medium');
    try {
      const col = selectedNoteCol || 'inbox';
      const created = await createNote(newNoteText.trim(), col);
      setNotes([created, ...notes]);
      setNewNoteText('');
    } catch (err) {
      console.error('Failed to create note:', err);
    }
  };

  const handleMoveNote = async (noteId: string, newCol: Note['column']) => {
    triggerHaptic('light');
    setNotes(notes.map(n => (n.id === noteId ? { ...n, column: newCol } : n)));
    try {
      await updateNote(noteId, { column: newCol });
    } catch (err) {
      console.error('Failed to move note:', err);
      loadNotes();
    }
  };

  const handleSaveNoteText = async (noteId: string, newText: string) => {
    setNotes(prev =>
      prev.map(n => (n.id === noteId ? { ...n, clean_text: newText, raw_text: newText } : n))
    );
    try {
      await updateNote(noteId, { clean_text: newText });
    } catch (err) {
      console.error('Failed to save note text:', err);
      await showAlert(t('tasks.errSaveNote'));
      loadNotes();
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    triggerHaptic('light');
    setNotes(notes.filter(n => n.id !== noteId));
    try {
      await deleteNote(noteId);
      fetchTrash().then(setTrashData).catch(() => {});
    } catch (err) {
      console.error('Failed to delete note:', err);
      loadNotes();
    }
  };

  // --- Trash Handlers ---
  async function loadTrashData() {
    try {
      setTrashLoading(true);
      const data = await fetchTrash();
      setTrashData(data);
    } catch (err) {
      console.error('Failed to load trash:', err);
    } finally {
      setTrashLoading(false);
    }
  }

  const handleOpenTrash = () => {
    triggerHaptic('light');
    setShowTrashModal(true);
    loadTrashData();
  };

  const handleRestoreTrashItem = async (itemType: 'task' | 'note', itemId: string) => {
    triggerHaptic('success');
    setRestoringId(itemId);
    try {
      await restoreTrashItem(itemType, itemId);
      await loadTrashData();
      if (itemType === 'task') {
        const [todoList, doneList] = await Promise.all([
          fetchTasks(undefined, 'todo'),
          fetchTasks(undefined, 'done'),
        ]);
        setTasks(todoList);
        setCompletedTasks(doneList);
      } else {
        await loadNotes();
      }
    } catch (err) {
      console.error('Failed to restore item:', err);
      await showAlert(t('trash.errRestore'));
    } finally {
      setRestoringId(null);
    }
  };

  const handleDeleteTrashItemPermanently = async (itemType: 'task' | 'note', itemId: string) => {
    if (!await showConfirm(t('trash.confirmDelete'))) return;
    triggerHaptic('medium');
    try {
      await deleteTrashItemPermanently(itemType, itemId);
      await loadTrashData();
    } catch (err) {
      console.error('Failed to delete item permanently:', err);
      await showAlert(t('trash.errDelete'));
    }
  };

  const handleEmptyTrash = async () => {
    if (!await showConfirm(t('trash.confirmEmpty'))) return;
    triggerHaptic('medium');
    setIsEmptyingTrash(true);
    try {
      await emptyTrash();
      await loadTrashData();
    } catch (err) {
      console.error('Failed to empty trash:', err);
      await showAlert(t('trash.errEmpty'));
    } finally {
      setIsEmptyingTrash(false);
    }
  };

  const toggleNoteExpanded = (noteId: string) => {
    triggerHaptic('light');
    setExpandedNotes(prev => {
      const next = new Set(prev);
      if (next.has(noteId)) {
        next.delete(noteId);
      } else {
        next.add(noteId);
      }
      return next;
    });
  };

  const handleCopyNote = (text: string, noteId: string) => {
    navigator.clipboard?.writeText(text);
    triggerHaptic('light');
    setCopiedNoteId(noteId);
    setTimeout(() => setCopiedNoteId(null), 1800);
  };

  // Medication handlers
  async function loadMedications() {
    try {
      setMedsLoading(true);
      const data = await fetchMedications();
      setMedications(data);
    } catch (err) {
      console.error('Failed to load medications:', err);
    } finally {
      setMedsLoading(false);
    }
  }

  const handleTakeMed = async (medId: string, scheduledTime: string) => {
    triggerHaptic('success');
    setMedications(prev =>
      prev.map(m => {
        if (m.id !== medId) return m;
        return {
          ...m,
          today_logs: m.today_logs.map(log =>
            log.scheduled_time === scheduledTime
              ? { ...log, status: 'taken', taken_at: new Date().toISOString() }
              : log
          ),
        };
      })
    );
    try {
      await takeMedication(medId, scheduledTime);
      await loadMedications();
    } catch (err) {
      console.error('Failed to mark med as taken:', err);
      loadMedications();
    }
  };

  const handleSkipMed = async (medId: string, scheduledTime: string) => {
    triggerHaptic('light');
    setMedications(prev =>
      prev.map(m => {
        if (m.id !== medId) return m;
        return {
          ...m,
          today_logs: m.today_logs.map(log =>
            log.scheduled_time === scheduledTime ? { ...log, status: 'skipped' } : log
          ),
        };
      })
    );
    try {
      await skipMedication(medId, scheduledTime);
      await loadMedications();
    } catch (err) {
      console.error('Failed to skip med:', err);
      loadMedications();
    }
  };

  const handleCreateMedication = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMedName.trim() || !newMedDosage.trim() || isSubmittingMed) return;
    try {
      setIsSubmittingMed(true);
      const parsedTimes = newMedTimes
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      await createMedication({
        name: newMedName.trim(),
        dosage: newMedDosage.trim(),
        times: parsedTimes.length > 0 ? parsedTimes : ['09:00'],
        instructions: newMedInstructions.trim() || undefined,
      });
      setNewMedName('');
      setNewMedDosage('');
      setNewMedTimes('09:00');
      setNewMedInstructions('');
      setIsAddingMed(false);
      triggerHaptic('success');
      await loadMedications();
    } catch (err) {
      console.error('Failed to create medication:', err);
    } finally {
      setIsSubmittingMed(false);
    }
  };

  const handleDeleteMedication = async (medId: string) => {
    if (!await showConfirm(t('meds.deleteConfirm'))) return;
    triggerHaptic('light');
    setMedications(prev => prev.filter(m => m.id !== medId));
    try {
      await deleteMedication(medId);
    } catch (err) {
      console.error('Failed to delete medication:', err);
      loadMedications();
    }
  };

  // Overdue tasks counter
  const totalOverdueCount = React.useMemo(() => {
    const now = Date.now();
    return tasks.filter(t => {
      if (t.status !== 'todo' || t.item_type === 'event') return false;
      const dueTime = t.due_at ? new Date(t.due_at).getTime() : null;
      const remindTime = t.remind_at ? new Date(t.remind_at).getTime() : null;
      return (dueTime !== null && dueTime < now) || (remindTime !== null && remindTime < now);
    }).length;
  }, [tasks]);

  // Filter & sort tasks
  const processedTasks = React.useMemo(() => {
    const now = Date.now();

    let list = selectedCategory
      ? tasks.filter(t => t.category_name === selectedCategory)
      : [...tasks];

    // Exclude events from regular day groups (events have their dedicated section)
    list = list.filter(t => t.item_type !== 'event');

    if (selectedCategory && selectedSubcategory) {
      list = list.filter(t => t.subcategory_name === selectedSubcategory || t.subcategory_id === selectedSubcategory);
    }

    if (taskFilter === 'overdue') {
      list = list.filter(t => {
        const dueTime = t.due_at ? new Date(t.due_at).getTime() : null;
        const remindTime = t.remind_at ? new Date(t.remind_at).getTime() : null;
        return (dueTime !== null && dueTime < now) || (remindTime !== null && remindTime < now);
      });
    } else if (taskFilter === 'dated') {
      list = list.filter(t => Boolean(t.due_at || t.remind_at));
    } else if (taskFilter === 'recurring') {
      list = list.filter(t => Boolean(t.recurrence));
    }

    return [...list].sort((a, b) => {
      const aDueTime = a.due_at ? new Date(a.due_at).getTime() : null;
      const aRemindTime = a.remind_at ? new Date(a.remind_at).getTime() : null;
      const aTargetTime = aDueTime ?? aRemindTime;
      const aIsOverdue = (aDueTime !== null && aDueTime < now) || (aRemindTime !== null && aRemindTime < now);

      const bDueTime = b.due_at ? new Date(b.due_at).getTime() : null;
      const bRemindTime = b.remind_at ? new Date(b.remind_at).getTime() : null;
      const bTargetTime = bDueTime ?? bRemindTime;
      const bIsOverdue = (bDueTime !== null && bDueTime < now) || (bRemindTime !== null && bRemindTime < now);

      if (taskSort === 'smart') {
        if (aIsOverdue && !bIsOverdue) return -1;
        if (!aIsOverdue && bIsOverdue) return 1;
        if (aIsOverdue && bIsOverdue) {
          if (aTargetTime !== null && bTargetTime !== null) {
            return aTargetTime - bTargetTime;
          }
        }

        if (aTargetTime !== null && bTargetTime === null) return -1;
        if (aTargetTime === null && bTargetTime !== null) return 1;
        if (aTargetTime !== null && bTargetTime !== null) {
          return aTargetTime - bTargetTime;
        }

        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }

      if (taskSort === 'due_date') {
        if (aTargetTime !== null && bTargetTime === null) return -1;
        if (aTargetTime === null && bTargetTime !== null) return 1;
        if (aTargetTime !== null && bTargetTime !== null) {
          return aTargetTime - bTargetTime;
        }
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }

      if (taskSort === 'created_desc') {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }

      if (taskSort === 'created_asc') {
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }

      if (taskSort === 'alpha') {
        return a.title.localeCompare(b.title, LOCALE_BCP47[locale] || 'ru-RU');
      }

      return 0;
    });
  }, [tasks, selectedCategory, selectedSubcategory, taskFilter, taskSort, locale]);

  const taskDayGroups = React.useMemo(() => {
    return groupTasksByDay(processedTasks, Date.now(), locale);
  }, [processedTasks, locale]);

  const activeEvents = React.useMemo(() => {
    let list = tasks.filter(t => t.status === 'todo' && t.item_type === 'event');
    if (selectedCategory) {
      list = list.filter(t => t.category_name === selectedCategory);
    }
    if (selectedCategory && selectedSubcategory) {
      list = list.filter(t => t.subcategory_name === selectedSubcategory || t.subcategory_id === selectedSubcategory);
    }
    return list.sort((a, b) => {
      const aT = a.due_at ? new Date(a.due_at).getTime() : 0;
      const bT = b.due_at ? new Date(b.due_at).getTime() : 0;
      return aT - bT;
    });
  }, [tasks, selectedCategory, selectedSubcategory]);

  const filteredNotes = React.useMemo(() => {
    return notes
      .filter(n => (!selectedNoteCol ? true : n.column === selectedNoteCol))
      .filter(n => {
        if (!noteSearch.trim()) return true;
        const s = noteSearch.toLowerCase();
        return (
          n.raw_text.toLowerCase().includes(s) ||
          Boolean(n.clean_text && n.clean_text.toLowerCase().includes(s))
        );
      });
  }, [notes, selectedNoteCol, noteSearch]);

  const filteredLiabilities = React.useMemo(() => {
    if (!activeLiabilityQueue) return liabilities;
    return liabilities.filter(l => l.queue === activeLiabilityQueue);
  }, [liabilities, activeLiabilityQueue]);

  const filteredDocChapters = React.useMemo(() => {
    if (!docSearchQuery.trim()) return docChapters;
    const q = docSearchQuery.trim().toLowerCase();
    return docChapters.filter(
      ch =>
        ch.title.toLowerCase().includes(q) ||
        ch.summary.toLowerCase().includes(q) ||
        Boolean(ch.content && ch.content.toLowerCase().includes(q)) ||
        findDocSectionMatches(ch, q).length > 0
    );
  }, [docChapters, docSearchQuery]);

  const displayedNotesForReader = React.useMemo(() => {
    return selectedNoteCol === null
      ? filteredNotes.filter(n => n.column !== 'archive')
      : filteredNotes;
  }, [filteredNotes, selectedNoteCol]);

  const activeReaderNoteIndex = React.useMemo(() => {
    if (!activeReaderNoteId) return -1;
    return displayedNotesForReader.findIndex(n => n.id === activeReaderNoteId);
  }, [displayedNotesForReader, activeReaderNoteId]);

  const activeReaderNote = React.useMemo(() => {
    if (!activeReaderNoteId) return null;
    return notes.find(n => n.id === activeReaderNoteId) || null;
  }, [notes, activeReaderNoteId]);

  const activeDocIndex = React.useMemo(() => {
    if (!selectedChapterSlug) return -1;
    const list = filteredDocChapters.length > 0 ? filteredDocChapters : docChapters;
    return list.findIndex(c => c.slug === selectedChapterSlug);
  }, [filteredDocChapters, docChapters, selectedChapterSlug]);

  const activeDocList = filteredDocChapters.length > 0 ? filteredDocChapters : docChapters;

  const activeDocChapter = React.useMemo(() => {
    if (!selectedChapterSlug) return null;
    if (chapterDetail && chapterDetail.slug === selectedChapterSlug) {
      return chapterDetail;
    }
    return docChapters.find(c => c.slug === selectedChapterSlug) || null;
  }, [selectedChapterSlug, chapterDetail, docChapters]);

  interface BankAccountGroup {
    name: string;
    total_eur: number;
    subAccounts: {
      id: string;
      currency: string;
      balance: number;
      balance_eur: number;
      envelope?: 'spendable' | 'reserved';
    }[];
  }

  const getAccountThemeClass = (name: string) => {
    const lower = name.toLowerCase();
    for (const rule of uiConfig.miniapp.accountThemes) {
      if (rule.pattern && lower.includes(rule.pattern.toLowerCase())) {
        return `account-theme-${rule.theme}`;
      }
    }
    if (/card|карт|kartic|カード/i.test(lower)) return 'account-theme-primary';
    if (/saving|накоп|šted|貯蓄/i.test(lower)) return 'account-theme-secondary';
    if (/crypto|крипт|kripto|暗号/i.test(lower)) return 'account-theme-accent';
    if (/cash|налич|gotov|現金/i.test(lower)) return 'account-theme-neutral';
    return '';
  };

  const groupedAccounts = React.useMemo(() => {
    const map = new Map<string, BankAccountGroup>();
    for (const acc of accounts) {
      if (!map.has(acc.name)) {
        map.set(acc.name, {
          name: acc.name,
          total_eur: 0,
          subAccounts: [],
        });
      }
      const grp = map.get(acc.name)!;
      grp.total_eur += acc.balance_eur;
      grp.subAccounts.push({
        id: acc.id,
        currency: acc.currency,
        balance: acc.current_balance,
        balance_eur: acc.balance_eur,
        envelope: acc.envelope,
      });
    }
    return Array.from(map.values());
  }, [accounts]);

  if (loading) {
    return (
      <div className="empty-state" style={{ paddingTop: 100 }}>
        <Sparkles size={32} color="var(--accent-color)" />
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  if (loadError && categories.length === 0 && tasks.length === 0) {
    return (
      <div className="empty-state" style={{ paddingTop: 80, paddingLeft: 24, paddingRight: 24, textAlign: 'center' }}>
        <WifiOff size={36} color="var(--text-muted)" />
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t('errors.connectionError')}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginBottom: 20, maxWidth: 300, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {loadError.includes('401') || loadError.includes('403') || loadError.includes('Authorization')
            ? t('errors.authErrorHint', { error: loadError })
            : loadError}
        </p>
        <button
          className="btn-primary"
          onClick={() => loadInitialData()}
          style={{ padding: '10px 24px', fontSize: 14, borderRadius: 10 }}
        >
          <RotateCcw size={15} />
          <span>{t('common.retry')}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="app-container">
      {dataSource !== 'live' && (
        <div className="stale-data-banner" role="status">
          <WifiOff size={14} />
          <span>
            {dataSource === 'cache'
              ? t('errors.staleCacheBanner')
              : t('errors.staleFallbackBanner')}
          </span>
        </div>
      )}
      {/* Header */}
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <Compass size={18} strokeWidth={1.75} />
          </div>
          <span className="brand-title">{uiConfig.brand.assistantName}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            className="btn-icon"
            onClick={handleOpenTrash}
            title={t('header.trash')}
            aria-label={t('header.openTrash')}
            style={{ position: 'relative' }}
          >
            <Trash2 size={17} strokeWidth={1.75} />
            {trashData && trashData.total_count > 0 && (
              <span className="header-badge tabular-nums">{trashData.total_count}</span>
            )}
          </button>

          {uiConfig.features.calmModeUi && (
            <button
              className={`btn-icon ${lowStimulation ? 'active' : ''}`}
              onClick={toggleLowStimulation}
              title={lowStimulation ? t('header.calmModeOn') : t('header.calmModeOff')}
              aria-label={lowStimulation ? t('header.switchCalmOff') : t('header.switchCalmOn')}
            >
              {lowStimulation ? <EyeOff size={18} strokeWidth={1.75} /> : <Eye size={18} strokeWidth={1.75} />}
            </button>
          )}
        </div>
      </header>

      {/* Navigation Tabs (5 Stacked Mobile Tabs) */}
      <nav className="nav-tabs" role="tablist" aria-label={t('nav.mainNav')}>
        <button
          role="tab"
          aria-selected={activeTab === 'today'}
          className={`nav-tab ${activeTab === 'today' ? 'active' : ''}`}
          onClick={() => { triggerHaptic('light'); setActiveTab('today'); }}
        >
          <Compass size={17} strokeWidth={1.75} />
          <span>{t('nav.today')}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'tasks'}
          className={`nav-tab ${activeTab === 'tasks' ? 'active' : ''}`}
          onClick={() => { triggerHaptic('light'); setActiveTab('tasks'); }}
        >
          <ListTodo size={17} strokeWidth={1.75} />
          <span>{t('nav.tasks')}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'finances'}
          className={`nav-tab ${activeTab === 'finances' ? 'active' : ''}`}
          onClick={() => { triggerHaptic('light'); setActiveTab('finances'); }}
        >
          <Wallet size={17} strokeWidth={1.75} />
          <span>{t('nav.finances')}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'notes'}
          className={`nav-tab ${activeTab === 'notes' ? 'active' : ''}`}
          onClick={() => { triggerHaptic('light'); setActiveTab('notes'); }}
        >
          <FileText size={17} strokeWidth={1.75} />
          <span>{t('nav.notes')}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'assistant'}
          className={`nav-tab ${activeTab === 'assistant' ? 'active' : ''}`}
          onClick={() => { triggerHaptic('light'); setActiveTab('assistant'); }}
        >
          <Brain size={17} strokeWidth={1.75} />
          <span>{t('nav.system')}</span>
        </button>
      </nav>

      {/* TAB: TODAY */}
      {activeTab === 'today' && (
        <TodayTab
          tasks={tasks}
          runway={runway}
          liabilities={liabilities}
          handleToggleTask={handleToggleTask}
          handleToggleStep={handleToggleStep}
          onQuickCapture={handleQuickCapture}
          onNavigateTab={(tab) => {
            triggerHaptic('light');
            setActiveTab(tab);
          }}
          triggerHaptic={triggerHaptic}
          baseCurrency={userSettings?.base_currency}
          reserveAmount={uiConfig.finance.reserveAmount}
        />
      )}

      {/* TAB: TASKS */}
      {activeTab === 'tasks' && (
        <TasksTab
          tasks={tasks}
          categories={categories}
          selectedCategory={selectedCategory}
          setSelectedCategory={setSelectedCategory}
          selectedSubcategory={selectedSubcategory}
          setSelectedSubcategory={setSelectedSubcategory}
          setNewTaskCat={setNewTaskCat}
          setNewTaskSubcat={setNewTaskSubcat}
          isAddingCat={isAddingCat}
          setIsAddingCat={setIsAddingCat}
          newCatName={newCatName}
          setNewCatName={setNewCatName}
          handleAddCategory={handleAddCategory}
          handleCreateTask={handleCreateTask}
          isTaskFormExpanded={isTaskFormExpanded}
          setIsTaskFormExpanded={setIsTaskFormExpanded}
          newTaskTitle={newTaskTitle}
          setNewTaskTitle={setNewTaskTitle}
          isSubmittingTask={isSubmittingTask}
          newTaskCat={newTaskCat}
          newTaskSubcat={newTaskSubcat}
          showSteps={showSteps}
          setShowSteps={setShowSteps}
          steps={steps}
          setSteps={setSteps}
          totalOverdueCount={totalOverdueCount}
          taskFilter={taskFilter}
          setTaskFilter={setTaskFilter}
          taskSort={taskSort}
          setTaskSort={setTaskSort}
          processedTasks={processedTasks}
          taskDayGroups={taskDayGroups}
          expandedTasks={expandedTasks}
          toggleTaskExpanded={toggleTaskExpanded}
          handleToggleTask={handleToggleTask}
          handleDeleteTask={handleDeleteTask}
          handleToggleStep={handleToggleStep}
          handleRescheduleTaskToday={handleRescheduleTaskToday}
          activeInlineDay={activeInlineDay}
          setActiveInlineDay={setActiveInlineDay}
          inlineTaskText={inlineTaskText}
          setInlineTaskText={setInlineTaskText}
          isSubmittingInline={isSubmittingInline}
          handleCreateInlineTask={handleCreateInlineTask}
          completedTasks={completedTasks}
          showCompleted={showCompleted}
          setShowCompleted={setShowCompleted}
          triggerHaptic={triggerHaptic}
          activeEvents={activeEvents}
          newTaskItemType={newTaskItemType}
          setNewTaskItemType={setNewTaskItemType}
          handleToggleItemType={handleToggleItemType}
        />
      )}

      {/* TAB: FINANCES */}
      {activeTab === 'finances' && (
        <FinancesTab
          finLoading={finLoading}
          accounts={accounts}
          finSummary={finSummary}
          runway={runway}
          groupedAccounts={groupedAccounts}
          activeBankName={activeBankName}
          setActiveBankName={setActiveBankName}
          getAccountThemeClass={getAccountThemeClass}
          triggerHaptic={triggerHaptic}
          liabilities={liabilities}
          activeLiabilityQueue={activeLiabilityQueue}
          setActiveLiabilityQueue={setActiveLiabilityQueue}
          filteredLiabilities={filteredLiabilities}
          updateLiability={updateLiability}
          loadFinances={loadFinances}
          showAlert={showAlert}
          showConfirm={showConfirm}
          payLiability={payLiability}
          budgetModalCategory={budgetModalCategory}
          setBudgetModalCategory={setBudgetModalCategory}
          budgetLimitInput={budgetLimitInput}
          setBudgetLimitInput={setBudgetLimitInput}
          handleSaveBudget={handleSaveBudget}
          transactions={transactions}
          undoLastTransaction={undoLastTransaction}
          resetFinances={resetFinances}
          baseCurrency={userSettings?.base_currency}
          reserveAmount={uiConfig.finance.reserveAmount}
          accountThemes={uiConfig.miniapp.accountThemes}
        />
      )}

      {/* TAB: NOTES (ИНБОКС & ВТОРОЙ МОЗГ) */}
      {activeTab === 'notes' && (
        <NotesTab
          notesLoading={notesLoading}
          notes={notes}
          selectedNoteCol={selectedNoteCol}
          setSelectedNoteCol={setSelectedNoteCol}
          triggerHaptic={triggerHaptic}
          noteColumns={noteColumns}
          newNoteText={newNoteText}
          setNewNoteText={setNewNoteText}
          handleCreateNote={handleCreateNote}
          noteSearch={noteSearch}
          setNoteSearch={setNoteSearch}
          filteredNotes={filteredNotes}
          expandedNotes={expandedNotes}
          toggleNoteExpanded={toggleNoteExpanded}
          copiedNoteId={copiedNoteId}
          handleCopyNote={handleCopyNote}
          handleDeleteNote={handleDeleteNote}
          handleMoveNote={handleMoveNote}
          handleConvertNoteToTask={handleConvertNoteToTask}
          onOpenNoteReader={n => setActiveReaderNoteId(n.id)}
        />
      )}

      {/* TAB: SYSTEM (ДИРЕКТИВЫ, АПТЕЧКА, ДОСЬЕ, ДОКУМЕНТАЦИЯ) */}
      {activeTab === 'assistant' && (
        <SystemTab
          personaPresets={personaPresets}
          personaStyle={personaStyle}
          setPersonaStyle={setPersonaStyle}
          customInstructions={customInstructions}
          setCustomInstructions={setCustomInstructions}
          isSavingDirectives={isSavingDirectives}
          directivesSavedMsg={directivesSavedMsg}
          handleSaveDirectives={handleSaveDirectives}
          suggestedQuestions={suggestedQuestions}
          copiedPromptIndex={copiedPromptIndex}
          handleCopyPrompt={handleCopyPrompt}
          loadingContext={loadingContext}
          lifeContext={lifeContext}
          contextDepth={contextDepth}
          setContextDepth={setContextDepth}
          loadAssistantData={loadAssistantData}
          loadingDocs={loadingDocs}
          loadDocsData={loadDocsData}
          docSearchQuery={docSearchQuery}
          setDocSearchQuery={setDocSearchQuery}
          filteredDocChapters={filteredDocChapters}
          docChapters={docChapters}
          selectedChapterSlug={selectedChapterSlug}
          handleToggleChapter={handleToggleChapter}
          loadingChapterDetail={loadingChapterDetail}
          chapterDetail={chapterDetail}
          onOpenDossierReader={() => setShowDossierReader(true)}
          triggerHaptic={triggerHaptic}
          medications={medications}
          medsLoading={medsLoading}
          isAddingMed={isAddingMed}
          setIsAddingMed={setIsAddingMed}
          newMedName={newMedName}
          setNewMedName={setNewMedName}
          newMedDosage={newMedDosage}
          setNewMedDosage={setNewMedDosage}
          newMedTimes={newMedTimes}
          setNewMedTimes={setNewMedTimes}
          newMedInstructions={newMedInstructions}
          setNewMedInstructions={setNewMedInstructions}
          isSubmittingMed={isSubmittingMed}
          handleCreateMedication={handleCreateMedication}
          handleTakeMed={handleTakeMed}
          handleSkipMed={handleSkipMed}
          handleDeleteMedication={handleDeleteMedication}
          userSettings={userSettings}
          onReloadSettings={loadInitialData}
          assistantName={uiConfig.brand.assistantName}
          backupPrefix={uiConfig.brand.backupPrefix}
          feedbackEnabled={uiConfig.features.feedbackEnabled}
        />
      )}

      {/* UNIFIED FULL-SCREEN READER SHEET (NOTES, DOCS, DOSSIER) */}
      {activeReaderNote && (
        <ReaderSheet
          mode="note"
          onClose={() => setActiveReaderNoteId(null)}
          triggerHaptic={triggerHaptic}
          fontScale={readerFontScale}
          onChangeFontScale={handleChangeFontScale}
          note={activeReaderNote}
          noteColumns={noteColumns}
          onMoveNote={handleMoveNote}
          onConvertNoteToTask={handleConvertNoteToTask}
          onDeleteNote={handleDeleteNote}
          onSaveNoteText={handleSaveNoteText}
          onPrevNote={
            activeReaderNoteIndex > 0
              ? () => setActiveReaderNoteId(displayedNotesForReader[activeReaderNoteIndex - 1].id)
              : null
          }
          onNextNote={
            activeReaderNoteIndex >= 0 &&
            activeReaderNoteIndex < displayedNotesForReader.length - 1
              ? () => setActiveReaderNoteId(displayedNotesForReader[activeReaderNoteIndex + 1].id)
              : null
          }
          notePositionLabel={
            activeReaderNoteIndex >= 0
              ? `${activeReaderNoteIndex + 1} / ${displayedNotesForReader.length}`
              : undefined
          }
        />
      )}

      {selectedChapterSlug && (
        <ReaderSheet
          mode="doc"
          onClose={() => {
            setSelectedChapterSlug(null);
            setInitialDocSectionTitle(null);
            setChapterDetail(null);
          }}
          triggerHaptic={triggerHaptic}
          fontScale={readerFontScale}
          onChangeFontScale={handleChangeFontScale}
          docChapter={activeDocChapter}
          loadingDocDetail={loadingChapterDetail}
          initialSectionTitle={initialDocSectionTitle}
          onSelectDocChapter={(slug, secTitle) => handleToggleChapter(slug, secTitle)}
          onPrevDoc={
            activeDocIndex > 0
              ? () => handleToggleChapter(activeDocList[activeDocIndex - 1].slug)
              : null
          }
          onNextDoc={
            activeDocIndex >= 0 && activeDocIndex < activeDocList.length - 1
              ? () => handleToggleChapter(activeDocList[activeDocIndex + 1].slug)
              : null
          }
          docPositionLabel={
            activeDocIndex >= 0 ? `${activeDocIndex + 1} / ${activeDocList.length}` : undefined
          }
        />
      )}

      {showDossierReader && (
        <ReaderSheet
          mode="dossier"
          onClose={() => setShowDossierReader(false)}
          triggerHaptic={triggerHaptic}
          fontScale={readerFontScale}
          onChangeFontScale={handleChangeFontScale}
          dossierContent={lifeContext}
          onRefreshDossier={() => loadAssistantData(contextDepth)}
          loadingDossier={loadingContext}
        />
      )}

      {/* TRASH MODAL OVERLAY */}
      {showTrashModal && (
        <div className="trash-modal-overlay" onClick={() => setShowTrashModal(false)}>
          <div className="trash-modal" onClick={e => e.stopPropagation()}>
            <div className="trash-modal-header">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Trash2 size={20} color="var(--accent-color)" />
                  <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{t('trash.title')}</h3>
                  {trashData && trashData.total_count > 0 && (
                    <span className="trash-count-pill tabular-nums">{trashData.total_count}</span>
                  )}
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>
                  {t('trash.retentionHint')}
                </p>
              </div>
              <button
                className="btn-icon"
                onClick={() => setShowTrashModal(false)}
                aria-label={t('trash.closeAria')}
                style={{ width: 32, height: 32, borderRadius: 8 }}
              >
                <X size={16} />
              </button>
            </div>

            <div className="trash-tabs-bar">
              <button
                className={`trash-tab-btn ${trashTab === 'all' ? 'active' : ''}`}
                onClick={() => { triggerHaptic('light'); setTrashTab('all'); }}
              >
                {t('trash.tabAll', { count: trashData?.total_count || 0 })}
              </button>
              <button
                className={`trash-tab-btn ${trashTab === 'tasks' ? 'active' : ''}`}
                onClick={() => { triggerHaptic('light'); setTrashTab('tasks'); }}
              >
                {t('trash.tabTasks', { count: trashData?.tasks.length || 0 })}
              </button>
              <button
                className={`trash-tab-btn ${trashTab === 'notes' ? 'active' : ''}`}
                onClick={() => { triggerHaptic('light'); setTrashTab('notes'); }}
              >
                {t('trash.tabNotes', { count: trashData?.notes.length || 0 })}
              </button>
            </div>

            <div className="trash-items-scroll">
              {trashLoading && !trashData ? (
                <div className="trash-empty-state">
                  <Sparkles size={24} color="var(--accent-color)" />
                  <span style={{ fontSize: 13.5 }}>{t('trash.loading')}</span>
                </div>
              ) : (!trashData || trashData.total_count === 0) ? (
                <div className="trash-empty-state">
                  <Trash2 size={28} color="var(--text-muted)" />
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{t('trash.emptyTitle')}</div>
                  <div style={{ fontSize: 12.5, maxWidth: 280 }}>
                    {t('trash.emptyDesc')}
                  </div>
                </div>
              ) : (
                <>
                  {(trashTab === 'all' || trashTab === 'tasks') &&
                    trashData.tasks.map(tr => (
                      <div key={`task-${tr.id}`} className="trash-item-card">
                        <div className="trash-item-header">
                          <div className="trash-item-title">{tr.title}</div>
                          <div className="trash-item-actions">
                            <button
                              className="btn-trash-restore"
                              disabled={restoringId === tr.id}
                              onClick={() => handleRestoreTrashItem('task', tr.id)}
                              title={t('trash.restoreTask')}
                            >
                              <RotateCcw size={12} />
                              <span>{restoringId === tr.id ? '...' : t('trash.restoreBtn')}</span>
                            </button>
                            <button
                              className="btn-trash-delete"
                              onClick={() => handleDeleteTrashItemPermanently('task', tr.id)}
                              title={t('trash.deleteForever')}
                              aria-label={t('trash.deleteTaskForever')}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>

                        {tr.notes && <div className="trash-item-body">{tr.notes}</div>}

                        <div className="trash-item-meta">
                          <div className="trash-meta-badges">
                            <span className="trash-badge-tag">{tr.category_name}</span>
                            {tr.steps_count > 0 && (
                              <span className="trash-badge-tag tabular-nums">{t('trash.stepsCount', { count: tr.steps_count })}</span>
                            )}
                          </div>
                          <div className="trash-badge-time tabular-nums">
                            <Clock size={11} />
                            <span>{t('trash.daysRemaining', { days: tr.days_remaining })}</span>
                          </div>
                        </div>
                      </div>
                    ))}

                  {(trashTab === 'all' || trashTab === 'notes') &&
                    trashData.notes.map(n => {
                      const displaySnippet = n.clean_text || n.raw_text;
                      return (
                        <div key={`note-${n.id}`} className="trash-item-card">
                          <div className="trash-item-header">
                            <div className="trash-item-title" style={{ fontWeight: 500 }}>
                              {displaySnippet.length > 120 ? `${displaySnippet.slice(0, 120)}...` : displaySnippet}
                            </div>
                            <div className="trash-item-actions">
                              <button
                                className="btn-trash-restore"
                                disabled={restoringId === n.id}
                                onClick={() => handleRestoreTrashItem('note', n.id)}
                                title={t('trash.restoreNote')}
                              >
                                <RotateCcw size={12} />
                                <span>{restoringId === n.id ? '...' : t('trash.restoreBtn')}</span>
                              </button>
                              <button
                                className="btn-trash-delete"
                                onClick={() => handleDeleteTrashItemPermanently('note', n.id)}
                                title={t('trash.deleteForever')}
                                aria-label={t('trash.deleteNoteForever')}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>

                          <div className="trash-item-meta">
                            <div className="trash-meta-badges">
                              <span className="trash-badge-tag">{t('trash.columnLabel', { column: n.column })}</span>
                            </div>
                            <div className="trash-badge-time tabular-nums">
                              <Clock size={11} />
                              <span>{t('trash.daysRemaining', { days: n.days_remaining })}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                </>
              )}
            </div>

            {trashData && trashData.total_count > 0 && (
              <div style={{ paddingTop: 4 }}>
                <button
                  className="btn-danger-outline"
                  onClick={handleEmptyTrash}
                  disabled={isEmptyingTrash}
                >
                  <Trash2 size={14} />
                  <span>{isEmptyingTrash ? t('trash.emptyingBtn') : t('trash.emptyAllBtn')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 30-SECOND ONBOARDING MODAL */}
      {uiConfig.features.onboardingWizard && userSettings && userSettings.onboarded === false && (
        <OnboardingModal
          initialSettings={userSettings}
          assistantName={uiConfig.brand.assistantName}
          triggerHaptic={triggerHaptic}
          onComplete={async (updated) => {
            setUserSettings(updated);
            if (updated.custom_instructions) {
              setCustomInstructions(updated.custom_instructions);
            }
            if (updated.persona_style) {
              setPersonaStyle(updated.persona_style);
            }
            setLowStimulation(updated.low_stimulation_mode);
            await loadInitialData();
            await loadFinances();
          }}
        />
      )}
    </div>
  );
}

export default App;
