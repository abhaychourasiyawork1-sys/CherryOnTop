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

/** What a mandate can let work do, in the words a person decides in. Each
 *  capability is a set of runtime tools; the editor switches the set, and
 *  anything not covered here is shown as a named extra tool. */
export interface Capability {
  id: string;
  label: string;
  detail: string;
  tools: string[];
}

export const CAPABILITIES: Capability[] = [
  { id: 'read', label: 'Read the code', detail: 'Open, search and list files in the workspace.', tools: ['Read', 'Grep', 'Glob'] },
  { id: 'edit', label: 'Change files', detail: 'Create and edit files, notebooks included.', tools: ['Write', 'Edit', 'NotebookEdit'] },
  { id: 'run', label: 'Run commands', detail: 'Build, test and use git inside the sandbox.', tools: ['Bash'] },
  { id: 'web', label: 'Use the web', detail: 'Search the web and read pages.', tools: ['WebSearch', 'WebFetch'] },
  // Not a runtime tool: it hands the run your GitHub login.
  { id: 'github', label: 'Act on GitHub as you', detail: 'Push branches, open pull requests and work with issues, using your GitHub login.', tools: ['GitHub'] },
];

export type CapabilityState = 'on' | 'partial' | 'off';

export function capabilityState(tools: string[], capability: Capability): CapabilityState {
  const held = capability.tools.filter((tool) => tools.includes(tool)).length;
  return held === 0 ? 'off' : held === capability.tools.length ? 'on' : 'partial';
}

/** Switches a whole capability, keeping the order the other tools were in. */
export function setCapability(tools: string[], capability: Capability, on: boolean): string[] {
  const rest = tools.filter((tool) => !capability.tools.includes(tool));
  return on ? [...rest, ...capability.tools] : rest;
}

/** Tools granted by name that no capability describes (MCP tools and the like). */
export function extraTools(tools: string[]): string[] {
  const known = new Set(CAPABILITIES.flatMap((c) => c.tools));
  return tools.filter((tool) => !known.has(tool));
}

export const BUDGET_PRESETS = [1, 5, 25, 100];
