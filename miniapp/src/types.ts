export interface Step {
  id?: string;
  title: string;
  status: 'todo' | 'done';
  position: number;
}

export interface StepUpdateResponse {
  status: string;
  id?: string;
  title?: string;
  next_task_id?: string | null;
  next_occurrence?: string | null;
}

export interface TelegramUser {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface TelegramWebAppInitData {
  query_id?: string;
  user?: TelegramUser;
  receiver?: TelegramUser;
  chat?: {
    id: number;
    type: string;
    title: string;
    username?: string;
    photo_url?: string;
  };
  start_param?: string;
  can_send_after?: number;
  auth_date?: number;
  hash?: string;
}

export interface Subcategory {
  id: string;
  category_id: string;
  name: string;
  position: number;
}

export interface Task {
  id: string;
  title: string;
  status: 'todo' | 'done' | 'archived';
  item_type?: 'task' | 'event';
  notes?: string;
  category_id?: string;
  category_name?: string;
  subcategory_id?: string;
  subcategory_name?: string;
  steps: Step[];
  created_at: string;
  due_at?: string | null;
  remind_at?: string | null;
  recurrence?: string | null;
}

export interface Category {
  id: string;
  name: string;
  color?: string;
  position: number;
  subcategories?: Subcategory[];
}

export interface UserPrefsSummary {
  has_overrides: boolean;
  history_count: number;
  ai: {
    preferred_model: string | null;
    max_steps: number | null;
    temperature: number | null;
  };
  adhd: {
    overload_shield_enabled: boolean;
    overload_overdue_threshold: number | null;
    overload_active_todo_threshold: number | null;
    overload_night_window: string | null;
    focus_limit: number | null;
    stale_after_days: number | null;
  };
  finance: {
    reserve_eur: number;
    aliases_count: number;
    default_accounts_count: number;
    has_runway_overrides: boolean;
  };
  diary: {
    has_overrides: boolean;
    include_tasks: boolean;
    sections_count: number;
    header_template: string | null;
  };
  proactive: {
    quiet_hours_enabled: boolean;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    disabled_jobs: string[];
  };
  brain: {
    custom_personas_count: number;
    disabled_builtin_skills: string[];
  };
  miniapp: {
    tabs: string[] | null;
    account_themes_count: number;
  };
}

export interface CustomPersonaSummary {
  id: string;
  name: string;
  description: string;
}

export interface SettingsPresetItem {
  id: string;
  name: string;
  description?: string;
  updated_at: string;
}

export interface CustomRoutineItem {
  id: string;
  name: string;
  enabled: boolean;
  kind: 'text' | 'summary' | 'ai';
  schedule: 'daily' | 'weekly' | 'monthly';
  time: string;
  weekdays?: number[];
  day_of_month?: number;
  summary_kind?: string;
  tool_access?: 'read-only' | 'allow_writes';
  respect_quiet_hours: boolean;
}

export interface UserSettings {
  name?: string;
  language?: 'ru' | 'en' | 'sr' | 'ja';
  base_currency: string;
  timezone: string;
  summary_time?: string;
  low_stimulation_mode: boolean;
  custom_instructions: string;
  persona_style: string;
  model_provider?: string;
  role?: 'admin' | 'user';
  onboarded?: boolean;
  daily_msg_limit?: number;
  daily_msg_used?: number;
  has_byok_key?: boolean;
  assistant_name?: string | null;
  prefs_summary?: UserPrefsSummary;
  custom_personas?: CustomPersonaSummary[];
  presets?: SettingsPresetItem[];
  routines?: CustomRoutineItem[];
}

export interface RoutineToggleResponse {
  ok: boolean;
  routine_id: string;
  enabled: boolean;
  settings: UserSettings;
}

export interface PresetApplyResponse {
  ok: boolean;
  preset_id: string;
  preset_name: string;
  diff: string;
  settings: UserSettings;
}

export interface SettingsResetResponse {
  ok: boolean;
  section: string;
  diff: string;
  settings: UserSettings;
}

export interface SettingsRollbackResponse {
  ok: boolean;
  restored_summary: string | null;
  remaining_history: number;
  diff: string;
  settings: UserSettings;
}

export interface UiConfigAccountTheme {
  pattern: string;
  theme: 'primary' | 'secondary' | 'accent' | 'neutral';
  shortName?: string;
  roleLabel?: string;
}

export interface UiConfigAccountAlias {
  account: string;
  patterns: string[];
}

export interface UiConfigCustomPersona {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

export interface UiConfigAdhd {
  focusLimit: number | null;
  staleAfterDays: number | null;
  overloadShieldEnabled: boolean;
}

export interface UiConfigSummary {
  activeRoutinesCount: number;
  totalRoutinesCount: number;
  presetsCount: number;
}

export interface UiConfig {
  brand: {
    assistantName: string;
    backupPrefix: string;
    supportContact: string;
  };
  features: {
    feedbackEnabled: boolean;
    calmModeUi: boolean;
    onboardingWizard: boolean;
  };
  finance: {
    reserveAmount: number;
    accountAliases?: UiConfigAccountAlias[];
    defaultAccountByCurrency?: Record<string, string>;
  };
  miniapp: {
    tabs: string[];
    accountThemes: UiConfigAccountTheme[];
  };
  adhd?: UiConfigAdhd;
  personas?: UiConfigCustomPersona[];
  summary?: UiConfigSummary;
}

export interface AccessInfo {
  role?: 'admin' | 'user';
  is_approved?: boolean;
  onboarded?: boolean;
  daily_msg_limit?: number;
  daily_msg_used?: number;
  has_byok_key?: boolean;
  model_provider?: string;
}

export interface OnboardingPayload {
  name: string;
  base_currency: string;
  timezone: string;
  persona_style: string;
  starter_accounts: string[]; // subset of ['card', 'cash', 'crypto']
}

export interface AdminUserItem {
  telegram_id: number;
  name: string;
  role: 'admin' | 'user';
  is_approved: boolean;
  onboarded: boolean;
  base_currency: string;
  daily_msg_limit: number;
  daily_msg_used: number;
  total_cost_usd: number;
  created_at: string | null;
}

export interface AdminInviteItem {
  code: string;
  note: string;
  max_uses: number;
  uses_count: number;
  used_by: number | null;
  bot_link: string;
  created_at: string | null;
}

export interface AdminDashboardData {
  users: AdminUserItem[];
  invites: AdminInviteItem[];
}

export interface Account {
  id: string;
  name: string;
  currency: string;
  current_balance: number;
  balance_eur: number;
  is_active: boolean;
  envelope?: 'spendable' | 'reserved';
}

export interface CreateAccountPayload {
  name: string;
  currency: string;
  current_balance?: number;
  envelope?: 'spendable' | 'reserved';
}

export interface UpdateAccountPayload {
  name?: string;
  currency?: string;
  current_balance?: number;
  is_active?: boolean;
  envelope?: 'spendable' | 'reserved';
}

export interface BackupRestoreResponse {
  status: string;
  restored?: Record<string, number>;
  message?: string;
}

export interface CategorySpending {
  category_id?: string;
  category_name: string;
  spent_eur: number;
  limit_eur?: number | null;
  percent_used?: number | null;
}

export interface FinanceSummary {
  total_net_worth_eur: number;
  month: string;
  total_spent_eur: number;
  total_income_eur: number;
  total_budgeted_eur?: number;
  total_budgeted_spent_eur?: number;
  categories: CategorySpending[];
}

export interface EnvelopeStatus {
  envelope_id: string;
  name: string;
  role: string;
  currency: string;
  current_balance_eur: number;
  required_reserve_eur: number;
  deficit_eur: number;
  coverage_ratio: number;
  status: 'green' | 'yellow' | 'red';
}

export interface RunwayInfo {
  spendable_eur: number;
  reserved_eur: number;
  pending_debt_horizon_eur: number;
  reserved_gap_eur: number;
  horizon_days: number;
  safe_daily_spend_eur: number;
  runway_days: number;
  total_liquid_eur?: number;
  true_free_cash_eur?: number;
  total_monthly_obligations_eur?: number;
  cash_reserve_eur?: number;
  envelopes?: EnvelopeStatus[];
}

export interface TransactionItem {
  id: string;
  occurred_at: string;
  kind: 'expense' | 'income' | 'transfer' | 'exchange';
  amount: number;
  currency: string;
  amount_eur: number;
  fx_rate: number;
  account_name: string;
  to_account_name?: string | null;
  category_name?: string | null;
  description?: string | null;
}

export interface Liability {
  id: string;
  name: string;
  queue: 'bank' | 'queue_1' | 'queue_2' | 'queue_3' | 'investors';
  amount: number;
  currency: string;
  amount_eur: number;
  monthly_payment?: number | null;
  monthly_payment_eur?: number | null;
  payment_day?: number | null;
  total_payments?: number | null;
  end_date?: string | null;
  notes?: string | null;
  is_active: boolean;
  paid_months?: string[];
  is_paid_this_month?: boolean;
  last_payment_date?: string | null;
  account_id?: string | null;
  account_name?: string | null;
}

export interface Note {
  id: string;
  raw_text: string;
  clean_text?: string | null;
  column: 'raw' | 'todo' | 'note' | 'idea' | 'archive';
  created_at: string;
  updated_at: string;
}

export interface DiaryEntrySummary {
  date: string;
  preview: string;
  energy: string | null;
}

export interface DiaryEntryDetail {
  date: string;
  content: string;
}

export interface MedicationTodayLog {
  scheduled_time: string;
  status: 'taken' | 'skipped' | 'pending';
  taken_at?: string | null;
}

export interface Medication {
  id: string;
  name: string;
  dosage: string;
  times: string[];
  frequency: string;
  instructions?: string | null;
  is_active: boolean;
  today_logs: MedicationTodayLog[];
}

export interface DocSection {
  chapter_slug: string;
  chapter_title: string;
  section_title: string;
  level: number;
  content: string;
}

export interface DocChapterSummary {
  slug: string;
  filename: string;
  title: string;
  summary: string;
  sections_count: number;
  content?: string;
  sections?: DocSection[];
}

export type ReaderFontScale = 'normal' | 'large' | 'xlarge';

export interface DocChapterDetail {
  slug: string;
  filename: string;
  title: string;
  summary: string;
  content: string;
  sections: DocSection[];
}

export interface TrashTaskItem {
  id: string;
  title: string;
  notes?: string | null;
  status: string;
  category_id?: string | null;
  category_name: string;
  steps_count: number;
  created_at: string | null;
  deleted_at: string | null;
  days_remaining: number;
}

export interface TrashNoteItem {
  id: string;
  raw_text: string;
  clean_text?: string | null;
  column: string;
  created_at: string | null;
  deleted_at: string | null;
  days_remaining: number;
}

export interface TrashData {
  tasks: TrashTaskItem[];
  notes: TrashNoteItem[];
  total_count: number;
}

export interface OverlaySkillItem {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
  disabled?: boolean;
}

export interface UserSkillItem {
  id: string;
  key: string;
  title: string;
  status: string;
  version: number;
  body: string;
  origin_failure: string | null;
  supersedes: string | null;
  runs: number;
  views: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface SkillsResponse {
  builtin: OverlaySkillItem[];
  user: UserSkillItem[];
}

export interface BacklogItem {
  id: string;
  category: string;
  title: string;
  raw_input: string;
  status: string;
  created_at: string | null;
}

export interface DiagnosticsTurnTrace {
  startedAt?: string | null;
  updatedAt?: string | null;
  stage?: string;
  modelCalls?: number;
  deadlineHit?: boolean;
}

export interface DiagnosticsTurnStats {
  turns?: number;
  ok?: number;
  failed?: number;
}

export interface DiagnosticsFailure {
  status?: number;
  at?: string | null;
  message?: string | null;
}

export interface DiagnosticsClock {
  lastExternalAttemptAt?: string | null;
  lastExternalSuccessAt?: string | null;
}

export interface DiagnosticsUsage {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  total_cost_eur: number;
}

export interface DiagnosticsResponse {
  summary_text: string;
  last_failure: DiagnosticsFailure | null;
  turn_trace: DiagnosticsTurnTrace | null;
  turn_stats: DiagnosticsTurnStats | null;
  clock: DiagnosticsClock | null;
  thread: {
    count: number;
    updated_at: string | null;
  };
  usage: DiagnosticsUsage;
  model_provider: string;
  has_byok_key: boolean;
}

export interface FxRatesResponse {
  date: string | null;
  base: string;
  rates: Record<string, number>;
  updated_at: string | null;
}

export interface CreateTransactionPayload {
  kind: 'expense' | 'income' | 'transfer';
  account_id: string;
  to_account_id?: string;
  amount: number;
  currency?: string;
  category_name?: string;
  description?: string;
}

export interface TransactionWriteResponse {
  group_id: string | null;
  transactions: TransactionItem[];
}

export interface DocSearchResult {
  query: string;
  topic: string | null;
  result: string;
}

export interface ReaderSkillData {
  source: 'builtin' | 'user';
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  triggers?: string[];
  body: string;
  runs?: number;
  views?: number;
}

