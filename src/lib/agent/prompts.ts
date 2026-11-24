/**
 * Системные промпты агента (SPEC §3 T11, §7 ADR-002).
 *
 * Порт `backend/app/agent/prompts.py`, но без персональных данных: банки,
 * город, валюты и сферы жизни upstream-владельца в код не попадают. Всё, что
 * относится к конкретному человеку, приходит параметрами из БД (`users`,
 * `doc_chapters`) — имя, таймзона, базовая валюта, стиль общения, личные
 * директивы. Промпт собирается на каждый вызов: дата, режим и каталог тулз
 * меняются, а кэшировать персонализацию нельзя (спека: промпт динамический).
 *
 * Три режима (как в upstream):
 *  1. `action` — короткая утилитарная просьба: сразу инструмент, короткий ответ;
 *  2. `thought_partner` — анализ и стратегия: сначала факты из тулз, потом вывод;
 *  3. `system_expert` — вопросы об устройстве системы: строгое заземление на
 *     документацию (`consult_system_docs` в терминах T12), без фантазий.
 *
 * Протокол ReAct описан в промпте текстом (`Thought` → `Action` → `Action Input`
 * → `Observation` → `Final Answer`), потому что порт не использует нативные
 * tool-call'ы провайдера: `lib/gemini.ts` — обычный чат.
 */

import { zonedParts } from '../utils.js';
import { renderSkillEntry, type ActiveSkill } from '../evolution.js';
import { formatLocaleDate, normalizeLocale, type LocaleCode } from '../i18n.js';
import {
  getAssistantName,
  getOverlay,
  getOverlayPrompt,
  getOverlaySkills,
  getPersonaStyleText,
  type OverlaySkill,
} from '../overlay.js';
import {
  computeWorkloadMetrics,
  detectOverloadMarkers,
  evaluateExecutiveOverload,
  formatOverloadReasons,
  isTaskOverdue,
  type ExecutiveOverloadFactors,
  type ExecutiveOverloadInput,
  type ExecutiveOverloadState,
  type WorkloadMetrics,
} from './constants.js';
import type { ToolSummary } from './registry.js';
import { TOOL_GROUPS, type ToolDomain } from './tools/index.js';

export {
  computeWorkloadMetrics,
  detectOverloadMarkers,
  evaluateExecutiveOverload,
  formatOverloadReasons,
  isTaskOverdue,
  type ExecutiveOverloadFactors,
  type ExecutiveOverloadInput,
  type ExecutiveOverloadState,
  type WorkloadMetrics,
};

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export type AgentMode = 'action' | 'thought_partner' | 'system_expert';

export type PersonaStyle = 'mentor' | 'strategist' | 'calm_partner' | 'concise';

/** Всё, что приходит из БД и влияет на текст промпта. */
export interface AgentProfile {
  userName: string | null;
  timezone: string;
  baseCurrency: string;
  locale?: LocaleCode;
  personaStyle: PersonaStyle | string | null;
  customInstructions: string | null;
  /** Переопределённое имя ассистента из `user_prefs`. */
  assistantName?: string | null;
  /** Пользовательские персоны из `user_prefs`. */
  customPersonas?: Readonly<
    Record<string, { name: string; description?: string; instructions: string }>
  > | null;
  /** Идентификаторы отключённых встроенных `.md`-скиллов. */
  disabledBuiltinSkills?: readonly string[] | null;
  /**
   * Включённые владельцем процедуры (`status='active'`). Загружаются один раз
   * на прогон вместе с остальным профилем: включение посреди прогона видно
   * только следующему. `pending` и `rejected` сюда не попадают по построению.
   */
  activeSkills?: readonly ActiveSkill[] | null;
  lowStimulationMode?: boolean;
  overloadShieldEnabled?: boolean;
  overdueTaskCount?: number;
  activeTodoCount?: number;
  missedMedsCount?: number;
}

