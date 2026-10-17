import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_SYSTEM_ONE_URL = 'https://openrouter.ai/api/v1/systemone';
export const OPENCODE_SYSTEM_ONE_URL = 'https://opencode.ai/inference/systemone/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
/** The model OpenCode Console serves when none is named; `jev-1.13` costs $0.042/M input. */
export const OPENCODE_DEFAULT_MODEL = 'jev-1.13';
/** OpenCode Zen serves the same System One API; its free Jev needs no key. */
export const OPENCODE_ZEN_URL = 'https://opencode.ai/zen/v1/systemone';
export const OPENCODE_ZEN_FREE_MODEL = 'jev-1.13-free';
export const OPENCODE_ZEN_MODEL = 'jev-1.13';

/**
 * Forces the provider when the keys alone are ambiguous: a host that keeps
 * several keys exported, or whose key is not exported under the provider's own
 * name.
 */
export const PROVIDER_OVERRIDE_ENV_KEY = 'FAST_JEV_PROVIDER';

/** Where Jev is served: TypeSafe directly, OpenRouter's System One route, OpenCode Console's, or OpenCode Zen's free one. */
export type JevProvider = 'typesafe' | 'openrouter' | 'opencode' | 'zen';

/** Everything that differs per provider: its endpoint, its key variable, and its default model. */
export interface ProviderFacts {
  /** The endpoint; a `baseUrl` override still wins. */
  url: string;
  /** The environment variable holding the provider's key. */
  envKey: string;
  /** The model to name when the caller asks for none. */
  model: string;
}

/**
 * The single per-provider record: one entry holds the endpoint, the key
 * variable, and the default model together, so the three facts cannot drift
 * apart. `PROVIDER_URLS` and `PROVIDER_ENV_KEYS` are views over it, kept
 * exported for callers that import them directly.
 */
export const PROVIDERS: Record<JevProvider, ProviderFacts> = {
  typesafe: { url: SYSTEM_ONE_URL, envKey: 'TYPESAFE_API_KEY', model: DEFAULT_MODEL },
  openrouter: { url: OPENROUTER_SYSTEM_ONE_URL, envKey: 'OPENROUTER_API_KEY', model: DEFAULT_MODEL },
  opencode: { url: OPENCODE_SYSTEM_ONE_URL, envKey: 'OPENCODE_API_KEY', model: OPENCODE_DEFAULT_MODEL },
  zen: { url: OPENCODE_ZEN_URL, envKey: 'OPENCODE_API_KEY', model: OPENCODE_ZEN_FREE_MODEL },
};

/** Projects one fact of `PROVIDERS` across every provider. */
function providerView<K extends keyof ProviderFacts>(key: K): Record<JevProvider, ProviderFacts[K]> {
  const view = {} as Record<JevProvider, ProviderFacts[K]>;
  for (const name of Object.keys(PROVIDERS) as JevProvider[]) {
    view[name] = PROVIDERS[name][key];
  }
  return view;
}

/** The endpoint of each provider; a view over `PROVIDERS`. */
export const PROVIDER_URLS = providerView('url');

/** The environment variable holding each provider's key; a view over `PROVIDERS`. */
export const PROVIDER_ENV_KEYS = providerView('envKey');

/** The prefix every OpenRouter key carries, used to spot one in either variable. */
export const OPENROUTER_KEY_PREFIX = 'sk-or-';

/** Whether a value names a provider; anything else is ignored. */
export function isJevProvider(value: unknown): value is JevProvider {
  return value === 'typesafe' || value === 'openrouter' || value === 'opencode' || value === 'zen';
}

/**
 * The model to name when the caller asks for none: the provider's own entry in
 * `PROVIDERS`. OpenCode Console serves System One under plain Jev slugs, and
 * its `jev-latest` is a TypeSafe endpoint alias.
 */
export function defaultModelFor(provider: JevProvider): string {
  return PROVIDERS[provider].model;
}

/** The missing-key error of one provider; names the variable to export. */
export function missingApiKeyError(provider: JevProvider): Error {
  return new Error(`${PROVIDERS[provider].envKey} is not configured`);
}

export interface JevEndpointOptions {
  /** Explicit provider; wins over every inference below. An unknown name is ignored. */
  provider?: JevProvider;
  /** Explicit endpoint; wins over the provider's own URL. */
  baseUrl?: string;
}

/**
 * The provider the options and the environment infer, or `undefined` when every
 * rung declines to name one. There is no terminal rung: each surface supplies
 * its own, so the one thing the surfaces differ in is written at the call site
 * that owns it instead of being baked into the shared ladder.
 *
 * Rungs, first match wins: the `provider` option, `FAST_JEV_PROVIDER`, a
 * `baseUrl` on a known host, an `sk-or-` key in either variable, a set
 * `TYPESAFE_API_KEY`, a lone `OPENROUTER_API_KEY`, a lone `OPENCODE_API_KEY`.
 * An unknown provider name is ignored, matching `FAST_JEV_PROVIDER`.
 */
