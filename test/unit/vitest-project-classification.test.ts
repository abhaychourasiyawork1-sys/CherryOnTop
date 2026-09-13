/** Regression test for the K8s test-suite misclassification bug: a
 *  src/lifecycle/*.integration.test.ts file that needs a real cluster must
 *  land in the `k8s` Vitest project, never `integration`, and vice versa for
 *  one that fully mocks the cluster boundary. See vitest.config.ts's comment
 *  above the `integration`/`k8s` suite definitions, and
 *  test/integration/README.md / test/k8s/README.md.
 *
 *  This parses vitest.config.ts's source statically (no new dependency, and
 *  no need to exec the file under every VITEST_SUITE value) rather than
 *  importing it, since importing only resolves the single suite selected by
 *  the current VITEST_SUITE env var.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_PATH = join(import.meta.dirname, '../../vitest.config.ts');
const CONFIG_SOURCE = readFileSync(CONFIG_PATH, 'utf-8');

/** Extracts the `include: [...]` array contents for a top-level suite key
 *  (e.g. "integration", "k8s") inside `const suites = { ... }`, by brace-depth
 *  matching rather than a single regex — suite blocks vary between one-line
 *  and multi-line forms. */
function includeListFor(suiteKey: string): string[] {
  const keyMatch = new RegExp(`\\b${suiteKey}:\\s*\\{`).exec(CONFIG_SOURCE);
  if (!keyMatch) throw new Error(`suite key "${suiteKey}" not found in vitest.config.ts`);

  const openBraceIndex = keyMatch.index + keyMatch[0].length - 1;
  let depth = 0;
  let closeBraceIndex = -1;
  for (let i = openBraceIndex; i < CONFIG_SOURCE.length; i++) {
    if (CONFIG_SOURCE[i] === '{') depth++;
    else if (CONFIG_SOURCE[i] === '}') {
      depth--;
      if (depth === 0) {
        closeBraceIndex = i;
        break;
      }
    }
  }
  if (closeBraceIndex === -1) throw new Error(`unbalanced braces for suite "${suiteKey}"`);

  const block = CONFIG_SOURCE.slice(openBraceIndex, closeBraceIndex);
  const includeMatch = /include:\s*\[([\s\S]*?)\]/.exec(block);
  if (!includeMatch) throw new Error(`no include array found for suite "${suiteKey}"`);

  return [...includeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('vitest.config.ts suite classification', () => {
  it('puts the cluster-dependent lifecycle test in k8s, not integration', () => {
    const integrationInclude = includeListFor('integration');
    const k8sInclude = includeListFor('k8s');

    expect(k8sInclude).toContain('src/lifecycle/autonomous-loop.integration.test.ts');
    expect(integrationInclude).not.toContain('src/lifecycle/autonomous-loop.integration.test.ts');
    // Guard against the old glob (or an equivalent) sneaking back in and
    // re-capturing the file indirectly.
    expect(integrationInclude.some((p) => p.includes('src/lifecycle/') && p.includes('*'))).toBe(false);
  });

  it('keeps the fully-mocked lifecycle test in integration, not k8s', () => {
    const integrationInclude = includeListFor('integration');
    const k8sInclude = includeListFor('k8s');

    expect(integrationInclude).toContain('src/lifecycle/wiring.integration.test.ts');
    expect(k8sInclude).not.toContain('src/lifecycle/wiring.integration.test.ts');
  });
});
