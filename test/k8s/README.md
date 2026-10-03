# Kubernetes tests

Kubernetes tests require a clean reachable Kind cluster and are run only by
`npm run test:k8s` in the dedicated CI job. Pure manifest and client-shaping
tests stay in the unit suite; live Jobs, Pods, logs, and cluster wiring belong
here.

This also includes `src/lifecycle/*.integration.test.ts` files that touch a
real cluster (e.g. `autonomous-loop.integration.test.ts`, which imports
`../k8s/kind.js` for real) — see the classification comment in
`vitest.config.ts` and `test/integration/README.md` for the sibling files
that mock the cluster boundary instead and belong in `integration`.
