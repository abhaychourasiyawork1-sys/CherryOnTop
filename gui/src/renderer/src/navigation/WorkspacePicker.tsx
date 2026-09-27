import { useEffect, useRef, useState } from 'react';
import { Icon } from '../shell/Icon.js';
import { ago } from '../lib/format.js';
import type { Workspace } from '../lib/workspaces.js';

/** Where new work from Home will happen, chosen where you type it. Lists the
 *  Workspaces the organization already knows, and lets you open any other git
 *  folder. Whether a folder is usable is the daemon's call; this only asks. */
export function WorkspacePicker(props: {
  workspaces: Workspace[];
  selected: Workspace | null;
  /** The daemon's verdict on the selected one. */
  status: 'checking' | 'ready' | 'unusable';
  onSelect: (key: string) => void;
  /** Resolves a host folder path; returns an error sentence or null on success. */
  onOpenFolder: (hostPath: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const canPick = Boolean(window.mission?.pickFolder);

  useEffect(() => {
    if (!open) { setQuery(''); setTyping(false); setError(null); return; }
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => { setOpen(false); trigger.current?.focus(); };

  const tryFolder = async (hostPath: string) => {
    setBusy(true);
    setError(null);
    const problem = await props.onOpenFolder(hostPath);
    setBusy(false);
    if (problem) setError(problem);
    else close();
  };

  const pick = async () => {
    if (!canPick) { setTyping(true); return; }
    const chosen = await window.mission!.pickFolder!();
    if (chosen) await tryFolder(chosen);
  };

  const matches = props.workspaces.filter((ws) => ws.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="ws-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ws-picker-trigger"
        data-status={props.status}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Work in ${props.selected?.name ?? 'no Workspace chosen'}. Change where this work happens`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ws-picker-label">Work in</span>
        <span className="ws-picker-name">{props.selected?.name ?? 'Choose a Workspace'}</span>
        <Icon name="chevronDown" size={12} />
      </button>

      {open && (
        <div
          className="ws-picker-pop"
          role="dialog"
          aria-label="Where should this work happen?"
          data-modal-open="true"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}
        >
          <p className="ws-picker-head">Where should this work happen?</p>
          {props.workspaces.length > 6 && (
            <input
              autoFocus
              className="switcher-search"
              placeholder="Find a Workspace"
              aria-label="Find a Workspace"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (matches[0]) { props.onSelect(matches[0].key); close(); }
              }}
            />
          )}
          <ul className="ws-picker-list">
            {matches.slice(0, 40).map((ws) => (
              <li key={ws.key}>
                <button
                  type="button"
                  className="ws-picker-option"
                  aria-current={ws.key === props.selected?.key}
                  onClick={() => { props.onSelect(ws.key); close(); }}
                >
                  <span className="switcher-mark" aria-hidden="true">{ws.name.slice(0, 1).toUpperCase()}</span>
                  <span className="ws-picker-option-main">
                    <span className="switcher-option-name">{ws.name}</span>
                    <span className="ws-picker-path">{ws.key.replace(/^\/host\//, '~/')}</span>
                  </span>
                  <span className="switcher-option-meta">{ws.cases.length === 0 ? 'New' : ago(ws.lastActivity)}</span>
                </button>
              </li>
            ))}
          </ul>
          {typing ? (
            // Not a <form>: this sits inside the composer's form, and a nested
            // form would hand Enter to the composer instead.
            <div className="ws-picker-path-form">
              <input
                autoFocus
                className="switcher-search"
                placeholder="/home/you/projects/app"
                aria-label="Path to a git repository"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (path.trim()) void tryFolder(path); }
                }}
              />
              <button type="button" className="button" disabled={busy || !path.trim()} onClick={() => void tryFolder(path)}>
                {busy ? 'Checking…' : 'Use this folder'}
              </button>
            </div>
          ) : (
            <button type="button" className="ws-picker-open" onClick={() => void pick()} disabled={busy}>
              <Icon name="plus" size={13} /> {busy ? 'Checking the folder…' : 'Open a folder…'}
            </button>
          )}
          {error && <p className="inline-error" role="alert">{error}</p>}
          <p className="ws-picker-note">A Workspace is a git repository in your home folder. Its runs, files and memory stay with it.</p>
        </div>
      )}
    </div>
  );
}
