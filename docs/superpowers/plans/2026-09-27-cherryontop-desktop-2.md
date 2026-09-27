# CherryOnTop Desktop 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a modern AI-workspace GUI for CherryOnTop that provides Claude-class workspace, conversation, artifact, skills, connectors and visual capabilities while preserving CherryOnTop's accountable organization runtime.

**Architecture:** Add a product-facing workspace/project/conversation/run layer above the existing Case/Node orchestration layer. Introduce a structured content/artifact protocol so chat, documents, Mermaid, charts, diffs, approvals and organization state share one renderer. Keep policy, budgets, decisions, sandboxing, validation and evidence enforced by the daemon/runtime, never by the renderer.

**Tech Stack:** TypeScript, React 19, Electron 40, tRPC 11, SQLite, Drizzle ORM, XState, Vitest, marked, Mermaid 11, existing CherryOnTop daemon/runtime.

**Spec:** `docs/architecture/cherryontop-desktop-2.md`

## Global Constraints

- Node.js >= 22.
- Electron + React remains the desktop shell.
- tRPC remains the GUI/daemon boundary.
- Existing Node contracts remain authoritative for execution.
- Existing mandate snapshots remain immutable historical authority.
- Existing evidence/event chain remains the source of truth for audit/provenance.
- UI may request capabilities but never directly grant execution authority.
- Existing Case/Proof/Receipt functionality must remain reachable until Run views have parity.
- Every new capability must have unit and integration coverage before being considered complete.

## Review Focus

- A renderer must not accidentally become an authority layer; test that UI requests cannot increase tool/budget/delegation permissions.
- Project context must not become prompt stuffing; test pin/exclude and planner-selected context separately.
- Streaming events can arrive out of order or after navigation; test idempotent reconciliation.
- Artifact versions must never lose provenance; test edits, regeneration and concurrent version creation.
- Daemon restart must preserve durable work; test GUI reconnection and active-run recovery.

---

## Task 1: Domain model and migrations