export interface SystemPromptOptions {
  /** Язык системного промпта (перекрывает `profile.locale`). */
  locale?: LocaleCode;
  /** Название продукта в шапке промпта. */
  assistantName?: string;
  /** Профиль пользователя (параметры из БД, не константы кода). */
  profile?: Partial<AgentProfile> | null;
  /** `null`/`undefined` — в промпт попадают все три режима. */
  mode?: AgentMode | null;
  /** Фокус запроса: сужает каталог тулз (`detectToolFocus`). `null` — целиком. */
  focus?: ToolFocus | null;
  /** Каталог тулз: имена и описания подставляет реестр. */
  tools?: readonly ToolSummary[];
  /** Лимит шагов — модель должна знать, что он конечен. */
  maxSteps?: number;
  /** Момент, для которого считаются дата и время. */
  now?: Date;
  /** Состояние когнитивного перегруза для динамического щита в хвосте промпта. */
  executiveOverload?: ExecutiveOverloadState;
  /** Активен разговорный режим (/talk): только свободный диалог, без записи в БД. */
  talkMode?: boolean;
}

// ---------------------------------------------------------------------------
// Константы локализации
// ---------------------------------------------------------------------------

export const RU_WEEKDAYS: readonly string[] = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
];

export const RU_MONTHS: readonly string[] = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

export const DEFAULT_ASSISTANT_NAME = getOverlay().manifest.brand.assistantName;

/** Падение промпта на неизвестной таймзоне недопустимо — считаем в UTC. */
const FALLBACK_TIMEZONE = 'UTC';

// ---------------------------------------------------------------------------
// Дата и время
// ---------------------------------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** День недели для календарной даты (0 — понедельник, как в Python `weekday()`). */
function weekdayIndex(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (date.getUTCDay() + 6) % 7;
}

export interface LocalMoment {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `ЧЧ:ММ`. */
  time: string;
  /** «пятница, 6 ноября 2026 г.» */
  human: string;
  weekday: string;
}

/** Календарные части момента в таймзоне пользователя. */
export function localMoment(now: Date, timeZone: string = FALLBACK_TIMEZONE): LocalMoment {
  const parts = zonedParts(now, timeZone);
  const weekday = RU_WEEKDAYS[weekdayIndex(parts.year, parts.month, parts.day)] ?? RU_WEEKDAYS[0]!;
  const month = RU_MONTHS[parts.month - 1] ?? RU_MONTHS[0]!;
  return {
    date: `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`,
    time: `${pad2(parts.hour)}:${pad2(parts.minute)}`,
    weekday,
    human: `${weekday}, ${parts.day} ${month} ${parts.year} г.`,
  };
}

/** Дата в формате upstream: `2026-11-06 (пятница, 6 ноября 2026 г.)`. */
export function formatDateRu(now: Date, timeZone: string = FALLBACK_TIMEZONE): string {
  const moment = localMoment(now, timeZone);
  return `${moment.date} (${moment.human})`;
}

// ---------------------------------------------------------------------------
// Определение режима
// ---------------------------------------------------------------------------

const THOUGHT_PARTNER_MARKERS: readonly RegExp[] = [
  /как (?:мне )?(?:лучше )?(?:поступить|сделать|решить)/i,
  /что (?:скажешь|думаешь|посоветуешь)/i,
  /порассуждай|порассуждаем|обсудим/i,
  /стратеги|приоритет|план(?:ы)? на|перспектив/i,
  /хватит ли|на сколько (?:хватит|денег)|финансов\w* (?:план|горизонт)/i,
  /как (?:устроен|работает) (?:мой|моя)|мо(?:и|я) (?:деньги|бюджет|долг)/i,
  /устал|выгорел|тревож|пережива|тяжело|грустно|нет\s+сил|не\s+могу\s+собраться|не\s+знаю\s+с\s+чего|чувствую\s+себя|хочется\s+выговориться|просто\s+делюсь|поделюсь/i,
];

const SYSTEM_EXPERT_MARKERS: readonly RegExp[] = [
  /документац|инструкц|как (?:устроен|работает) (?:систем|бот|приложен|мини)/i,
  /что (?:такое|означает) /i,
  /какие (?:есть )?(?:команды|кнопки|возможности|правила|функции)/i,
  /что ты умеешь/i,
  /как (?:настроить|изменить) (?:систем|правил|стиль)/i,
];

/**
 * Режим по тексту запроса. Эвристика намеренно грубая: она лишь подсказывает
 * модели, на что опереться, и не мешает ей выбрать другой путь внутри ответа.
 */
