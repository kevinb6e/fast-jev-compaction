import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_SYSTEM_ONE_URL = 'https://openrouter.ai/api/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/** Where Jev is served: TypeSafe directly, or OpenRouter's System One route. */
export type JevProvider = 'typesafe' | 'openrouter';

/** The endpoint of each provider; a `baseUrl` override still wins. */
export const PROVIDER_URLS: Record<JevProvider, string> = {
  typesafe: SYSTEM_ONE_URL,
  openrouter: OPENROUTER_SYSTEM_ONE_URL,
};

/** The environment variable holding each provider's key. */
export const PROVIDER_ENV_KEYS: Record<JevProvider, string> = {
  typesafe: 'TYPESAFE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** The prefix every OpenRouter key carries, used to spot one in either variable. */
export const OPENROUTER_KEY_PREFIX = 'sk-or-';

/** Whether a value names a provider; anything else is ignored. */
export function isJevProvider(value: unknown): value is JevProvider {
  return value === 'typesafe' || value === 'openrouter';
}

/** The missing-key error of one provider; names the variable to export. */
export function missingApiKeyError(provider: JevProvider): Error {
  return new Error(`${PROVIDER_ENV_KEYS[provider]} is not configured`);
}

export interface JevEndpointOptions {
  /** Explicit provider; wins over every inference below. */
  provider?: JevProvider;
  /** Explicit endpoint; wins over the provider's own URL. */
  baseUrl?: string;
}

/**
 * Which provider to call: an explicit `provider`, then a `baseUrl` on
 * `openrouter.ai`, then the environment (a lone `OPENROUTER_API_KEY` means
 * OpenRouter, anything else means TypeSafe), then TypeSafe. The environment is
 * only read when a map is passed, so a caller without one is deterministic.
 */
export function resolveJevProvider(
  options: JevEndpointOptions = {},
  env: Record<string, string | undefined> = {},
): JevProvider {
  if (options.provider) return options.provider;
  if (options.baseUrl) return /openrouter\.ai/i.test(options.baseUrl) ? 'openrouter' : 'typesafe';
  const typesafe = env[PROVIDER_ENV_KEYS.typesafe];
  const openrouter = env[PROVIDER_ENV_KEYS.openrouter];
  // An OpenRouter key means OpenRouter wherever it is exported: a common setup
  // puts it in `TYPESAFE_API_KEY`, which would otherwise win and 401.
  if (typesafe?.startsWith(OPENROUTER_KEY_PREFIX) || openrouter?.startsWith(OPENROUTER_KEY_PREFIX)) {
    return 'openrouter';
  }
  if (openrouter && !typesafe) return 'openrouter';
  return 'typesafe';
}

export interface JevEndpoint {
  provider: JevProvider;
  url: string;
}

/** The provider to call and the URL to reach it on. */
export function resolveJevEndpoint(
  options: JevEndpointOptions = {},
  env?: Record<string, string | undefined>,
): JevEndpoint {
  const provider = resolveJevProvider(options, env);
  return { provider, url: options.baseUrl ?? PROVIDER_URLS[provider] };
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/**
 * The HTTP request for one Jev call, for any fetch-like transport. The caller
 * resolves the provider itself (`resolveJevProvider`), so no environment is
 * consulted here: without a `provider` the request goes to TypeSafe.
 */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    provider?: JevProvider;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? PROVIDER_URLS[params.provider ?? 'typesafe'],
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
