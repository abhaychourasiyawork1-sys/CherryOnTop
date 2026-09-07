import { useEffect, useState } from 'react';
import { toneOf, labelOf, isTerminal } from '../lib/state.js';
import type { OrgNode } from '../lib/useOrg.js';
import type { OrgEvent } from '../lib/eventLog.js';

interface Props {
  nodes: OrgNode[];
  events: OrgEvent[];
}

/** What the organization is doing *right now*, always on screen while anything
 *  is running. The transcript is history; this is the present tense — without it
 *  a node that is planning, deciding or waiting on a sandbox looks identical to
 *  one that has stopped, which is what made a live run feel like a blind one. */
export function LiveStatus({ nodes, events }: Props) {
  const active = nodes.filter((node) => !isTerminal(node.state));

  // The elapsed clock has to tick on its own; nothing else re-renders while a
  // sandbox is starting, which is exactly when you most want to see it move.
  const [, tick] = useState(0);
  useEffect(() => {
    if (active.length === 0) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active.length]);

  if (active.length === 0) return null;

  return (
    <ul className="live" aria-live="polite">
      {active.map((node) => (
        <li key={node.id} style={{ ['--state' as string]: `var(--${toneOf(node.state)})` }}>
          <span className="live-pulse" aria-hidden="true" />
          <span className="live-what">{labelOf(node.state)}</span>
          <span className="live-who">{node.parentId ? node.goal : 'Root agent'}</span>
          <span className="live-detail">{lastProgress(events, node.id)}</span>
          <span className="live-elapsed figure">{since(node.updatedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The most recent thing this node said it was doing, which is more useful than
 *  the state name once a sandbox is involved. */
function lastProgress(events: OrgEvent[], nodeId: string): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.nodeId !== nodeId) continue;
    if (event.type === 'step.progress') {
      return (event.payload as { message?: string } | null)?.message ?? '';
    }
    if (event.type === 'exec.assistant') {
      const blocks = (event.payload as { message?: { content?: { type: string; name?: string }[] } } | null)
        ?.message?.content ?? [];
      const tool = blocks.find((block) => block.type === 'tool_use');
      if (tool?.name) return `Running ${tool.name}`;
    }
    // A new step supersedes whatever the previous one was doing.
    if (event.type === 'step.outcome') return '';
  }
  return '';
}

function since(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
