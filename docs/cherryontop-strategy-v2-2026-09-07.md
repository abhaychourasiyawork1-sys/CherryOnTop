# CherryOnTop Strategy v2 — Competitive Teardown, IP Thesis, and GUI Reform

**Supersedes:** `competitive-product-strategy-2026-09-07-source.md` (v1)
**Date:** 7 September 2026
**Target buyer for the next build cycle:** solo developer and small engineering team, local-first (Electron desktop + local daemon + `kind` cluster). Enterprise families are catalogued but deliberately deferred.
**Method:** direct read of the current source tree (`gui/src/renderer/**`, `src/engines`, `src/lifecycle`, `src/db`, `src/server/routers`) plus live vendor/practitioner research current to September 2026.

---

## 0. What v1 got right, and what it missed

v1's core call is correct and I am not relitigating it: **do not build a generic drag-and-drop agent canvas.** The recursive accountable organization is the asset. The Case File and Decision Receipt are the right product objects.

But v1 has four problems that this document fixes.

**It graded the runtime too generously.** v1 says "every node carries a formal contract: goal, definition of done, tool authority, delegation authority, budget, constraints." Two of those are not real yet. Verified in the tree:

- `authority.tools` is referenced in exactly one place — [src/engines/authority.ts:14](src/engines/authority.ts:14) — where a child's requested tools are intersected with the parent's grant. It is **never consulted at the tool-call boundary**. Nothing stops a sandbox from using a tool its contract does not list.
- `contract.constraints` is written by [node-contract.ts:19](src/schemas/node-contract.ts:19) and read by nothing. Zero enforcement sites. It is a display string.
- Budget *is* real (economics + approvals gate it). Delegation authority *is* real (`max_child_count`, `spawn_children`). Those two carry the whole claim right now.

This matters more than any competitive gap in the document. The entire positioning — "every AI outcome has an authority boundary" — is currently half-true. **Making the contract enforced is higher priority than every feature v1 listed**, because it is the difference between a marketing claim and a product.

**It missed durability entirely.** v1's Phase 3 mentions checkpoints as a mid-roadmap item. In reality [src/lifecycle/orphans.ts:51](src/lifecycle/orphans.ts:51) tells the user, verbatim: *"The daemon restarted while this was running, so it stopped where it was. Start the task again to pick it up."* And [src/server/routers/node.ts:126](src/server/routers/node.ts:126) refuses an approval whose node did not survive a restart. Actors live only in daemon memory ([node-actor-manager.ts:34](src/lifecycle/node-actor-manager.ts:34) even carries a `ponytail:` marker naming event-log rehydration as the upgrade path). For a product whose pitch is a *durable record of accountable work*, losing the work on a process restart is the most damaging possible defect. Durable execution is now the single loudest procurement signal in the market — the phrase circulating in 2026 enterprise agent rollouts is literally *"durable by default or do not ship."*

**It missed the whole coding-agent competitive set.** v1 benchmarks against Langflow, Flowise, Dify, n8n, Copilot Studio, Agentforce, UiPath, ServiceNow, watsonx. Those are workflow/CX platforms. CherryOnTop dispatches Claude Code and Codex into sandboxes against a git repository. Its actual rivals are Devin, Cursor, Factory, OpenHands, and Claude Code itself — and *those* products set the table stakes a user will judge us against on day one.

**It missed the layer where our IP is now market-validated.** The 2026 non-human-identity literature converged on a requirement we already half-implement and nobody in the coding-agent space ships as UX: *constrained delegation, where sub-agents can only receive permissions the parent already holds, with the full delegation chain carried in every credential so audit trails link ephemeral sub-agent actions back through the orchestrator to the authorizing human principal.* That is [src/engines/authority.ts](src/engines/authority.ts) described by a security analyst who has never seen our code. We should stop treating it as plumbing and make it the product.

---

## 1. Verified current state

### The real assets (things no competitor has)

