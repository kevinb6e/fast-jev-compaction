# Proposal

## Why

Every place this library shortens text uses `String.slice` on UTF-16 code-unit
indices. When a cut lands between the two halves of a surrogate pair, the kept
text ends in a lone surrogate: `JSON.stringify` escapes it as `\udXXX`, the
decision endpoint rejects the request with `400: Request contains invalid
Unicode text`, and the compaction falls back to the host's own summarizer
(upstream issue #128). Where the cut lands in text the host keeps, the half
character stays in the transcript the session continues from.

## What Changes

- Cut on code-point boundaries at all four sites: the head kept from a dropped
  tool result (`truncatedResultText`, `src/compact.ts`), `truncate` and
  `abridge` in `src/state.ts` (head and tail), and the reply abridgement in
  `src/text.ts` (head and tail).
- Keep each removal note's character count equal to the characters actually
  removed, so a kept head plus its note accounts for the original length.
- No behaviour change for text that carries no astral characters.

## Capabilities

### New Capabilities

- `transcript-integrity`: the rules that keep text this library rewrites valid
  and honest at its boundaries — cuts land on code-point boundaries, and
  removal notes report what was removed.

### Modified Capabilities

None: no existing spec covers boundary handling.

## Impact

`src/compact.ts`, `src/state.ts`, `src/text.ts`; tests in
`tests/fast-jev-compaction.test.ts` and `tests/text-blocks.test.ts`. All three
files are shared core, so the Claude Code hook, the omp extension, the OpenCode
plugin and direct library consumers all take the fix. The reply abridgement in
`src/text.ts` is this fork's own code (added with text-block compaction) and is
not covered by any upstream PR: #110 fixes the tool-result head, #132 and #135
the `src/state.ts` helpers.
