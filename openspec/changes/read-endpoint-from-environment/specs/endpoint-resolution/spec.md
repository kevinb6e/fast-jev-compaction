# Spec Delta

## Purpose

Defines how the endpoint for a decision request is chosen: an explicit
configuration wins, then environment variables in a fixed order, then the
provider's own URL.

## ADDED Requirements

### Requirement: The endpoint may come from the environment

WHEN no endpoint is configured for a host, resolution SHALL consult the
environment: `JEV_BASE_URL` as a complete endpoint URL, then `TYPESAFE_BASE_URL`
as a host with `/v1/systemone` appended unless that path is already present.

#### Scenario: Full endpoint in JEV_BASE_URL

- **WHEN** `JEV_BASE_URL` is set and no endpoint is configured
- **THEN** requests go to that URL exactly as given, with no path appended

#### Scenario: Host in TYPESAFE_BASE_URL

- **WHEN** `TYPESAFE_BASE_URL` names a host and no endpoint is configured
- **THEN** requests go to that host with `/v1/systemone` appended

#### Scenario: TYPESAFE_BASE_URL already carries the path

- **WHEN** `TYPESAFE_BASE_URL` already ends in `/v1/systemone`
- **THEN** the path is not appended a second time

#### Scenario: Both variables set

- **WHEN** both `JEV_BASE_URL` and `TYPESAFE_BASE_URL` are set
- **THEN** `JEV_BASE_URL` wins

#### Scenario: An explicit option is set

- **WHEN** a host is configured with an endpoint (including the adapter-specific
  `FAST_JEV_BASE_URL`)
- **THEN** the environment is not consulted for an endpoint

#### Scenario: Nothing is set

- **WHEN** no endpoint is configured and neither variable is set
- **THEN** the request goes to the provider's own URL, as before

### Requirement: Endpoint resolution does not change provider or key choice

The provider and the key chosen SHALL be decided exactly as before, so adding an
endpoint from the environment cannot move a request to a provider whose key is
not available.

#### Scenario: OpenRouter key with no endpoint configured

- **WHEN** the only key present is an `sk-or-` key and no endpoint is configured
- **THEN** the request goes to the OpenRouter endpoint, as before

#### Scenario: Endpoint from the environment with a TypeSafe key

- **WHEN** `TYPESAFE_BASE_URL` supplies the endpoint and the key resolves to
  TypeSafe
- **THEN** the request carries the TypeSafe key to that endpoint

### Requirement: The host environment is read where the host exposes one

Each host SHALL resolve these variables from the environment it already uses for
credentials: the engine environment and then the settings `env` block for the
Claude Code hook, the process environment for omp, and the plugin's own options
and environment for OpenCode.

#### Scenario: Value only in the settings env block

- **WHEN** the engine environment does not define the variable but the settings
  `env` block does
- **THEN** the settings value is used, matching how the API key is resolved

#### Scenario: Engine environment wins over settings

- **WHEN** both define the variable
- **THEN** the engine environment wins, matching how the API key is resolved

### Requirement: The endpoint in use is visible in diagnostics

The host SHALL report the resolved endpoint host in its outcome line or log, so
that a request redirected by the environment can be seen.

#### Scenario: Request redirected by the environment

- **WHEN** a compaction runs against an endpoint taken from the environment
- **THEN** the host's diagnostic line names that endpoint's host
