import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
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
    expect([...asked].sort()).toEqual(
      [
        ...Object.values(PROVIDER_ENV_KEYS),
        ...Object.values(ENDPOINT_ENV_KEYS),
        PROVIDER_OVERRIDE_ENV_KEY,
      ].sort(),
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

  it('defaults the model to the resolved provider, and lets an explicit one win', async () => {
    const modelOf = async (config: Partial<HookConfig>): Promise<string> => {
      const bodies: string[] = [];
      await compactSession(
        transcript(),
        { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', ...config },
        jevFetch(() => 0.9, bodies),
      );
      return (JSON.parse(bodies[0]!) as { model: string }).model;
    };
    expect(await modelOf({})).toBe('jev-latest');
    expect(await modelOf({ provider: 'opencode' })).toBe('jev-1.13');
    expect(await modelOf({ provider: 'opencode', model: 'jev-x' })).toBe('jev-x');
  });

  it('sizes the state budget from the resolved model', async () => {
    const big = transcript();
    big[0]!.text = 'x'.repeat(40_000);
    const stageOf = async (config: Partial<HookConfig>): Promise<string> => {
      const { result } = await compactSession(
        big,
        { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', ...config },
        jevFetch(() => 0.9),
      );
      return result.stats.stateStage;
    };
    expect(await stageOf({})).toBe('full');
    // 'jev-x' is unlisted, so the 8 192-token fallback ceiling forces the fit
    expect(await stageOf({ model: 'jev-x' })).not.toBe('full');
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

describe('compaction measurement', () => {
  const MEASURE_PREFIX = 'fast-jev-compaction:measure ';
  const nativeMessages: SessionMessage[] = [
    message('user', 'native built-in summary', { handle: 'native-0' }),
  ];
  /** Jev answers that drop the first call and keep the second. */
  const dropFirst = (name: string): number =>
    name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1;

  type CompactEvent = { trigger: string; messages: SessionMessage[] };
  type CompactOutcome = { messages?: readonly SessionMessage[] };
  type CompactHandler = (
    ctx: unknown,
    event: CompactEvent,
    next: (event: CompactEvent) => Promise<CompactOutcome>,
  ) => Promise<CompactOutcome>;

  /** Drives the public `register` with a fake engine, capturing the handler. */
  function harness(
    options: Record<string, unknown>,
    answers: (name: string) => number = dropFirst,
    env: Record<string, string> = {},
  ) {
    const handlers: Record<string, CompactHandler> = {};
    const on = ((pattern: string, hook: CompactHandler) => {
      handlers[pattern] = hook;
    }) as never;
    register(on, options as never);

    const logs: string[] = [];
    const toasts: string[] = [];
    const files = new Map<string, string>();
    const writes: string[] = [];
    const answered = jevFetch(answers);
    const envValues: Record<string, string> = { TYPESAFE_API_KEY: 'k', ...env };
    const engine = {
      env: { get: async (name: string) => envValues[name] },
      settings: { read: async () => ({ env: {} }) },
      http: { fetch: (url: string, init?: { body?: string }) => answered(url, init) },
      ui: {
        log: (text: string) => logs.push(text),
        toast: (text: string) => toasts.push(text),
      },
      fs: {
        read: async (path: string) => {
          if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
          return files.get(path)!;
        },
        write: async (path: string, text: string) => {
          files.set(path, text);
          writes.push(text);
        },
      },
      session: {
        usage: async () => ({ context: { tokens: 8000, window: 200_000, percent: 4 } }),
      },
    };

    let nextCalls = 0;
    const next = async (_event: CompactEvent): Promise<CompactOutcome> => {
      nextCalls += 1;
      return { messages: nativeMessages };
    };
    const handler = handlers['session.compact']!;
    const run = (event: CompactEvent) => handler(engine, event, next);
    const measures = () =>
      logs
        .filter((line) => line.startsWith(MEASURE_PREFIX))
        .map((line) => JSON.parse(line.slice(MEASURE_PREFIX.length)) as Record<string, unknown>);
    return { run, logs, toasts, files, writes, measures, nextCalls: () => nextCalls };
  }

  it('returns the pruned messages and logs a replaced measurement', async () => {
    const h = harness({ preserveRecentMessages: 1 });
    const out = await h.run({ trigger: 'manual', messages: transcript() });

    expect(out.messages?.map((m) => m.handle)).toEqual([
      'h-0',
      'h-tool-2',
      'r-tool-2',
      'h-5',
      'h-6',
    ]);
    expect(out.messages).not.toBe(nativeMessages);
    expect(h.nextCalls()).toBe(0);
    expect(h.toasts[0]).toContain('kept 5/7 messages, no summary');

    const measurements = h.measures();
    expect(measurements).toHaveLength(1);
    const m = measurements[0]!;
    expect(m.outcome).toBe('replaced');
    expect(m.trigger).toBe('manual');
    expect(m.messagesBefore).toBe(7);
    expect(m.messagesAfter).toBe(5);
    expect(m.contextTokens).toBe(8000);
    expect(m.contextPercent).toBe(4);
    expect((m.tokensBefore as number) > (m.tokensAfter as number)).toBe(true);
    expect(m.reduction).toBe(((m.charsBefore as number) - (m.charsAfter as number)) / (m.charsBefore as number));
    expect('nativeSummaryMessages' in m).toBe(false);
    expect('fallbackReason' in m).toBe(false);
  });

  it('appends the same measurement line to the metrics file', async () => {
    const h = harness({ preserveRecentMessages: 1, metricsPath: 'metrics.jsonl' });
    await h.run({ trigger: 'auto', messages: transcript() });

    const line = h.logs.filter((entry) => entry.startsWith(MEASURE_PREFIX))[0]!.slice(
      MEASURE_PREFIX.length,
    );
    expect(h.writes).toEqual([`${line}\n`]);
    expect(h.files.get('metrics.jsonl')).toBe(`${line}\n`);
  });

  it('falls back to FAST_JEV_METRICS when no metricsPath option is set', async () => {
    const h = harness({ preserveRecentMessages: 1 }, dropFirst, {
      FAST_JEV_METRICS: 'env-metrics.jsonl',
    });
    await h.run({ trigger: 'plugin', messages: transcript() });

    expect(h.files.has('env-metrics.jsonl')).toBe(true);
  });

  it('measures the built-in summary when asked, still returning the prune', async () => {
    const h = harness({ preserveRecentMessages: 1, measureNativeSummary: true });
    const out = await h.run({ trigger: 'manual', messages: transcript() });

    expect(h.nextCalls()).toBe(1);
    expect(out.messages?.map((m) => m.handle)).toEqual([
      'h-0',
      'h-tool-2',
      'r-tool-2',
      'h-5',
      'h-6',
    ]);
    const m = h.measures()[0]!;
    expect(m.outcome).toBe('replaced');
    expect(m.nativeSummaryMessages).toBe(nativeMessages.length);
    expect((m.nativeSummaryTokens as number) > 0).toBe(true);
  });

  it('logs a fallback measurement and returns the built-in compaction', async () => {
    const h = harness(
      { preserveRecentMessages: 1, minReductionRatio: 0, requireKeepSignal: true },
      () => 0.1,
    );
    const out = await h.run({ trigger: 'manual', messages: transcript() });

    expect(out.messages).toBe(nativeMessages);
    expect(h.nextCalls()).toBe(1);
    const m = h.measures()[0]!;
    expect(m.outcome).toBe('fallback');
    expect(m.fallbackReason).toMatch(/^no keep signal \(/);
    expect(m.messagesAfter).toBe(nativeMessages.length);
    expect(m.nativeSummaryMessages).toBe(nativeMessages.length);
  });

  it('logs a one-line failure when the metrics write fails, without throwing', async () => {
    const lines: string[] = [];
    const m = measurementOf({
      at: '2020-01-01T00:00:00.000Z',
      trigger: 'manual',
      outcome: 'replaced',
      before: transcript(),
      after: transcript(),
      stateTokens: 0,
      requests: 0,
      ms: 0,
    });
    await logMeasurement(
      {
        ui: { log: (text: string) => lines.push(text) },
        fs: {
          read: async () => '',
          write: async () => {
            throw new Error('EACCES');
          },
        },
      },
      m,
      'metrics.jsonl',
    );
    expect(lines[0]).toBe(`${MEASURE_PREFIX}${JSON.stringify(m)}`);
    expect(lines[1]).toBe('fast-jev-compaction:measure failed to write metrics.jsonl (EACCES)');
  });
});