export function detectMode(text: string | null | undefined): AgentMode {
  const value = String(text ?? '').trim();
  if (!value) return 'action';

  for (const marker of SYSTEM_EXPERT_MARKERS) {
    if (marker.test(value)) return 'system_expert';
  }
  for (const marker of THOUGHT_PARTNER_MARKERS) {
    if (marker.test(value)) return 'thought_partner';
  }

  // Длинный развёрнутый вопрос без явных маркеров — скорее разговор, чем команда.
  const words = value.split(/\s+/).filter(Boolean).length;
  if (words >= 25 || /\?$/.test(value)) return 'thought_partner';
  return 'action';
}

// ---------------------------------------------------------------------------
// Фокус каталога
// ---------------------------------------------------------------------------

/**
 * Домен запроса, по которому сужается каталог тулз. Ось независима от
 * `AgentMode`: режим отвечает за тон и способ рассуждения, фокус — только за
 * состав каталога. `null` — сужать нечем, отдаём каталог целиком.
 */
export type ToolFocus = 'finance' | 'medical';

/** Маркеры финансового запроса. Эвристика грубая, как и у `detectMode`. */
const FINANCE_FOCUS_MARKERS: readonly RegExp[] = [
  /финанс|денеж|деньг|бюджет|баланс|счёт|счет|долг(?:и|ов|ам|ами|ах|ом|а|у)?(?![а-яё])|кредит|займ|ипотек|рассрочк|платеж|платёж|обязательств/i,
  /(?<![а-яё])трат|расход|потрат|затрат|доход|заработ|прибыл|перевод|обмен|валют|рубл|евро|доллар|лимит/i,
  /на сколько (?:хватит|денег)|хватит ли/i,
];

/** Маркеры медицинского запроса (аптечка и приёмы). */
const MEDICAL_FOCUS_MARKERS: readonly RegExp[] = [
  /лекарств|таблетк|медикамент|препарат|аптек|витамин|дозировк/i,
  /приня(?:л|ла|ть)?\s+(?:таблетк|лекарств|доз)|выпи(?:л|ла|ть)\s+(?:таблетк|лекарств)/i,
  /напомни(?:ть)?\s+(?:о|про)\s+(?:лекарств|таблетк)/i,
];

/**
 * Фокус каталога по тексту запроса. Если названы оба домена («сколько потратил
 * на таблетки») или ни одного — `null`: сужать каталог нельзя, нужен полный
 * набор инструментов.
 */
export function detectToolFocus(text: string | null | undefined): ToolFocus | null {
  const value = String(text ?? '').trim();
  if (!value) return null;

  const finance = FINANCE_FOCUS_MARKERS.some((marker) => marker.test(value));
  const medical = MEDICAL_FOCUS_MARKERS.some((marker) => marker.test(value));
  if (finance === medical) return null;
  return finance ? 'finance' : 'medical';
}

/** Домены, которые прячутся, когда запрос явно про другой домен. */
const FOCUS_HIDDEN_DOMAINS: Record<ToolFocus, readonly ToolDomain[]> = {
  finance: ['medications'],
  medical: ['finance', 'runway'],
};

/**
 * Каталог под фокус: финансовый запрос не видит аптечку, медицинский — деньги
 * и runway. Остальные домены (задачи, заметки, корзина, документация,
 * reasoning) остаются всегда: они нужны в любом сценарии.
 */
export function filterToolsByFocus(
  tools: readonly ToolSummary[],
  focus: ToolFocus | null | undefined,
): ToolSummary[] {
  if (!focus) return [...tools];

  const hidden = new Set(
    FOCUS_HIDDEN_DOMAINS[focus].flatMap((domain) => TOOL_GROUPS[domain].map((tool) => tool.name)),
  );
  return tools.filter((tool) => !hidden.has(tool.name));
}

// ---------------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------------

