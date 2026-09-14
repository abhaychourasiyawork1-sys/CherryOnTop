import { EventEmitter } from 'node:events';

export interface BusEvent {
  /** The events-table row id. Lets a client that replayed history skip events
   *  it has already rendered, without guessing from timestamps. */
  id?: number;
  nodeId: string;
  type: string;
  // Optional so this type also describes the event as it arrives over the wire,
  // where an `unknown` field serializes as optional. Publishers always set it.
  payload?: unknown;
  createdAt: string;
}

const emitter = new EventEmitter();
// A daemon can run many nodes and many TUI/subscription clients over its
// lifetime; the default limit of 10 would print spurious warnings.
emitter.setMaxListeners(200);

export function publish(event: BusEvent): void {
  emitter.emit('event', event);
  emitter.emit(`event:${event.nodeId}`, event);
}

export function subscribeAll(handler: (event: BusEvent) => void): () => void {
  emitter.on('event', handler);
  return () => { emitter.off('event', handler); };
}

export function subscribeToNode(nodeId: string, handler: (event: BusEvent) => void): () => void {
  emitter.on(`event:${nodeId}`, handler);
  return () => { emitter.off(`event:${nodeId}`, handler); };
}

/** Every event whose type starts with `prefix`.
 *
 *  Exists because every subscriber that wants a family of events — the economic
 *  stream, the `exec.*` stream — otherwise writes the same two lines of
 *  filtering, and one of them eventually writes `includes` instead of
 *  `startsWith` and receives half the bus. */
export function subscribeToPrefix(prefix: string, handler: (event: BusEvent) => void): () => void {
  return subscribeAll((event) => {
    if (event.type.startsWith(prefix)) handler(event);
  });
}
