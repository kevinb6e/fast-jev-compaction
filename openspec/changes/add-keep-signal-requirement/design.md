# Design

## Context

Three hosts gate on their own `minReductionRatio`: `hooks/fast-jev.ts` (below the
floor, it hands the event back with `next(event)`), `omp/index.ts` `buildSummary`,
and `opencode/index.ts`, which returns a reason in its `SummaryOutcome`.
`CompactResult.decisions` is already public and carries one decision per
collected call, with `action` of `keep`, `drop_result` or `drop_call` and a
`reason` that is `pinned` for calls the library never judges.

## Goals / Non-Goals

**Goals:**

- One rule, applied identically by all three hosts.
- The option lives in each host, so the guard can be turned off per install
  without a release.

**Non-Goals:**

- Changing the reduction floor, the keep threshold, or the decision model.
- Second-guessing runs where something survived.
- Covering injected text blocks as candidates: for skill bodies and repeated
  command output, removal is the intended outcome, so "every block removed" is a
  normal informative run rather than a missing signal. A transcript whose only
  candidates are text blocks therefore gets no protection from this rule. This is
  a deliberate limit, not an oversight.
- Adding a deadline: a fallback still waits on the Jev request.

## Decisions

- **A predicate over the existing `decisions`, not new counters.** `hasKeepSignal`
  reads `result.decisions`: candidates are those whose reason is not `pinned`,
  and a signal is present when no candidate was judged or at least one came back
  as something other than `drop_call`. No new stats fields, and nothing for the
  three hosts to recompute differently.
- **`drop_result` counts as a signal.** That call keeps the call with a note, so
  the assistant can still see the work happened and re-run the tool; only
  `drop_call` removes the evidence while leaving the narration.
- **The option is per host, defaulting to true.** The hook reads it from plugin
  `userConfig`, omp from `FAST_JEV_REQUIRE_KEEP_SIGNAL`, OpenCode from its plugin
  options, matching how each host already resolves its other options.
- **The guard runs before the reduction floor.** With no signal, the reduction is
  usually the largest the library can produce, so checking the floor first would
  rarely matter — but ordering it first keeps the reported reason accurate.
- **Fallback mechanics are untouched**: the hook returns `next(event)`, omp
  returns `undefined`, OpenCode leaves `event.result` unset. This change only adds
  a reason to take those paths.

## Risks / Trade-offs

- A Jev that legitimately clears nothing — a transcript of spent reads — now
  falls back to a written summary instead of the pruned transcript. That is the
  intended trade: a written summary keeps the work visible, whereas the prune
  leaves narration with no evidence behind it. `requireKeepSignal: false`
  restores the previous behaviour.
- Installations that are working today may see more fallbacks after upgrading,
  with the reason given in the notification or log line.
