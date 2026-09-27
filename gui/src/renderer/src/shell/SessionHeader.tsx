import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon.js';
import { STATE_LABEL, type WorkspaceState } from '../lib/workspaces.js';
import { ORGANIZATION, type Section } from '../lib/view.js';

export type SessionTool = 'files' | 'plan' | 'memory';

const TOOLS: { id: SessionTool; label: string; icon: IconName; hint: string }[] = [
  { id: 'files', label: 'Files', icon: 'files', hint: 'What this session changed' },
  { id: 'plan', label: 'Plan', icon: 'plan', hint: 'The plan for the current run' },
  { id: 'memory', label: 'Memory', icon: 'memory', hint: 'What this session remembers' },
];

/** Where you are — Workspace, then session — and everything about this one
 *  session one click away. Nothing here reaches outside the session. */
export function SessionHeader(props: {
  workspaceName: string;
  workspaceKey: string;
  /** Null until the first message creates the session. */
  title: string | null;
  onRename?: (title: string) => Promise<void>;
  section: Section;
  onSection: (section: Section) => void;
  open: Partial<Record<SessionTool, boolean>>;
  onTool: (tool: SessionTool) => void;
  /** Organization appears once there is something in it. */
  organized: boolean;
  state: WorkspaceState;
  onState?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  const inOrg = props.section !== 'chat';

  const commit = (value: string) => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== props.title) void props.onRename?.(next);
  };

  return (
    <header className="session-header">
      <div className="crumbs">
        <span className="crumb-ws" title={props.workspaceKey}>
          <Icon name="folder" size={14} />
          <span>{props.workspaceName}</span>
        </span>
        <span className="crumb-sep" aria-hidden="true">/</span>
        {editing ? (
          <input
            ref={input}
            className="crumb-rename"
            defaultValue={props.title ?? ''}
            aria-label="Session name"
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(event.currentTarget.value);
              if (event.key === 'Escape') setEditing(false);
            }}
          />
        ) : props.title ? (
          <button type="button" className="crumb-title" title="Rename this session" onClick={() => setEditing(true)} disabled={!props.onRename}>
            <h1>{props.title}</h1>
          </button>
        ) : (
          <h1 className="crumb-title crumb-new">New session</h1>
        )}
      </div>

      <div className="session-tools" role="toolbar" aria-label="This session">
        {inOrg && (
          <button type="button" className="tool-button" onClick={() => props.onSection('chat')}>
            <Icon name="chat" size={14} />
            <span>Chat</span>
          </button>
        )}
        {!inOrg && TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="tool-button"
            aria-pressed={Boolean(props.open[tool.id])}
            title={tool.hint}
            onClick={() => props.onTool(tool.id)}
          >
            <Icon name={tool.icon} size={14} />
            <span>{tool.label}</span>
          </button>
        ))}
        {props.organized && (
          <button
            type="button"
            className="tool-button"
            aria-pressed={inOrg}
            title="Decisions, runs, agents and evidence behind this session"
            onClick={() => props.onSection(inOrg ? 'chat' : 'decisions')}
          >
            <Icon name="agents" size={14} />
            <span>Organization</span>
          </button>
        )}
        <span className="tool-sep" aria-hidden="true" />
        <button
          type="button"
          className="ws-state"
          data-state={props.state}
          data-loud={props.state === 'attention'}
          onClick={props.onState}
          disabled={!props.onState}
          aria-label={`Session ${STATE_LABEL[props.state]}`}
        >
          <span className="ws-state-dot" aria-hidden="true" />
          {STATE_LABEL[props.state]}
        </button>
      </div>

      {inOrg && (
        <nav className="org-tabs" aria-label="Organization">
          {[...ORGANIZATION, { id: 'authority' as Section, label: 'Authority' }].map((item) => (
            <button key={item.id} type="button" className="org-tab" aria-current={props.section === item.id ? 'page' : undefined} onClick={() => props.onSection(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}
