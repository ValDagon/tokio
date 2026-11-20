import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { getActiveLocale, translate } from './i18n/core';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in Mini App:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      const loc = getActiveLocale();
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            textAlign: 'center',
            color: 'var(--text-primary, #f8fafc)',
            background: 'var(--bg-color, #0b0d14)',
            fontFamily: 'inherit',
          }}
        >
          <div style={{ marginBottom: 14, color: 'var(--accent-color, #f59e0b)' }}>
            <AlertTriangle size={40} strokeWidth={1.75} />
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            {translate(loc, 'errors.boundaryTitle')}
          </h2>
          <p
            style={{
              fontSize: 13,
              color: 'var(--text-muted, #94a3b8)',
              marginBottom: 20,
              maxWidth: 320,
              lineHeight: 1.4,
            }}
          >
            {this.state.error?.message ||
              translate(loc, 'errors.boundaryFallback')}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 22px',
              borderRadius: 12,
              background: 'var(--accent-color, #f59e0b)',
              color: 'var(--accent-text, #0c0d10)',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
              border: 'none',
            }}
          >
            <RefreshCw size={15} strokeWidth={1.75} />
            <span>{translate(loc, 'errors.reload')}</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