| Asset | Where | Why it is rare |
|---|---|---|
| Scalar, printable delegation economics | [economics.ts](src/engines/economics.ts) — `value − (model + latency + coordination + verification) − risk ≥ threshold` | Every competitor's "why did it delegate" is an LLM rationalization. Ours is arithmetic with named terms. It is inspectable, reproducible, and **counterfactual-capable**. |
| Monotone authority narrowing | [authority.ts:14](src/engines/authority.ts:14) | A child can never hold more than its parent. This is the constrained-delegation property 2026 identity vendors are selling as a roadmap item. |
| Approval fired *at the authority boundary*, carrying the score that crossed it | [approval router](src/server/routers/approval.ts), [Inbox.tsx](gui/src/renderer/src/panels/Inbox.tsx) | Everyone else's HITL is "tool X is on the risky list, ask first." Ours is "this agent's economics exceeded its mandate, here is the ledger." |
| Runtime selection as a *scored, recorded* decision | [decision.ts](src/schemas/decision.ts) `runtime_selection` | Claude Code vs Codex chosen by measured evidence, and the choice is auditable in the same view as delegation. |
| Measured organizational memory | `memory` table `run_outcome` rows → `getRuntimeStats` | Devin's Knowledge and OpenHands' microagents are *authored*. Ours is *earned* from outcomes, with sample counts and confidence. |
| Per-node hard isolation | [k8s/client.ts](src/k8s/client.ts), non-root, network-restricted Job per node, ephemeral credentials from [credentials.ts](src/execution/credentials.ts) | Stronger default containment than Devin/Cursor/Factory cloud sandboxes expose to the user. |
| Answers from the record, not a model | [intelligence/ask.ts](src/intelligence/ask.ts), wired into the single composer | "Why did this cost $4?" answered deterministically. Uncopyable by anyone whose record is a chat transcript. |

### The real defects

| Defect | Evidence | Severity |
|---|---|---|
| Runs die on daemon restart; approvals become unresolvable | [orphans.ts:51](src/lifecycle/orphans.ts:51), [node.ts:126](src/server/routers/node.ts:126), [node-actor-manager.ts:34](src/lifecycle/node-actor-manager.ts:34) | **Critical** |
| `authority.tools` never enforced at execution | only site is the delegation intersection | **Critical** — invalidates the pitch |
| `contract.constraints` read by nothing | grep: zero consumers | **High** |
| No connector/MCP layer at all | grep `mcp` across `src/`: zero hits | **High** — MCP is the 2026 interop floor |
| Fixed default mandate on task creation | [App.tsx](gui/src/renderer/src/App.tsx) hardcodes `max_child_count: 3, budget_usd: 5, tools: []` | **High** — the mandate is the product and the user cannot set it |
| No run list, no search, no cross-task view | Rail is a flat task list; no filters, no history beyond it | **High** |
| No git surface — no diff review, branch, commit, or PR | artifacts record paths and summaries only | **High** for the coding-agent buyer |
| No retry / replay / fork | terminal is terminal | **Medium-High** |
| Event log is not tamper-evident | `events` table has no hash chain | **Medium** — but cheap to fix and worth a lot |
| No scheduling, no headless API trigger | CLI + GUI only | **Medium** |
| No evaluation or feedback loop | no test sets, no annotations, no scorecards | **Medium** |

---

## 2. Expanded competitive landscape (September 2026)

v1's ten platforms are still valid evidence and I am not repeating them. These are the sets it missed or under-read.

### 2a. Direct rivals — coding agents (this is who we are actually judged against)

**Devin / Cognition.** The most complete accountability-adjacent UX in the category. 2026 brought a redesigned session page with **session hierarchy built into the header**, a **nested sub-Devin session tree**, filterable session sidebar, and the ability to **follow and view other people's sessions**. Its Advanced Capabilities layer lets a Devin orchestrate managed Devins in parallel, *analyze past sessions*, and *create and improve playbooks* from them. Knowledge is a cross-session store of tips and conventions Devin recalls automatically; Playbooks are procedures attached per session class, from a team or community library, or dropped in as a `.devin.md`.
**Forces on us:** (a) a nested-session tree is now table stakes — our Flow view must be at least as legible; (b) **the org has to learn**, and Devin's learning is authored while ours is measured — that is our wedge, not our gap; (c) *following* someone else's run is a real collaboration primitive we have no answer for.

**Cursor 3 (April 2026).** Shipped an **Agents Window** for orchestrating multiple agents in parallel, plus Design Mode and Composer 2. Teams get split usage pools, rebuilt spend alerting, and a usage dashboard showing proximity to each limit. Background agents run cloud-side.
**Forces on us:** parallel-agent management is a *first-class window*, not a tab. And note the framing gap we can exploit: Cursor ships **spend alerting**; we ship **spend enforcement**. Practitioner analysis in 2026 is blunt that the two are not the same — "budget enforcement is the layer that refuses the next API call; dashboards, alerts, and provider-level caps are observability, not enforcement." We are on the correct side of that line and are not saying so.

