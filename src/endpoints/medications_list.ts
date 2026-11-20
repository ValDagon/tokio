/**
 * GET /api/medications → `src/endpoints/medications_list.ts`.
 *
 * Порт `backend/app/api/routes.py::get_medications` +
 * `backend/app/services/medications.py::get_user_medications`.
 *
 * Ответ — `MedicationResponseSchema`: только активные медикаменты и журнал на
 * «сегодня», где день считается в таймзоне пользователя (upstream брал
 * `datetime.now().date()` сервера).
 */

import { requireUserId } from '../lib/auth.js';
import { getUser } from '../lib/dal/users.js';
import { listDoses } from '../lib/dal/medications.js';
import { dateKey } from '../lib/utils.js';
import type { MedicationRow } from '../lib/types.js';

export interface MedicationTodayLog {
  scheduled_time: string;
  /** `taken`, `skipped` или `pending`. */
  status: string;
  taken_at: string | null;
}

export interface MedicationSchema {
  id: string;
  name: string;
  dosage: string;
  times: string[];
  frequency: string;
  instructions: string | null;
  is_active: boolean;
  today_logs: MedicationTodayLog[];
}

/** Строка DAL → `MedicationResponseSchema` (snake_case, id строкой). */
export function toMedicationSchema(
  medication: MedicationRow,
  todayLogs: MedicationTodayLog[],
): MedicationSchema {
  return {
    id: String(medication.id),
    name: medication.name,
    dosage: medication.dosage,
    times: [...medication.times],
    frequency: medication.frequency,
    instructions: medication.instructions ?? null,
    is_active: medication.isActive,
    today_logs: todayLogs,
  };
}

/** Локальная дата пользователя `YYYY-MM-DD` (по умолчанию UTC). */
export async function userToday(userId: number): Promise<string> {
  const user = await getUser(userId);
  return dateKey(new Date(), user?.timezone ?? 'UTC');
}

export default async function (
  input: Record<string, unknown>,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<MedicationSchema[]> {
  const userId = requireUserId(input, ctx);

  const today = await userToday(userId);
  const doses = await listDoses(userId, today);

  // `listDoses` уже даёт по одной дозе на каждое время расписания, `pending`
  // для тех, по которым записи в журнале ещё нет — ровно формат `today_logs`.
  const byMedication = new Map<number, MedicationSchema>();
  for (const dose of doses) {
    let entry = byMedication.get(dose.medication.id);
    if (!entry) {
      entry = toMedicationSchema(dose.medication, []);
      byMedication.set(dose.medication.id, entry);
    }
    entry.today_logs.push({
      scheduled_time: dose.scheduledTime,
      status: dose.status,
      taken_at: dose.takenAt ?? null,
    });
  }

  return [...byMedication.values()];
}
