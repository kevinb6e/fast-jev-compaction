import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastJevCompaction, {
  appendFilesTag,
  buildSummary,
  fileLists,
  fromAgentMessages,
  handleBeforeCompact,
  resolveOmpOptions,
  summaryCeiling,
} from '../omp/index.ts';
import type { JevAsker } from '../src/index.js';

type OmpMessages = Parameters<typeof fromAgentMessages>[0];
type Preparation = Parameters<typeof buildSummary>[0];

const omp = (messages: readonly unknown[]): OmpMessages => messages as OmpMessages;
const preparation = (extra: Record<string, unknown> = {}): Preparation =>
  ({
    firstKeptEntryId: 'entry-2',
    messagesToSummarize: [],
    turnPrefixMessages: [],
    recentMessages: [],
    isSplitTurn: false,
    tokensBefore: 4200,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true },
    ...extra,
  }) as Preparation;

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: unknown[]) => ({
  role: 'assistant',
  content,
  api: 'anthropic',
  provider: 'anthropic',
  model: 'claude',
});
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const toolResult = (id: string, name: string, text: string, isError = false) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: name,
  content: [{ type: 'text', text }],
  isError,
});

function asker(answer: (name: string) => number, seen: string[] = []): JevAsker {
  return {
    async ask(_state, questions) {
      seen.push(...Object.keys(questions));
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
      };
    },
  };
}

const keepNew = (name: string) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1);

const file = 'export const x = 1;\n'.repeat(40);

function transcript(): readonly unknown[] {
  return [
    user('Fix the failing test.'),
    assistant([toolCall('t1', 'Read', { file_path: 'src/a.ts' })]),
    toolResult('t1', 'Read', file),
    assistant([toolCall('t2', 'Bash', { command: 'npm test' })]),
    toolResult('t2', 'Bash', 'FAIL b.test.ts: expected 2 to be 3', true),
    assistant([{ type: 'text', text: 'Two tests fail.' }]),
  ];
}

describe('compaction instructions', () => {
  it('carries customInstructions into the state goal', async () => {
    const states: { goal?: string }[] = [];
    const recording: JevAsker = {
      async ask(state, questions) {
        states.push(state);
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: 0.9 }]),
          ),
        };
      },
    };

    await handleBeforeCompact(
      {
        type: 'session_before_compact',
        preparation: preparation({ messagesToSummarize: omp(transcript()) }),
        branchEntries: [],
        customInstructions: 'keep the auth work',
      } as never,
      { ui: { notify: () => {} } },
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1' }),
      recording,
    );

    expect(states[0]?.goal).toContain('keep the auth work');
  });
});

