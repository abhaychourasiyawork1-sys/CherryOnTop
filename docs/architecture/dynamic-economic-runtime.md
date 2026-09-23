# The dynamic economic runtime

How CherryOnTop decides what to do about a run that is already under way.

This document describes a **control plane**, not a planner. The agent remains the
reasoner: it decides what the work is, what to read, and how to do it. What is
described here decides only whether there is a *material economic opportunity*
worth acting on, and in the overwhelming majority of cases the answer is no and
nothing happens.

The objective is `Tokens : Quality : Latency = 2 : 2 : 1`, and the primary
metric is **tokens per successful task**. Quality is not a term that a large
enough token saving can buy — a cheaper incorrect task is a regression, and a
success count that includes runs which did not work would score an optimizer
that makes runs cheaper and wronger as an improvement.

---

## Five layers

| Layer | Question it answers | Where it lives |
|---|---|---|
| **State** | What does the runtime know right now? | `src/decision/state.ts` |
| **Capabilities** | What could be done about it? | `src/decision/actions.ts`, `deep-path.ts` |
| **Economic decision** | Which of those is worth doing? | `src/decision/utility.ts`, `engine.ts`, `trust.ts` |
| **Agent / execution** | Carry it out — or, usually, do nothing | `src/lifecycle/economic-runtime.ts` |
| **Evidence / evaluation** | What happened, and what did it cost? | `src/evidence/`, `src/efficiency/ledger.ts` |

The flow is one direction:

```
Goal → State → Capabilities → Economic Decision → Agent Execution → Evidence → State update
```

### State

One immutable value, one total reducer. Before it, "what does the runtime know?"
was answered by reaching into six places at once — pre-task signals, the tool
stream, the cost table, the turn count, the knowledge frontier, the context
receipt. Each was correct and none was *the state*, which is why the spend
guard, the context planner and the decision engine each held a partial,
differently-shaped copy and could disagree.

Every dimension is something **any** task has:

- **evidence** — pointers to what is believed and how it came to be believed.
  Never the content; that already lives in the event chain and the artifacts
  table.
- **uncertainty** — four independent doubts (`target`, `structural`,
  `behavioral`, `validation`), tracked apart because they have different cures.
  A run that knows exactly which file to change but not whether the change works
  has low structural and high validation doubt, and reading more files helps
  neither.
- **resources** — budget, spend, the optimizer's own allowance, any recovery
  reserve.
- **trajectory** — progress, information gain, exploration and failure pressure,
  state similarity, and how much the orchestrator trusts its own reading.
- **constraints** — the quality floor and the hard stop.

Snapshots are values: `applyEconomicEvent` returns a new state and never touches
the one it was given, so a decision made against version 7 is still explicable
after version 12 exists. Normalization is total — a state arriving with a NaN or
a budget smaller than what was spent is a bug in whatever produced it, and a bug
in a *state* must not become a bug in a *dispatch*.

### Capabilities

Every option the runtime has is an `ActionCandidate`: a bundle of expected
economic effects in one shape. Ten generic verbs — `continue`,
`acquire_evidence`, `explore`, `validate`, `reuse_evidence`, `parallelize`,
`serialize`, `recover`, `constrain`, `stop` — and **capability-specific detail
goes in `metadata`, never in a new field**. A field named `evidenceLevel` would
be the first step towards a per-capability schema, and a per-capability schema is
a per-capability pathway with extra steps.

New capabilities arrive as *candidate sources*: a pure function from state to
candidates, registered rather than branched on.

### Economic decision

Two paths, and the cheap one runs far more often.

**The fast path** (`fast-path.ts`) reads nothing but the state it was handed — no
graph, no memory, no database, no model — and asks whether there is visibly
anything worth paying to look into. Every signal is a *difference between two
state dimensions*, floored at zero:

| Signal | Expression |
|---|---|
| identifiable missing evidence | doubt − evidence held |
| repeated failure | failure pressure − progress |
| high duplication | state similarity − information gain |
| validation uncertainty | validation doubt − work outstanding |
| resource pressure | spend share − progress |

A difference reaches exactly zero when the two dimensions agree, which is what
lets a healthy run report *nothing* rather than a small number needing an
arbitrary noise floor to suppress. It also states each pathology directly:
repetition beyond the information it produced *is* wasteful repetition.

The bar it clears is not a constant. It is **what a deep evaluation would cost as
a share of the optimization allowance still available**, so as the optimizer
spends, its own bar rises — and an optimizer that has spent its allowance stops
screening entirely, with no separate switch.

**The deep path** (`deep-path.ts`) is where the expensive lookups live, and it
runs only after the screen has found something. It *proposes* and never chooses.

