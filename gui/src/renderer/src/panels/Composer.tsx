import { useEffect, useRef, useState } from 'react';
import { Icon } from '../shell/Icon.js';
import { useLocalState } from '../lib/useLocalState.js';
import { localKey } from '../lib/sync.js';
import {
  resolveIntent, addRef, parseDroppedRef, REF_MIME,
  type ContextRef, type Intent,
} from '../composer/ContextResolver.js';
import type { Mandate } from '../lib/mandates.js';

interface Props {
  variant: 'hero' | 'docked';
  /** Something is on record, so a question can be answered from it. */
  hasCase: boolean;
  /** The run a redirect would replace. */
  liveRun: { id: string; title: string } | null;
  /** Context the open surfaces offer; the person chooses what to attach. */
  suggestions: ContextRef[];
  mandates: Mandate[];
  mandateId: string | null;
  onSelectMandate: (id: string) => void;
  /** Opens the plain-words authority summary for this Workspace. */
  onAuthority?: () => void;
  /** Why work cannot be started here. Questions still work. */
  blockedReason: string | null;
  offline: boolean;
  draftScope: string;
  autoFocus?: boolean;
  onQuestion: (text: string) => Promise<void>;
  onWork: (text: string, refs: ContextRef[]) => Promise<void>;
  onRedirect: (text: string, refs: ContextRef[]) => Promise<void>;
}

const HINT: Record<Intent, string> = {
  question: 'Answered from the record',
  work: 'Starts new work',
  redirect: 'Redirects the current run',
};

/** The one place to type. It works out whether you are asking a question,
 *  giving work, or changing course — you never pick a mode first — and says
 *  which before you send, so nothing surprising starts. */
export function Composer(props: Props) {
  const [text, setText] = useLocalState<string>(localKey('draft', props.draftScope), (raw) => raw ?? '', (value) => value);
  const [refs, setRefs] = useState<ContextRef[]>([]);
  const [override, setOverride] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (props.autoFocus) box.current?.focus();
  }, [props.autoFocus, props.draftScope]);

  useEffect(() => { grow(); });

  const inferred = resolveIntent(text, { hasCase: props.hasCase, runLive: props.liveRun !== null });
  const intent: Intent = override && (override !== 'redirect' || props.liveRun) ? override : inferred;
  const workBlocked = intent !== 'question' && (props.blockedReason !== null || props.offline);

  function grow() {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, props.variant === 'hero' ? 240 : 180)}px`;
  }

  const send = async () => {
    const value = text.trim();
    if (!value || busy || workBlocked) return;
    setBusy(true);
    setError(null);
    try {
      if (intent === 'question') await props.onQuestion(value);
      else if (intent === 'redirect') await props.onRedirect(value, refs);
      else await props.onWork(value, refs);
      setText('');
      setRefs([]);
      setOverride(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const payload = event.dataTransfer.getData(REF_MIME);
    const dropped = payload ? parseDroppedRef(payload) : null;
    if (dropped) {
      setRefs((current) => addRef(current, dropped));
      return;
    }
    for (const file of Array.from(event.dataTransfer.files)) {
      const path = window.mission?.pathForFile?.(file) || file.name;
      setRefs((current) => addRef(current, { kind: 'file', id: path, label: file.name }));
    }
  };

  const offered = props.suggestions.filter((s) => !refs.some((r) => r.kind === s.kind && r.id === s.id)).slice(0, 3);

  return (
    <div className="composer2" data-variant={props.variant} data-dragging={dragging}>
      <form
        className="composer2-box"
        onSubmit={(event) => { event.preventDefault(); void send(); }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        {(refs.length > 0 || offered.length > 0) && (
          <ul className="context-chips" aria-label="Context">
            {refs.map((ref) => (
              <li key={`${ref.kind}:${ref.id}`}>
                <span className="chip" data-attached="true">
                  {ref.label}
                  <button type="button" aria-label={`Remove ${ref.label}`} onClick={() => setRefs((current) => current.filter((r) => r !== ref))}>
                    <Icon name="close" size={12} />
                  </button>
                </span>
              </li>
            ))}
            {offered.map((ref) => (
              <li key={`offer:${ref.kind}:${ref.id}`}>
                <button type="button" className="chip" data-attached="false" onClick={() => setRefs((current) => addRef(current, ref))}>
                  <Icon name="plus" size={12} /> {ref.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          value={text}
          rows={1}
          placeholder={props.variant === 'hero' ? 'Tell CherryOnTop what you want to accomplish…' : 'Ask, add work, or change direction…'}
          aria-label="Tell CherryOnTop what you want"
          aria-describedby="composer-hint"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer2-foot">
          {props.mandates.length > 0 && (
            <span className="authority-chip" title="What new work is allowed to do">
              {props.onAuthority ? (
                <button type="button" className="authority-open" aria-label="Review what new work may do" title="Review what new work may do" onClick={props.onAuthority}>
                  <Icon name="shield" size={13} />
                </button>
              ) : <Icon name="shield" size={13} />}
              <select
                value={props.mandateId ?? ''}
                aria-label="Mandate new work runs under"
                onChange={(event) => props.onSelectMandate(event.target.value)}
              >
                {props.mandates.map((mandate) => <option key={mandate.id} value={mandate.id}>{mandate.name}</option>)}
              </select>
            </span>
          )}
          {props.liveRun && intent !== 'question' ? (
            <div className="intent-toggle" role="radiogroup" aria-label="What to do with the current run">
              <button type="button" role="radio" aria-checked={intent === 'work'} onClick={() => setOverride('work')}>Add as new work</button>
              <button type="button" role="radio" aria-checked={intent === 'redirect'} onClick={() => setOverride('redirect')}>Redirect current run</button>
            </div>
          ) : (
            <span className="intent-hint" id="composer-hint">{text.trim() ? HINT[intent] : ''}</span>
          )}
          <button
            type="submit"
            className="send"
            aria-label={HINT[intent]}
            title={HINT[intent]}
            disabled={busy || !text.trim() || workBlocked}
          >
            <Icon name="send" size={16} />
          </button>
        </div>
      </form>
      {workBlocked && text.trim() && (
        <p className="composer-note" role="status">{props.offline ? 'Offline — new work can start once the daemon is reachable.' : props.blockedReason}</p>
      )}
      {error && <p className="composer-note" data-tone="problem" role="alert">{error}</p>}
    </div>
  );
}
