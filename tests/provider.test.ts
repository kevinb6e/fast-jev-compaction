import { describe, expect, it } from 'vitest';
import { JevClient } from '../src/client.js';
import {
  buildJevRequest,
  isJevProvider,
  missingApiKeyError,
  OPENROUTER_SYSTEM_ONE_URL,
  PROVIDER_ENV_KEYS,
  PROVIDER_URLS,
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
});

describe('resolveJevEndpoint', () => {
  it('pairs each provider with its endpoint', () => {
    expect(resolveJevEndpoint()).toEqual({ provider: 'typesafe', url: SYSTEM_ONE_URL });
    expect(resolveJevEndpoint({ provider: 'openrouter' })).toEqual({
      provider: 'openrouter',
      url: OPENROUTER_SYSTEM_ONE_URL,
    });
    expect(resolveJevEndpoint({}, { OPENROUTER_API_KEY: 'o' }).url).toBe(OPENROUTER_SYSTEM_ONE_URL);
  });

  it('lets a baseUrl win over the provider URL', () => {
    expect(resolveJevEndpoint({ baseUrl: 'https://proxy.local/systemone' }).url).toBe(
      'https://proxy.local/systemone',
    );
  });
});

describe('provider helpers', () => {
  it('recognises the known providers only', () => {
    expect(isJevProvider('typesafe')).toBe(true);
    expect(isJevProvider('openrouter')).toBe(true);
    expect(isJevProvider('open-ai')).toBe(false);
    expect(isJevProvider(undefined)).toBe(false);
  });

  it('names the environment variable of each provider', () => {
    expect(PROVIDER_ENV_KEYS).toEqual({ typesafe: 'TYPESAFE_API_KEY', openrouter: 'OPENROUTER_API_KEY' });
    expect(PROVIDER_URLS).toEqual({ typesafe: SYSTEM_ONE_URL, openrouter: OPENROUTER_SYSTEM_ONE_URL });
    expect(missingApiKeyError('typesafe').message).toMatch(/TYPESAFE_API_KEY/);
    expect(missingApiKeyError('openrouter').message).toMatch(/OPENROUTER_API_KEY/);
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
