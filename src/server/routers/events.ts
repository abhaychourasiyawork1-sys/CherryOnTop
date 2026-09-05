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

      try {
        while (!signal?.aborted) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>((resolve) => {
            notify = resolve;
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          notify = null;
        }
      } finally {
        unsubscribe();
      }
    }),
});
