# Accountable Agent Organization Runtime — Implementation-Level Design

Status: approved by user (verbal walk-through, 2026-09-05). Supersedes/extends the conceptual handoff in `accountable_agent_organization_runtime_handoff.html`, which stays the front-facing source of truth and will be updated from this spec.

## 1. Scope

This spec pins down the parts of the original architecture handoff that were left conceptual: language/runtime, process model, sandboxing/execution substrate, persistence, daemon lifecycle, CLI/TUI shape, credential handling, and the concrete delegation-economics formula. It does not re-derive the product thesis, node contract, lifecycle states, or CLI command names — those are unchanged from the handoff and referenced, not repeated, here.

## 2. Product framing

Adopt a light organizational metaphor, not a new mascot: the existing vocabulary (organization, accountable owner, delegation, commitment, authority, handoff) *is* the product voice — CLI output, docs, and any future UI should talk about "the organization" and "handoffs," not generic "agents" and "tasks." This is packaging what the architecture already implies, not a separate creative effort.

## 3. Stack decision

**Pure TypeScript on Node.js (LTS) for v0.1.** No polyglot split. Intelligence-plane workers (evidence, capability, runtime-intel) are constrained invocations of the same runtime adapters used for implementation work — not a separate ML/Python stack. Rationale: one dependency graph, one build/debug story, first-class async I/O for streaming concurrent subprocess/Job output, and npm distribution fits users who already run Node-based coding-agent CLIs.

Deferred, not rejected: a Python (or other) sidecar worker contract for anything that genuinely needs the Python ecosystem (e.g., local embeddings for memory retrieval) — added in v0.2+ only if a concrete capability can't be met in TS (e.g., via `@xenova/transformers` or a hosted embeddings API first).

## 4. Process & daemon architecture

### 4.1 Server / Host split, colocated

One OS process for v0.1, structured internally as two logical components behind a defined interface, so a later remote-worker version (already on the roadmap as v0.4) is a deployment change, not a redesign — mirrors the split used by Omnigent (a comparable meta-harness product: Server holds state/serves API, Host executes in sandboxes).

- **Server**: owns SQLite (nodes, commitments, decisions, events, memory) — accessed via Drizzle ORM for typed queries/migrations — runs the Node Runtime (per-node XState statecharts), the Commitment/Authority/Economics engines, and the Intelligence Coordinator. Exposes a local HTTP + WebSocket API via Fastify + tRPC (zod-validated inputs, `@fastify/websocket` for subscriptions) that the CLI and any future GUI consume.
- **Host**: owns the Kubernetes client, the Runtime Adapter Registry, Job dispatch/watching, and per-Job Secret lifecycle.

### 4.2 Lifecycle

The daemon persists as a background process across CLI invocations — this is required for the live TUI and desktop-notification approval flow to mean anything. `org run` auto-spawns the daemon (Server+Host) if none is running, detected via a local Unix domain socket / lock file. Every other command (`org tree`, `org approve`, `org watch`) is a thin client hitting the daemon's API. Explicit lifecycle control: `org daemon start|status|stop`.

### 4.3 Nodes are not OS processes

Accountable nodes are in-memory state machines inside the Server, checkpointed to SQLite on every transition. They are never given their own OS process or pod. The only thing that leaves the daemon is a single execution step, dispatched as one Kubernetes Job.

## 5. Execution substrate

### 5.1 Sandboxing: Kubernetes from v0.1

Per-execution containerized isolation via Kubernetes, not plain Docker — chosen deliberately over the lighter MVP-velocity option, because the handoff document itself flags worktree-only isolation as a real, named risk. This applies even for a single local user.

