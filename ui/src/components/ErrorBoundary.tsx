import { Component, type ErrorInfo, type ReactNode } from 'react';
import { brand } from '../brand';
import { restoreAutosave, toFile } from '../lib/persistence';
import { download } from '../lib/exporters';

/**
 * Crash containment.
 *
 * This panel runs inside the customer's CAD session. An unhandled render fault would
 * otherwise leave a blank white pane docked in SOLIDWORKS with no way back, which reads
 * as "the add-in broke my CAD" even though SOLIDWORKS itself is unaffected.
 *
 * So: catch it, say plainly what happened and that their model is untouched, and give
 * them their work back — the autosaved document can still be exported to a file even
 * when the UI that produced it will not render.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only. Shipping this to a service would mean exfiltrating a stack trace
    // that can contain document paths and part names from an engineering workstation.
    console.error('[DATUM] render fault', error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  private recoverDocument = (): void => {
    const { doc } = restoreAutosave();
    if (!doc) return;
    download(`${doc.title.replace(/\.[^.]+$/, '')}-recovered.json`, toFile(doc), 'application/json');
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const hasSaved = restoreAutosave().doc !== null;

    return (
      <div className="crash">
        <div className="crash-card">
          <span className="eyebrow" style={{ color: 'var(--dang)' }}>Interface fault</span>
          <h2>{brand.name} stopped rendering</h2>

          <p>
            Your SOLIDWORKS session and your model are unaffected — this panel failed on its
            own, and nothing was written to your document.
          </p>

          <pre className="crash-msg">{error.message || String(error)}</pre>

          <div className="crash-actions">
            <button className="btn primary" style={{ marginLeft: 0 }} onClick={() => window.location.reload()}>
              Reload panel
            </button>
            {hasSaved && (
              <button className="btn determ" onClick={this.recoverDocument}>
                Download recovered document
              </button>
            )}
          </div>

          {hasSaved && (
            <p className="crash-note">
              Your last autosave is intact and will be restored when the panel reloads. The
              download is a second copy in case you would rather keep it outside the browser.
            </p>
          )}

          {info && (
            <details className="crash-details">
              <summary>Technical detail</summary>
              <pre>{info}</pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
