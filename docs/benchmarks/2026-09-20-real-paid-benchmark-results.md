# CherryOnTop architecture benchmark — results

Executed per `docs/benchmarks/BENCHMARK-PROMPT.md`. Two things happened that the
prompt did not anticipate: Step 2's gate failed for a reason no goal or knob
choice could fix, and it was root-caused, fixed, and committed mid-run. The
tested revision is therefore `401a241` (the prompt was written against
`573db74`), and this report documents why.

## Verdict: WIN (narrow, and only on what actually fired)

The `on` arm was cheaper and more reliable than `off` on every goal both arms
completed cleanly, with one exception (`shared-parallel-docs`). Success rate:
23/24 (`on`) vs 17/24 (`off`), and cost per success $0.53 vs $0.79. But **four
of the seven changes under test — the ones that depend on delegation — barely
fired at all** in the frozen 24-goal set, for a reason unrelated to the
architecture: the decomposition classifier only ever considers one of the 24
goals worth delegating, and even that one only splits part of the time. The
win is real but narrow: it is evidence the "full" architecture's non-delegation
improvements (context selection, model routing, the stricter split rule) work,
not evidence about work-graph scheduling, fan-out pricing, sibling sharing, or
the Action Market veto — none of which ran in the wild in this data.

**Total spend: ~$37.15** across preflight probes, root-cause diagnostics, the
fix's live verification, and the full suite.

## Configuration

| | |
|---|---|
| revision | `401a2418edccd51808348ef860d3a84ef30ce312` (not `573db74` — see §Deviation) |
| max-children | 3 |
| budget | $5 |
| spend-cap | $4 |
| model | default execute tier + haiku for plan/synthesize (sonnet unavailable this session — tiering fell back, both arms equally) |
| arms | `ORG_EFFICIENCY_MODE=enabled` (on) vs `disabled` (off) |
| date | 2026-09-19 → 2026-09-20 |
| delegation reachable | yes (`--spawn --max-children 3 --budget 5`, confirmed `delegationReachable: true`) |
| spend guard engaged | yes (`ORG_TASK_SPEND_CAP_USD=4` > 0, confirmed `spendGuardEngaged: true`) |

## Deviation from the prompt: a mid-run fix

Step 2's gate (§1) requires child nodes, a `market_authorized`/`market_vetoed`
decision, a `delegation.scheduled` event, and a working `--replay` before Step
3 may run. The prompt's own suggested goal (`shared-parallel-docs`) never even
reached a delegation decision — traced to `src/intelligence/decompose.ts`'s
classifier scoring 23 of the 24 frozen goals below its split threshold. The one
goal that does clear it (`budget-deep-single`) *did* reach `DELEGATE` with
`market_authorized: 1` — but produced zero child nodes and zero
`delegation.scheduled` events, on every attempt, across the databases'
entire multi-day accumulated history (108+ nodes, zero with `parent_id` set).

