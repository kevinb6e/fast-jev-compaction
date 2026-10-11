import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  getCredentials,
  hookFallbackReason,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import {
  applyDecisions,
  collectToolCalls,
  decideCall,
  endpointHost,
  ENDPOINT_ENV_KEYS,
  PROVIDER_ENV_KEYS,
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
    expect([...asked].sort()).toEqual(
      [...Object.values(PROVIDER_ENV_KEYS), ...Object.values(ENDPOINT_ENV_KEYS)].sort(),
    );
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
});

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, requireKeepSignal: true, model: 'jev-latest', maxStateTokens: 25000, maxRequestTokens: 30000 });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      // 'jev-x' is not a listed decision model, so the request ceiling falls
      // back rather than assuming the default model's 30 000
      maxRequestTokens: 8192,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      requireKeepSignal: true,
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

    expect(hookFallbackReason(dropped, config)).toMatch(/^no keep signal \(/);
    expect(hookFallbackReason(survivor, config)).toBeNull();
    expect(hookFallbackReason(dropped, { ...config, requireKeepSignal: false })).toBeNull();
  });

  it('defaults on and can be turned off through userConfig', () => {
    expect(resolveHookConfig({}).requireKeepSignal).toBe(true);
    expect(resolveHookConfig({ requireKeepSignal: false }).requireKeepSignal).toBe(false);
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

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

