# Proposal

## Why

A compaction can be asked for with instructions — `/compact keep the auth work,
drop the test logs` — and those instructions never reach the decision model. The
task Jev is given comes from the configured goal or, failing that, the last three
user prompts, so the pruning is decided without the one thing the user just said
about it. The hosts already receive the text: Claude Code puts it on the event as
`instructions`, omp as `customInstructions`, which the omp README currently lists
as an unapplied caveat.

## What Changes

- Carry the host's compaction instructions into the goal Jev is given, appended
  after the configured or inferred goal so neither displaces the other.
- Wire the field through the two hosts that expose one: the Claude Code hook
  (`event.instructions`) and the omp extension
  (`event.preparation` companion field `customInstructions`).
- Bound the instructions the way a derived prompt is bounded, so a pasted
  instruction cannot make the state unfittable.

## Capabilities

### New Capabilities

- `decision-model`: what is asked of Jev and how its answers are read — the
  state's context and goal, the per-candidate questions, the thresholds, and the
  validation of answers.

### Modified Capabilities

None.

## Impact

`src/types.ts` and `src/state.ts` (the option and where the goal is composed),
`hooks/fast-jev.ts`, `omp/index.ts`, the root README options table, `omp/README.md`
(the caveat it currently documents) and `hooks/README.md`; tests in
`tests/fast-jev-compaction.test.ts`, `tests/hook.test.ts`, `tests/omp.test.ts`.
OpenCode's compaction event carries no instruction field, so that adapter is
unaffected — recorded as a non-goal rather than an omission.
