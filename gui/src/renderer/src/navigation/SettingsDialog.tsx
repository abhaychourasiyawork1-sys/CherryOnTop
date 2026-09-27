import { useEffect, useRef, useState } from 'react';
import { Icon } from '../shell/Icon.js';
import { applyTheme, themePreference, type ThemePreference } from '../lib/theme.js';
import type { Mandate } from '../lib/mandates.js';

export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'Ctrl/⌘ K', what: 'Search runs, Workspaces and actions' },
  { keys: 'Ctrl/⌘ Shift O', what: 'New work' },
  { keys: 'Enter', what: 'Send' },
  { keys: 'Shift Enter', what: 'New line' },
  { keys: 'Esc', what: 'Close the newest panel, or a Deep Dive' },
  { keys: 'Ctrl/⌘ Z', what: 'Undo a layout change' },
  { keys: 'Ctrl/⌘ \\', what: 'Collapse or expand the sidebar' },
  { keys: 'Ctrl/⌘ ,', what: 'Settings' },
  { keys: 'Ctrl/⌘ /', what: 'Keyboard shortcuts' },
];

/** Settings, kept short: how it looks, what new work defaults to, whether it
 *  tells you when work finishes, and the keys. All per-person and local. */
export function SettingsDialog(props: {
  open: boolean;
  focus: 'settings' | 'shortcuts';
  onClose: () => void;
  mandates: Mandate[];
  mandateId: string | null;
  onMandate: (id: string) => void;
  notifyOnFinish: boolean;
  onNotifyOnFinish: (on: boolean) => void;
}) {
  const [theme, setTheme] = useState<ThemePreference>(themePreference);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!props.open) {
      if (opener.current instanceof HTMLElement) opener.current.focus();
      return;
    }
    opener.current = document.activeElement;
    setTheme(themePreference());
    requestAnimationFrame(() => {
      const target = props.focus === 'shortcuts'
        ? dialog.current?.querySelector<HTMLElement>('#settings-shortcuts')
        : dialog.current?.querySelector<HTMLElement>('input, select, button');
      target?.focus();
      target?.scrollIntoView?.({ block: 'nearest' });
    });
  }, [props.open, props.focus]);

  if (!props.open) return null;

  const choose = (next: ThemePreference) => { setTheme(next); applyTheme(next); };

  return (
    <div className="palette-scrim" data-modal-open="true" onMouseDown={props.onClose}>
      <div
        ref={dialog}
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); props.onClose(); } }}
      >
        <header className="settings-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={props.onClose}><Icon name="close" /></button>
        </header>

        <section className="settings-section" aria-labelledby="settings-appearance">
          <h3 id="settings-appearance" className="section-label">Appearance</h3>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={theme === option} aria-selected={theme === option} onClick={() => choose(option)}>
                {option === 'system' ? 'Match system' : option === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-work">
          <h3 id="settings-work" className="section-label">New work</h3>
          {props.mandates.length > 0 && (
            <label className="settings-row">
              <span>Runs under</span>
              <select value={props.mandateId ?? ''} onChange={(event) => props.onMandate(event.target.value)}>
                {props.mandates.map((mandate) => <option key={mandate.id} value={mandate.id}>{mandate.name}</option>)}
              </select>
            </label>
          )}
          <p className="settings-note">
            {props.mandates.find((m) => m.id === props.mandateId)?.description ?? ''}
          </p>
          <label className="settings-row">
            <span>Tell me when work finishes while the window is in the background</span>
            <input type="checkbox" checked={props.notifyOnFinish} onChange={(event) => props.onNotifyOnFinish(event.target.checked)} />
          </label>
        </section>

        <section className="settings-section" aria-labelledby="settings-shortcuts-title">
          <h3 id="settings-shortcuts-title" className="section-label">Keyboard shortcuts</h3>
          <dl className="shortcuts" id="settings-shortcuts" tabIndex={-1}>
            {SHORTCUTS.map((shortcut) => (
              <div key={shortcut.keys}><dt><kbd>{shortcut.keys}</kbd></dt><dd>{shortcut.what}</dd></div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