**Factory (Droids).** $150M Series C, deployed at Nvidia, Adobe, EY, Palo Alto Networks, Adyen. Architecturally the closest to us: **a coordinator agent that decomposes work and dispatches to specialized droids — code, review, docs, test, Knowledge — with explicit role boundaries rather than one generalist.** Enterprise tier adds audit logging, on-prem, admin controls, SOC 2 Type II.
**Forces on us:** the "organization of specialized agents" frame is *taken* at the pitch level. Our differentiation cannot be "we have multiple agents." It must be **the mandate, the ledger, and the enforcement** — the parts Factory buys separately as a governance layer. The most quoted line from 2026 Factory analysis is that enterprise budgets split into "the compliance-heavy execution layer, then build or buy the coordination layer that governs it." **We are the coordination layer.** That is the sentence our positioning should be built around.

**OpenHands.** Local-first with an Agent Canvas for parallel runs in one view; extends to VM/Cloud/self-hosted. Enterprise Agent Control Plane adds RBAC, SSO, audit logs, budgets, cost attribution, customer-VPC deployment. **Microagents** carry repo-specific and task-specific knowledge. Headless mode allows programmatic task submission via REST.
**Forces on us:** local-first + parallel canvas + repo-scoped knowledge + headless API is the floor for our exact buyer. We have local-first and nothing else on that list.

**Claude Code (2026 desktop).** Sidebar for multiple workstreams, visual diff review, integrated terminal, live app preview, GitHub PR monitoring with auto-merge, parallel sessions in separate git worktrees. Team/Enterprise get an analytics dashboard, SCIM, and per-team spend limits.
**Forces on us:** we dispatch Claude Code but offer *less* git surface than Claude Code does natively. A user who has seen visual diff review and worktree-parallel sessions will find our Evidence tab — a list of file paths — thin. **Worktree-parallel sessions are also the honest local answer to "parallel agents", and it is a pattern we can adopt directly.**

### 2b. Hyperscaler control planes (they define the vocabulary buyers will use)

