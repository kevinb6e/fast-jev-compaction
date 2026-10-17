import { describe, expect, it } from 'vitest';
import { JevClient } from '../src/client.js';
import {
  apiKeyFor,
  buildJevRequest,
  defaultModelFor,
  endpointHost,
  inferJevProvider,
  isJevProvider,
  missingApiKeyError,
  OPENROUTER_SYSTEM_ONE_URL,
  PROVIDER_ENV_KEYS,
  PROVIDER_URLS,
  PROVIDERS,
  resolveJevEndpoint,
  resolveJevProvider,
  SYSTEM_ONE_URL,
} from '../src/request.js';

const state = 'history';
const questions = { t: { type: 'noul' as const, instructions: 'keep?' } };

describe('resolveJevProvider', () => {
  it('defaults to TypeSafe without an environment', () => {
    expect(resolveJevProvider()).toBe('typesafe');
    expect(resolveJevProvider({}, {})).toBe('typesafe');
    expect(resolveJevProvider({}, { TYPESAFE_API_KEY: 't' })).toBe('typesafe');
  });

  it('honours FAST_JEV_PROVIDER over every inference below it', () => {
    // A valid name wins over the keys and the baseUrl.
    expect(resolveJevProvider({}, { FAST_JEV_PROVIDER: 'opencode', TYPESAFE_API_KEY: 't' })).toBe(
      'opencode',
    );
    expect(resolveJevProvider({}, { FAST_JEV_PROVIDER: 'typesafe', OPENROUTER_API_KEY: 'sk-or-v1-abc' })).toBe(
      'typesafe',
    );
    expect(resolveJevProvider({}, { FAST_JEV_PROVIDER: 'openrouter', OPENCODE_API_KEY: 'oc' })).toBe(
      'openrouter',
    );
    // An explicit provider option still wins over the variable.
    expect(resolveJevProvider({ provider: 'typesafe' }, { FAST_JEV_PROVIDER: 'opencode' })).toBe(
      'typesafe',
    );
    // An unknown name is ignored, so the keys decide.
    expect(resolveJevProvider({}, { FAST_JEV_PROVIDER: 'openai', OPENCODE_API_KEY: 'oc' })).toBe(
      'opencode',
    );
  });

  it('prefers an explicit provider and an openrouter baseUrl', () => {
    expect(resolveJevProvider({ provider: 'openrouter' }, { TYPESAFE_API_KEY: 't' })).toBe('openrouter');
    expect(resolveJevProvider({ baseUrl: OPENROUTER_SYSTEM_ONE_URL })).toBe('openrouter');
    expect(resolveJevProvider({ baseUrl: SYSTEM_ONE_URL }, { OPENROUTER_API_KEY: 'o' })).toBe('typesafe');
    expect(resolveJevProvider({ provider: 'openrouter', baseUrl: SYSTEM_ONE_URL })).toBe('openrouter');
  });

  it('infers OpenRouter from a lone OPENROUTER_API_KEY', () => {
    expect(resolveJevProvider({}, { OPENROUTER_API_KEY: 'o' })).toBe('openrouter');
    expect(resolveJevProvider({}, { OPENROUTER_API_KEY: 'o', TYPESAFE_API_KEY: 't' })).toBe('typesafe');
  });

  it('infers OpenRouter from an OpenRouter-shaped key in either variable', () => {
    const key = 'sk-or-v1-abc';
    expect(resolveJevProvider({}, { TYPESAFE_API_KEY: key })).toBe('openrouter');
    expect(resolveJevProvider({}, { TYPESAFE_API_KEY: key, OPENROUTER_API_KEY: key })).toBe('openrouter');
    expect(resolveJevProvider({}, { OPENROUTER_API_KEY: key, TYPESAFE_API_KEY: 't' })).toBe('openrouter');
  });

  it('infers OpenCode only from a lone OPENCODE_API_KEY or an opencode baseUrl', () => {
    expect(resolveJevProvider({}, { OPENCODE_API_KEY: 'oc' })).toBe('opencode');
    expect(resolveJevProvider({ baseUrl: 'https://opencode.ai/inference/systemone/v1/systemone' })).toBe('opencode');
    // an explicit provider or any other key keeps TypeSafe / OpenRouter
    expect(resolveJevProvider({}, { OPENCODE_API_KEY: 'oc', TYPESAFE_API_KEY: 't' })).toBe('typesafe');
    expect(resolveJevProvider({}, { OPENCODE_API_KEY: 'oc', OPENROUTER_API_KEY: 'o' })).toBe('openrouter');
    expect(resolveJevProvider({ provider: 'openrouter' }, { OPENCODE_API_KEY: 'oc' })).toBe('openrouter');
  });
});

