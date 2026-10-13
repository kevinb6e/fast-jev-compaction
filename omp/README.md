# fast-jev-compaction for omp (oh-my-pi)

Replaces omp's compaction summary with Jev's pruned transcript: every tool
call and result in the region omp is about to summarise is scored in one fast
request, stale ones are dropped or truncated, everything kept stays verbatim.
When Jev cannot shrink the transcript enough the extension returns nothing,
and omp summarises the session itself.

## Install

Clone this repository and point omp at the entry file, either with an absolute
path or with a path relative to the config file:

```yaml
# config.yaml
extensions:
  - /home/you/Documents/fast-jev-compaction/omp/index.ts
```

or from the shell:

```sh
omp -e /home/you/Documents/fast-jev-compaction/omp/index.ts
```

The extension is also declared in the package manifest
(`"omp": { "extensions": ["./omp/index.ts"] }`), so a checkout installed as a
package is discovered the same way.

Credentials come from the environment: `TYPESAFE_API_KEY`, or
`OPENROUTER_API_KEY` / `OPENCODE_API_KEY` alone to route Jev through OpenRouter
or OpenCode Console (see the repository README, "Providers").

## What it does

- Registers `session_before_compact`; `preparation.messagesToSummarize` is the
  region omp is about to summarise, `firstKeptEntryId` and `tokensBefore` come
  straight from the preparation, so the recent messages stay exactly where omp
  put them.
- Assistant text and tool calls, and the tool results paired with them, are
  mapped onto the library's messages; omp's own message types (shell and
  Python runs, file mentions, branch and context summaries) render as the text
  they stand for.
- The pruned transcript is rendered to text and returned as
  `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`,
  which skips omp's summarizer. `details` carries the cumulative file lists
  (`readFiles`, `modifiedFiles`) and the summary ends with the `<files>` tag
  omp keeps, so the next compaction sees the same bookkeeping.
- The previous summary is prepended before a `---` separator, so later
  compactions keep the whole history instead of starting from the pruned
  region alone. On a split turn the turn prefix is summarised as a second
  request and appended as a `**Turn Context (split turn):**` section.

## Fallbacks

The extension returns `undefined`, which runs omp's own summarizer, when:

- Jev judged at least one tool call and dropped every one of them: the largest
  reduction available is also the one that leaves the narration with no evidence
  behind it, so it is treated as no answer at all. `FAST_JEV_REQUIRE_KEEP_SIGNAL`
  set to a false value applies the prune anyway;
- the reduction is below `FAST_JEV_MIN_REDUCTION` (short sessions, or a
  transcript with little to drop);
- the rendered summary exceeds `FAST_JEV_MAX_SUMMARY_TOKENS` (it is a full
  transcript replacement, not a condensed note);
- Jev fails (missing key, HTTP error, malformed answers).

Every fallback is reported with `ctx.ui.notify(..., 'warning')`; a recorded
summary is reported with `'info'`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `FAST_JEV_PROVIDER` | inferred | `typesafe`, `openrouter` or `opencode`; inferred from `FAST_JEV_BASE_URL` or the environment otherwise |
| `FAST_JEV_API_KEY` | `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `OPENCODE_API_KEY` | API key for the provider |
| `FAST_JEV_BASE_URL` | provider endpoint | System One endpoint override; `JEV_BASE_URL` and `TYPESAFE_BASE_URL` are read when it is unset |
| `FAST_JEV_MODEL` | `jev-latest` | Jev model name |
| `FAST_JEV_GOAL` | last 3 user prompts | Ongoing task description included in the state |
| `FAST_JEV_KEEP_THRESHOLD` | `0.5` | Minimum keep probability for a call or result to stay |
| `FAST_JEV_PRESERVE_RECENT` | `6` | Newest messages never touched (the first is always kept) |
| `FAST_JEV_MAX_STATE_TOKENS` | `25000` | Estimated token ceiling for the state |
| `FAST_JEV_MAX_REQUEST_TOKENS` | `30000` | Estimated ceiling for state plus one batch of questions |
| `FAST_JEV_TRUNCATE_HEAD_CHARS` | `300` | Characters of a dropped tool result retained before its note |
| `FAST_JEV_MIN_REDUCTION` | `0.25` | Minimum shrink of the rendered transcript |
| `FAST_JEV_REQUIRE_KEEP_SIGNAL` | `true` | Fall back when Jev drops every call it judged, rather than apply the largest possible reduction |
| `FAST_JEV_MAX_SUMMARY_TOKENS` | `16384` | Estimated token ceiling for the summary |

Malformed values (an unknown provider, a non-numeric threshold) are ignored
and the default is used. Options are read once when the extension loads.

## Caveats

- The summary slot holds a transcript, not a condensed note: tool inputs and
  kept results are reproduced verbatim, so it stays useful but longer than a
  model-written summary would be.
- Images and reasoning are dropped from the rendering; only text, tool calls
  and tool results reach the summary.
- `event.customInstructions` are carried into the state's goal, so the decisions
  know what the compaction is for; they do not rewrite the summary itself.
- Installing the extension makes Jev the first pass for every compaction,
  including the strategies omp would otherwise run itself (remote, snapcompact,
  …); those run only when Jev falls back.
