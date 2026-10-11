# Design

## Context

Four cut sites, all `String.slice` on UTF-16 code-unit indices:
`truncatedResultText` (`src/compact.ts`), `truncate` and `abridge`
(`src/state.ts`), and the reply abridgement in `src/text.ts`. Text bound for Jev
is serialized with `JSON.stringify`, which escapes a lone surrogate rather than
rejecting it, so the fault surfaces as an HTTP 400 from the endpoint and costs a
whole compaction. Text handed back to the host keeps the malformed half
character. Upstream fixes exist for the first and second sites only.

## Goals / Non-Goals

**Goals:**

- No unpaired surrogate leaves the library, into a request body or into a host
  transcript.
- Removal notes stay arithmetically consistent with the text they describe.

**Non-Goals:**

- Grapheme-cluster correctness: a cut may still land inside a combined sequence
  such as an emoji with a skin-tone modifier. The failure being fixed is invalid
  Unicode, not visual truncation.
- Changing how much text each site keeps; every budget stays as it is.

## Decisions

- **Inspect the two code units around the cut instead of converting the string.**
  A cut is safe when the unit before it is not a high surrogate or the unit after
  it is not a low surrogate; when unsafe, move the cut one unit. `Array.from`
  would give code points but allocates an array proportional to a result that can
  run to megabytes, on the compaction hot path. `Intl.Segmenter` splits grapheme
  clusters, a stricter unit than needed, and is far slower.
- **One shared helper, exported from `src/state.ts`.** The check is a few lines
  and four copies would drift; the other three sites already import from
  `src/state.ts`.
- **Move the cut, then compute the note from the moved index.** This keeps the
  note and the kept text from disagreeing, which a separately adjusted count
  would not guarantee.
- **Adjust downward for heads, upward for tails.** A head cut moves one unit
  left, a tail cut (which keeps the end of the string) moves one unit right, so
  in both cases the pair stays whole rather than being dropped.

## Risks / Trade-offs

- An adjusted head keeps one code unit less than requested. Invisible at the
  budgets in use (hundreds to thousands of characters), and the note reports the
  real number.
- A tail kept from the end can be one code unit shorter, which is the same
  trade in the other direction.
