import { lazy, Suspense, useMemo, useState } from 'react';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { fileIndex, changeFromEvent, lineDiff, displayPath, type FileEntry, type FileChange } from '../lib/artifacts.js';
import { titleOf } from '../lib/run.js';
import { ago, when } from '../lib/format.js';
import { agentName } from '../lib/agentName.js';
import { REF_MIME } from '../composer/ContextResolver.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';
import type { ArtifactRow } from '../lib/run.js';
import type { OrgEvent } from '../lib/eventLog.js';

// The Markdown renderer pulls in marked, DOMPurify and (lazily) mermaid; a file
// viewer should not pay for that until a Markdown file is actually opened.
const Markdown = lazy(() => import('../panels/Markdown.js').then((m) => ({ default: m.Markdown })));

/** How many of the Workspace's most recent runs Files reads. */
const RECENT_RUNS = 25;

/** Every file this Workspace's runs changed — the working set, not a file
 *  tree. Each row can be dragged into the composer as context. */
export function FilesSurface() {
  const ws = useWorkspace();
  const caseIds = ws.workspace.cases.slice(0, RECENT_RUNS).map((root) => root.id);
  const stamp = ws.workspace.cases.slice(0, RECENT_RUNS).map((root) => root.updatedAt).join('|');
  const [filter, setFilter] = useState('');

  const artifacts = useDaemonQuery<(ArtifactRow & { caseId: string; eventId?: number | null })[]>(
    async () => {
      const lists = await Promise.all(caseIds.map((id) =>
        daemon().artifact.listForSubtree.query({ nodeId: id })
          .then((rows) => (rows as (ArtifactRow & { eventId?: number | null })[]).map((row) => ({ ...row, caseId: id })))));
      return lists.flat();
    },
    [stamp],
  );

  const files = useMemo(() => fileIndex(artifacts.data ?? []), [artifacts.data]);
  const shown = filter ? files.filter((file) => file.display.toLowerCase().includes(filter.toLowerCase())) : files;

  if (artifacts.loading && !artifacts.data) return <p className="surface-empty">Reading what changed…</p>;
  if (files.length === 0) {
    return <p className="surface-empty">No files have been changed in this Workspace yet. Files the organization writes or edits appear here with the run that changed them.</p>;
  }

  return (
    <div className="files">
      {files.length > 8 && (
        <input
          className="surface-filter"
          type="search"
          placeholder="Filter files"
          aria-label="Filter files"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <ul className="file-list">
        {shown.map((file) => <FileRow key={file.path} file={file} />)}
      </ul>
    </div>
  );
}

function FileRow({ file }: { file: FileEntry }) {
  const ws = useWorkspace();
  const name = file.display.split('/').at(-1) ?? file.display;
  const dir = file.display.slice(0, file.display.length - name.length).replace(/\/$/, '');
  return (
    <li>
      <button
        type="button"
        className="file-row"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(REF_MIME, JSON.stringify({ kind: 'file', id: file.path, label: file.display }));
          event.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => ws.surfaces.open('artifact', file.path)}
      >
        <span className="file-name">{name}</span>
        <span className="file-dir">{dir}</span>
        <span className="file-meta">
          {file.changes.length} {file.changes.length === 1 ? 'change' : 'changes'} · {ago(file.lastAt)}
        </span>
      </button>
    </li>
  );
}

/** Node event lists are large and immutable once written; read each once. */
const nodeEvents = new Map<string, Promise<OrgEvent[]>>();
function eventsOfNode(nodeId: string): Promise<OrgEvent[]> {
  let cached = nodeEvents.get(nodeId);
  if (!cached) {
    cached = daemon().events.listForNode.query({ nodeId }) as Promise<OrgEvent[]>;
    cached.catch(() => nodeEvents.delete(nodeId));
    nodeEvents.set(nodeId, cached);
  }
  return cached;
}

/** One file: every change the organization made to it, newest first, each
 *  with the run and agent that made it. The change is read from the recorded
 *  tool call, so it shows what was actually done — not today's working tree. */
export function ArtifactSurface({ path }: { path: string }) {
  const ws = useWorkspace();
  const caseIds = ws.workspace.cases.slice(0, RECENT_RUNS).map((root) => root.id);
  const stamp = ws.workspace.cases.slice(0, RECENT_RUNS).map((root) => root.updatedAt).join('|');
  const artifacts = useDaemonQuery<(ArtifactRow & { caseId: string; eventId?: number | null })[]>(
    async () => {
      const lists = await Promise.all(caseIds.map((id) =>
        daemon().artifact.listForSubtree.query({ nodeId: id })
          .then((rows) => (rows as (ArtifactRow & { eventId?: number | null })[])
            .filter((row) => row.path === path).map((row) => ({ ...row, caseId: id })))));
      return lists.flat();
    },
    [path, stamp],
  );
  const entry = useMemo(() => fileIndex(artifacts.data ?? [])[0] ?? null, [artifacts.data]);

  if (!entry) return <p className="surface-empty">{artifacts.loading ? 'Reading…' : 'No recorded changes to this file.'}</p>;

  return (
    <div className="artifact">
      <p className="artifact-kind">{presentationLabel(entry.presentation)} · {entry.changes.length} recorded {entry.changes.length === 1 ? 'change' : 'changes'}</p>
      <ol className="changes">
        {entry.changes.map((change, index) => (
          <ChangeView key={change.artifactId} change={change} path={path} presentation={entry.presentation} initiallyOpen={index === 0} />
        ))}
      </ol>
    </div>
  );
}

function presentationLabel(p: FileEntry['presentation']): string {
  return { code: 'Code', markdown: 'Document', image: 'Image', pdf: 'PDF', table: 'Table', data: 'Data', diagram: 'Diagram', text: 'Text' }[p];
}

function ChangeView(props: { change: FileChange; path: string; presentation: FileEntry['presentation']; initiallyOpen: boolean }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(props.initiallyOpen);
  const node = ws.org.nodes.find((n) => n.id === props.change.nodeId);
  const root = ws.org.nodes.find((n) => n.id === props.change.caseId);
  const body = useDaemonQuery(
    () => (open && props.change.eventId != null
      ? eventsOfNode(props.change.nodeId).then((events) => changeFromEvent(events.find((e) => e.id === props.change.eventId), props.path))
      : Promise.resolve(null)),
    [open, props.change.eventId],
  );

  return (
    <li className="change">
      <button type="button" className="change-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="change-verb">{props.change.kind === 'file_write' ? 'Written' : 'Edited'}</span>
        <span className="change-by">by {node ? agentName(node.goal) : 'an agent'}</span>
        <time className="change-when" dateTime={props.change.at} title={when(props.change.at)}>{ago(props.change.at)}</time>
      </button>
      {root && (
        <button type="button" className="quiet-link change-run" onClick={() => ws.focusCase(root.id)}>
          In “{titleOf(root.goal)}”
        </button>
      )}
      {open && (
        body.loading ? <p className="surface-empty">Reading the change…</p>
          : !body.data ? <p className="surface-empty">The content of this change was not recorded.</p>
            : body.data.kind === 'edit' ? <Diff before={body.data.before} after={body.data.after} />
              : props.presentation === 'markdown'
                ? <Suspense fallback={<p className="surface-empty">Rendering…</p>}><div className="artifact-doc"><Markdown source={body.data.content} /></div></Suspense>
                : props.presentation === 'image' || props.presentation === 'pdf'
                  ? <p className="surface-empty">{displayPath(props.path)} can’t be previewed here. Open it from the project.</p>
                  : <pre className="artifact-code"><code>{body.data.content}</code></pre>
      )}
    </li>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  return (
    <pre className="artifact-diff" aria-label="Change, removed and added lines">
      {lines.map((line, index) => (
        <span key={index} data-sign={line.sign}>
          <span className="diff-sign" aria-hidden="true">{line.sign === 'add' ? '+' : line.sign === 'remove' ? '−' : ' '}</span>
          <span className="sr-only">{line.sign === 'add' ? 'added: ' : line.sign === 'remove' ? 'removed: ' : ''}</span>
          {line.text}{'\n'}
        </span>
      ))}
    </pre>
  );
}