**Ranking** (`engine.ts`) filters by hard constraints before scoring anything —
a constraint a good enough score can overturn is a weight, not a boundary — then
orders by trust-adjusted utility, then confidence, then a stable id. Never by
kind, and never by anything derived from what the task is about.

**Trust** (`trust.ts`) closes the failure that makes automated optimization
dangerous rather than merely useless: an orchestrator that responds to not
knowing what is going on by intervening harder. `risk = consequence × (1 −
trust)`, so as confidence falls the *expensive* options become uncompetitive
first. Doubt narrows what may be done.

### Agent / execution

`economic-runtime.ts` is called once, at the boundary the lifecycle already
establishes — the moment a dispatch is assembled. It does not own the loop; the
CLI does. It does not own the state machine; `node-actor-manager.ts` does.

`CONTINUE` is a genuine no-op. The test that pins this reconstructs the
dispatched prompt from the context planner alone and compares it byte for byte;
any byte the control plane contributed would show up there.

### Evidence / evaluation

Cross-run knowledge is **not a cache**. A cache answers "have I computed this
before?" and the answer is usable or not; knowledge about a repository is usable
*to a degree*, and the degree depends on facts the storing run cannot know.
Every item carries where it came from, how much it was believed, and what
replaced it — and the reader decides.

The ledger records what each decision *predicted* alongside what happened.
Without it, a comparison can say spend moved and cannot say whether the thing
that moved it was any good at predicting its own effect.

---

## Information economics

The question the context planner was always implicitly answering and never
explicitly asking: **hand it over now, or let the agent find it?**

The asymmetry that makes it interesting is that a handed-over file costs what it
costs, once, while the same file discovered costs several turns of searching —
and a turn re-reads the conversation, so cost inside a dispatch grows
superlinearly in turns rather than linearly. A hundred tokens of context can
genuinely save thousands; the same hundred spent on a file the agent was never
going to need is pure waste. Both directions are real, which is why
`evaluateInformationOpportunity` returns a *net value* that can be negative
rather than a score that can only rank.

Evidence comes in four explicit levels:

| Level | What | Cost to produce |
|---|---|---|
| `L0` | metadata — the path alone | free (inventory) |
| `L1` | structural — path and top-level symbols | free (inventory) |
| `L2` | focused — plus direct relationships | free (inventory) |
| `L3` | full artifact — the file itself | a real read |

`L3` is **priced here and never materialized here**: deciding whether something
is worth opening must not cost what opening it costs. A selected `L3` is a
*request*, charged to acquisition rather than to the render budget, and fulfilled
at an execution boundary by `context/evidence-actions.ts` — one artifact per
call, re-priced against the state as it stands then, refused rather than
truncated above a size ceiling.

Quality-risk reduction is converted into tokens at the objective's own exchange
rate: under 2:2:1 a unit of quality is worth a whole budget of tokens. Writing
the conversion down is what makes it checkable instead of implicit.

---

## Dynamic resource allocation

`budget.ts` replaces a table. The old allocation came from what a task *looked
like*, before anything had happened, and was never revisited — so a task that
turned out to need no exploration still held an exploration allowance, and one
that discovered it needed a retry had nothing held back for one.

Here the allowance comes from the opportunities that exist now, capped at what
they actually asked for. **Holding nothing back is the default**, because an
allowance reserved for work nobody proposed is an allowance the work that *is*
happening cannot use. The recovery reserve is a bucket like any other: when the
run stops failing there are no recovery opportunities and the reserve is zero,
with nothing having to remember to release it.

---

## Agent-first behaviour

The architectural commitment, stated plainly: **the agent is the reasoner, and
the control plane is not.**

- The default healthy action is non-intervention.
- Orchestrator uncertainty *reduces* intervention aggressiveness. It never
  increases it.
- The reassessment cadence backs off while a run stays quiet and collapses to
  every event the moment it stops — the opposite of a fixed cadence, where the
  price of catching a problem early is paying for the check when there is none.
- The loop charges itself. Tokens are modelled and latency is measured; an
  orchestrator whose own cost is accounted somewhere it never reads will always
  report itself profitable.

---

## Do not hard-code workflows

This is the rule the whole design exists to keep, and it is easy to break with a
change that looks entirely reasonable in isolation.

**Not permitted:**

- A branch on task class that selects which actions exist, which context recipe
  applies, or which budget a task gets.
- A per-capability field on `ActionCandidate`, or a per-capability schema
  anywhere in `src/decision/`.
- A universal stuck rule: `searchCount > N`, `turns >= N`, `failures > N`. The
  most expensive run this repository has measured took 42 turns and was
  genuinely working; the 19-turn run before it was not.
