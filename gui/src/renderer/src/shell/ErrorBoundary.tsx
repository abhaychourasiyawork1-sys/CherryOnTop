import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** What failed, in the user's words — "this panel", "the case view". */
  what: string;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken panel from taking the whole window with it.
 *
 * React unmounts the entire tree on an uncaught render error, so a single
 * missing field in one response turned the window blank — no message, no way
 * back, and every live subscription rendered useless because there was no tree
 * left to update. That is how a stale daemon presented itself: not as "your
 * daemon is old" but as a white rectangle.
 *
 * This is the last line of defence, not the fix. The fix is that panels tolerate
 * missing fields; this is here because the next missing field is one nobody has
 * thought of yet.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // The window's console is the only place this is recoverable from, and
    // main/index.ts forwards renderer errors to the terminal.
    console.error(`[${this.props.what}]`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boundary">
        <h2>{this.props.what} could not be shown.</h2>
        <p className="boundary-reason figure">{this.state.error.message}</p>
        <p>
          The rest of the window still works. If this started after an update, the daemon
          is probably older than this window — rebuild with <span className="figure">npm run build</span>,
          then <span className="figure">org daemon stop</span>.
        </p>
        <button type="button" className="ghost-button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