describe('resolveJevEndpoint', () => {
  it('pairs each provider with its endpoint', () => {
    expect(resolveJevEndpoint()).toEqual({ provider: 'typesafe', url: SYSTEM_ONE_URL });
    expect(resolveJevEndpoint({ provider: 'openrouter' })).toEqual({
      provider: 'openrouter',
      url: OPENROUTER_SYSTEM_ONE_URL,
    });
    expect(resolveJevEndpoint({ provider: 'opencode' })).toEqual({
      provider: 'opencode',
      url: PROVIDER_URLS.opencode,
    });
    expect(resolveJevEndpoint({}, { OPENCODE_API_KEY: 'oc' }).url).toBe(PROVIDER_URLS.opencode);
    expect(resolveJevEndpoint({}, { OPENROUTER_API_KEY: 'o' }).url).toBe(OPENROUTER_SYSTEM_ONE_URL);
  });

  it('lets a baseUrl win over the provider URL', () => {
    expect(resolveJevEndpoint({ baseUrl: 'https://proxy.local/systemone' }).url).toBe(
      'https://proxy.local/systemone',
    );
  });
});

describe('endpoint from the environment', () => {
  it('takes a full endpoint URL verbatim', () => {
    expect(resolveJevEndpoint({}, { JEV_BASE_URL: 'https://engine.local/systemone' }).url).toBe(
      'https://engine.local/systemone',
    );
  });

  it('appends the System One route to a host, but only once', () => {
    expect(resolveJevEndpoint({}, { TYPESAFE_BASE_URL: 'https://engine.local' }).url).toBe(
      'https://engine.local/v1/systemone',
    );
    expect(resolveJevEndpoint({}, { TYPESAFE_BASE_URL: 'https://engine.local/' }).url).toBe(
      'https://engine.local/v1/systemone',
    );
    expect(
      resolveJevEndpoint({}, { TYPESAFE_BASE_URL: 'https://engine.local/v1/systemone' }).url,
    ).toBe('https://engine.local/v1/systemone');
  });

  it('prefers JEV_BASE_URL over TYPESAFE_BASE_URL, and an explicit endpoint over both', () => {
    const env = { JEV_BASE_URL: 'https://jev.local', TYPESAFE_BASE_URL: 'https://ts.local' };
    expect(resolveJevEndpoint({}, env).url).toBe('https://jev.local');
    expect(resolveJevEndpoint({ baseUrl: 'https://explicit.local' }, env).url).toBe(
      'https://explicit.local',
    );
  });

  it('keeps the provider default and the OpenRouter key rule', () => {
    expect(resolveJevEndpoint({}, {}).url).toBe(SYSTEM_ONE_URL);
    expect(resolveJevEndpoint({}, { OPENROUTER_API_KEY: 'sk-or-v1-abc' }).url).toBe(
      OPENROUTER_SYSTEM_ONE_URL,
    );
    expect(
      resolveJevEndpoint({}, { TYPESAFE_BASE_URL: 'https://engine.local', TYPESAFE_API_KEY: 't' }),
    ).toEqual({ provider: 'typesafe', url: 'https://engine.local/v1/systemone' });
  });

  it('ignores TYPESAFE_BASE_URL when the OpenRouter key wins, so the key meets its own route', () => {
    expect(
      resolveJevEndpoint({}, { OPENROUTER_API_KEY: 'sk-or-v1-abc', TYPESAFE_BASE_URL: 'https://engine.local' })
        .url,
    ).toBe(OPENROUTER_SYSTEM_ONE_URL);
    expect(
      resolveJevEndpoint({ provider: 'opencode' }, { TYPESAFE_BASE_URL: 'https://engine.local' }).url,
    ).toBe('https://opencode.ai/inference/systemone/v1/systemone');
  });
});

