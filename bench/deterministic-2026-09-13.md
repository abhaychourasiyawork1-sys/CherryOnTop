# Deterministic benchmark — token-efficiency architecture

Run: `npm run bench:deterministic` on branch `feat/token-efficiency-architecture`,
commit `d53ec8f`, 2026-09-13.

No model was called and no cluster was used. Every number is arithmetic over
fixtures and is reproducible by re-running the file. Nothing here measures
turns, cost or wall-clock — those need a paid run against a live cluster, and
that run has **not** been done.

```

## Observation reduction — deterministic, no model

| output                              | reducer     | tokens before | tokens after | removed |
|-------------------------------------|-------------|---------------|--------------|---------|
| test runner (2001 tests, 1 failing) | test        | 30,261        | 32           | 99.9%   |
| git diff (200 files)                | git         | 15,020        | 2,795        | 81.4%   |
| package install log                 | runtime-log | 13,613        | 13           | 99.9%   |
| ripgrep with context lines          | search      | 10,738        | 6,543        | 39.1%   |

## Generic fallback (no reducer claims the output)

| output                   | tokens before | tokens after | removed |
|--------------------------|---------------|--------------|---------|
| unknown tool, 1000 lines | 7,973         | 484          | 93.9%   |

## Context projection against a 600-file tree, 6000-token ceiling

| goal                       | whole inventory | projected | files kept | ceiling used |
|----------------------------|-----------------|-----------|------------|--------------|
| names one area             | 10,207          | 2,735     | 202/660    | 46%          |
| names many modules         | 10,207          | 4,335     | 272/660    | 72%          |
| names no file or symbol    | 10,207          | 37        | 0/660      | 1%           |
| names nothing in this tree | 10,207          | 37        | 0/660      | 1%           |

## Structural planner vs lexical selector, same tree and ceiling

| goal                   | lexical tokens | planner tokens | ceiling used | files kept | newly reached |
|------------------------|----------------|----------------|--------------|------------|---------------|
| anchored one-file edit | 5,998          | 1,196          | 20%          | 402 -> 105 | 0             |
| anchored with callers  | 5,998          | 2,569          | 43%          | 402 -> 190 | 1             |
| names an area only     | 5,998          | 2,942          | 49%          | 402 -> 180 | 14            |
| names nothing specific | 37             | 37             | 1%           | 0 -> 0     | 0             |

## Execution path, from the goal alone — no model consulted

| goal                                           | class            | complexity | plans? | decision    |
|------------------------------------------------|------------------|------------|--------|-------------|
| Review the codebase and find bugs. Do not m... | investigation    | medium     | no     | RUN_MODEL   |
| Fix authentication, optimise the DB query l... | multi_workstream | high       | yes    | SPAWN_AGENT |
| Fix the typo in the README                     | trivial_edit     | low        | no     | RUN_MODEL   |
| Investigate the root cause of this bug         | debugging        | low        | no     | RUN_MODEL   |

## A valid prior answer

| decision          | tokens spent | tokens avoided | cost avoided |
|-------------------|--------------|----------------|--------------|
| REUSE_COMPUTATION | 0            | 1,772,218      | $0.95        |

## Evidence planning

| situation            | chosen                                                 | tokens |
|----------------------|--------------------------------------------------------|--------|
| all three available  | reuse                                                  | 400    |
| only a search        | search                                                 | 200    |
| only a full dispatch | stop (the best available evidence (run_model) woul...) | 0      |
| nothing outstanding  | stop (the knowledge frontier is closed — nothing o...) | 0      |

No model was called and no cluster was used. Every number above is
arithmetic over fixtures, reproducible by re-running this file.

```
