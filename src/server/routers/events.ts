import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listEventsForNode } from '../../db/queries/events.js';
import { subscribeAll, subscribeToNode, type BusEvent } from '../../events/bus.js';

export const eventsRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listEventsForNode(ctx.db, input.nodeId)),

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
