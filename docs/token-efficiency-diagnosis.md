# Why one review request ate 26% of a 5-hour window

Measured, not modelled. Source: the run recorded in `~/.org/state.db` as node
`5432bd11-0338-4e38-9b6a-baebed0cc6a3`, goal *"Review the codebase and check for
bugs,no edits"*, started 2026-09-11T02:11:42Z. Every number below comes from
that run's own event stream — `plan.result` / `exec.result` / `synth.result`
payloads (the `modelUsage` block Claude Code reports) and the
`rate_limit_event.unifiedWindows.five_hour.utilization` field, which is the
account's own view of the window and therefore the authoritative answer to
"how much of the window did this cost".

## The window trace

`five_hour.utilization`, in order, across the whole run tree:

```
02:11:45  0.00   planner starts          (haiku)
02:12:16  0.01   children 1+2 start      (sonnet-5, 2 concurrent — the cap)
02:14:35  0.11   child 3 starts
02:16:07  0.16
02:16:34  ——     TASK CANCELLED; root reaches CANCELLED, children marked CANCELLED
02:16:37  0.17   synthesis runs anyway   (haiku)
02:16:58  ——     final answer published to the user
02:16:36  0.18   child 5 STARTS ITS JOB — two seconds after being cancelled
02:20:59  0.26   child 5 finishes, 42 turns later. Its output is discarded.
```

**0% → 26% in nine minutes.** Roughly **9 percentage points of that — more
than a third — was spent after the task was cancelled and after the user
already had their answer.**

## Per-Job ledger

| Job | role | model | turns | maxTurns | in | out | cacheRead | cacheCreate | wall | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| `5432bd11` | plan | haiku-4.5 | 5 | 15 | 1,053 | 1,975 | 104,960 | 11,852 | 26s | $0.045 |
| `fc2fc34d` | execute | **sonnet-5** | 19 | — | 22 | 11,792 | 651,955 | 63,859 | 134s | $0.505 |
| `32e920ec` | execute | **sonnet-5** | 30 | — | 34 | 14,226 | 1,136,108 | 86,951 | 222s | $0.718 |
| `7d28cf6e` | execute | **sonnet-5** | ~22 | — | — | — | ~500,000¹ | — | 120s | ~$0.40¹ |
| `1a17107d` | execute | **sonnet-5** | 42 | — | 46 | 18,117 | 1,772,218 | 102,487 | 263s | $0.947 |
| `9d85d0aa` | execute | — | 0 | — | 0 | 0 | 0 | 0 | — | $0 |
| `5432bd11` | synthesize | haiku-4.5 | 1 | 1 | 3,630 | 1,561 | 12,237 | 9,918 | 19s | $0.032 |

¹ cancelled mid-run, so it has no `result` event and no authoritative aggregate.
Estimated by turn count against `fc2fc34d`. Per-message `exec.assistant` sums
are **not** usable as a substitute: summing them for `fc2fc34d` gives 1,592,522
cache-read against the authoritative 651,955, and 157 output against 11,792.

**Totals: 7 Claude Jobs** (1 planner + 5 children + 1 synthesis) — 6 of which
actually dispatched — **~119 turns, ~4.2M cache-read tokens, ~$2.65, 9m21s wall** (5m16s to the answer; the rest burned after it).

Of that, `7d28cf6e` + `1a17107d` (~64 turns, ~2.3M cache-read, ~$1.35) produced
**nothing**: both were CANCELLED and neither report reached the answer. The
answer the user got was synthesised from 2 children and says so: *"Two bugs
found; three areas unchecked due to incomplete review."*

## Dominant factor

Not one of the seven candidates — two, in this order.

### 1. The work should never have been delegated (root cause of Jobs 2–7)

The run's own `decision.made` record:

```json
{"outcome":"DELEGATE","breakdown":{
  "breadth_terms":1,"separate_items":0,"distinct_work_types":1,
  "named_single_targets":0,"decomposition_score":2,
  "estimatedValue":0.7,"modelCost":0.1,"latencyCost":0.05,
  "coordinationCost":0.15,"verificationCost":0.1,"riskPenalty":0,
  "threshold":0.3,"score":0.29999999999999993}}
```

Read it term by term:

- `decomposition_score: 2` came **entirely from the single word "codebase"**.
  `src/intelligence/decompose.ts` scores `breadth * 2`, and `BREADTH` matches
  `codebase`. `separate_items: 0`, `distinct_work_types: 1`. There was no second
  workstream anywhere in the request — the scorer never looked for one.
- 2 ≥ 1.5, so `complexity: 'medium'`, `worthSplitting: true`.
- Economics then scored `0.7 − 0.4 = 0.2999999...` against a threshold of `0.3`
  and delegated **on the 1e-9 float tolerance**. Every medium-complexity goal
  delegates at exactly zero margin, by construction.

