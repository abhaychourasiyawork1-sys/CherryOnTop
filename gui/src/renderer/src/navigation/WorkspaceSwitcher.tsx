import { useEffect, useRef, useState } from 'react';
import { Icon } from '../shell/Icon.js';
import { ago } from '../lib/format.js';
import type { Workspace } from '../lib/workspaces.js';

/** A compact, searchable list of Workspaces. Type to filter, arrows to move,
 *  Enter to open, Escape to close. */
export function WorkspaceSwitcher(props: {
  workspaces: Workspace[];
  current: Workspace | null;
  collapsed: boolean;
  onOpen: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const matches = props.workspaces.filter((ws) => ws.name.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    if (open) { setQuery(''); setIndex(0); requestAnimationFrame(() => input.current?.focus()); }
  }, [open]);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = (key: string) => { props.onOpen(key); setOpen(false); };

  return (
    <div className="switcher">
      <button
        ref={trigger}
        type="button"
        className="switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Workspace: ${props.current?.name ?? 'none'}. Switch Workspace`}
        title={props.collapsed ? props.current?.name ?? 'Workspaces' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="switcher-mark" aria-hidden="true">{(props.current?.name ?? 'C').slice(0, 1).toUpperCase()}</span>
        {!props.collapsed && (
          <>
            <span className="switcher-name">{props.current?.name ?? 'CherryOnTop'}</span>
            <Icon name="chevronDown" size={14} />
          </>
        )}
      </button>

      {open && (
        <div className="switcher-pop" data-modal-open="true" role="dialog" aria-label="Switch Workspace">
          <input
            ref={input}
            className="switcher-search"
            placeholder="Find a Workspace"
            aria-label="Find a Workspace"
            aria-controls="switcher-list"
            aria-activedescendant={matches[index] ? `ws-${index}` : undefined}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(i + 1, matches.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
              if (event.key === 'Enter' && matches[index]) { event.preventDefault(); choose(matches[index].key); }
              if (event.key === 'Escape') { event.preventDefault(); close(); }
            }}
            onBlur={(event) => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) setOpen(false); }}
          />
          <ul className="switcher-list" id="switcher-list" role="listbox">
            {matches.length === 0 && <li className="switcher-empty">No Workspace matches.</li>}
            {matches.slice(0, 50).map((ws, i) => (
              <li
                key={ws.key}
                id={`ws-${i}`}
                role="option"
                aria-selected={i === index}
                className="switcher-option"
                data-current={ws.key === props.current?.key}
                onMouseDown={(event) => { event.preventDefault(); choose(ws.key); }}
                onMouseEnter={() => setIndex(i)}
              >
                <span className="switcher-option-name">{ws.name}</span>
                <span className="switcher-option-meta">
                  {ws.needsYou > 0 ? 'Needs you' : ws.running > 0 ? 'Working' : ago(ws.lastActivity)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
