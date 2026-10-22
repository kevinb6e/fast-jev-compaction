import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  describeProvider,
  getCredentials,
  hookFallbackReason,
  logMeasurement,
  measurementOf,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
  type HookConfig,
} from '../hooks/fast-jev.ts';
import {
  applyDecisions,
  collectToolCalls,
  decideCall,
  endpointHost,
  ENDPOINT_ENV_KEYS,
  MODEL_ENV_KEY,
  PROVIDER_ENV_KEYS,
  PROVIDER_OVERRIDE_ENV_KEY,
  type Message,
} from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('getCredentials', () => {
  const host = (asked: string[], values: Record<string, string> = {}) => ({
    env: {
      get: async (name: string) => {
        asked.push(name);
        return values[name];
      },
    },
    settings: { read: async () => ({ env: {} }) },
  });
  const config = { model: 'jev-latest', compactAtPercent: 60, minReductionRatio: 0.25 };

  /**
   * `$.env.get` refuses a computed name, so the hook spells each variable out
   * instead of looping over the maps. This pins the two together: a variable
   * added to a map without a literal call fails here.
   */
  it('reads exactly the variables the maps name', async () => {
    const asked: string[] = [];
    await getCredentials(host(asked) as never, config);
    // OpenCode Console and Zen share one key variable, which is read once.
    const named = [
      ...Object.values(PROVIDER_ENV_KEYS),
      ...Object.values(ENDPOINT_ENV_KEYS),
      MODEL_ENV_KEY,
      PROVIDER_OVERRIDE_ENV_KEY,
    ];
    expect([...asked].sort()).toEqual([...new Set(named)].sort());
  });

  it('picks OpenRouter from a key in either variable, given no other setting', async () => {
    const asked: string[] = [];
    const credentials = await getCredentials(
      host(asked, { OPENROUTER_API_KEY: 'sk-or-v1-abc' }) as never,
      config,
    );
    expect(credentials).toEqual({ apiKey: 'sk-or-v1-abc', provider: 'openrouter' });
  });

  it('returns the provider with no key rather than throwing', async () => {
    expect(await getCredentials(host([]) as never, config)).toEqual({ provider: 'typesafe' });
  });

  it('takes the provider from FAST_JEV_PROVIDER when no key pins one', async () => {
    expect(
      await getCredentials(host([], { FAST_JEV_PROVIDER: 'opencode' }) as never, config),
    ).toEqual({ provider: 'opencode' });
  });

  it('lets the provider option win over FAST_JEV_PROVIDER', async () => {
    const asked: string[] = [];
    const credentials = await getCredentials(
      host(asked, { FAST_JEV_PROVIDER: 'openrouter' }) as never,
      { ...config, provider: 'opencode' },
    );
    expect(credentials).toEqual({ provider: 'opencode' });
  });

  it('takes the override over a set TYPESAFE_API_KEY, keeping the override key', async () => {
    const credentials = await getCredentials(
      host([], {
        FAST_JEV_PROVIDER: 'opencode',
        TYPESAFE_API_KEY: 'ts-key',
        OPENCODE_API_KEY: 'oc-key',
      }) as never,
      config,
    );
    expect(credentials).toEqual({ apiKey: 'oc-key', provider: 'opencode' });
  });

  it('ignores an override no provider name matches', async () => {
    const credentials = await getCredentials(
      host([], { FAST_JEV_PROVIDER: 'openai', OPENROUTER_API_KEY: 'sk-or-v1-abc' }) as never,
      config,
    );
    expect(credentials).toEqual({ apiKey: 'sk-or-v1-abc', provider: 'openrouter' });
  });
});

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      requireKeepSignal: false,
      measureNativeSummary: false,
    });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      requireKeepSignal: false,
      measureNativeSummary: false,
    });
  });

  it('passes the text thresholds through to the compaction options', () => {
    expect(resolveHookConfig({ injectedMinChars: 0, replyMinChars: 500 })).toMatchObject({
      injectedMinChars: 0,
      replyMinChars: 500,
    });
  });
});

describe('compaction instructions', () => {
  it('carries the host instructions into the state goal', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    await compactSession(
      transcript(),
      { ...config, instructions: 'keep the auth work' },
      jevFetch(() => 0.9, bodies),
    );
    const { state } = JSON.parse(bodies[0]!) as { state: { goal: string } };
    expect(state.goal).toContain('keep the auth work');
  });
});