So: one breadth word, worth two points, bought a planner Job and five sonnet-5
children. This is precisely the "large scope ≠ parallelisable work" confusion —
`breadth` is treated as a split signal with no requirement that there be more
than one *kind* of work to spread across it.

### 2. A cancelled node's queued dispatch still opens a sandbox (root cause of the ~11pp of pure waste)

`dispatch()` in `src/lifecycle/node-actor-manager.ts` wraps every sandbox run in
the daemon-wide `sandboxLimiter()` (`DEFAULT_MAX_CONCURRENT = 2`). Child
`1a17107d` entered `SELF_EXECUTE` at 02:12:14 and then **waited 4m22s in that
queue**. `cancelSubtree` ran at 02:16:34: it delivered CANCEL to all five
children and called `deleteNodeJobs` for each. For `1a17107d` that deleted
nothing — it had no Job yet. Two seconds later the limiter handed it the freed
slot, and `dispatch` created a brand-new Job for an already-CANCELLED node,
which ran 42 turns to `{"succeeded":true,"message":"Job completed successfully"}`
at 02:21:03 — 4½ minutes after the user had their answer.

Nothing between acquiring the slot and dispatching checks whether the node is
still alive. `deleteNodeJobs` correctly kills a *running* Job (`7d28cf6e` did
stop at cancel); it cannot kill one that does not exist yet.

### The other candidates, ruled out or subordinate

- **Turns per Job (19/30/42, uncapped for `execute`)** — real, and the reason
  cache-read grows super-linearly inside a Job, but *correctly* uncapped: a
  whole-codebase bug hunt needs those turns. The fix is to pay for them once,
  not five times.
- **Model selection** — sonnet-5 is the right model for this task. Planner and
  synthesis were already on haiku and together cost 1pp of 26.
- **Repo/context payload** — already goal-aware (`DispatchContext`, 6k budget);
  `usage.input_tokens` is 22–46 per Job. Not a factor.
- **Synthesis** — already conditional, ran once on haiku for $0.03. Not a factor.
  It did run on a cancelled root, which is the same missing-cancel-check bug.
- **Concurrency** — the cap of 2 is what *contained* this; it serialised the
  children so wall-clock was 9 minutes rather than 5. It is also what created the
  4-minute queue wait that the cancel bug then turned into wasted spend.

## Fix order

1. Coherent global tasks (review / audit / investigate / analyse) stay a single
   execution — **without** losing their complexity rating, because that rating
   is what keeps them on sonnet-5 (`modelChoiceFor` reads
   `assessDecomposition(goal).complexity`). Splittability and difficulty are two
   different questions sharing one score today.
2. Never open a sandbox for a node that reached a terminal state while queued.
3. Planner turns: 15 → 2 (it used 5; with goal-aware context it does not explore).
4. Default child cap: 5 → 2.

---

# What changed, and what it is worth

Six changes. Four cut Jobs, one cuts turns, one prevents a downgrade the first
change would otherwise have caused.

| # | Change | Where | Why |
|---|---|---|---|
| 1 | Difficulty and splittability are scored separately; breadth only counts toward splitting when there is more than one *kind* of work to spread across it | `src/intelligence/decompose.ts` | Removes the planner and all children for a coherent global task, **without** demoting it: `modelChoiceFor` routes on complexity, so one shared score could not answer both questions |
| 2 | An explicit request to parallelise (`in parallel`, `across several agents`, …) always splits | `src/intelligence/decompose.ts` | Scope inference must not overrule the user saying so |
| 3 | A dispatch whose node reached a terminal state while queued opens no sandbox | `src/lifecycle/node-actor-manager.ts` (`dispatch`) | The 11pp of pure waste. One guard at the single chokepoint all three roles route through |
| 4 | Planner turn cap 15 → 2 | `src/config/efficiency.ts` | It is handed a goal-aware map and asked for a JSON array. The measured run used 5 turns exploring anyway |
| 5 | Default fan-out cap 5 → 2 (`ORG_MAX_CHILD_JOBS`) | `src/config/efficiency.ts`, `src/intelligence/plan.ts` | Five children on a broad goal mostly re-read the same repository |
| 6 | Reviewing / diagnosing / investigating is never tiered down to `fast` on complexity alone | `src/intelligence/model-router.ts` | Pre-existing: "investigate the root cause of this bug" names nothing broad, scores `low`, and `low` was the fast-tier trigger. A wrong root cause does not look like a failure the way a broken edit does |

