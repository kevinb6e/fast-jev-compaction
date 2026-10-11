# Tasks

## 1. Resolution

- [x] 1.1 Extend `resolveJevEndpoint` in `src/request.ts` to consult `JEV_BASE_URL`
      then `TYPESAFE_BASE_URL` when no endpoint is configured, appending
      `/v1/systemone` for the host form only when the path is absent
- [x] 1.2 Export the endpoint-resolution rule from `src/index.ts`
- [x] 1.3 Test: full URL used verbatim; host form gets the path; path not
      doubled; `JEV_BASE_URL` wins over `TYPESAFE_BASE_URL`; explicit option wins
      over both; nothing set keeps the provider default; an `sk-or-` key still
      selects OpenRouter

## 2. Hosts

- [x] 2.1 Hook: read `JEV_BASE_URL` and `TYPESAFE_BASE_URL` by literal name in
      `getCredentials`, engine environment first then the settings `env` block
- [x] 2.2 omp: pass the same variables from its process environment when
      `FAST_JEV_BASE_URL` is not set
- [x] 2.3 OpenCode: pass them from its plugin options and environment
- [x] 2.4 Test each host resolves the environment endpoint and that an explicit
      option still wins

## 3. Diagnostics

- [x] 3.1 Name the resolved endpoint host in the hook's log line and the
      adapters' outcome lines
- [x] 3.2 Test that the reported host changes when the environment sets the
      endpoint

## 4. Documentation

- [x] 4.1 Root README and the three adapter READMEs: the two variables, the
      precedence, and the note that the transcript goes wherever the endpoint
      points
- [x] 4.2 Run `npm test`, `npm run typecheck`
