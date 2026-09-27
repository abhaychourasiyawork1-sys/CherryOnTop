import { useEffect, useRef, useState } from 'react';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { Envelope } from './Envelope.js';
import { Icon } from '../shell/Icon.js';
import {
  CAPABILITIES, BUDGET_PRESETS, capabilityState, setCapability, extraTools,
  type Authority, type Envelope as EnvelopeData, type Mandate,
} from '../lib/mandates.js';

type Draft = Omit<Mandate, 'id' | 'builtin' | 'summary'>;

const BLANK: Draft = {
  name: '',
  description: '',
  authority: { tools: ['Read', 'Grep', 'Glob'], spawn_children: false, max_child_count: 0, budget_usd: 5 },
  constraints: [],
};

const NEW = '__new__';

function draftOf(mandate: Mandate): Draft {
  return {
    name: mandate.name,
    description: mandate.description,
    authority: { ...mandate.authority, tools: [...mandate.authority.tools] },
    constraints: [...mandate.constraints],
  };
}

const same = (a: Draft | null, b: Draft | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Mandates: what work is allowed to do, authored before it runs.
 *
 * A list on the left, one mandate open on the right, and — beside the form —
 * what it permits, worked out by the daemon as you edit. Every run records the
 * mandate as it stood when it started, so editing here never rewrites the past.
 */
export function MandatesPage(props: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The mandate new work starts under. */
  defaultId: string | null;
  onMakeDefault: (id: string) => void;
  onChanged: () => void;
}) {
  const list = useDaemonQuery<Mandate[]>(() => daemon().mandate.list.query() as Promise<Mandate[]>, []);
  const mandates = list.data ?? [];
  const selectedId = props.selectedId ?? props.defaultId ?? mandates[0]?.id ?? null;
  const selected = mandates.find((m) => m.id === selectedId) ?? null;
  const isNew = selectedId === NEW;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Load the selection into the form. A new mandate may be seeded (duplicate).
  const seed = useRef<Draft | null>(null);
  useEffect(() => {
    setError(null);
    setConfirmDelete(false);
    if (isNew) {
      const start = seed.current ?? { ...BLANK, authority: { ...BLANK.authority, tools: [...BLANK.authority.tools] } };
      seed.current = null;
      setDraft(start);
      setSaved(null);
      return;
    }
    if (!selected) { setDraft(null); setSaved(null); return; }
    const loaded = draftOf(selected);
    setDraft(loaded);
    setSaved(loaded);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, isNew, selected?.id, list.data]);

  const dirty = draft !== null && (isNew || !same(draft, saved));
  const nameMissing = draft !== null && !draft.name.trim();

  const leave = (next: string | null) => {
    if (next === selectedId) return;
    if (dirty && !window.confirm('Discard the changes to this mandate?')) return;
    props.onSelect(next);
  };

  const save = async () => {
    if (!draft || nameMissing || busy) return;
    setBusy(true);
    setError(null);
    const body = { ...draft, name: draft.name.trim(), description: draft.description.trim() };
    try {
      if (isNew) {
        const created = await daemon().mandate.create.mutate(body) as { id: string };
        list.reload();
        props.onSelect(created.id);
      } else if (selectedId) {
        await daemon().mandate.update.mutate({ id: selectedId, ...body });
        setSaved(body);
        setDraft(body);
        list.reload();
      }
      setFlash('Saved');
      props.onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Ctrl+S saves, as in any editor.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash]);

  const act = async (what: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    try {
      await what();
      list.reload();
      props.onChanged();
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const duplicate = () => {
    if (!draft) return;
    if (dirty && !window.confirm('Discard the changes to this mandate?')) return;
    seed.current = { ...draft, name: `${draft.name} copy`, authority: { ...draft.authority, tools: [...draft.authority.tools] }, constraints: [...draft.constraints] };
    props.onSelect(NEW);
  };

  return (
    <div className="mandates-page">
      <aside className="mandate-index" aria-label="Mandates">
        <div className="mandate-index-head">
          <p className="mandate-index-lead">What work is allowed to do. Every run keeps the mandate it started under.</p>
          <button type="button" className="button primary" onClick={() => leave(NEW)}>
            <Icon name="plus" size={14} /> New mandate
          </button>
        </div>
        <ul className="mandate-rows">
          {isNew && (
            <li>
              <button type="button" className="mandate-row" aria-current="true">
                <span className="mandate-row-name">{draft?.name.trim() || 'Untitled mandate'}</span>
                <span className="mandate-row-sub">Not saved yet</span>
              </button>
            </li>
          )}
          {mandates.map((mandate) => (
            <li key={mandate.id}>
              <button
                type="button"
                className="mandate-row"
                aria-current={mandate.id === selectedId ? 'true' : undefined}
                onClick={() => leave(mandate.id)}
              >
                <span className="mandate-row-name">
                  {mandate.name}
                  {mandate.id === props.defaultId && <span className="badge">Default</span>}
                </span>
                <span className="mandate-row-sub">{mandate.summary ?? mandate.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {draft ? (
        <Editor
          key={selectedId ?? 'none'}
          draft={draft}
          onChange={setDraft}
          builtin={selected?.builtin ?? false}
          isNew={isNew}
          isDefault={selectedId === props.defaultId}
          dirty={dirty}
          nameMissing={nameMissing}
          busy={busy}
          error={error}
          flash={flash}
          confirmDelete={confirmDelete}
          onSave={() => void save()}
          onDiscard={() => (isNew ? props.onSelect(null) : setDraft(saved))}
          onDuplicate={duplicate}
          onMakeDefault={selectedId && !isNew ? () => props.onMakeDefault(selectedId) : undefined}
          onReset={selected?.builtin ? () => void act(() => daemon().mandate.reset.mutate({ id: selected.id })) : undefined}
          onDelete={selected && !selected.builtin ? () => {
            if (!confirmDelete) { setConfirmDelete(true); return; }
            void act(() => daemon().mandate.delete.mutate({ id: selected.id }), () => props.onSelect(null));
          } : undefined}
        />
      ) : (
        <div className="mandate-editor-empty">
          <p>{list.loading ? 'Reading mandates…' : 'Choose a mandate, or make a new one.'}</p>
        </div>
      )}
    </div>
  );
}

function Editor(props: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  builtin: boolean;
  isNew: boolean;
  isDefault: boolean;
  dirty: boolean;
  nameMissing: boolean;
  busy: boolean;
  error: string | null;
  flash: string | null;
  confirmDelete: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onDuplicate: () => void;
  onMakeDefault?: () => void;
  onReset?: () => void;
  onDelete?: () => void;
}) {
  const { draft } = props;
  const tools = draft.authority.tools;
  const setAuthority = (patch: Partial<Authority>) => props.onChange({ ...draft, authority: { ...draft.authority, ...patch } });
  const [extra, setExtra] = useState('');
  const [instruction, setInstruction] = useState('');
  const envelope = useSimulation(draft.authority, draft.constraints);

  const addExtra = () => {
    const tool = extra.trim();
    setExtra('');
    if (tool && !tools.includes(tool)) setAuthority({ tools: [...tools, tool] });
  };
  const addInstruction = () => {
    const line = instruction.trim();
    setInstruction('');
    if (line) props.onChange({ ...draft, constraints: [...draft.constraints, line] });
  };

  return (
    <div className="mandate-editor2">
      <form className="mandate-form" onSubmit={(event) => { event.preventDefault(); props.onSave(); }}>
        <div className="mandate-title-row">
          <input
            className="mandate-name-input"
            value={draft.name}
            placeholder="Name this mandate"
            aria-label="Mandate name"
            aria-invalid={props.nameMissing}
            autoFocus={props.isNew}
            onChange={(event) => props.onChange({ ...draft, name: event.target.value })}
          />
          {props.builtin && <span className="badge quiet">Built in</span>}
        </div>
        <textarea
          className="mandate-desc-input"
          rows={2}
          value={draft.description}
          placeholder="What it is for — shown when someone picks it"
          aria-label="What it is for"
          onChange={(event) => props.onChange({ ...draft, description: event.target.value })}
        />

        <section className="mandate-section" aria-labelledby="m-can">
          <h2 id="m-can">What it can do</h2>
          {tools.length === 0 && (
            <div className="mandate-callout" data-tone="attention">
              <p>No tools are listed, so work under this mandate may use <strong>any tool</strong> its runtime offers (except GitHub, which is only ever given by name).</p>
              <button type="button" className="quiet-link" onClick={() => setAuthority({ tools: ['Read', 'Grep', 'Glob'] })}>Start from read-only</button>
            </div>
          )}
          <ul className="capabilities">
            {CAPABILITIES.map((capability) => {
              const state = capabilityState(tools, capability);
              return (
                <li key={capability.id} className="capability" data-state={state}>
                  <label className="capability-main">
                    <span className="capability-text">
                      <span className="capability-label">{capability.label}</span>
                      <span className="capability-detail">{capability.detail}</span>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      className="switch"
                      checked={state === 'on'}
                      aria-checked={state === 'partial' ? 'mixed' : state === 'on'}
                      ref={(el) => { if (el) el.indeterminate = state === 'partial'; }}
                      onChange={(event) => setAuthority({ tools: setCapability(tools, capability, event.target.checked) })}
                    />
                  </label>
                  {capability.tools.length > 1 && state !== 'off' && (
                    <div className="capability-tools" aria-label={`${capability.label} tools`}>
                      {capability.tools.map((tool) => (
                        <button
                          key={tool}
                          type="button"
                          className="tool-chip"
                          aria-pressed={tools.includes(tool)}
                          onClick={() => setAuthority({ tools: tools.includes(tool) ? tools.filter((t) => t !== tool) : [...tools, tool] })}
                        >
                          {tool}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="extra-tools">
            <span className="field-label">Other tools, by name</span>
            <div className="extra-tools-row">
              {extraTools(tools).map((tool) => (
                <span key={tool} className="tool-chip" data-extra="true">
                  {tool}
                  <button type="button" aria-label={`Remove ${tool}`} onClick={() => setAuthority({ tools: tools.filter((t) => t !== tool) })}>
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
              <input
                value={extra}
                placeholder="e.g. mcp__linear__create_issue"
                aria-label="Add a tool by name"
                onChange={(event) => setExtra(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addExtra(); } }}
                onBlur={addExtra}
              />
            </div>
          </div>
        </section>

        <section className="mandate-section" aria-labelledby="m-team">
          <h2 id="m-team">Team</h2>
          <label className="setting-row">
            <span className="capability-text">
              <span className="capability-label">May build a team of agents</span>
              <span className="capability-detail">Split the work across agents it staffs and checks, at any depth.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={draft.authority.spawn_children}
              onChange={(event) => setAuthority({
                spawn_children: event.target.checked,
                max_child_count: event.target.checked ? Math.max(2, draft.authority.max_child_count) : 0,
              })}
            />
          </label>
          {draft.authority.spawn_children && (
            <div className="setting-row">
              <span className="capability-label">At most</span>
              <Stepper
                value={draft.authority.max_child_count}
                min={1}
                unit={draft.authority.max_child_count === 1 ? 'agent' : 'agents'}
                label="Most agents"
                onChange={(value) => setAuthority({ max_child_count: value })}
              />
            </div>
          )}
        </section>

        <section className="mandate-section" aria-labelledby="m-spend">
          <h2 id="m-spend">Spend</h2>
          <div className="setting-row">
            <span className="capability-text">
              <span className="capability-label">Most one run may spend</span>
              <span className="capability-detail">{draft.authority.budget_usd > 0 ? 'Work stops and asks you before going past this.' : '$0 means no limit is enforced.'}</span>
            </span>
            <span className="money-input">
              <span aria-hidden="true">$</span>
              <input
                type="number"
                min={0}
                step={0.5}
                aria-label="Budget in US dollars"
                value={draft.authority.budget_usd}
                onChange={(event) => setAuthority({ budget_usd: Math.max(0, Number(event.target.value) || 0) })}
              />
            </span>
          </div>
          <div className="presets" role="group" aria-label="Common budgets">
            {BUDGET_PRESETS.map((amount) => (
              <button key={amount} type="button" className="tool-chip" aria-pressed={draft.authority.budget_usd === amount} onClick={() => setAuthority({ budget_usd: amount })}>
                ${amount}
              </button>
            ))}
          </div>
        </section>

        <section className="mandate-section" aria-labelledby="m-rules">
          <h2 id="m-rules">Standing instructions</h2>
          <p className="section-hint">Told to every run under this mandate. They guide the agent; they are not enforced like the settings above.</p>
          {draft.constraints.length > 0 && (
            <ol className="instructions">
              {draft.constraints.map((line, index) => (
                <li key={`${index}:${line}`}>
                  <input
                    value={line}
                    aria-label={`Instruction ${index + 1}`}
                    onChange={(event) => props.onChange({ ...draft, constraints: draft.constraints.map((c, i) => (i === index ? event.target.value : c)) })}
                    onBlur={(event) => { if (!event.target.value.trim()) props.onChange({ ...draft, constraints: draft.constraints.filter((_, i) => i !== index) }); }}
                  />
                  <button type="button" className="icon-button tiny" aria-label={`Remove instruction ${index + 1}`} onClick={() => props.onChange({ ...draft, constraints: draft.constraints.filter((_, i) => i !== index) })}>
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="instruction-add">
            <input
              value={instruction}
              placeholder="Add an instruction, e.g. Never touch the migrations folder"
              aria-label="New instruction"
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addInstruction(); } }}
            />
            <button type="button" className="button" onClick={addInstruction} disabled={!instruction.trim()}>Add</button>
          </div>
        </section>

        <div className="mandate-more">
          {props.onMakeDefault && (
            props.isDefault
              ? <span className="mandate-default-note"><Icon name="check" size={13} /> New work starts under this mandate</span>
              : <button type="button" className="quiet-link" onClick={props.onMakeDefault}>Use for new work by default</button>
          )}
          {!props.isNew && <button type="button" className="quiet-link" onClick={props.onDuplicate}>Duplicate</button>}
          {props.onReset && <button type="button" className="quiet-link" onClick={props.onReset}>Reset to shipped settings</button>}
          {props.onDelete && (
            <button type="button" className="quiet-link danger" onClick={props.onDelete}>
              {props.confirmDelete ? 'Press again to delete' : 'Delete mandate'}
            </button>
          )}
        </div>

        <div className="save-bar" data-dirty={props.dirty}>
          <span className="save-state" role="status">
            {props.error ?? (props.nameMissing ? 'Give it a name to save it.' : props.flash ?? (props.dirty ? 'Unsaved changes' : 'All changes saved'))}
          </span>
          {props.dirty && <button type="button" className="button" onClick={props.onDiscard}>Discard</button>}
          <button type="submit" className="button primary" disabled={!props.dirty || props.nameMissing || props.busy}>
            {props.isNew ? 'Create mandate' : 'Save'} <kbd>Ctrl S</kbd>
          </button>
        </div>
      </form>

      <aside className="mandate-preview" aria-labelledby="m-preview">
        <h2 id="m-preview">Before anything runs</h2>
        <p className="section-hint">Worked out from the settings alone, as you edit. Nothing is spent.</p>
        {envelope ? <Envelope envelope={envelope} /> : <p className="surface-empty">Working it out…</p>}
      </aside>
    </div>
  );
}

function Stepper(props: { value: number; min: number; unit: string; label: string; onChange: (value: number) => void }) {
  return (
    <span className="stepper">
      <button type="button" aria-label={`Fewer ${props.unit}`} disabled={props.value <= props.min} onClick={() => props.onChange(Math.max(props.min, props.value - 1))}>−</button>
      <input
        type="number"
        min={props.min}
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(Math.max(props.min, Math.round(Number(event.target.value) || props.min)))}
      />
      <button type="button" aria-label={`More ${props.unit}`} onClick={() => props.onChange(props.value + 1)}>+</button>
      <span className="stepper-unit">{props.unit}</span>
    </span>
  );
}

/** The daemon computes the envelope so the window, the CLI and the receipt can
 *  never describe the same mandate three different ways. */
function useSimulation(authority: Authority, constraints: string[]): EnvelopeData | null {
  const [envelope, setEnvelope] = useState<EnvelopeData | null>(null);
  const key = JSON.stringify([authority, constraints]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      daemon().mandate.simulate.query({ authority, constraints })
        .then((result) => { if (!cancelled) setEnvelope((result as { envelope: EnvelopeData }).envelope); })
        .catch(() => { if (!cancelled) setEnvelope(null); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return envelope;
}
