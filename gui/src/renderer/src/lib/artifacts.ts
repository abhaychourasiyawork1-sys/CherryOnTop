import type { OrgEvent } from './eventLog.js';
import type { ArtifactRow } from './run.js';

/** Files and other artifacts as one model, whatever their type.
 *
 *  The runtime records an artifact row for every file an agent wrote or edited,
 *  pointing at the event that did it. That event carries the tool call's own
 *  input, so the change itself — the before and after of an edit, the content
 *  of a write — can be shown without any new backend API and without reading
 *  the working tree (which may have moved on since). */

export type Presentation = 'code' | 'markdown' | 'image' | 'pdf' | 'table' | 'data' | 'diagram' | 'text';

const BY_EXTENSION: Record<string, Presentation> = {
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  pdf: 'pdf',
  csv: 'table', tsv: 'table', xlsx: 'table',
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', parquet: 'data',
  mmd: 'diagram', mermaid: 'diagram', dot: 'diagram',
  txt: 'text', log: 'text',
};

export function presentationOf(path: string): Presentation {
  const extension = path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
  return BY_EXTENSION[extension] ?? 'code';
}

/** The sandbox mounts the repository at /workspace; a person thinks of paths
 *  relative to their project. */
export function displayPath(path: string): string {
  return path.replace(/^\/workspace\//, '');
}

export interface FileChange {
  artifactId: string;
  nodeId: string;
  caseId: string;
  kind: 'file_edit' | 'file_write';
  at: string;
  eventId: number | null;
}

export interface FileEntry {
  path: string;
  display: string;
  presentation: Presentation;
  changes: FileChange[];
  lastAt: string;
}

/** Every file the Workspace's runs touched, newest change first, with the run
 *  and agent that produced each change — provenance comes with the file. */
export function fileIndex(artifacts: (ArtifactRow & { caseId: string; eventId?: number | null })[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  for (const artifact of artifacts) {
    if ((artifact.kind !== 'file_edit' && artifact.kind !== 'file_write') || !artifact.path) continue;
    const entry = byPath.get(artifact.path) ?? {
      path: artifact.path,
      display: displayPath(artifact.path),
      presentation: presentationOf(artifact.path),
      changes: [],
      lastAt: '',
    };
    const at = artifact.createdAt ?? '';
    entry.changes.push({
      artifactId: artifact.id, nodeId: artifact.nodeId, caseId: artifact.caseId,
      kind: artifact.kind, at, eventId: artifact.eventId ?? null,
    });
    if (at > entry.lastAt) entry.lastAt = at;
    byPath.set(artifact.path, entry);
  }
  for (const entry of byPath.values()) entry.changes.sort((a, b) => b.at.localeCompare(a.at));
  return [...byPath.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export type ChangeBody =
  | { kind: 'edit'; before: string; after: string }
  | { kind: 'write'; content: string };

/** The change an artifact's event made to `path`, read from the tool call. */
export function changeFromEvent(event: OrgEvent | undefined, path: string): ChangeBody | null {
  const content = (event?.payload as { message?: { content?: unknown[] } } | null)?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
    if (b.type !== 'tool_use' || b.input?.file_path !== path) continue;
    if (typeof b.input.old_string === 'string' && typeof b.input.new_string === 'string') {
      return { kind: 'edit', before: b.input.old_string, after: b.input.new_string };
    }
    if (typeof b.input.content === 'string') return { kind: 'write', content: b.input.content };
  }
  return null;
}

export interface DiffLine { sign: 'add' | 'remove' | 'context'; text: string }

/** A line diff, LCS-based. Bounded: past a few hundred lines on a side it
 *  degrades to remove-all/add-all rather than allocating a huge table on the
 *  render path. */
export function lineDiff(before: string, after: string, limit = 400): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > limit || b.length > limit) {
    return [...a.map((text) => ({ sign: 'remove' as const, text })), ...b.map((text) => ({ sign: 'add' as const, text }))];
  }
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ sign: 'context', text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ sign: 'remove', text: a[i++] });
    else out.push({ sign: 'add', text: b[j++] });
  }
  while (i < a.length) out.push({ sign: 'remove', text: a[i++] });
  while (j < b.length) out.push({ sign: 'add', text: b[j++] });
  return out;
}
