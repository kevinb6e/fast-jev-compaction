# fast-jev-compaction

Verbatim, Jev-scored context compaction for coding agents. Every tool call and
result is scored in one fast request; stale ones are dropped or truncated and
everything kept stays verbatim. One scoring core (`src/`) drives adapters for
several harnesses, and is usable on its own as an npm library.

No API key is needed: without one, the OpenCode plugin reaches Jev at
[OpenCode Zen](https://opencode.ai/docs/zen), whose `jev-1.13-free` model is
free and unauthenticated. The Claude Code hook and omp resolve TypeSafe and
report the missing key, so set `provider: "zen"` there to use the free endpoint
instead. Set `TYPESAFE_API_KEY` to use TypeSafe's own endpoint.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is an npm package (`src/`) plus one adapter per harness: a Claude
Code function-hook plugin (`hooks/`, `.claude-plugin/`), an OpenCode plugin
(`opencode/`) and an omp extension (`omp/`). All three feed their host's
compaction through the same core and replace its summary with the original
messages.

## Harnesses

Each adapter is a thin layer over the shared core. It hands the harness's
compaction hook a Jev-pruned transcript, and steps aside — leaving the
harness's own summarizer to run — when Jev fails, the history is too short to
shrink, the reduction is below `minReductionRatio`, or Jev kept none of the
calls it judged while the `requireKeepSignal` guard is on (the guard is off
by default in the Claude Code and omp adapters; the OpenCode plugin does not
have it — its pruning is continuous, so there is no result to fall back
from). Nothing about the
adapter changes the scoring; see [How it works](#how-it-works).

| Harness | Entry point | Installed as |
| --- | --- | --- |
| Claude Code | [`hooks/fast-jev.ts`](hooks/fast-jev.ts) | a function-hook plugin (`.claude-plugin/`) |
| OpenCode (V2) | [`opencode/index.ts`](opencode/index.ts) | an OpenCode plugin |
| omp (oh-my-pi) | [`omp/index.ts`](omp/index.ts) | an omp extension |

**Codex and Pi are not supported.** Codex's hook system cannot replace a
compaction result, only observe it before the summary runs, so the pruning this
library does has nowhere to land; Pi is a separate ecosystem with its own
extension packaging. Both would need their own adapter — the core in `src/` is
harness-agnostic, so an adapter is mostly a message-shape translation.

### Claude Code

`hooks/fast-jev.ts` feeds `session.compact` transcripts through `src/` and falls
back to Claude Code's built-in summary on errors or insufficient reduction. See
[`hooks/README.md`](hooks/README.md) for configuration and the Claude Code type
reference.

Function hooks are an early-access Claude Code feature (2.1.274+), so the opt-in
flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Then add this repository as a plugin marketplace and install the plugin, either
from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add kevinb6e/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (`provider`, `apiKey`, thresholds,
`truncateHeadChars`, …); leave them at their defaults to resolve the provider and
key from the environment. Restart Claude Code or run `/reload-plugins`. From
then on `/compact` (and auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

### OpenCode

`opencode/server.js` (bundled from `src/opencode/`) is an OpenCode plugin for
both plugin APIs: OpenCode 1 (`@opencode-ai/plugin` hooks) and OpenCode 2
(`@opencode/plugin` `setup(ctx)`); each host reads the one it knows. Neither
OpenCode line has a hook that hands back the messages a compaction should
produce, so the plugin prunes continuously instead: before every model request
it asks Jev about stale tool calls, remembers the decisions per session and
applies them to that request and every later one. OpenCode 2 additionally
supplies a verbatim checkpoint from its `compaction` hook whenever the pruned
history fits `checkpointTokens`, so `/compact` is instant and no summary is
written.

Install needs only `git` — the entry `opencode/server.js` is committed, so no
build runs:

```sh
curl -fsSL https://raw.githubusercontent.com/kevinb6e/fast-jev-compaction/main/install.sh | sh
```

On OpenCode 2 (with `opencode` on PATH) that runs `opencode plugin add` for
you; on OpenCode 1 it clones into `~/.local/share/fast-jev-compaction` and
writes one file into `~/.config/opencode/plugins/`, which either version loads
on the next start (`opencode service restart` for the background server). See
[`opencode/README.md`](opencode/README.md) for configuration.

### omp

`omp/index.ts` registers `session_before_compact`, renders Jev's pruned
transcript to text and returns it as the compaction summary, skipping omp's
summarizer. The previous summary is prepended, the turn prefix is summarised as
a second request on a split turn, and the cumulative `<files>` tag and `details`
file lists are kept up to date. The handler returns `undefined` — which runs
omp's own summarizer — on the same fallback conditions. The package manifest
declares the extension (`"omp": { "extensions": ["./omp/index.ts"] }`), so a
checkout installs directly:

```sh
omp plugin install -l /path/to/fast-jev-compaction
```

Because `omp plugin install -l` *links* the directory rather than copying it,
that path must be durable. See [`omp/README.md`](omp/README.md) for
configuration.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. Text blocks are candidates too, since in a long session the harness-injected
   bulk (skill bodies, `<local-command-stdout>` echoes, the `## Context Usage`
   report, system reminders) usually outweighs the tool output. Each block at
   least `injectedMinChars` long gets one `noul` question and shows in the state
   as an `[x3: skill ui-ux-pro-max, 44559 chars]` note; a reply at least
   `replyMinChars` long gets one too, marked `text_block`. Whatever the person
   typed is never a candidate. A block whose exact content appears again later
   is dropped as a duplicate without asking Jev. A removed block becomes a
   one-line note; an abridged reply keeps its first 600 and last 300 characters.
   Text is rewritten before calls are, and a rebuilt message keeps its tool
   uses and results as the same objects.
8. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the harness adapter) decides what to fall back to.

## Providers

Jev is served by TypeSafe, and also hosted on OpenRouter, OpenCode Console and
OpenCode Zen on the same System One API surface, so the four are a drop-in
base-URL change. OpenCode Zen's `jev-1.13-free` model is free and needs no key
at all:

```sh
export TYPESAFE_API_KEY=...      # TypeSafe directly
export OPENROUTER_API_KEY=...    # OpenRouter
export OPENCODE_API_KEY=...      # OpenCode Console (Jev 1.13) or Zen (free Jev)
# or force one when the environment is ambiguous
export FAST_JEV_PROVIDER=typesafe|openrouter|opencode|zen
```

### Environment variables per provider

Expose the key of the provider you use; the endpoint and the default model
follow from it. `JEV_BASE_URL` is the one endpoint override that applies to
every provider.

| Provider | Expose (key) | Endpoint override | Default model | Default endpoint |
| --- | --- | --- | --- | --- |
| TypeSafe | `TYPESAFE_API_KEY` | `TYPESAFE_BASE_URL` (host form) or `JEV_BASE_URL` | `jev-latest` | `https://api.typesafe.ai/v1/systemone` |
| OpenRouter | `OPENROUTER_API_KEY` | `JEV_BASE_URL` (`TYPESAFE_BASE_URL` is ignored) | `jev-latest` | `https://openrouter.ai/api/v1/systemone` |
| OpenCode Console | `OPENCODE_API_KEY` | `JEV_BASE_URL` (`TYPESAFE_BASE_URL` is ignored) | `jev-1.13` | `https://opencode.ai/inference/systemone/v1/systemone` |
| OpenCode Zen | `OPENCODE_API_KEY` (optional) | `JEV_BASE_URL` (`TYPESAFE_BASE_URL` is ignored) | `jev-1.13-free` | `https://opencode.ai/zen/v1/systemone` |

`TYPESAFE_BASE_URL` is the host form TypeSafe's own SDKs take, so
`/v1/systemone` is appended unless it is already there; it is ignored when the
resolved provider is OpenRouter or OpenCode, whose keys must meet their own
route. `FAST_JEV_PROVIDER` is the provider override, and `FAST_JEV_MODEL`
overrides the default model (see [Choosing a decision model](#choosing-a-decision-model)).

### Which one wins (priority)

**Provider** — the first rule that matches decides, in this order:

1. an explicit `provider` option;
2. `FAST_JEV_PROVIDER`, when it names `typesafe`, `openrouter`, `opencode` or
   `zen` (the hook reads it from the engine environment, then its settings `env`
   block; the omp and OpenCode adapters and the library read it from the
   process environment);
3. a `baseUrl` containing `openrouter.ai`, or `opencode.ai/zen` (Zen), or
   `opencode.ai` (Console);
4. an OpenRouter-shaped key (`sk-or-`) in **either** key variable;
5. a lone `OPENROUTER_API_KEY`;
6. a set `TYPESAFE_API_KEY`;
7. otherwise the host's own terminal: TypeSafe for the library, hook and omp,
   and OpenCode Zen's keyless free Jev for the OpenCode plugin.

So `TYPESAFE_API_KEY` outranks a set `OPENROUTER_API_KEY` (rule 6 beats rule 5)
unless that key is `sk-or-`-shaped. Rule 4 reads the key's own shape because a
key keeps it wherever it is exported — a common setup exports an OpenRouter key
as `TYPESAFE_API_KEY`, and without that rule TypeSafe would be chosen and the
request would 401. With no key at all, only the OpenCode plugin falls back to
Zen's free `jev-1.13-free`: the Claude Code hook and omp resolve TypeSafe and
report its missing key, so ask for Zen with `provider: "zen"` there. The
library's `JevClient` resolves TypeSafe and throws the same missing-key error
rather than sending a keyless request.

**API key** — an explicit `apiKey` option, then `FAST_JEV_API_KEY` (omp and
OpenCode), then the resolved provider's own variable.

**Endpoint** — an explicit `baseUrl` option, then `FAST_JEV_BASE_URL` (omp and
OpenCode), then `JEV_BASE_URL`, then `TYPESAFE_BASE_URL`, then the provider's own
URL.

**Model** — an explicit `model` option (or `FAST_JEV_MODEL`, which every host
now reads: the library, the Claude Code hook, omp and OpenCode), then the
resolved provider's default.

The model IDs are `jev-latest`, `jev-1.13`, `jev-1.13-free` (Zen's free model)
and, on OpenRouter, `typesafe/jev-1.13`.

**The transcript goes wherever the resolved endpoint points**, so a variable
exported for another tool sends it there; every host names the endpoint host in
its outcome line, so the destination is visible.

## Tuning every harness from one place

The scoring knobs (`FAST_JEV_*`) are now read by **every** adapter, not only omp,
so one block in a shell profile (`~/.zshrc`) tunes Claude Code, omp, OpenCode and
the Pi port alike. Precedence is always: **the harness's own option** (Claude Code
`userConfig`, OpenCode plugin `options`, Pi `settings.json`, omp has none) **wins,
then the environment, then the built-in default**.

| Variable | Knob (default) |
| --- | --- |
| `FAST_JEV_KEEP_THRESHOLD` | keep probability (`0.5`) |
| `FAST_JEV_PRESERVE_RECENT` | newest messages pinned (`6`) |
| `FAST_JEV_MIN_REDUCTION` | min shrink before fallback (`0.25`; not OpenCode, which prunes continuously) |
| `FAST_JEV_COMPACT_AT_PERCENT` | auto-compact context percent (`60`) |
| `FAST_JEV_MAX_STATE_TOKENS` | state budget (`25000`) |
| `FAST_JEV_MAX_REQUEST_TOKENS` | request budget (`30000`) |
| `FAST_JEV_TRUNCATE_HEAD_CHARS` | tool-result head kept (`300`) |
| `FAST_JEV_INJECTED_MIN_CHARS` / `FAST_JEV_REPLY_MIN_CHARS` | text-block floors (library) |
| `FAST_JEV_MAX_SUMMARY_TOKENS` | summary ceiling (`0` = 20% of the context compacted, min `16384`; omp) |
| `FAST_JEV_COOLDOWN_TOKENS` | Pi port cooldown (`8000`) |
| `FAST_JEV_REQUIRE_KEEP_SIGNAL` | refuse an all-drop run (`false`; `true/1/yes`) |
| `FAST_JEV_MEASURE_NATIVE_SUMMARY` | also run the host summarizer to compare (`false`; Claude Code) |

```sh
# one place for Claude Code, omp, OpenCode and Pi
export FAST_JEV_MIN_REDUCTION=0.1
export FAST_JEV_PRESERVE_RECENT=2
export FAST_JEV_KEEP_THRESHOLD=0.4
```

A malformed or out-of-range value is ignored and the default stands, so a typo
cannot silently misbehave. `src/env-config.ts` is the single source of truth for
the names; a parity test pins omp's hard-coded list to it.

## Choosing a decision model

Jev is one decision model among many. OpenRouter serves a whole class of them
on the same API, and this library speaks that protocol, so swapping one in is a
one-line change:

```sh
export FAST_JEV_MODEL=openai/gpt-6-luna-decisions   # omp and OpenCode
# the `model` plugin option for Claude Code
```

**The token budget follows the model.** The usable ceilings differ by two
orders of magnitude, and the advertised `context_length` cannot size a request:
`typesafe/jev-1.13` advertises 64 000 tokens and rejects anything above ~31 000.
The ceilings in `src/models.ts` are therefore measured against the live
endpoint, one model at a time, by growing the `state` until it answers
`max_tokens_exceeded` and keeping the largest size that passed:

| Model | Usable request tokens (measured) |
| --- | ---: |
| `openai/gpt-6-luna-decisions` | 524 288 |
| `perplexity/pplx-decider-v1.1-27b` | 150 000 (token ceiling is higher; the gateway times out first) |
| `upstage/solar-decide`, `upstage/solar-decide-flash` | 491 520 |
| `cloudflare/clef` | 458 752 |
| `cloudflare/clef-omni`, `togethercomputer/tev1-4b-experimental` | 245 760 |
| `nace-ai/drex-v1.5`, `cloudflare/clef-flash` | 122 880 |
| `liquid/d1`, `inception/mercury-decide`(`:free`) | 61 440 |
| `microsoft/microsoft-decision-1` | 30 720 |
| `typesafe/jev-1.13`, `~typesafe/jev-latest`, `jev-latest`, `jev-1.13` | 30 000 |
| `jaredpalmer/kev-4b` | 7 168 |

`maxStateTokens` and `maxRequestTokens` are then derived for you, and an
explicit value still wins. An **unlisted model gets 8 192 tokens**: a request
over the limit fails outright and hands the whole compaction back to the host's
summarizer, so an unknown model loses context rather than losing Jev. Raise it
with `maxRequestTokens` once the model's own ceiling is known.

`respan/span-01`, `respan/span-01-lite` and `respan/span-01-lite:free` are
**not** compatible: they reject this library's structured `state` and require a
string or a `{input, output}` object.

To add a model, measure it the same way and add one line to
`DECISION_MODEL_CEILINGS`.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

To call Jev through another host, expose that host's key and name the provider
with `FAST_JEV_PROVIDER` (`typesafe`, `openrouter`, `opencode` or `zen`) — the
endpoint and the default model then follow from it:

```sh
export OPENROUTER_API_KEY=...      # or OPENCODE_API_KEY / TYPESAFE_API_KEY
export FAST_JEV_PROVIDER=openrouter
```

Without any key, only the OpenCode plugin uses Zen's free Jev; the hook and omp
resolve TypeSafe and report the missing key, so ask for Zen there with
`provider: "zen"`. To use
Zen from the library, pass `{ apiKey: '', baseUrl: OPENCODE_ZEN_URL, model:
OPENCODE_ZEN_FREE_MODEL }` (both constants are exported); a key is only required
for the keyed providers, and an empty key sends no `authorization` header.

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is; the OpenCode and omp adapters translate their own shapes
to it in `src/opencode/` and `omp/index.ts`.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to the variable of the resolved provider
(`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` or `OPENCODE_API_KEY`), and an
`sk-or-`-shaped key is taken from either variable, since that is the key the
shape rule routed on. `FAST_JEV_PROVIDER` names the provider outright — it beats
`baseUrl` and the key-shape inference, and an unknown name is ignored. A supplied
`apiKey` still pins the endpoint, so pass `provider` alongside it rather than
relying on the environment. Never commit the key or put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `provider` | inferred | `typesafe`, `openrouter`, `opencode` or `zen`; set it with the `provider` option or `FAST_JEV_PROVIDER`, otherwise inferred from `baseUrl` or the key |
| `apiKey` | `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `OPENCODE_API_KEY` | API key for the provider (`compactMessages`/`JevClient`) |
| `model` | resolved provider's (`jev-1.13` on OpenCode Console, `jev-latest` otherwise) | Decision model name; see [Choosing a decision model](#choosing-a-decision-model) |
| `baseUrl` | provider endpoint | System One endpoint (`https://api.typesafe.ai/v1/systemone`, `https://openrouter.ai/api/v1/systemone` or `https://opencode.ai/inference/systemone/v1/systemone`) |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `instructions` | — | What the user asked this compaction to keep or drop (`/compact keep the auth work`), appended after the goal; truncated the way an inferred goal is |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | from the model | Estimated token ceiling for the state (25k for `jev-latest`) |
| `maxRequestTokens` | from the model | Estimated ceiling for state plus one batch of questions (30k for `jev-latest`) |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `injectedMinChars` | `1000` | Injected blocks (skill bodies, command output, reminders) at least this long are judged by Jev; `0` leaves all text alone |
| `replyMinChars` | `2000` | Assistant replies at least this long may be abridged to head and tail; `0` never abridges |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

The OpenCode and omp adapters add their own options on top (`maxSummaryTokens`,
`minReductionRatio`, `FAST_JEV_*` overrides); their READMEs are the reference.

## Measurement

The Claude Code hook logs one measurement line per compaction — whether it
replaced the history or fell back:

```
fast-jev-compaction:measure {"at":"…","trigger":"manual","outcome":"replaced",…}
```

The JSON carries the message and character counts before and after, estimated
`tokensBefore` / `tokensAfter` (the library's own estimator over the rendered
transcript, so before and after share one basis), the `reduction`, the state size and request
count, the elapsed `ms`, and the context window's real `contextTokens` /
`contextPercent` when `$.session.usage()` reports them; a fallback line adds
`fallbackReason`. This is the evidence behind the token and cost claims.

Set `metricsPath` (or export `FAST_JEV_METRICS`, read from the engine
environment) to also append the same JSON as one line to that file. The write
is best-effort: a missing file is created, and a failure is logged in one line
rather than allowed to break the compaction. `measureNativeSummary` is off by
default because, when on, a replaced compaction also runs the built-in
summarizer once to record its `nativeSummaryMessages` / `nativeSummaryTokens`
— a whole extra summarizer call — so turn it on to see kept-against-summary
rather than for routine use.

## Verifying it works

Every harness falls back to its own summarizer when Jev fails — no key, the
wrong endpoint, a transcript too short to shrink, or a decision that would
delete every candidate (every adapter applies those prunes by default) — so a
broken setup can look exactly like a working one. Each adapter names itself
when it does act:

| Harness | Where the evidence lands |
| --- | --- |
| Claude Code | Run `claude --debug`; the log in `~/.claude/debug/` carries `hooks module fast-jev-compaction ... events: session.compact,turn.complete` when it loads, and the toast reads `kept N/M messages, no summary (…)` when it replaces the summary. `claude plugin details` reports `Hooks (0)` for function-hook modules — cosmetic, not a load failure. |
| OpenCode | `[fast-jev-compaction]` lines on the console. |
| omp | `~/.omp/logs/omp.<date>.*.log`: `jev context: <before>-><after> chars, dropped=…`, or `jev context skipped: <reason>` when it decides not to act. |

## Codex

Not supported. The plugin installs (`codex plugin add fast-jev-compaction@fast-jev-compaction` after
adding this repo as a marketplace) but its hooks cannot run: Codex's hook format rejects the
function-hook module manifest, and Codex's `PreCompact`/`PostCompact` hooks cannot replace the
transcript with compacted messages — they can only veto compaction or emit a `systemMessage`.

Before blaming a harness, check the endpoint and key on their own:

```ts
import { buildJevRequest, resolveJevProvider } from 'fast-jev-compaction';
const provider = resolveJevProvider({}, process.env);
const request = buildJevRequest({ apiKey, model, baseUrl }, state, questions);
// POST request.url with request.headers/request.body: expect HTTP 200 and an `answers` object.
```

A 401 means the provider and the key disagree: the key was sent to the other
vendor's endpoint. `resolveJevProvider` above reports which provider was chosen.
See [Providers](#providers).

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.
- Nothing is redacted. The state sent to Jev carries your prompts, tool inputs
  and abridged text, so a secret pasted into a prompt or a tool input leaves the
  machine. Tool *outputs* are replaced by a note and do not.

## Development

```sh
npm install
npm run typecheck        # library + hook + adapters
npm test
npm run build
npm run bundle           # rebuild opencode/server.js after changing src/opencode/
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
