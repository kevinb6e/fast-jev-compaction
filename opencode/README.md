# fast-jev-compaction for OpenCode

Replaces OpenCode's checkpoint summary with Jev's pruned transcript: every
tool call and result in the messages being summarised is scored in one fast
request, stale ones are dropped or truncated, everything kept stays verbatim.
When Jev cannot shrink the transcript enough the plugin records nothing, and
OpenCode summarises the session itself.

## Install

Clone this repository and point `plugins` at the entry file, either with an
absolute path or with a path relative to the config file:

```jsonc
// opencode.json(c)
{
  "plugins": ["/home/you/Documents/fast-jev-compaction/opencode/index.ts"]
}
```

Plugin options go in the object form of the same entry:

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/Documents/fast-jev-compaction/opencode/index.ts",
      "options": {
        "provider": "openrouter",
        "minReductionRatio": 0.3,
        "preserveRecentMessages": 8
      }
    }
  ]
}
```

Credentials come from `options.apiKey` or, when that is absent, from the
environment: `TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` alone to call Jev
through OpenRouter (see the repository README, "OpenRouter").

## What it does

- Hooks `session.hook('compaction', …)`; `event.messages` is the older
  conversation OpenCode is about to summarise (the recent tail is kept by
  OpenCode and re-appended after the summary).
- Assistant text and tool calls, and the tool results paired with them, are
  mapped onto the library's messages; media, reasoning and effort markers are
  left out of the summary slot.
- The pruned transcript is rendered to text and returned as
  `event.result = { summary, metadata }`, which skips OpenCode's model call.
  `metadata.fastJev` records the reduction, the dropped counts and whether a
  previous summary was carried along.
- The previous summary is carried forward so later compactions keep the whole
  history: read from a `compaction` part inside the transcript when one is
  there, otherwise from `ctx.session.context()`, and prepended before a
  `---` separator.

## Fallbacks

The plugin leaves `event.result` unset, which runs OpenCode's built-in
summarizer, when:

- the reduction is below `minReductionRatio` (short sessions, or a transcript
  with little to drop);
- the rendered summary exceeds `maxSummaryTokens` (it is a full transcript
  replacement, not a condensed note);
- the previous checkpoint cannot be read into a new summary — a
  provider-encrypted `compaction` part, an unreadable previous compaction, or a
  failed `ctx.session.context()` call;
- Jev fails (missing key, HTTP error, malformed answers).

Every fallback is logged with a `[fast-jev-compaction]` prefix to OpenCode's
log; there is no notification API on the plugin context.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `provider` | inferred | `typesafe` or `openrouter`; inferred from `baseUrl` or the environment otherwise |
| `apiKey` | `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` | API key for the provider |
| `baseUrl` | provider endpoint | System One endpoint override; `JEV_BASE_URL` and `TYPESAFE_BASE_URL` are read when it is unset |
| `model` | `jev-latest` | Jev model name |
| `minReductionRatio` | `0.25` | Minimum shrink of the rendered transcript |
| `maxSummaryTokens` | `16384` | Estimated token ceiling for the summary |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

Malformed values (an unknown `provider`, a non-numeric threshold) are ignored
and the default is used.

## Caveats

- The summary slot holds a transcript, not a condensed note: tool inputs and
  kept results are reproduced verbatim, so it stays useful but longer than a
  model-written summary would be.
- Images and reasoning are dropped from the rendering; only text, tool calls
  and tool results reach the summary.