describe('endpointHost', () => {
  it('names the host, and falls back to a value it cannot parse', () => {
    expect(endpointHost('https://api.typesafe.ai/v1/systemone')).toBe('api.typesafe.ai');
    expect(endpointHost('localhost:8080')).toBe('localhost:8080');
  });
});

describe('inferJevProvider', () => {
  it('returns undefined when every rung declines, so a host supplies its terminal', () => {
    expect(inferJevProvider()).toBeUndefined();
    expect(inferJevProvider({}, {})).toBeUndefined();
    // The library's wrapper keeps the old answer.
    expect(resolveJevProvider({}, {})).toBe('typesafe');
  });

  it('ignores an unknown provider name instead of returning it', () => {
    // Returning it verbatim made `PROVIDERS['openai']` undefined, so
    // resolveJevEndpoint, buildJevRequest and defaultModelFor threw.
    expect(inferJevProvider({ provider: 'openai' as never })).toBeUndefined();
    expect(resolveJevEndpoint({ provider: 'openai' as never }).provider).toBe('typesafe');
    expect(defaultModelFor(resolveJevProvider({ provider: 'openai' as never }))).toBe('jev-latest');
    // An unknown name falls through to the keys, like FAST_JEV_PROVIDER does.
    expect(inferJevProvider({ provider: 'openai' as never }, { OPENCODE_API_KEY: 'oc' })).toBe('opencode');
  });

  it('lets a set TYPESAFE_API_KEY outrank a lone OPENROUTER_API_KEY', () => {
    // Swapping these two rungs misroutes this pair to OpenRouter.
    expect(inferJevProvider({}, { TYPESAFE_API_KEY: 't', OPENROUTER_API_KEY: 'o' })).toBe('typesafe');
    expect(inferJevProvider({}, { OPENROUTER_API_KEY: 'o' })).toBe('openrouter');
  });

  it('is the same ladder the library resolves through', () => {
    const envs: Record<string, string | undefined>[] = [
      {},
      { TYPESAFE_API_KEY: 't' },
      { OPENROUTER_API_KEY: 'o' },
      { OPENCODE_API_KEY: 'oc' },
      { TYPESAFE_API_KEY: 't', OPENCODE_API_KEY: 'oc' },
      { TYPESAFE_API_KEY: 'sk-or-v1-abc' },
    ];
    for (const env of envs) {
      expect(resolveJevProvider({}, env)).toBe(inferJevProvider({}, env) ?? 'typesafe');
    }
  });
});

describe('apiKeyFor', () => {
  it("finds the provider's own variable", () => {
    expect(apiKeyFor('typesafe', { TYPESAFE_API_KEY: 't' })).toBe('t');
    expect(apiKeyFor('openrouter', { OPENROUTER_API_KEY: 'o' })).toBe('o');
    expect(apiKeyFor('zen', { OPENCODE_API_KEY: 'z' })).toBe('z');
  });

  it('finds an sk-or- key that selected OpenRouter from either variable', () => {
    // The shape rule routes to OpenRouter; without this the key it routed on
    // goes missing, because PROVIDERS.openrouter names OPENROUTER_API_KEY.
    const key = 'sk-or-v1-abc';
    expect(apiKeyFor('openrouter', { TYPESAFE_API_KEY: key })).toBe(key);
    expect(apiKeyFor('openrouter', { TYPESAFE_API_KEY: 't', OPENROUTER_API_KEY: key })).toBe(key);
    // A non-OpenRouter provider never borrows the other variable's key.
    expect(apiKeyFor('typesafe', { OPENROUTER_API_KEY: key })).toBeUndefined();
    expect(apiKeyFor('zen', { TYPESAFE_API_KEY: key })).toBeUndefined();
  });
});

