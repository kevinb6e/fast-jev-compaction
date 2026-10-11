# Design

## Context

`estimateTokens` (`src/state.ts`) walks the text and charges one token per six
characters for letter runs, half a token per digit, and 0.9 per separator. Its
comment records that this lands 2–18% above the usage Jev reports on real
transcripts, where a plain characters-per-token ratio undercounts JSON-heavy
states by up to 40%. That calibration holds for prose; it does not hold for runs
that carry no word structure. `fitState` and `batchItems` both spend the estimate
as if it were a hard budget, and each host checks its rendered summary against a
ceiling with it.

## Goals / Non-Goals

**Goals:**

- Dense payloads stop passing a budget check the model then rejects.
- Ordinary prose keeps the estimate the calibration was measured on.

**Non-Goals:**

- Exact tokenization. A real tokenizer would mean a dependency on the hot path
  and per-model vocabulary data; the estimate is a guard against overruns, not a
  billing figure.
- Handling CJK or Han text, which has its own measured rate and is tracked
  separately (upstream issue #82).

## Decisions

- **Match the shape used upstream (#85): a run is dense when it mixes letters with
  digits at eight characters or more, or when it is at least sixteen characters,
  under a quarter vowels, and made of at least eight distinct characters.** The
  second test targets base64 and digests while leaving long words alone, and the
  distinct-character floor keeps a repeated character out, which compresses well.
- **Charge the maximum of the word rate and one token per three characters**,
  rather than replacing the word rate. A dense run is never cheaper than the
  estimate that already passed, which keeps the change monotonic.
- **Separator handling stays as it is**: the previous implementation charged 0.9
  per non-alphanumeric character, and the split into runs must not change that.
- **Numbers-only runs keep the half-token-per-digit rate.** Digit runs are
  already charged densely relative to their length; the failure mode being fixed
  is letter-heavy runs.

## Risks / Trade-offs

- Estimates now run above the true count on prose carrying many long identifiers,
  so a little less history fits `maxStateTokens` than before. An overestimate
  costs state; an underestimate costs a failed compaction, which is the worse of
  the two.
- The three-characters-per-token floor is a population figure, not a guarantee
  for any single run; a run can still tokenize denser than that. It is a guard,
  and the hedge is the fitted-state stage that shrinks the state further when a
  request is rejected.