- **Cluster bootstrap**: on first use, if no kubeconfig/cluster is detected, the CLI provisions a local `kind` cluster automatically (one dependency — Docker — instead of two). If a kubeconfig already points somewhere (a real cluster, Docker Desktop's K8s, a shared org cluster), that's used instead. Same code path from laptop to production cluster.
- **Execution granularity**: one Kubernetes Job per harness-invocation step (one Claude Code/Codex/Pi headless run), not one pod per node's lifetime. The node's iteration loop can spawn many such Jobs; each runs to completion, streams results back, then terminates.
- **Image strategy**: one shared base runner image (`org/runner`) with all supported harness CLIs, git, and common toolchains pre-installed, built from a Dockerfile in-repo and published to GHCR on release; pulled at a pinned tag by default, with local build fallback if unavailable.

### 5.2 Credentials

Per-Job Kubernetes Secrets, mounted read-only, created immediately before the Job and deleted on completion. The daemon reads the user's existing local credentials (Claude Code/Codex CLI auth, git credential helper output) once and relays them — nothing long-lived sits in the cluster, and the user's existing subscription-based auth keeps working without re-entering anything.

### 5.3 Network policy

Default-deny egress and ingress, with an allowlist per Job: the LLM provider endpoint(s) the harness needs, the task's git remote, and package registries only if the Definition of Done requires installing dependencies. Pod-to-pod and pod-to-cluster-internals traffic is not needed (nodes coordinate through the daemon, not directly) and stays blocked.

### 5.4 Runtime adapters

Adapters drive each harness in its built-in headless/non-interactive streaming mode (e.g., Claude Code's `--print --output-format stream-json`), parsed as structured events — no PTY, no ANSI scraping. This is the same mode the Claude Agent SDK itself is built on. An adapter without a structured mode falls back to capturing plain stdout/stderr and the exit code; PTY driving is not used unless a future harness genuinely has no scriptable mode at all.

Concretely: the subprocess is spawned with `execa`, and stdout is piped through `ndjson`'s parse transform to yield one structured event object per line.

## 6. Persistence

SQLite (via `better-sqlite3`) with two layers:
- **State tables** (mutable): current node state, commitments, budgets, decisions — answers "what's true right now" without replaying history.
- **Append-only `events` table**: every state transition, for `org events`, crash-recovery, and the audit trail the accountability model depends on.

This is deliberately not full event sourcing (state is not derived by replay) — the query patterns the CLI needs (tree view, commitment risk, decision inspection) are simpler against direct state tables, and full event-sourcing's snapshot/projection machinery isn't justified for a local single-daemon tool yet.

## 7. Delegation economics — concrete formula

```
score = estimated_value_of_delegating
        − (model_cost + latency_cost + coordination_cost + verification_cost)
        − risk_penalty

delegate if score >= configurable_threshold, else self-execute
```

Inputs are cheap, already-available signals:
- task-class complexity, from the Intelligence Bundle
- remaining budget/deadline slack, from the node's commitment
- historical actuals for similar past tasks, from node/org memory — falling back to conservative defaults when no history exists

Chosen over "ask the LLM to judge" specifically because every number behind the decision must be printable and reproducible — this is what makes delegation decisions themselves evidence-backed, not just their outcomes. Improves purely by accumulating history; no model training required for v0.1.

## 8. CLI / TUI surface

- Most commands print clean, scriptable, pipeable text, with `--json` for machine consumption (`org tree`, `org node inspect`, `org commitment`, `org decision`, `org events`).
- One command, `org watch`, opens a live Ink-based TUI: real-time tree, budgets, commitment risk, and highlighted pending approvals.
- Framework: Commander.js for the command tree (sufficient structure without oclif's plugin-system overhead), Ink for `org watch`.

## 9. Approvals & escalation

When a node hits an authority boundary, the pending approval surfaces in `org watch` (if open) and fires a native OS desktop notification (`node-notifier`) regardless of whether any terminal is attached. `org approve <id>` / `org reject <id>` resolve it from any terminal, since the CLI is a stateless client to the daemon's API.

## 10. Observability

Structured JSON logs (`pino`) to local file/stdout, plus the `events` table already serving as the accountability timeline. No separate tracing backend (OpenTelemetry collector, etc.) for v0.1 — the log shape is chosen so it can feed a real OTel pipeline later without rework, once there's evidence multiple concurrent Jobs actually need trace-level correlation.

## 11. Tech stack summary

| Layer | Choice |
|---|---|
| Language/runtime | TypeScript, Node.js LTS |
| CLI framework | Commander.js |
| Live dashboard | Ink, with `@inkjs/ui` for prebuilt widgets (ProgressBar/Badge/Spinner/Alert/StatusMessage) |
| Daemon ↔ CLI API | Fastify + tRPC (official Fastify adapter) + `@fastify/websocket` for subscriptions |
| Input/schema validation | zod — validates node contracts, CLI args, and every tRPC procedure input |
| State/event store | SQLite via `better-sqlite3`, with Drizzle ORM + `drizzle-kit` for schema/migrations/typed queries |
| Node lifecycle engine | XState — implements the CREATED→...→COMPLETE statechart directly |
| Process execution | execa — replaces raw `child_process` for adapters and Host-side `kind`/`kubectl`/git shelling |
| Harness output parsing | `ndjson` — streaming parse of Claude Code's `stream-json` output |
| K8s control | `@kubernetes/client-node` (official) |
| Local cluster | `kind` CLI, shelled out to via execa; existing context via `kubectl config current-context` |
| Logging | `pino` |
| Desktop notifications | `node-notifier` |
| Daemon process lifecycle | pm2 (programmatic API) — start/stop/status, crash auto-restart, log capture |
| Interactive CLI prompts | `@clack/prompts` — `org doctor`'s guided setup |
| Preflight task UI | `listr2` — sequential/concurrent spinners for dependency checks |
| Packaging | npm global package, `bin` entry, `org doctor` preflight (checks Docker/kind/kubectl) |
| Runner image | Dockerfile in-repo → GHCR, pinned tag, local-build fallback |
| Project CI | GitHub Actions: lint/typecheck/unit always; `kind`-backed integration job (`helm/kind-action`) for real Job/Secret/NetworkPolicy dispatch |
| Test framework | Vitest |

### 11.1 Library research pass (2026-09-05)

Verified via live search (not assumed) to replace hand-rolled pieces of the stack with actively-maintained, widely-adopted packages:

| Need | Library | Verified adoption | Replaces |
|---|---|---|---|
| Validation | [zod](https://zod.dev/) | 100M+ weekly downloads; de facto TS validation standard | Hand-rolled runtime validation scattered across the codebase |
| Daemon↔CLI RPC | [tRPC](https://trpc.io/) (Fastify + WS adapters) | Official adapters maintained by trpc.io | Hand-written REST routes, duplicated request/response types, hand-rolled WS protocol |
| Typed SQL | [Drizzle ORM](https://orm.drizzle.team/) + drizzle-kit | ~2M weekly downloads | Hand-written SQL strings and migration scripts |
| Node lifecycle | [XState](https://stately.ai/docs/xstate) | Zero deps, widely used for backend workflow orchestration | Hand-rolled switch/if FSM |
| Process execution | [execa](https://github.com/sindresorhus/execa) | ~128M weekly downloads | Raw `child_process` boilerplate |
| Streaming JSON | [ndjson](https://www.npmjs.com/package/ndjson) | Standard, ~1MB peak memory even on 1GB input | Hand-rolled line-buffering JSON parser |
| Daemon lifecycle | [pm2](https://pm2.keymetrics.io/) (programmatic API) | ~2.8-3.6M weekly downloads, 600M+ total | Hand-rolled detached-process + PID-file + crash-restart logic |
| CLI prompts | [@clack/prompts](https://github.com/bombshell-dev/clack) | Modern TS-native successor to inquirer | Hand-rolled interactive prompt UI |
| Task-list UI | [listr2](https://listr2.kilic.dev/) | Purpose-built for concurrent/sequential CLI task lists | Hand-rolled spinner sequencing |
| TUI widgets | [@inkjs/ui](https://github.com/vadimdemedes/ink-ui) | Official Ink companion, same author as Ink | Hand-rolled progress bars/badges in Ink |

**Reconfirmed unchanged**: `@kubernetes/client-node` (official, ~1-2M weekly downloads, actively maintained v2.x), `node-notifier` (still maintained, v10.x, no better alternative found), `better-sqlite3` (now the driver underneath Drizzle).

**Deliberately not added**: a dedicated binary-existence checker (e.g. `command-exists`) — the common package is 6+ years unmaintained; `execa`'s own error path (`await execa('docker', ['--version'])`, catching `ENOENT`) covers this in one line.

**Confirmed no better option exists**: no viable npm-native wrapper for `kind` cluster creation was found (it's a Go binary with no official JS bindings) — shelling out via execa remains the correct choice, not a placeholder.

## 12. Testing & verification

**Product-level** (this project's own correctness):
- Unit tests for the Commitment, Authority, and Economics engines as pure functions (Vitest)
- Integration tests hitting the Fastify API against a temp SQLite file
- CI integration job using a real `kind` cluster to exercise Job creation, Secret lifecycle, and NetworkPolicy enforcement end-to-end — not just mocked
- One CLI smoke test: `org run` against a trivial fixture repo/task, end-to-end

**Target-repo verification** (what a node's own deliverable is judged against, unchanged from the handoff): build/lint/test/typecheck commands detected from the target repo's own conventions or explicitly named in the node's Definition of Done, run as a Job step, with pass/fail + captured output stored as evidence.

## 13. Explicitly deferred (not v0.1)

- Python/polyglot intelligence workers
- Remote/separated Host (Host and Server on different machines)
- Full TUI-first experience (every command through the dashboard)
- Full event sourcing
- OpenTelemetry tracing
- A distinct brand persona/mascot beyond the organizational-metaphor voice
- Learned (non-heuristic) delegation-economics scoring
- Per-adapter or user-pluggable runner images (shared base image only for v0.1)

## 14. Decisions log addendum

Extends the handoff's existing D1–D12 with the decisions made in this session:

- **D13** Stack — pure TypeScript for v0.1, polyglot workers deferred.
- **D14** Node isolation — single daemon, in-memory node state machines, SQLite durability; nodes are never OS processes.
- **D15** Adapter execution — headless/structured-streaming mode, no PTY.
- **D16** Persistence — CRUD state tables + append-only event log, not full event sourcing.
- **D17** CLI/TUI — scriptable plain text by default, one live TUI (`org watch`).
- **D18** Sandboxing — Kubernetes per-execution isolation from v0.1, chosen over lighter policy-only MVP option because of the handoff's own stated worktree-isolation risk.
- **D19** Cluster bootstrap — CLI auto-provisions a local `kind` cluster when no kubeconfig is present; existing kubeconfig used otherwise.
- **D20** Execution granularity — one Job per harness-invocation step, not per node lifetime.
- **D21** Credentials — per-Job K8s Secrets, read-only, deleted on completion.
- **D22** CLI packaging — npm global package with `org doctor` preflight dependency checks.
- **D23** Observability — structured logs + event store only; no OTel for v0.1.
- **D24** Product framing — light organizational metaphor, no separate mascot.
- **D25** Network policy — default-deny with a narrow per-Job egress allowlist.
- **D26** Approval notifications — TUI highlight + OS desktop notification, not a blocking terminal prompt.
- **D27** Daemon architecture — logical Server/Host split, colocated for v0.1, modeled on Omnigent's comparable production architecture.
- **D28** Delegation economics — transparent weighted heuristic formula, not LLM judgment, for auditability.
- **D29** Container image strategy — one shared base runner image, not per-adapter or user-pluggable, for v0.1.
- **D30** zod for all validation — node contracts, CLI args, tRPC inputs.
- **D31** tRPC over hand-written REST for daemon↔CLI communication.
- **D32** Drizzle ORM over raw SQL, layered on the existing `better-sqlite3` driver.
- **D33** XState for the node lifecycle statechart.
- **D34** execa for all process execution (adapters + Host shelling to kind/kubectl/git).
- **D35** ndjson for parsing harness streaming output.
- **D36** pm2 (programmatic API) for daemon process lifecycle, replacing hand-rolled detach/PID-file logic.
- **D37** `@clack/prompts` + `listr2` + `@inkjs/ui` for CLI/TUI polish, replacing hand-rolled equivalents.
- **D38** `@kubernetes/client-node` and `node-notifier` reconfirmed as correct via live research; no change.
- **D39** No JS wrapper exists for `kind` (confirmed, not assumed); no `command-exists` dependency added (unmaintained, one-line execa alternative covers it).

## 15. Next steps

1. Rework `accountable_agent_organization_runtime_handoff.html` to fold in every decision above (new/updated sections for stack, execution substrate, security posture, daemon architecture, CLI/TUI, and an updated decisions log) — this is the immediate deliverable for this session.
2. When ready to start building, invoke the `writing-plans` skill against this spec to produce a phased implementation plan. Not part of this session's scope unless requested.
