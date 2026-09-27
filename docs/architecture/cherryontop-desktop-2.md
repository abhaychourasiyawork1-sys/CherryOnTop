# CherryOnTop Desktop 2.0 — Product & Architecture Specification

**Status:** Design baseline  
**Date:** 2026-09-27  
**Target branch:** `feat/system1-laya-decision-architecture`

## 1. Vision

CherryOnTop Desktop 2.0 is a polished AI workspace and the visual control plane for an accountable AI organization runtime.

The product should feel as simple as a modern AI chat application while retaining the underlying guarantees that differentiate CherryOnTop: explicit authority, System-1 decisions, adaptive orchestration, sandboxed execution, evidence capture, organizational memory, cost controls, replay, validation, and provenance.

The core product promise is:

> One conversation surface for the human; an inspectable organization underneath.

Users interact primarily with Workspace, Project, Conversation, Run, Artifact, File, Skill, Connector, and Agent concepts. The runtime continues to operate with Case, Node, Mandate, Decision, Context, Execution, Validation, Evidence, and Economics concepts.

## 2. Current codebase baseline

The target branch already provides a strong runtime foundation:

- Electron + React desktop GUI.
- React renderer organized around Desk, Cases, Conversation, Organization, Proof, Receipt, Mandates, Memory, Inbox, Inspector, Composer, Markdown and graph panels.
- tRPC between GUI and daemon.
- Persistent daemon so work continues after closing the GUI.
- SQLite + Drizzle persistence for nodes, events, commitments, decisions, artifacts, memory, approvals, mandates, definition-of-done items, knowledge and evidence conflicts.
- Goal-aware context selection and structural context planning.
- Claude/Codex runtime adapters.
- System-1 integration with Laya and a model gateway/protocol layer.
- Spend/turn guards and efficiency accounting.
- Evidence-preserving recovery and replay.
- Markdown rendering using marked and Mermaid dependency already present.
- Electron IPC for approval notifications and receipt export.

The principal gap is not orchestration infrastructure. It is a product/workspace layer that makes the existing runtime as fluid and expressive as a modern AI desktop environment.

## 3. Design principles

### 3.1 Progressive disclosure
Default UI is clean conversation. Orchestration details appear when useful and are always inspectable.

### 3.2 One composer
Do not force users to choose Chat versus Agent versus Cowork versus Organization before asking. Parse intent and route internally.

### 3.3 Structured content, not text-only responses
Messages may contain text, code, Markdown, tables, charts, diagrams, artifacts, files, diffs, timelines, run state and interactive widgets.

### 3.4 Three representations
Every important object has:
1. human representation,
2. machine-readable representation,
3. provenance/evidence representation.

### 3.5 Evidence-backed explanations
"Why?" is a universal product primitive. Decisions, context selection, tool use, cost, agent creation and artifact changes must be explainable from stored evidence.

### 3.6 Local-first, organization-ready
Keep the current daemon/SQLite/local sandbox architecture, while making Workspace and Organization policy inheritance possible.

### 3.7 Preserve runtime invariants
The GUI must never become the authority for permissions, budgets, delegation or execution. UI settings create requested policy; daemon/runtime enforcement remains authoritative.

## 4. Product information architecture

Top-level navigation:

```
Home
Projects
Chats
Artifacts
Runs
Agents
----------------
Skills
Connectors
----------------
Approvals
Memory
Settings
```

Advanced runtime views remain reachable from a Run:

```
Run
├── Conversation
├── Organization
├── Decisions
├── Evidence
├── Files / Context
├── Artifacts
└── Receipt
```

Use "Run" in user-facing UI instead of "Case". Keep Case as an internal domain concept where existing code depends on it.

## 5. Workspace

A Workspace is the durable top-level container.

### Workspace contents

```
Workspace
├── Projects
├── Conversations
├── Shared Files
├── Shared Knowledge
├── Shared Skills
├── Shared Connectors
├── Agent Roster
├── Policies / Mandates
├── Budgets
└── Activity
```

Workspace settings define defaults. They never rewrite historical run contracts.

### Required capabilities

- create, rename, archive workspace
- switch workspace
- workspace-scoped search
- shared context
- shared skills and plugins
- shared connectors
- organization policies
- workspace budget
- workspace activity
- import/export configuration

## 6. Project

A Project is a persistent work context.

```
Project
├── Overview
├── Conversations
├── Files
├── Knowledge
├── Artifacts
├── Skills
├── Connectors
├── Agents
├── Runs
└── Settings
```

A project may reference multiple repositories and folders.

