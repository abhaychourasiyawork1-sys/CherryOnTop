# Accountable Agent Organization Runtime v0.1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Before starting:** create an isolated workspace via superpowers:using-git-worktrees — this is a brand-new repo (no git history yet), so Task 1 below performs `git init` itself; do that inside the worktree, not the bare working directory.
>
> **Skills to invoke during execution** (the user explicitly asked for skills to be used wherever relevant):
> - superpowers:test-driven-development governs every task's step rhythm (write failing test → verify fail → implement → verify pass → commit) — already baked into each task below, not something to re-invoke separately.
> - superpowers:systematic-debugging — invoke the moment any test fails for a reason you don't immediately understand, before guessing at a fix.
> - superpowers:requesting-code-review — invoke after each phase (not each task) is complete, before moving to the next phase.
> - superpowers:verification-before-completion — invoke before declaring any phase done: re-run the phase's full test suite and the CLI smoke test, don't just trust the last green run.
> - superpowers:finishing-a-development-branch — invoke once Phase 1 (or any phase) is complete and reviewed, to decide how it merges before the next phase starts.

**Goal:** Build a working v0.1 of the Accountable Agent Organization Runtime — a local-first, Kubernetes-sandboxed, CLI-driven runtime for a recursive tree of accountable software-engineering agent nodes — ending with a real `org run "<goal>"` that creates a root node, delegates to a Claude-Code-driven child running inside an isolated K8s Job, and reports a verified outcome.

**Architecture:** A single Node.js daemon (logically split into Server — state/API — and Host — K8s dispatch) holds accountable nodes as XState statecharts backed by SQLite (via Drizzle). A thin Commander CLI and Ink TUI talk to the daemon over a local tRPC/Fastify API. Node execution steps run as one-shot Kubernetes Jobs in an auto-provisioned local `kind` cluster, driving coding-agent CLIs headlessly via execa+ndjson.

**Tech Stack:** TypeScript, Node.js, Fastify, tRPC, zod, Drizzle ORM + better-sqlite3, XState, Commander, Ink + @inkjs/ui, execa, ndjson, pm2, @kubernetes/client-node, kind, node-notifier, @clack/prompts, listr2, pino, Vitest, GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-09-05-accountable-agent-org-runtime-design.md](../specs/2026-09-05-accountable-agent-org-runtime-design.md) and [accountable_agent_organization_runtime_handoff.html](../../../accountable_agent_organization_runtime_handoff.html) (source of truth for all architecture/product decisions — this plan implements it, does not redecide it).

## Global Constraints

- Node.js >= 20 LTS. Package manager: npm (no pnpm/yarn — nothing here needs a workspace tool yet).
- npm package name: `cherryontop`. CLI binary name: `org`. GitHub repo: `github.com/abhaychourasiyawork1-sys/CherryOnTop`.
- GHCR runner image path: `ghcr.io/abhaychourasiyawork1-sys/cherryontop-runner`.
- Pure TypeScript for v0.1 — no Python or other language runtime anywhere in this plan (spec §3, decision D13).
- Every state transition persists through the events table (append-only) in addition to the mutable state tables (spec §6, D16) — never skip the event-log write.
- All external inputs (node contracts, CLI args, tRPC procedure inputs) validated with zod (D30) — no hand-rolled validation.
- All subprocess execution uses execa, never raw `child_process` (D34).
- Before installing `@trpc/server`/`@trpc/client`/`zod`/`fastify`/`@fastify/websocket`, check each package's published peerDependencies for the actual compatible version combination at install time — tRPC v11 requires Fastify v5+ and a zod major it lists as a peer; pin whatever that combination resolves to, don't assume the versions named in this plan's code samples are still current patches.
- Every task ends with a commit. Never batch multiple tasks into one commit.

## Phase Overview

| Phase | Delivers | Status |
|---|---|---|
| **1. Foundation & Daemon Core** | Project scaffold, persistence (Drizzle+SQLite+events), XState node lifecycle skeleton, tRPC+Fastify API, pm2 daemon lifecycle, CLI skeleton (`org run`/`org tree`/`org daemon`) | **Fully detailed below** |
| **2. Execution Substrate** | Local `kind` auto-bootstrap, K8s Job-per-step dispatch, per-Job Secrets, NetworkPolicy, Claude Code adapter (execa+ndjson headless), wired into the lifecycle's EXECUTE step | Scoped task list below — full TDD detail written in a follow-up pass once Phase 1's real interfaces exist |
| **3. Accountability Engines** | Commitment engine, Authority engine, Economics engine (weighted heuristic), Intelligence Coordinator, real delegation (child node creation) | Scoped task list below |
| **4. CLI/TUI & Approvals** | `org watch` (Ink+@inkjs/ui), `org commitment`/`org decision`/`org events`, approval escalation (node-notifier), `org doctor` (real checks, @clack/prompts + listr2) | Scoped task list below |
| **5. Memory, Multi-Adapter & CI/Packaging** | Node/org memory + promotion, Codex adapter, GHCR image + publish workflow, `kind`-backed CI integration job, npm packaging | Scoped task list below |

Each later phase gets its own full bite-sized-step plan pass (same format as Phase 1) immediately before work on it starts — writing all five phases to code-level detail now would mean writing Phase 4/5 code against Phase 1/2 interfaces that don't exist yet.

---

# Phase 1: Foundation & Daemon Core

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.nvmrc`
- Create: `test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working `npm install`, `npm run build`, `npm test`, `npm run typecheck` toolchain every later task builds on.

- [ ] **Step 1: Initialize git and the npm project**

```bash
git init
npm init -y
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
dist/
*.db
*.db-journal
*.db-wal
.org/
```

- [ ] **Step 3: Write `.nvmrc`**

```
20
```

- [ ] **Step 4: Install toolchain dependencies**

```bash
npm install --save-dev typescript vitest @vitest/coverage-v8 tsx @types/node
```

- [ ] **Step 5: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 6: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
```

- [ ] **Step 7: Write the smoke test**

```ts
// test/smoke.test.ts
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests under Vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 8: Add npm scripts to `package.json`**

```json
{
  "name": "cherryontop",
  "version": "0.1.0",
  "type": "module",
  "bin": { "org": "./dist/cli/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev:cli": "tsx src/cli/index.ts"
  }
}
```

