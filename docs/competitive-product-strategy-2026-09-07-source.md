# CherryOnTop Product Strategy and Implementation Roadmap

**Audience:** CherryOnTop product and founding team  
**Date:** 7 September 2026  
**Scope:** Current desktop GUI and runtime, compared with mature open-source and enterprise agent/workflow platforms. This is a transferable feature-family comparison, not a claim that every competitor SKU has every capability.

## Executive answer

CherryOnTop should not try to win by cloning a generic drag-and-drop agent canvas. Its defensible core already exists: a recursive organization of agents operates under explicit goals, budgets, tool authority, commitments, human approvals, sandbox boundaries, and accumulated runtime performance evidence. The strategy is to turn that runtime into the **accountable AI organization control plane**.

The near-term product gap is not the organizational graph. It is the surrounding operating system: identity and workspaces, policy-managed connectors and secrets, durable/recoverable runs, searchable operational telemetry, evaluation and feedback loops, versioned releases, and team lifecycle governance. The near-term GUI opportunity is to make the existing accountability record visible as a useful product object: a **Case File** for each task and a **Decision Receipt** for every consequential action.

The positioning to validate is: **Every AI outcome has an owner, a mandate, an authority boundary, evidence, cost, risk status, and a human decision trail.** Do not promise hidden chain-of-thought. Show structured rationale, policies evaluated, tools/data used, artifacts, and approval history instead.

## Current-state audit

The audit was based on the current source tree, specifically `gui/src/renderer/src/App.tsx`, panels, graph components, tRPC routers, lifecycle machinery, execution code, and `USAGE.md`.

### What is already differentiated

- A task is a root goal plus its recursively delegated organization, rather than an isolated chat.
- Every node carries a formal contract: goal, definition of done, tool authority, delegation authority, budget, constraints, and optional deadline.
- The GUI already exposes Conversation, Flow, per-node inspection, live event streaming, task rail, approval inbox, artifacts, decisions, cost/budget health, runtime memory, and cancellation.
- The runtime records append-only events, commitments, decisions, artifacts, approvals, and measured runtime outcomes. It can select Claude Code or Codex and execute in non-root, network-restricted Kubernetes jobs with ephemeral credentials.
- Existing approval UX already shows a reason and the scored decision that crossed an authority boundary. That is a rare, defensible foundation.

### Material gaps before team or enterprise deployment

- The local desktop daemon exposes public procedures on localhost; there is no user identity, workspace/tenant, role model, SSO, service identity, or team collaboration surface.
- “New task” uses a fixed small default authority contract. There are no editable templates, policy profiles, dry-runs, scheduled triggers, workload routing controls, or task/portfolio ownership fields.
- The Flow view is a live hierarchy, not a durable editable design, dependency graph, operational timeline, or execution-replay surface.
- Current auditability is strong at individual run record level but lacks search, trace filtering, normalized tool I/O, system-wide metrics, alerts, export/retention policy, evaluation datasets, and feedback-to-improvement loops.
- There is no connector catalog, MCP/API/webhook framework, policy-scoped secret vault, workflow/source versioning, environment promotion, rollback, or protected production release.
- The existing sandbox posture is useful for local software work but needs organization-wide endpoint allowlists, policy versioning, containment controls, and an accountable identity model for consequential actions.

## Market evidence and implications

### Open-source and developer-first platforms