**AWS Bedrock AgentCore** (GA Oct 2025, expanded through 2026). Decomposed into Runtime (8-hour execution windows, complete session isolation, A2A protocol), Memory (short- and long-term, self-managed extraction pipelines), Gateway (turns APIs/Lambdas/**existing MCP servers** into agent tools, with IAM *and* OAuth authorization), Identity (**identity-aware authorization, secure vault for refresh tokens**, agents acting on behalf of users or themselves), and Observability (OTEL-compatible, exports to CloudWatch, Datadog, Dynatrace, LangSmith, Langfuse).
**Forces on us:** AgentCore has taught the market the five-noun decomposition — **Runtime / Memory / Gateway / Identity / Observability**. Buyers will ask which of the five we have. We have Runtime and a primitive Memory. Emitting **OTEL spans at our boundaries** is cheap and instantly legible.

**Microsoft Agent 365** (GA May 2026). Explicitly "the control plane to observe, secure, and govern AI agents." Its centrepiece is an **agent registry — a unified inventory of every agent in the org, Microsoft and non-Microsoft** — anchored on **Entra Agent ID**, which gives each agent its own identity. It now syncs its registry with Amazon Bedrock and Google Cloud for cross-platform governance.
**Forces on us:** "control plane for agents" is now a Microsoft-owned phrase. v1's proposed positioning — "accountable AI organization control plane" — will read as a Microsoft me-too in 2026. **Change the noun.** We are not a registry of agents that exist; we are a **record of work that was authorized**. Positioning should move from *control plane* to *accountability record* / *proof of work*.

**Google (Gemini Enterprise Agent Platform).** Vertex AI rebranded and merged with Agentspace at Cloud Next 2026. Agent Engine **Sessions and Memory Bank now GA and metered since Jan 2026**. Most relevant: **semantic governance policies in Preview — a policy engine that evaluates an agent's proposed tool calls against user intent and organizational rules at runtime.**
**Forces on us:** runtime policy evaluation *of the proposed tool call* is precisely the enforcement point where our `authority.tools` currently does nothing. Google is shipping the interception; we already have the contract that should drive it. Closing that gap is a one-file change conceptually and the highest-value thing on this entire roadmap.

**OpenAI AgentKit.** Shipped a centralized **Connector Registry** — one pane for admins to govern how agents reach SharePoint, Teams, Drive. Notably, **OpenAI is winding down Agent Builder and Evals; both are gone from the platform after 30 November 2026**, with the Agents SDK recommended for anything that should live as code.
**Forces on us:** this is the strongest external validation of v1's "do not build the canvas" call — the largest player in the market tried the visual builder and is retiring it inside a year. Cite it. It also means **connector *governance* outlived the connector *builder***: the registry survives, the canvas does not.

### 2c. Durable execution (the family v1 omitted)

**Temporal, Inngest, DBOS, Restate, AWS Durable Functions, Cloudflare Workflows, Vercel Workflow DevKit** — durable execution crossed into the early majority in late 2025 and is now assumed. Workflows wait minutes, hours, or days for a signal — *a human approval*, a webhook, an external event — without holding a thread. On crash recovery a workflow **replays from event history and does not re-ask the model for decisions it already made**; it reads them back out of the log.

**Forces on us:** this is the exact architecture our defect needs, and we are unusually well positioned for it — we already have an append-only `events` table that *is* an event history. The fix for [orphans.ts](src/lifecycle/orphans.ts) is not new infrastructure; it is rehydrating actors from the log we already keep, which the code's own `ponytail:` marker already says. **A pending approval must survive a restart. Today it does not, and that is the bug that would kill a trial.**

### 2d. Governance and identity (why our IP is timely)

**Regulatory.** EU AI Act **Article 12** requires high-risk systems to *automatically* record events across their lifetime — manual documentation explicitly does not satisfy it — and deployers must retain logs at least six months. ISO/IEC 42001 demands a *dynamic audit ledger*, not static snapshots. NIST AI RMF (Govern/Map/Measure/Manage) is voluntary but is what auditors read. Critically: **none of the three was designed for agentic AI**; Singapore's January 2026 framework is the only major document addressing autonomous agents directly, and the named gaps are **cascading failures, scope creep, and attribution gaps.**

Read that list again. Cascading failure, scope creep, attribution. Those are the three things a recursive delegation tree with monotone authority narrowing and a per-node budget is *structurally* built to prevent. **We should say so explicitly, in those words, because they are the regulator's words.**

**Identity.** The 2026 consensus: no standing credentials, no unscoped tokens, no shared secrets across agents; SPIFFE/WIMSE for workload identity; **constrained delegation where sub-agents receive only permissions the parent holds, with the full delegation chain in every token so audit trails link ephemeral sub-agent actions back through the orchestrator to the authorizing human principal.**

We implement the *semantics* of this already and expose none of it. Our per-node ephemeral credentials ([credentials.ts](src/execution/credentials.ts)) plus monotone narrowing plus the parent/child edge *is* a delegation chain. It just has no name, no UI, and no place on any receipt.

### 2e. UX research (what "transparent" is supposed to look like in 2026)

Practitioner and academic work converged this year on three patterns worth stealing directly:
- **Provenance in the primary loop**, not behind a link — the source of a claim visible where the claim is.
- **"Show work" / receipt** — a persistent audit trail with an interaction that replays the decision logic, described as "the ultimate safety net, allowing the user to spot-check the validity of the output."
- **Editable memory with visible provenance and reversible personalization** — the user must be able to see *why* the system behaves as it does and override it.

The third is a direct instruction for our Memory panel, which currently displays learned outcomes with no way to inspect their basis or veto them.

---

## 3. Feature-family gap matrix

Scored for the chosen buyer (solo / small team, local-first). "Verdict" is what we do about it, not what the market has.

| # | Family | Best-in-class reference | CherryOnTop today | Verdict |
|---|---|---|---|---|
| 1 | **Durable runs / crash resume** | Temporal, LangGraph checkpointers, Flowise, n8n retry-from-node | Runs die on restart; approvals become dead | **Fix first.** P0 |
| 2 | **Enforced tool authority** | Google semantic governance policies; AgentCore Gateway | Declared, intersected at delegation, never enforced | **Fix first.** P0 — it is the pitch |
| 3 | **Editable mandate at task creation** | OpenHands per-conversation budgets; UiPath Form+Canvas | Hardcoded `$5 / 3 children / no tools` | P0 |
| 4 | **Repo/project + git surface** | Claude Code diff review + worktrees; OpenHands repo workspaces | Repo mounted; no diff, branch, commit, or PR | P1 |
| 5 | **Parallel run management** | Cursor Agents Window; Devin 10 concurrent; OpenHands Agent Canvas | Single flat task rail | P1 |
| 6 | **Run history, search, filter** | n8n executions; Dify logs; LangSmith traces | None | P1 |
| 7 | **Retry / replay / fork** | n8n replay-from-failed-node; Dify replay with original params | None | P1 |
| 8 | **Org knowledge / playbooks** | Devin Knowledge + Playbooks; OpenHands microagents; `CLAUDE.md` | Measured `run_outcome` memory only; not editable, not authorable | P1 — **and our version is better if we surface it** |
| 9 | **Connectors / MCP** | AgentCore Gateway; AgentKit Connector Registry; Langflow MCP | Zero | P2 (MCP client only; skip the marketplace) |
| 10 | **Cost analytics** | Cursor usage dashboard; n8n Insights; LangSmith unified cost | Per-node meter only; no rollups, no trend | P2 |
| 11 | **Evals / feedback loop** | LangSmith online evals; Dify annotations | None | P2 |
| 12 | **Tamper-evident log / export** | EU AI Act Art. 12; ISO 42001 dynamic ledger | Append-only but unchained, no export | P2 — cheap, high marketing value |
| 13 | **Scheduling / headless API** | OpenHands headless REST; n8n triggers | None | P3 |
| 14 | **Identity, RBAC, SSO, tenancy** | Agent 365 + Entra Agent ID; OpenHands Enterprise | None | **Deferred** — wrong buyer |
| 15 | **Versioned releases / promotion** | n8n environments; Agentforce draft→committed | None | **Deferred** |
| 16 | **Sharing / following runs** | Devin follow-sessions; Flowise trace links | None | P2 as *file export*, not a server |

---

## 4. The IP thesis — eleven things only we can build

These are not competitive catch-up. Each is downstream of something already in the tree, and each is hard for a rival to copy because they lack the underlying primitive.

**1. The Chain of Custody.**
Every artifact, decision, and tool call renders a single strip: `you → root(goal) → node(goal) → tool`, each hop showing what authority was granted and what was narrowed. Downstream of [authority.ts](src/engines/authority.ts) plus the parent edge. This is the thing the identity industry is writing whitepapers about and shipping as roadmap. We can render it this quarter. **No coding agent has it.**

**2. The Mandate — a first-class, editable, diffable object.**
Promote `NodeContract` from a hidden default to the thing you author before you run. Goal, definition of done, budget, delegation depth, allowed tools, constraints, deadline. Saved as named **mandate templates** ("read-only investigation", "test-writing, $2, no delegation", "refactor, $20, 5 children"). Every run names the mandate it ran under, and two runs can be diffed by mandate.

**3. The Authority Simulator (pre-flight dry run).**
Before spending a cent: *"Under this mandate the organization may spawn ≤3 agents, spend ≤$5.00, use Read/Write/Bash, and may not reach the network. It will stop and ask you if it needs to exceed $5.00 or delegate a 4th time."* Pure function of the contract — no model call, no execution. Directly answers Google's semantic-governance framing, without the model.

**4. The counterfactual "why not".**
`economics.ts` yields score vs threshold with named terms. So we can render what nobody else can: *"Delegating scored +0.42 against a threshold of +0.30. Had verification cost been $0.13 higher, it would have done the work itself."* This is the sentence that proves the reasoning is arithmetic and not theatre. It is impossible for any competitor whose "why" is an LLM paragraph.

**5. Budgets that stop, said out loud.**
We already refuse and escalate at the budget boundary. The market distinguishes sharply between spend *alerting* (Cursor, most vendors) and spend *enforcement*. Make the enforcement visible: a reservation-vs-actual view, a burn treemap over the org tree showing which branch consumed the money, and an explicit "raise the ceiling" approval carrying the economics that justify it.

**6. Verified Definition of Done.**
`definition_of_done` is an array of strings today, rendered as a bullet list. Make each item a row with a state (met / unmet / unverified) and a link to the artifact or command output that closed it. This converts "commitment closed" from a status into a checkable receipt — and it is the literal mechanism behind the phrase "proof of work."

**7. Earned Memory, with its receipts.**
`run_outcome` rows already calibrate runtime selection. Surface them as claims with evidence: *"Codex completed test-writing tasks at 0.6× the cost of Claude Code across 23 runs (confidence 0.71). [see the runs]"* — with a veto. Devin's Knowledge is authored opinion; ours is measured evidence with an n. Per the 2026 UX consensus, editable memory with visible provenance is the pattern; we are one panel away from being the best example of it in the category.

**8. Time-travel over the organization.**
`events` is append-only and timestamped. Add a scrubber to the Flow view and the whole org chart animates through its own history — nodes appearing, budgets draining, approvals blocking, edges thickening with delegated money. Cheap to build on data we already store. It is also the single best thing we could put in a launch video.

**9. Tamper-evident by construction.**
One column: `events.prevHash`, each row hashing the previous. One export: a signed, self-contained bundle. Satisfies the *spirit* of EU AI Act Art. 12 automatic logging, and lets us say "the record cannot be edited after the fact" — a claim no chat-transcript competitor can make. Small diff, disproportionate credibility. (Claim tamper-*evidence*, never "tamper-proof.")

**10. The Case Receipt as a file, not a URL.**
v1 wanted shareable links, which implies a server, auth, and tenancy — all deferred. The local-first version is better and ships now: **export one self-contained HTML file** containing the goal, mandate, chain of custody, decisions with breakdowns, DoD verification, artifacts, approvals with named human and timestamp, cost, and the hash chain. Attachable to a PR, an email, a compliance ticket. Zero infrastructure.

**11. Replay and fork.**
Re-run a completed node under a different mandate or runtime and diff the outcomes — cost, duration, evidence, DoD met. Because decisions are recorded with numeric breakdowns, the diff is quantitative, not vibes. This is n8n's replay plus LangSmith's comparison, in a shape neither can offer because neither has a mandate to vary.

---

## 5. GUI reform

### The stack verdict: reform the information architecture, keep the stack

You said you would accept complete reform if it genuinely adds enormous value. My honest answer, having read all 3,317 lines of the renderer: **the stack is not the problem and replacing it would be value-destroying.** The Electron + React + tRPC + hand-rolled SVG-graph choice is lean, has no dependency rot, and the components are unusually well-reasoned — [WhyPanel.tsx](gui/src/renderer/src/panels/WhyPanel.tsx) falling unknown economics terms through to a tail so a new term can never be silently hidden is the kind of thing you do not get back after a rewrite. Rewriting as a web app also buys nothing for a local-first buyer while costing an auth surface we explicitly deferred.

**What does need complete reform is the information architecture.** Today it is: Rail (flat task list) → Task → two tabs (Conversation | Flow) → Inspector (5 tabs). That is a shape for *watching one task*. Everything in this document — history, search, parallel runs, receipts, mandates, cost rollups, memory with provenance — has nowhere to live in it. The Rail is already doing three unrelated jobs (project label, task list, Inbox/Memory asides).

So: **keep every component, rebuild the shell.** Concretely that is a new `App.tsx` route model plus roughly six new panels, with [Inspector.tsx](gui/src/renderer/src/panels/Inspector.tsx), [WhyPanel.tsx](gui/src/renderer/src/panels/WhyPanel.tsx), [OrgGraph.tsx](gui/src/renderer/src/graph/OrgGraph.tsx), [NodeCard.tsx](gui/src/renderer/src/graph/NodeCard.tsx), [Conversation.tsx](gui/src/renderer/src/panels/Conversation.tsx), [LiveStatus.tsx](gui/src/renderer/src/panels/LiveStatus.tsx) and the transcript/markdown libs carried over largely intact. That is reform where reform pays and preservation where it pays.

### The new shell — five surfaces

Replace the Rail-plus-two-tabs shape with a persistent left nav of five destinations:

**1. Desk** *(default)* — what needs you, now. Not just approvals: one ranked attention queue merging approvals awaiting a human, nodes over budget, nodes stalled with no progress event, commitments whose DoD is unmet, and runs orphaned by a restart. Below it, live runs with the [LiveStatus](gui/src/renderer/src/panels/LiveStatus.tsx) line each. The composer lives here as the hero when the queue is empty. *This replaces the current empty-state Hero and the Inbox aside, and it is the screen the app should open on.*

**2. Cases** — every run ever, searchable and filterable by state, mandate, cost, runtime, repository, date, DoD-met, and whether a human intervened. Row = goal, state, agents, cost vs budget, duration, outcome. This is the surface that does not exist at all today and is the single biggest usability gap versus n8n executions or Devin's session sidebar.

**3. Case** *(one run)* — the Case File. Header answers, above any transcript: objective, mandate it ran under, current state, cost against ceiling, DoD progress, what it produced, what needs you. Then four synchronized views over the same event model — **Conversation** (today's, kept), **Organization** (today's Flow, plus the time-travel scrubber, authority overlay, and burn treemap), **Proof** (filterable ledger of every decision, tool call, artifact, approval, and DoD verification), and **Receipt** (the compact shareable object, exportable to HTML).

**4. Mandates** — template library. Create, edit, diff, and pre-flight simulate. Form-first; no canvas. The Authority Simulator lives here and on the composer.

**5. Memory** — earned claims with sample sizes, confidence, drill-down to the runs that produced them, and a veto. Plus authored notes (our answer to Devin Knowledge / OpenHands microagents), scoped to a repository.

### Interaction principles worth keeping and one worth adding

Keep: **one input** ([Composer.tsx](gui/src/renderer/src/panels/Composer.tsx) doing both goal and question via the real [parseQuestion](src/intelligence/ask.ts) parser rather than a heuristic) — that is a genuinely good idea and it stays. Keep the `--state` single-hue-per-card discipline. Keep answering questions from the record rather than a model.

Add: **an authority preview on the composer itself.** Before you press Start, one line under the box says what the organization will be permitted to do and what will make it stop and ask you. Nobody in this market shows you the blast radius before you press go.

---

## 6. Positioning and marketing

### Change the noun

Drop "control plane." Microsoft Agent 365 shipped GA in May 2026 as literally "the control plane for agents," anchored on Entra Agent ID, with a cross-cloud agent registry. Competing for that phrase is unwinnable and, worse, it misdescribes us — a registry inventories *agents that exist*; we record *work that was authorized*.

**Positioning line:**
> **CherryOnTop is the accountability record for AI work. Every outcome carries its mandate, its chain of custody, its evidence, its cost, and the name of the human who authorized it.**

**Supporting claims, each defensible and each tied to shipped code:**

- *"The org chart is the audit trail."* — the delegation tree literally is the record.
- *"Budgets that stop, not dashboards that report."* — we enforce at the boundary; the market's own analysts draw this exact distinction and put most vendors on the wrong side of it.
- *"It doesn't just tell you what it did. It tells you what it was allowed to do."* — the mandate, pre-flight and post-hoc.
- *"Arithmetic, not adjectives."* — the economics breakdown, with the counterfactual. Everyone else's "why" is a paragraph a model wrote about itself.
- *"An agent can never hold more authority than the one that hired it."* — monotone narrowing, in one sentence.
- *"Cascading failure, scope creep, attribution gaps."* — the three problems every 2026 governance framework names as unsolved for agents, and the three our structure is built against. Use the regulator's vocabulary; it lands with the buyer without us claiming compliance.

### The demo

One clip, ninety seconds, no narration needed: give a goal → the **authority preview** shows the blast radius before you press start → the org forms in Flow → a child hits its budget ceiling and **stops**, blocking on your Desk with the ledger that took it there → you raise the ceiling → it finishes → the **DoD checklist** goes green item by item with evidence links → export the **Receipt** → drag the scrubber and watch the whole thing replay. Every frame of that is data we already store.

### Boundaries to state publicly (credibility comes from limits)

- We show **structured rationale** — scored decisions, policies evaluated, tools used, artifacts produced. We do **not** claim to expose model reasoning, and we say that explicitly.
- **Tamper-evident, not tamper-proof.**
- Local-first: what stays on your machine, what the sandbox can reach, which credential was used.
- No compliance certification claims. We say the record is *built to be auditable*, and we let the auditor decide.

---

## 7. What not to build (updated)

v1's list holds — no unconstrained canvas, no connector marketplace before policy, no freeform production editing, no opaque "AI audit" claims. Three additions:

- **Do not build a visual agent builder.** OpenAI is retiring Agent Builder and Evals from its platform after 30 November 2026, one year after launch, and pointing users at code. That is the most expensive possible A/B test and it came back negative.
- **Do not build identity, RBAC, SSO, or tenancy this cycle.** It is the wrong buyer, it is 100% invisible in a demo, and Agent 365 / Entra Agent ID will make "bring your own agent identity" the integration shape anyway. Build the *delegation chain* now; bind it to an external identity later.
- **Do not chase evals as a product surface yet.** The feedback loop matters, but for a solo buyer with no dataset it is empty scaffolding. Ship replay-and-fork first — it is the same value with an n of one.

---

## 8. Success measures

Unchanged from v1 where they were good; sharpened where they were vague.

- **Restart survival rate** — % of runs in flight across a daemon restart that resume. Target 100%. *(Today: 0%.)*
- **Enforcement coverage** — % of tool calls checked against the node's mandate. Target 100%. *(Today: 0%.)*
- Time to answer "what happened and why" from the GUI, without reading raw logs.
- % of completed cases with a complete Receipt: mandate, chain of custody, DoD verified, cost, approvals, hash chain.
- **DoD verification rate** — % of closed commitments where every DoD item has linked evidence.
- Approval response time; % of runs that stopped at a boundary rather than overrunning it.
- Cost and duration by mandate template, runtime, and repository — the inputs that make Memory smarter.
- Replay/fork usage — how often a user re-runs under a changed mandate. This is the leading indicator that the mandate is a real product object rather than a form.

---

## 9. Limitations

Grounded in the source tree as of 7 September 2026 and public vendor material current to the same date. Competitor capabilities vary by edition, tier, and preview status; the comparison is at the level of feature families, not SKUs. Some 2026 vendor claims are drawn from secondary practitioner analysis rather than first-party docs and are flagged where they carry weight. I stopped when independent sources stopped changing the priority order — durability, enforcement, and mandate authoring came out on top from every direction.

## Sources

**Coding agents:** [OpenHands 2026 coding-agent survey](https://www.openhands.dev/blog/best-coding-agents) · [OpenHands review](https://aiagentslist.com/agents/openhands) · [Devin 2026 release notes](https://docs.devin.ai/release-notes/2026) · [Devin manages Devins](https://cognition.ai/blog/devin-can-now-manage-devins) · [Devin knowledge base](https://medium.com/@nitinmatani22/devin-s-knowledge-base-how-to-teach-an-ai-agent-your-codebase-conventions-6a30a89eb3a1) · [Devin playbooks](https://fast.io/resources/devin-ai-playbook-guide/) · [Cursor 3 guide](https://baeseokjae.github.io/posts/cursor-3-guide-2026/) · [Cursor 2026 features](https://www.deployhq.com/guides/cursor) · [Factory AI review](https://www.digitalapplied.com/blog/factory-ai-multi-agent-coding-platform-review) · [Factory vs Cosmos](https://www.augmentcode.com/tools/factory-ai-vs-augment-cosmos) · [Claude Code analytics](https://code.claude.com/docs/en/analytics) · [Claude desktop guide](https://fast.io/resources/claude-desktop-app-guide/)

**Control planes:** [Bedrock AgentCore overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html) · [AgentCore release notes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html) · [AgentCore Gateway](https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-agentcore-gateway-transforming-enterprise-ai-agent-tool-development/) · [AgentCore observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html) · [Microsoft Agent 365](https://www.microsoft.com/en-us/microsoft-agent-365) · [Agent 365 GA](https://www.microsoft.com/en-us/security/blog/2026/05/01/microsoft-agent-365-now-generally-available-expands-capabilities-and-integrations/) · [Entra agent registry convergence](https://learn.microsoft.com/en-us/entra/agent-id/agent-registry-convergence) · [Gemini Enterprise Agent Platform release notes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/release-notes) · [Vertex AI release notes](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes) · [OpenAI AgentKit](https://openai.com/index/introducing-agentkit/) · [AgentKit analysis](https://kanerika.com/blogs/openai-agentkit/)

**Durability & observability:** [Temporal for AI](https://temporal.io/solutions/ai) · [Dynamic agents on Temporal](https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal) · [Durable agents 2026 survey](https://www.reactify-solutions.com/articles/durable-ai-agents-2026) · [Inngest on durable execution](https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents) · [LangSmith platform](https://www.langchain.com/langsmith-platform) · [LangSmith observability docs](https://docs.langchain.com/langsmith/observability) · [n8n Insights](https://docs.n8n.io/insights/) · [n8n execution data](https://deepwiki.com/n8n-io/n8n-docs/9.3-execution-data-and-history) · [Dify run history](https://deepwiki.com/langgenius/dify-docs/6.3-run-history-and-logging) · [LangChain Agent Inbox](https://github.com/langchain-ai/agent-inbox) · [LangGraph human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)

**Governance, identity, economics:** [EU AI Act vs NIST vs ISO 42001](https://www.eccouncil.org/cybersecurity-exchange/responsible-ai-governance/eu-ai-act-nist-ai-rmf-and-iso-iec-42001-a-plain-english-comparison/) · [AI agent governance 2026](https://zylos.ai/research/2026-05-01-ai-agent-governance-compliance-2026/) · [AI model audit trail requirements](https://visotrust.com/resources/ai-model-audit-trail-requirements/) · [Agent auth & delegated access](https://zylos.ai/research/2026-04-11-agent-authentication-delegated-access-oauth-scoped-tokens) · [SPIFFE for agentic AI](https://www.hashicorp.com/en/blog/spiffe-securing-the-identity-of-agentic-ai-and-non-human-actors) · [Agent identity playbook](https://www.digitalapplied.com/blog/agent-identity-credentials-non-human-access-2026-playbook) · [Agent budget enforcement](https://ravoid.com/blog/ai-agent-budget-enforcement) · [Token budget enforcement](https://waxell.ai/blog/ai-agent-token-budget-enforcement) · [Agent cost per task](https://www.kunalganglani.com/blog/ai-agent-cost-per-task-2026)

**UX:** [Practical interface patterns for AI transparency](https://www.smashingmagazine.com/2026/05/practical-interface-patterns-ai-transparency/) · [Trust & transparency patterns](https://agentic-design.ai/patterns/ui-ux-patterns/trust-transparency-patterns) · [Explainable AI UI design](https://www.eleken.co/blog-posts/explainable-ai-ui-design-xai)

**Frameworks:** [MetaGPT](https://github.com/foundationagents/metagpt) · [ChatDev 2.0](https://github.com/openbmb/ChatDev) · [Multi-agent framework comparison 2026](https://www.spheron.network/blog/langgraph-vs-crewai-vs-autogen-2026/)