- [ ] **Step 9: Run the test suite to verify the toolchain works**

Run: `npm test`
Expected: PASS — 1 test passed (`runs TypeScript tests under Vitest`).

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .nvmrc test/smoke.test.ts
git commit -m "chore: project scaffold with TypeScript + Vitest toolchain"
```

---

### Task 2: Node contract zod schema

**Files:**
- Create: `src/schemas/node-contract.ts`
- Test: `src/schemas/node-contract.test.ts`

**Interfaces:**
- Consumes: `zod` (new dependency).
- Produces: `NodeContractSchema`, `type NodeContract`, `type Authority`, `type Deadline` — consumed by Task 4 (persistence), Task 6 (tRPC router), and every later phase that constructs or validates a node contract.

- [ ] **Step 1: Install zod**

```bash
npm install zod
```

- [ ] **Step 2: Write the failing test**

```ts
// src/schemas/node-contract.test.ts
import { describe, it, expect } from 'vitest';
import { NodeContractSchema } from './node-contract';

describe('NodeContractSchema', () => {
  it('accepts a valid node contract', () => {
    const result = NodeContractSchema.safeParse({
      goal: 'Implement OAuth login',
      definition_of_done: ['OAuth provider integrated', 'tests pass'],
      authority: {
        tools: ['git', 'shell'],
        spawn_children: true,
        max_child_count: 3,
        budget_usd: 3,
      },
      constraints: ['preserve existing auth'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a contract with an empty goal', () => {
    const result = NodeContractSchema.safeParse({
      goal: '',
      definition_of_done: ['x'],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a contract with no definition_of_done entries', () => {
    const result = NodeContractSchema.safeParse({
      goal: 'x',
      definition_of_done: [],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('defaults constraints to an empty array when omitted', () => {
    const result = NodeContractSchema.parse({
      goal: 'x',
      definition_of_done: ['x'],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
    });
    expect(result.constraints).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- node-contract`
Expected: FAIL — `Cannot find module './node-contract'`.

- [ ] **Step 4: Write the schema**

```ts
// src/schemas/node-contract.ts
import { z } from 'zod';

export const AuthoritySchema = z.object({
  tools: z.array(z.string()),
  spawn_children: z.boolean(),
  max_child_count: z.number().int().nonnegative(),
  budget_usd: z.number().nonnegative(),
});

export const DeadlineSchema = z.object({
  expected_at: z.string().datetime().optional(),
  hard_at: z.string().datetime().optional(),
});

export const NodeContractSchema = z.object({
  goal: z.string().min(1),
  definition_of_done: z.array(z.string()).min(1),
  authority: AuthoritySchema,
  constraints: z.array(z.string()).default([]),
  deadline: DeadlineSchema.optional(),
});

export type Authority = z.infer<typeof AuthoritySchema>;
export type Deadline = z.infer<typeof DeadlineSchema>;
export type NodeContract = z.infer<typeof NodeContractSchema>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- node-contract`
Expected: PASS — 4 tests passed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/schemas/node-contract.ts src/schemas/node-contract.test.ts
git commit -m "feat: add NodeContract zod schema"
```

---

### Task 3: Drizzle schema + migrations

**Files:**
- Create: `src/db/schema.ts`, `drizzle.config.ts`
- Test: `src/db/schema.test.ts`

**Interfaces:**
- Consumes: `NodeContract` type from Task 2 (used as the JSON-column type for `nodes.contract`).
- Produces: `nodes` and `events` Drizzle table objects, and a generated migration under `src/db/migrations/` — consumed by Task 4 (`db/client.ts` and the query modules).

- [ ] **Step 1: Install Drizzle + better-sqlite3**

```bash
npm install drizzle-orm better-sqlite3
npm install --save-dev drizzle-kit @types/better-sqlite3
```

- [ ] **Step 2: Write the schema**

```ts
// src/db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { NodeContract } from '../schemas/node-contract';

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  goal: text('goal').notNull(),
  contract: text('contract', { mode: 'json' }).$type<NodeContract>().notNull(),
  state: text('state').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('node_id').notNull(),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull(),
});
```

- [ ] **Step 3: Write `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: './dev.db' },
});
```

- [ ] **Step 4: Generate the migration**

```bash
npx drizzle-kit generate
```

Expected: a new SQL file under `src/db/migrations/` creating the `nodes` and `events` tables.

- [ ] **Step 5: Write the failing test (schema + migration apply cleanly to a fresh temp DB)**

```ts
// src/db/schema.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { unlinkSync, existsSync } from 'node:fs';
import { nodes } from './schema';

const TEST_DB = './test-schema.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('schema migration', () => {
  it('creates the nodes table and allows inserting a row', () => {
    const sqlite = new Database(TEST_DB);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: './src/db/migrations' });

    db.insert(nodes).values({
      id: 'n1',
      parentId: null,
      goal: 'test goal',
      contract: {
        goal: 'test goal',
        definition_of_done: ['done'],
        authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
        constraints: [],
      },
      state: 'CREATED',
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    }).run();

    const row = db.select().from(nodes).all()[0];
    expect(row?.id).toBe('n1');
    expect(row?.state).toBe('CREATED');
    sqlite.close();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- schema.test`
Expected: FAIL if the migration folder doesn't exist yet or the import path is wrong — confirm the failure message points at a real gap, not a typo, before proceeding.

- [ ] **Step 7: Fix any migration/path issues, then run again to verify it passes**

Run: `npm test -- schema.test`
Expected: PASS — 1 test passed.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json drizzle.config.ts src/db/schema.ts src/db/schema.test.ts src/db/migrations
git commit -m "feat: add Drizzle schema for nodes/events with generated migration"
```

---

### Task 4: Persistence query layer

**Files:**
- Create: `src/db/client.ts`, `src/db/queries/nodes.ts`, `src/db/queries/events.ts`
- Test: `src/db/queries/nodes.test.ts`, `src/db/queries/events.test.ts`

**Interfaces:**
- Consumes: `nodes`/`events` tables from Task 3, `NodeContract` from Task 2.
- Produces: `createDb(filePath): Db`, `insertNode(db, record)`, `updateNodeState(db, id, state, updatedAt)`, `getNode(db, id)`, `listNodes(db)`, `appendEvent(db, record)`, `listEventsForNode(db, nodeId)` — consumed by Task 5 (lifecycle) and Task 6 (tRPC routers).

- [ ] **Step 1: Write `db/client.ts`**

```ts
// src/db/client.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export function createDb(filePath: string) {
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });
  return db;
}

export type Db = ReturnType<typeof createDb>;
```

- [ ] **Step 2: Write the failing test for node queries**

```ts
// src/db/queries/nodes.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client';
import { insertNode, getNode, updateNodeState, listNodes } from './nodes';

const TEST_DB = './test-nodes.db';

function cleanUp() {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
}

afterEach(cleanUp);

const CONTRACT = {
  goal: 'test',
  definition_of_done: ['done'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
  constraints: [],
};

describe('node queries', () => {
  it('inserts and retrieves a node', () => {
    const db = createDb(TEST_DB);
    insertNode(db, {
      id: 'n1', parentId: null, goal: 'test', contract: CONTRACT,
      state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    });
    const node = getNode(db, 'n1');
    expect(node?.goal).toBe('test');
    expect(node?.state).toBe('CREATED');
  });

  it('updates node state', () => {
    const db = createDb(TEST_DB);
    insertNode(db, {
      id: 'n1', parentId: null, goal: 'test', contract: CONTRACT,
      state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    });
    updateNodeState(db, 'n1', 'ORIENT', 't1');
    const node = getNode(db, 'n1');
    expect(node?.state).toBe('ORIENT');
    expect(node?.updatedAt).toBe('t1');
  });

  it('lists all nodes', () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'a', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'n2', parentId: 'n1', goal: 'b', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });
    expect(listNodes(db)).toHaveLength(2);
  });

  it('returns undefined for a missing node', () => {
    const db = createDb(TEST_DB);
    expect(getNode(db, 'missing')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- nodes.test`
Expected: FAIL — `Cannot find module './nodes'`.

- [ ] **Step 4: Write `db/queries/nodes.ts`**

```ts
// src/db/queries/nodes.ts
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { nodes } from '../schema';
import type { NodeContract } from '../../schemas/node-contract';

export interface NodeRecord {
  id: string;
  parentId: string | null;
  goal: string;
  contract: NodeContract;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export function insertNode(db: Db, record: NodeRecord): void {
  db.insert(nodes).values(record).run();
}

export function updateNodeState(db: Db, id: string, state: string, updatedAt: string): void {
  db.update(nodes).set({ state, updatedAt }).where(eq(nodes.id, id)).run();
}

export function getNode(db: Db, id: string): NodeRecord | undefined {
  return db.select().from(nodes).where(eq(nodes.id, id)).get() as NodeRecord | undefined;
}

export function listNodes(db: Db): NodeRecord[] {
  return db.select().from(nodes).all() as NodeRecord[];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- nodes.test`
Expected: PASS — 4 tests passed.

- [ ] **Step 6: Write the failing test for event queries**

```ts
// src/db/queries/events.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client';
import { appendEvent, listEventsForNode } from './events';

const TEST_DB = './test-events.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('event queries', () => {
  it('appends and lists events for a node', () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'n1', type: 'state.transition', payload: { state: 'CREATED' }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'n1', type: 'state.transition', payload: { state: 'ORIENT' }, createdAt: 't1' });
    appendEvent(db, { nodeId: 'n2', type: 'state.transition', payload: { state: 'CREATED' }, createdAt: 't0' });

    const events = listEventsForNode(db, 'n1');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('state.transition');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- events.test`
Expected: FAIL — `Cannot find module './events'`.

- [ ] **Step 8: Write `db/queries/events.ts`**

```ts
// src/db/queries/events.ts
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { events } from '../schema';

export interface EventRecord {
  nodeId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export function appendEvent(db: Db, record: EventRecord): void {
  db.insert(events).values(record).run();
}

export function listEventsForNode(db: Db, nodeId: string) {
  return db.select().from(events).where(eq(events.nodeId, nodeId)).all();
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test -- events.test`
Expected: PASS — 1 test passed.

- [ ] **Step 10: Commit**

```bash
git add src/db/client.ts src/db/queries
git commit -m "feat: add persistence query layer for nodes and events"
```

---

### Task 5: XState node lifecycle skeleton

**Files:**
- Create: `src/lifecycle/node-machine.ts`, `src/lifecycle/node-actor-manager.ts`
- Test: `src/lifecycle/node-machine.test.ts`, `src/lifecycle/node-actor-manager.test.ts`

**Interfaces:**
- Consumes: `Db`, `updateNodeState`, `appendEvent` from Task 4.
- Produces: `nodeMachine` (XState machine), `startNodeActor(db, nodeId, goal): void`, `sendToNode(nodeId, event): void`, `getNodeActor(nodeId)` — consumed by Task 6's `node.create` tRPC mutation, and by Phase 3's economics/delegation logic (which will send `CONTEXT_SUFFICIENT`/`SELF_EXECUTE`/`DELEGATE`/`DOD_MET` events instead of Phase 1's placeholder auto-transitions).

- [ ] **Step 1: Install xstate**

```bash
npm install xstate
```

- [ ] **Step 2: Write the failing test for the machine shape**

```ts
// src/lifecycle/node-machine.test.ts
import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { nodeMachine } from './node-machine';

describe('nodeMachine', () => {
  it('starts in CREATED and moves through ORIENT/PLAN to INTELLIGENCE_GATE on START', () => {
    const actor = createActor(nodeMachine, { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    expect(actor.getSnapshot().value).toBe('CREATED');
    actor.send({ type: 'START' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
  });

  it('loops back to PLAN when context is insufficient, then proceeds when sufficient', () => {
    const actor = createActor(nodeMachine, { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_INSUFFICIENT' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION');
  });

  it('reaches COMPLETE via SELF_EXECUTE -> VERIFY -> DOD_MET', () => {
    const actor = createActor(nodeMachine, { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    expect(actor.getSnapshot().value).toBe('VERIFY');
    actor.send({ type: 'DOD_MET' });
    expect(actor.getSnapshot().value).toBe('COMPLETE');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it('re-plans when DoD is not met after verification', () => {
    const actor = createActor(nodeMachine, { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    actor.send({ type: 'DOD_NOT_MET' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- node-machine.test`
Expected: FAIL — `Cannot find module './node-machine'`.

- [ ] **Step 4: Write the machine**

```ts
// src/lifecycle/node-machine.ts
import { setup } from 'xstate';

export interface NodeMachineContext {
  nodeId: string;
  goal: string;
}

export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'CONTEXT_SUFFICIENT' }
  | { type: 'CONTEXT_INSUFFICIENT' }
  | { type: 'SELF_EXECUTE' }
  | { type: 'DELEGATE' }
  | { type: 'DOD_MET' }
  | { type: 'DOD_NOT_MET' };

export const nodeMachine = setup({
  types: {
    context: {} as NodeMachineContext,
    events: {} as NodeMachineEvent,
    input: {} as NodeMachineContext,
  },
}).createMachine({
  id: 'accountableNode',
  context: ({ input }) => input,
  initial: 'CREATED',
  states: {
    CREATED: { on: { START: 'ORIENT' } },
    ORIENT: { always: 'PLAN' },
    PLAN: { always: 'INTELLIGENCE_GATE' },
    INTELLIGENCE_GATE: {
      on: {
        CONTEXT_SUFFICIENT: 'EXECUTION_DECISION',
        CONTEXT_INSUFFICIENT: 'PLAN',
      },
    },
    EXECUTION_DECISION: {
      on: {
        SELF_EXECUTE: 'SELF_EXECUTE',
        DELEGATE: 'DELEGATE',
      },
    },
    SELF_EXECUTE: { always: 'VERIFY' },
    DELEGATE: { always: 'VERIFY' },
    VERIFY: {
      on: {
        DOD_MET: 'COMPLETE',
        DOD_NOT_MET: 'INTELLIGENCE_GATE',
      },
    },
    COMPLETE: { type: 'final' },
  },
});
```

Note: `PLAN` transitions straight to `INTELLIGENCE_GATE` unconditionally in this Phase-1 skeleton (no real planning logic yet — that arrives in Phase 3 alongside the Intelligence Coordinator). `EXECUTION_DECISION`, `SELF_EXECUTE`, and `DELEGATE` are similarly stubs the caller drives explicitly for now; Phase 3 replaces the caller-driven events with real economics/intelligence decisions, without changing the state names or shape this test locks in.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- node-machine.test`
Expected: PASS — 4 tests passed.

- [ ] **Step 6: Write the failing test for the actor manager (persistence wiring)**

```ts
// src/lifecycle/node-actor-manager.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client';
import { getNode } from '../db/queries/nodes';
import { listEventsForNode } from '../db/queries/events';
import { insertNode } from '../db/queries/nodes';
import { startNodeActor, sendToNode } from './node-actor-manager';

const TEST_DB = './test-actor.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const CONTRACT = {
  goal: 'test', definition_of_done: ['done'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 }, constraints: [],
};

describe('node-actor-manager', () => {
  it('persists state transitions and appends an event per transition', () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'test', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });

    startNodeActor(db, 'n1', 'test');
    expect(getNode(db, 'n1')?.state).toBe('INTELLIGENCE_GATE');

    sendToNode('n1', { type: 'CONTEXT_SUFFICIENT' });
    expect(getNode(db, 'n1')?.state).toBe('EXECUTION_DECISION');

    const recordedEvents = listEventsForNode(db, 'n1');
    expect(recordedEvents.length).toBeGreaterThanOrEqual(2);
    expect(recordedEvents.every((e) => e.type === 'state.transition')).toBe(true);
  });

  it('throws when sending to a node with no active actor', () => {
    expect(() => sendToNode('missing', { type: 'CONTEXT_SUFFICIENT' })).toThrow();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- node-actor-manager.test`
Expected: FAIL — `Cannot find module './node-actor-manager'`.

- [ ] **Step 8: Write the actor manager**

```ts
// src/lifecycle/node-actor-manager.ts
import { createActor, type Actor } from 'xstate';
import { nodeMachine } from './node-machine';
import type { Db } from '../db/client';
import { updateNodeState } from '../db/queries/nodes';
import { appendEvent } from '../db/queries/events';

const actors = new Map<string, Actor<typeof nodeMachine>>();

export function startNodeActor(db: Db, nodeId: string, goal: string): void {
  const actor = createActor(nodeMachine, { input: { nodeId, goal } });
  actor.subscribe((snapshot) => {
    const now = new Date().toISOString();
    updateNodeState(db, nodeId, String(snapshot.value), now);
    appendEvent(db, { nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });
  });
  actor.start();
  actors.set(nodeId, actor);
  actor.send({ type: 'START' });
}

export function getNodeActor(nodeId: string): Actor<typeof nodeMachine> | undefined {
  return actors.get(nodeId);
}

export function sendToNode(nodeId: string, event: Parameters<Actor<typeof nodeMachine>['send']>[0]): void {
  const actor = actors.get(nodeId);
  if (!actor) throw new Error(`No active actor for node ${nodeId}`);
  actor.send(event);
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test -- node-actor-manager.test`
Expected: PASS — 2 tests passed.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/lifecycle
git commit -m "feat: add XState node lifecycle machine and actor manager"
```

---

### Task 6: tRPC router + Fastify server

**Files:**
- Create: `src/server/trpc.ts`, `src/server/root-router.ts`, `src/server/routers/node.ts`, `src/server/routers/events.ts`, `src/server/routers/daemon.ts`, `src/server/app.ts`
- Test: `src/server/app.test.ts`

**Interfaces:**
- Consumes: `Db`/`createDb` (Task 4), `insertNode`/`getNode`/`listNodes` (Task 4), `listEventsForNode` (Task 4), `startNodeActor` (Task 5), `NodeContractSchema` (Task 2).
- Produces: `type AppRouter` (the tRPC router type) — consumed by Task 8 (`daemon/client.ts`) as the client's type parameter. `buildServer(dbPath): FastifyInstance` — consumed by Task 7 (`daemon-entry.ts`) and this task's own test via `.inject()`.

- [ ] **Step 1: Install Fastify and tRPC**

```bash
npm install fastify @trpc/server @trpc/client
```

- [ ] **Step 2: Write `server/trpc.ts`**

```ts
// src/server/trpc.ts
import { initTRPC } from '@trpc/server';
import type { Db } from '../db/client';

export interface TrpcContext {
  db: Db;
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
```

- [ ] **Step 3: Write the routers**

```ts
// src/server/routers/node.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { NodeContractSchema } from '../../schemas/node-contract';
import { insertNode, getNode, listNodes } from '../../db/queries/nodes';
import { startNodeActor } from '../../lifecycle/node-actor-manager';

export const nodeRouter = router({
  create: publicProcedure
    .input(NodeContractSchema)
    .mutation(({ input, ctx }) => {
      const id = randomUUID();
      const now = new Date().toISOString();
      insertNode(ctx.db, {
        id, parentId: null, goal: input.goal, contract: input,
        state: 'CREATED', createdAt: now, updatedAt: now,
      });
      startNodeActor(ctx.db, id, input.goal);
      return { id };
    }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const node = getNode(ctx.db, input.id);
      if (!node) throw new Error(`Node ${input.id} not found`);
      return node;
    }),

  tree: publicProcedure.query(({ ctx }) => listNodes(ctx.db)),
});
```

```ts
// src/server/routers/events.ts
import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { listEventsForNode } from '../../db/queries/events';

export const eventsRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listEventsForNode(ctx.db, input.nodeId)),
});
```

```ts
// src/server/routers/daemon.ts
import { router, publicProcedure } from '../trpc';

export const daemonRouter = router({
  ping: publicProcedure.query(() => ({ ok: true as const, pid: process.pid })),
});
```

```ts
// src/server/root-router.ts
import { router } from './trpc';
import { nodeRouter } from './routers/node';
import { eventsRouter } from './routers/events';
import { daemonRouter } from './routers/daemon';

export const appRouter = router({
  node: nodeRouter,
  events: eventsRouter,
  daemon: daemonRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 4: Write the failing test for the Fastify app (using `.inject()`, no real network)**

```ts
// src/server/app.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from './app';

const TEST_DB = './test-app.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('Fastify + tRPC app', () => {
  it('responds to daemon.ping', async () => {
    const app = buildServer(TEST_DB);
    const response = await app.inject({ method: 'GET', url: '/trpc/daemon.ping' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.result.data.ok).toBe(true);
  });

  it('creates a node via node.create and retrieves it via node.get', async () => {
    const app = buildServer(TEST_DB);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/trpc/node.create',
      payload: {
        goal: 'test goal',
        definition_of_done: ['done'],
        authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { result } = JSON.parse(createResponse.body);
    const nodeId = result.data.id;
    expect(typeof nodeId).toBe('string');

    const getResponse = await app.inject({ method: 'GET', url: `/trpc/node.get?input=${encodeURIComponent(JSON.stringify({ id: nodeId }))}` });
    const getBody = JSON.parse(getResponse.body);
    expect(getBody.result.data.goal).toBe('test goal');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm test -- app.test`
Expected: FAIL — `Cannot find module './app'`.

- [ ] **Step 6: Install the Fastify tRPC adapter and write `server/app.ts`**

```bash
npm install @trpc/server
```

```ts
// src/server/app.ts
import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { appRouter } from './root-router';
import { createDb } from '../db/client';

export function buildServer(dbPath: string) {
  const db = createDb(dbPath);
  const app = Fastify({ logger: false });

  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: () => ({ db }),
    },
  });

  return app;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- app.test`
Expected: PASS — 2 tests passed.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/server
git commit -m "feat: add tRPC router and Fastify server with node/events/daemon procedures"
```

---

### Task 7: pm2-managed daemon entry point

**Files:**
- Create: `src/server/daemon-entry.ts`, `src/daemon/manager.ts`
- Test: `src/daemon/manager.test.ts`

**Interfaces:**
- Consumes: `buildServer` (Task 6).
- Produces: `startDaemon(): Promise<void>`, `daemonStatus(): Promise<DaemonStatus>`, `stopDaemon(): Promise<void>` — consumed by Task 8's CLI `daemon` command and `run` command.

- [ ] **Step 1: Install pm2**

```bash
npm install pm2
```

- [ ] **Step 2: Write `server/daemon-entry.ts`**

```ts
// src/server/daemon-entry.ts
import path from 'node:path';
import os from 'node:os';
import { buildServer } from './app';

const DAEMON_PORT = Number(process.env.ORG_DAEMON_PORT ?? 4177);
const DB_PATH = process.env.ORG_DB_PATH ?? path.join(os.homedir(), '.org', 'state.db');

const app = buildServer(DB_PATH);

app.listen({ port: DAEMON_PORT, host: '127.0.0.1' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Write the failing test for the daemon manager**

This test exercises the real pm2 programmatic API against the built entry script, so it requires `npm run build` first — it's an integration test, not a unit test, and is slower than the rest of the suite.

```ts
// src/daemon/manager.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startDaemon, stopDaemon, daemonStatus } from './manager';

describe('daemon manager', () => {
  afterAll(async () => {
    await stopDaemon().catch(() => {});
  });

  it('reports not running before start', async () => {
    const status = await daemonStatus();
    expect(status.running).toBe(false);
  });

  it('starts the daemon and reports it running with a pid', async () => {
    await startDaemon();
    await new Promise((r) => setTimeout(r, 500));
    const status = await daemonStatus();
    expect(status.running).toBe(true);
    expect(typeof status.pid).toBe('number');
  });

  it('stops the daemon and reports not running', async () => {
    await stopDaemon();
    const status = await daemonStatus();
    expect(status.running).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- manager.test`
Expected: FAIL — `Cannot find module './manager'`.

- [ ] **Step 5: Write `daemon/manager.ts`**

```ts
// src/daemon/manager.ts
import pm2 from 'pm2';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROCESS_NAME = 'org-daemon';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_SCRIPT = path.join(__dirname, '..', 'server', 'daemon-entry.js');

function withPm2<T>(fn: (resolve: (v: T) => void, reject: (e: unknown) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) return reject(err);
      fn(
        (v) => { pm2.disconnect(); resolve(v); },
        (e) => { pm2.disconnect(); reject(e); },
      );
    });
  });
}

export async function startDaemon(): Promise<void> {
  await withPm2<void>((resolve, reject) => {
    pm2.start({ name: PROCESS_NAME, script: ENTRY_SCRIPT }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
}

export async function daemonStatus(): Promise<DaemonStatus> {
  return withPm2<DaemonStatus>((resolve, reject) => {
    pm2.describe(PROCESS_NAME, (err, list) => {
      if (err) return reject(err);
      const proc = list[0];
      if (!proc || proc.pm2_env?.status !== 'online') return resolve({ running: false });
      resolve({ running: true, pid: proc.pid });
    });
  });
}

export async function stopDaemon(): Promise<void> {
  await withPm2<void>((resolve, reject) => {
    pm2.delete(PROCESS_NAME, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
```

- [ ] **Step 6: Build the project so the entry script exists, then run the test**

Run: `npm run build && npm test -- manager.test`
Expected: PASS — 3 tests passed.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/server/daemon-entry.ts src/daemon/manager.ts src/daemon/manager.test.ts
git commit -m "feat: add pm2-managed daemon entry point and lifecycle manager"
```

---

### Task 8: CLI skeleton (`org daemon` / `org run` / `org tree`)

**Files:**
- Create: `src/daemon/client.ts`, `src/cli/index.ts`, `src/cli/commands/daemon.ts`, `src/cli/commands/run.ts`, `src/cli/commands/tree.ts`
- Test: `test/cli-e2e.test.ts`

**Interfaces:**
- Consumes: `AppRouter` type (Task 6), `startDaemon`/`stopDaemon`/`daemonStatus` (Task 7).
- Produces: the `org` binary — the final integration point for this phase; no later Phase-1 task depends on this one, but every Phase 2+ CLI command (`org watch`, `org approve`, etc.) will register onto the same `program` instance from `cli/index.ts`.

- [ ] **Step 1: Install Commander and the tRPC client link**

```bash
npm install commander @trpc/client
```

- [ ] **Step 2: Write `daemon/client.ts`**

```ts
// src/daemon/client.ts
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../server/root-router';

const DAEMON_PORT = Number(process.env.ORG_DAEMON_PORT ?? 4177);

export function createDaemonClient() {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `http://127.0.0.1:${DAEMON_PORT}/trpc` })],
  });
}
```

- [ ] **Step 3: Write the CLI commands**

```ts
// src/cli/commands/daemon.ts
import type { Command } from 'commander';
import { startDaemon, stopDaemon, daemonStatus } from '../../daemon/manager';

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command('daemon').description('Control the background daemon');

  daemon.command('start').action(async () => {
    await startDaemon();
    console.log('Daemon started.');
  });

  daemon.command('status').action(async () => {
    const status = await daemonStatus();
    console.log(status.running ? `Running (pid ${status.pid})` : 'Not running');
  });

  daemon.command('stop').action(async () => {
    await stopDaemon();
    console.log('Daemon stopped.');
  });
}
```

```ts
// src/cli/commands/run.ts
import type { Command } from 'commander';
import { daemonStatus, startDaemon } from '../../daemon/manager';
import { createDaemonClient } from '../../daemon/client';

async function waitForDaemon(retries = 10): Promise<void> {
  const client = createDaemonClient();
  for (let i = 0; i < retries; i++) {
    try {
      await client.daemon.ping.query();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('Daemon did not become ready in time');
}

export function registerRunCommand(program: Command): void {
  program
    .command('run <goal>')
    .description('Create a root accountable node for the given goal')
    .action(async (goal: string) => {
      const status = await daemonStatus();
      if (!status.running) {
        console.log('Daemon not running — starting...');
        await startDaemon();
        await waitForDaemon();
      }
      const client = createDaemonClient();
      const result = await client.node.create.mutate({
        goal,
        definition_of_done: [goal],
        authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
        constraints: [],
      });
      console.log(`Root node created: ${result.id}`);
    });
}
```

```ts
// src/cli/commands/tree.ts
import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client';

export function registerTreeCommand(program: Command): void {
  program
    .command('tree')
    .description('Show the organization tree')
    .action(async () => {
      const client = createDaemonClient();
      const nodeList = await client.node.tree.query();
      for (const node of nodeList) {
        console.log(`${node.id}  ${node.state}  ${node.goal}`);
      }
    });
}
```

```ts
// src/cli/index.ts
#!/usr/bin/env node
import { Command } from 'commander';
import { registerDaemonCommand } from './commands/daemon';
import { registerRunCommand } from './commands/run';
import { registerTreeCommand } from './commands/tree';

const program = new Command();
program.name('org').description('Accountable Agent Organization Runtime CLI');

registerDaemonCommand(program);
registerRunCommand(program);
registerTreeCommand(program);

program.parseAsync(process.argv);
```

- [ ] **Step 4: Write the failing end-to-end test**

```ts
// test/cli-e2e.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import { stopDaemon } from '../src/daemon/manager';

const CLI = './dist/cli/index.js';

describe('CLI end-to-end', () => {
  afterAll(async () => {
    await stopDaemon().catch(() => {});
  });

  it('org run creates a node, org tree lists it', async () => {
    const runResult = await execa('node', [CLI, 'run', 'end-to-end test goal']);
    expect(runResult.stdout).toContain('Root node created:');

    await new Promise((r) => setTimeout(r, 500));

    const treeResult = await execa('node', [CLI, 'tree']);
    expect(treeResult.stdout).toContain('end-to-end test goal');
  }, 20000);
});
```

- [ ] **Step 5: Install execa (needed by the test) and run to verify it fails**

```bash
npm install --save-dev execa
```

Run: `npm run build && npm test -- cli-e2e.test`
Expected: FAIL — `dist/cli/index.js` either doesn't exist yet or `org run`/`org tree` aren't wired up.

- [ ] **Step 6: Fix any wiring issues, rebuild, and run again to verify it passes**

Run: `npm run build && npm test -- cli-e2e.test`
Expected: PASS — 1 test passed, with real stdout showing the created node's goal in the tree output.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/daemon/client.ts src/cli test/cli-e2e.test.ts
git commit -m "feat: add CLI skeleton (org daemon/run/tree) with end-to-end test"
```

---

### Task 9: `org doctor` framework (no real checks yet)

**Files:**
- Create: `src/doctor/checks.ts`, `src/cli/commands/doctor.ts`
- Test: `src/doctor/checks.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interface DoctorCheck { name: string; run(): Promise<{ ok: boolean; message: string }> }`, `runChecks(checks: DoctorCheck[]): Promise<boolean>` — Phase 2 appends real Docker/kind/kubectl checks to the array passed into `registerDoctorCommand`, without changing this task's shape.

- [ ] **Step 1: Install listr2 and @clack/prompts**

```bash
npm install listr2 @clack/prompts
```

- [ ] **Step 2: Write the failing test**

```ts
// src/doctor/checks.test.ts
import { describe, it, expect } from 'vitest';
import { runChecks, type DoctorCheck } from './checks';

describe('runChecks', () => {
  it('returns true when all checks pass', async () => {
    const checks: DoctorCheck[] = [
      { name: 'always ok', run: async () => ({ ok: true, message: 'fine' }) },
    ];
    expect(await runChecks(checks)).toBe(true);
  });

  it('returns false when any check fails', async () => {
    const checks: DoctorCheck[] = [
      { name: 'ok', run: async () => ({ ok: true, message: 'fine' }) },
      { name: 'broken', run: async () => ({ ok: false, message: 'missing dependency' }) },
    ];
    expect(await runChecks(checks)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- checks.test`
Expected: FAIL — `Cannot find module './checks'`.

- [ ] **Step 4: Write `doctor/checks.ts`**

```ts
// src/doctor/checks.ts
import { Listr } from 'listr2';

export interface DoctorCheckResult {
  ok: boolean;
  message: string;
}

export interface DoctorCheck {
  name: string;
  run(): Promise<DoctorCheckResult>;
}

export async function runChecks(checks: DoctorCheck[]): Promise<boolean> {
  let allOk = true;
  const listr = new Listr(
    checks.map((check) => ({
      title: check.name,
      task: async (_ctx, task) => {
        const result = await check.run();
        if (!result.ok) allOk = false;
        task.title = `${check.name}: ${result.message}`;
        if (!result.ok) throw new Error(result.message);
      },
    })),
    { exitOnError: false },
  );
  await listr.run();
  return allOk;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- checks.test`
Expected: PASS — 2 tests passed.

- [ ] **Step 6: Write and register the `doctor` CLI command**

```ts
// src/cli/commands/doctor.ts
import type { Command } from 'commander';
import { runChecks, type DoctorCheck } from '../../doctor/checks';

const CHECKS: DoctorCheck[] = [
  {
    name: 'Node.js version',
    run: async () => {
      const major = Number(process.versions.node.split('.')[0]);
      return major >= 20
        ? { ok: true, message: `v${process.versions.node}` }
        : { ok: false, message: `v${process.versions.node} — need >= 20` };
    },
  },
];

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check that required dependencies are present')
    .action(async () => {
      const ok = await runChecks(CHECKS);
      process.exitCode = ok ? 0 : 1;
    });
}
```

```ts
// src/cli/index.ts — add these two lines to the existing file
import { registerDoctorCommand } from './commands/doctor';
// ...
registerDoctorCommand(program);
```

- [ ] **Step 7: Rebuild and manually verify the command runs**

Run: `npm run build && node dist/cli/index.js doctor`
Expected: prints a task list with "Node.js version: v20.x.x" (or your installed version) and exits 0.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/doctor src/cli/commands/doctor.ts src/cli/index.ts
git commit -m "feat: add org doctor framework with Node.js version check"
```

---

### Task 10: CI skeleton

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm run typecheck`, `npm test`, `npm run build` (all defined in Task 1/earlier tasks).
- Produces: a passing CI badge on every push/PR — Phase 5 extends this workflow with a `kind`-backed integration job; this task only wires the always-on unit-test job.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add typecheck/build/test workflow"
```

- [ ] **Step 3: Push and verify the workflow runs green**

Run: `git push -u origin main` (after creating the `abhaychourasiyawork1-sys/CherryOnTop` GitHub repo and adding it as `origin`, if not already done)
Expected: the Actions tab shows the `test` job passing.

---

## Phase 1 exit checklist

Before moving to Phase 2 (invoke superpowers:verification-before-completion here, not just this checklist from memory):

- [ ] `npm run typecheck` passes with zero errors.
- [ ] `npm test` passes — every test file from Tasks 1–9, including the pm2 integration test and the CLI end-to-end test.
- [ ] `node dist/cli/index.js run "manual smoke test"` followed by `node dist/cli/index.js tree` shows the created node with its real state.
- [ ] `node dist/cli/index.js doctor` runs and exits 0.
- [ ] CI is green on GitHub.
- [ ] Invoke superpowers:requesting-code-review before merging, then superpowers:finishing-a-development-branch to decide how Phase 1 lands (this plan assumed a single `main`-branch flow via direct commits inside a worktree; if the review surfaces a reason to use a PR instead, follow finishing-a-development-branch's guidance there).

---

# Phase 2: Execution Substrate (scoped — full step detail written just before this phase starts)

**Depends on:** Phase 1's `nodeMachine`/`node-actor-manager` (the `SELF_EXECUTE` state gets real behavior instead of an unconditional `always: 'VERIFY'`), and `Db`/event-log plumbing.

1. **`src/k8s/kind.ts`** — wraps `kind get clusters` / `kind create cluster --name org-local` via execa; `ensureLocalCluster(): Promise<void>` called from `org doctor` and from daemon startup. Detects an existing kubeconfig context first (via `@kubernetes/client-node`'s `KubeConfig.loadFromDefault()`) before provisioning.
2. **`src/k8s/client.ts`** — thin wrapper around `@kubernetes/client-node`'s `BatchV1Api`/`CoreV1Api`, exposing `createJobForExecution(spec): Promise<string>` (returns Job name), `watchJobCompletion(jobName): Promise<JobResult>`, `deleteJob(jobName): Promise<void>`.
3. **`src/k8s/secrets.ts`** — `createEphemeralSecret(nodeId, credentials): Promise<string>` (Secret name) and `deleteSecret(name): Promise<void>`, called immediately before/after each Job per spec §18.
4. **`src/k8s/network-policy.ts`** — `ensureDefaultDenyPolicy(namespace): Promise<void>` applied once per namespace/cluster bootstrap, plus a per-Job egress-allowlist Secret/policy per spec's network table.
5. **`src/adapters/adapter.ts`** — the `RuntimeAdapter` interface from handoff §7 (`discover`, `validate`, `estimate`, `launch`, `stream`, `stop`, `collect_usage`, `normalize_result`), typed with zod-validated request/result shapes.
6. **`src/adapters/claude-code.ts`** — implements `RuntimeAdapter` for Claude Code: `launch()` spawns `claude --print --output-format stream-json` via execa inside the dispatched Job (the Job's container command, not a local subprocess), `stream()` pipes the Job's log stream through `ndjson.parse()`.
7. **`src/execution/execute-step.ts`** — the function the node machine's `SELF_EXECUTE` state invokes: creates the Secret, dispatches the Job with the worktree mounted, streams events into the node's event log via `appendEvent`, awaits completion, deletes the Secret, returns a structured result consumed by `VERIFY`.
8. **Wire into `node-machine.ts`**: replace `SELF_EXECUTE: { always: 'VERIFY' }` with an invoked actor calling `execute-step.ts`, transitioning to `VERIFY` on success/failure with the real result in context.
9. **`org doctor` additions**: Docker running, `kind` binary present, `kubectl` binary present, cluster reachable — each a `DoctorCheck` appended to the array from Task 9.

Exit criteria for this phase: `org run "<goal that Claude Code can actually complete>"` results in a real K8s Job executing Claude Code headlessly inside the auto-bootstrapped `kind` cluster, with its structured output visible in `org events`.

# Phase 3: Accountability Engines (scoped)

**Depends on:** Phase 2's `execute-step.ts` (self-execution must work before delegation has anything to compare itself against).

1. **`src/schemas/commitment.ts`** — zod schema matching handoff §9's `Commitment` shape; `src/db/schema.ts` gains a `commitments` table (additive Drizzle migration).
2. **`src/engines/authority.ts`** — `effectiveAuthority(platformMax, parentGranted, childRequested, runtimeCaps, sandboxCaps): Authority` implementing the intersection formula from handoff §8.
3. **`src/engines/economics.ts`** — `scoreDelegation(input): { score: number; delegate: boolean }` implementing the exact formula from handoff §10/spec §7: `estimated_value - (model_cost + latency_cost + coordination_cost + verification_cost) - risk_penalty`, compared against a configurable threshold. Every intermediate term returned in the result, not just the final boolean, so `org decision` (Phase 4) can print the full breakdown.
4. **`src/intelligence/coordinator.ts`** — `assessUncertainty(nodeContext): IntelligenceBundle`, checking node/org memory first (Phase 5 for the "org memory" half; node-local memory can land here) before returning a bundle; low uncertainty short-circuits to a cheap default bundle without spawning any workers.
5. **`src/lifecycle/delegate.ts`** — the `DELEGATE` state's real implementation: creates a child node (new row in `nodes`, new `nodeMachine` actor) with a budget/deadline envelope carved from the parent's, replacing the current `DELEGATE: { always: 'VERIFY' }` stub.
6. **`src/db/queries/decisions.ts`** — persists each economics/delegation decision (`decisions` table, new Drizzle migration) with its full score breakdown, for `org decision`.

Exit criteria: a node with a subtask that scores above the delegation threshold actually spawns a child node with its own budget envelope, and `org decision` (once Phase 4 exists) can show the score that caused it.

# Phase 4: CLI/TUI & Approvals (scoped)

**Depends on:** Phase 3's commitments/decisions tables and delegation (there needs to be a real tree and real decisions to watch/inspect).

1. **`src/cli/commands/watch.tsx`** — Ink app using `@inkjs/ui`'s `Badge`/`ProgressBar`/`StatusMessage`, polling (or subscribing via tRPC's WebSocket subscription once Task-below wires it) `node.tree` + a new `commitment.list` procedure.
2. **`server/routers/commitment.ts`, `server/routers/decision.ts`** — new tRPC procedures backing `org commitment` and `org decision`.
3. **`src/server/subscriptions.ts`** + `@fastify/websocket` registration in `app.ts` — a tRPC subscription procedure emitting tree-changed events, replacing `org watch`'s polling with push updates.
4. **`src/approvals/escalation.ts`** — when a node enters `ESCALATE`/`WAIT_APPROVAL` (currently absent from the Phase-1 machine — added here as real states wired from the authority engine), fires `node-notifier` and records a pending-approval row.
5. **`src/cli/commands/approve.ts`** — `org approve <id>` / `org reject <id>`, calling a new `node.resolveApproval` mutation that sends the corresponding event to the waiting actor.
6. **`org doctor` UX pass** — swap the Task-9 framework's console output for `@clack/prompts`-driven guidance text when a check fails (e.g., a copy-pasteable install command).

Exit criteria: a node that hits an authority boundary shows up in `org watch`, fires a desktop notification, and `org approve <id>` unblocks it.

# Phase 5: Memory, Multi-Adapter & CI/Packaging (scoped)

**Depends on:** Phase 3's decisions/commitments (memory promotion needs real outcomes to learn from) and Phase 2's adapter interface (Codex adapter implements the same `RuntimeAdapter` contract).

1. **`src/memory/node-memory.ts`, `src/memory/org-memory.ts`, `src/memory/promotion.ts`** — implements handoff §11's three-level model and promotion rule; org memory feeds back into `src/engines/economics.ts`'s historical-actuals input (closing the loop described in handoff §10's "Learning from economics" diagram).
2. **`src/adapters/codex.ts`** — second `RuntimeAdapter` implementation, proving the interface from Phase 2 generalizes without modification.
3. **`Dockerfile`** (repo root) — the shared `org/runner` base image (Claude Code + Codex CLIs, git, common toolchains) referenced by Phase 2's Job specs.
4. **`.github/workflows/publish-image.yml`** — builds and pushes to `ghcr.io/abhaychourasiyawork1-sys/cherryontop-runner` on release tag.
5. **`.github/workflows/ci.yml` extension** — add a `kind`-backed integration job using `helm/kind-action`, running the Phase 2 K8s dispatch tests against a real ephemeral cluster in CI (not just local dev).
6. **`package.json` packaging pass** — `files` field, `prepublishOnly` build step, verify `npm pack` produces a correctly-runnable global install.

Exit criteria: `npm install -g cherryontop` on a clean machine, followed by `org run`, results in a real sandboxed multi-adapter-capable execution with memory-informed delegation decisions — the full v0.1 scope from the handoff document, end to end.