describe('endpoint from the environment', () => {
  it('takes JEV_BASE_URL and TYPESAFE_BASE_URL when FAST_JEV_BASE_URL is unset', () => {
    expect(resolveOmpOptions({ JEV_BASE_URL: 'https://jev.local' }).baseUrl).toBe('https://jev.local');
    expect(resolveOmpOptions({ TYPESAFE_BASE_URL: 'https://ts.local' }).baseUrl).toBe(
      'https://ts.local/v1/systemone',
    );
    expect(
      resolveOmpOptions({
        TYPESAFE_BASE_URL: 'https://ts.local',
        FAST_JEV_BASE_URL: 'https://fast.local',
      }).baseUrl,
    ).toBe('https://fast.local');
  });

  it('names the endpoint host in the notification', async () => {
    const seen: string[] = [];
    await handleBeforeCompact(
      {
        type: 'session_before_compact',
        preparation: preparation({ messagesToSummarize: omp(transcript()) }),
        branchEntries: [],
      } as never,
      { ui: { notify: (message: string) => void seen.push(message) } },
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1', TYPESAFE_BASE_URL: 'https://engine.local' }),
      asker(keepNew),
    );
    expect(seen.join(' ')).toContain('engine.local');
  });
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveOmpOptions', () => {
  it('falls back to the defaults', () => {
    expect(resolveOmpOptions({})).toEqual({
      model: 'jev-latest',
      minReductionRatio: 0.25,
      requireKeepSignal: false,
      maxSummaryTokens: 0,
      maxStateTokens: 25000,
      maxRequestTokens: 30000,
    });
  });

  it('derives the model from the resolved provider when none is set', () => {
    expect(resolveOmpOptions({}).model).toBe('jev-latest');
    expect(resolveOmpOptions({ FAST_JEV_PROVIDER: 'opencode' }).model).toBe('jev-1.13');
    expect(resolveOmpOptions({ OPENCODE_API_KEY: 'oc' }).model).toBe('jev-1.13');
    expect(resolveOmpOptions({ FAST_JEV_PROVIDER: 'openrouter' }).model).toBe('jev-latest');
    // An explicit model still wins over the provider default.
    expect(
      resolveOmpOptions({ FAST_JEV_PROVIDER: 'opencode', FAST_JEV_MODEL: 'typesafe/jev-1.13' }).model,
    ).toBe('typesafe/jev-1.13');
  });

  it('reads the FAST_JEV_* variables and ignores malformed ones', () => {
    expect(
      resolveOmpOptions({
        FAST_JEV_PROVIDER: 'openrouter',
        FAST_JEV_API_KEY: 'or',
        FAST_JEV_BASE_URL: 'https://openrouter.ai/api/v1/systemone',
        FAST_JEV_MODEL: 'jev-1.13',
        FAST_JEV_GOAL: 'ship it',
        FAST_JEV_KEEP_THRESHOLD: '0.7',
        FAST_JEV_PRESERVE_RECENT: '2',
        FAST_JEV_MAX_STATE_TOKENS: '4000',
        FAST_JEV_MAX_REQUEST_TOKENS: '5000',
        FAST_JEV_TRUNCATE_HEAD_CHARS: '120',
        FAST_JEV_MIN_REDUCTION: '0.4',
        FAST_JEV_REQUIRE_KEEP_SIGNAL: 'true',
        FAST_JEV_MAX_SUMMARY_TOKENS: '2048',
      }),
    ).toEqual({
      provider: 'openrouter',
      apiKey: 'or',
      baseUrl: 'https://openrouter.ai/api/v1/systemone',
      model: 'jev-1.13',
      goal: 'ship it',
      keepThreshold: 0.7,
      preserveRecentMessages: 2,
      maxStateTokens: 4000,
      maxRequestTokens: 5000,
      truncateHeadChars: 120,
      minReductionRatio: 0.4,
      requireKeepSignal: true,
      maxSummaryTokens: 2048,
    });

    expect(
      resolveOmpOptions({
        FAST_JEV_PROVIDER: 'openai',
        FAST_JEV_MIN_REDUCTION: 'lots',
        FAST_JEV_REQUIRE_KEEP_SIGNAL: 'maybe',
      }),
    ).toEqual({
      model: 'jev-latest',
      minReductionRatio: 0.25,
      requireKeepSignal: false,
      maxSummaryTokens: 0,
      maxStateTokens: 25000,
      maxRequestTokens: 30000,
    });
  });
});

describe('summaryCeiling', () => {
  it('derives 20% of the context being compacted, with a 16k floor', () => {
    const options = resolveOmpOptions({});
    expect(summaryCeiling(preparation({ tokensBefore: 118572 }), options)).toBe(23714);
    expect(summaryCeiling(preparation({ tokensBefore: 220715 }), options)).toBe(44143);
    expect(summaryCeiling(preparation({ tokensBefore: 323739 }), options)).toBe(64748);
    expect(summaryCeiling(preparation({ tokensBefore: 8000 }), options)).toBe(16384);
  });

  it('takes an explicit ceiling verbatim', () => {
    const options = resolveOmpOptions({ FAST_JEV_MAX_SUMMARY_TOKENS: '24000' });
    expect(summaryCeiling(preparation({ tokensBefore: 220715 }), options)).toBe(24000);
    expect(summaryCeiling(preparation({ tokensBefore: 220715 }), resolveOmpOptions({ FAST_JEV_MAX_SUMMARY_TOKENS: '4096' }))).toBe(4096);
  });
});