Project context must not mean "send everything every time". It is a searchable, revision-aware context graph consumed by the Context Planner.

## 7. Context Graph

Introduce a logical Context Graph over:

- project files
- repositories
- selected folders
- artifacts
- validated knowledge
- previous run outputs
- conversation summaries
- connected resources
- source metadata

The graph stores relationships such as:

```
imports
references
generated-from
validated-by
supersedes
depends-on
mentioned-in
touched-by
derived-from
```

The planner decides what enters a dispatch.

The GUI must expose:

- Included context
- Excluded context
- Why included
- Source
- Revision
- Approximate token cost
- Planner confidence

A user can explicitly pin or exclude context, but hard runtime limits still apply.

## 8. Conversation

Conversations are the human-facing continuity layer.

Required behavior:

- clean chronological messages
- streaming state
- attachments
- mentions of files/artifacts/runs
- message actions
- branching
- searchable history
- regenerate/follow-up semantics
- linked runs
- linked artifacts
- inline approval cards
- inline progress cards

A conversation may contain multiple runs over time.

## 9. Unified Composer

The composer is always available.

```
[ + ] [Attach] [Context] [Skills] [Tools]       Send
```

Internally classify an input as one of:

- answer-from-context
- answer-from-record
- create/run task
- investigate
- generate artifact
- manipulate existing artifact
- operate on project
- configure workspace
- invoke tool/connector
- request an organization
- schedule recurring work

The existing explicit question parser remains useful, but broaden it into an intent router. Never start a costly run just because a question was ambiguous.

## 10. Runs and organizations

A Run is a user-facing execution session for a goal.

A Run maps to the existing Case + root Node.

The organization graph is assembled dynamically:

```
Goal
  ↓
Context
  ↓
System-1 decision
  ↓
Candidate work decomposition
  ↓
Agent selection
  ↓
Organization
  ↓
Execution
  ↓
Validation
  ↓
Artifacts / Evidence
```

Users can optionally preview the proposed organization before starting.

## 11. Agent roster

Introduce reusable agent profiles.

Agent profile contains:

- id
- display name
- role
- capabilities
- skills
- preferred runtime(s)
- tool policy
- validation policy
- budget policy
- delegation policy
- provenance
- performance statistics

System-1 may choose an agent profile, create a new specialized child, or execute directly.

The roster is a product-level abstraction; actual execution remains backed by Node contracts.

## 12. Mandate inheritance

Policy resolution:

```
Workspace policy
  ↓
Project policy
  ↓
Conversation requested policy
  ↓
Run mandate
  ↓
Node contract
```

The stored Node contract remains the immutable historical authority snapshot.

The GUI should show the effective policy and where each rule came from.

## 13. Skills

Skills are reusable instruction/tool/policy bundles.

Install locations:

- personal
- workspace
- project

Lifecycle:

```
Discover
→ Install
→ Review permissions
→ Enable
→ Use
→ Update
→ Disable
```

Skill manifests should be machine-readable and support:

- instructions
- tools
- assets/templates
- required capabilities
- context hints
- preferred runtimes
- validators
- version
- publisher/provenance
- compatibility

A skill may influence routing but cannot bypass mandate or hard runtime controls.

## 14. Plugins

A Plugin packages multiple extensions:

```
Plugin
├── Skills
├── Connectors
├── Tools
├── Agent definitions
├── Commands
├── Hooks
├── Artifact types
└── Validators
```

Plugins must have:

- manifest
- version
- permissions
- installation scope
- enable/disable state
- provenance
- optional signature/checksum
- compatibility metadata

A future marketplace/discovery UI should support curated and private organization plugins.

## 15. Connectors / MCP

Implement a capability/connector registry.

Initial conceptual groups:

- GitHub/GitLab
- Slack
- Google Drive
- Linear/Jira
- Notion
- databases
- filesystem
- Kubernetes
- cloud providers
- custom MCP servers

Every externally meaningful tool invocation passes through:

```
Request
→ capability authorization
→ mandate/policy check
→ approval check
→ execution
→ event capture
→ result/provenance
```

The connector result must be attachable to the Run and Artifact system.

## 16. Browser and computer capabilities

Desktop capabilities may include:

- browser
- local filesystem
- computer interaction

These are privileged capabilities.

The UI must show:

- capability requested
- scope
- approval state
- active agent
- sandbox/environment
- evidence capture

The GUI must not imply that an action is possible merely because a UI button exists; capability availability comes from the runtime.

## 17. Artifact system

Artifacts are first-class objects opened beside the conversation.

