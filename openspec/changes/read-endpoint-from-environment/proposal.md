# Proposal

## Why

The decision endpoint can only be set through a host's own option (`baseUrl`) or,
in the adapters, `FAST_JEV_BASE_URL`. A user whose System One key is issued for
another host sets `TYPESAFE_BASE_URL` — the variable TypeSafe's own SDKs read —
and nothing happens: every request still goes to `api.typesafe.ai` and comes back
401, so every compaction silently falls back. Upstream carries a dozen
overlapping PRs for this one gap (#84, #90, #91, #94, #95, #96, #113, #124,
#142), which is a sign of how often it bites.

## What Changes

- Endpoint resolution consults the environment when no endpoint is configured:
  `JEV_BASE_URL` (a full endpoint URL) first, then `TYPESAFE_BASE_URL` (a host, so
  `/v1/systemone` is appended unless the value already carries that path), then
  the provider's own URL.
- Precedence is explicit option, then `JEV_BASE_URL`, then `TYPESAFE_BASE_URL`,
  then the provider default. Provider and key inference are untouched: an `sk-or-`
  key still routes to OpenRouter, and the adapter-specific `FAST_JEV_BASE_URL`
  keeps its current meaning as the explicit option.
- Each host supplies its environment: the Claude Code hook reads the engine
  environment and the settings `env` block, omp its process environment, OpenCode
  its plugin options and environment.
- The resolved endpoint host is reported alongside the existing diagnostics, so a
  transcript redirected by a stale variable is visible rather than silent.

## Capabilities

### New Capabilities

- `endpoint-resolution`: how the endpoint for a decision request is chosen —
  explicit configuration, environment variables in a fixed order, and the
  provider default.

### Modified Capabilities

None.

## Impact

`src/request.ts` (resolution), `hooks/fast-jev.ts`, `omp/index.ts`,
`opencode/index.ts` (each passes its environment), the root README, the three
adapter READMEs; tests in `tests/provider.test.ts`, `tests/hook.test.ts`,
`tests/omp.test.ts`. Installations that never set these variables behave exactly
as before; one that has `TYPESAFE_BASE_URL` exported for another tool will start
sending transcripts to that host.
