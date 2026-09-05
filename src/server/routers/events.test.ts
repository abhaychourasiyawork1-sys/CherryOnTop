import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import { buildServer } from '../app.js';
import { publish } from '../../events/bus.js';
import type { AppRouter } from '../root-router.js';

const TEST_DB = './test-events-sub.db';
const TEST_PORT = 4477;

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('events.subscribe', () => {
  it('delivers a bus event published after the subscription starts, filtered by nodeId', async () => {
    const app = buildServer(TEST_DB, () => {});
    await app.listen({ port: TEST_PORT, host: '127.0.0.1' });

    const wsClient = createWSClient({ url: `ws://127.0.0.1:${TEST_PORT}/trpc` });
    const client = createTRPCClient<AppRouter>({ links: [wsLink({ client: wsClient })] });

    const received: unknown[] = [];
    const subscription = client.events.subscribe.subscribe(
      { nodeId: 'n1' },
      { onData: (event) => received.push(event) },
    );

    await new Promise((r) => setTimeout(r, 300)); // let the subscription establish
    publish({ nodeId: 'n1', type: 'test', payload: { x: 1 }, createdAt: 't0' });
    publish({ nodeId: 'n2', type: 'test', payload: {}, createdAt: 't0' }); // must NOT arrive

    await new Promise((r) => setTimeout(r, 300));
    subscription.unsubscribe();
    wsClient.close();
    await app.close();

    expect(received).toHaveLength(1);
    expect((received[0] as { nodeId: string }).nodeId).toBe('n1');
  }, 15_000);
});
