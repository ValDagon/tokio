/**
 * GET /api/system/usage → `src/endpoints/system_usage.ts`.
 *
 * Порт `backend/app/api/routes.py::get_system_usage` +
 * `backend/app/services/token_tracker.py::get_total_usage_summary`.
 * DAL хранит стоимость в микро-долларах (`llm_usage.cost_micros`), upstream —
 * в долларах с округлением до 4 знаков.
 */

import { requireUserId } from '../lib/auth.js';
import { totalUsage } from '../lib/dal/misc.js';

export interface SystemUsageResponse {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  total_cost_eur: number;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export default async function (
  input: Record<string, unknown>,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<SystemUsageResponse> {
  const userId = requireUserId(input, ctx);

  const totals = await totalUsage(userId);
  const usd = totals.costMicros / 1_000_000;

  return {
    total_prompt_tokens: totals.promptTokens,
    total_completion_tokens: totals.completionTokens,
    total_tokens: totals.promptTokens + totals.completionTokens,
    total_cost_usd: round4(usd),
    // Приблизительный курс USD → EUR (0.92), как в upstream token_tracker.
    total_cost_eur: round4(usd * 0.92),
  };
}
