import { useEffect, useState } from 'react';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { Envelope } from './Envelope.js';
import { money } from '../lib/format.js';
import { COMMON_TOOLS, type Authority, type Envelope as EnvelopeData, type Mandate } from '../lib/mandates.js';

const BLANK: Omit<Mandate, 'id' | 'builtin'> = {
  name: 'New mandate',
  description: '',
  authority: { tools: ['Read', 'Grep', 'Glob'], spawn_children: false, max_child_count: 0, budget_usd: 5 },
  constraints: [],
};

/**
 * The mandate library.
 *
 * Form-first, and deliberately not a canvas: the thing being authored is a set
 * of limits, and limits are a form. The simulator beside it is the point — you
 * are told the blast radius as you type, for free, before anything runs.
 */
export function Mandates({ onChanged }: { onChanged: () => void }) {
  const mandates = useDaemonQuery<Mandate[]>(() => daemon().mandate.list.query() as Promise<Mandate[]>, []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Omit<Mandate, 'id' | 'builtin'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);

  const list = mandates.data ?? [];
  const editing = list.find((mandate) => mandate.id === editingId) ?? null;

  const startEdit = (mandate: Mandate) => {
    setEditingId(mandate.id);
    setDraft({
      name: mandate.name, description: mandate.description,
      authority: { ...mandate.authority, tools: [...mandate.authority.tools] },
      constraints: [...mandate.constraints],
    });
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      if (editingId) await daemon().mandate.update.mutate({ id: editingId, ...draft });
      else {
        const created = await daemon().mandate.create.mutate(draft);
        setEditingId((created as { id: string }).id);
      }
      mandates.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await daemon().mandate.delete.mutate({ id });
      if (editingId === id) { setEditingId(null); setDraft(null); }
      mandates.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mandates">
      <header className="sheet-head">
        <div>
          <h1>Mandates</h1>
          <p className="sheet-lead">
            What an organization is permitted to do, authored before it runs. Every case
            records the mandate it ran under, frozen as it stood — editing one here never
            rewrites what a past run was allowed to do.
          </p>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={() => { setEditingId(null); setDraft({ ...BLANK, authority: { ...BLANK.authority } }); }}
        >
          New mandate
        </button>
      </header>

      {error && <p className="inbox-error">{error}</p>}

      <div className="mandate-layout">
        <ul className="mandate-list">
          {list.map((mandate) => (
            <li key={mandate.id}>
              <button
                type="button"
                className="mandate-card"
                aria-current={editingId === mandate.id}
                onClick={() => startEdit(mandate)}
              >
                <span className="mandate-card-head">
                  <span className="mandate-mark" aria-hidden="true">⛨</span>
                  <span className="mandate-name">{mandate.name}</span>
                  {mandate.builtin && <span className="tag tag-quiet">built in</span>}
                </span>
                <span className="mandate-desc">{mandate.description}</span>
                <span className="figure mandate-summary">{mandate.summary}</span>
              </button>
              <div className="mandate-card-actions">
                <button
                  type="button"
                  className="linkish"
                  onClick={() => setComparing(comparing === mandate.id ? null : mandate.id)}
                >
                  {comparing === mandate.id ? 'stop comparing' : 'compare'}
                </button>
                {!mandate.builtin && (
                  <button type="button" className="linkish linkish-danger" onClick={() => void remove(mandate.id)}>
                    delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="mandate-editor">
          {draft ? (
            <Editor
              draft={draft}
              readOnlyName={editing?.builtin ?? false}
              onChange={setDraft}
              onSave={() => void save()}
              onCancel={() => { setDraft(null); setEditingId(null); }}
              compareWith={comparing ? list.find((m) => m.id === comparing) ?? null : null}
            />
          ) : (
            <div className="graph-empty">
              <h1>Pick a mandate.</h1>
              <p>
                Or make a new one. As you change it, the panel below says exactly what an
                organization under it could and could not do — before you spend anything.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Editor(props: {
  draft: Omit<Mandate, 'id' | 'builtin'>;
  readOnlyName: boolean;
  onChange: (draft: Omit<Mandate, 'id' | 'builtin'>) => void;
  onSave: () => void;
  onCancel: () => void;
  compareWith: Mandate | null;
}) {
  const { draft } = props;
  const setAuthority = (patch: Partial<Authority>) =>
    props.onChange({ ...draft, authority: { ...draft.authority, ...patch } });

  const envelope = useSimulation(draft.authority, draft.constraints);
  const other = useSimulation(
    props.compareWith?.authority ?? null,
    props.compareWith?.constraints ?? [],
  );

  return (
    <div className="editor">
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(event) => props.onChange({ ...draft, name: event.target.value })}
        />
      </label>

      <label className="field">
        <span>What it is for</span>
        <input
          value={draft.description}
          placeholder="Reads and reports. Cannot change anything."
          onChange={(event) => props.onChange({ ...draft, description: event.target.value })}
        />
      </label>

      <fieldset className="field">
        <legend>Tools it may use</legend>
        <div className="tool-grid">
          {[...new Set([...COMMON_TOOLS, ...draft.authority.tools])].map((tool) => (
            <button
              key={tool}
              type="button"
              className="chip"
              aria-pressed={draft.authority.tools.includes(tool)}
              onClick={() => setAuthority({
                tools: draft.authority.tools.includes(tool)
                  ? draft.authority.tools.filter((t) => t !== tool)
                  : [...draft.authority.tools, tool],
              })}
            >
              {tool}
            </button>
          ))}
        </div>
        {draft.authority.tools.length === 0 && (
          <p className="field-warn">
            An empty list means <strong>no restriction</strong> — the agent may use any tool its
            runtime offers. Pick tools to make this a real boundary.
          </p>
        )}
      </fieldset>

      <label className="field field-inline">
        <span>May delegate</span>
        <input
          type="checkbox"
          checked={draft.authority.spawn_children}
          onChange={(event) => setAuthority({
            spawn_children: event.target.checked,
            max_child_count: event.target.checked ? Math.max(1, draft.authority.max_child_count) : 0,
          })}
        />
      </label>

      {draft.authority.spawn_children && (
        <label className="field">
          <span>Most agents it may build: <span className="figure">{draft.authority.max_child_count}</span></span>
          <input
            type="range" min={1} max={8} step={1}
            value={draft.authority.max_child_count}
            onChange={(event) => setAuthority({ max_child_count: Number(event.target.value) })}
          />
        </label>
      )}

      <label className="field">
        <span>Total it may spend: <span className="figure">{money(draft.authority.budget_usd)}</span></span>
        <input
          type="range" min={0.5} max={100} step={0.5}
          value={draft.authority.budget_usd}
          onChange={(event) => setAuthority({ budget_usd: Number(event.target.value) })}
        />
      </label>

      <label className="field">
        <span>Instructions (told to the agent, not enforced)</span>
        <textarea
          rows={3}
          value={draft.constraints.join('\n')}
          placeholder={'Do not touch the database.\nOne line each.'}
          onChange={(event) => props.onChange({
            ...draft,
            constraints: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean),
          })}
        />
      </label>

      <div className="editor-actions">
        <button type="button" className="approve" onClick={props.onSave}>Save</button>
        <button type="button" className="ghost-button" onClick={props.onCancel}>Cancel</button>
      </div>

      <section className="simulator">
        <h3>Before you run it</h3>
        {envelope ? <Envelope envelope={envelope} /> : <p className="tab-empty">…</p>}
        <p className="simulator-note">
          Worked out from the contract alone — no model, no sandbox, nothing spent.
        </p>
      </section>

      {props.compareWith && other && (
        <section className="simulator simulator-compare">
          <h3>Compared with {props.compareWith.name}</h3>
          <Envelope envelope={other} compact />
        </section>
      )}
    </div>
  );
}

/** The daemon computes the envelope so the window, the CLI and the receipt can
 *  never describe the same mandate three different ways. */
function useSimulation(authority: Authority | null, constraints: string[]): EnvelopeData | null {
  const [envelope, setEnvelope] = useState<EnvelopeData | null>(null);
  const key = authority ? JSON.stringify([authority, constraints]) : null;

  useEffect(() => {
    if (!authority) { setEnvelope(null); return; }
    let cancelled = false;
    daemon().mandate.simulate.query({ authority, constraints })
      .then((result) => { if (!cancelled) setEnvelope((result as { envelope: EnvelopeData }).envelope); })
      .catch(() => { if (!cancelled) setEnvelope(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return envelope;
}
