/** The golden-corpus fixtures under test/fixtures/runtime-events/ are only
 *  worth having if something actually parses them. This wires each one
 *  through the real adapter parser and, where a fixture feeds a specific
 *  consumer (rate limits, usage), through that consumer too — so a fixture
 *  drifting out of sync with the shapes those consumers expect fails here
 *  first, not in production.
 */
import { describe, it, expect } from 'vitest';
import { loadFixture, loadFixtureRaw } from '../helpers/fixtures.js';
import { claudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { rateLimitFromEvents } from '../../src/execution/rate-limit.js';
import { usageFromEvents, ZERO_USAGE } from '../../src/execution/tokens.js';

const asLine = (fixture: unknown) => JSON.stringify(fixture);

describe('runtime-events golden corpus', () => {
  it.each([
    'success', 'failure', 'rate-limit', 'timeout', 'usage', 'unknown-event-type',
  ])('%s.json parses as a real adapter line would', (name) => {
    const fixture = loadFixture<{ type: string }>(`runtime-events/${name}.json`);
    const event = claudeCodeAdapter.parseLine(asLine(fixture));
    expect(event).toEqual({ type: fixture.type, payload: fixture });
  });

  it('malformed.json is exactly the noise a real stream can produce, and the parser drops it', () => {
    const raw = loadFixtureRaw('runtime-events/malformed.json').trim();
    expect(claudeCodeAdapter.parseLine(raw)).toBeNull();
  });

  it('the rate-limit fixture is what rateLimitFromEvents needs to name the exhausted window', () => {
    const fixture = loadFixture('runtime-events/rate-limit.json');
    const event = claudeCodeAdapter.parseLine(asLine(fixture))!;
    expect(rateLimitFromEvents([event]))
      .toEqual({ window: 'five_hour', resetsAtSeconds: 1788697200 });
  });

  it('the usage fixture is what usageFromEvents reads token counts off', () => {
    const fixture = loadFixture('runtime-events/usage.json');
    const event = claudeCodeAdapter.parseLine(asLine(fixture))!;
    expect(usageFromEvents([event])).toEqual({
      inputTokens: 1200, outputTokens: 340, cacheReadTokens: 8000,
      cacheCreationTokens: 500, numTurns: 7,
    });
  });

  it('a run with only noise (no result event) falls back to ZERO_USAGE', () => {
    const fixture = loadFixture<{ type: string }>('runtime-events/unknown-event-type.json');
    const event = claudeCodeAdapter.parseLine(asLine(fixture))!;
    expect(usageFromEvents([event])).toEqual(ZERO_USAGE);
  });
});