Canonical types:

- document
- Markdown
- code
- HTML
- React
- diagram
- Mermaid
- chart
- dashboard
- table
- spreadsheet
- presentation
- diff
- report
- timeline
- investigation
- runbook

Artifact metadata:

```
id
workspaceId
projectId
conversationId
runId
nodeId
type
title
content/spec
version
createdBy
source
dependencies
permissions
provenance
createdAt
updatedAt
```

Artifacts have version history and provenance links.

## 18. Document / Markdown viewer

Generated Markdown files should open as a clean rendered document, not a raw text dump.

Features:

- rendered/raw toggle
- table of contents
- code highlighting
- Mermaid
- tables
- callouts
- math
- collapsible sections
- internal file links
- edit mode
- version history
- diff against prior version
- open in system editor
- export

The same viewer should power Markdown artifacts and repository Markdown files.

## 19. Mermaid

Mermaid is a first-class visual artifact.

Required interactions:

- zoom
- pan
- fullscreen
- source toggle
- edit
- copy source
- export
- select node
- "Explain this node"
- "Expand this subgraph"
- "Convert to document"

For runtime graphs, clicking an agent/node opens the Node Inspector.

## 20. Dynamic visualizations

Introduce a generic VisualArtifact protocol.

Conceptual schema:

```
VisualArtifact {
  type,
  spec,
  data,
  sourceRefs,
  interactive,
  version,
  provenance
}
```

Supported visuals include:

- line/bar/scatter/area charts
- histogram
- heatmap
- box plot
- candlestick
- network graph
- timelines
- KPI cards
- dashboards
- custom HTML/SVG visuals

Charts should support zoom/filter/series toggles where applicable.

The data source and transformations must be recorded.

## 21. Interactive connector apps

A connector may return a UI surface rather than plain text.

Examples:

- project boards
- analytics dashboards
- issue views
- data tables

The same security boundary applies: the connector app is a tool surface, not an escape hatch from mandate/approval/evidence.

## 22. File Explorer

Project and repository files become first-class navigable objects.

Actions:

- open
- preview
- edit
- compare
- add/remove from context
- ask about file
- trace agents
- trace evidence
- find dependents
- generate documentation
- create artifact

The explorer must show generated artifacts separately from source files.

## 23. Git intelligence

Repository-aware UI should show:

- current branch
- working tree state
- commits
- changed files
- agent ownership/touches
- tests related to change
- artifacts produced
- validation results

Diffs should show provenance such as "changed by Agent #17" and links to the corresponding Run and evidence.

## 24. Memory and Knowledge

Split user-facing concepts:

### Memory
What the organization has learned across work.

### Knowledge
Revision-aware, source-backed claims.

Knowledge views must display:

- repository
- revision
- source paths/symbols
- confidence
- validation
- superseded relationship
- invalidation
- conflicts

The existing `knowledge` schema should be extended, not replaced.

## 25. Conflict center

Evidence conflicts become a visible workflow.

Users can inspect:

- conflicting evidence
- reason
- severity
- affected runs
- sources
- whether resolved
- resolution evidence

Never silently delete the losing evidence.

## 26. Decision Center

A Run should expose a human-readable decision timeline.

Each decision card:

```
Action
Evidence
Breakdown
Selected runtime
Alternative
Budget impact
Confidence/uncertainty
Fallback
```

Advanced users can expand to raw decision payload.

## 27. Universal "Why?" interaction

Any important object should expose "Why?":

- Why this file?
- Why this agent?
- Why this runtime?
- Why delegate?
- Why stop?
- Why ask approval?
- Why this artifact?
- Why this cost?

The response should be evidence-backed and linkable to the underlying record.

## 28. Inbox / Activity Center

Home should surface:

### Needs you
- approvals
- questions
- evidence conflicts
- failed validation
- configuration issues

### Running
- active runs
- agents
- current stage
- spend

### Recently completed
- completed runs
- artifacts
- reports

### Organizational pulse
- success rate
- spend
- active agents
- validation health
- unresolved conflicts

## 29. Scheduling

Introduce Scheduled Runs.

A scheduled run stores:

- name
- goal/instructions
- workspace/project
- mandate
- trigger
- model/runtime preference
- scope
- approval mode
- next execution
- history
- status

Execution is always a real Run with full evidence/provenance.

For the first local-first milestone, support daemon-owned schedules. Later add cloud/external scheduling if product requirements justify it.

## 30. Search and Command Palette

Global search covers:

- workspaces
- projects
- chats
- messages
- files
- artifacts
- runs
- agents
- skills
- connectors
- knowledge
- decisions
- evidence

