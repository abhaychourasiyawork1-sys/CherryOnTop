# Integration tests

Integration tests exercise real local boundaries such as SQLite, filesystem,
and the PM2 daemon boundary with isolated paths. Run them with
`npm run test:integration`; they are deliberately excluded from the unit gate.
