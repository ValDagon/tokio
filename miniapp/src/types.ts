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

export interface UserSettings {
  name?: string;
  language?: 'ru' | 'en' | 'sr' | 'ja';
  base_currency: string;
  timezone: string;
  summary_time?: string;
  low_stimulation_mode: boolean;
  custom_instructions: string;
  persona_style: string;
  personal_memory?: string;
  role?: 'admin' | 'user';
  onboarded?: boolean;
  daily_msg_limit?: number;
  daily_msg_used?: number;
  has_byok_key?: boolean;
}

export interface UiConfigAccountTheme {
  pattern: string;
  theme: 'primary' | 'secondary' | 'accent' | 'neutral';
  shortName?: string;
  roleLabel?: string;
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
  };
  miniapp: {
    tabs: string[];
    accountThemes: UiConfigAccountTheme[];
  };
}

export interface AccessInfo {
  role?: 'admin' | 'user';
  is_approved?: boolean;
  onboarded?: boolean;
  daily_msg_limit?: number;
  daily_msg_used?: number;
  has_byok_key?: boolean;
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
  column: 'inbox' | 'raw' | 'ideas' | 'self' | 'useful' | 'possible_tasks' | 'archive';
  created_at: string;
  updated_at: string;
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

