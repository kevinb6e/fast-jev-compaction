# Spec Delta

## Purpose

Keeps the text this library rewrites valid and honest: every cut lands on a
code-point boundary, so no lone surrogate reaches a request body or a host
transcript, and every note reports the characters actually removed.

## ADDED Requirements

### Requirement: Cuts land on code-point boundaries

The library SHALL cut text between code points, never between the two halves of
a UTF-16 surrogate pair, at every site that shortens text it keeps: the head
kept from a dropped tool result, the head and tail of an abridged reply, and the
head and tail used when fitting text into the Jev state.

#### Scenario: Kept head of a dropped tool result would end inside a surrogate pair

- **WHEN** the head kept from a dropped tool result would end between the halves
  of an astral character (emoji, CJK extension)
- **THEN** the head ends one UTF-16 code unit earlier and contains no unpaired
  surrogate

#### Scenario: Abridged reply cuts head or tail inside a surrogate pair

- **WHEN** an abridged reply's head boundary or tail boundary falls inside a
  surrogate pair
- **THEN** that boundary moves by one code unit so the pair stays whole

#### Scenario: Text fitted into the Jev state ends inside a surrogate pair

- **WHEN** `truncate` or `abridge` in the state fitter would cut inside a
  surrogate pair
- **THEN** the cut moves off the pair, so the serialized request body carries no
  lone surrogate

#### Scenario: Cut already on a boundary

- **WHEN** the cut index already falls between two code points
- **THEN** the cut is unchanged

### Requirement: Removal notes count the characters actually removed

A note the library writes into shortened text SHALL report the number of
characters actually removed, so the kept text and its note account for the
original length.

#### Scenario: Note follows a boundary-adjusted cut

- **WHEN** a cut moves one code unit to avoid splitting a surrogate pair
- **THEN** the note's character count reflects the adjusted cut, not the
  requested one
