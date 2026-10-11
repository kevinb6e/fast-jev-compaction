# Spec Delta

## Purpose

Covers how the compaction core is wired into a host process: resolving options
and credentials, keeping host lifecycle events from starting work twice, and the
notices and log lines that report each outcome.

## ADDED Requirements

### Requirement: The auto-compaction guard is claimed before any await

The `turn.complete` handler SHALL claim its in-flight guard before its first
await and SHALL release it on every exit path, including a throw, so that
overlapping host events cannot both start a compaction.

#### Scenario: Two turn-complete events interleave

- **WHEN** two `turn.complete` events are handled concurrently and the context is
  past the compaction threshold
- **THEN** exactly one of them starts a compaction and the other passes the event
  through untouched

#### Scenario: Reading session usage fails

- **WHEN** the session usage read throws
- **THEN** the guard is released, the failure is logged, and a later turn can
  still compact

#### Scenario: Context below the threshold

- **WHEN** the context is below `compactAtPercent`
- **THEN** no compaction starts and the guard is released

#### Scenario: The compaction rejects

- **WHEN** the session compaction rejects for any reason
- **THEN** the guard is released
