import type { Aside } from '../lib/view.js';
import { basename } from '../lib/format.js';

interface Props {
  section: Aside;
  onNavigate: (view: Aside) => void;
  /** Badge on Desk: how many things are waiting on a person right now. */
  attention: number;
  running: number;
  repoPath: string | null;
  repoError: string | null;
  connected: boolean;
  onNewTask: () => void;
}

const DESTINATIONS: { id: Aside; label: string; icon: string; hint: string }[] = [
  { id: 'desk', label: 'Desk', icon: '◎', hint: 'What needs you' },
  { id: 'cases', label: 'Cases', icon: '▤', hint: 'Every run, searchable' },
  { id: 'mandates', label: 'Mandates', icon: '⛨', hint: 'What agents are permitted to do' },
  { id: 'memory', label: 'Memory', icon: '◇', hint: 'What the organization has learned' },
];

/** The left rail. Four destinations plus the case you are in, rather than a task
 *  list: the old rail was doing three unrelated jobs at once, and there was
 *  nowhere to put history, receipts or mandates without making it a fourth. */
export function Nav(props: Props) {
  return (
    <nav className="nav" aria-label="Sections">
      <div className="nav-project" title={props.repoPath ?? props.repoError ?? undefined}>
        <span className="nav-project-dot" data-connected={props.connected} aria-hidden="true" />
        <span className="nav-project-name">
          {props.repoPath ? basename(props.repoPath) : 'No repository'}
        </span>
      </div>

      <button type="button" className="nav-new" onClick={props.onNewTask}>
        <span aria-hidden="true">＋</span> New task
      </button>

      <ul className="nav-list">
        {DESTINATIONS.map((destination) => (
          <li key={destination.id}>
            <button
              type="button"
              className="nav-item"
              aria-current={props.section === destination.id}
              title={destination.hint}
              onClick={() => props.onNavigate(destination.id)}
            >
              <span className="nav-icon" aria-hidden="true">{destination.icon}</span>
              <span className="nav-label">{destination.label}</span>
              {destination.id === 'desk' && props.attention > 0 && (
                <span className="nav-count" data-urgent="true">{props.attention}</span>
              )}
              {destination.id === 'cases' && props.running > 0 && (
                <span className="nav-count">{props.running}</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <p className="nav-foot figure">
        {props.connected ? 'Daemon connected' : 'Daemon unreachable'}
      </p>
    </nav>
  );
}
