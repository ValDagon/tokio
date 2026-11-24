import React from 'react';
import {
  Plus,
  Search,
  X,
  Sparkles,
  Trash2,
  ChevronRight,
  ListPlus,
  BookOpen,
} from 'lucide-react';
import type { DiaryEntrySummary, Note } from '../types';
import { getNotePreview } from '../utils';
import { RichMarkdown } from '../components/ReaderSheet';
import { useI18n } from '../i18n/index';

export interface NoteColumn {
  id: Note['column'];
  name: string;
}

export function FormattedNoteContent({ text }: { text: string }) {
  return <RichMarkdown content={text} />;
}

export interface NotesTabProps {
  notesLoading: boolean;
  notes: Note[];
  selectedNoteCol: string | null;
  setSelectedNoteCol: (col: string | null) => void;
  triggerHaptic: (type?: 'light' | 'medium' | 'success') => void;
  noteColumns: readonly NoteColumn[] | NoteColumn[];
  newNoteText: string;
  setNewNoteText: (text: string) => void;
  handleCreateNote: (e: React.FormEvent) => void;
  noteSearch: string;
  setNoteSearch: (search: string) => void;
  filteredNotes: Note[];
  expandedNotes?: Set<string>;
  toggleNoteExpanded?: (id: string) => void;
  copiedNoteId?: string | null;
  handleCopyNote?: (text: string, id: string) => void;
  handleDeleteNote: (id: string) => void;
  handleMoveNote: (noteId: string, newCol: Note['column']) => void;
  handleConvertNoteToTask?: (note: Note) => void;
  onOpenNoteReader: (note: Note) => void;
  diaryEntries?: DiaryEntrySummary[];
  diaryLoading?: boolean;
  onOpenDiaryEntry?: (date: string) => void;
}

