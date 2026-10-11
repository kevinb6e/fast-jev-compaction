# Tasks

## 1. Library

- [x] 1.1 Add `instructions` to `CompactOptions` and to the resolved options in
      `src/compact.ts`
- [x] 1.2 In `fitState` (`src/state.ts`), append non-blank instructions to the
      configured or inferred goal, truncated to the same bound as an inferred
      prompt
- [x] 1.3 Test: configured goal plus instructions; inferred goal plus
      instructions; instructions alone; blank instructions change nothing;
      oversized instructions are truncated

## 2. Hosts

- [x] 2.1 Hook: pass `event.instructions` through to `compact`
- [x] 2.2 omp: pass `event.customInstructions` through to `compact`
- [x] 2.3 Test both hosts end to end with a stub asker, asserting the goal the
      state carries

## 3. Documentation

- [x] 3.1 Root README options table; `hooks/README.md`; drop the
      `customInstructions is not applied` caveat from `omp/README.md`
- [x] 3.2 Run `npm test`, `npm run typecheck`
