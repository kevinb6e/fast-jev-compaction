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
  }

  /** The provider this client resolves to, for logs and error messages. */
  get resolvedProvider(): JevProvider {
    return this.provider;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
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
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
