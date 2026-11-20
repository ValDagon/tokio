/**
 * Паритет Python ↔ TS: повторяющиеся задачи (ADR-004).
 *
 * Python-референс — `calculate_next_occurrence()` (`legacy/backend/app/services/tasks.py`).
 * TS-реализация — `nextOccurrence()` (`src/lib/dal/tasks.ts`).
 *
 * Кейсы фикстуры несут оба представления правила: `pythonRule` (строка вида
 * `daily`, `weekly:2`) и `tsRule` (`RecurrenceRule`). База и «сейчас» — моменты
 * с фиксированным смещением +02:00, поэтому шаги считаются в UTC и DST-сдвиги
 * Python не вмешиваются.
 *
 * Паритет полный: и семантика шага (день/7 дней/месяц с клампом дня/год), и
 * клампинг 31 → 28/30 совпадают, включая weekly-across-DST.
 *
 * Осознанно вне паритета: `weekdays` у weekly (в Python его нет — TS-расширение),
 * `count` (обрабатывается в `completeTask`, а не в `nextOccurrence`).
 */

import { describe, expect, it } from 'vitest';
import { nextOccurrence } from '../../src/lib/dal/tasks';
import type { RecurrenceRule } from '../../src/types';
import { recurrenceFixture } from './loader';

const NOW = new Date(recurrenceFixture.now);

describe('recurrence: nextOccurrence()', () => {
  it('все 23 кейса дают тот же момент, что Python', () => {
    expect(recurrenceFixture.cases.length).toBe(23);

    for (const testCase of recurrenceFixture.cases) {
      const rule = testCase.tsRule as RecurrenceRule;
      const next = nextOccurrence(rule, new Date(testCase.base), NOW);

      if (testCase.pythonEpochMs === null) {
        expect(next, `${testCase.id}: python → null`).toBeNull();
        continue;
      }

      expect(next, `${testCase.id}: python не null`).not.toBeNull();
      expect(next?.getTime(), `${testCase.id} (${testCase.pythonRule})`).toBe(
        testCase.pythonEpochMs,
      );
      expect(next?.toISOString(), `${testCase.id}: iso`).toBe(
        new Date(testCase.pythonIso as string).toISOString(),
      );
    }
  });

  it('результат строго позже now', () => {
    for (const testCase of recurrenceFixture.cases) {
      const next = nextOccurrence(testCase.tsRule as RecurrenceRule, new Date(testCase.base), NOW);
      if (next === null) continue;
      expect(next.getTime(), testCase.id).toBeGreaterThan(NOW.getTime());
    }
  });

  it('месячные повторы клампят день: 31 → конец короткого месяца', () => {
    const monthly = recurrenceFixture.cases.filter(
      (c) => c.tsRule.freq === 'monthly' && c.pythonEpochMs !== null,
    );
    expect(monthly.length).toBeGreaterThan(0);
    for (const testCase of monthly) {
      const next = nextOccurrence(testCase.tsRule as RecurrenceRule, new Date(testCase.base), NOW);
      expect(next?.getTime(), testCase.id).toBe(testCase.pythonEpochMs);
    }
  });
});
