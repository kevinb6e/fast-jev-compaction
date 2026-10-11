# fast-jev-compaction

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library, and ships adapters for OpenCode (`opencode/`) and omp (`omp/`).

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is an npm package (`src/`), a Claude Code plugin (`hooks/`,
`.claude-plugin/`) that uses the package to replace Claude Code's built-in
compaction summary with the original messages, and adapters that do the same
for OpenCode (`opencode/`) and omp (`omp/`).

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
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

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
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## OpenRouter

Jev is also hosted on OpenRouter, and the System One API surface is a drop-in
base-URL change, so the library can call either provider:

```sh
export OPENROUTER_API_KEY=...   # alone, it selects OpenRouter
# or
export FAST_JEV_PROVIDER=openrouter
```

Resolution order: an explicit `provider` option, then a `baseUrl` containing
`openrouter.ai`, then the environment (a lone `OPENROUTER_API_KEY` selects
OpenRouter; `TYPESAFE_API_KEY` always wins when both are set), then TypeSafe.
`baseUrl` always wins for the URL. The model IDs are `jev-latest`, `jev-1.13`
and `typesafe/jev-1.13`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `provider` | inferred | `typesafe` or `openrouter`; inferred from `baseUrl` or the environment |
| `apiKey` | `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` | API key for the provider (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | provider endpoint | System One endpoint (`https://api.typesafe.ai/v1/systemone` or `https://openrouter.ai/api/v1/systemone`) |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## OpenCode plugin

`opencode/index.ts` is an OpenCode (V2) plugin: it hooks `compaction`, renders
Jev's pruned transcript to text and returns it as `event.result`, skipping
OpenCode's model call. The previous summary is carried forward (read from a
`compaction` part in the transcript or from the session context), and the hook
leaves `event.result` unset — which runs OpenCode's built-in summarizer —
when Jev cannot shrink the transcript enough, the summary would exceed
`maxSummaryTokens`, the previous checkpoint is unreadable, or Jev fails.
See [`opencode/README.md`](opencode/README.md) for install and configuration.

## omp extension

`omp/index.ts` is an omp (oh-my-pi) extension: it registers
`session_before_compact`, renders Jev's pruned transcript to text and returns
it as the compaction summary, skipping omp's summarizer. The previous summary
is prepended, the turn prefix is summarised as a second request on a split
turn, and the cumulative `<files>` tag and `details` file lists are kept up to
date. The handler returns `undefined` — which runs omp's own summarizer — on
the same fallback conditions. See [`omp/README.md`](omp/README.md) for install
and configuration.

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
import { buildJevRequest } from 'fast-jev-compaction';
const request = buildJevRequest({ apiKey, model, baseUrl }, state, questions);
// POST request.url with request.headers/request.body: expect HTTP 200 and an `answers` object.
```

A 401 means the provider and the key disagree — the commonest cause here is
`TYPESAFE_API_KEY` holding an OpenRouter key, since it wins whenever both are
set. See [OpenRouter](#openrouter).

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
