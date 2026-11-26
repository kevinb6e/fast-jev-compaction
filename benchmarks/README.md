# Decision-model benchmark

Run date: 2026-11-26. Endpoint: `https://openrouter.ai/api/v1/systemone`.
Key: `OPENROUTER_API_KEY` from the environment. No secrets are stored here.

`bench-models.ts` patches `fetch` to record `usage` from the gateway. Results
below use the same transcript, options and three trials per model.

## Parameters — identical for every model

Only `model` changed. Everything else was held fixed:

| Parameter | Value |
| --- | --- |
| Transcript | `examples/demo.ts`, copied verbatim into `bench-models.ts` |
| Provider | `openrouter` (explicit in `JevClient`) |
| Endpoint | default `https://openrouter.ai/api/v1/systemone` (`src/request.ts:4`, `:42`) |
| Compaction options | `{ preserveRecentMessages: 2 }` |
| keepThreshold | 0.5 (`DEFAULT_OPTIONS`, `src/compact.ts:31`) |
| maxStateTokens | 25,000 (`src/compact.ts:33`) |
| maxRequestTokens | 30,000 (`src/compact.ts:34`) |
| truncateHeadChars | 300 (`src/compact.ts:35`) |
| injectedMinChars | 1,000 (`src/compact.ts:36`) |
| replyMinChars | 2,000 (`src/compact.ts:37`) |
| goal | inferred from the last user prompts (`src/state.ts`) |
| instructions | empty (`src/compact.ts:30`) |
| Trials | 3 per model, sequential |
| Transport | native `fetch`, wrapped to capture `usage.cost` and `usage.input_tokens` |

The wrapper reads the response text, records usage, then returns a new
`Response` with the same body, status and headers. `JevClient` receives the
original body unchanged. Request body is exactly `{model, state, questions}`
from `buildJevRequest` (`src/request.ts:256`).

The library path was used, not the harness adapters. The benchmark passes
explicit 25k/30k budgets, so the model-derived budgets in `applyRequestBudget`
(`src/models.ts`) did not apply. Every model ran under identical budgets.

## Context and call quantity

| Item | Value |
| --- | --- |
| Messages | 21 |
| Characters | 4,475 before compaction |
| Tool calls | 7, each paired with a result |
| Tool mix | Glob ×1, Read ×2, Bash ×3, Edit ×1 |
| `noul` questions | 14 (two per call: `call_tN`, `result_tN`) |
| Text-block candidates | 0 (`texts: 0` in stats) |
| Requests per compaction | 1 (all 14 questions batched) |
| State sent | `{context, goal, history}`; results replaced by short notes |
| Estimated state tokens | 1,139 (`stateStage: "full"`) |

Estimated state size is model-independent: one estimator for all six runs.
Reported input tokens are not. For the same state:

| Model | Reported input tokens |
| --- | ---: |
| `liquid/d1.2` | 1,787 |
| `jev-latest` → `typesafe/jev-1.14-20261014` | 1,908 |
| `baseten/groundhog-1` | 2,146 |
| `baseten/bison-1` | 2,146 |
| `heygen/heygen-decision-1-turbo` | 14,067 |
| `respan/span-02` | 14,165 |

The last two charge the whole state once per question. 14 questions turn a
1,139-token state into ~14,000 reported tokens. `STATE_PER_QUESTION_MODELS` and
`batchItems` now account for that when budgets come from `applyRequestBudget`.
With explicit 25k/30k budgets, as in this benchmark, that charge does not apply.

## Results (3 trials each)

| Model | Avg API ms (range) | Cost / run | Chars saved | Messages after |
| --- | ---: | ---: | ---: | ---: |
| `liquid/d1.2` | 365 (251–520) | $0.0000357 | 71.4% (varies) | 13 |
| `jev-latest` | 219 (216–222) | $0.0000801 | 87.1% | 7 |
| `baseten/groundhog-1` | 325 (289–373) | $0.0000751 | 82.4% | 9 |
| `baseten/bison-1` | 332 (291–364) | $0.0002146 | 66.8% | 15 |
| `heygen/heygen-decision-1-turbo` | 704 (343–1,203) | $0.0005908 | 68.4% | 15 |
| `respan/span-02` | 319 (278–379) | $0.0001417 | 78.5% | 11 |

All six returned HTTP 200 and valid `answers` objects. No fallback occurred.
Every run had `kept: 0` — no tool result stayed fully verbatim.

- `jev-latest` dropped all 7 calls.
- `groundhog-1` kept 1 call, truncated its result, dropped 6 calls.
- `span-02` kept 2 calls, truncated results, dropped 5 calls.
- `d1.2`, `bison-1`, `heygen` kept 3–4 calls, truncated results, dropped 3–4 calls.
- Only `d1.2` varied between trials: 11–15 messages, 66.7–78.5% saved.

Earlier exploratory runs of `d1.2` and `jev-latest` (9 runs each, same
transcript and options) agree: `d1.2` 64.5–69.1% saved, 267–601 ms;
`jev-latest` 87.1% saved, 177–601 ms.

## Re-run

```sh
TRIALS=3 npx tsx benchmarks/bench-models.ts \
  liquid/d1.2 jev-latest \
  baseten/groundhog-1 baseten/bison-1 \
  heygen/heygen-decision-1-turbo respan/span-02
```

A 3-trial sweep of all six models spends roughly $0.0034.

## Measured request ceilings

Largest passing input tokens from a separate padding probe, one `noul`
question. These became the entries in `src/models.ts`:

| Model | Ceiling | Wall |
| --- | ---: | --- |
| `liquid/d1.2` | 50 000 | 65 536 tokens, and 250 000 text bytes |
| `baseten/groundhog-1` | 130 000 | 131 072 |
| `baseten/bison-1` | 130 000 | 131 072 |
| `heygen/heygen-decision-1-turbo` | 260 000 | 262 144 |
| `respan/span-02` | 125 000 | ~131 072 |

`heygen` and `span-02` charge state per question. Their smaller state share and
the per-question charge in `batchItems` keep a batch inside the wall.

## Limits of this benchmark

The script passes explicit 30k/25k budgets, so it does not exercise the
model-derived budget or per-question batching added in `src/models.ts`.

One small synthetic transcript, one request per run, no text-block candidates,
no multi-batch state fitting, default threshold only. Latency includes network
variance. It does not measure quality of kept content, only what the model
chose to drop.

`respan/span-02` works here. The incompatibility note in `README.md` applies to
`span-01`, `span-01-lite` and `span-01-lite:free`, not to `span-02`.
