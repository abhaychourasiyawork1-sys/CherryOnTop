# Owned context runtime: what to keep, what to take from ToFu

**Branch:** `feat/owned-agent-loop`. **Inputs:** the ToFu paper, this branch's owned loop, and its
Terminal-Bench runs (`bench/terminal-bench`, `bench/agent-owned/STATS.md`).

## The principle

> **The model owns reasoning; CherryOnTop owns information flow.**

The model decides *what to do next*. CherryOnTop decides what information the model is given, what it
keeps, what it can get back, when to delegate, when to retry, when to verify and when to stop. Until the
owned loop existed, CherryOnTop could only shape the one argv a dispatch started with
([context-runtime-decisions.md](context-runtime-decisions.md), "the one fact everything else follows
from"). Now that it owns the loop, it also controls what the model sees on every turn after that. This
document covers that second half.

Research question it serves: *can an economically aware, ownership-preserving harness improve quality
per token by controlling information flow rather than only execution?* The metric stays
quality × cost × latency. Tokens saved is a diagnostic, not the objective.

## Keep unchanged

These are CherryOnTop's own primitives. ToFu's ideas plug into them; they do not replace them.

| primitive | where |
|---|---|
| ownership and authority: parent owns the outcome, pooled budget and child limits, explicit tool grants, write scope, CAS delegation state | `lifecycle/delegate-child.ts`, `engines/enforce-tools.ts`, `decision/budget.ts` |
| economic decisions: continue/delegate/parallelize/acquire evidence/validate/recover/stop as priced `ActionCandidate`s | `decision/actions.ts`, `decision/utility.ts`, `decision/engine.ts` |
| evidence: provenance, confidence, current evidence outranks history, stale penalty, receipts | `evidence/`, `events/` |
| parent → child contract: goal, constraints, DoD, acceptance, budget, max turns, refs not transcripts, `contextRevision` | `intelligence/agent-envelope.ts` |
| child isolation and the merge gate ("done" is not accepted until reviewed) | `workspace/`, `lifecycle/` |
| failure-aware recovery: failure signatures, bounded rework, no blind repeats | `recovery/`, `decision/strategy-gate.ts` |

Every context mechanism below is either something the broker or loop does, priced with the same
carrying-cost arithmetic (`infocontrol/economics.ts`), or a candidate for the existing economic
controller. None of them is a separate optimizer.

## Adopted from ToFu, and where it lives

| ToFu idea | status | where |
|---|---|---|
| L1: size-aware tool-output budgets | built | `agent/tools.ts` (`OUTPUT_CAP`, `WEB_CAP`, information control's projections) |
| L2: deterministic, cache-aware micro-compaction | built, priced | `agent/compaction.ts` `microCompact`, `agent/loop.ts` `doMicro` |
| L3: semantic compaction by a small model near the limit | built, 80% of usable window, falls back to deterministic | `agent/loop.ts` `summarize`, `SUMMARY_INSTRUCTIONS` |
| **tool results externalized under a reference** | **built in this change** | `agent/result-store.ts`, `FetchResult` in `agent/tools.ts` |
| **results shared between parent and sub-agents** | **built in this change** (owned `Task` sub-agents) | one store per dispatch, `adapters/anthropic-owned.ts` |
| **context-flow telemetry** | **built in this change** | `ContextTelemetry` on the `result` event; `zones` on each `owned.turn` |
| cache zones (stable / semi-stable / hot) | the layout already followed it; now measured | fixed system and tools; opening message; append-only hot history |
| critic gate before finishing | built | `CONFIRM_FINISH` |
| reactive delegation on leftover uncertainty | not built | see Phase 4 |

### Tool results as addressable objects

Any output of at least `MIN_STORED_CHARS` is stored host-side as `result://<tool_use_id>`, along with
its tool, target, size, line count, sha256 checksum and a preview. The model reads it back with
`FetchResult` (`ref`, plus either `offset`/`limit` or a regex `pattern`). This changes three things:

- **Shortening no longer loses anything.** A bounded output's banner names its `result://` ref. The
  sandbox spill file is still written so Bash can grep it, but the ref still works if that write fails.
- **Micro-compaction always has somewhere to point.** Before, a placeholder was skipped when the
  sandbox save failed. Now it names the ref (and, for a Read, also says the file can be read again
  for its current content). A FetchResult answer that gets moved out points back at the same fetch.
- **Compaction's call index carries refs.** Calls folded away by compaction list
  `full output: result://…`, so the model can get back exactly what it saw, not only what the file
  holds now.

**Authority.** `FetchResult` is listed in `HARNESS_TOOLS`. It only re-reads output from calls the
mandate already allowed, so it carries no authority of its own. It is offered under every grant and
never reported as a violation. It bypasses information control, whose repeat gate would otherwise
price a re-read of evidence as a wasted repeat, and it bypasses the circuit breaker.

**Shared evidence.** One store serves the dispatch and every `Task` sub-agent it runs. A parent can
put `result://…` in a sub-agent prompt instead of having the sub-agent re-run the call. A sub-agent
report longer than `SUBAGENT_REPORT_CAP` is capped in the parent's context, but the full report stays
fetchable. Identical content is stored once, by checksum. This is `sharedEvidenceIds` made real at the
scale of a single dispatch.

**Bounded.** Contents past 32M characters are evicted oldest first. Metadata stays, and a fetch of an
evicted ref points at the spill file. When an attempt is remembered for resume, its store is shrunk
to 2M characters and kept with the transcript, so the refs in that transcript still resolve.
`ORG_OWNED_RESULT_STORE=off` turns the store off.

### Telemetry

The `result` event (and `AgentSessionResult.context`) now carries:

```
toolRawTokens      toolShownTokens          — L1: produced vs handed to the model
microCompactions   microSavedTokens         — L2
compactions        compactionDroppedTokens  compactionStateTokens   — L3 / window
summaryUsd                                  — what L3's small model cost
fetches            fetchedTokens            — what externalizing cost in recovery
cacheReadTokens    cacheCreationTokens
results: { stored, storedChars, deduped, evicted, fetches, fetchedTokens }
```

Each `owned.turn` also reports `zones: { stable, semiStable, hot }`. Compaction should act almost
entirely on `hot`. A run where `fetchedTokens` approaches `toolRawTokens − toolShownTokens` is
externalizing results it then needs back. That is the signal to raise a cap, not to celebrate the
savings.

## Not copied from ToFu

- Its orchestration. CherryOnTop's ownership, budget pooling and merge gate are stronger.
- Fixed heuristics in place of the economic engine.
- Generic memory in place of the evidence store's provenance and staleness model.
- An LLM summarizer everywhere. L3 fires only near the limit. Measured on Terminal-Bench, priced
  full compaction at about 12% of the window cost more than it saved (`pricedCompaction` stays off).
- Parallelizing by default. `execution/workstreams.ts` already prices coordination cost.

## Phases

| phase | state |
|---|---|
| 0 Freeze the primitives | in effect: this change touches only `agent/`, the owned adapter and their tests |
| 1 Owned context runtime | **result store, refs and FetchResult built.** The loop already acts as the compiler (fixed prefix, append-only history, compaction rebuilds from state). It now reports zones. No separate `ContextCompiler` module was added, because nothing yet needs one. |
| 2 Three-layer compression with telemetry | L1–L3 built earlier on this branch; **telemetry built in this change** |
| 3 Context-aware delegation | **shared result refs between parent and `Task` sub-agents built.** Still open: org-level children (`node-actor-manager`) sending `renderDelta(diffProjections(…))` keyed on `contextRevision` on re-dispatch instead of a fresh envelope. Both primitives exist (`context/delta.ts`, `revisionOf`); the wiring does not. Also open: a parent acquiring a `sharedEvidenceIds` item once before fanning out. |
| 4 Reactive delegation | open: after a child result, compute the information value of the remaining uncertainty and emit an `acquire-evidence` / targeted-child `ActionCandidate` (`decision/actions.ts`), not a new branch |
| 5 Memory closure | open: accepted result → candidate `KnowledgeItem` → the existing `learning/lessons.ts` lifecycle (one observation is never a rule) |
| 6 Merged-tree verification | open: after the merge gate, verify the *integrated* tree in a fresh sandbox, so that A passing and B passing but A+B failing is caught |
| 7 Learning context and delegation policies | open: only after 1–6 produce measurements worth learning from |

## Measuring the change

The next Terminal-Bench run should compare against run 3 (`bench/agent-owned/STATS.md`) on:
pass rate, cost per pass, `fetches` per task, `fetchedTokens / (toolRawTokens − toolShownTokens)`,
and how often micro-compaction fired now that placeholders can no longer fail. If fetches are rare
and pass rate holds, externalization is cheap insurance. If fetches are frequent, the L1 caps are too
tight for those task families.
