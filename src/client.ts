import {
  apiKeyFor,
  buildJevRequest,
  environmentEndpoint,
  environmentModel,
  missingApiKeyError,
  parseJevResponse,
  resolveJevProvider,
  type JevProvider,
} from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

/** A 429 is transient; retry a few times before the host falls back. */
const MAX_429_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5_000;
const RATE_LIMIT_CAP_MS = 120_000;

/**
 * OpenRouter and Zen free tiers allow only a couple of concurrent Jev calls
 * and release a 429 after roughly a minute. Default conservatively; callers
 * can raise the concurrency for endpoints with wider quotas.
 */
function maxInFlightFor(options: JevClientOptions): number {
  const configured = Number(options.env?.FAST_JEV_MAX_IN_FLIGHT ?? 2);
  return Number.isFinite(configured) ? Math.max(1, Math.min(8, Math.floor(configured))) : 2;
}

function rateLimitCooldownMs(options: JevClientOptions): number {
  const configured = Number(options.env?.FAST_JEV_RATE_LIMIT_COOLDOWN_MS ?? 61_000);
  return Number.isFinite(configured) ? Math.max(0, Math.min(RATE_LIMIT_CAP_MS, configured)) : 61_000;
}

function retryDelayMs(
  headers: Headers | undefined,
  attempt: number,
  cooldownMs: number,
): number {
  const header = headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RATE_LIMIT_CAP_MS);
    const until = Date.parse(header);
    if (Number.isFinite(until)) return Math.min(Math.max(0, until - Date.now()), RATE_LIMIT_CAP_MS);
  }
  if (attempt < MAX_429_ATTEMPTS) return cooldownMs;
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface JevClientOptions {
  /** Defaults to the resolved provider's environment variable. */
  apiKey?: string;
  /** Defaults to the resolved provider's model (`jev-1.13` on OpenCode Console). */
  model?: string;
  /** Defaults to TypeSafe unless `baseUrl` or the environment says otherwise. */
  provider?: JevProvider;
  /** Defaults to the resolved provider's endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Where keys are looked up; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly provider: JevProvider;
  private readonly fetcher: typeof fetch;
  private readonly maxInFlight: number;
  private readonly cooldownMs: number;
  private rateLimitedUntil = 0;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: JevClientOptions = {}) {
    const env = options.env ?? process.env;
    // A supplied key pins the endpoint: only an implicit key is found by
    // inspecting the environment, so tests and callers with their own key
    // never depend on which variables happen to be exported.
    this.provider = resolveJevProvider(
      { provider: options.provider, baseUrl: options.baseUrl },
      options.apiKey === undefined ? env : undefined,
    );
    this.apiKey = options.apiKey ?? apiKeyFor(this.provider, env) ?? '';
    // The environment names the model (`FAST_JEV_MODEL`, as omp and the
    // OpenCode adapter already do) and the endpoint (`JEV_BASE_URL` /
    // `TYPESAFE_BASE_URL`); an explicit option still wins over each.
    this.model = options.model ?? environmentModel(env);
    this.baseUrl = options.baseUrl ?? environmentEndpoint(env, this.provider);
    this.fetcher = options.fetch ?? fetch;
    this.maxInFlight = maxInFlightFor(options);
    this.cooldownMs = rateLimitCooldownMs(options);
  }

  /** The provider this client resolves to, for logs and error messages. */
  get resolvedProvider(): JevProvider {
    return this.provider;
  }

  /** Cap in-flight requests so large sessions cannot burst past endpoint limits. */
  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    while (this.inFlight >= this.maxInFlight) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;
    try {
      return await run();
    } finally {
      this.inFlight -= 1;
      this.waiters.shift()?.();
    }
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    return this.withSlot(() => this.askOnce(state, questions));
  }

  private async askOnce(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    // A key is required for the keyed providers when no endpoint override is
    // set; OpenCode Zen's free Jev needs none, and an override may point at a
    // proxy that adds its own.
    if (!this.apiKey && this.provider !== 'zen' && !this.baseUrl) {
      throw missingApiKeyError(this.provider);
    }
    const request = buildJevRequest(
      {
        apiKey: this.apiKey,
        model: this.model,
        provider: this.provider,
        baseUrl: this.baseUrl,
      },
      state,
      questions,
    );
    while (Date.now() < this.rateLimitedUntil) {
      await sleep(Math.min(this.rateLimitedUntil - Date.now(), 30_000));
    }
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      if (response.ok) return parseJevResponse(response.status, true, await response.text());
      const text = await response.text();
      if (response.status === 429) {
        const delay = retryDelayMs(response.headers, attempt, this.cooldownMs);
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + delay);
        if (attempt < MAX_429_ATTEMPTS) {
          await sleep(delay);
          continue;
        }
      }
      return parseJevResponse(response.status, false, text);
    }
  }
}
