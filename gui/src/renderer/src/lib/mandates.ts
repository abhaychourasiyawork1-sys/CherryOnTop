export interface Authority {
  tools: string[];
  spawn_children: boolean;
  max_child_count: number;
  budget_usd: number;
}

export interface Mandate {
  id: string;
  name: string;
  description: string;
  authority: Authority;
  constraints: string[];
  builtin: boolean;
  /** The one-line envelope, computed by the daemon so the window and the CLI can
   *  never describe the same mandate differently. */
  summary?: string;
}

export interface Envelope {
  permits: string[];
  stops: string[];
  advisory: string[];
}

/** The tools a mandate editor offers. Not an exhaustive list of what a runtime
 *  can do — an allowlist the user can also type into — but the set that covers
 *  the choices worth making without reading documentation. */
export const COMMON_TOOLS = [
  'Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch',
];
