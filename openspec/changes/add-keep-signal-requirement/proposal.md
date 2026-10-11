# Proposal

## Why

Each host applies the pruned transcript when the reported reduction clears its
`minReductionRatio`. That check has a floor but no ceiling: a run in which Jev
drops every candidate is the largest reduction the library can produce, so the
least informative possible outcome is exactly the one the floor accepts. It is
indistinguishable from a Jev that answered zero to every question, and it leaves
the transcript with no evidence of the work while the assistant's own narration
of that work stays behind (upstream issues #53 and #65).

## What Changes

- The library exposes whether a compaction kept any of the candidates it judged,
  so a host can tell "Jev kept nothing" apart from "there was little to prune".
- The Claude Code hook, the omp extension and the OpenCode plugin treat a run
  that judged at least one candidate and dropped every one of them as carrying no
  keep signal, and use their own summarizer instead.
- New option `requireKeepSignal`, default `true`, in all three hosts: the guard
  is on for existing installs and can be turned off without a release.
- The guard does not apply when nothing was judged, so short sessions and
  transcripts with nothing to prune keep today's behaviour.

## Capabilities

### New Capabilities

- `compaction-fallback`: when a host's own summarizer runs instead of the pruned
  transcript — the reduction floor, the keep-signal requirement, and the reason
  reported for each.

### Modified Capabilities

None.

## Impact

`src/compact.ts` and `src/index.ts` (the predicate), `hooks/fast-jev.ts`,
`omp/index.ts`, `opencode/index.ts`, the root README options table and the three
adapter READMEs; tests in `tests/fast-jev-compaction.test.ts`,
`tests/hook.test.ts`, `tests/omp.test.ts`, `tests/opencode.test.ts`. The
`.claude-plugin/plugin.json` `userConfig` gains the option. Behaviour changes for
existing installs: a compaction that deletes every candidate now falls back
instead of being applied.