describe('fromAgentMessages', () => {
  it('keeps assistant text and tool calls, and pairs tool results', () => {
    const messages = fromAgentMessages(
      omp([
        user('Fix the failing test.'),
        assistant([
          { type: 'text', text: 'Reading.' },
          toolCall('t1', 'Read', { file_path: 'a.ts' }),
          { type: 'thinking', thinking: 'hmm' },
        ]),
        toolResult('t1', 'Read', 'contents'),
      ]),
    );
    expect(messages).toEqual([
      { role: 'user', text: 'Fix the failing test.', toolUses: [] },
      {
        role: 'assistant',
        text: 'Reading.',
        toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 't1', text: 'contents', isError: false }],
      },
    ]);
  });

  it('renders the agent message types as the text they stand for', () => {
    const messages = fromAgentMessages(
      omp([
        {
          role: 'bashExecution',
          command: 'npm test',
          output: 'FAIL',
          exitCode: 1,
          cancelled: false,
          truncated: false,
          timestamp: 0,
        },
        { role: 'pythonExecution', code: 'print(1)', output: '1', exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
        { role: 'branchSummary', summary: 'Side branch work.', fromId: 'e0', timestamp: 0 },
        { role: 'compactionSummary', summary: 'Earlier context.', tokensBefore: 10 },
        { role: 'fileMention', files: [{ path: 'src/a.ts', content: 'export const a = 1;' }], timestamp: 0 },
        { role: 'custom', customType: 'note', content: 'plain note', display: true, timestamp: 0 },
        { role: 'mystery' },
      ]),
    );
    expect(messages.map((message) => message.text)).toEqual([
      '$ npm test (exit 1)\nFAIL',
      '>>> print(1)\n1',
      '[branch summary]\nSide branch work.',
      '[context summary]\nEarlier context.',
      '@src/a.ts\nexport const a = 1;',
      'plain note',
    ]);
    expect(messages.every((message) => message.role === 'user')).toBe(true);
  });
});

describe('file bookkeeping', () => {
  it('splits read from modified files and drops url schemes', () => {
    const files = fileLists({
      read: new Set(['src/a.ts', 'src/b.ts', 'artifact://thing']),
      written: new Set(['src/b.ts', 'conflict://old']),
      edited: new Set(),
    });
    expect(files).toEqual({ readFiles: ['src/a.ts'], modifiedFiles: ['src/b.ts'] });
  });

  it('appends a files tag once, however often compaction runs', () => {
    const files = { readFiles: ['src/a.ts'], modifiedFiles: ['src/b.ts'] };
    const first = appendFilesTag('summary', files, new Set(['src/b.ts']));
    expect(first).toBe('summary\n\n<files>\nsrc/a.ts (Read)\nsrc/b.ts (RW)\n</files>');
    expect(appendFilesTag(first, files, new Set(['src/b.ts']))).toBe(first);
    expect(appendFilesTag('summary', { readFiles: [], modifiedFiles: [] }, new Set())).toBe('summary');
    expect(appendFilesTag('<read-files>\nold\n</read-files>', files, new Set())).toContain('src/a.ts (Read)');
  });
});

