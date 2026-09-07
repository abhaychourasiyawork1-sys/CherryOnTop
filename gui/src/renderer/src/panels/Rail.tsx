import type { Task } from '../lib/tasks.js';
import type { Approval } from '../lib/useOrg.js';

export type Aside = 'inbox' | 'memory';

interface Props {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  aside: Aside | null;
  onAside: (aside: Aside | null) => void;
  approvals: Approval[];
  repoPath: string | null;
  repoError: string | null;
}

export function Rail(props: Props) {
  return (
    <nav className="rail" aria-label="Tasks">
      <div className="rail-top">
        <p className="rail-project" title={props.repoPath ?? props.repoError ?? undefined}>
          {props.repoPath ? shortPath(props.repoPath) : 'No repository'}
        </p>
        <button type="button" className="rail-new" onClick={props.onNewTask}>
          New task
        </button>
      </div>

      <ul className="task-list">
        {props.tasks.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              className="task"
              aria-current={props.selectedTaskId === task.id && props.aside === null}
              style={{ ['--state' as string]: `var(--${task.tone})` }}
              onClick={() => { props.onSelectTask(task.id); props.onAside(null); }}
            >
              <span className="task-goal">{task.goal}</span>
              <span className="task-meta">
                {task.running && <span className="task-pulse" aria-hidden="true" />}
                <span className="figure">{task.nodeCount === 1 ? '1 agent' : `${task.nodeCount} agents`}</span>
                <span className="figure task-cost">${task.costUsd.toFixed(2)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="rail-asides">
        <button
          type="button"
          className="rail-item"
          aria-current={props.aside === 'inbox'}
          onClick={() => props.onAside('inbox')}
        >
          Inbox
          {props.approvals.length > 0 && <span className="rail-count">{props.approvals.length}</span>}
        </button>
        <button
          type="button"
          className="rail-item"
          aria-current={props.aside === 'memory'}
          onClick={() => props.onAside('memory')}
        >
          Memory
        </button>
      </div>
    </nav>
  );
}

function shortPath(repoPath: string): string {
  return repoPath.split('/').filter(Boolean).at(-1) ?? repoPath;
}
