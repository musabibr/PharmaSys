import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './styles/globals.css';
import './tours/tour-styles.css';
import './i18n';
import { App } from './App';

// Error boundary to catch rendering failures
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[PharmaSys] React error boundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, color: '#ef4444', fontFamily: 'system-ui' }}>
          <h1 style={{ fontSize: 24, marginBottom: 16 }}>Something went wrong</h1>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 14, color: '#ccc', background: '#1a1a1a', padding: 16, borderRadius: 8 }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 16px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

try {
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found');
  }

  console.log('[PharmaSys] Mounting React app...');
  console.log('[PharmaSys] window.api available:', !!window.api);

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <HashRouter>
          <App />
        </HashRouter>
      </ErrorBoundary>
    </React.StrictMode>
  );
} catch (err) {
  console.error('[PharmaSys] Failed to mount React app:', err);
  const rootEl = document.getElementById('root');
  if (rootEl) {
    rootEl.innerHTML = `
      <div style="padding:40px;color:#ef4444;font-family:system-ui">
        <h1 style="font-size:24px;margin-bottom:16px">Failed to start PharmaSys</h1>
        <pre style="white-space:pre-wrap;font-size:14px;color:#ccc;background:#1a1a1a;padding:16px;border-radius:8px">${
          err instanceof Error ? err.message + '\n\n' + err.stack : String(err)
        }</pre>
      </div>
    `;
  }
}