describe('endpoint from the environment', () => {
  const base = resolveHookConfig({ preserveRecentMessages: 1 });
  const host = (values: Record<string, string>) => ({
    env: { get: async (name: string) => values[name] },
    settings: { read: async () => ({ env: {} }) },
  });

  it('resolves the endpoint from the engine environment, then the settings block', async () => {
    const engine = await getCredentials(
      host({ TYPESAFE_BASE_URL: 'https://engine.local' }) as never,
      base,
    );
    expect(engine.baseUrl).toBe('https://engine.local/v1/systemone');

    const settings = await getCredentials(
      {
        env: { get: async () => undefined },
        settings: { read: async () => ({ env: { JEV_BASE_URL: 'https://jev.local' } }) },
      } as never,
      base,
    );
    expect(settings.baseUrl).toBe('https://jev.local');
  });

  it('lets a configured baseUrl win over the environment', async () => {
    const credentials = await getCredentials(
      host({ TYPESAFE_BASE_URL: 'https://engine.local' }) as never,
      { ...base, baseUrl: 'https://configured.local' },
    );
    expect(credentials.baseUrl).toBe('https://configured.local');
  });

  it('takes the model from FAST_JEV_MODEL, engine environment first', async () => {
    // The README's Model rule promises the variable for every host; the hook
    // reads its environment literally, so the name has to be spelled out.
    const engine = await getCredentials(
      host({ FAST_JEV_MODEL: 'typesafe/jev-1.13', TYPESAFE_API_KEY: 't' }) as never,
      base,
    );
    expect(engine.model).toBe('typesafe/jev-1.13');

    const settings = await getCredentials(
      {
        env: { get: async () => undefined },
        settings: { read: async () => ({ env: { FAST_JEV_MODEL: 'jev-1.13' } }) },
      } as never,
      base,
    );
    expect(settings.model).toBe('jev-1.13');
  });

  it('lets a configured model win over FAST_JEV_MODEL', async () => {
    const credentials = await getCredentials(
      host({ FAST_JEV_MODEL: 'jev-env' }) as never,
      { ...base, model: 'jev-config' },
    );
    expect(credentials.model).toBeUndefined();
  });

  it('sends the request to that endpoint and names it in the summary', async () => {
    const credentials = await getCredentials(
      host({ TYPESAFE_BASE_URL: 'https://engine.local' }) as never,
      base,
    );
    const urls: string[] = [];
    const respond = jevFetch(() => 0.9);
    const { result } = await compactSession(
      transcript(),
      { ...base, ...credentials, apiKey: 'k' },
      async (url, init) => {
        urls.push(url);
        return respond(url, init);
      },
    );
    expect(urls[0]).toBe('https://engine.local/v1/systemone');
    expect(summarize(result, endpointHost(urls[0]!))).toContain('engine.local');
  });
});

describe('keep signal', () => {
  it('hands a run that kept nothing back to the summarizer', async () => {
    const config = {
      ...resolveHookConfig({ preserveRecentMessages: 1, minReductionRatio: 0 }),
      apiKey: 'k',
    };
    const dropped = (await compactSession(transcript(), config, jevFetch(() => 0.1))).result;
    const survivor = (
      await compactSession(transcript(), config, jevFetch((name) => (name === 'call_t2' ? 0.9 : 0.1)))
    ).result;

    expect(hookFallbackReason(dropped, { ...config, requireKeepSignal: true })).toMatch(
      /^no keep signal \(/,
    );
    expect(hookFallbackReason(survivor, { ...config, requireKeepSignal: true })).toBeNull();
    expect(hookFallbackReason(dropped, config)).toBeNull();
  });

  it('defaults off and can be turned on through userConfig', () => {
    expect(resolveHookConfig({}).requireKeepSignal).toBe(false);
    expect(resolveHookConfig({ requireKeepSignal: true }).requireKeepSignal).toBe(true);
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});
describe('OpenCode Zen by explicit configuration', () => {
  it('reaches Zen without a key and sends no authorization header there', async () => {
    // Zen is asked for, not fallen into: with no key the hook resolves TypeSafe
    // and names its missing key, so the free endpoint needs `provider: 'zen'`.
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), provider: 'zen' as const };
    expect(describeProvider(config)).toBe('jev-1.13-free at TypeSafe (no key)');
    const urls: string[] = [];
    const headers: string[][] = [];
    const answers = jevFetch(() => 0.9);
    const { result: output } = await compactSession(transcript(), config, async (url, init) => {
      urls.push(url);
      headers.push(Object.keys(init?.headers ?? {}));
      return answers(url, init);
    });
    expect(urls).toEqual(['https://opencode.ai/zen/v1/systemone']);
    expect(headers).toEqual([['content-type']]);
    expect(output.stats.requests).toBe(1);
  });

  it('keeps a configured baseUrl, a chosen model and a supplied key', async () => {
    const base = resolveHookConfig({ preserveRecentMessages: 1 });
    const asked = (config: HookConfig) => {
      const urls: string[] = [];
      return compactSession(transcript(), config, async (url, init) => {
        urls.push(url);
        return jevFetch(() => 0.9)(url, init);
      }).then(() => urls[0]);
    };
    // A configured endpoint still wins over the provider's own.
    expect(await asked({ ...base, provider: 'zen', baseUrl: 'http://jev.local' })).toBe(
      'http://jev.local',
    );
    // An explicitly chosen model survives the provider's default.
    expect(describeProvider({ ...base, provider: 'zen', model: 'jev-1.13' })).toContain('jev-1.13');
    // A supplied key is carried, and reaches its own endpoint.
    const keyed = { ...base, provider: 'zen' as const, apiKey: 'k' };
    expect(await asked(keyed)).toBe('https://opencode.ai/zen/v1/systemone');
  });
});
