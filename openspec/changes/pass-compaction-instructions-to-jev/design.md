# Design

## Context

The goal reaches Jev inside the fitted state: `fitState` (`src/state.ts`) sets
`goal = options.goal || goalFromMessages(messages, blocks)`, where the inferred
goal is the last three user prompts in state form, each truncated to 500
characters. The option comes from `resolveOptions` (`src/compact.ts`), whose
default is an empty string, so today the inferred goal wins whenever no goal is
configured. The hosts pass `CompactOptions` straight through; only two of them
receive instruction text from their host, and neither forwards it.

## Goals / Non-Goals

**Goals:**

- Instructions and the existing goal both survive into the state.
- One implementation, so the three adapters cannot drift.

**Non-Goals:**

- Steering the questions rather than the state. Instructions describe what the
  user cares about in the conversation, which is what the state's goal is for;
  rewriting the per-candidate questions from free text would change the decision
  model, which this change does not touch.
- OpenCode: its `SessionCompaction` event extends the session context and carries
  no instruction field, so there is nothing to forward until that host exposes
  one.
- Appending to a summary the host writes itself: this is about the transcript
  prune, not the built-in summarizer.

## Decisions

- **Compose inside `fitState`, from a new `instructions` option, rather than in
  each host.** Composing in the host would mean a host that sets `goal` from
  instructions suppresses the inferred goal, losing the task context — the
  library is the only place that knows whether a goal was configured or inferred.
- **Append after the goal with a blank line**, matching how the hook already
  separates sections elsewhere, and reject a whitespace-only value so a host that
  always sends an empty string changes nothing.
- **Bound the instructions with the same 500-character truncation used for an
  inferred prompt.** The goal is not fitted; an oversized one makes the state
  unfittable, which throws and costs the compaction. The bound is the honest fix,
  and the trade-off is that a very long instruction is cut.
- **Field names stay the hosts' own**: `event.instructions` in the hook,
  `event.customInstructions` in omp, both mapped to the library's `instructions`
  option at the call site.

## Risks / Trade-offs

- An instruction that the user expects to act as a direct order is only context
  for the scoring questions, so its effect is indirect. That is inherent in
  asking the model whether each call still matters, not something this design can
  fix.
- Truncating at 500 characters can cut a long instruction; the kept prefix is
  still the part that is read.
