import React from 'react';
import {
  Sparkles,
  Pill,
  Trash2,
  Clock,
  CheckCircle2,
  Check,
  SkipForward,
  Info,
} from 'lucide-react';
import type { Medication } from '../types';
import { useI18n } from '../i18n/index';

export interface MedsTabProps {
  medsLoading: boolean;
  medications: Medication[];
  isAddingMed: boolean;
  setIsAddingMed: (val: boolean) => void;
  newMedName: string;
  setNewMedName: (val: string) => void;
  newMedDosage: string;
  setNewMedDosage: (val: string) => void;
  newMedTimes: string;
  setNewMedTimes: (val: string) => void;
  newMedInstructions: string;
  setNewMedInstructions: (val: string) => void;
  isSubmittingMed: boolean;
  handleCreateMedication: (e: React.FormEvent) => void;
  handleTakeMed: (medId: string, scheduledTime: string) => void;
  handleSkipMed: (medId: string, scheduledTime: string) => void;
  handleDeleteMedication: (medId: string) => void;
}

export const MedsTab: React.FC<MedsTabProps> = ({
  medsLoading,
  medications,
  isAddingMed,
  setIsAddingMed,
  newMedName,
  setNewMedName,
  newMedDosage,
  setNewMedDosage,
  newMedTimes,
  setNewMedTimes,
  newMedInstructions,
  setNewMedInstructions,
  isSubmittingMed,
  handleCreateMedication,
  handleTakeMed,
  handleSkipMed,
  handleDeleteMedication,
}) => {
  const { t } = useI18n();
  if (medsLoading && medications.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 40 }}>
        <Sparkles size={28} color="var(--accent-color)" />
        <p>{t('meds.loading')}</p>
      </div>
    );
  }

  let totalLogs = 0;
  let takenLogs = 0;
  let pendingLogs = 0;

  for (const m of medications) {
    for (const log of m.today_logs) {
      totalLogs += 1;
      if (log.status === 'taken') takenLogs += 1;
      else if (log.status === 'pending') pendingLogs += 1;
    }
  }

  const pct = totalLogs > 0 ? Math.round((takenLogs / totalLogs) * 100) : 0;

  return (
    <div className="meds-container">
      {/* Top Stats Banner */}
      <div className="med-summary-card">
        <div className="med-summary-header">
          <div>
            <div className="med-summary-title">{t('meds.todayIntake')}</div>
            <div className="med-summary-sub">
              {totalLogs === 0
                ? t('meds.emptyBanner')
                : pendingLogs === 0
                ? t('meds.allTaken')
                : t('meds.remainingBanner', { pending: pendingLogs, total: totalLogs })}
            </div>
          </div>
          {totalLogs > 0 && (
            <span className="med-summary-badge">
              {takenLogs} / {totalLogs}
            </span>
          )}
        </div>

        {totalLogs > 0 && (
          <div className="med-progress-track">
            <div
              className="med-progress-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>

      {/* Today's Schedule Section */}
      <div className="section-header-row">
        <span className="section-title">{t('meds.todaySchedule')}</span>
        <button
          className="btn-link"
          onClick={() => setIsAddingMed(!isAddingMed)}
          style={{ fontSize: 13, fontWeight: 600 }}
        >
          {isAddingMed ? t('common.cancel') : t('meds.addMed')}
        </button>
      </div>

      {/* Add Medication Form */}
      {isAddingMed && (
        <form onSubmit={handleCreateMedication} className="med-form-card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
            {t('meds.newMedTitle')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              type="text"
              className="input-field"
              aria-label={t('meds.namePlaceholder')}
              placeholder={t('meds.namePlaceholder')}
              value={newMedName}
              onChange={(e) => setNewMedName(e.target.value)}
              required
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                className="input-field"
                style={{ flex: 1 }}
                aria-label={t('meds.dosagePlaceholder')}
                placeholder={t('meds.dosagePlaceholder')}
                value={newMedDosage}
                onChange={(e) => setNewMedDosage(e.target.value)}
                required
              />
              <input
                type="text"
                className="input-field"
                style={{ flex: 1 }}
                aria-label={t('meds.timesPlaceholder')}
                placeholder={t('meds.timesPlaceholder')}
                value={newMedTimes}
                onChange={(e) => setNewMedTimes(e.target.value)}
                required
              />
            </div>
            <input
              type="text"
              className="input-field"
              aria-label={t('meds.instructionsPlaceholder')}
              placeholder={t('meds.instructionsPlaceholder')}
              value={newMedInstructions}
              onChange={(e) => setNewMedInstructions(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                className="btn-link"
                onClick={() => setIsAddingMed(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={isSubmittingMed || !newMedName.trim() || !newMedDosage.trim()}
              >
                {isSubmittingMed ? t('common.saving') : t('common.add')}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Medications List */}
      {medications.length === 0 ? (
        <div className="empty-state" style={{ padding: 30 }}>
          <Pill size={32} color="var(--accent-color)" />
          <p>{t('meds.emptyMeds')}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {medications.map((m) => (
            <div key={m.id} className="med-card">
              <div className="med-card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Pill size={18} color="var(--accent-color)" />
                  <span className="med-name">{m.name}</span>
                  <span className="med-dosage-badge">{m.dosage}</span>
                </div>
                <button
                  className="btn-link"
                  onClick={() => handleDeleteMedication(m.id)}
                  style={{ padding: 2, opacity: 0.6 }}
                  title={t('meds.deleteMed')}
                  aria-label={t('meds.deleteMed')}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {m.instructions && (
                <div className="med-instructions" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Info size={13} strokeWidth={1.75} />
                  <span>{m.instructions}</span>
                </div>
              )}

              <div className="med-intakes-list">
                {m.today_logs.map((log) => {
                  const isTaken = log.status === 'taken';
                  const isSkipped = log.status === 'skipped';
                  const isPending = log.status === 'pending';

                  return (
                    <div key={log.scheduled_time} className="med-intake-row">
                      <div className="med-time-tag tabular-nums">
                        <Clock size={13} strokeWidth={1.75} style={{ opacity: 0.7 }} />
                        <span>{log.scheduled_time}</span>
                      </div>

                      {isTaken && (
                        <div className="med-status-taken">
                          <CheckCircle2 size={15} strokeWidth={1.75} />
                          <span>{t('meds.taken')}</span>
                        </div>
                      )}

                      {isSkipped && (
                        <div className="med-status-skipped" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <SkipForward size={13} strokeWidth={1.75} />
                          <span>{t('meds.skipped')}</span>
                        </div>
                      )}

                      {isPending && (
                        <div className="med-actions">
                          <button
                            type="button"
                            className="btn-take"
                            onClick={() => handleTakeMed(m.id, log.scheduled_time)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                          >
                            <Check size={14} strokeWidth={1.75} />
                            <span>{t('meds.takeBtn')}</span>
                          </button>
                          <button
                            type="button"
                            className="btn-skip"
                            onClick={() => handleSkipMed(m.id, log.scheduled_time)}
                          >
                            {t('meds.skipBtn')}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
