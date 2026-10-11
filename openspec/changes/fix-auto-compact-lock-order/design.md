# Design

## Context

`on('turn.complete')` in `hooks/fast-jev.ts` currently checks a module-level
`compacting` flag, then awaits `$.session.usage()`, compares the reported context
percentage against `compactAtPercent`, and only then sets the flag before calling
`$.session.compact()`. Everything between the check and the assignment is an
await, and the engine may deliver another `turn.complete` in that window.

## Goals / Non-Goals

**Goals:**

- No two auto-compactions running over the same session.
- The flag cannot be left set by an early return, a throw, or a rejected
  compaction.

**Non-Goals:**

- Guarding manual `/compact` or plugin-triggered compactions: those are called by
  the engine's own request path, and the flag exists for the auto path only.
- Serialising compactions across sessions or processes; the flag is per hook
  registration, as before.
- Adding a request deadline. That is separate work, and it is the reason the
  trade-off below needs naming.

## Decisions

- **Move the flag assignment above the `usage()` call and wrap the body in
  `try`/`finally`.** The alternative — a `Promise`-based mutex — solves the same
  interleaving with more machinery for a handler that has exactly one caller.
- **Release in `finally` rather than at each return site**, so a future edit that
  adds an exit path cannot silently wedge the flag.
- **Keep the skip silent**, as today: a turn-complete event that finds the guard
  claimed just passes the event through.

## Risks / Trade-offs

- The flag is now held across the usage read, and it is held for the whole
  compaction. A compaction that hangs holds it until the compaction settles, so
  auto-compaction stops for the session instead of racing. This makes a deadline
  on the Jev request (`JevClient` has none today) more valuable, not less: without
  one, a hung request now has a visible consequence rather than a subtle one.
