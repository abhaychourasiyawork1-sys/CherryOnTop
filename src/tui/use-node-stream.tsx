import { useEffect, useState } from 'react';
import { tuiClient } from './client.js';
import { createStreamRenderer, type RenderedLine } from './stream-renderer.js';
import type { BusEvent } from '../events/bus.js';

/** Replays a node's already-persisted execution events, then keeps rendering
 *  whatever arrives live — so a node opened mid-run, after it finished, or
 *  before it even started all show the same thing.
 *
 *  The subscription is opened *before* history is queried (nothing emitted in
 *  between is lost) and live events are buffered until history has been fed, so
 *  the renderer still sees them in order. Events already present in history are
 *  skipped by row id, not by timestamp guesswork. */
export function useNodeStream(nodeId: string): RenderedLine[] {
  const [lines, setLines] = useState<RenderedLine[]>([]);

  useEffect(() => {
    const renderer = createStreamRenderer();
    let alive = true;
    setLines([]);

    const apply = (type: string, payload: unknown) => {
      if (!type.startsWith('exec.')) return;
      const results = renderer.feed({ type: type.slice('exec.'.length), payload });
      if (results.length === 0) return;
      setLines((prev) => {
        let next = prev;
        for (const r of results) {
          next = r.action === 'append'
            ? [...next, r.line]
            : next.map((l) => (l.key === r.line.key ? r.line : l));
        }
        return next;
      });
    };

    let replayed = false;
    let highestReplayedId = 0;
    const buffered: BusEvent[] = [];

    const subscription = tuiClient().events.subscribe.subscribe(
      { nodeId },
      {
        onData: (event: BusEvent) => {
          if (!alive) return;
          if (!replayed) { buffered.push(event); return; }
          if (event.id !== undefined && event.id <= highestReplayedId) return;
          apply(event.type, event.payload);
        },
      },
    );

    tuiClient().events.listForNode.query({ nodeId })
      .then((historical) => {
        if (!alive) return;
        for (const e of historical) {
          highestReplayedId = Math.max(highestReplayedId, e.id);
          apply(e.type, e.payload);
        }
        replayed = true;
        for (const e of buffered) {
          if (e.id !== undefined && e.id <= highestReplayedId) continue;
          apply(e.type, e.payload);
        }
        buffered.length = 0;
      })
      .catch(() => { replayed = true; });

    return () => { alive = false; subscription.unsubscribe(); };
  }, [nodeId]);

  return lines;
}
