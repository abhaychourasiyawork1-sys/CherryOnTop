import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listEventsForNode, listRecentEvents, listEventsForNodes } from '../../db/queries/events.js';
import { subtreeNodeIds } from '../../db/queries/nodes.js';
import { subscribeAll, subscribeToNode, type BusEvent } from '../../events/bus.js';

export const eventsRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listEventsForNode(ctx.db, input.nodeId)),

  /** Every event under one case, oldest first.
   *
   *  The transcript used to render from `recent` — the newest N events across
   *  the whole daemon — so a case's conversation was whatever of it happened to
   *  still be in that window. Open a case from yesterday, or any case at all
   *  after a busy hour, and the transcript was simply empty. A conversation has
   *  to be able to load its own history. */
  forCase: publicProcedure
    .input(z.object({ id: z.string(), limit: z.number().min(1).max(20000).default(6000) }))
    .query(({ input, ctx }) => {
      const events = listEventsForNodes(ctx.db, subtreeNodeIds(ctx.db, input.id));
      // Oldest-first, but keep the *newest* when a very large case overflows:
      // the end of a run is what a reader is looking at.
      return events.length > input.limit ? events.slice(events.length - input.limit) : events;
    }),

  recent: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(1000).default(200), before: z.number().optional() }))
    .query(({ input, ctx }) => listRecentEvents(ctx.db, input)),

  subscribe: publicProcedure
    .input(z.object({ nodeId: z.string().optional() }))
    .subscription(async function* ({ input, signal }) {
      // An async generator, not observable(): tRPC v11's Fastify/WS adapter
      // drives generators directly and handles backpressure and abort for us.
      // The bus is callback-based, so bridge it through a small queue that the
      // generator drains.
      const queue: BusEvent[] = [];
      let notify: (() => void) | null = null;
      const unsubscribe = input.nodeId
        ? subscribeToNode(input.nodeId, (e) => { queue.push(e); notify?.(); })
        : subscribeAll((e) => { queue.push(e); notify?.(); });

      // One abort listener for the whole subscription, not one per event: the
      // { once: true } variant only unregisters if it actually fires, so
      // re-adding it each loop would pile up a listener per delivered event.
      const wake = () => notify?.();
      signal?.addEventListener('abort', wake, { once: true });

      try {
        while (!signal?.aborted) {
          while (queue.length > 0) yield queue.shift()!;
          if (signal?.aborted) break;
          await new Promise<void>((resolve) => { notify = resolve; });
          notify = null;
        }
      } finally {
        signal?.removeEventListener('abort', wake);
        unsubscribe();
      }
    }),
});