describe('provider helpers', () => {
  it('recognises the known providers only', () => {
    expect(isJevProvider('typesafe')).toBe(true);
    expect(isJevProvider('openrouter')).toBe(true);
    expect(isJevProvider('opencode')).toBe(true);
    expect(isJevProvider('open-ai')).toBe(false);
    expect(isJevProvider(undefined)).toBe(false);
  });

  it('holds the endpoint, key variable, and model together in one record', () => {
    expect(PROVIDERS).toEqual({
      typesafe: { url: SYSTEM_ONE_URL, envKey: 'TYPESAFE_API_KEY', model: 'jev-latest' },
      openrouter: {
        url: OPENROUTER_SYSTEM_ONE_URL,
        envKey: 'OPENROUTER_API_KEY',
        model: 'jev-latest',
      },
      opencode: {
        url: 'https://opencode.ai/inference/systemone/v1/systemone',
        envKey: 'OPENCODE_API_KEY',
        model: 'jev-1.13',
      },
      zen: {
        url: 'https://opencode.ai/zen/v1/systemone',
        envKey: 'OPENCODE_API_KEY',
        model: 'jev-1.13-free',
      },
    });
    // The two exported maps are views over the record, so they cannot drift.
    for (const provider of Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]) {
      expect(PROVIDER_URLS[provider]).toBe(PROVIDERS[provider].url);
      expect(PROVIDER_ENV_KEYS[provider]).toBe(PROVIDERS[provider].envKey);
      expect(defaultModelFor(provider)).toBe(PROVIDERS[provider].model);
    }
  });

  it('names the environment variable of each provider', () => {
    expect(PROVIDER_ENV_KEYS).toEqual({
      typesafe: 'TYPESAFE_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      opencode: 'OPENCODE_API_KEY',
      zen: 'OPENCODE_API_KEY',
    });
    expect(PROVIDER_URLS).toEqual({
      typesafe: SYSTEM_ONE_URL,
      openrouter: OPENROUTER_SYSTEM_ONE_URL,
      opencode: 'https://opencode.ai/inference/systemone/v1/systemone',
      zen: 'https://opencode.ai/zen/v1/systemone',
    });
    expect(missingApiKeyError('typesafe').message).toMatch(/TYPESAFE_API_KEY/);
    expect(missingApiKeyError('openrouter').message).toMatch(/OPENROUTER_API_KEY/);
    expect(missingApiKeyError('opencode').message).toMatch(/OPENCODE_API_KEY/);
  });
});

describe('buildJevRequest', () => {
  it('targets OpenRouter when asked, TypeSafe by default', () => {
    expect(buildJevRequest({ apiKey: 'k' }, state, questions).url).toBe(SYSTEM_ONE_URL);
    expect(buildJevRequest({ apiKey: 'k', provider: 'openrouter' }, state, questions).url).toBe(
      OPENROUTER_SYSTEM_ONE_URL,
    );
  });

  it('keeps the same body and bearer header for both providers', () => {
    const request = buildJevRequest({ apiKey: 'k', provider: 'openrouter', model: 'jev-1.13' }, state, questions);
    expect(request.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(request.body)).toEqual({ model: 'jev-1.13', state, questions });
  });

  it('defaults the OpenCode model to jev-1.13 and others to jev-latest', () => {
    expect(JSON.parse(buildJevRequest({ apiKey: 'k', provider: 'opencode' }, state, questions).body).model)
      .toBe('jev-1.13');
    expect(JSON.parse(buildJevRequest({ apiKey: 'k' }, state, questions).body).model).toBe('jev-latest');
  });

  it('lets a baseUrl win over the provider URL', () => {
    const request = buildJevRequest({ apiKey: 'k', baseUrl: 'https://proxy.local/systemone' }, state, questions);
    expect(request.url).toBe('https://proxy.local/systemone');
  });
});

