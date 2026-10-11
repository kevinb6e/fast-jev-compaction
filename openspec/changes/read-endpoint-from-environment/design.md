# Design

## Context

`resolveJevEndpoint(options, env)` in `src/request.ts` already takes an
environment map, but uses it only to infer the provider from which key is set;
the URL is `options.baseUrl ?? PROVIDER_URLS[provider]`. Each host resolves its
own options and passes `baseUrl` when it has one, so the environment never
reaches the URL. The Claude Code hook reads variables through `$.env.get`, which
the engine answers only for names it can find spelled out literally in the
module's source — the existing `getCredentials` has a comment saying so — and it
falls back to the settings `env` block for keys that are absent. omp reads
`FAST_JEV_BASE_URL` from its process environment, and OpenCode from its plugin
options.

## Goals / Non-Goals

**Goals:**

- A user who sets the variable TypeSafe's own tooling documents gets a working
  endpoint without knowing this plugin's option names.
- No change for installs that configure nothing.

**Non-Goals:**

- Supporting the other gateways upstream PRs added (Vercel AI Gateway, custom
  transports). An endpoint override is enough to reach any host that speaks the
  System One request shape, including a local engine.
- Changing provider or key inference, or the meaning of `FAST_JEV_BASE_URL`.

## Decisions

- **Resolution lives in `src/request.ts`** beside `resolveJevProvider`, taking
  the environment map it already accepts, so all hosts share one precedence rule
  instead of three.
- **`JEV_BASE_URL` is a full endpoint URL and `TYPESAFE_BASE_URL` is a host.** The
  second name is TypeSafe's own convention, where SDKs take an API base and append
  the route; treating a full URL as a host would produce
  `https://host/v1/systemone/v1/systemone`. The append is skipped when the path is
  already there, so pasting a full endpoint into either variable works.
- **The variables are read by literal name in the hook**, in a small map beside
  the two key variables, because the engine refuses a computed name — a loop over
  a list of names would silently resolve nothing.
- **Precedence keeps the explicit option on top.** `FAST_JEV_BASE_URL` in the
  adapters feeds the option as it does today, so an install that already uses it
  cannot be moved by a variable someone else exported.
- **The endpoint host is added to the existing diagnostics** (the host's outcome
  line and the hook's log). This is the one new behaviour not strictly implied by
  "read the endpoint from the environment": the request now goes somewhere the
  user may not have chosen, and the transcript goes with it, so the destination is
  named where the other numbers already are.

## Risks / Trade-offs

- `TYPESAFE_BASE_URL` is a name other tooling uses; a globally exported value now
  redirects where transcripts are sent. The mitigation is the reported host, not
  a prompt or a refusal, because a user who sets the variable wants exactly this.
- A host that is reachable but does not speak the System One shape fails at
  request time and falls back, which is the same failure mode as a wrong key.
