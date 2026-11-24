import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  FileText,
  Info,
  List,
  ListPlus,
  Pencil,
  Search,
  Sparkles,
  Square,
  Trash2,
  Type,
  Wrench,
  Ban,
  X,
  AlertTriangle,
} from 'lucide-react';
import type {
  DiaryEntryDetail,
  DocChapterDetail,
  DocChapterSummary,
  Note,
  ReaderFontScale,
  ReaderSkillData,
} from '../types';
import {
  extractNoteTitleAndBody,
  extractTocHeadings,
  getNoteSummary,
  slugifyHeading,
  stripHeadingFormatting,
  stripMarkdownInline,
} from '../utils';
import { useI18n } from '../i18n/index';

export interface NoteColumnOption {
  id: Note['column'];
  name: string;
}

interface HighlightTextProps {
  text: string;
  query: string;
}

const HighlightText: React.FC<HighlightTextProps> = ({ text, query }) => {
  const q = query.trim();
  if (!q) return <>{text}</>;

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  if (parts.length === 1) return <>{text}</>;

  return (
    <>
      {parts.map((part, idx) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={idx} className="reader-mark">
            {part}
          </mark>
        ) : (
          <React.Fragment key={idx}>{part}</React.Fragment>
        )
      )}
    </>
  );
};

export interface RichMarkdownProps {
  content: string;
  highlightQuery?: string;
  onNavigateDocSlug?: (slug: string) => void;
  triggerHaptic?: (type?: 'light' | 'medium' | 'success') => void;
}

function extractDocSlugFromHref(href: string): string | null {
  const match = /(?:docs\/system\/|^)([0-9]{2}_[a-z0-9_]+|INDEX|MEMORY|AGENT_PLAYBOOK|HANDOFF)(?:\.md)?(?:#.*)?$/i.exec(
    href.trim()
  );
  if (match) {
    return match[1];
  }
  return null;
}