Command palette `Cmd/Ctrl+K` provides actions over the same objects.

## 31. Desktop shell

The target shell:

```
┌───────────────────────────────────────────────────────────┐
│ Workspace ▾       Search                     ⌘K            │
├──────────────┬───────────────────────────┬────────────────┤
│ Navigation   │ Main content              │ Context rail   │
│              │                           │                │
│ Home         │ Conversation / Artifact   │ Files          │
│ Projects     │ / Run / Dashboard         │ Knowledge      │
│ Chats        │                           │ Skills         │
│ Artifacts    │                           │ Connectors     │
│ Runs         │                           │ Agent details  │
│ Agents       │                           │                │
│              │                           │                │
├──────────────┴───────────────────────────┴────────────────┤
│                       Composer                             │
└───────────────────────────────────────────────────────────┘
```

The right rail is contextual, not permanently overloaded.

## 32. GUI component architecture

Target renderer structure:

```
gui/src/renderer/src/
  app/
  shell/
    Nav
    CommandPalette
    WorkspaceSwitcher
    ContextRail
    Notifications
  home/
  workspaces/
  projects/
  conversations/
  runs/
    RunView
    Organization
    DecisionCenter
    Evidence
    RunInspector
  artifacts/
    ArtifactHost
    DocumentViewer
    MarkdownViewer
    MermaidViewer
    ChartViewer
    HtmlViewer
    DiffViewer
  files/
  agents/
  skills/
  connectors/
  schedules/
  memory/
  shared/
    Composer
    Message
    ContentRenderer
    Provenance
    WhyButton
```

Existing panels should be migrated incrementally. Do not rewrite all renderer code in one step.

## 33. Backend domain architecture

Add logical domains:

```
src/workspace/
src/projects/
src/conversations/
src/artifacts/
src/files/
src/visuals/
src/skills/
src/plugins/
src/connectors/
src/agents/
src/search/
src/scheduling/
```

Retain and integrate:

```
src/context/
src/decision/
src/execution/
src/evidence/
src/efficiency/
src/intelligence/
src/lifecycle/
src/recovery/
src/approvals/
src/system1/
```

## 34. Database model additions

Introduce tables approximately:

### workspaces
id, name, description, settings, status, timestamps

### workspace_members
workspace_id, principal_id, role, timestamps

### projects
id, workspace_id, name, description, settings, status, timestamps

### project_resources
project_id, resource_type, resource_ref, scope, pinned, created_at

### conversations
id, workspace_id, project_id, title, status, created_at, updated_at

### messages
id, conversation_id, run_id, role, content, structured_content, created_at

### runs
id, conversation_id, case_id/node root id, status, goal, mandate snapshot, created_at, updated_at

### artifacts (extend existing)
workspace_id, project_id, conversation_id, run_id, version, mime/type metadata, source/provenance data

### artifact_versions
artifact_id, version, content/spec, created_by, change_summary, created_at

### skills
id, scope, manifest, source, version, enabled, installed_at

### plugins
id, scope, manifest, version, enabled, installed_at

### connectors
id, scope, manifest/config reference, enabled, status, timestamps

### agent_profiles
id, workspace_id, project_id nullable, profile, enabled, timestamps

### schedules
id, workspace_id, project_id, instructions, cadence, mandate_id, status, next_run_at, timestamps

### files/resources index
project-scoped resource metadata for search/context selection

Do not duplicate existing Node authority fields unnecessarily.

## 35. tRPC API surface

Add routers:

- workspace
- project
- conversation
- run
- artifact (extend existing)
- file
- visual
- skill
- plugin
- connector
- agent
- search
- schedule

Existing routers remain authoritative for:

- node
- approval
- decision
- events
- mandate
- memory
- stats
- evidence

Prefer compositional procedures over a monolithic router.

## 36. Streaming/event protocol

The GUI needs a stable presentation event stream.

Minimum event types:

- conversation.message.started
- conversation.message.delta
- conversation.message.completed
- run.started
- run.progress
- run.waiting
- run.completed
- run.failed
- agent.created
- agent.state_changed
- decision.created
- tool.started
- tool.completed
- approval.requested
- approval.resolved
- artifact.created
- artifact.updated
- validation.updated
- knowledge.updated

These are presentation/domain events. Existing persisted evidence events remain the source of truth.

## 37. ContentRenderer

Create one renderer that understands structured blocks.

Example block types:

```
text
markdown
code
table
image
chart
diagram
artifact
file
diff
agent_state
approval
decision
progress
citation
```

