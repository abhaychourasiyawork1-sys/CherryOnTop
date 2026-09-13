import { defineConfig } from 'vitest/config';

const suite = process.env.VITEST_SUITE ?? 'unit';

const suites = {
  unit: {
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts', 'test/smoke.test.ts'],
    exclude: [
      'src/daemon/manager.test.ts',
      'src/execution/execute-step.integration.test.ts',
      'src/k8s/client.test.ts',
      'src/k8s/kind.test.ts',
      'src/lifecycle/**/*.integration.test.ts',
      'test/cli-e2e.test.ts',
    ],
  },
  // src/lifecycle/*.integration.test.ts files are NOT globbed as a group: some
  // (e.g. wiring.integration.test.ts) mock ../k8s/cleanup.js and need no real
  // cluster, while others (e.g. autonomous-loop.integration.test.ts) import
  // ../k8s/kind.js for real and gate on a reachable cluster at module load
  // time. A new file under src/lifecycle/*.integration.test.ts must be listed
  // explicitly below in whichever suite matches — check whether it touches
  // ../k8s/kind.js (or otherwise needs a live cluster) before defaulting it
  // into `integration`. See test/integration/README.md and test/k8s/README.md.
  integration: {
    include: ['src/daemon/manager.test.ts', 'src/lifecycle/wiring.integration.test.ts', 'test/integration/**/*.test.ts'],
    exclude: [],
  },
  e2e: { include: ['test/cli-e2e.test.ts', 'test/e2e/**/*.test.ts'], exclude: [] },
  k8s: {
    include: [
      'src/k8s/client.test.ts',
      'src/k8s/kind.test.ts',
      'src/execution/execute-step.integration.test.ts',
      'src/lifecycle/autonomous-loop.integration.test.ts',
      'test/k8s/**/*.test.ts',
    ],
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
