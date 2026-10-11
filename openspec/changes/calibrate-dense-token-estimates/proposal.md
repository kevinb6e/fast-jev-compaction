# Proposal

## Why

`estimateTokens` charges every run of letters the prose rate — one token per six
characters — no matter what the run contains. Hex digests, UUIDs, addresses and
base64 blobs do not compress into dictionary words: they tokenize at roughly
three characters per token. A state that fits `maxStateTokens` by the estimator
can therefore exceed the model's own ceiling and come back as
`400 max_tokens_exceeded`, which costs the whole compaction (upstream issue #81).

## What Changes

- Charge an alphanumeric run that is unlikely to be a word at least one token per
  three characters: a run mixing letters with digits, or a long, vowel-starved,
  varied run of the kind base64 and hashes produce.
- Keep the prose rate for word-like runs and for runs of one repeated character,
  which compress well.
- Keep separators and digits-only runs charged as they are today.
- Restate the estimator's calibration claim with the band measured after the
  change, since the current comment's numbers no longer describe it.

## Capabilities

### New Capabilities

- `request-budget`: how much of the transcript is sent to Jev and how that is
  measured — token estimation, state fitting, batching and the question cap.

### Modified Capabilities

None.

## Impact

`src/state.ts` (the estimator and its calibration comment); tests in
`tests/fast-jev-compaction.test.ts`. The estimator is used for the state budget,
for batching, and for the summary ceiling every host checks, so the change is
visible in all four hosts. Estimator output can only rise, which means slightly
less history fits `maxStateTokens` in state whose text is dense.
