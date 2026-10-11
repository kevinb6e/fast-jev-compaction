# Tasks

## 1. Shared boundary helper

- [x] 1.1 Add a code-point-safe cut helper to `src/state.ts` (head and tail
      variants) and export it from `src/index.ts`
- [x] 1.2 Test: a cut already between two code points is returned unchanged
- [x] 1.3 Test: a cut inside a surrogate pair moves one code unit, for a head and
      for a tail

## 2. Apply at the four cut sites

- [x] 2.1 `src/compact.ts` `truncatedResultText`: cut the kept head on a
      boundary and count the note from the adjusted index
- [x] 2.2 `src/state.ts` `truncate`: same for its head
- [x] 2.3 `src/state.ts` `abridge`: same for head and tail
- [x] 2.4 `src/text.ts` reply abridgement: same for head and tail, and count the
      omitted characters from the adjusted indices

## 3. Cover the behaviour

- [x] 3.1 Test each site with an astral character straddling the boundary and
      with one aligned to it
- [x] 3.2 Test that the note's count plus the kept text equals the original
      length
- [x] 3.3 Test that a dropped result straddling the boundary leaves no lone
      surrogate in the serialized transcript, so the request body is valid
- [x] 3.4 Run `npm test`, `npm run typecheck`