OpenHands establishes the baseline for repository-first workspaces, per-conversation budgets, sandboxed execution, secrets/MCP configuration, Git integration, and—on Cloud/Enterprise—roles, collaboration, sharing, spend caps, and spend alerts. This makes repository/project context, budgets, and shareability table stakes for coding-agent products. Source: [OpenHands Cloud UI](https://docs.openhands.dev/openhands/usage/cloud/cloud-ui), [roles and permissions](https://docs.openhands.dev/openhands/usage/cloud/organizations/roles-permissions), and [budgets](https://docs.openhands.dev/openhands/usage/cloud/organizations/budgets).

Langflow shows why a visual authoring surface should be paired with a test/playground and safely constrained production runtime. Its editor connects agents, models, data sources, MCP servers, and tools; its Playground exposes tool calls and outputs; and flows can be shared or exposed as MCP tools. CherryOnTop should borrow the testability and interop, not its generic-node metaphor. Sources: [visual editor](https://docs.langflow.org/concepts-overview), [Playground](https://docs.langflow.org/next/concepts-playground), and [MCP server](https://docs.langflow.org/mcp-server).

Flowise demonstrates the value of supervisor/worker delegation, durable checkpoints and resume, tool-level approvals, reviewer-accessible trace links, analytics integrations, workspace isolation, and controlled credential sharing. Its important lesson is durable intervention: an approval must pause the specific action and resume the same work context. Sources: [Agentflow V2](https://docs.flowiseai.com/using-flowise/agentflowv2), [human in the loop](https://docs.flowiseai.com/tutorials/human-in-the-loop), [analytics](https://docs.flowiseai.com/using-flowise/analytics), and [workspaces](https://docs.flowiseai.com/using-flowise/workspaces).

Dify provides a model run-review loop worth adopting: logs expose inputs/outputs, token cost, latency, raw prompts, tool iterations and node traces; team feedback and annotations turn inspected failures into approved responses; runs can be replayed with original parameters; and operational history can be downloaded. Sources: [logs and runs](https://docs.dify.ai/en/cloud/use-dify/monitor/logs), [annotation system](https://docs.dify.ai/en/cloud/use-dify/monitor/annotation-reply), and [member roles](https://docs.dify.ai/en/cloud/use-dify/workspace/team-members-management).

n8n provides version/release mechanics that agents need in production: execution search/retry/replay, workflow history with comparison/restore, protected source-controlled development and production environments, sharing/roles, and security auditing. The key CherryOnTop implication is that each organization and policy must be versioned and a run must identify the exact version that governed it. Sources: [execution history](https://docs.n8n.io/workflows/executions/all-executions/), [workflow history](https://github.com/n8n-io/n8n-docs/blob/main/docs/build/manage-workflows/view-change-history.md), [environments](https://docs.n8n.io/source-control-environments/create-environments/), and [security audit](https://docs.n8n.io/hosting/securing/security-audit/).

### Enterprise platforms

Microsoft Copilot Studio demonstrates the enterprise minimum for environments: data boundaries, security roles, connector policy, development/test/production separation, publishing controls, network isolation, audits, retention, and telemetry. Source: [zoned governance](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/sec-gov-phase2) and [project management guidance](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/sec-gov-intro).

Salesforce Agentforce pairs a builder with a debugging plane: hierarchical agents/actions/data, draft-to-committed versions, interaction details, traces, test previews, batch/multi-turn evaluation, and agent-targeted MCP policy/quotas. Its strongest lesson is to make the lifecycle from design to inspected production evidence one coherent experience. Sources: [Agentforce Builder](https://help.salesforce.com/s/articleView?id=ai.agent_builder_tour.htm&language=en_US), [Testing Center](https://help.salesforce.com/s/articleView?id=005228642&language=en_US&type=1), [Agent Analytics](https://help.salesforce.com/s/articleView?id=ai.generative_ai_agent_analytics.htm&language=en_US), and [MCP policies](https://help.salesforce.com/s/articleView?id=ai.agentforce_gateway_apply_policies_by_agent.htm&language=en_US&type=5).

UiPath offers a useful product pattern: one agent definition supports synchronized Form and Canvas views; the design-time trace lights nodes as they run; breakpoints permit inspection; and the workspace holds history, evaluations, deployment configuration, contexts, tools, and human escalations. Source: [Studio Web Agent Builder](https://docs.uipath.com/agents/automation-cloud/latest/user-guide/building-an-agent-in-studio-web).

ServiceNow validates the “organization” frame, but the product gap remains: its central orchestrator coordinates agents and can select agents dynamically, execute tools in parallel, and attribute tool actions and approvals to the logged-in user. CherryOnTop can be more legible by making the agent’s charter and accountability chain the center of the experience. Source: [AI Agent Orchestrator](https://www.servicenow.com/docs/r/intelligent-experiences/understand-na-aia.html).

IBM watsonx Orchestrate distinguishes free-form agent reasoning from deterministic workflow branches, state, parallelism, long-running activities and human-in-the-loop. This supports CherryOnTop’s recommended hybrid model: use autonomous reasoning inside explicit, versioned, reviewable operating lanes. Sources: [agent orchestration](https://www.ibm.com/docs/en/watsonx/watson-orchestrate/base?topic=agents-adding-orchestration) and [agentic workflows](https://www.ibm.com/docs/en/watsonx/watson-orchestrate/base?topic=tools-agentic-workflows).

LangSmith adds a complementary quality expectation: offline test sets and online evaluations/monitoring, with the production failures feeding the next evaluation dataset. Source: [evaluation](https://docs.langchain.com/langsmith/evaluation) and [platform setup](https://docs.langchain.com/langsmith/platform-setup).

## Product principles

1. **Organization, not canvas.** The primary object is an accountable organization that performs work. A visual graph exists to explain roles, delegation, dependencies, and authority—not to make users draw boxes.
2. **Case File before chat.** A task view should put objective, owner, current state, risk, expected outcome, budget, approvals, proof, and next required human action above the transcript.
3. **Authority is a user-facing product primitive.** Every agent card and approval must answer: who authorized this, what can it access, how much can it spend, what data/tool scope applies, what changes at this boundary, and how can it be stopped.
4. **Evidence, not opaque reasoning.** Provide structured decision inputs/outputs, policy results, tool I/O metadata, artifacts, tests, sources, and human interventions. Do not expose private model reasoning or call it an audit trail.
5. **One definition, several useful views.** Keep the existing live hierarchy; add synchronized Case File, Timeline/Trace, Plan/Policy, and Evidence views over the same event and contract model.
6. **Autonomy is graduated.** Each task moves through Observe, Guided, Delegated, and Autonomous operating modes. Moving mode must show an authority/policy diff and record the named human approver.

## Differentiated GUI proposal

### Primary navigation

- **Portfolio:** project/workspace health, active cases, approval queue, risk/quality/cost trends, and attention-required work.
- **Cases:** the current task list, upgraded from a rail to searchable work cases with owners, SLA, policy profile, environment, and health.
- **Organization:** the existing Flow view, upgraded with role cards, live activity, dependency edges, authority overlays, workload, and drill-down details.
- **Proof:** an evidence ledger and timeline that filter every delegation, decision, tool call, artifact, approval, policy evaluation, test, and result.
- **Blueprints:** templates and versioned organization/policy definitions; form-first, with an optional graph preview.
- **Govern:** people, workspaces, identities, connectors, secrets, policy bundles, environments, release approvals, and audit exports.

### The Decision Receipt

For every consequential delegation, tool use, budget expansion, release, or failure, give users one compact, shareable receipt: objective; accountable agent and human owner; input/context classes; decision and alternatives; policy/authority evaluated; tools/data accessed; change or artifact; evidence/quality result; cost/latency; approval or exception; and links to the exact event and organization version. This is the core UX and marketing object.

### Marketing that follows the product

- Lead with “AI teams you can hold accountable,” not “autonomous agents.”
- Demonstrate an end-to-end before/after Decision Receipt in the product tour.
- Use “proof of work” as the value proposition for engineering leaders, compliance, operations, and founders who are not willing to trust a chat transcript.
- Publish transparent modes and limits: what is local, what is retained, which identity was used, which model/tool acted, and when a person had to decide.
- Do not claim zero risk, perfect audits, or model reasoning visibility. Credibility comes from explicit boundaries and reliable evidence.

## Implementation sequence

This is dependency order, not a calendar estimate; staff it in vertical slices and do not begin a multi-tenant launch without the identity/policy foundation.

### Phase 0  Establish the control-plane contract

Create Workspace, Project, Environment, User/ServiceIdentity, PolicyBundle, Connector, SecretReference, OrganizationVersion, Case, Run, TraceSpan, Approval, EvaluationSet, EvaluationRun, and Feedback data contracts. Add actor identity and policy/version IDs to every event, approval and artifact. Introduce a migration path from local SQLite to Postgres/object storage while retaining local-first single-user mode. Define an explicit lifecycle: draft, test, approved, released, suspended, retired. Acceptance: every run can be reconstructed to its exact organization/policy/runtime/connector version and actor.

### Phase 1  Make accountability visible in the existing GUI

Turn the task page into a Case File. Add a task creation form with template, project/repository, desired outcome, success checks, owner, risk/autonomy profile, budget/deadline, and selected environment. Add the Decision Receipt and filtered Proof timeline. Upgrade the organization graph with user-readable roles, contract summary, live activity, authority overlay, risk state, dependencies, and persistent tooltips. Make artifacts and evidence clickable/deep-linkable. Add pause/resume/cancel and retry/replay only where the execution state guarantees it is safe. Acceptance: a nontechnical stakeholder can answer what happened, who owned it, why it was permitted, what changed, and what needs attention without reading raw logs.

### Phase 2  Workspace, identity, policy, and approval controls

Add workspaces, project membership, RBAC, named human ownership, service identities, and eventual SSO/SCIM. Build a policy engine for tool/connector allowlists, data classes, model/runtime restrictions, max spend/concurrency, required approvals, execution mode, retention, and egress endpoints. Create scoped secret references and a connector registry; never place long-lived secret values in the event stream. Extend approval with decision-specific and tool-specific requests, delegated approvers, expiry/SLA, comment/reason, escalation, and immutable resolution history. Acceptance: two projects can use separate people, secrets, policies, evidence retention and tool boundaries; a policy simulator explains allow/deny before a run starts.

### Phase 3  Durable operations and observability

Normalize a trace schema around Run -> AgentAttempt -> Decision -> ToolCall -> Artifact -> Evaluation -> Approval. Persist checkpointed work state so a human or external wait can resume safely after restart. Add trace search/filters, duration/cost/error breakdowns, tool I/O metadata with redaction, run comparison, outcome taxonomy, alerts, budget forecasts, concurrency queue, and one-click evidence export. Emit OpenTelemetry-compatible telemetry at boundaries. Acceptance: an operator can isolate a failure by policy, tool, runtime, model, connector, organization version, customer/project, or error class and replay a safe diagnostic run.

### Phase 4  Quality, releases, and controlled autonomy

Add test inputs, evaluation datasets, structured expected outcomes, policy/safety checks, artifact/test verification, human review, and scorecards. Let annotations and incidents produce candidate tests or playbook changes, never automatic production policy changes. Support drafts, immutable released versions, diffs, protected promotion, environment-aware configuration, rollback, and a per-case “autonomy mode” change with approval. Acceptance: a release cannot enter production without its required quality/policy gate, and every production run names its immutable version.

### Phase 5  Interoperability and collaboration

Deliver a versioned connector/tool catalog (MCP, GitHub/GitLab, issue tracking, chat, CI, storage, webhooks/API) with owner, scope, health, schema, quota, and policy. Start with GitHub/GitLab, Jira/Linear, Slack/Teams, generic webhook, and MCP because they support the intended software/operations motion. Add shareable read-only Case/Receipt links, comment/mention subscriptions, Slack/Teams approval actions, notifications, report exports, and APIs. Acceptance: connector health/deprecation and a changed permission scope are visible before they affect a release or run.

### Phase 6  Enterprise hardening and scale

Add SSO/SCIM, tenant/domain isolation, audit retention/hold/export, data residency choices, BYOK/secret-provider integrations, endpoint-level network policy, environment-specific deployment, enterprise deployment topology, quotas, rate limits, security posture reports, and administrator readiness checks. Acceptance: a security review can obtain a complete case export and demonstrate least privilege from person to agent to tool to data to network endpoint.

## Priority calls

**Build now:** Case File, Decision Receipt, evidence links/timeline, templates and task-authoring form, policy metadata in events, safe pause/retry/replay primitives, budget/queue visibility, workspace/role data model.

**Build next:** Policy simulation and enforcement, connector/secret registry, durable checkpoints, trace explorer, operational dashboards, evaluation/feedback, version/release mechanics.

**Build once foundation is credible:** full visual blueprint editor, broad connector marketplace, SaaS multitenancy, SSO/SCIM, advanced compliance/residency, and general-purpose workflow canvas.

**Do not copy:** an unconstrained drag-and-drop canvas as the core product; hundreds of shallow connectors before policy/ownership; freeform production editing without version/promotion gates; or opaque “AI audit” claims based on raw model reasoning.

## Success measures

- Time to answer a stakeholder’s “what happened and why?” question from the GUI.
- Percentage of consequential actions with a complete Decision Receipt and linked evidence.
- Approval response time, escalation rate, and prevented out-of-policy actions.
- Completed-case success rate, verified-definition-of-done rate, replay/retry recovery rate, and human rework rate.
- Cost/latency/success by organization version, runtime/model, tool/connector, template, risk mode, and project.
- Evaluation coverage before release; regression rate after release; feedback-to-test conversion rate.
- Policy coverage: runs with named owner, identity, environment, policy, version, tool/data scope, and retention classification.

## Limitations and stopping rationale

This research used the current CherryOnTop source tree and current public first-party documentation as of 7 September 2026. Availability varies by edition, tenancy, and preview status. The findings cover the highest-value transferable feature families rather than every connector or SKU detail. Research stopped after independent sources converged on the same control-plane, observability, release, and governance needs; additional broad searches were repeating evidence rather than changing the roadmap.