export const RichMarkdown: React.FC<RichMarkdownProps> = ({
  content,
  highlightQuery = '',
  onNavigateDocSlug,
  triggerHaptic,
}) => {
  const { t } = useI18n();
  const [copiedCodeIdx, setCopiedCodeIdx] = useState<number | null>(null);

  const handleCopyCode = (codeText: string, idx: number) => {
    navigator.clipboard?.writeText(codeText);
    triggerHaptic?.('light');
    setCopiedCodeIdx(idx);
    setTimeout(() => setCopiedCodeIdx(null), 1800);
  };

  const renderInline = (str: string): React.ReactNode => {
    const tokenRegex =
      /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+|\*[^*\s][^*]*\*)/g;
    const tokens = str.split(tokenRegex);

    return tokens.map((token, i) => {
      if (!token) return null;

      if (
        (token.startsWith('**') && token.endsWith('**') && token.length > 4) ||
        (token.startsWith('__') && token.endsWith('__') && token.length > 4)
      ) {
        const inner = token.slice(2, -2);
        return (
          <strong key={i} className="reader-bold">
            {renderInline(inner)}
          </strong>
        );
      }

      if (token.startsWith('~~') && token.endsWith('~~') && token.length > 4) {
        const inner = token.slice(2, -2);
        return (
          <del key={i} className="reader-strike">
            {renderInline(inner)}
          </del>
        );
      }

      if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
        const inner = token.slice(1, -1);
        const docSlug = onNavigateDocSlug ? extractDocSlugFromHref(inner) : null;
        if (docSlug && onNavigateDocSlug) {
          return (
            <button
              key={i}
              type="button"
              className="reader-doc-link-chip"
              onClick={(e) => {
                e.stopPropagation();
                triggerHaptic?.('light');
                onNavigateDocSlug(docSlug);
              }}
            >
              <BookOpen size={12} />
              <span>{inner}</span>
            </button>
          );
        }
        return (
          <code key={i} className="reader-inline-code">
            <HighlightText text={inner} query={highlightQuery} />
          </code>
        );
      }

      if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
        const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        if (linkMatch) {
          const label = stripMarkdownInline(linkMatch[1]);
          const href = linkMatch[2];
          const docSlug = extractDocSlugFromHref(href);

          if (docSlug && onNavigateDocSlug) {
            return (
              <button
                key={i}
                type="button"
                className="reader-doc-link-chip"
                onClick={(e) => {
                  e.stopPropagation();
                  triggerHaptic?.('light');
                  onNavigateDocSlug(docSlug);
                }}
              >
                <BookOpen size={12} />
                <span>
                  <HighlightText text={label} query={highlightQuery} />
                </span>
              </button>
            );
          }

          if (href.startsWith('http://') || href.startsWith('https://')) {
            return (
              <a
                key={i}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="reader-link"
                onClick={(e) => e.stopPropagation()}
              >
                <HighlightText text={label} query={highlightQuery} />
              </a>
            );
          }

          return (
            <span key={i} className="reader-inline-code">
              <HighlightText text={label} query={highlightQuery} />
            </span>
          );
        }
      }

      if (token.startsWith('http://') || token.startsWith('https://')) {
        return (
          <a
            key={i}
            href={token}
            target="_blank"
            rel="noopener noreferrer"
            className="reader-link"
            onClick={(e) => e.stopPropagation()}
          >
            <HighlightText
              text={token.replace(/^https?:\/\/(www\.)?/, '')}
              query={highlightQuery}
            />
          </a>
        );
      }

      if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
        const inner = token.slice(1, -1);
        return (
          <em key={i} className="reader-italic">
            <HighlightText text={inner} query={highlightQuery} />
          </em>
        );
      }

      return <HighlightText key={i} text={token} query={highlightQuery} />;
    });
  };

  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let headingCounter = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

      // 1. Empty line
      if (!trimmed) {
        i += 1;
        continue;
      }

      // 2. Fenced code block ```
      if (trimmed.startsWith('```')) {
        const lang = trimmed.slice(3).trim();
        const codeLines: string[] = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1; // skip closing ```
        const codeText = codeLines.join('\n');
        const blockIdx = elements.length;
        elements.push(
          <div key={`code-${blockIdx}`} className="reader-code-block">
            <div className="reader-code-header">
              <span className="reader-code-lang">{lang || 'code'}</span>
              <button
                type="button"
                className="reader-code-copy"
                onClick={() => handleCopyCode(codeText, blockIdx)}
              >
                {copiedCodeIdx === blockIdx ? (
                  <>
                    <Check size={12} color="#10b981" />
                    <span>{t('common.copied')}</span>
                  </>
                ) : (
                  <>
                    <Copy size={12} />
                    <span>{t('common.copy')}</span>
                  </>
                )}
              </button>
            </div>
            <pre className="reader-code-pre">
              <code>
                <HighlightText text={codeText} query={highlightQuery} />
              </code>
            </pre>
          </div>
        );
        continue;
      }

      // 3. Display formula block $$...$$
      if (trimmed.startsWith('$$')) {
        const formulaLines: string[] = [];
        if (trimmed.endsWith('$$') && trimmed.length > 4) {
          formulaLines.push(trimmed.slice(2, -2).trim());
          i += 1;
        } else {
          const firstRest = trimmed.slice(2).trim();
          if (firstRest) formulaLines.push(firstRest);
          i += 1;
          while (i < lines.length && !lines[i].trim().endsWith('$$')) {
            formulaLines.push(lines[i].trim());
            i += 1;
          }
          if (i < lines.length) {
            const lastRest = lines[i].trim().slice(0, -2).trim();
            if (lastRest) formulaLines.push(lastRest);
            i += 1;
          }
        }
        const cleanFormula = formulaLines
          .join(' ')
          .replace(/\\text\{([^}]+)\}/g, '$1')
          .replace(/\\sum/g, '∑')
          .replace(/\\times/g, '×')
          .replace(/\\div/g, '÷');
        elements.push(
          <div key={`math-${elements.length}`} className="reader-formula-box">
            {cleanFormula}
          </div>
        );
        continue;
      }

      // 4. Horizontal rule --- or ***
      if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
        elements.push(<hr key={`hr-${elements.length}`} className="reader-divider" />);
        i += 1;
        continue;
      }

      // 5. Headings # .. ####
      const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const rawTitle = headingMatch[2].trim();
        const cleanTitle = stripHeadingFormatting(rawTitle);
        const headingId = slugifyHeading(cleanTitle, headingCounter);
        headingCounter += 1;

        const HeadingTag =
          level === 1 ? 'h2' : level === 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
        elements.push(
          <HeadingTag
            key={`h-${elements.length}`}
            id={headingId}
            className={`reader-heading reader-h${level}`}
          >
            {level > 1 && <span className="reader-section-anchor">§</span>}
            <span>{renderInline(rawTitle)}</span>
          </HeadingTag>
        );
        i += 1;
        continue;
      }

      // 6. Markdown Table (| ... |)
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const tableLines: string[] = [];
        while (
          i < lines.length &&
          lines[i].trim().startsWith('|') &&
          lines[i].trim().endsWith('|')
        ) {
          tableLines.push(lines[i].trim());
          i += 1;
        }

        if (tableLines.length >= 2) {
          const parseRow = (rowStr: string) =>
            rowStr
              .slice(1, -1)
              .split('|')
              .map((cell) => cell.trim());

          const headerCells = parseRow(tableLines[0]);
          const isSeparator = (rowStr: string) =>
            /^\|[\s:|-]+\|$/.test(rowStr);

          const bodyStartIdx = isSeparator(tableLines[1]) ? 2 : 1;
          const bodyRows = tableLines.slice(bodyStartIdx).map(parseRow);

          elements.push(
            <div
              key={`table-${elements.length}`}
              tabIndex={0}
              role="region"
              aria-label={t('reader.tableAria')}
              className="reader-table-wrapper"
            >
              <table className="reader-table tabular-nums">
                <thead>
                  <tr>
                    {headerCells.map((cell, cIdx) => (
                      <th key={cIdx}>{renderInline(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bodyRows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) =>
                        cIdx === 0 ? (
                          <th key={cIdx} scope="row">
                            {renderInline(cell)}
                          </th>
                        ) : (
                          <td key={cIdx}>{renderInline(cell)}</td>
                        )
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          continue;
        }
      }

      // 7. Blockquotes & Callouts (> [!NOTE], > ...)
      if (trimmed.startsWith('>')) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i += 1;
        }
        const firstQuote = quoteLines[0] || '';
        const calloutMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(
          firstQuote
        );

        let calloutType = 'quote';
        let calloutLabel = '';
        const bodyLines = [...quoteLines];

        if (calloutMatch) {
          calloutType = calloutMatch[1].toLowerCase();
          const inlineAfterTag = calloutMatch[2].trim();
          if (inlineAfterTag) {
            bodyLines[0] = inlineAfterTag;
          } else {
            bodyLines.shift();
          }
          calloutLabel =
            calloutType === 'note'
              ? t('reader.calloutNote')
              : calloutType === 'tip'
              ? t('reader.calloutTip')
              : calloutType === 'important'
              ? t('reader.calloutImportant')
              : t('reader.calloutWarning');
        }

        elements.push(
          <blockquote
            key={`quote-${elements.length}`}
            className={`reader-callout reader-callout-${calloutType}`}
          >
            {calloutLabel && (
              <div className="reader-callout-title">
                {calloutType === 'warning' || calloutType === 'caution' ? (
                  <AlertTriangle size={14} />
                ) : calloutType === 'tip' ? (
                  <Sparkles size={14} />
                ) : (
                  <Info size={14} />
                )}
                <span>{calloutLabel}</span>
              </div>
            )}
            <div className="reader-callout-body">
              {bodyLines.map((ql, qIdx) => (
                <p key={qIdx} className="reader-paragraph">
                  {renderInline(ql)}
                </p>
              ))}
            </div>
          </blockquote>
        );
        continue;
      }

      // 8. Checklists (- [ ] / - [x])
      if (/^[-*]\s*\[([ xX])\]\s*/.test(trimmed)) {
        const checkItems: { done: boolean; text: string }[] = [];
        while (
          i < lines.length &&
          /^[-*]\s*\[([ xX])\]\s*/.test(lines[i].trim())
        ) {
          const lineTrim = lines[i].trim();
          const isDone = /^[-*]\s*\[[xX]\]/.test(lineTrim);
          const itemText = lineTrim.replace(/^[-*]\s*\[([ xX])\]\s*/, '');
          checkItems.push({ done: isDone, text: itemText });
          i += 1;
        }
        elements.push(
          <div key={`checks-${elements.length}`} className="reader-checklist">
            {checkItems.map((item, cIdx) => (
              <div
                key={cIdx}
                className={`reader-checklist-item ${item.done ? 'checked' : ''}`}
              >
                <span className="reader-checklist-icon">
                  {item.done ? <CheckSquare size={15} /> : <Square size={15} />}
                </span>
                <span className="reader-checklist-text">
                  {renderInline(item.text)}
                </span>
              </div>
            ))}
          </div>
        );
        continue;
      }

      // 9. Lists (Ordered & Unordered, with nested sub-items support)
      const isListLine = (lineStr: string) =>
        /^\s*(?:[-*•]|\d+\.)\s+/.test(lineStr);

      if (isListLine(rawLine)) {
        interface ListItemNode {
          ordered: boolean;
          markerLabel: string;
          text: string;
          children: string[];
        }
        const items: ListItemNode[] = [];

        while (i < lines.length && isListLine(lines[i])) {
          const currentRaw = lines[i];
          const indent = currentRaw.match(/^\s*/)?.[0].length ?? 0;
          const currentTrimmed = currentRaw.trim();
          const orderedMatch = /^(\d+)\.\s+(.*)$/.exec(currentTrimmed);
          const bulletMatch = /^[-*•]\s+(.*)$/.exec(currentTrimmed);

          if (indent >= 2 && items.length > 0) {
            const subText = orderedMatch
              ? orderedMatch[2]
              : bulletMatch
              ? bulletMatch[1]
              : currentTrimmed;
            items[items.length - 1].children.push(subText);
          } else if (orderedMatch) {
            items.push({
              ordered: true,
              markerLabel: `${orderedMatch[1]}.`,
              text: orderedMatch[2],
              children: [],
            });
          } else if (bulletMatch) {
            items.push({
              ordered: false,
              markerLabel: '•',
              text: bulletMatch[1],
              children: [],
            });
          }
          i += 1;
        }

        const isOrderedList = items.length > 0 && items[0].ordered;
        const ListTag = isOrderedList ? 'ol' : 'ul';

        elements.push(
          <ListTag
            key={`list-${elements.length}`}
            className={`reader-list ${isOrderedList ? 'ordered' : 'unordered'}`}
          >
            {items.map((item, idx) => (
              <li key={idx} className="reader-list-item">
                <div className="reader-list-item-main">{renderInline(item.text)}</div>
                {item.children.length > 0 && (
                  <ul className="reader-sublist">
                    {item.children.map((sub, sIdx) => (
                      <li key={sIdx} className="reader-sublist-item">
                        {renderInline(sub)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ListTag>
        );
        continue;
      }

      // 10. Regular paragraph
      elements.push(
        <p key={`p-${elements.length}`} className="reader-paragraph">
          {renderInline(trimmed)}
        </p>
      );
      i += 1;
    }

  return <div className="reader-markdown-body">{elements}</div>;
};

export interface ReaderSheetProps {
  mode: 'note' | 'doc' | 'dossier' | 'skill' | 'diary';
  onClose: () => void;
  triggerHaptic: (type?: 'light' | 'medium' | 'success') => void;

  // Font scale
  fontScale: ReaderFontScale;
  onChangeFontScale: (scale: ReaderFontScale) => void;

  // Note mode props
  note?: Note | null;
  noteColumns?: readonly NoteColumnOption[];
  onMoveNote?: (noteId: string, col: Note['column']) => void;
  onConvertNoteToTask?: (note: Note) => void;
  onDeleteNote?: (noteId: string) => void;
  onSaveNoteText?: (noteId: string, newText: string) => Promise<void>;
  onPrevNote?: (() => void) | null;
  onNextNote?: (() => void) | null;
  notePositionLabel?: string;

  // Doc mode props
  docChapter?: DocChapterSummary | DocChapterDetail | null;
  loadingDocDetail?: boolean;
  initialSectionTitle?: string | null;
  onSelectDocChapter?: (slug: string, sectionTitle?: string) => void;
  onPrevDoc?: (() => void) | null;
  onNextDoc?: (() => void) | null;
  docPositionLabel?: string;

  // Dossier mode props
  dossierContent?: string;
  onRefreshDossier?: () => void;
  loadingDossier?: boolean;

  // Skill mode props
  skill?: ReaderSkillData | null;
  onActivateSkill?: (skillId: string) => Promise<void>;
  onRejectSkill?: (skillId: string) => Promise<boolean | void>;

  // Diary mode props (read-only)
  diaryEntry?: DiaryEntryDetail | null;
  loadingDiary?: boolean;
  onPrevDiary?: (() => void) | null;
  onNextDiary?: (() => void) | null;
  diaryPositionLabel?: string;
}

const FONT_SCALE_ORDER: readonly ReaderFontScale[] = ['normal', 'large', 'xlarge'];
const FONT_SCALE_LABELS: Record<ReaderFontScale, string> = {
  normal: '15px',
  large: '17px',
  xlarge: '19px',
};

export const ReaderSheet: React.FC<ReaderSheetProps> = ({
  mode,
  onClose,
  triggerHaptic,
  fontScale,
  onChangeFontScale,
  note,
  noteColumns = [],
  onMoveNote,
  onConvertNoteToTask,
  onDeleteNote,
  onSaveNoteText,
  onPrevNote,
  onNextNote,
  notePositionLabel,
  docChapter,
  loadingDocDetail,
  initialSectionTitle,
  onSelectDocChapter,
  onPrevDoc,
  onNextDoc,
  docPositionLabel,
  dossierContent = '',
  onRefreshDossier,
  loadingDossier,
  skill,
  onActivateSkill,
  onRejectSkill,
  diaryEntry,
  loadingDiary,
  onPrevDiary,
  onNextDiary,
  diaryPositionLabel,
}) => {
  const { locale, t, formatDate } = useI18n();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedAll, setCopiedAll] = useState(false);
  const [showTocList, setShowTocList] = useState(false);
  const [skillBusy, setSkillBusy] = useState(false);

  // Note editing state (keyed by note.id so switching notes automatically exits edit mode)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const isEditingNote = Boolean(mode === 'note' && note && editingNoteId === note.id);

  // Reset scroll position when switching items
  const activeItemKey =
    mode === 'note'
      ? note?.id
      : mode === 'doc'
      ? docChapter?.slug
      : mode === 'skill'
      ? `skill-${skill?.source}-${skill?.id}`
      : mode === 'diary'
      ? `diary-${diaryEntry?.date}`
      : 'dossier';

  useEffect(() => {
    if (scrollContainerRef.current && !initialSectionTitle) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [activeItemKey, initialSectionTitle]);

  // Assemble full markdown content for reading
  const fullMarkdown = useMemo(() => {
    if (mode === 'note' && note) {
      return note.clean_text || note.raw_text || '';
    }
    if (mode === 'doc' && docChapter) {
      if (docChapter.content && docChapter.content.trim()) {
        return docChapter.content;
      }
      if (docChapter.sections && docChapter.sections.length > 0) {
        return [
          `# ${docChapter.title}`,
          ...docChapter.sections.map(
            (s) => `${'#'.repeat(Math.max(2, s.level))} ${s.section_title}\n\n${s.content}`
          ),
        ].join('\n\n');
      }
      return `# ${docChapter.title}\n\n${docChapter.summary}`;
    }
    if (mode === 'dossier') {
      return dossierContent || '';
    }
    if (mode === 'skill' && skill) {
      return skill.body || '';
    }
    if (mode === 'diary' && diaryEntry) {
      return diaryEntry.content || '';
    }
    return '';
  }, [mode, note, docChapter, dossierContent, skill, diaryEntry]);

  const tocHeadings = useMemo(() => {
    const all = extractTocHeadings(fullMarkdown);
    // Skip top H1 if there are H2/H3 sections below it
    if (all.length > 1 && all[0].level === 1) {
      return all.slice(1);
    }
    return all;
  }, [fullMarkdown]);

  // Scroll to initialSectionTitle when opened from section search pill
  useEffect(() => {
    if (!initialSectionTitle || tocHeadings.length === 0) return;
    const targetLower = initialSectionTitle.toLowerCase();
    const found = tocHeadings.find((h) =>
      h.title.toLowerCase().includes(targetLower)
    );
    if (found) {
      const timer = setTimeout(() => {
        const el = document.getElementById(found.id);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [initialSectionTitle, tocHeadings]);

  // Keyboard Escape handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleCycleFontScale = () => {
    triggerHaptic('light');
    const idx = FONT_SCALE_ORDER.indexOf(fontScale);
    const next = FONT_SCALE_ORDER[(idx + 1) % FONT_SCALE_ORDER.length];
    onChangeFontScale(next);
  };

  const handleCopyFullText = () => {
    navigator.clipboard?.writeText(fullMarkdown);
    triggerHaptic('success');
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1800);
  };

  const handleJumpToHeading = (headingId: string) => {
    triggerHaptic('light');
    setShowTocList(false);
    const el = document.getElementById(headingId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleSaveNoteEdit = async () => {
    if (!note || !onSaveNoteText || !editDraft.trim() || isSavingEdit) return;
    try {
      setIsSavingEdit(true);
      triggerHaptic('medium');
      await onSaveNoteText(note.id, editDraft.trim());
      setEditingNoteId(null);
      triggerHaptic('success');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const headerBadgeText =
    mode === 'note' && note
      ? noteColumns.find((c) => c.id === note.column)?.name || note.column
      : mode === 'doc'
      ? t('reader.docsBadge')
      : mode === 'diary'
      ? t('reader.diaryBadge')
      : mode === 'skill' && skill
      ? skill.source === 'builtin'
        ? t('skills.builtinBadge')
        : skill.status || t('skills.userBadge')
      : t('reader.dossierBadge');

  const headerTitle =
    mode === 'note' && note
      ? getNoteSummary(fullMarkdown, locale)
      : mode === 'doc' && docChapter
      ? docChapter.title
      : mode === 'diary' && diaryEntry
      ? formatDate(diaryEntry.date, { day: 'numeric', month: 'long', year: 'numeric' })
      : mode === 'skill' && skill
      ? skill.title
      : t('reader.dossierTitle');

  const [hasTgBack, setHasTgBack] = useState(() => {
    if (typeof window === 'undefined') return false;
    return Boolean(
      window.Telegram?.WebApp?.BackButton?.isVisible ||
        (document.body.classList.contains('in-telegram') &&
          window.Telegram?.WebApp?.BackButton)
    );
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const checkBack = () => {
      const active = Boolean(
        window.Telegram?.WebApp?.BackButton?.isVisible ||
          (document.body.classList.contains('in-telegram') &&
            window.Telegram?.WebApp?.BackButton)
      );
      setHasTgBack(active);
    };
    checkBack();
    const timer = setTimeout(checkBack, 50);
    return () => clearTimeout(timer);
  }, []);

  const { title: noteTitle, body: noteBody, hasExplicitHeading } = useMemo(() => {
    if (mode === 'note' && note) {
      return extractNoteTitleAndBody(fullMarkdown, locale);
    }
    return {
      title: headerTitle,
      body: fullMarkdown,
      hasExplicitHeading: false,
    };
  }, [mode, note, fullMarkdown, headerTitle, locale]);

  const prevHandler =
    mode === 'note'
      ? onPrevNote
      : mode === 'doc'
      ? onPrevDoc
      : mode === 'diary'
      ? onPrevDiary
      : null;
  const nextHandler =
    mode === 'note'
      ? onNextNote
      : mode === 'doc'
      ? onNextDoc
      : mode === 'diary'
      ? onNextDiary
      : null;
  const positionLabel =
    mode === 'note'
      ? notePositionLabel
      : mode === 'doc'
      ? docPositionLabel
      : mode === 'diary'
      ? diaryPositionLabel
      : undefined;

  return (
    <div
      className="reader-sheet-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={headerTitle}
    >
      {/* Sticky Safe-Area Aware Top Bar */}
      <header className="reader-sheet-header">
        <div className="reader-header-top-row">
          {hasTgBack ? (
            <span className="reader-tg-badge">{headerBadgeText}</span>
          ) : (
            <button
              type="button"
              className="reader-back-btn"
              onClick={() => {
                triggerHaptic('light');
                onClose();
              }}
              aria-label={t('reader.closeAria')}
            >
              <ArrowLeft size={17} strokeWidth={2} />
              <span>{t('common.back')}</span>
            </button>
          )}

          <div className="reader-header-actions">
            {/* Font size cycling button (15px -> 17px -> 19px) */}
            <button
              type="button"
              className="reader-icon-btn reader-font-btn tabular-nums"
              onClick={handleCycleFontScale}
              title={t('reader.fontScaleTitle')}
              aria-label={t('reader.fontScaleAria', { scale: FONT_SCALE_LABELS[fontScale] })}
            >
              <Type size={14} />
              <span>{FONT_SCALE_LABELS[fontScale]}</span>
            </button>

            {/* TOC toggle if document has sections */}
            {tocHeadings.length > 1 && (
              <button
                type="button"
                className={`reader-icon-btn ${showTocList ? 'active' : ''} tabular-nums`}
                onClick={() => {
                  triggerHaptic('light');
                  setShowTocList((v) => !v);
                }}
                title={t('reader.tocTitle')}
                aria-label={t('reader.tocTitle')}
              >
                <List size={15} />
                <span>§ {tocHeadings.length}</span>
              </button>
            )}

            {/* In-document search toggle */}
            <button
              type="button"
              className={`reader-icon-btn ${showSearch || Boolean(searchQuery) ? 'active' : ''}`}
              onClick={() => {
                triggerHaptic('light');
                setShowSearch((v) => !v);
              }}
              title={t('reader.searchTitle')}
              aria-label={t('reader.searchTitle')}
            >
              <Search size={15} />
            </button>

            {/* Edit note button */}
            {mode === 'note' && note && onSaveNoteText && (
              <button
                type="button"
                className={`reader-icon-btn ${isEditingNote ? 'active' : ''}`}
                onClick={() => {
                  triggerHaptic('light');
                  if (isEditingNote) {
                    setEditingNoteId(null);
                  } else {
                    setEditDraft(note.clean_text || note.raw_text || '');
                    setEditingNoteId(note.id);
                  }
                }}
                title={t('reader.editNoteTitle')}
                aria-label={t('reader.editNoteTitle')}
              >
                <Pencil size={14} />
              </button>
            )}

            {/* Copy full text button */}
            <button
              type="button"
              className="reader-icon-btn"
              onClick={handleCopyFullText}
              title={t('reader.copyAllTitle')}
              aria-label={t('reader.copyAllTitle')}
            >
              {copiedAll ? <Check size={15} color="#10b981" /> : <Copy size={15} />}
            </button>
          </div>
        </div>

        {/* Collapsible In-Document Search Bar */}
        {showSearch && (
          <div className="reader-search-bar">
            <Search size={14} className="reader-search-icon" />
            <input
              type="text"
              className="input-field reader-search-input"
              placeholder={t('reader.searchPlaceholder')}
              aria-label={t('reader.searchAria')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
            {searchQuery && (
              <button
                type="button"
                className="btn-link reader-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label={t('reader.clearSearch')}
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {/* Expandable Table of Contents (TOC) Drawer */}
        {showTocList && tocHeadings.length > 1 && (
          <div className="reader-toc-drawer">
            <div className="reader-toc-drawer-title">{t('reader.tocQuickJump')}</div>
            <div className="reader-toc-pills">
              {tocHeadings.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className={`reader-toc-pill level-${h.level}`}
                  onClick={() => handleJumpToHeading(h.id)}
                >
                  <span className="reader-toc-symbol">§</span>
                  <span>{h.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* Main Scrollable Reading Canvas */}
      <div
        ref={scrollContainerRef}
        className={`reader-sheet-body font-scale-${fontScale}`}
      >
        {/* Document Metadata Subheader */}
        <div className="reader-doc-meta">
          <div className="reader-doc-meta-left">
            {mode === 'note' && note ? (
              <span className={`col-badge ${note.column}`}>{headerBadgeText}</span>
            ) : mode === 'doc' ? (
              <span className="reader-source-badge">
                <BookOpen size={12} />
                <span>{docChapter?.filename || 'docs/system'}</span>
              </span>
            ) : mode === 'diary' ? (
              <span className="reader-source-badge">
                <BookOpen size={12} />
                <span className="tabular-nums">{diaryEntry?.date || t('reader.diaryBadge')}</span>
              </span>
            ) : mode === 'skill' && skill ? (
              <>
                <span className="reader-source-badge">
                  <Wrench size={12} />
                  <span>{skill.subtitle || skill.id}</span>
                </span>
                {skill.status && (
                  <span className="reader-source-badge">{skill.status}</span>
                )}
                {(skill.runs !== undefined || skill.views !== undefined) && (
                  <span className="note-date tabular-nums">
                    {t('skills.telemetry', { runs: skill.runs ?? 0, views: skill.views ?? 0 })}
                  </span>
                )}
              </>
            ) : (
              <span className="reader-source-badge">
                <Database size={12} />
                <span>{t('reader.snapshotBadge')}</span>
              </span>
            )}
            {mode === 'note' && note && (
              <span className="note-date tabular-nums">
                {formatDate(note.created_at, {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </div>

          {mode === 'dossier' && onRefreshDossier && (
            <button
              type="button"
              className="btn-link"
              onClick={onRefreshDossier}
              disabled={loadingDossier}
              style={{ fontSize: 12.5, fontWeight: 600 }}
            >
              {loadingDossier ? t('reader.refreshingDossier') : t('reader.refreshDossier')}
            </button>
          )}
        </div>

        {mode === 'skill' && skill && skill.triggers && skill.triggers.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {skill.triggers.map((trig) => (
              <span key={trig} className="category-chip" style={{ fontSize: 11.5, padding: '2px 8px' }}>
                {trig}
              </span>
            ))}
          </div>
        )}

        {/* Horizontal Quick Section Chips for Docs */}
        {!showTocList && tocHeadings.length > 1 && !isEditingNote && (
          <div className="reader-inline-toc-strip" role="navigation" aria-label={t('reader.docSectionsAria')}>
            {tocHeadings.map((h) => (
              <button
                key={h.id}
                type="button"
                className="reader-inline-toc-chip"
                onClick={() => handleJumpToHeading(h.id)}
              >
                <span className="reader-toc-symbol">§</span>
                <span>{h.title}</span>
              </button>
            ))}
          </div>
        )}

        {/* Content or Note Editor */}
        {(loadingDocDetail || loadingDiary) && !fullMarkdown ? (
          <div className="empty-state" style={{ padding: 48 }}>
            <Sparkles size={28} color="var(--accent-color)" />
            <p>{loadingDiary ? t('reader.loadingDiary') : t('reader.loadingChapter')}</p>
          </div>
        ) : isEditingNote && mode === 'note' && note ? (
          <div className="reader-note-editor">
            <label htmlFor="reader-note-textarea" className="reader-editor-label">
              {t('reader.editLabel')}
            </label>
            <textarea
              id="reader-note-textarea"
              className="reader-editor-textarea"
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              rows={12}
              autoFocus
            />
            <div className="reader-editor-actions">
              <button
                type="button"
                className="btn-link"
                onClick={() => setEditingNoteId(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={isSavingEdit || !editDraft.trim()}
                onClick={handleSaveNoteEdit}
              >
                {isSavingEdit ? t('common.saving') : t('reader.saveChanges')}
              </button>
            </div>
          </div>
        ) : (
          <article className="reader-article">
            {mode === 'note' &&
              note &&
              !hasExplicitHeading && (
                <h2 className="reader-note-main-title">
                  <FileText size={18} color="var(--accent-color)" style={{ flexShrink: 0, marginTop: 3 }} />
                  <span>
                    <HighlightText text={noteTitle} query={searchQuery} />
                  </span>
                </h2>
              )}
            {noteBody.trim() ? (
              <RichMarkdown
                content={noteBody}
                highlightQuery={searchQuery}
                onNavigateDocSlug={
                  onSelectDocChapter
                    ? (slug) => onSelectDocChapter(slug)
                    : undefined
                }
                triggerHaptic={triggerHaptic}
              />
            ) : null}
          </article>
        )}

        {/* Note Triage Controls inside Reader */}
        {mode === 'note' && note && !isEditingNote && (
          <div className="reader-note-triage-panel">
            <div className="reader-triage-label">{t('reader.moveNoteLabel')}</div>
            <div className="note-column-chips">
              {noteColumns.map((col) => {
                const isCurrent = note.column === col.id;
                return (
                  <button
                    key={col.id}
                    type="button"
                    className={`note-col-chip ${isCurrent ? 'active' : ''}`}
                    onClick={() => {
                      if (!isCurrent && onMoveNote) {
                        triggerHaptic('light');
                        onMoveNote(note.id, col.id);
                      }
                    }}
                  >
                    {col.name}
                  </button>
                );
              })}
            </div>

            <div className="reader-note-bottom-actions">
              {onConvertNoteToTask && note.column !== 'archive' && (
                <button
                  type="button"
                  className="btn-note-to-task"
                  onClick={() => {
                    triggerHaptic('medium');
                    onConvertNoteToTask(note);
                    onClose();
                  }}
                >
                  <ListPlus size={14} />
                  <span>{t('reader.toTaskBtn')}</span>
                </button>
              )}

              {onDeleteNote && (
                <button
                  type="button"
                  className="reader-delete-note-btn"
                  onClick={() => {
                    triggerHaptic('light');
                    onDeleteNote(note.id);
                    onClose();
                  }}
                >
                  <Trash2 size={14} />
                  <span>{t('reader.toTrashBtn')}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* User Skill Approval / Toggle Controls inside Reader */}
        {mode === 'skill' && skill && skill.source === 'user' && (onActivateSkill || onRejectSkill) && (
          <div className="reader-note-triage-panel">
            <div className="reader-note-bottom-actions">
              {onActivateSkill && skill.status !== 'active' && (
                <button
                  type="button"
                  className="btn-note-to-task"
                  disabled={skillBusy}
                  onClick={async () => {
                    try {
                      setSkillBusy(true);
                      triggerHaptic('medium');
                      await onActivateSkill(skill.id);
                      onClose();
                    } finally {
                      setSkillBusy(false);
                    }
                  }}
                >
                  <Check size={14} />
                  <span>{t('skills.activateBtn')}</span>
                </button>
              )}

              {onRejectSkill && (skill.status === 'pending' || skill.status === 'active') && (
                <button
                  type="button"
                  className="reader-delete-note-btn"
                  disabled={skillBusy}
                  onClick={async () => {
                    try {
                      setSkillBusy(true);
                      triggerHaptic('light');
                      const ok = await onRejectSkill(skill.id);
                      if (ok !== false) {
                        onClose();
                      }
                    } finally {
                      setSkillBusy(false);
                    }
                  }}
                >
                  <Ban size={14} />
                  <span>
                    {skill.status === 'active' ? t('skills.disableBtn') : t('skills.rejectBtn')}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Sequential Navigation Footer (Prev / Next) */}
      {(prevHandler || nextHandler || positionLabel) && (
        <footer className="reader-sheet-footer">
          <button
            type="button"
            className="reader-nav-step-btn"
            disabled={!prevHandler}
            onClick={() => {
              if (prevHandler) {
                triggerHaptic('light');
                prevHandler();
              }
            }}
          >
            <ChevronLeft size={16} />
            <span>{t('common.prev')}</span>
          </button>

          {positionLabel && (
            <span className="reader-nav-position tabular-nums">{positionLabel}</span>
          )}

          <button
            type="button"
            className="reader-nav-step-btn"
            disabled={!nextHandler}
            onClick={() => {
              if (nextHandler) {
                triggerHaptic('light');
                nextHandler();
              }
            }}
          >
            <span>{t('common.next')}</span>
            <ChevronRight size={16} />
          </button>
        </footer>
      )}
    </div>
  );
};
