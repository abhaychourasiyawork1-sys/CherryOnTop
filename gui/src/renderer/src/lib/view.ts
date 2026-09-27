/** Where the window is. Home, or a Workspace — and inside a Workspace, the
 *  conversation or one of the deeper organization views. Files, Plan and
 *  Memory are not places: they are surfaces that open beside the conversation
 *  (see surfaces.ts), which is what keeps the conversation primary.
 *
 *  A router dependency for this would be a few lines of state replaced by
 *  fourteen kilobytes. */
export type Section = 'chat' | 'decisions' | 'runs' | 'agents' | 'evidence' | 'authority';

/** Inside a Workspace you are always in one chat session — or, with
 *  `sessionId` null, about to start one: the first message creates it. */
export type View =
  | { name: 'home' }
  | { name: 'mandates'; id: string | null }
  | { name: 'workspace'; key: string; sessionId: string | null; section: Section; caseId: string | null; nodeId: string | null };

/** The deeper organization views, revealed contextually. */
export const ORGANIZATION: { id: Section; label: string }[] = [
  { id: 'agents', label: 'Chart' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'runs', label: 'Runs' },
];

export const SECTION_LABEL: Record<Section, string> = {
  chat: 'Chat',
  decisions: 'Decisions',
  runs: 'Runs',
  agents: 'Organization',
  evidence: 'Evidence',
  authority: 'Authority',
};

export function inWorkspace(view: View): view is Extract<View, { name: 'workspace' }> {
  return view.name === 'workspace';
}

export function openSession(key: string, sessionId: string | null, caseId: string | null = null): View {
  return { name: 'workspace', key, sessionId, section: 'chat', caseId, nodeId: null };
}

/** One level up: a deeper view returns to its Workspace's conversation, and
 *  the conversation returns Home. */
export function parentOf(view: View): View {
  if (view.name !== 'workspace') return { name: 'home' };
  if (view.section !== 'chat') return { ...view, section: 'chat', nodeId: null };
  return { name: 'home' };
}