describe('buildSummary', () => {
  it('renders the pruned transcript with the previous summary and files tag', async () => {
    const outcome = await buildSummary(
      preparation({
        messagesToSummarize: omp(transcript()),
        previousSummary: 'from compaction one',
        fileOps: { read: new Set(['src/a.ts']), written: new Set(), edited: new Set() },
      }),
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1' }),
      asker(keepNew),
    );
    expect(outcome.summary).toMatch(/^from compaction one\n\n---\n\n## user/);
    expect(outcome.summary).toContain('tool Bash({"command":"npm test"})');
    expect(outcome.summary).not.toContain('export const x = 1;');
    expect(outcome.summary).toContain('src/a.ts (Read)');
    expect(outcome.reduction ?? 0).toBeGreaterThan(0.25);
    expect(outcome.result?.stats.callsDropped).toBe(1);
    expect(outcome.files).toEqual({ readFiles: ['src/a.ts'], modifiedFiles: [] });
  });

  it('adds the turn prefix section on a split turn', async () => {
    const outcome = await buildSummary(
      preparation({
        messagesToSummarize: omp(transcript()),
        turnPrefixMessages: omp([user('continue the fix'), assistant([{ type: 'text', text: 'On it.' }])]),
        isSplitTurn: true,
      }),
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1' }),
      asker(keepNew),
    );
    expect(outcome.summary).toContain('---\n\n**Turn Context (split turn):**\n\n## user\ncontinue the fix');
    expect(outcome.summary).toContain('## assistant\nOn it.');
  });

  it('falls back when Jev keeps everything', async () => {
    const outcome = await buildSummary(
      preparation({ messagesToSummarize: omp(transcript()) }),
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1' }),
      asker(() => 1),
    );
    expect(outcome.summary).toBeUndefined();
    expect(outcome.reason).toMatch(/below 25% minimum/);
  });

  it('falls back when Jev drops every call it judged', async () => {
    const outcome = await buildSummary(
      preparation({ messagesToSummarize: omp(transcript()) }),
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1', FAST_JEV_REQUIRE_KEEP_SIGNAL: 'true' }),
      asker(() => 0.1),
    );
    expect(outcome.summary).toBeUndefined();
    expect(outcome.reason).toMatch(/no keep signal/);

    const allowed = await buildSummary(
      preparation({ messagesToSummarize: omp(transcript()) }),
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1' }),
      asker(() => 0.1),
    );
    expect(allowed.summary).toBeDefined();
  });

  it('falls back when the rendered summary is too large for the slot', async () => {
    const outcome = await buildSummary(
      preparation({ messagesToSummarize: omp(transcript()) }),
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1', FAST_JEV_MAX_SUMMARY_TOKENS: '4' }),
      asker(keepNew),
    );
    expect(outcome.summary).toBeUndefined();
    expect(outcome.reason).toMatch(/exceeds 4/);
  });

  it('scales the ceiling with the context so a long session still compacts', async () => {
    const words = 'word '.repeat(20_800);
    const outcome = await buildSummary(
      preparation({
        tokensBefore: 118_572,
        messagesToSummarize: omp([
          user('Fix the failing test.'),
          assistant([toolCall('t1', 'Read', { file_path: 'src/b.ts' })]),
          toolResult('t1', 'Read', 'filler '.repeat(40_000)),
          assistant([toolCall('t2', 'Write', { file_path: 'src/a.ts', content: words })]),
          toolResult('t2', 'Write', 'wrote 1 file'),
        ]),
      }),
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1' }),
      asker(() => 0.1),
    );
    expect(outcome.summary).toBeDefined();
    expect(outcome.reason).toBeUndefined();
  });
});

describe('handleBeforeCompact', () => {
  function event(extra: Record<string, unknown> = {}, signal?: AbortSignal) {
    return {
      type: 'session_before_compact',
      preparation: preparation({
        messagesToSummarize: omp(transcript()),
        fileOps: { read: new Set(['src/a.ts']), written: new Set(), edited: new Set() },
        ...extra,
      }),
      branchEntries: [],
      signal: signal ?? new AbortController().signal,
    } as unknown as Parameters<typeof handleBeforeCompact>[0];
  }

  const ctx = () => ({ ui: { notify: vi.fn() } });

  it('returns the compaction omp should store', async () => {
    const ui = ctx().ui;
    const result = await handleBeforeCompact(
      event(),
      { ui },
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1' }),
      asker(keepNew),
    );
    expect(result?.compaction).toMatchObject({
      firstKeptEntryId: 'entry-2',
      tokensBefore: 4200,
      details: { readFiles: ['src/a.ts'], modifiedFiles: [] },
    });
    expect(result?.compaction?.summary).toContain('tool Bash({"command":"npm test"})');
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('reduction'), 'info');
  });

  it('returns nothing so omp summarises when Jev cannot help', async () => {
    const ui = ctx().ui;
    const result = await handleBeforeCompact(
      event(),
      { ui },
      { ...resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1' }), provider: 'typesafe', apiKey: '' },
    );
    expect(result).toBeUndefined();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/falling back.*TYPESAFE_API_KEY/), 'warning');
  });

  it('stays out of the way once the compaction was cancelled', async () => {
    const ui = ctx().ui;
    const controller = new AbortController();
    controller.abort();
    const result = await handleBeforeCompact(
      event({}, controller.signal),
      { ui },
      resolveOmpOptions({ FAST_JEV_PRESERVE_RECENT: '1' }),
      asker(keepNew),
    );
    expect(result).toBeUndefined();
    expect(ui.notify).not.toHaveBeenCalled();
  });
});

describe('extension entry point', () => {
  it('registers the compaction handler', () => {
    const on = vi.fn();
    fastJevCompaction({ on } as never);
    expect(on).toHaveBeenCalledWith('session_before_compact', expect.any(Function));
  });
});