This avoids scattered Markdown/HTML handling across individual panels.

## 38. Artifact provenance

Every artifact should be able to answer:

- Which conversation created it?
- Which run?
- Which node?
- Which files/data were used?
- Which tool calls created it?
- Which validation closed it?
- Which version superseded this one?

Provenance must not rely on UI-only metadata.

## 39. Security / sandbox invariants

The following remain hard runtime guarantees:

- UI cannot grant tools directly.
- UI cannot increase budgets beyond authorized policy.
- UI cannot bypass approvals.
- UI cannot make a child inherit a fresh budget.
- External connectors cannot bypass sandbox/capability controls.
- Artifacts cannot execute arbitrary privileged code merely because they render in the GUI.
- Provenance cannot be forged by renderer state.

## 40. UX success criteria

A new user should be able to:

1. create a workspace,
2. create/open a project,
3. attach a repository,
4. ask one natural-language request,
5. observe clean conversation,
6. watch an artifact/diagram/chart appear,
7. inspect organization only when desired,
8. approve a privileged action,
9. reopen the result later,
10. understand why a major decision happened.

A power user should additionally be able to:

- inspect context selection,
- inspect agent graph,
- inspect decisions,
- inspect budgets,
- inspect tool calls,
- inspect evidence,
- replay a run,
- compare versions,
- search organizational memory,
- manage skills/plugins/connectors,
- configure policies and schedules.

## 41. Implementation sequencing

Do not build all features simultaneously.

Recommended waves:

### Wave 1 — Workspace foundation
Workspace, Project, Conversation, Run abstraction, new shell/navigation, persistence.

### Wave 2 — Conversation/content foundation
Unified Composer, Message model, streaming protocol, ContentRenderer, Markdown/document viewer, file explorer.

### Wave 3 — Artifacts/visuals
Artifact v2, versioning, Mermaid, charts, dashboards, provenance.

### Wave 4 — Organization UX
Agent roster, live organization graph, Decision Center, Why interactions, Context Inspector.

### Wave 5 — Extensibility
Skills, plugins, connectors/MCP, capability permissions.

### Wave 6 — Operations
Schedules, activity center, global search, Git intelligence.

### Wave 7 — Organization/enterprise
Workspace members, shared policies, departments, budgets, centralized extension distribution and audit UX.

## 42. Migration strategy

Do not break existing GUI routes while building the new shell.

Phase the transition:

```
Old panel
  ↓
Adapter/view-model
  ↓
New shared domain object
  ↓
New host component
  ↓
Old panel retired
```

The existing Case/Proof/Receipt views should remain accessible until Run views have feature parity.

## 43. Testing strategy

Every feature gets:

- pure unit tests for domain transformations,
- router contract tests,
- GUI component tests where behavior is interactive,
- integration tests for daemon persistence,
- E2E tests for the user journey.

Critical E2E journeys:

1. Create workspace → project → conversation → run.
2. Attach repo → context planner selects relevant files → run records context.
3. Run creates organization → graph updates live.
4. Run produces Markdown → viewer renders.
5. Run produces Mermaid → graph is interactive.
6. Run produces chart → chart renders and provenance is available.
7. Agent requests privileged action → approval card appears → resolution recorded.
8. Artifact edited → version created → provenance preserved.
9. Restart daemon → active run and GUI state recover.
10. Schedule fires → new run created with policy snapshot.
11. Connector call → authorization + evidence + result captured.
12. Why interaction → answer traceable to stored record.
13. Knowledge conflict → conflict center displays both claims.
14. Search returns messages/files/artifacts/runs consistently.

## 44. Non-goals for first release

Do not initially build:

- a full IDE replacement,
- arbitrary remote multi-tenant cloud control plane,
- custom model training,
- a new execution runtime,
- a replacement for Kubernetes sandboxing,
- automatic deletion of old evidence,
- hidden model calls for explanation when the answer can be derived from records.

## 45. Definition of good

CherryOnTop Desktop 2.0 is successful when:

- the default interaction feels like a polished AI workspace rather than an operations console;
- complex work can be handed off without the user choosing an execution mode;
- artifacts and visuals are native objects, not attachments bolted onto chat;
- projects carry useful context without indiscriminate prompt stuffing;
- every major action is traceable to a policy, decision, agent, or evidence;
- an expert can inspect the organization without making the product intimidating to a normal user;
- the existing System-1, context, efficiency, sandbox, validation and evidence architecture remain authoritative;
- the product gains breadth without losing the accountability that defines CherryOnTop.
