# Tasks

## 1. Library rule

- [x] 1.1 Add `hasKeepSignal(result)` to `src/compact.ts` (candidates are the
      decisions whose reason is not `pinned`; no candidates judged, or at least
      one not `drop_call`, means a signal is present) and export it from
      `src/index.ts`
- [x] 1.2 Test: every judged call dropped → false; one kept → true; one
      `drop_result` → true; nothing judged → true; only pinned → true

## 2. Claude Code hook

- [x] 2.1 Add `requireKeepSignal` to `HOOK_DEFAULTS`, `HookConfig` and
      `resolveHookConfig`, and declare it in `.claude-plugin/plugin.json`
- [x] 2.2 Apply the rule before the reduction floor and report the reason
- [x] 2.3 Test: falls back with the reason, applies when a candidate survives,
      and applies when the option is false

## 3. omp extension

- [x] 3.1 Add the option and `FAST_JEV_REQUIRE_KEEP_SIGNAL` to `OMP_DEFAULTS`,
      `OmpOptions` and `resolveOmpOptions`; return the reason from `buildSummary`
- [x] 3.2 Test in `tests/omp.test.ts`

## 4. OpenCode plugin

- [x] 4.1 Add the option to `OPENCODE_DEFAULTS` and `resolvePluginOptions`, and
      return the reason from `buildSummary`
- [x] 4.2 Test in `tests/opencode.test.ts`

## 5. Documentation

- [x] 5.1 Root README options table, plus `hooks/README.md`, `omp/README.md`,
      `opencode/README.md`: the option, its default, and the trade it makes
- [x] 5.2 Run `npm test`, `npm run typecheck`
