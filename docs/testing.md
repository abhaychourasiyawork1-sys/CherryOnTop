# Testing CherryOnTop

CherryOnTop uses a layered suite. `npm test` is intentionally the fast,
deterministic unit gate and is safe to run without Docker, Kind, a model API,
credentials, a daemon, or a network connection.

| Layer | Command | Scope |
| --- | --- | --- |
| Unit | `npm run test:unit` | Pure services, schemas, policies, local SQLite and filesystem fixtures |
| Coverage | `npm run test:coverage` | Unit suite plus V8 coverage gate (70% lines/statements/functions, 65% branches) |
| Integration | `npm run test:integration` | PM2 and multi-module local boundaries |
| E2E | `npm run test:e2e` | Built CLI/daemon workflow with isolated state |
| Kubernetes | `npm run test:k8s` | Live Jobs, logs, cleanup and Kind wiring |
| GUI | `npm run test:gui` | Electron/Vite frontend suite |
| Benchmark | `npm run bench:deterministic` | Deterministic efficiency evidence; not a correctness gate |

The existing collocated suites are classified by `VITEST_SUITE` in
`vitest.config.ts`. `src/k8s/client.test.ts`, `src/k8s/kind.test.ts`, and
`src/execution/execute-step.integration.test.ts` are live-cluster tests;
`src/daemon/manager.test.ts` is PM2 integration; lifecycle files ending in
`.integration.test.ts` are local integration; and `test/cli-e2e.test.ts` is
the CLI E2E suite. All remaining root TypeScript tests are unit tests, except
the GUI workspace, which owns its own Vitest configuration.

Use `test/helpers/test-db.ts` for a database per test and
`test/helpers/temp-worktree.ts` for disposable Git state. Fixtures must not
include credentials or personal data. Tests must assert observable contracts,
remain order-independent, and clean temporary resources in `afterEach` or
`afterAll`.

The coverage gate is a floor, not a substitute for decision coverage. Policy,
authority, context, routing, lifecycle, execution cleanup, and parsing tests
must include positive and negative branch cases. CI uploads LCOV/HTML coverage
and any available test results when a job fails.
