# Spec Delta

## Purpose

Covers what is sent to Jev and how that is measured: how the state is fitted to
the token budget, how many questions fit in one request, and how many tokens the
estimator says any of it costs.

## ADDED Requirements

### Requirement: Dense runs are charged at least three characters per token

The estimator SHALL charge an alphanumeric run that is unlikely to be a word at
least one token per three characters, and SHALL keep the word rate for word-like
runs.

#### Scenario: Hex digest, UUID or address

- **WHEN** the text contains a run of hex characters, a UUID, or a similar
  identifier made of letters and digits
- **THEN** that run is charged at least a third of its length in tokens

#### Scenario: Base64 blob or hash

- **WHEN** the text contains a long run that is varied but nearly vowel-free, the
  shape base64 and digests produce
- **THEN** that run is charged at least one token per three characters

#### Scenario: Ordinary prose

- **WHEN** the text is ordinary prose made of words
- **THEN** its estimate is unchanged from the previous estimator

#### Scenario: One repeated character

- **WHEN** a long run is a single character repeated
- **THEN** it stays on the word rate, because it compresses

### Requirement: The estimator never undercounts relative to its predecessor

For any text, the estimate SHALL be greater than or equal to the estimate the
previous implementation produced, so the change cannot make an unprivileged state
look smaller than it did.

#### Scenario: Monotonic over a mixed transcript

- **WHEN** a transcript mixing prose, paths, digests and base64 is estimated
- **THEN** the result is at least the previous estimator's result for the same
  text

### Requirement: The calibrated band is stated for the current estimator

The estimator's documentation SHALL state the accuracy band measured against the
usage Jev reports for real transcripts, and that band SHALL be re-measured when
the estimator changes.

#### Scenario: Comment matches measurements

- **WHEN** the estimator's behaviour changes
- **THEN** the recorded band is updated from measurements on recorded transcripts
  rather than left describing the previous implementation
