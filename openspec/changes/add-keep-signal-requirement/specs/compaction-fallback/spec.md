# Spec Delta

## Purpose

Defines when a host discards the pruned transcript in favour of its own
summarizer, so that a compaction which would delete every candidate carries a
reason instead of looking like the best possible outcome.

## ADDED Requirements

### Requirement: A run that keeps no judged candidate is not applied

WHEN a compaction judged at least one candidate and dropped every judged
candidate, the host SHALL NOT apply the pruned transcript and SHALL use its own
summarizer, reporting that no keep signal was present.

#### Scenario: Every judged candidate is dropped

- **WHEN** Jev judged at least one tool call and every one of them came back
  `drop_call`
- **THEN** the host falls back to its own summarizer and reports the missing keep
  signal among its reasons

#### Scenario: A candidate survives in any form

- **WHEN** at least one judged candidate was kept whole or kept as its call with
  a truncated result (`drop_result`)
- **THEN** the pruned transcript is applied as before

#### Scenario: Nothing was judged

- **WHEN** the transcript offered no candidate to judge, because it is short or
  everything was pinned
- **THEN** the keep-signal rule does not apply and the reduction floor decides,
  as before

#### Scenario: The guard is turned off

- **WHEN** `requireKeepSignal` is set to false in the host
- **THEN** the pruned transcript is applied even though no candidate survived

### Requirement: The keep-signal rule is shared by every host

The library SHALL expose the keep-signal rule over a compaction result, so the
Claude Code hook, the omp extension and the OpenCode plugin apply one
implementation rather than each re-deriving it.

#### Scenario: Predicate over a result

- **WHEN** the rule is applied to a compaction result
- **THEN** it reports false only for a run that judged candidates and dropped all
  of them, and true for a run that kept one, a run that judged none, and a run
  whose only decisions were pinned