describe('JevClient provider resolution', () => {
  function recordingFetch() {
    const calls: { url: string; auth: string }[] = [];
    const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, auth: init?.headers?.authorization ?? '' });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ answers: {} }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  it('calls OpenRouter when only OPENROUTER_API_KEY is set', async () => {
    const { calls, fetchFn } = recordingFetch();
    const client = new JevClient({ env: { OPENROUTER_API_KEY: 'or' }, fetch: fetchFn, model: 'jev-1.13' });
    expect(client.resolvedProvider).toBe('openrouter');
    await client.ask(state, questions);
    expect(calls).toEqual([{ url: OPENROUTER_SYSTEM_ONE_URL, auth: 'Bearer or' }]);
  });

  it('prefers TypeSafe when both keys are set', async () => {
    const { calls, fetchFn } = recordingFetch();
    const client = new JevClient({ env: { OPENROUTER_API_KEY: 'or', TYPESAFE_API_KEY: 'ts' }, fetch: fetchFn });
    expect(client.resolvedProvider).toBe('typesafe');
    await client.ask(state, questions);
    expect(calls[0]?.auth).toBe('Bearer ts');
  });

  it('honours FAST_JEV_PROVIDER on the library path when no key is supplied', async () => {
    const { calls, fetchFn } = recordingFetch();
    const client = new JevClient({
      env: { FAST_JEV_PROVIDER: 'opencode', OPENCODE_API_KEY: 'oc' },
      fetch: fetchFn,
    });
    expect(client.resolvedProvider).toBe('opencode');
    await client.ask(state, questions);
    expect(calls[0]?.url).toBe('https://opencode.ai/inference/systemone/v1/systemone');
    expect(calls[0]?.auth).toBe('Bearer oc');
  });

  it('pins a supplied key to TypeSafe even when OPENROUTER_API_KEY is set', async () => {
    const { calls, fetchFn } = recordingFetch();
    const client = new JevClient({ apiKey: 'k', env: { OPENROUTER_API_KEY: 'or' }, fetch: fetchFn });
    expect(client.resolvedProvider).toBe('typesafe');
    await client.ask(state, questions);
    expect(calls[0]?.auth).toBe('Bearer k');
  });

  it('names the right variable when a key is missing', async () => {
    const missing = new JevClient({ env: {} });
    await expect(missing.ask(state, questions)).rejects.toThrow(/TYPESAFE_API_KEY/);

    const missingOpenRouter = new JevClient({ provider: 'openrouter', env: {} });
    await expect(missingOpenRouter.ask(state, questions)).rejects.toThrow(/OPENROUTER_API_KEY/);

    // An explicitly empty key is still "supplied", so it never turns TypeSafe into OpenRouter.
    const empty = new JevClient({ apiKey: '', env: { OPENROUTER_API_KEY: 'or' } });
    expect(empty.resolvedProvider).toBe('typesafe');
    await expect(empty.ask(state, questions)).rejects.toThrow(/TYPESAFE_API_KEY/);
  });

  it('still honours a baseUrl override', async () => {
    const { calls, fetchFn } = recordingFetch();
    const client = new JevClient({
      apiKey: 'k',
      baseUrl: 'https://proxy.local/systemone',
      fetch: fetchFn,
    });
    await client.ask(state, questions);
    expect(calls[0]?.url).toBe('https://proxy.local/systemone');
  });
});
