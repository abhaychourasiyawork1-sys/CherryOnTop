import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES_ROOT = join(import.meta.dirname, '..', 'fixtures');

/** Reads a fixture file as raw text. Use this over `loadFixture` when the
 *  fixture is deliberately not valid JSON (e.g. a malformed adapter stream
 *  line) — `loadFixture` would throw on it before the test ever gets to
 *  exercise the parser. */
export function loadFixtureRaw(relativePath: string): string {
  return readFileSync(join(FIXTURES_ROOT, relativePath), 'utf8');
}

/** Reads and JSON.parses a fixture file rooted at test/fixtures/. */
export function loadFixture<T = unknown>(relativePath: string): T {
  return JSON.parse(loadFixtureRaw(relativePath)) as T;
}
