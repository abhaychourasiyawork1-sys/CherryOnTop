import { useMemo, useState } from 'react';
import { toStory, byTimeOf } from '../lib/story.js';
import { subtreeOf } from '../lib/tasks.js';
import { caseStamp, useCaseEvents } from '../lib/useCase.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';
import type { OrgEvent } from '../lib/eventLog.js';

/** How many raw rows Details renders at once. */
const PAGE = 200;

/** The run's history as a story, with the raw record one toggle away. Both
 *  read the same append-only event log; Story only folds, never deletes. */
export function ActivitySurface({ caseId }: { caseId: string }) {
  const ws = useWorkspace();
  const subtree = useMemo(() => subtreeOf(ws.org.nodes, caseId), [ws.org.nodes, caseId]);
  const scope = useMemo(() => new Set(subtree.map((n) => n.id)), [subtree]);
  const { events, loading } = useCaseEvents(caseId, caseStamp(subtree), ws.org.events, scope);
  const [mode, setMode] = useState<'story' | 'details'>('story');
  const [highlight, setHighlight] = useState<Set<number> | null>(null);
  const story = useMemo(() => byTimeOf(toStory(events, subtree, caseId)), [events, subtree, caseId]);

  if (loading && events.length === 0) return <p className="surface-empty">Reading the history…</p>;

  return (
    <div className="activity">
      <div className="segmented" role="tablist" aria-label="History view">
        <button type="button" role="tab" aria-selected={mode === 'story'} onClick={() => setMode('story')}>Story</button>
        <button type="button" role="tab" aria-selected={mode === 'details'} onClick={() => { setMode('details'); setHighlight(null); }}>Details</button>
      </div>

      {mode === 'story' ? (
        <ol className="story">
          {story.map((group) => (
            <li key={group.heading + group.entries[0].id}>
              <p className="story-time">{group.heading}</p>
              <ul>
                {group.entries.map((entry) => (
                  <li key={entry.id} className="story-entry" data-tone={entry.tone}>
                    <p className="story-title">{entry.title}</p>
                    {entry.detail && <p className="story-detail">{entry.detail}</p>}
                    {entry.folded > 0 && (
                      <button
                        type="button"
                        className="quiet-link story-folded"
                        onClick={() => { setHighlight(new Set(entry.sourceIds)); setMode('details'); }}
                      >
                        {entry.folded} routine {entry.folded === 1 ? 'event' : 'events'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : (
        <Details events={highlight ? events.filter((e) => e.id !== undefined && highlight.has(e.id)) : events} filtered={highlight !== null} onClear={() => setHighlight(null)} />
      )}
    </div>
  );
}

function Details({ events, filtered, onClear }: { events: OrgEvent[]; filtered: boolean; onClear: () => void }) {
  // ponytail: paged, not virtualized. Newest page first; "earlier" pages back
  // through the list. Swap for a windowed list if a page ever feels slow.
  const [pages, setPages] = useState(1);
  const shown = events.slice(Math.max(0, events.length - pages * PAGE));
  return (
    <div className="details">
      {filtered && <button type="button" className="quiet-link" onClick={onClear}>Show every event</button>}
      {shown.length < events.length && (
        <button type="button" className="quiet-link" onClick={() => setPages((n) => n + 1)}>
          Load {Math.min(PAGE, events.length - shown.length)} earlier of {events.length}
        </button>
      )}
      <ol className="raw-events">
        {shown.map((event, index) => (
          <li key={event.id ?? index}>
            <span className="figure raw-id">#{event.id}</span>
            <span className="raw-type">{event.type}</span>
            <time className="figure raw-time">{new Date(event.createdAt).toLocaleTimeString()}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}
