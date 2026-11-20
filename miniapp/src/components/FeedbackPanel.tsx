/**
 * FeedbackPanel — бета-форма обратной связи в мини-аппе.
 *
 * Три вида записей (отзыв / предложение / багрепорт), отправка на
 * POST /api/feedback/create, список своих записей из GET /api/feedback/list.
 * Админу дополнительно доступен режим «все записи» (backend сам проверяет роль).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Send, Bug, Lightbulb, Heart } from 'lucide-react';
import { request } from '../api';
import { useI18n } from '../i18n/index';

type FeedbackKind = 'feedback' | 'suggestion' | 'bug';
type FeedbackStatus = 'new' | 'ack' | 'done';

interface FeedbackItem {
  id: number;
  kind: FeedbackKind;
  text: string;
  status: FeedbackStatus;
  createdAt: string | null;
  userId?: number;
}

const MAX_TEXT = 4000;

export const FeedbackPanel: React.FC<{ isAdmin?: boolean }> = ({ isAdmin = false }) => {
  const { t } = useI18n();
  const [kind, setKind] = useState<FeedbackKind>('feedback');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sentMsg, setSentMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  const kindLabel: Record<FeedbackKind, string> = {
    feedback: t('feedback.kindFeedback'),
    suggestion: t('feedback.kindSuggestion'),
    bug: t('feedback.kindBug'),
  };

  const kindOptions: ReadonlyArray<{ kind: FeedbackKind; label: string; icon: React.ReactNode }> = [
    { kind: 'feedback', label: t('feedback.labelFeedback'), icon: <Heart size={14} /> },
    { kind: 'suggestion', label: t('feedback.labelSuggestion'), icon: <Lightbulb size={14} /> },
    { kind: 'bug', label: t('feedback.labelBug'), icon: <Bug size={14} /> },
  ];

  const loadList = useCallback(async (all: boolean) => {
    try {
      const res = await request<{ items: FeedbackItem[] }>('/api/feedback', {
        method: all ? 'POST' : 'GET',
        body: all ? { action: 'list', all: true } : undefined,
      });
      setItems(res.items ?? []);
    } catch {
      // list is non-critical: form remains available
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadList(false);
  }, [loadList]);

  const submit = useCallback(async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    setSentMsg(null);
    try {
      await request('/api/feedback', {
        method: 'POST',
        body: { kind, text, context: navigator.userAgent.slice(0, 200) },
      });
      setSentMsg(t('feedback.sentOk'));
      setText('');
      await loadList(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('feedback.sendError'));
    } finally {
      setSending(false);
    }
  }, [kind, text, sending, loadList, t]);

  return (
    <div className="system-accordion-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <MessageSquare size={18} color="var(--accent-color)" />
        <div style={{ fontWeight: 600 }}>{t('feedback.title')}</div>
      </div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
        {t('feedback.desc')}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {kindOptions.map((option) => (
          <button
            key={option.kind}
            onClick={() => setKind(option.kind)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '6px 10px',
              borderRadius: 10,
              border: kind === option.kind ? '1px solid var(--accent-color)' : '1px solid rgba(128,128,128,0.35)',
              background: kind === option.kind ? 'rgba(120,120,255,0.12)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value.slice(0, MAX_TEXT))}
        placeholder={kind === 'bug' ? t('feedback.placeholderBug') : t('feedback.placeholderDefault')}
        rows={4}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          borderRadius: 10,
          border: '1px solid rgba(128,128,128,0.35)',
          background: 'rgba(255,255,255,0.04)',
          color: 'inherit',
          padding: 10,
          fontSize: 14,
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <span style={{ fontSize: 11, opacity: 0.6 }}>{text.length}/{MAX_TEXT}</span>
        <button
          onClick={() => void submit()}
          disabled={sending || !text.trim()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 14px',
            borderRadius: 10,
            border: 'none',
            background: 'var(--accent-color, #5b7cfa)',
            color: '#fff',
            cursor: sending || !text.trim() ? 'default' : 'pointer',
            opacity: sending || !text.trim() ? 0.55 : 1,
            fontSize: 14,
          }}
        >
          <Send size={14} />
          {sending ? t('feedback.sending') : t('feedback.send')}
        </button>
      </div>
      {sentMsg && <div style={{ color: '#4caf50', fontSize: 13, marginTop: 8 }}>{sentMsg}</div>}
      {error && <div style={{ color: '#ff6b6b', fontSize: 13, marginTop: 8 }}>{error}</div>}

      {items.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{t('feedback.myItems', { count: items.length })}</span>
            {isAdmin && (
              <button
                onClick={() => void loadList(true)}
                style={{ fontSize: 12, background: 'transparent', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 8, padding: '3px 8px', color: 'inherit', cursor: 'pointer' }}
              >
                {t('feedback.allItems')}
              </button>
            )}
          </div>
          {loadingList && <div style={{ fontSize: 12, opacity: 0.6 }}>{t('common.loading')}</div>}
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                borderTop: '1px solid rgba(128,128,128,0.2)',
                padding: '8px 0',
                fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.75, fontSize: 11 }}>
                <span>{kindLabel[item.kind] ?? item.kind}{isAdmin && item.userId ? ` · id${item.userId}` : ''}</span>
                <span>{item.status === 'done' ? t('feedback.statusDone') : item.status === 'ack' ? t('feedback.statusAck') : t('feedback.statusNew')}</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', marginTop: 3 }}>{item.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