const MODE_SECTIONS: Record<AgentMode, string> = {
  action: `1. ⚡ РЕЖИМ БЫСТРОГО ДЕЙСТВИЯ (Action Mode)
Когда запрос короткий и утилитарный (записать трату, поставить напоминание, добавить задачу, отметить приём лекарства, изменить или удалить обязательство, счёт, операцию, заметку):
- Сразу вызывай подходящий инструмент (tool) — не пересказывай намерение словами и не пиши, что сделал, пока инструмент реально не выполнен.
- Любые просьбы управлять обязательствами, подписками и долгами (add_liability, update_liability, delete_liability, mark_liability_paid), счетами (set_account_balance, adjust_account_balance, update_account, delete_account), операциями (add_expense, add_income, add_transfer, add_exchange, list_transactions, delete_transaction), задачами, заметками (add_note, edit_note, move_note, delete_note) и лекарствами выполняй сразу через соответствующие инструменты.
- Если пользователь просто прислал сырую мысль, наблюдение или идею для запоминания без вопроса и без действия — сохрани её через add_note.
- Описание остатков на счетах и просьбы перевести, переложить, сконвертировать, обменять или пересчитать деньги — это ДЕЙСТВИЕ, а не заметка: не вызывай add_note и не оставляй такую фразу в инбоксе.
- Если для денежной операции не хватает счёта, суммы или валюты — сначала get_fin_balances, затем ОДИН точный вопрос с реальными названиями счетов и валют. Суммы и курс не выдумывай.
- Для обмена валюты передавай from_amount и валюты, а to_amount не указывай: add_exchange сам посчитает по живому курсу на дату операции и округлит вверх до ,99. Посмотреть курс — get_fx_rates.
- Если курса на сегодня нет, а пользователь его называет — сохрани его через set_fx_rate (сколько единиц валюты за 1 EUR) и сразу повтори обмен.
- Если инструмент ответил, что операция опустошит счёт и нужно подтверждение, задай пользователю один короткий вопрос; после явного «да» повтори вызов с confirm: true.
- Отвечай предельно лаконично, ёмко и тепло, без лишней воды и длинных лекций.
- Крупные пугающие дела декомпозируй на 3–5 простых шагов по 10–15 минут.`,

  thought_partner: `2. 🧠 РЕЖИМ МЫСЛИТЕЛЬНОГО ПАРТНЁРА И АНАЛИТИКА (Thought Partner Mode)
Когда пользователь спрашивает о планировании, деньгах, перспективах или просит разобраться в ситуации («как мне лучше поступить?», «что скажешь по моим проектам?»):
- ПЕРВЫМ ДЕЛОМ ВЫЗЫВАЙ ИНСТРУМЕНТЫ и поднимай факты из базы. Никогда не рассуждай о цифрах и обязательствах по памяти.
- РАССУЖДАЙ ГЛУБОКО НА ОСНОВАНИИ ДАННЫХ: соединяй реальные цифры, сроки и мысли из заметок с уровнем нагрузки.
- Ссылайся на контекст как на источники (в стиле NotebookLM): опирайся на проверенные факты из базы, а не на догадки.
- Используй сократический диалог: помогай структурировать мысли, подсвечивай развилки и задавай 1–2 точных вопроса для ясности.`,

  system_expert: `3. 📖 РЕЖИМ ЭКСПЕРТА ПО СИСТЕМЕ (System Expert, строгое заземление)
Когда спрашивают об устройстве системы, правилах, формулах, возможностях, кнопках, очередях, повторах задач или командах:
- ПЕРВЫМ ДЕЛОМ ВЫЗЫВАЙ ИНСТРУМЕНТ РАБОТЫ С ДОКУМЕНТАЦИЕЙ. Никогда не описывай устройство системы по памяти.
- СТРОГОЕ ЗАЗЕМЛЕНИЕ: опирайся только на текст полученной документации и ссылайся на конкретный раздел первоисточника (например: [Документация: раздел «…»]).
- ЗАПРЕТ НА ФАНТАЗИИ: если возможности в документации нет, прямо скажи, что её сейчас нет, без домыслов и ложных обещаний о будущем.`,
};

const PROTOCOL = `ФОРМАТ РАБОТЫ (АВТОНОМНЫЕ ИНСТРУМЕНТЫ):
Ты — полноценный автономный агент и работаешь напрямую через встроенный механизм вызовов функций (native tool calling).
Правила работы с инструментами:
- не пиши в ответ протокольные метки вида «Thought: / Action: / Action Input: / Final Answer:» — вызывай функции напрямую через API инструментов;
- если задача многошаговая — выполняй её цепочкой шагов (например, сначала проверь список через get_liabilities / list_tasks / list_transactions / search_notes, затем сразу вызови нужное обновление или удаление);
- независимые проверки (балансы, обязательства, runway, задачи, заметки) объединяй в одном ходе параллельно — это тратит 1 шаг вместо нескольких и ускоряет ответ;
- имена и аргументы инструментов бери строго из объявленных схем;
- если инструмент вернул ошибку или «не найдено» — уточни поиск по списку или честно объясни причину, не выдумывая результат;
- если подходящего инструмента нет — сразу ответь пользователю по сути, не выдумывая результаты;
- подтверждение confirm: true требуется для безвозвратных удалений (delete_liability, delete_account, delete_medication), массовой зачистки (reset_finance_history, clear_trash) и условных бизнес-правил самих инструментов (нулевой баланс, опустошение счёта); удаления в корзину (delete_note, delete_task) выполняй сразу по явной просьбе, а создание записей подтверждения не требует никогда;
- если текущее сообщение — приветствие, благодарность или светская реплика без просьбы, не вызывай инструменты изменения данных, даже когда в истории диалога осталась незакрытая просьба: сначала уточни, актуальна ли она;
- количество шагов ограничено, поэтому не зацикливайся на чтении документации и не перепроверяй одно и то же.`;

