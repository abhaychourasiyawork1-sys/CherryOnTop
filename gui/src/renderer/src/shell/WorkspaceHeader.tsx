import { Icon } from './Icon.js';
import { STATE_LABEL, type WorkspaceState } from '../lib/workspaces.js';

/** The one line that keeps you oriented: where back goes, where you are, and
 *  the Workspace's state. The state is quiet unless a person is needed — the
 *  only state allowed to raise its voice. It describes the Workspace, never
 *  one run. */
export function WorkspaceHeader(props: {
  backLabel: string | null;
  onBack: () => void;
  title: string;
  context?: React.ReactNode;
  state: WorkspaceState;
  onState?: () => void;
  cachedAt?: string | null;
}) {
  const loud = props.state === 'attention';
  const stateLabel = STATE_LABEL[props.state];
  return (
    <header className="ws-header">
      {props.backLabel ? (
        <button type="button" className="back-link" onClick={props.onBack}>
          <Icon name="chevronLeft" size={14} />
          <span>{props.backLabel}</span>
        </button>
      ) : <span />}
      <div className="ws-header-center">
        <h1 className="ws-title">{props.title}</h1>
        {props.context}
      </div>
      <button
        type="button"
        className="ws-state"
        data-state={props.state}
        data-loud={loud}
        onClick={props.onState}
        disabled={!props.onState}
        aria-label={`Workspace ${stateLabel}${loud ? ', open what needs you' : ''}`}
        title={props.state === 'offline' && props.cachedAt ? `Showing what was known at ${new Date(props.cachedAt).toLocaleString()}` : undefined}
      >
        <span className="ws-state-dot" aria-hidden="true" />
        {stateLabel}
      </button>
    </header>
  );
}
