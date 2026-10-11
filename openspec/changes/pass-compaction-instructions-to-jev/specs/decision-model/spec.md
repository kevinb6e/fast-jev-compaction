# Spec Delta

## Purpose

Defines what the decision model is shown and how its answers are read: the
state's context and goal, the questions asked about each candidate, the
thresholds applied to the answers, and the validation that keeps a malformed
answer from driving a deletion.

## ADDED Requirements

### Requirement: Host compaction instructions reach the decision model

WHEN the host supplies compaction instructions AND they are not blank, the state
sent to Jev SHALL include them, appended after the configured goal or the goal
inferred from the conversation, so neither displaces the other.

#### Scenario: Instructions with a configured goal

- **WHEN** a goal is configured and the host also supplies instructions
- **THEN** the state's goal carries the configured goal first and the
  instructions after it

#### Scenario: Instructions with an inferred goal

- **WHEN** no goal is configured, the conversation provides one, and the host
  supplies instructions
- **THEN** the inferred goal is kept and the instructions are appended to it

#### Scenario: Instructions with no goal at all

- **WHEN** no goal is configured, the conversation offers no prompt, and the host
  supplies instructions
- **THEN** the instructions alone form the goal

#### Scenario: Blank or absent instructions

- **WHEN** the host supplies nothing, or supplies whitespace
- **THEN** the goal is exactly what it would have been without this change

#### Scenario: Oversized instructions

- **WHEN** the host supplies instructions longer than the bound applied to an
  inferred prompt
- **THEN** they are truncated to that bound, so the state stays fittable