/**
 * Директива read-only прогона: тулсет урезан до чтения, и модель обязана
 * сказать об этом честно, а не имитировать выполненное действие.
 *
 * Живёт в промпте, а не в коде ответа: решение, что именно сказать, остаётся за
 * моделью, но право на запись отнято физически — write-тулз нет в списке.
 */
export const READ_ONLY_DIRECTIVE = `ОГРАНИЧЕНИЕ ЭТОГО ХОДА (только чтение):
В этом ходе доступны только инструменты чтения — изменять данные нельзя.
- На приветствие, благодарность или светскую реплику отвечай коротко и тепло, без вызовов, если данных не просят.
- Если просят данные (балансы, задачи, заметки, лекарства, расходы) — используй инструменты чтения.
- Если просят действие (записать, удалить, напомнить, перевести, изменить) — честно скажи, что действие не выполнено, и попроси прислать просьбу отдельным сообщением. Не выдумывай результат и никогда не пиши, что действие выполнено, если инструмент не вызывался.`;

export const TALK_MODE_DIRECTIVE = `РЕЖИМ СВОБОДНОГО РАЗГОВОРА (/talk):
Сейчас активен разговорный режим: пользователь хочет просто поговорить, поразмышлять или выговориться.
- Отвечай тепло, по-человечески и бережно как Life Thought Partner, без давления продуктивностью и без навязывания списков дел.
- Не сохраняй реплики пользователя в заметки и не изменяй данные в базе.
- Если пользователь просит что-то записать/изменить или хочет вернуться к обычному управлению — подскажи, что из режима можно выйти командой /talk off или словом «закончим».`;

/** Нормализует стиль общения; поддерживает кастомные персоны и свободный текст. */
export function resolvePersonaStyle(
  style: PersonaStyle | string | null | undefined,
  locale: LocaleCode = 'ru',
  customPersonas?: Readonly<
    Record<string, { name: string; description?: string; instructions: string }>
  > | null,
): string | null {
  const value = typeof style === 'string' ? style.trim() : '';
  if (!value) return null;
  if (customPersonas && Object.hasOwn(customPersonas, value)) {
    const custom = customPersonas[value];
    if (custom?.instructions?.trim()) {
      return `${custom.name || value}: ${custom.instructions.trim()}`;
    }
  }
  const known = getPersonaStyleText(value, locale);
  if (known) return known;
  return value;
}

// ---------------------------------------------------------------------------
// Каталог тулз
// ---------------------------------------------------------------------------

/** Компактная JSON-схема аргументов: длинные описания обрезаем, чтобы не раздувать промпт. */
function renderSchema(schema: Record<string, unknown> | null): string {
  if (!schema) return '';
  let json: string;
  try {
    json = JSON.stringify(schema);
  } catch {
    return '';
  }
  if (!json) return '';
  if (json.length > 700) json = `${json.slice(0, 697)}…`;
  return `\n  Аргументы: ${json}`;
}

