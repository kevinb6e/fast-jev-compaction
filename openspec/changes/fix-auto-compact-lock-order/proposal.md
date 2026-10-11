# Proposal

## Why

The `turn.complete` handler guards against re-entrant auto-compaction with a
`compacting` flag, but sets that flag after `await $.session.usage()`. Two
turn-complete events that interleave during that await both see the flag clear
and both call the session compaction, so a second compaction can start on a
transcript the first is already rewriting (upstream issue #35, PR #46).

## What Changes

- Claim the in-flight guard before the first await in the handler, and release it
  on every exit path, including a throw.
- Leave the trigger alone: the `compactAtPercent` comparison, what the handler
  returns, and how errors are logged all stay as they are.

## Capabilities

### New Capabilities

- `host-integration`: how the compaction core is wired into a host process —
  option and environment resolution, re-entrancy, and the notices and log lines
  each host emits.

### Modified Capabilities

None.

## Impact

`hooks/fast-jev.ts` and `tests/hook.test.ts`. Only the Claude Code hook has this
path; the omp and OpenCode adapters are driven by their own hosts' lifecycle
events and hold no in-flight flag.
