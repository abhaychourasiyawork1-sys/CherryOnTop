/** Where the window is. Home, or a Workspace — and inside a Workspace, the
 *  conversation or one of the deeper organization views. Files, Plan and
 *  Memory are not places: they are surfaces that open beside the conversation
 *  (see surfaces.ts), which is what keeps the conversation primary.
 *
 *  A router dependency for this would be a few lines of state replaced by
 *  fourteen kilobytes. */
export type Section = 'chat' | 'decisions' | 'runs' | 'agents' | 'evidence' | 'authority';

export type View =
  | { name: 'home' }
  | { name: 'workspace'; key: string; section: Section; caseId: string | null; nodeId: string | null };

/** The deeper organization views, revealed contextually. */
export const ORGANIZATION: { id: Section; label: string }[] = [
  { id: 'decisions', label: 'Decisions' },
  { id: 'runs', label: 'Runs' },
  { id: 'agents', label: 'Agents' },
  { id: 'evidence', label: 'Evidence' },
];

export const SECTION_LABEL: Record<Section, string> = {
  chat: 'Chat',
  decisions: 'Decisions',
  runs: 'Runs',
  agents: 'Agents',
  evidence: 'Evidence',
  authority: 'Authority',
};

export function inWorkspace(view: View): view is Extract<View, { name: 'workspace' }> {
  return view.name === 'workspace';
}

export function openWorkspace(key: string, caseId: string | null = null): View {
  return { name: 'workspace', key, section: 'chat', caseId, nodeId: null };
}

/** One level up: a deeper view returns to its Workspace's conversation, and
 *  the conversation returns Home. */
export function parentOf(view: View): View {
  if (view.name === 'home') return view;
  if (view.section !== 'chat') return { ...view, section: 'chat', nodeId: null };
  return { name: 'home' };
}
