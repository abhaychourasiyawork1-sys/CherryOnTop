import { describe, it, expect } from 'vitest';

describe('sandbox DNS forwarders', () => {
  it('forwards public names to reliable resolvers, idempotently', async () => {
    const { withForwarders, sandboxDnsServers } = await import('./kind.js');
    const corefile = '.:53 {\n    forward . /etc/resolv.conf {\n       max_concurrent 1000\n    }\n}';
    const once = withForwarders(corefile, ['8.8.8.8', '1.1.1.1']);
    expect(once).toContain('forward . 8.8.8.8 1.1.1.1 {');
    expect(once).toContain('max_concurrent 1000');
    expect(withForwarders(once, ['8.8.8.8', '1.1.1.1'])).toBe(once);
    expect(sandboxDnsServers({})).toEqual(['8.8.8.8', '1.1.1.1']);
    expect(sandboxDnsServers({ ORG_SANDBOX_DNS: 'host' })).toBeNull();
    expect(sandboxDnsServers({ ORG_SANDBOX_DNS: '9.9.9.9, bogus;rm' })).toEqual(['9.9.9.9']);
  });
});
