import { defineConfig } from 'vitest/config';

const suite = process.env.VITEST_SUITE ?? 'unit';

const suites = {
  unit: {
    // `bench/**/*.test.mjs` runs here rather than in its own suite: those
    // are pure functions over synthetic records with no cluster and no model,
    // and the arithmetic that decides whether a change ships should be checked
    // by the suite that runs on every change.
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts', 'test/smoke.test.ts', 'bench/**/*.test.mjs'],
    exclude: [
      'src/daemon/manager.test.ts',
      'src/execution/execute-step.integration.test.ts',
      'src/k8s/client.test.ts',
      'src/k8s/kind.test.ts',
      'src/lifecycle/**/*.integration.test.ts',
      'test/cli-e2e.test.ts',
    ],
  },
  integration: {
    include: ['src/daemon/manager.test.ts', 'src/lifecycle/**/*.integration.test.ts', 'test/integration/**/*.test.ts'],
    exclude: [],
  },
  e2e: { include: ['test/cli-e2e.test.ts', 'test/e2e/**/*.test.ts'], exclude: [] },
  k8s: {
    include: ['src/k8s/client.test.ts', 'src/k8s/kind.test.ts', 'src/execution/execute-step.integration.test.ts', 'test/k8s/**/*.test.ts'],
    exclude: [],
  },
} as const;

if (!(suite in suites)) throw new Error(`Unknown VITEST_SUITE: ${suite}`);

export default defineConfig({
  test: {
    environment: 'node',
    ...suites[suite as keyof typeof suites],
    fileParallelism: true,
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/server/daemon-entry.ts'],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 70,
        lines: 70,
      },
    },
  },
});
