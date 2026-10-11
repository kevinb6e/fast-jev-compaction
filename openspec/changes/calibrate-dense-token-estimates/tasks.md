# Tasks

## 1. Estimator

- [x] 1.1 Restructure `estimateTokens` into alphanumeric runs plus separators,
      keeping the current rates for words, digits and separators
- [x] 1.2 Add the dense-run test (letters with digits at eight characters or
      more; sixteen or more with few vowels and at least eight distinct
      characters) and charge `max(word rate, length / 3)`
- [ ] 1.3 Update the calibration comment with the band measured after the change

## 2. Cover the behaviour

- [x] 2.1 Test: a hex digest and a UUID are charged at least a third of their
      length in tokens
- [x] 2.2 Test: a base64-shaped blob is charged at least three characters per
      token
- [x] 2.3 Test: a prose paragraph and a run of one repeated character keep their
      previous estimates
- [x] 2.4 Test: over a mixed transcript the new estimate is never below the old
      one (pin the old implementation's expected numbers in the test)
- [x] 2.5 Run `npm test`, `npm run typecheck`
