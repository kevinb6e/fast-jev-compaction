/**
 * How much of a decision model's context a request may use.
 *
 * The provider's advertised `context_length` cannot size a request: measured
 * against OpenRouter, `typesafe/jev-1.13` advertises 64 000 tokens and rejects
 * anything above ~31 000, while `openai/gpt-6-luna-decisions` advertises
 * 1 050 000 and accepted 524 000. The ceilings below are therefore measured,
 * one model at a time, by growing the `state` until the endpoint returns
 * `max_tokens_exceeded`, and recording the largest size that succeeded.
 *
 * Every value is the largest measured success, in input tokens as the provider
 * reported them. They are a floor on what works, not the exact wall: a request
 * at the ceiling is known to pass, which is the property the caller needs.
 */

/** Measured request ceilings of the decision models on OpenRouter. */
export const DECISION_MODEL_CEILINGS: Readonly<Record<string, number>> = {
  // measured 31 051; the shipped default was 30 000, kept so nothing changes
  'typesafe/jev-1.13': 30_000,
  '~typesafe/jev-latest': 30_000,
  // the default model name; the endpoint resolves it to the latest Jev, which
  // measured the same as jev-1.13
  'jev-latest': 30_000,
  'jev-1.13': 30_000,
  'openai/gpt-6-luna-decisions': 524_288,
  'upstage/solar-decide': 491_520,
  'upstage/solar-decide-flash': 491_520,
  'perplexity/pplx-decider-v1.1-27b': 524_288,
  'nace-ai/drex-v1.5': 122_880,
  'cloudflare/clef': 458_752,
  'cloudflare/clef-flash': 122_880,
  'cloudflare/clef-omni': 245_760,
  'liquid/d1': 61_440,
  'inception/mercury-decide': 61_440,
  'inception/mercury-decide:free': 61_440,
  'microsoft/microsoft-decision-1': 30_720,
  'togethercomputer/tev1-4b-experimental': 245_760,
  'jaredpalmer/kev-4b': 7_168,
};

/**
 * What an unlisted model gets. Deliberately small: a request over the model's
 * limit fails outright and hands the whole compaction back to the host's
 * summarizer, so an unknown model should lose context rather than lose Jev.
 * Raise it with `maxRequestTokens` once the model's own limit is known.
 */
export const UNKNOWN_MODEL_REQUEST_TOKENS = 8_192;

/** The state is the bulk of a request; 25k of a 30k request is the old ratio. */
const STATE_SHARE_OF_REQUEST = 25 / 30;

export interface RequestBudget {
  maxStateTokens: number;
  maxRequestTokens: number;
  /** Where the request ceiling came from. `fallback` means the model is unlisted. */
  source: 'measured' | 'fallback';
}

export interface RequestBudgetOverrides {
  maxStateTokens?: number;
  maxRequestTokens?: number;
}

/**
 * The token budget for one model. An explicit option always wins; otherwise the
 * request ceiling is the model's measured one, and the state takes its share.
 * Raising `maxRequestTokens` on its own raises the state with it.
 */
export function resolveRequestBudget(
  model: string | undefined,
  overrides: RequestBudgetOverrides = {},
): RequestBudget {
  const measured = model ? DECISION_MODEL_CEILINGS[model] : undefined;
  const ceiling = measured ?? UNKNOWN_MODEL_REQUEST_TOKENS;
  const maxRequestTokens = Math.max(1, Math.floor(overrides.maxRequestTokens ?? ceiling));
  return {
    maxRequestTokens,
    maxStateTokens: Math.max(
      1,
      Math.floor(overrides.maxStateTokens ?? maxRequestTokens * STATE_SHARE_OF_REQUEST),
    ),
    source: measured ? 'measured' : 'fallback',
  };
}

/**
 * Fills `maxStateTokens` and `maxRequestTokens` on an options object from the
 * model's measured ceiling, leaving anything the caller set alone. Adapters
 * call this once after resolving their own options so a model swap carries the
 * right budget with it.
 */
export function applyRequestBudget<T extends RequestBudgetOverrides & { model?: string }>(
  options: T,
): T & Pick<RequestBudget, 'maxStateTokens' | 'maxRequestTokens'> {
  const budget = resolveRequestBudget(options.model, options);
  return {
    ...options,
    maxStateTokens: budget.maxStateTokens,
    maxRequestTokens: budget.maxRequestTokens,
  };
}