- A fixed task-to-budget percentage, or a fixed task-to-context mapping.
- A new user-facing runtime mode.

**Permitted, and how to do it instead:**

| Instead of | Do |
|---|---|
| a branch for a new task shape | nothing — the generic path already covers it |
| a new capability | register a `CandidateSource` |
| a new pathology signal | a difference between two state dimensions in `fast-path.ts` |
| a new cost or benefit | a field on `ActionCandidate` that *every* action has |
| an emergency behaviour | a `FallbackReason`; the behaviour is always Baseline |

Task classification still exists and is still used — as a **weak prior on the
numbers**, never as a selector of behaviour. `src/architecture/invariants.test.ts`
enforces every line of this section, including by reading the source: "there are
no task-specific pathways" is a claim about what the code contains, and no
behavioural test catches a pathway added beside the generic one for a case
somebody thought was special.

---

## Engineering freedom

Implementation may change internal algorithms, split or merge files, replace data
structures, improve scheduling or caching, or substitute a stronger mechanism for
a specified one.

It may **not** use "simpler", "less code", "fewer files", "less work" or "easier"
as the *sole* reason to remove or weaken a requirement.

A deviation is valid only when it demonstrably improves token efficiency,
quality, latency, adaptability, agent autonomy, manageability, fault containment,
observability or composability — and still preserves the invariants above. When
one is found:

1. Write the failing or regression test that shows the current mechanism is
   insufficient, or the proposed one better.
2. Implement it.
3. Run the focused and adjacent suites.
4. Record the deviation and its reason in the commit message and the
   implementation audit.
5. Do not make a task-specific shortcut the improvement.

---

## Product modes

Exactly two, and this is a hard invariant rather than a current state of affairs.

| Mode | `ORG_EFFICIENCY_MODE` | Behaviour |
|---|---|---|
| **Baseline** | `disabled`, `off`, `0`, `false`, `baseline`, `shadow` | Fixed per-role models, lexical context, nothing decided from the state of a run. The behaviour this branch shipped with. |
| **Full Architecture** | anything else, including unset | The architecture acting on its decisions. |

`shadow` was a third mode and is now an alias for Baseline — which is exactly
what a shadow run dispatched as, so a deployment that set it keeps the behaviour
it had. A shadow's whole value is being inert, and a *product* mode cannot be
inert: it is one more thing an operator can be running, one more combination to
test, and one more thing a bug report has to establish before it can be read. The
measurement it existed for now happens in `src/learning/shadow.ts`, which is not
reachable from configuration at all, and in the benchmark harness, which compares
matched runs of the two real modes.

Baseline is also the **fallback**. There is one fallback with many reasons rather
than a degraded mode per fault, because every alternative is a new behaviour to
test and a new state for a run to be in — and the value of having a Baseline is
that it is the behaviour that already works.

The one exception: **a safety failure is not a reason to fall back.** Falling
back means running unoptimized, and an action that violates a hard safety
constraint is just as unsafe unoptimized. `FallbackDecision.safetyPreserved` is a
separate answer from `mode` precisely so a caller checking only the mode cannot
lose that distinction.

---

## Where to look

| Concern | File |
|---|---|
| State and its reducer | `src/decision/state.ts` |
| Action contract | `src/decision/actions.ts` |
| Utility and hard constraints | `src/decision/utility.ts` |
| Ranking and provenance | `src/decision/engine.ts` |
| Screen and proposal | `src/decision/fast-path.ts`, `deep-path.ts` |
| Uncertainty and trajectory | `src/decision/uncertainty.ts`, `trajectory.ts` |
| Budget allocation | `src/decision/budget.ts` |
| Orchestration loop and its cost | `src/decision/orchestration-loop.ts`, `orchestration-cost.ts` |
| Trust and fallback | `src/decision/trust.ts`, `fallback.ts` |
| Information economics | `src/efficiency/information-economics.ts` |
| Context candidates and selection | `src/context/candidates.ts`, `scoring.ts`, `selector.ts` |
| Reactive acquisition | `src/context/evidence-actions.ts` |
| Validation ladder | `src/validation/contract.ts`, `engine.ts` |
| Recovery | `src/recovery/engine.ts` |
| Evidence plane | `src/evidence/store.ts`, `reuse.ts` |
| Workstreams and conflicts | `src/execution/workstreams.ts`, `conflicts.ts` |
| Lifecycle integration | `src/lifecycle/economic-runtime.ts` |
| Ledger and metrics | `src/efficiency/ledger.ts`, `metrics.ts` |
| Architecture invariants | `src/architecture/invariants.test.ts` |
