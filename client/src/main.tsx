import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './ui/App';

/** Keeps a rendering bug in the UI chrome from leaving a white screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[ui] render error', error, info.componentStack); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h2>Something went wrong in the MathBoard interface</h2>
        <p>Your board is saved on the server. Reloading brings everything back.</p>
        <pre>{String(error.stack || error.message || error)}</pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn primary" onClick={() => location.reload()}>Reload</button>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try to continue</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