export function inferJevProvider(
  options: JevEndpointOptions = {},
  env: Record<string, string | undefined> = {},
): JevProvider | undefined {
  // Validated, not trusted: `PROVIDERS` is a record over `JevProvider`, so an
  // unchecked name indexes it as `undefined` downstream.
  if (isJevProvider(options.provider)) return options.provider;
  const override = env[PROVIDER_OVERRIDE_ENV_KEY];
  if (isJevProvider(override)) return override;
  if (options.baseUrl) {
    if (/openrouter\.ai/i.test(options.baseUrl)) return 'openrouter';
    if (/opencode\.ai\/zen/i.test(options.baseUrl)) return 'zen';
    if (/opencode\.ai/i.test(options.baseUrl)) return 'opencode';
    return 'typesafe';
  }
  const typesafe = env[PROVIDERS.typesafe.envKey];
  const openrouter = env[PROVIDERS.openrouter.envKey];
  // An OpenRouter key means OpenRouter wherever it is exported: a common setup
  // puts it in `TYPESAFE_API_KEY`, which would otherwise win and 401.
  if (
    typesafe?.startsWith(OPENROUTER_KEY_PREFIX) ||
    openrouter?.startsWith(OPENROUTER_KEY_PREFIX) ||
    env[PROVIDERS.opencode.envKey]?.startsWith(OPENROUTER_KEY_PREFIX)
  ) {
    return 'openrouter';
  }
  // A set `TYPESAFE_API_KEY` outranks a lone `OPENROUTER_API_KEY`; swapping
  // these two lines misroutes that pair to OpenRouter.
  if (typesafe) return 'typesafe';
  if (openrouter) return 'openrouter';
  if (env[PROVIDERS.opencode.envKey]) return 'opencode';
  return undefined;
}

/**
 * `inferJevProvider` with TypeSafe as the terminal, the library's own default.
 * The signature is unchanged, so every existing call site keeps working.
 */
export function resolveJevProvider(
  options: JevEndpointOptions = {},
  env: Record<string, string | undefined> = {},
): JevProvider {
  return inferJevProvider(options, env) ?? 'typesafe';
}

/**
 * The key a provider is reached with: its own variable, or the `sk-or-` key that
 * selected OpenRouter. The shape rule is the router's own, checked over both
 * variables in the same order, so routing and the key lookup cannot disagree:
 * otherwise an `sk-or-` key in `TYPESAFE_API_KEY` routes to OpenRouter and then
 * goes missing, because `PROVIDERS.openrouter` names a different variable.
 */
export function apiKeyFor(
  provider: JevProvider,
  env: Record<string, string | undefined>,
): string | undefined {
  if (provider !== 'openrouter') return env[PROVIDERS[provider].envKey] || undefined;
  // Mirrors `inferJevProvider`: the shape decides which variable holds the key,
  // since a key keeps its shape wherever it is exported.
  const typesafe = env[PROVIDERS.typesafe.envKey];
  const openrouter = env[PROVIDERS.openrouter.envKey];
  const opencode = env[PROVIDERS.opencode.envKey];
  if (openrouter?.startsWith(OPENROUTER_KEY_PREFIX)) return openrouter;
  if (typesafe?.startsWith(OPENROUTER_KEY_PREFIX)) return typesafe;
  if (opencode?.startsWith(OPENROUTER_KEY_PREFIX)) return opencode;
  return openrouter || undefined;
}

export interface JevEndpoint {
  provider: JevProvider;
  url: string;
}

/** The variables an endpoint may come from, in precedence order. */
export const ENDPOINT_ENV_KEYS = {
  full: 'JEV_BASE_URL',
  host: 'TYPESAFE_BASE_URL',
} as const;

/**
 * The endpoint the environment asks for: `JEV_BASE_URL` is a whole endpoint URL,
 * `TYPESAFE_BASE_URL` is the host form TypeSafe's own SDKs take, so the System
 * One route is appended unless it is already there. `JEV_BASE_URL` wins.
 * `TYPESAFE_BASE_URL` routes to TypeSafe, so it is ignored when the resolved
 * provider is OpenRouter — sending an OpenRouter key to the TypeSafe route
 * would just 401. Anything else keeps today's behavior.
 */
export function environmentEndpoint(
  env: Record<string, string | undefined> = {},
  provider?: JevProvider,
): string | undefined {
  const full = env[ENDPOINT_ENV_KEYS.full];
  if (full) return full;
  if (provider && provider !== 'typesafe') return undefined;
  const base = env[ENDPOINT_ENV_KEYS.host]?.replace(/\/+$/, '');
  if (!base) return undefined;
  return base.endsWith('/v1/systemone') ? base : `${base}/v1/systemone`;
}

/**
 * The host of an endpoint, for diagnostics. A scheme-less value (`localhost:8080`)
 * parses as a URL with no authority, so it is retried as one; a value `URL`
 * rejects either way is returned as given.
 */
export function endpointHost(url: string): string {
  for (const candidate of [url, `http://${url}`]) {
    try {
      const { host } = new URL(candidate);
      if (host) return host;
    } catch {
      // try the next form
    }
  }
  return url;
}

/** The provider to call and the URL to reach it on. */
export function resolveJevEndpoint(
  options: JevEndpointOptions = {},
  env?: Record<string, string | undefined>,
): JevEndpoint {
  const provider = resolveJevProvider(options, env);
  return {
    provider,
    url: options.baseUrl ?? environmentEndpoint(env, provider) ?? PROVIDERS[provider].url,
  };
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
 * consulted here: without a `provider` the request goes to TypeSafe. An empty
 * `apiKey` sends no `authorization` header (OpenCode Zen's free Jev).
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
    url: params.baseUrl ?? PROVIDERS[params.provider ?? 'typesafe'].url,
    method: 'POST',
    headers: {
      ...(params.apiKey ? { authorization: `Bearer ${params.apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? defaultModelFor(params.provider ?? 'typesafe'),
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