**Files:**
- Create: `src/workspace/*`, `src/projects/*`, `src/conversations/*`, `src/runs/*`
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/*`
- Test: corresponding `*.test.ts`

**Interfaces:**
- Produces workspace/project/conversation/run repository APIs used by later tasks.
- Run references the existing root Node/Case instead of replacing it.

- [ ] Step 1: Write failing schema/API tests for create/list/get/update workspace, project, conversation and run.
- [ ] Step 2: Run `npm run test:unit` against the focused tests and verify failure.
- [ ] Step 3: Add migrations and domain repositories with stable IDs and timestamps.
- [ ] Step 4: Verify workspace → project → conversation → run relationships and archival behavior.
- [ ] Step 5: Run focused tests and `npm run typecheck`.
- [ ] Step 6: Commit `feat: add workspace project conversation run domains`.

## Task 2: tRPC workspace/project/conversation/run routers

**Files:**
- Create: `src/server/routers/workspace.ts`
- Create: `src/server/routers/project.ts`
- Create: `src/server/routers/conversation.ts`
- Create: `src/server/routers/run.ts`
- Modify: `src/server/root-router.ts`
- Test: router contract tests

**Interfaces:**
- Query/mutation names should be stable and typed.
- Run creation delegates to the existing node creation path.

- [ ] Step 1: Write failing contract tests for CRUD and run creation.
- [ ] Step 2: Implement routers against repositories from Task 1.
- [ ] Step 3: Ensure run creation records the created root Node/Case reference.
- [ ] Step 4: Verify existing router compatibility helpers still pass.
- [ ] Step 5: Commit `feat: expose workspace project conversation run api`.

## Task 3: New desktop shell and navigation

**Files:**
- Create: `gui/src/renderer/src/app/*`
- Create: `gui/src/renderer/src/shell/WorkspaceSwitcher.tsx`
- Create: `gui/src/renderer/src/shell/CommandPalette.tsx`
- Modify: `gui/src/renderer/src/App.tsx`
- Modify: `gui/src/renderer/src/styles.css`
- Test: GUI component tests

**Interfaces:**
- Shell consumes Task 2 routers.
- Legacy panels remain reachable behind Run routes.

- [ ] Step 1: Write tests for workspace switch, navigation and deep-link Run routing.
- [ ] Step 2: Implement shell with left navigation, contextual right rail and persistent composer slot.
- [ ] Step 3: Route old Desk/Cases/Mandates/Memory and new Project/Chat/Run views without data duplication.
- [ ] Step 4: Add keyboard command palette with navigation/search command stubs.
- [ ] Step 5: Run GUI tests and build.
- [ ] Step 6: Commit `feat: add desktop workspace shell`.

## Task 4: Conversation and message model

**Files:**
- Modify: conversation domain and schema from Task 1
- Create: `src/server/routers/message.ts`
- Create: `gui/src/renderer/src/conversations/*`
- Test: domain/router/component tests

- [ ] Step 1: Add failing tests for message ordering, persistence and run linkage.
- [ ] Step 2: Implement message persistence with structured content field.
- [ ] Step 3: Build clean message timeline with streaming placeholders.
- [ ] Step 4: Add message actions for copy, retry, branch, open linked Run/artifact.
- [ ] Step 5: Verify reload reconstructs the exact conversation.
- [ ] Step 6: Commit `feat: add persistent conversations and messages`.

## Task 5: Unified Composer and intent routing

**Files:**
- Extend: `src/intelligence/ask.ts`
- Create: `src/intelligence/intent-router.ts`
- Modify: `gui/src/renderer/src/panels/Composer.tsx`
- Create: GUI intent-routing tests

- [ ] Step 1: Write failing tests for question vs task vs artifact vs connector vs project intents.
- [ ] Step 2: Implement deterministic high-confidence record/question routes before expensive execution.
- [ ] Step 3: Route task intents into existing node/run creation.
- [ ] Step 4: Add attachment/context/skill/tool affordances without coupling authority to UI state.
- [ ] Step 5: Test ambiguous input does not accidentally start a run.
- [ ] Step 6: Commit `feat: unify composer intent routing`.

## Task 6: Presentation event stream

**Files:**
- Create: `src/events/presentation-protocol.ts`
- Extend: existing server subscription/daemon event bridge
- Create: `gui/src/renderer/src/shared/event-reconciler.ts`
- Test: protocol/reconciliation tests

**Interfaces:**
- Events listed in the spec are the minimum presentation envelope.
- Reconciler is idempotent and revision-aware.

- [ ] Step 1: Write failing tests for duplicated, delayed and out-of-order events.
- [ ] Step 2: Implement typed presentation event envelope.
- [ ] Step 3: Implement renderer reconciliation keyed by stable IDs and versions.
- [ ] Step 4: Verify navigation away/back rehydrates from durable queries.
- [ ] Step 5: Commit `feat: add typed presentation events`.

## Task 7: Structured ContentRenderer

**Files:**
- Create: `gui/src/renderer/src/shared/ContentRenderer.tsx`
- Create: `gui/src/renderer/src/shared/content-types.ts`
- Modify: `Conversation.tsx`
- Test: content rendering tests

- [ ] Step 1: Write failing tests for text, Markdown, code, table, chart, diagram, artifact, file, diff, approval and progress blocks.
- [ ] Step 2: Implement discriminated-union content blocks.
- [ ] Step 3: Migrate Conversation to ContentRenderer.
- [ ] Step 4: Verify unsupported blocks degrade safely to an inspectable fallback.
- [ ] Step 5: Commit `feat: add structured response renderer`.

## Task 8: Artifact v2 and versioning

**Files:**
- Modify: `src/db/schema.ts` artifacts
- Create: `src/artifacts/*`
- Modify: `src/server/routers/artifact.ts`
- Create: `gui/src/renderer/src/artifacts/*`
- Test: artifact/version/provenance tests

- [ ] Step 1: Write failing tests for create, update, version, link, list and provenance traversal.
- [ ] Step 2: Extend artifact persistence with workspace/project/conversation/run and version data.
- [ ] Step 3: Add artifact versions and change summaries.
- [ ] Step 4: Add ArtifactHost and artifact routing.
- [ ] Step 5: Verify provenance survives edits and reruns.
- [ ] Step 6: Commit `feat: add versioned artifact system`.

## Task 9: Markdown/document viewer

**Files:**
- Create: `gui/src/renderer/src/artifacts/DocumentViewer.tsx`
- Create: `gui/src/renderer/src/artifacts/MarkdownViewer.tsx`
- Modify: existing `Markdown.tsx`
- Test: rendering/security tests

- [ ] Step 1: Write tests for headings, links, code, tables, Mermaid fences and raw/rendered toggle.
- [ ] Step 2: Implement sanitized Markdown rendering.
- [ ] Step 3: Add document chrome, TOC and version controls.
- [ ] Step 4: Add open/edit/diff hooks against project files.
- [ ] Step 5: Verify unsafe HTML cannot execute.
- [ ] Step 6: Commit `feat: add polished document viewer`.

## Task 10: Mermaid viewer

**Files:**
- Create: `gui/src/renderer/src/artifacts/MermaidViewer.tsx`
- Extend: ContentRenderer
- Test: Mermaid rendering/failure tests

- [ ] Step 1: Add tests for valid, invalid and empty Mermaid source.
- [ ] Step 2: Implement rendering with safe failure UI.
- [ ] Step 3: Add fullscreen, source toggle, copy/export and node-selection hooks.
- [ ] Step 4: Connect node clicks to Run/Agent inspector.
- [ ] Step 5: Commit `feat: make Mermaid a first-class artifact`.

## Task 11: Visual artifact and dynamic chart protocol

**Files:**
- Create: `src/visuals/*`
- Create: `src/server/routers/visual.ts`
- Create: `gui/src/renderer/src/artifacts/ChartViewer.tsx`
- Test: visual spec and renderer tests

- [ ] Step 1: Write tests for deterministic visual specs, source references and transformations.
- [ ] Step 2: Implement VisualArtifact schema.
- [ ] Step 3: Implement chart viewer with zoom/filter/series toggles where applicable.
- [ ] Step 4: Render chart provenance and data-source details.
- [ ] Step 5: Commit `feat: add interactive visual artifacts`.

## Task 12: File/resource explorer and context inspector

**Files:**
- Create: `src/files/*`
- Create: `src/server/routers/file.ts`
- Create: `gui/src/renderer/src/files/*`
- Extend: `src/context/*`
- Test: context planner + UI tests

- [ ] Step 1: Write tests for pin/exclude, planner selection and context explanations.
- [ ] Step 2: Add project resource registry without copying full file contents into the database.
- [ ] Step 3: Build file explorer with open/preview/ask/include/exclude actions.
- [ ] Step 4: Extend context planner receipts with source and reason metadata.
- [ ] Step 5: Verify explicit exclusions cannot be silently reintroduced except under hard safety/runtime requirements, which are surfaced.
- [ ] Step 6: Commit `feat: add project resources and context inspector`.

## Task 13: Run UX and live organization graph

**Files:**
- Create/modify: `gui/src/renderer/src/runs/*`
- Migrate: `Organization.tsx`
- Extend: existing organization data queries
- Test: GUI run/graph tests

- [ ] Step 1: Add failing tests for root Run → Node tree mapping.
- [ ] Step 2: Build RunView with Conversation/Organization/Decisions/Evidence/Artifacts tabs.
- [ ] Step 3: Implement live organization graph and state transitions.
- [ ] Step 4: Add Agent inspector and contextual right rail.
- [ ] Step 5: Keep legacy Organization functionality reachable during migration.
- [ ] Step 6: Commit `feat: add modern run and organization views`.

## Task 14: Decision Center and universal Why

**Files:**
- Create: `gui/src/renderer/src/runs/DecisionCenter.tsx`
- Create: `gui/src/renderer/src/shared/WhyButton.tsx`
- Extend: decision/event APIs
- Test: decision explanation tests

- [ ] Step 1: Write tests mapping decisions to evidence and alternatives.
- [ ] Step 2: Implement human-readable decision cards.
- [ ] Step 3: Implement WhyButton for node, context, runtime, cost, approval and artifact targets.
- [ ] Step 4: Ensure answers are derived from stored records rather than a fresh model request.
- [ ] Step 5: Commit `feat: add decision center and evidence-backed why`.

## Task 15: Agent roster and agent profiles

**Files:**
- Create: `src/agents/*`
- Create: `src/server/routers/agent.ts`
- Create: `gui/src/renderer/src/agents/*`
- Test: profile/selection policy tests

- [ ] Step 1: Add tests for creating/enabling/disabling profiles.
- [ ] Step 2: Implement profile persistence and capability metadata.
- [ ] Step 3: Add roster UI.
- [ ] Step 4: Add safe System-1 integration point that selects among profiles without bypassing Node contracts.
- [ ] Step 5: Commit `feat: add reusable agent roster`.

## Task 16: Skills

**Files:**
- Create: `src/skills/*`
- Create: `src/server/routers/skill.ts`
- Create: `gui/src/renderer/src/skills/*`
- Test: manifest validation/install/enable tests

- [ ] Step 1: Define and test SkillManifest schema.
- [ ] Step 2: Implement install/list/enable/disable/update persistence.
- [ ] Step 3: Add discovery/installed UI.
- [ ] Step 4: Connect skills to Composer suggestions and runtime context without changing authority.
- [ ] Step 5: Commit `feat: add workspace and project skills`.

## Task 17: Plugins and capability registry

**Files:**
- Create: `src/plugins/*`
- Create: `src/connectors/*`
- Create: `src/server/routers/plugin.ts`
- Create: `src/server/routers/connector.ts`
- Create: GUI management panels
- Test: manifest/permission tests

- [ ] Step 1: Define plugin manifest and connector capability schemas.
- [ ] Step 2: Implement install/remove/enable/disable state.
- [ ] Step 3: Add capability permission review UI.
- [ ] Step 4: Verify plugin/connector state cannot bypass runtime policy.
- [ ] Step 5: Commit `feat: add plugins and connector registry`.

## Task 18: Connector/MCP execution bridge

**Files:**
- Extend connector subsystem and existing adapters/tool infrastructure
- Extend evidence/event capture
- Test: connector authorization/evidence integration

- [ ] Step 1: Add failing test for connector request → policy check → execution → evidence.
- [ ] Step 2: Implement connector invocation envelope.
- [ ] Step 3: Record source/result metadata.
- [ ] Step 4: Add approval flow for privileged connector actions.
- [ ] Step 5: Commit `feat: audit connector actions`.

## Task 19: Memory/Knowledge/Conflict UX

**Files:**
- Extend: existing Memory panel
- Create: Knowledge/Conflict components
- Extend: knowledge/evidence queries
- Test: revision/validation/conflict tests

- [ ] Step 1: Add tests for revision-aware knowledge states and conflict display.
- [ ] Step 2: Build unified Memory/Knowledge surface.
- [ ] Step 3: Add "may be stale" indicators and revalidation actions.
- [ ] Step 4: Add Conflict Center preserving both sides.
- [ ] Step 5: Commit `feat: expose organizational memory and conflicts`.

## Task 20: Activity center and approvals UX

**Files:**
- Create/modify: `gui/src/renderer/src/home/*`
- Extend: approval queries/events
- Test: notification and approval journey tests

- [ ] Step 1: Write tests for needs-you/running/recent sections.
- [ ] Step 2: Build activity aggregation.
- [ ] Step 3: Add approval cards and batch review affordances.
- [ ] Step 4: Preserve existing native Electron notification path.
- [ ] Step 5: Commit `feat: add activity center and approval inbox`.

## Task 21: Scheduling

**Files:**
- Create: `src/scheduling/*`
- Create: `src/server/routers/schedule.ts`
- GUI Scheduled view
- Test: cadence/run creation/policy snapshot tests

- [ ] Step 1: Add deterministic schedule parser/storage tests.
- [ ] Step 2: Implement daemon-owned scheduler with explicit status.
- [ ] Step 3: Create real Runs from scheduled instructions with a mandate snapshot.
- [ ] Step 4: Add pause/resume/run-now/history UI.
- [ ] Step 5: Commit `feat: add scheduled runs`.

## Task 22: Global search and command palette

**Files:**
- Create: `src/search/*`
- Create: `src/server/routers/search.ts`
- Extend: CommandPalette
- Test: ranking/scope/result tests

- [ ] Step 1: Write tests for cross-domain search.
- [ ] Step 2: Implement indexed metadata search and domain adapters.
- [ ] Step 3: Add CommandPalette actions and result previews.
- [ ] Step 4: Verify workspace/project scoping.
- [ ] Step 5: Commit `feat: add global workspace search`.

## Task 23: Git intelligence and provenance-aware diff

**Files:**
- Extend: existing git-state/runtime queries
- Create: GUI source-control components
- Test: diff/agent provenance tests

- [ ] Step 1: Add tests mapping changes to nodes/artifacts/evidence.
- [ ] Step 2: Implement source-control panel.
- [ ] Step 3: Link changed files to runs and agents.
- [ ] Step 4: Add validation status next to diffs.
- [ ] Step 5: Commit `feat: add provenance-aware source control`.

## Task 24: Security boundary tests

**Files:**
- Add cross-cutting tests under `test/security` or existing architecture suite
- Extend: architecture invariants

- [ ] Step 1: Write failing tests that attempt UI-side budget/tool/delegation escalation.
- [ ] Step 2: Verify all such changes are rejected by daemon/runtime authority.
- [ ] Step 3: Test unsafe artifact HTML cannot execute privileged operations.
- [ ] Step 4: Test connector permissions are enforced independently of GUI state.
- [ ] Step 5: Commit `test: codify desktop authority boundaries`.

## Task 25: E2E migration suite

**Files:**
- Create: GUI E2E coverage
- Extend: `test/e2e`

- [ ] Step 1: Add workspace/project/conversation/run journey.
- [ ] Step 2: Add artifact/Markdown/Mermaid/chart journey.
- [ ] Step 3: Add organization/approval/evidence journey.
- [ ] Step 4: Add restart/reconnect journey.
- [ ] Step 5: Add skills/connectors journey using fakes.
- [ ] Step 6: Run full GUI/E2E suite and fix integration regressions.
- [ ] Step 7: Commit `test: add Desktop 2.0 end-to-end coverage`.

## Task 26: Performance and resilience pass

**Files:**
- Extend existing benchmark/instrumentation infrastructure
- Add GUI performance tests where useful

- [ ] Step 1: Measure renderer memory with long conversations.
- [ ] Step 2: Measure chart/Mermaid rendering for large visuals.
- [ ] Step 3: Measure event reconciliation under bursty agent activity.
- [ ] Step 4: Verify large project file listings remain paginated/indexed.
- [ ] Step 5: Verify no full event-log refetch is required for ordinary UI updates.
- [ ] Step 6: Commit `perf: harden Desktop 2.0 under sustained activity`.

## Task 27: Product polish and migration cleanup

**Files:**
- Existing GUI shell/styles/components
- Docs and release notes

- [ ] Step 1: Replace legacy top-level terminology with Workspace/Project/Run terminology.
- [ ] Step 2: Consolidate duplicated panel styles and shared controls.
- [ ] Step 3: Verify loading/empty/error/offline states across all main routes.
- [ ] Step 4: Verify keyboard navigation and accessibility for core workflows.
- [ ] Step 5: Remove superseded UI only after parity tests pass.
- [ ] Step 6: Run `npm run typecheck`, `npm run test:unit`, `npm run test:gui`, and relevant E2E tests.
- [ ] Step 7: Commit `refactor: finish Desktop 2.0 shell migration`.

## Execution gates

After Tasks 1–5:
- Workspace/project/conversation/run lifecycle works without regressions.

After Tasks 6–14:
- One conversation can produce streamed structured content and expose run organization/evidence.

After Tasks 15–18:
- Agent/skill/plugin/connector extensibility is functional but still policy-controlled.

After Tasks 19–23:
- The system becomes an operational workspace rather than only a chat/run viewer.

After Tasks 24–27:
- Authority, resilience, performance, accessibility and migration correctness are verified.

## Required verification commands

At minimum before declaring the branch complete:

```bash
npm run typecheck
npm run test:unit
npm run test:gui
npm run build
npm run gui:build
```

Run integration/E2E/Kubernetes suites when the affected features require them.

## Whole-product acceptance scenario

Start from a clean workspace:

1. Create a Workspace.
2. Create a Project and attach CherryOnTop repository.
3. Start a Conversation.
4. Ask: "Investigate the benchmark regression, show me the architecture, plot cost vs success rate, and produce a report."
5. Verify one natural-language request creates the appropriate Run without requiring a mode toggle.
6. Verify Context Planner records why the relevant files were selected.
7. Verify the organization graph appears while work executes.
8. Verify Mermaid architecture appears as an interactive visual.
9. Verify chart appears as a dynamic artifact with source/provenance.
10. Verify the report opens in the document viewer.
11. Open the Run's Decision Center and inspect delegation/runtime decisions.
12. Ask "Why did you create this agent?" and receive a record-backed answer.
13. Trigger a privileged connector/tool action and approve it.
14. Restart the daemon and reopen the desktop.
15. Verify the Conversation, Run, Artifact versions, evidence and approvals remain coherent.
16. Search for the report, agent and decision through global search.
17. Inspect the final receipt.

Only after this scenario and the required verification commands pass should the migration be considered release-ready.
