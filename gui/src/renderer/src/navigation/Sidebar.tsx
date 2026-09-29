import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../shell/Icon.js';
import { useLocalState } from '../lib/useLocalState.js';
import { localKey } from '../lib/sync.js';
import type { SessionRow } from '../lib/sessions.js';

export interface WorkspaceGroup {
  key: string;
  name: string;
  sessions: SessionRow[];
}

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  groups: WorkspaceGroup[];
  currentKey: string | null;
  currentSessionId: string | null;
  atHome: boolean;
  onHome: () => void;
  /** A new session — in a Workspace when one is given, else chosen on Home. */
  onNewSession: (key: string | null) => void;
  onOpenSession: (key: string, sessionId: string) => void;
  onRenameSession: (id: string, title: string) => Promise<void>;
  onDeleteSession: (id: string) => Promise<void>;
  onSearch: () => void;
  onMandates: () => void;
  atMandates: boolean;
  onSettings: () => void;
  /** Only what genuinely needs a person. */
  attention: number;
  onAttention: () => void;
  connected: boolean;
  authoritative: boolean;
}

/** How many sessions a Workspace shows before "Show more". */
const SHOWN = 6;

function decodeList(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Chat sessions, grouped by the Workspace they happen in — the way Claude
 *  and Codex list conversations under a project. Everything about one session
 *  (its files, plan, memory, organization) lives in that session's header, so
 *  the sidebar is only ever a list of places to go. */
export function Sidebar(props: Props) {
  // Folded Workspaces are remembered; the one you are in never folds away.
  const [folded, setFolded] = useLocalState<string[]>(localKey('draft', 'folded-workspaces'), decodeList);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  return (
    <nav className="sidebar" data-collapsed={props.collapsed} aria-label="Sessions">
      <div className="sidebar-top">
        <button type="button" className="brand" onClick={props.onHome} aria-current={props.atHome ? 'page' : undefined} title="Home">
          <svg className="brand-mark" viewBox="300 50 935 710" aria-hidden="true" focusable="false">
            <defs><radialGradient id="brand-cherry" cx="0.3" cy="0.28" r="0.8"><stop offset="0" stopColor="#FFC2C8"/><stop offset="0.38" stopColor="#FF1F45"/><stop offset="1" stopColor="#B80D2C"/></radialGradient></defs>
            <circle cx="765" cy="177" r="108" fill="url(#brand-cherry)"/>
            <g fill="currentColor"><path d="M679 320 L679 340 C679 430 600 465 510 495 C420 525 360 580 360 690" fill="none" stroke="currentColor" strokeWidth="84" strokeLinejoin="round"/>
            <path d="M851 320 L851 340 C851 430 930 465 1020 495 C1110 525 1170 580 1170 690" fill="none" stroke="currentColor" strokeWidth="84" strokeLinejoin="round"/>
            <rect x="637" y="300" width="84" height="40" rx="14"/>
            <rect x="809" y="300" width="84" height="40" rx="14"/>
            <circle cx="360" cy="690" r="42"/>
            <circle cx="1170" cy="690" r="42"/>
            <path d="M590 738 L590 690 C590 625 625 585 675 552 C715 527 748 512 765 490 C782 512 815 527 855 552 C905 585 942 625 942 690 L942 738 L858 738 L858 690 C858 648 835 622 800 598 C785 588 775 585 765 585 C755 585 745 588 730 598 C695 622 672 648 672 690 L672 738 Z" stroke="currentColor" strokeWidth="6" strokeLinejoin="round"/>
            </g>
          </svg>
          {!props.collapsed && <span className="brand-name">CherryOnTop</span>}
        </button>
      </div>

      <ul className="side-list">
        <li>
          <SideButton icon="compose" label="New session" hint="Ctrl ⇧ O" collapsed={props.collapsed} onClick={() => props.onNewSession(props.currentKey)} />
        </li>
        <li>
          <SideButton icon="search" label="Search" hint="Ctrl K" collapsed={props.collapsed} onClick={props.onSearch} />
        </li>
      </ul>

      <div className="side-sessions">
        {!props.collapsed && (
          <div className="side-group-head">
            <p className="side-group-label" id="ws-label">Workspaces</p>
            <button type="button" className="icon-button tiny" aria-label="Open a folder as a Workspace" title="Open a folder" onClick={() => props.onNewSession(null)}>
              <Icon name="plus" size={13} />
            </button>
          </div>
        )}
        {props.groups.length === 0 && !props.collapsed && (
          <p className="side-empty">Sessions you start appear here, under the folder they work in.</p>
        )}
        <ul className="ws-groups" aria-labelledby={props.collapsed ? undefined : 'ws-label'} aria-label={props.collapsed ? 'Workspaces' : undefined}>
          {props.groups.map((group) => {
            const isCurrent = group.key === props.currentKey;
            const open = isCurrent || !folded.includes(group.key);
            const live = group.sessions.some((s) => s.live);
            if (props.collapsed) {
              return (
                <li key={group.key}>
                  <button
                    type="button"
                    className="ws-group-mark"
                    data-current={isCurrent}
                    aria-label={group.name}
                    title={group.name}
                    onClick={() => (group.sessions[0] ? props.onOpenSession(group.key, group.sessions[0].id) : props.onNewSession(group.key))}
                  >
                    {group.name.slice(0, 1).toUpperCase()}
                    {live && <span className="ws-group-live" aria-hidden="true" />}
                  </button>
                </li>
              );
            }
            const all = expanded.has(group.key);
            const shown = all ? group.sessions : group.sessions.slice(0, SHOWN);
            // The open session stays visible even when it is older than the cut.
            const current = group.sessions.find((s) => s.id === props.currentSessionId);
            if (current && !shown.includes(current)) shown.push(current);
            return (
              <li key={group.key} className="ws-group" data-current={isCurrent}>
                <div className="ws-group-row">
                  <button
                    type="button"
                    className="ws-group-toggle"
                    aria-expanded={open}
                    onClick={() => setFolded((list) => (list.includes(group.key) ? list.filter((k) => k !== group.key) : [...list, group.key]))}
                    title={group.key}
                  >
                    <span className="ws-group-chevron" data-open={open} aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
                    <Icon name="folder" size={14} />
                    <span className="side-label">{group.name}</span>
                    {!open && live && <span className="recent-live" aria-label="Working" />}
                  </button>
                  <button type="button" className="icon-button tiny ws-group-new" aria-label={`New session in ${group.name}`} title={`New session in ${group.name}`} onClick={() => props.onNewSession(group.key)}>
                    <Icon name="plus" size={13} />
                  </button>
                </div>
                {open && (
                  <ul className="session-list">
                    {shown.map((session) => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        current={session.id === props.currentSessionId}
                        onOpen={() => props.onOpenSession(group.key, session.id)}
                        onRename={(title) => props.onRenameSession(session.id, title)}
                        onDelete={() => props.onDeleteSession(session.id)}
                      />
                    ))}
                    {group.sessions.length === 0 && (
                      <li><button type="button" className="session-empty" onClick={() => props.onNewSession(group.key)}>Start a session</button></li>
                    )}
                    {group.sessions.length > SHOWN && (
                      <li>
                        <button
                          type="button"
                          className="session-more"
                          onClick={() => setExpanded((set) => {
                            const next = new Set(set);
                            if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                            return next;
                          })}
                        >
                          {all ? 'Show fewer' : `Show ${group.sessions.length - SHOWN} more`}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="sidebar-foot">
        {props.attention > 0 && (
          <button type="button" className="side-attention" onClick={props.onAttention} aria-label={`${props.attention} need your attention`}>
            <span className="attention-pip" aria-hidden="true" />
            {!props.collapsed && <span>Needs you</span>}
            <span className="figure">{props.attention}</span>
          </button>
        )}
        <SideButton icon="shield" label="Mandates" title="What work is allowed to do" current={props.atMandates} collapsed={props.collapsed} onClick={props.onMandates} />
        <div className="side-foot-row">
          <span
            className="conn"
            data-state={!props.connected ? 'offline' : props.authoritative ? 'live' : 'syncing'}
            title={!props.connected ? 'Offline — showing the last known state' : props.authoritative ? 'Connected' : 'Syncing'}
          >
            <span className="conn-dot" aria-hidden="true" />
            {!props.collapsed && (!props.connected ? 'Offline' : props.authoritative ? 'Connected' : 'Syncing')}
          </span>
          <button type="button" className="icon-button" onClick={props.onSettings} aria-label="Settings" title="Settings (Ctrl ,)">
            <Icon name="settings" />
          </button>
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

function SessionItem(props: {
  session: SessionRow;
  current: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renaming) input.current?.select(); }, [renaming]);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3500);
    return () => clearTimeout(timer);
  }, [confirming]);

  const commit = (value: string) => {
    setRenaming(false);
    const title = value.trim();
    if (title && title !== props.session.title) void props.onRename(title);
  };

  return (
    <li className="session-row" data-current={props.current} data-confirming={confirming}>
      {renaming ? (
        <input
          ref={input}
          className="session-rename"
          defaultValue={props.session.title}
          aria-label="Session name"
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(event.currentTarget.value);
            if (event.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="session-item"
          aria-current={props.current ? 'page' : undefined}
          title={props.session.title}
          onClick={props.onOpen}
          onDoubleClick={() => setRenaming(true)}
        >
          <span className="side-label">{props.session.title}</span>
          {props.session.live
            ? <span className="recent-live" aria-label="Working" />
            : <span className="session-when">{short(props.session.updatedAt)}</span>}
        </button>
      )}
      {!renaming && (
        <span className="session-actions">
          {confirming ? (
            <button type="button" className="session-confirm" onClick={() => void props.onDelete()}>Delete?</button>
          ) : (
            <>
              <button type="button" className="icon-button tiny" aria-label={`Rename ${props.session.title}`} title="Rename" onClick={() => setRenaming(true)}>
                <Icon name="edit" size={12} />
              </button>
              <button type="button" className="icon-button tiny" aria-label={`Delete ${props.session.title}`} title="Delete" onClick={() => setConfirming(true)}>
                <Icon name="trash" size={12} />
              </button>
            </>
          )}
        </span>
      )}
    </li>
  );
}

/** "3m", "5h", "2d" — a sidebar has no room for "ago". */
function short(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : `${Math.round(days / 7)}w`;
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
