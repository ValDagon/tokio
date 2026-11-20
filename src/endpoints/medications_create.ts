/**
 * POST /api/medications → `src/endpoints/medications_create.ts`.
 *
 * Порт `backend/app/api/routes.py::create_medication` +
 * `backend/app/services/medications.py::create_user_medication`.
 * Дефолты: `times=['09:00']`, `frequency='daily'`, `instructions=null`
 * (upstream `str | None = None` → в БД NULL), `dosage=''`.
 * `today_logs` сразу заполняется `pending` по каждому времени расписания.
 */

import { EndpointError } from 'sdk';
import { requireUserId } from '../lib/auth.js';
import {
  createMedication,
  normalizeTimes,
  DEFAULT_FREQUENCY,
  DEFAULT_TIMES,
} from '../lib/dal/medications.js';
import type { MedicationFrequency } from '../lib/types.js';
import { toMedicationSchema } from './medications_list.js';
import type { MedicationSchema } from './medications_list.js';

/** `times` из тела: массив строк; мусор → 400 (upstream отдавал 422). */
function readTimes(value: unknown): string[] {
  if (value === undefined || value === null) return [...DEFAULT_TIMES];
  if (!Array.isArray(value)) {
    throw new EndpointError('times must be a list of HH:MM strings', { code: 'BAD_REQUEST' });
  }
  try {
    return normalizeTimes(value.map((item) => String(item)));
  } catch {
    throw new EndpointError('times must be a list of HH:MM strings', { code: 'BAD_REQUEST' });
  }
}

export default async function (
  input: Record<string, unknown>,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<MedicationSchema> {
  const userId = requireUserId(input, ctx);

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new EndpointError('name is required', { code: 'BAD_REQUEST' });
  }

  const dosage = typeof input.dosage === 'string' ? input.dosage : '';
  const times = readTimes(input.times);
  const frequency: MedicationFrequency =
    typeof input.frequency === 'string' && input.frequency.trim()
      ? (input.frequency.trim() as MedicationFrequency)
      : DEFAULT_FREQUENCY;
  const instructions =
    typeof input.instructions === 'string' ? input.instructions : null;

  const created = await createMedication(userId, {
    name,
    dosage,
    times,
    frequency,
    instructions,
  });

  const todayLogs = created.times.map((time) => ({
    scheduled_time: time,
    status: 'pending',
    taken_at: null,
  }));

  return toMedicationSchema(created, todayLogs);
}
