# fast-jev-compaction for OpenCode

An OpenCode plugin for both plugin APIs: OpenCode 1 (`@opencode-ai/plugin`
hooks) and OpenCode 2 (`@opencode/plugin` `setup(ctx)`). One entry,
`fast-jev-compaction/server` (this directory's `server.js`, bundled from
`src/opencode/`), default-exports an object carrying both a `server` function
and a `setup` function; each host reads the one it knows and ignores the
other.

Neither OpenCode line has a hook that lets a plugin hand back the messages a
compaction should produce (OpenCode 1's `experimental.session.compacting` only
changes the prompt; OpenCode 2's `compaction` hook only accepts a summary
string). So the plugin works differently from the Claude Code hook:

- **Continuous pruning (OpenCode 1 and 2).** Before every model request
  (`experimental.chat.messages.transform` in OpenCode 1, the `context` session
  hook in OpenCode 2) the plugin estimates the transcript size. Above
  `compactAtPercent` of the context window it asks Jev about every tool call
  outside the pinned first and newest messages, remembers the decisions per
  session, and applies them to that request and every later one: a
  `drop_call` removes the tool call and its result, a `drop_result` keeps the
  call and the first `truncateHeadChars` characters of its output. Jev is
  asked again only when the transcript is still above the threshold and holds
  a call it has not been asked about; a kept call can be dropped by a later
  pass, a dropped one never comes back. Because the model then sees the
  pruned history, its reported usage stays low and OpenCode's own
  auto-compaction rarely triggers. Only tool calls are candidates here:
  the library's text-block removal and reply abridging are left out so the
  remembered per-session state stays in step with what Jev was asked.
  Nothing is rewritten in the session store;
  decisions are held in memory and recomputed after a restart.
- **Verbatim checkpoint (OpenCode 2 only).** When OpenCode 2 does compact, its
  `compaction` session hook lets a plugin supply the summary and skip the
  summarising model call. The plugin runs a forced Jev pass over the history
  being summarised and, if the pruned history fits `checkpointTokens`
  (estimated), supplies it rendered verbatim (`[User]: …`, `[Assistant tool
  call]: …`, `[Tool result]: …`) instead of a summary. Above that budget the
  built-in summary runs, so a checkpoint can never be too large to fit.
  OpenCode 1 has no such hook; its built-in summary runs unchanged, over the
  pruned history.

## Install

The entry `opencode/server.js` is committed, so no build runs — install needs
only `git`:

```sh
curl -fsSL https://raw.githubusercontent.com/kevinb6e/fast-jev-compaction/main/install.sh | sh
```

On OpenCode 2 (with `opencode` on PATH) the script runs
`opencode plugin add github:kevinb6e/fast-jev-compaction` for you; on
OpenCode 1 (or with `--file`) it clones into
`~/.local/share/fast-jev-compaction` and writes
`~/.config/opencode/plugins/fast-jev-compaction.ts`, which either version
loads on the next start (`opencode service restart` for OpenCode 2's
background server). `--dir` uses an existing checkout, `--ref` picks a branch.

## Where Jev is reached

With `TYPESAFE_API_KEY` (or the `apiKey` option) the plugin uses TypeSafe's
endpoint and `jev-latest`; with `OPENROUTER_API_KEY`, OpenRouter's; without
either, OpenCode Zen's free `jev-1.13-free`, which needs no key
(`OPENCODE_API_KEY` is sent when set, which also unlocks Zen's paid
`jev-1.13`). `provider` forces one of `typesafe`, `openrouter`, `opencode`
(OpenCode Console) or `zen`; `FAST_JEV_PROVIDER` does the same from the
environment. The plugin logs which it picked at startup. If a Jev request
fails, that request goes out unpruned and nothing is asked again for
`cooldownMs`, so an unreachable endpoint costs one failure per cooldown, not
one per request.

## Configuration

Every option is read from the plugin's `options` (OpenCode 2) or the plugin
options bag (OpenCode 1), with `FAST_JEV_*` environment stand-ins:

| Option | Default | Description |
| --- | --- | --- |
| `provider` | inferred | `typesafe`, `openrouter`, `opencode` (Console) or `zen`; inferred from the keys otherwise |
| `apiKey` | provider's env var | API key; unset reaches Zen's keyless free Jev |
| `baseUrl` | provider endpoint | System One endpoint override |
| `model` | provider's | Jev model name (`jev-1.13-free` on Zen) |
| `compactAtPercent` | `60` | Percentage of the context window at which a pass runs |
| `contextTokens` | `200000` | Context window assumed when the host reports none |
| `checkpointTokens` | `40000` | Largest verbatim checkpoint supplied instead of the built-in summary (OpenCode 2) |
| `cooldownMs` | `60000` | Milliseconds without Jev requests after one fails |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

Malformed values (an unknown provider, a non-numeric threshold) are ignored
and the default is used.

## Caveats

- The summary slot of an OpenCode 2 checkpoint holds a transcript, not a
  condensed note: tool inputs and kept results are reproduced verbatim, so it
  stays useful but longer than a model-written summary would be.
- Images and reasoning are dropped from the rendering; only text, tool calls
  and tool results reach the summary.
- Decisions are remembered per session in memory only; a restart recomputes
  them, and a call Jev dropped stays dropped for the rest of the session.
- The `requireKeepSignal` guard (Claude Code, omp) does not exist here:
  pruning is continuous, so a pass where Jev drops every call it judged is
  still applied. Set `keepThreshold` higher to make Jev keep more.