Changes 1, 2 and 6 sit behind the existing `ORG_EFFICIENCY_MODE` switch, so
`node bench/run.mjs efficiency` is a true A/B. Change 3 does not: nobody wants
the arm that pays for discarded work. Changes 4 and 5 have their own knobs.

## The decision chain, after

| goal | complexity | splits | outcome | model |
|---|---|---|---|---|
| Review the codebase and find bugs. Do not modify anything. | medium | **no** | SELF_EXECUTE | runtime default (sonnet) |
| Audit the repository for security issues | medium | **no** | SELF_EXECUTE | runtime default |
| Understand why the application is slow | low | **no** | SELF_EXECUTE | runtime default ← change 6 |
| Analyze the architecture and identify flaws | low | **no** | SELF_EXECUTE | runtime default ← change 6 |
| Investigate the root cause of this bug | low | **no** | SELF_EXECUTE | runtime default ← change 6 |
| Fix authentication, optimize the DB query layer, update the frontend, and add API tests | high | **yes** | DELEGATE | runtime default |
| Review the codebase in parallel across several agents | high | **yes** | DELEGATE | runtime default |
| Fix the typo in the README | low | no | SELF_EXECUTE | haiku |

## What is measured, and what is projected

**No A/B benchmark was run.** `bench/run.mjs` needs a live cluster and makes
real paid calls; the "off" arm is by definition the behaviour that costs 26% of a
window per broad review, and five goals × two arms would spend several windows to
confirm a number the ledger already explains. The switch is wired so it can be
run on request — it is a deliberate omission, not an oversight.

So the table below separates the two honestly.

### Certain — arithmetic on the recorded ledger, no modelling

Replaying the recorded request through the new decision chain (proved by the
integration test *"does not buy a planner, children or a synthesis run for a
global review"*: one dispatch, zero children):

| | before | after | |
|---|---|---|---|
| Jobs created | 7 | **1** | −86% |
| Jobs dispatched | 6 | **1** | −83% |
| planner Jobs | 1 | **0** | |
| synthesis Jobs | 1 | **0** | |
| child Jobs | 5 (4 dispatched) | **0** | |
| planner tokens | 104,960 read / 11,852 created / 1,975 out | **0** | |
| synthesis tokens | 12,237 read / 9,918 created / 1,561 out | **0** | |
| planner + synthesis turns | 6 | **0** | |
| discarded-child spend (change 3 alone, independent of change 1) | ~2.27M read, ~64 turns, ~$1.35, **~11 of 26 window points** | **0** | |
| **spend removed with certainty** | | | **$1.42 of $2.65 — 54%** |

### Projected — the one number that needs a model

The two children that did useful work (19 and 30 turns, 1.79M cache-read,
$1.22) are replaced by one execution covering all five areas. Its turn count is
not knowable without running it, so this is a range, not a figure:

- **Floor:** no cheaper than the largest single child measured — 42 turns, 1.77M
  cache-read, $0.95, ~9 window points.
- **Ceiling:** ~1.5× that, because a single conversation extends one cached
  prefix instead of rebuilding five from zero.

→ **projected 9–14 window points against a measured 26 — a 46–65% reduction**,
of which the 11 points from change 3 are certain regardless of how the single
execution turns out.

### Latency: an honest negative

The 15–30% p50 target is **not** claimed, and the mechanism argues against it for
this task shape. Two children ran concurrently before; one execution serialises
that work. Removing the planner (26s), the synthesis run (19s) and a 4m22s queue
wait pulls the other way. Expect time-to-answer roughly flat — 5m16s measured,
~5–7min projected — with total burn falling from 9m21s to the same ~5–7min
because nothing runs on past the answer any more. For multi-workstream goals,
which still delegate, latency is unchanged.

## Top remaining bottleneck

Turns inside the one surviving Job. A 42-turn `execute` dispatch spent 1.77M
cache-read tokens; at ~1.26 growth in cache-read per turn, the conversation
prefix is re-read on every turn and dominates everything else by an order of
magnitude. `execute` is deliberately left uncapped — a whole-codebase bug hunt
needs its turns, and capping it truncates the answer rather than cheapening it.

## Next, in order, and only these two

1. **Measure before optimising further.** Run `node bench/run.mjs efficiency`
   once with the new goal set, and add `Review the codebase and find bugs` to
   `bench/goals.json`. Everything above rests on one recorded run; a second
   makes the 46–65% range a number.
2. **Cap `execute` turns as a circuit breaker, not a budget** — e.g. 60, with
   the run told to summarise when it approaches the cap rather than being cut
   off. The measured spread was 19–42 turns, so a limit at 60 costs nothing
   today and bounds the one unbounded term in the system. Do this only after (1)
   shows where real runs land.