Root cause, confirmed live via `kubectl describe pod`: `forkWorkspace()`
(`src/execution/workspace-fork.ts`) built every child's isolated worktree
under `os.tmpdir()` (`/tmp`). This `kind` cluster only bind-mounts the user's
home directory into its node (`src/k8s/kind.ts`'s `extraMounts`) — never
`/tmp`. A child's pod requested `/tmp/org-fork-<hash>` as a `hostPath` volume,
which the kubelet resolves against the *node's* filesystem, not the real
host's — the mount permanently failed with `hostPath type check failed: ...
is not a directory`, and the pod hung in `ContainerCreating` forever. This
blocked **every** delegation attempt in the environment, unconditionally,
independent of goal wording, classifier score, or knob settings.

Fixed with TDD (failing test first, confirmed red, then green): `forkPath()`
now nests the fork under `basePath` (`join(basePath, '.org-forks', ...)`)
instead of `os.tmpdir()` — mirroring the identical fix `bench/lib/isolation.mjs`
already applies for goal worktrees. `basePath` is guaranteed to sit under
`$HOME` because `org run` refuses any `--repo` outside it. Verified live,
twice, after the fix: real child nodes created with correctly-nested
`repo_path`, pods reaching `1/1 Running` instead of hanging, `delegation.
scheduled` events recorded, children reaching `COMPLETE`. Full test suite
(1798 tests), typecheck, and build all pass. Committed as `401a241`.

**This means Step 3 tests the fixed runtime, not the revision the prompt
names.** The fix is necessary — `573db74` could not have exercised delegation
at all, making four of the seven changes untestable by construction — but it
is a real deviation, disclosed here rather than silently absorbed.

## Validity

**Step 3: 48 of 48 valid**, after correcting two data-quality issues, both
disclosed:

1. **Auth expired mid-run.** The `on` arm ran 1.85 hours (607 turns, 24
   goals) before the `off` arm started; by the `off` arm's 7th goal, the
   relayed Claude subscription token had expired (`org doctor`: "login
   expired at 20/9/2026, 2:40:00am"). The remaining 18 `off`-arm goals failed
   in ~8 seconds each with zero dispatches — correctly caught by the harness's
   own validity classifier as `INVALID_INFRA` ("reached FAILED without
   dispatching anything"), not folded into the regression numbers. Re-run
   cleanly via `bench/regime-runner.mjs off` after re-authenticating; all 18
   came back `VALID`.
2. **`regime-runner.mjs` doesn't populate `environmentFingerprint` or
   `models`** on its rows (`run.mjs` does; this resumable one-arm variant
   never did). Both are required for `pairKeyOf` to match a goal across arms.
   Backfilled `environmentFingerprint` from independently-verified session
   facts (same host, same Node version, same runner image, run minutes after
   the `on` arm) and `models` by re-querying `org tokens <nodeId> --json`
   for each of the 18 resumed nodes (their real dispatch data, just never
   surfaced in the row). This is a real gap in `regime-runner.mjs` worth
   fixing separately — flagged, not fixed here (out of scope for this run).

**A further 4 rows are suspect and excluded from paired statistics despite
passing the automated classifier**: `off`-arm `rich-anchored-test`,
`poor-unanchored-audit`, `poor-unanchored-question`, `poor-vague-improvement`.
All four ran in the same window as the confirmed auth failure, at $0 cost, $0
tokens, with `wallSeconds` patterns matching the later confirmed-bad batch
(one is exactly 8 seconds; another waited 427 seconds before failing with
nothing billed — consistent with the harness's own environment-retry backoff).
None trip `telemetryAnomaly`'s check, which only catches cost-with-no-tokens,
not the reverse — a real gap in `bench/lib/validity.mjs`, also flagged, not
fixed here. Excluding them leaves **44 trustworthy rows** (24 `on`, 20 `off`)
and **14 trustworthy paired goals** (down from the classifier's 17).

**Step 4: 4 of 4 valid** on the second attempt. The first attempt was killed
mid-run by a session usage-limit interruption unrelated to the benchmark
itself; retried cleanly once the limit reset.

## Did the mechanisms fire?

| # | Change | Status | Evidence |
|---|---|---|---|
| 1 | Work-graph scheduling | **DID NOT FIRE** in the official 24-goal data | Zero children created in either arm's Step 3 database (0 `on`, 2 `off` — see below). No `serializationReasons` or `cancelled` entries possible without a fan-out. |
| 2 | Real fan-out pricing | **INDIRECTLY SUPPORTED, not directly fired** | `market_authorized: 1` fired once (`budget-deep-single`, `on` arm) but produced no children. The `off` arm's old rule *did* split `novel-inventory` into 2 children — and cost 4x more than `on`'s un-split run of the same goal. Suggestive that the new architecture's stricter split gate avoids exactly the pointless fan-out the change targets, but this is the *classifier*, not the market's utility pricing specifically. |
| 3 | Cross-run knowledge | **DID NOT FIRE — write path never engaged** | `SELECT count(*) FROM knowledge` = 0 in the `on` arm's database, across the entire Step 3 + Step 4 run (26 goal-dispatches against the same DB, including the two goals Step 4 re-asked). The read side was never tested because nothing was ever written. |
| 4 | Sibling context sharing | **DID NOT FIRE** | No goal produced ≥2 siblings in the `on` arm. `shared-parallel-docs`, `shared-parallel-tests`, and `shared-write-conflict` all scored below the decomposition threshold and self-executed. |
| 5 | Conditional recovery reserve | **WIRED, never observed active** | Confirmed a real caller exists (`withReserves()` in `src/lifecycle/economic-runtime.ts`, called from the decision cycle) — this one *is* wired, unlike 1/2/4/7 in the official data. But `resources.recoveryReserve` stayed `0` across every one of the 48+4 dispatches, including the 9 that ended `FAILED`. Consistent with "clean runs unaffected" (invariant holds trivially — everything was 0), but the "does it actually help a failing run recover" half is untested: nothing in this population ever entered the in-flight failure/validation state the reserve watches for. |
| 6 | Learning loop inert | **CONFIRMED INERT — correctly** | Zero `PROMOTED` policy candidates. (Two memory rows in each arm's database contain the substring "PROMOTED" — verified by hand: both are cached file-read observations of `src/learning/policy-experiments.ts`'s own source, which defines `PROMOTED` as a union-type literal. Not runtime promotions.) |
| 7 | Action Market veto | **DID NOT FIRE** | `market_vetoed: 1` appears zero times across either arm's entire decision history. The market authorized once; it never had occasion to refuse. |

**Net: of the four delegation-dependent changes (1, 2, 4, 7), none produced a
real fan-out in the official Step 3/4 data.** The one real delegation success
in this report — 2 children, real `Running` pods, a `COMPLETE` child, a
`delegation.scheduled` event — came from my own diagnostic dispatch while
verifying the fix, run outside the benchmark's own database, with a goal
engineered to unambiguously clear the classifier (`"Split this across several
agents: benchmark X, refactor Y, document Z"`). It proves the mechanism
*works*; it is not evidence about the benchmark's 24-goal population.

## Paired results, per regime

14 trustworthy pairs across 7 of 8 regimes (`information-poor` has zero
trustworthy paired data — all three of its goals fell in the auth-failure
window). `Δ` is `on` minus `off`, negative is better for cost/turns/cache.

| regime | n | Δcost% (mean) | notes |
|---|---|---|---|
| hard-budget | 2 | −36% | `budget-deep-single` −34.9%, `budget-many-files` −37% |
| hidden-dependency | 2 | −25% | both goals, consistent direction |
| information-rich | 2 | −12% | `rich-anchored-edit` −19%, `rich-anchored-doc` −6% |
| novel | 1 | −69% | `novel-judgement`; turns +400%, cache +186% (more turns, still cheaper — smaller model/cheaper path per turn) |
| shared-information | 3 | +0.3% | `shared-parallel-docs` +47% (regression — see Attribution), `shared-parallel-tests` −19%, `shared-write-conflict` −27% (and `on` succeeded where `off` failed) |
| strategy-failure | 3 | −19% | `strategy-wrong-layer` −54% (and `on` succeeded where `off` failed), `strategy-wrong-cause` −6%, `strategy-wrong-tool` +2% |
| exploration-trap | 1 | −31% | `trap-no-such-thing` |

Sign test across all 14: 12 of 14 goals cheaper on `on`, 2 worse
(`shared-parallel-docs`, `strategy-wrong-tool`, the latter roughly flat at
+1.6%). `costPerSuccess`, whole-suite: `on` $0.53, `off` $0.79 (−33%, but this
is a total, not a per-pair mean — reported per Hard Rule #8's own caution
against reading it as the headline).

## Attribution

**`shared-parallel-docs` regression (+47% cost, +124% cache reads, `on`
worse):** delegation did not fire (confirmed: `SELF_EXECUTE`,
`reason_single_unit_of_work: 1`, `coherent_single_task: 1` — the goal names
three READMEs but the word "README" trips the classifier's `SINGLE_TARGET`
regex, cancelling the "each" breadth signal). So changes 1 and 4 — the ones
this regime exists to test — get **no credit and no blame** here; the
regression is coming from elsewhere in the "full" architecture's context
selection or turn-budget behavior on this specific goal, not from delegation
machinery. Not investigated further — out of scope for a benchmark run
(Hard Rule #10).

**`novel-inventory` ($0.25 `on` vs $0.96 `off`, 4x):** the `off` arm's old
"breadth alone splits" rule fanned this goal into 2 real children; the `on`
arm's stricter rule correctly judged it a single unit and ran once. This is
the clearest evidence in the whole run for change #2's underlying premise —
fewer pointless splits — even though the mechanism observed firing is the
decomposition classifier, not the Action Market's utility pricing specifically.

## The three re-tests

**`shared-information` was +99%.** Narrowed to roughly flat (+0.3% mean, 2 of
3 goals cheaper, and `on` succeeded on all 3 while `off` failed on one) — a
real, large improvement over the historical regression. But per Attribution
above, this is *not* because changes 1 or 4 fired; delegation never engaged on
any of the three goals in this regime. The improvement is from elsewhere in
the architecture. n=3 per regime — directionally clear, not statistically
strong.

**`hard-budget` was 61 → 146 turns.** Does not reproduce. With
`ORG_TASK_SPEND_CAP_USD=4` genuinely engaged this time, the highest turn count
observed anywhere in the hard-budget regime was 79 (`budget-broad-under-cap`,
`on` arm) — nowhere near 146. The spend guard's own `tasks stopped` counter
shows it engaged twice (`off`) and once (`on`) across the full run, confirming
it was live. The original 146-turn finding is retracted as a runtime defect:
it was the guard being unset, not the runtime misbehaving with it set.

**`strategy-failure` stopped differently from baseline.** One clean case:
`strategy-wrong-layer` — `on` reached `COMPLETE`, `off` reached `FAILED`, and
`on` was also 54% cheaper. Consistent with "the reserve helps `on` recover
where `off` stopped," but `recoveryReserve` itself was observed at 0
throughout (see mechanism #5 above) — so if something helped this goal
specifically recover, the recorded telemetry doesn't show the reserve doing
it. n=1; suggestive, not attributable to a named mechanism with confidence.

## Quality

**Not scored.** The harness's own instruction stands: "Score the rubric by
hand." Doing that properly for 48+4 dispatches — reading each goal's actual
final output against its rubric — is a separate, substantial pass this report
does not attempt. What *is* checked: no case was found among the 14
trustworthy paired goals where `on` was cheaper and `off`'s terminal state was
`COMPLETE` while `on`'s was not (Hard Rule #9's specific concern) — on the 14
trustworthy pairs, `on` succeeded on all 14, and where the two differ in
state, it is `off` that failed, never `on`. This is a proxy for quality
(terminal state), not a rubric grade.

## What this does NOT establish

- **Changes 1, 2, 4, 7** — no real evidence from the official run. The
  infrastructure now supports them (confirmed via diagnostic dispatch outside
  the benchmark's own data), but the 24-goal frozen population barely
  exercises them, independent of delegation now working. A benchmark
  re-run against goals engineered to reliably decompose (multiple named work
  types, explicit multi-agent language) would be needed to say anything about
  work-graph scheduling, fan-out pricing accuracy, sibling sharing, or the
  veto specifically.
- **Change 5** — wired, never observed active. Whether it actually helps a
  failing run recover is untested; only that it doesn't spuriously activate.
- **Quality** — rubric-graded correctness of any of the 52 dispatches'
  actual output. Terminal state (`COMPLETE`/`FAILED`) is not a quality proxy.
- **`information-poor` regime** — zero trustworthy paired data; all three
  goals fell in the auth-failure window.
- **Statistical significance** — n=14 paired goals (n=1–3 per regime) supports
  a direction, not a p-value, per the harness's own sign-test wording.

## Recommended next action

No tuning proposed — no threshold, weight, or constant in the decomposition
classifier, the Action Market, or the recovery-reserve logic is named by
anything above as the cause of a regression, so Hard Rule #10 applies. Two
narrowly-scoped follow-ups are worth a separate session, not bundled into this
report:

1. Fix `bench/regime-runner.mjs` to populate `environmentFingerprint` and
   `models` on every row, so a resumed arm pairs cleanly without a manual
   patch.
2. Tighten `telemetryAnomaly` in `bench/lib/validity.mjs` to also catch
   "real dispatches/turns recorded, zero cost and zero tokens" — the pattern
   this run's auth-expiry casualties left behind, which currently slips past
   as a genuine product `FAILED` rather than `INVALID_ENV`.

If delegation-dependent changes need real evidence, the next run should add a
handful of goals to `bench/goals.json`'s `regimes` array specifically written
to clear the decomposition classifier (multiple named work types, or explicit
"split this across N agents" language) — not to replace the frozen population,
but as a supplementary probe, per the same `--goals=` scoping this run already
used for Steps 1 and 2.
