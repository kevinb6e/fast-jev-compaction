# Tasks

## 1. Guard ordering

- [x] 1.1 In `hooks/fast-jev.ts`, claim the in-flight guard before the session
      usage read and release it in a `finally`
- [x] 1.2 Keep the below-threshold and error paths behaving as they do today,
      with the guard released

## 2. Cover the behaviour

- [x] 2.1 Test: two interleaved `turn.complete` events past the threshold start
      exactly one compaction
- [x] 2.2 Test: a throwing usage read leaves the guard released, and the next
      turn can compact
- [x] 2.3 Test: below the threshold, no compaction starts and the guard is
      released
- [x] 2.4 Run `npm test`, `npm run typecheck`
