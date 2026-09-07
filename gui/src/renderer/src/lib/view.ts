/** Where the window is. Five destinations plus one that carries an id, which is
 *  the whole routing model — a router dependency for this would be five lines of
 *  state replaced by fourteen kilobytes. */
export type Aside = 'desk' | 'cases' | 'mandates' | 'memory';

export type CaseTab = 'conversation' | 'organization' | 'proof' | 'receipt';

export type View =
  | { name: Aside }
  | { name: 'case'; id: string; tab: CaseTab; nodeId: string | null };

export function isCase(view: View): view is Extract<View, { name: 'case' }> {
  return view.name === 'case';
}

/** Which nav item should look current. A case belongs to Cases. */
export function sectionOf(view: View): Aside {
  return isCase(view) ? 'cases' : view.name;
}
