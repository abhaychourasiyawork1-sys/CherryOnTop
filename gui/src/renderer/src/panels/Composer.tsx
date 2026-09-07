import { useEffect, useRef, useState } from 'react';
import type { Mandate } from '../lib/mandates.js';

interface Props {
  onSubmit: (text: string) => Promise<void>;
  disabled: boolean;
  /** The hero is the whole screen when there is nothing to look at yet; docked
   *  is the same field at the foot of a conversation. One component either way —
   *  there is never a second place to type. */
  variant: 'hero' | 'docked';
  /** Why a task cannot be started right now. Shown rather than leaving a dead
   *  input with no explanation — asking a question of the record still works. */
  blockedReason?: string | null;
  autoFocus?: boolean;
  /** The mandate the next task will run under. Picking one here is the whole
   *  difference between authoring what an organization may do and discovering it
   *  afterwards. */
  mandates?: Mandate[];
  selectedMandateId?: string | null;
  onSelectMandate?: (id: string | null) => void;
}

function ComposerField(props: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (props.autoFocus) box.current?.focus();
  }, [props.autoFocus, props.variant]);

  const grow = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, props.variant === 'hero' ? 220 : 160)}px`;
  };

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await props.onSubmit(value);
      setText('');
      if (box.current) box.current.style.height = 'auto';
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="composer"
      data-variant={props.variant}
      onSubmit={(submitEvent) => { submitEvent.preventDefault(); void send(); }}
    >
      <textarea
        ref={box}
        value={text}
        rows={1}
        placeholder={
          props.variant === 'hero'
            ? 'Describe what you want done'
            : 'Give another task, or ask why, what is blocking this, what it produced'
        }
        aria-label="Give the organization a task"
        disabled={props.disabled}
        onChange={(changeEvent) => { setText(changeEvent.target.value); grow(changeEvent.target); }}
        onKeyDown={(keyEvent) => {
          // Enter sends; shift+enter is how you write a multi-line goal.
          if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
            keyEvent.preventDefault();
            void send();
          }
        }}
      />
      <button type="submit" className="composer-send" disabled={props.disabled || busy || !text.trim()}>
        {busy ? 'Starting' : 'Start'}
      </button>
    </form>
  );
}

/** What the organization will be allowed to do, said before you press Start.
 *
 *  Nobody else in this category shows the blast radius in advance. It costs
 *  nothing to show — the envelope is a pure function of the contract — and it is
 *  the difference between authorizing work and merely requesting it. */
function AuthorityPreview(props: {
  mandates: Mandate[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const selected = props.mandates.find((mandate) => mandate.id === props.selectedId)
    ?? props.mandates[0] ?? null;

  if (!selected) return null;

  return (
    <div className="authority-preview">
      <label className="authority-pick">
        <span className="mandate-mark" aria-hidden="true">⛨</span>
        <select
          value={selected.id}
          aria-label="Mandate this task runs under"
          onChange={(event) => props.onSelect(event.target.value)}
        >
          {props.mandates.map((mandate) => (
            <option key={mandate.id} value={mandate.id}>{mandate.name}</option>
          ))}
        </select>
      </label>
      <span className="authority-summary figure">{selected.summary}</span>
    </div>
  );
}

export function Composer(props: Props) {
  return (
    <div className="composer-shell" data-variant={props.variant}>
      {props.mandates && props.mandates.length > 0 && props.onSelectMandate && (
        <AuthorityPreview
          mandates={props.mandates}
          selectedId={props.selectedMandateId ?? null}
          onSelect={props.onSelectMandate}
        />
      )}
      <ComposerField {...props} />
      {props.blockedReason && <p className="composer-blocked">{props.blockedReason}</p>}
    </div>
  );
}

/** The empty state: the input is the only thing on screen, because giving the
 *  organization a task is the only thing there is to do yet. */
export function Hero(props: Omit<Props, 'variant'>) {
  return (
    <div className="hero">
      <h1>What needs doing?</h1>
      <p>
        A root agent takes the goal, decides whether to do the work or split it up, and
        the organization it builds appears as it forms.
      </p>
      <Composer {...props} variant="hero" />
    </div>
  );
}
