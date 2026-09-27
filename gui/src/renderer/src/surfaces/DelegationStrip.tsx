import { useMemo } from 'react';
import { useWorkspace } from '../shell/WorkspaceContext.js';
import { agentName } from '../lib/agentName.js';
import { toneOf, labelOf, isTerminal } from '../lib/state.js';
import { money } from '../lib/format.js';
import { Icon } from '../shell/Icon.js';
import type { OrgNode } from '../lib/useOrg.js';

/** The organization a run built, in the conversation itself.
 *
 *  Delegation is what makes CherryOnTop more than one agent, so when a run
 *  splits its work the chat shows it happening: the lead agent, the agents it
 *  staffed, work flowing down each line while that agent is busy, each one
 *  settling as it finishes. One click opens the full chart. Shown only when
 *  there is an organization — a single agent needs no diagram. */
export function DelegationStrip({ root }: { root: OrgNode }) {
  const ws = useWorkspace();
  const { children, below, total } = useMemo(() => {
    const kids = ws.org.nodes
      .filter((n) => n.parentId === root.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const count = new Map<string, number>();
    const under = (id: string): number => {
      if (count.has(id)) return count.get(id)!;
      const direct = ws.org.nodes.filter((n) => n.parentId === id);
      const n = direct.length + direct.reduce((sum, c) => sum + under(c.id), 0);
      count.set(id, n);
      return n;
    };
    return { children: kids, below: (id: string) => under(id), total: 1 + under(root.id) };
  }, [ws.org.nodes, root.id]);

  if (children.length === 0) return null;
  const done = children.filter((c) => c.state === 'COMPLETE').length;
  const working = children.filter((c) => !isTerminal(c.state) && c.state !== 'INTERRUPTED').length;
  const rootTone = toneOf(root.state);

  const openChart = (nodeId: string | null = null) => {
    ws.focusCase(root.id);
    ws.openSection('agents', nodeId);
  };

  return (
    <figure className="deleg" aria-label={`Organization: ${total} agents`} data-live={working > 0}>
      <figcaption className="deleg-head">
        <Icon name="agents" size={14} />
        <span className="deleg-title">
          {total} agents
          <span className="deleg-sub">
            {working > 0 ? ` · ${working} working` : ''}{done > 0 ? ` · ${done} of ${children.length} done` : ''}
          </span>
        </span>
        <button type="button" className="quiet-link" onClick={() => openChart()}>Open the chart</button>
      </figcaption>

      <div className="deleg-tree">
        <button type="button" className="deleg-lead" style={{ ['--state' as string]: `var(--${rootTone})` }} onClick={() => openChart(root.id)}>
          <span className="deleg-dot" aria-hidden="true" />
          <span className="deleg-name">Lead agent</span>
          <span className="deleg-state">{labelOf(root.state)}</span>
        </button>
        <ul className="deleg-row" style={{ ['--n' as string]: children.length }}>
          {children.map((child, index) => {
            const tone = toneOf(child.state, child.supersededBy);
            const busy = !isTerminal(child.state) && child.state !== 'INTERRUPTED';
            const more = below(child.id);
            return (
              <li
                key={child.id}
                className="deleg-branch"
                data-busy={busy}
                data-tone={tone}
                style={{ ['--state' as string]: `var(--${tone})`, ['--i' as string]: index }}
              >
                <span className="deleg-wire" aria-hidden="true"><span className="deleg-pulse" /></span>
                <button type="button" className="deleg-agent" title={child.goal} onClick={() => openChart(child.id)}>
                  <span className="deleg-dot" aria-hidden="true">
                    {child.state === 'COMPLETE' && <Icon name="check" size={9} />}
                  </span>
                  <span className="deleg-name">{agentName(child.goal, 64)}</span>
                  <span className="deleg-meta">
                    {labelOf(child.state, child.supersededBy)}
                    {child.costUsd > 0 ? ` · ${money(child.costUsd)}` : ''}
                    {more > 0 ? ` · +${more} under it` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </figure>
  );
}
