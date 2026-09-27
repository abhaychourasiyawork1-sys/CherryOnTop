import { useMemo, useState } from 'react';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { workspaceMemory, SECTIONS, TYPE_LABEL, type CaseRecord, type MemoryItem } from '../lib/memory.js';
import { ago, when } from '../lib/format.js';
import { Memory as OrganizationMemory } from '../panels/Memory.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';

/** How many recent runs Workspace memory is built from. */
const RECENT = 12;

/** What the organization understands about this Workspace. Scoped to it by
 *  construction — every item comes from one of its runs. The organization-wide
 *  record (how runtimes perform across every Workspace) is a separate scope,
 *  opened deliberately, never mixed in. */
export function MemorySurface() {
  const ws = useWorkspace();
  const recent = ws.workspace.cases.slice(0, RECENT);
  const stamp = recent.map((root) => root.updatedAt).join('|');
  const [scope, setScope] = useState<'workspace' | 'global'>('workspace');

  const records = useDaemonQuery<CaseRecord[]>(
    () => Promise.all(recent.map((root) =>
      (daemon().case.file.query({ id: root.id }) as Promise<CaseRecord>).catch(() => null)))
      .then((rows) => rows.filter((row): row is CaseRecord => row !== null)),
    [stamp],
  );
  const items = useMemo(() => workspaceMemory(records.data ?? []), [records.data]);

  return (
    <div className="memory2">
      <div className="segmented" role="tablist" aria-label="Memory scope">
        <button type="button" role="tab" aria-selected={scope === 'workspace'} onClick={() => setScope('workspace')}>This Workspace</button>
        <button type="button" role="tab" aria-selected={scope === 'global'} onClick={() => setScope('global')}>All Workspaces</button>
      </div>

      {scope === 'global' ? (
        <div className="memory-global">
          <p className="surface-note">Shared across every Workspace: how each runtime has performed. It informs routing; it never carries one project’s details into another.</p>
          <OrganizationMemory onChanged={ws.org.refresh} revision={ws.org.revision} />
        </div>
      ) : records.loading && !records.data ? (
        <p className="surface-empty">Reading what this Workspace has learned…</p>
      ) : items.length === 0 ? (
        <p className="surface-empty">Nothing learned yet. Finished runs, your decisions and the rules work runs under collect here.</p>
      ) : (
        SECTIONS.map((section) => {
          const inSection = items.filter((item) => item.section === section.id);
          if (inSection.length === 0) return null;
          return (
            <section key={section.id} className="memory-section" aria-labelledby={`mem-${section.id}`}>
              <h3 id={`mem-${section.id}`} className="section-label">{section.label}</h3>
              <ul className="memory-items">
                {inSection.slice(0, 8).map((item) => <MemoryRow key={item.id} item={item} />)}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

function MemoryRow({ item }: { item: MemoryItem }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <li className="memory-item" data-type={item.type}>
      <button type="button" className="memory-text" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {item.text}
      </button>
      {open && (
        <dl className="memory-provenance">
          <div><dt>Kind</dt><dd>{TYPE_LABEL[item.type]}</dd></div>
          <div><dt>Confidence</dt><dd>{item.confidence === 'confirmed' ? 'Confirmed by a check or a person' : 'Stated by the run, not confirmed'}</dd></div>
          <div><dt>Last confirmed</dt><dd title={when(item.lastConfirmed)}>{ago(item.lastConfirmed)}</dd></div>
          <div>
            <dt>From</dt>
            <dd><button type="button" className="quiet-link" onClick={() => ws.focusCase(item.caseId)}>{item.caseTitle}</button></dd>
          </div>
        </dl>
      )}
    </li>
  );
}
