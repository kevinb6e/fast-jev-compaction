# fast-jev-compaction

Verbatim, Jev-scored context compaction for coding agents. Every tool call and
result is scored in one fast request; stale ones are dropped or truncated and
everything kept stays verbatim. One scoring core (`src/`) drives adapters for
several harnesses, and is usable on its own as an npm library.

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
shrink, or the reduction is below `minReductionRatio`. Nothing about the
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

`opencode/index.ts` hooks `compaction`, renders Jev's pruned transcript to text
and returns it as `event.result`, skipping OpenCode's model call. The previous
summary is carried forward (read from a `compaction` part in the transcript or
from the session context), and the hook leaves `event.result` unset — which runs
OpenCode's built-in summarizer — when Jev cannot shrink the transcript enough,
the summary would exceed `maxSummaryTokens`, the previous checkpoint is
unreadable, or Jev fails. It reads its options from `opencode.json(c)` and the
`FAST_JEV_*` environment variables; see [`opencode/README.md`](opencode/README.md).

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
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the harness adapter) decides what to fall back to.

## Providers

Jev is served by TypeSafe, and also hosted on OpenRouter on the same System One
API surface, so the two are a drop-in base-URL change:

```sh
export TYPESAFE_API_KEY=...      # TypeSafe directly
export OPENROUTER_API_KEY=...    # OpenRouter
# or force one when the environment is ambiguous
export FAST_JEV_PROVIDER=openrouter
```

The provider is resolved in this order: an explicit `provider` option, then a
`baseUrl` containing `openrouter.ai`, then an OpenRouter-shaped key (`sk-or-`)
in **either** key variable, then a lone `OPENROUTER_API_KEY`, then TypeSafe.
Detection reads the key's own shape because a key keeps it wherever it is
exported — a common setup exports an OpenRouter key as `TYPESAFE_API_KEY`, and
without that rule TypeSafe would be chosen and the request would 401.

`baseUrl` always wins for the URL. The model IDs are `jev-latest`, `jev-1.13`
and, on OpenRouter, `typesafe/jev-1.13`.

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
| `openai/gpt-6-luna-decisions`, `perplexity/pplx-decider-v1.1-27b` | 524 288 |
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
to it in `opencode/index.ts` and `omp/index.ts`.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to the variable of the resolved provider
(`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`). Never commit the key or put it in
a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `provider` | inferred | `typesafe` or `openrouter`; inferred from `baseUrl` or the key |
| `apiKey` | `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` | API key for the provider (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Decision model name; see [Choosing a decision model](#choosing-a-decision-model) |
| `baseUrl` | provider endpoint | System One endpoint (`https://api.typesafe.ai/v1/systemone` or `https://openrouter.ai/api/v1/systemone`) |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | from the model | Estimated token ceiling for the state (25k for `jev-latest`) |
| `maxRequestTokens` | from the model | Estimated ceiling for state plus one batch of questions (30k for `jev-latest`) |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

The OpenCode and omp adapters add their own options on top (`maxSummaryTokens`,
`minReductionRatio`, `FAST_JEV_*` overrides); their READMEs are the reference.

## Verifying it works

Every harness falls back to its own summarizer when Jev fails — no key, the
wrong endpoint, a transcript too short to shrink — so a broken setup looks
exactly like a working one. Each adapter names itself when it does act:

| Harness | Where the evidence lands |
| --- | --- |
| Claude Code | Run `claude --debug`; the log in `~/.claude/debug/` carries `hooks module fast-jev-compaction ... events: session.compact,turn.complete` when it loads, and the toast reads `kept N/M messages, no summary (…)` when it replaces the summary. `claude plugin details` reports `Hooks (0)` for function-hook modules — cosmetic, not a load failure. |
| OpenCode | `[fast-jev-compaction]` lines on the console. |
| omp | `~/.omp/logs/omp.<date>.*.log`: `jev context: <before>-><after> chars, dropped=…`, or `jev context skipped: <reason>` when it decides not to act. |

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
