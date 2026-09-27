import { Icon, type IconName } from '../shell/Icon.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';
import { ORGANIZATION, type Section } from '../lib/view.js';
import type { Workspace } from '../lib/workspaces.js';

export type CoreItem = 'chat' | 'files' | 'plan' | 'memory';

const CORE: { id: CoreItem; label: string; icon: IconName; hint: string }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat', hint: 'The conversation' },
  { id: 'files', label: 'Files', icon: 'files', hint: 'What changed, and who changed it' },
  { id: 'plan', label: 'Plan', icon: 'plan', hint: 'The plan for the current run' },
  { id: 'memory', label: 'Memory', icon: 'memory', hint: 'What this Workspace has learned' },
];

const ORG_ICON: Record<string, IconName> = { decisions: 'decisions', runs: 'runs', agents: 'agents', evidence: 'evidence' };

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  workspaces: Workspace[];
  workspace: Workspace | null;
  onOpenWorkspace: (key: string) => void;
  atHome: boolean;
  onHome: () => void;
  /** Which core items are showing right now. */
  active: Partial<Record<CoreItem, boolean>>;
  onCore: (item: CoreItem) => void;
  section: Section | null;
  onSection: (section: Section) => void;
  /** Only what genuinely needs a person. */
  attention: number;
  onAttention: () => void;
  onSearch: () => void;
  connected: boolean;
  authoritative: boolean;
}

/** Four permanent destinations — Chat, Files, Plan, Memory — and the
 *  organization underneath, revealed only once a Workspace has one. Collapsed,
 *  it is a column of labelled icons; every control keeps its accessible name. */
export function Sidebar(props: Props) {
  return (
    <nav className="sidebar" data-collapsed={props.collapsed} aria-label="Workspace">
      <div className="sidebar-top">
        <WorkspaceSwitcher
          workspaces={props.workspaces}
          current={props.workspace}
          collapsed={props.collapsed}
          onOpen={props.onOpenWorkspace}
        />
      </div>

      <ul className="side-list">
        <li>
          <SideButton icon="home" label="Home" current={props.atHome} collapsed={props.collapsed} onClick={props.onHome} />
        </li>
        <li>
          <SideButton icon="search" label="Search" hint="Ctrl K" collapsed={props.collapsed} onClick={props.onSearch} />
        </li>
      </ul>

      {props.workspace && (
        <ul className="side-list" aria-label="Core">
          {CORE.map((item) => (
            <li key={item.id}>
              <SideButton
                icon={item.icon}
                label={item.label}
                title={item.hint}
                current={Boolean(props.active[item.id])}
                collapsed={props.collapsed}
                onClick={() => props.onCore(item.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {props.workspace?.organized && (
        <div className="side-group">
          {!props.collapsed && <p className="side-group-label" id="org-label">Organization</p>}
          <ul className="side-list" aria-labelledby={props.collapsed ? undefined : 'org-label'} aria-label={props.collapsed ? 'Organization' : undefined}>
            {ORGANIZATION.map((item) => (
              <li key={item.id}>
                <SideButton
                  icon={ORG_ICON[item.id]}
                  label={item.label}
                  current={props.section === item.id}
                  collapsed={props.collapsed}
                  onClick={() => props.onSection(item.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="sidebar-foot">
        {props.attention > 0 && (
          <button type="button" className="side-attention" onClick={props.onAttention} aria-label={`${props.attention} need your attention`}>
            <span className="attention-pip" aria-hidden="true" />
            {!props.collapsed && <span>Needs you</span>}
            <span className="figure">{props.attention}</span>
          </button>
        )}
        <div className="side-foot-row">
          <span
            className="conn"
            data-state={!props.connected ? 'offline' : props.authoritative ? 'live' : 'syncing'}
            title={!props.connected ? 'Offline — showing the last known state' : props.authoritative ? 'Connected' : 'Syncing'}
          >
            <span className="conn-dot" aria-hidden="true" />
            {!props.collapsed && (!props.connected ? 'Offline' : props.authoritative ? 'Connected' : 'Syncing')}
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={props.onToggle}
            aria-label={props.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!props.collapsed}
            title={props.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <Icon name="sidebar" />
          </button>
        </div>
      </div>
    </nav>
  );
}

function SideButton(props: {
  icon: IconName;
  label: string;
  hint?: string;
  title?: string;
  current?: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="side-item"
      aria-current={props.current ? 'page' : undefined}
      aria-label={props.collapsed ? props.label : undefined}
      title={props.collapsed ? props.label : props.title}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
      {!props.collapsed && <span className="side-label">{props.label}</span>}
      {!props.collapsed && props.hint && <kbd className="side-hint">{props.hint}</kbd>}
    </button>
  );
}
