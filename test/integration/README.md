# Integration tests

Integration tests exercise real local boundaries such as SQLite, filesystem,
and the PM2 daemon boundary with isolated paths. Run them with
`npm run test:integration`; they are deliberately excluded from the unit gate.

`src/lifecycle/*.integration.test.ts` files live here only if they mock the
cluster boundary (e.g. `wiring.integration.test.ts` mocks `../k8s/cleanup.js`
entirely). A file that touches `../k8s/kind.js` for real belongs in
`test/k8s/README.md`'s suite instead — see the classification comment above
the `integration`/`k8s` suites in `vitest.config.ts`.