export function renderToolCatalog(tools: readonly ToolSummary[]): string {
  if (tools.length === 0) {
    return 'КАТАЛОГ ИНСТРУМЕНТОВ:\nИнструменты не подключены. Работай только текстом: отвечай Final Answer без вызовов.';
  }
  const lines = tools.map(
    (tool) => `- ${tool.name}: ${tool.description}${renderSchema(tool.schema)}`,
  );
  return `КАТАЛОГ ИНСТРУМЕНТОВ:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Сборка промпта
// ---------------------------------------------------------------------------

function resolveTimeZone(raw: string | null | undefined): string {
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (!candidate) return FALLBACK_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

function dateHeader(options: SystemPromptOptions, locale: LocaleCode): string {
  const profile = options.profile ?? {};
  const timeZone = resolveTimeZone(profile.timezone);
  const now = options.now ?? new Date();
  const moment = localMoment(now, timeZone);
  if (locale === 'ru') {
    return `ТЕКУЩЕЕ ВРЕМЯ И КАЛЕНДАРЬ:
Сегодняшняя дата: ${formatDateRu(now, timeZone)}
Местное время пользователя: ${moment.time} (${timeZone})`;
  }
  const human = formatLocaleDate(locale, now, timeZone, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  if (locale === 'sr') {
    return `TRENUTNO VREME I KALENDAR:
Današnji datum: ${moment.date} (${human})
Lokalno vreme korisnika: ${moment.time} (${timeZone})`;
  }
  if (locale === 'ja') {
    return `現在時刻とカレンダー:
本日の日付: ${moment.date} (${human})
ユーザーの現地時刻: ${moment.time} (${timeZone})`;
  }
  return `CURRENT TIME & CALENDAR:
Today's date: ${moment.date} (${human})
User local time: ${moment.time} (${timeZone})`;
}

function profileBlock(options: SystemPromptOptions): string {
  const profile = options.profile ?? {};
  const lines: string[] = [];
  const name = typeof profile.userName === 'string' ? profile.userName.trim() : '';
  if (name) lines.push(`Обращайся к пользователю по имени: ${name}.`);
  const currency = typeof profile.baseCurrency === 'string' ? profile.baseCurrency.trim() : '';
  if (currency) lines.push(`Базовая валюта пользователя: ${currency} (все итоги и лимиты — в ней).`);
  if (lines.length === 0) return '';
  return `ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ (данные из базы, не константы):\n${lines.join('\n')}`;
}

function overloadShieldBlock(options: SystemPromptOptions): string {
  if (!getOverlay().manifest.features.overloadShield) return '';
  if (
    options.executiveOverload?.shieldEnabled === false ||
    options.profile?.overloadShieldEnabled === false
  ) {
    return '';
  }
  const state = options.executiveOverload;
  const manualCalm = Boolean(state?.lowStimulationMode || options.profile?.lowStimulationMode);
  if (!state?.isOverloaded && !manualCalm) return '';

  const reasons = formatOverloadReasons(state, manualCalm);

  const contextLine =
    reasons.length > 0
      ? `Активные факторы: ${reasons.join('; ')}.`
      : 'Активный режим снижения когнитивной нагрузки.';

  return `[РЕЖИМ СБЕРЕЖЕНИЯ ВНИМАНИЯ / EXECUTIVE OVERLOAD SHIELD]
${contextLine}
Правила ответа в этом состоянии:
- Тон: спокойный, тёплый и бережный (low-stimulation) — короткие фразы, без стен текста, без многоуровневых списков и без давления или чувства вины.
- Анти-абулия: сужай действие до ОДНОГО конкретного физического микро-шага длительностью ≤ 2 минут, который можно сделать прямо сейчас.
- СТРОГОЕ ТАБУ: никогда не переноси, не редактируй и не удаляй задачи пользователя в базе данных самостоятельно, пока пользователь прямо не попросит изменить конкретную задачу.`;
}

/** Вводная строка блока скиллов (в бюджет процедур не входит). */
export const SKILL_BLOCK_PREAMBLE =
  'БИБЛИОТЕКА ПРОЦЕДУР (скиллы, включённые владельцем — выполняй буквально):';

/**
 * Блок включённых процедур. Отдельный от `customInstructions`: личные правила
 * пользователя не должны вытесняться скиллами и наоборот. Текст не режется —
 * бюджет проверяется при включении (`activateSkill`), а не здесь, и меряет он
 * ровно те же строки (`renderSkillEntry` в `lib/evolution.ts`).
 */
export function renderSkillBlock(skills: readonly ActiveSkill[]): string {
  if (skills.length === 0) return '';
  return `${SKILL_BLOCK_PREAMBLE}\n${skills.map(renderSkillEntry).join('\n\n')}`;
}

/**
 * Компактный индекс встроенных `.md`-скиллов оверлея (Progressive Disclosure):
 * в системный промпт попадают только `id`, `name` и краткое `description`.
 * Полный Markdown-регламент агент подгружает по необходимости через `read_skill`.
 */
export function renderOverlaySkillCatalog(skills: readonly OverlaySkill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((skill) => {
    const namePart = skill.name && skill.name !== skill.id ? ` (${skill.name})` : '';
    return `- ${skill.id}${namePart}: ${skill.description}`;
  });
  return [
    'КАТАЛОГ ДОМЕННЫХ СКИЛЛОВ (.md, загружай по запросу через read_skill):',
    ...lines,
    'Правило: когда запрос подходит под описание скилла, сначала вызови read_skill(name_or_id) и следуй его процедуре. Для создания нового повторяемого навыка по просьбе пользователя используй draft_skill (включение всегда подтверждает пользователь).',
  ].join('\n');
}

/**
 * Собирает системный промпт. Все персональные значения — параметры; в самом
 * тексте промпта нет ни одного имени банка, города, валюты или сферы жизни.
 */
export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
  const overlay = getOverlay();
  const locale = normalizeLocale(
    options.locale ?? options.profile?.locale ?? overlay.manifest.defaultLocale,
    'ru',
  );
  const defaultName = getAssistantName(locale) || DEFAULT_ASSISTANT_NAME;
  const profileAssistantName =
    typeof options.profile?.assistantName === 'string' ? options.profile.assistantName.trim() : '';
  const name =
    String(options.assistantName ?? (profileAssistantName || defaultName)).trim() || defaultName;
  const mode = options.mode ?? null;
  const maxSteps = Math.max(1, Math.floor(options.maxSteps ?? 8));

  const identity = getOverlayPrompt(locale, 'identity', { assistantName: name });
  const mission = getOverlayPrompt(locale, 'mission', { assistantName: name });
  const principles = getOverlayPrompt(locale, 'principles', { assistantName: name });

  // Стабильный префикс (IDENTITY → каталог → профиль/скиллы/стиль/директивы)
  // идёт до динамической даты, чтобы провайдер мог переиспользовать prompt cache.
  const blocks: string[] = [identity, mission];

  const modeBlock =
    mode === null
      ? `ТРИ РЕЖИМА РАБОТЫ:\n\n${MODE_SECTIONS.action}\n\n${MODE_SECTIONS.thought_partner}\n\n${MODE_SECTIONS.system_expert}`
      : `АКТИВНЫЙ РЕЖИМ:\n${MODE_SECTIONS[mode]}`;
  blocks.push(modeBlock);
  blocks.push(principles);
  blocks.push(`${PROTOCOL}\nМаксимум шагов в этом диалоге: ${maxSteps}.`);
  blocks.push(renderToolCatalog(filterToolsByFocus(options.tools ?? [], options.focus ?? null)));

  const profile = profileBlock(options);
  if (profile) blocks.push(profile);

  const disabledSet = new Set(options.profile?.disabledBuiltinSkills ?? []);
  const enabledOverlaySkills = getOverlaySkills().filter((skill) => !disabledSet.has(skill.id));
  const overlaySkillCatalog = renderOverlaySkillCatalog(enabledOverlaySkills);
  if (overlaySkillCatalog) blocks.push(overlaySkillCatalog);

  const skills = renderSkillBlock(options.profile?.activeSkills ?? []);
  if (skills) blocks.push(skills);

  const style = resolvePersonaStyle(
    options.profile?.personaStyle,
    locale,
    options.profile?.customPersonas,
  );
  if (style) blocks.push(`ТЕКУЩИЙ СТИЛЬ ОБЩЕНИЯ:\nСтиль общения: ${style}`);

  const custom =
    typeof options.profile?.customInstructions === 'string'
      ? options.profile.customInstructions.trim()
      : '';
  if (custom) {
    blocks.push(`==================================================
🎯 ВЫСШИЕ ПОЛЬЗОВАТЕЛЬСКИЕ ДИРЕКТИВЫ (CUSTOM INSTRUCTIONS):
Пользователь задал следующие персональные правила для твоего поведения.
Они имеют ВЫСШИЙ ПРИОРИТЕТ над любыми общими формулировками:
«${custom}»
==================================================`);
  }

  blocks.push(dateHeader(options, locale));

  const shield = overloadShieldBlock(options);
  if (shield) blocks.push(shield);

  if (options.talkMode) blocks.push(TALK_MODE_DIRECTIVE);

  return blocks.join('\n\n');
}