export const NotesTab: React.FC<NotesTabProps> = ({
  notesLoading,
  notes,
  selectedNoteCol,
  setSelectedNoteCol,
  triggerHaptic,
  noteColumns,
  newNoteText,
  setNewNoteText,
  handleCreateNote,
  noteSearch,
  setNoteSearch,
  filteredNotes,
  handleDeleteNote,
  handleConvertNoteToTask,
  onOpenNoteReader,
  diaryEntries = [],
  diaryLoading = false,
  onOpenDiaryEntry,
}) => {
  const { locale, t, formatDate } = useI18n();

  const displayedDiary = React.useMemo(() => {
    const q = noteSearch.trim().toLowerCase();
    if (!q) return diaryEntries;
    return diaryEntries.filter(
      (entry) =>
        entry.date.toLowerCase().includes(q) || entry.preview.toLowerCase().includes(q),
    );
  }, [diaryEntries, noteSearch]);

  if (notesLoading && notes.length === 0 && selectedNoteCol !== 'diary') {
    return (
      <div className="empty-state" style={{ padding: 40 }}>
        <Sparkles size={28} color="var(--accent-color)" />
        <p>{t('notes.loading')}</p>
      </div>
    );
  }

  const isDiaryMode = selectedNoteCol === 'diary';
  const activeNotesCount = notes.filter((n) => n.column !== 'archive').length;
  const displayedNotes =
    selectedNoteCol === null
      ? filteredNotes.filter((n) => n.column !== 'archive')
      : filteredNotes;

  return (
    <div className="notes-container">
      {/* Column filter pills */}
      <div className="categories-bar">
        <button
          className={`category-chip ${selectedNoteCol === null ? 'active' : ''} tabular-nums`}
          onClick={() => {
            triggerHaptic('light');
            setSelectedNoteCol(null);
          }}
        >
          {t('notes.activeCount', { count: activeNotesCount })}
        </button>
        {noteColumns.map((col) => {
          const count = notes.filter((n) => n.column === col.id).length;
          return (
            <button
              key={col.id}
              className={`category-chip ${selectedNoteCol === col.id ? 'active' : ''} tabular-nums`}
              onClick={() => {
                triggerHaptic('light');
                setSelectedNoteCol(col.id);
              }}
            >
              {col.name} {count > 0 && `(${count})`}
            </button>
          );
        })}
        <button
          className={`category-chip ${isDiaryMode ? 'active' : ''} tabular-nums`}
          onClick={() => {
            triggerHaptic('light');
            setSelectedNoteCol('diary');
          }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <BookOpen size={13} strokeWidth={1.75} />
          <span>
            {t('notes.colDiary')}
            {diaryEntries.length > 0 ? ` (${diaryEntries.length})` : ''}
          </span>
        </button>
      </div>

      {/* Quick Note Input (hidden in read-only diary view) */}
      {!isDiaryMode && (
        <form onSubmit={handleCreateNote} className="note-input-bar">
          <input
            type="text"
            className="input-field note-title-input"
            aria-label={t('notes.newNoteAria')}
            placeholder={t('notes.quickNotePlaceholder')}
            value={newNoteText}
            onChange={(e) => setNewNoteText(e.target.value)}
          />
          <button
            type="submit"
            className="btn-create-note"
            disabled={!newNoteText.trim()}
            title={t('notes.addNoteTitle')}
            aria-label={t('notes.addNoteTitle')}
          >
            <Plus size={16} />
          </button>
        </form>
      )}

      {/* Search bar */}
      <div className="note-search-wrapper">
        <Search size={13} className="note-search-icon" />
        <input
          type="text"
          className="input-field note-search-input"
          aria-label={t('notes.searchAria')}
          placeholder={t('notes.searchPlaceholder')}
          value={noteSearch}
          onChange={(e) => setNoteSearch(e.target.value)}
        />
        {noteSearch && (
          <button
            type="button"
            className="btn-link note-search-clear"
            onClick={() => setNoteSearch('')}
            title={t('notes.clearSearch')}
            aria-label={t('notes.clearSearch')}
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Notes or Read-Only Diary list */}
      {isDiaryMode ? (
        <div className="notes-list">
          {diaryLoading && diaryEntries.length === 0 ? (
            <div className="empty-state" style={{ padding: 30 }}>
              <Sparkles size={28} color="var(--accent-color)" />
              <p>{t('notes.diaryLoading')}</p>
            </div>
          ) : displayedDiary.length === 0 ? (
            <div className="empty-state" style={{ padding: 30 }}>
              <BookOpen size={28} color="var(--accent-color)" strokeWidth={1.75} />
              <p>{noteSearch ? t('notes.emptySearch') : t('notes.diaryEmpty')}</p>
            </div>
          ) : (
            displayedDiary.map((entry) => {
              const dateLabel = formatDate(entry.date, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              });
              return (
                <div
                  key={entry.date}
                  className="note-card reader-preview-card"
                  onClick={() => {
                    triggerHaptic('light');
                    onOpenDiaryEntry?.(entry.date);
                  }}
                >
                  <div className="note-header">
                    <div className="note-header-left">
                      <span className="col-badge useful">{t('notes.colDiary')}</span>
                      <span className="note-date tabular-nums">{dateLabel}</span>
                      {entry.energy && (
                        <span className="col-badge tabular-nums">
                          {t('notes.diaryEnergy', { energy: entry.energy })}
                        </span>
                      )}
                    </div>
                    <div className="note-header-right">
                      <div className="note-expand-chevron" title={t('notes.openReader')}>
                        <BookOpen size={13} strokeWidth={1.75} style={{ opacity: 0.7 }} />
                        <ChevronRight size={14} strokeWidth={1.75} />
                      </div>
                    </div>
                  </div>
                  {entry.preview && (
                    <div className="note-preview-block">
                      <div className="note-preview-snippet">{entry.preview}</div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="notes-list">
        {displayedNotes.length === 0 ? (
          <div className="empty-state" style={{ padding: 30 }}>
            <Sparkles size={28} color="var(--accent-color)" />
            <p>
              {noteSearch
                ? t('notes.emptySearch')
                : selectedNoteCol
                ? t('notes.emptyCol')
                : t('notes.emptyAll')}
            </p>
          </div>
        ) : (
          displayedNotes.map((n) => {
            const noteText = n.clean_text || n.raw_text;
            const { title, snippet } = getNotePreview(noteText, locale);
            const dateStr = formatDate(n.created_at, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            });

            return (
              <div
                key={n.id}
                className="note-card reader-preview-card"
                onClick={() => {
                  triggerHaptic('light');
                  onOpenNoteReader(n);
                }}
              >
                <div className="note-header">
                  <div className="note-header-left">
                    <span className={`col-badge ${n.column}`}>
                      {noteColumns.find((c) => c.id === n.column)?.name || n.column}
                    </span>
                    <span className="note-date tabular-nums">{dateStr}</span>
                  </div>

                  <div className="note-header-right" onClick={(e) => e.stopPropagation()}>
                    {handleConvertNoteToTask && n.column !== 'archive' && (
                      <button
                        type="button"
                        className="btn-note-to-task"
                        onClick={(e) => {
                          e.stopPropagation();
                          triggerHaptic('light');
                          handleConvertNoteToTask(n);
                        }}
                        title={t('notes.toTaskTitle')}
                        aria-label={t('notes.toTaskBtn')}
                      >
                        <ListPlus size={13} />
                        <span>{t('notes.toTaskBtn')}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-link note-action-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteNote(n.id);
                      }}
                      title={t('notes.deleteNote')}
                      aria-label={t('notes.deleteNote')}
                    >
                      <Trash2 size={13} />
                    </button>
                    <div className="note-expand-chevron" title={t('notes.openReader')}>
                      <BookOpen size={13} style={{ opacity: 0.7 }} />
                      <ChevronRight size={14} />
                    </div>
                  </div>
                </div>

                <div className="note-preview-block">
                  <div className="note-preview-title">{title}</div>
                  {snippet && <div className="note-preview-snippet">{snippet}</div>}
                </div>
              </div>
            );
          })
        )}
        </div>
      )}
    </div>
  );
};
