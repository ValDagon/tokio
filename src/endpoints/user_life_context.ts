/**
 * GET /api/user/life-context → `src/endpoints/user_life_context.ts`.
 *
 * Порт `backend/app/api/routes.py::get_user_life_context` →
 * `backend/app/agent/tools/reasoning.py::synthesize_life_context`.
 *
 * Детерминированный оффлайн-досье на русском: заметки, свежий инбокс,
 * обязательства, активные задачи и препараты. Никаких вызовов LLM.
 *
 * Отличия от upstream (осознанные, из-за схемы платформы):
 *  - upstream брал заметки из колонок `self`/`ideas`/`useful`, которых нет
 *    в `NoteColumn` платформы; курируемый набор — `note` (ранг 1) и `idea`
 *    (ранг 2), сортировка по рангу и `created_at DESC`, лимит 6;
 *  - инбокс — только колонка `raw` (upstream: `raw` + `inbox`);
 *  - секция графа знаний (`🧠 **Связи, проекты и ключевые сущности:**`)
 *    не портирована — KG-запросов в этом слое нет;
 *  - `ListTasks` вызывается с `autoAdvance: false`, чтобы чтение контекста
 *    не двигало прошедшие события (у upstream чтение — чистый SELECT);
 *  - если у обязательства нет `payment_day`, хвост `(день N)` не печатается
 *    (upstream вывел бы `(день None)`).
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { listLiabilities } from '../lib/dal/finances.js';
import { listMedications } from '../lib/dal/medications.js';
import { listNotes } from '../lib/dal/notes.js';
import { listCategories, listTasks } from '../lib/dal/tasks.js';
import type {
  LiabilityRow,
  MedicationRow,
  NoteRow,
  TaskRow,
} from '../lib/types.js';

/** Ранг курируемых колонок (upstream: self=1, ideas=2, useful=3). */
const CURATED_RANK: Partial<Record<string, number>> = { note: 1, idea: 2 };

const THOUSANDS_RE = /\B(?=(\d{3})+(?!\d))/g;

/** Python `round()` — округление половины к чётному. */
function roundHalfEven(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const floor = Math.floor(abs);
  const diff = abs - floor;
  if (diff > 0.5) return sign * (floor + 1);
  if (diff < 0.5) return sign * floor;
  return sign * (floor % 2 === 0 ? floor : floor + 1);
}

/** Python `f"{value:,.0f}"` — целое с запятыми-разделителями тысяч. */
function formatThousands(value: number): string {
  return String(roundHalfEven(value)).replace(THOUSANDS_RE, ',');
}

/** `ORDER BY created_at DESC` после слияния двух выборок. */
function compareNotes(a: NoteRow, b: NoteRow): number {
  const rankA = CURATED_RANK[a.column] ?? 99;
  const rankB = CURATED_RANK[b.column] ?? 99;
  if (rankA !== rankB) return rankA - rankB;
  const createdA = a.createdAt ?? '';
  const createdB = b.createdAt ?? '';
  if (createdA === createdB) return b.id - a.id;
  return createdA < createdB ? 1 : -1;
}

/** `ORDER BY payment_day NULLS LAST`, затем id. */
function compareLiabilities(a: LiabilityRow, b: LiabilityRow): number {
  if ((a.paymentDay === null) !== (b.paymentDay === null)) {
    return a.paymentDay === null ? 1 : -1;
  }
  if (a.paymentDay !== null && b.paymentDay !== null && a.paymentDay !== b.paymentDay) {
    return a.paymentDay - b.paymentDay;
  }
  return a.id - b.id;
}

/** Python `txt[:100] + "..."`, если длиннее 100 code points. */
function truncate(text: string): string {
  const chars = Array.from(text);
  return chars.length > 100 ? `${chars.slice(0, 100).join('')}...` : text;
}

/** Строка `topic` из тела: `undefined` — фильтра нет. */
function readTopic(input: Record<string, unknown>): string | undefined {
  const raw = input.topic;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new EndpointError('Invalid topic', { code: 'BAD_REQUEST' });
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<{ context: string }> {
  const userId = requireUserId(input, ctx);
  const topic = readTopic(input);

  const [noteRows, ideaRows, inboxNotes, liabilities, tasks, categories, medications] =
    await Promise.all([
      listNotes(userId, { column: 'note', limit: 1000 }),
      listNotes(userId, { column: 'idea', limit: 1000 }),
      listNotes(userId, { column: 'raw', limit: 5 }),
      listLiabilities(userId),
      listTasks(userId, { status: 'todo', parentId: null, autoAdvance: false, limit: 6 }),
      listCategories(userId),
      listMedications(userId),
    ]);

  const topicLower = topic?.toLowerCase();
  const notes = [...noteRows, ...ideaRows]
    .filter((note) => {
      if (topicLower === undefined) return true;
      const haystack = `${note.rawText}\n${note.cleanText ?? ''}`.toLowerCase();
      return haystack.includes(topicLower);
    })
    .sort(compareNotes)
    .slice(0, 6);

  const categoryNames = new Map<number, string>(
    categories.map((category) => [category.id, category.name] as const),
  );

  const sections = ['💾 **Срез реальных данных из вашей базы:**'];

  if (notes.length > 0) {
    sections.push('\n📝 **Заметки и мысли:**');
    for (const note of notes) {
      sections.push(`• [${note.column}] ${note.cleanText || note.rawText}`);
    }
  }

  if (inboxNotes.length > 0) {
    sections.push('\n📥 **Свежие мысли и инбокс (raw / inbox):**');
    for (const note of inboxNotes) {
      const text = (note.cleanText || note.rawText || '').trim();
      sections.push(`• [${note.column}] ${truncate(text)}`);
    }
  }

  if (liabilities.length > 0) {
    const ordered = [...liabilities].sort(compareLiabilities);
    const totalDebtEur = ordered.reduce((sum, item) => sum + item.amountEurCents / 100, 0);
    const monthlyPayments = ordered
      .filter((item) => item.monthlyPaymentCents > 0)
      .map((item) => {
        const amount = formatThousands(item.monthlyPaymentCents / 100);
        const day = item.paymentDay === null ? '' : ` (день ${item.paymentDay})`;
        return `${item.name}: ${amount} ${item.currency}${day}`;
      });

    sections.push('\n💳 **Финансовые обязательства:**');
    sections.push(`• Общий объём долгов/кредитов: ~${formatThousands(totalDebtEur)} EUR`);
    if (monthlyPayments.length > 0) {
      sections.push(`• Регулярные платежи: ${monthlyPayments.join('; ')}`);
    }
  }

  if (tasks.length > 0) {
    sections.push('\n✅ **Текущие задачи и фокус:**');
    for (const task of tasks) {
      const category = categorySuffix(task, categoryNames);
      sections.push(`• ${task.title}${category}`);
    }
  }

  if (medications.length > 0) {
    sections.push('\n💊 **Приём препаратов:**');
    for (const medication of medications) {
      sections.push(medicationLine(medication));
    }
  }

  return { context: sections.join('\n') };
}

function categorySuffix(task: TaskRow, names: Map<number, string>): string {
  if (task.categoryId === null) return '';
  const name = names.get(task.categoryId);
  return name ? ` [${name}]` : '';
}

function medicationLine(medication: MedicationRow): string {
  const times = medication.times.length > 0 ? medication.times.join(', ') : '';
  return `• ${medication.name} (${medication.dosage}) в ${times}`;
}
