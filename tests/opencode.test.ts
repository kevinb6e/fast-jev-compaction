import type { Context } from '@opencode/plugin/promise/plugin';
import type { SessionCompaction } from '@opencode/plugin/promise/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSummary,
  carryPrevious,
  contextSummary,
  fromHostMessages,
  handleCompaction,
  inBandSummary,
  resolvePluginOptions,
} from '../opencode/index.ts';
import type { JevAsker } from '../src/index.js';

type HostMessages = Parameters<typeof fromHostMessages>[0];

const host = (messages: readonly unknown[]): HostMessages => messages as HostMessages;

function user(text: string): Record<string, unknown> {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistant(
  text: string,
  calls: { id: string; name: string; input: Record<string, unknown> }[] = [],
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map((call) => ({ type: 'tool-call', ...call })),
    ],
  };
}

function tool(id: string, name: string, value: unknown, type = 'text'): Record<string, unknown> {
  return { role: 'tool', content: [{ type: 'tool-result', id, name, result: { type, value } }] };
}

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

const file = 'export const x = 1;\n'.repeat(40);

function transcript(): readonly unknown[] {
  return [
    user('Fix the failing test.'),
    assistant('', [{ id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }]),
    tool('t1', 'Read', file),
    assistant('', [{ id: 't2', name: 'Bash', input: { command: 'npm test' } }]),
    tool('t2', 'Bash', 'FAIL b.test.ts: expected 2 to be 3'),
    assistant('Two tests fail.'),
  ];
}

// An explicit empty env: the defaults must not depend on the ambient FAST_JEV_* vars.
const options = (extra: Record<string, unknown> = {}) =>
  resolvePluginOptions({ preserveRecentMessages: 1, ...extra }, {});

function context(stub?: unknown[]): { ctx: Context; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async () => stub ?? []);
  const ctx = { options: {}, session: { context: list } } as unknown as Context;
  return { ctx, list };
}

function event(messages: readonly unknown[]): SessionCompaction {
  return { sessionID: 'ses_test', messages: host(messages) } as unknown as SessionCompaction;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolvePluginOptions', () => {
  it('falls back to the defaults', () => {
    expect(resolvePluginOptions({}, {})).toEqual({
      model: 'jev-latest',
      minReductionRatio: 0.25,
      maxSummaryTokens: 16384,
      maxStateTokens: 25000,
      maxRequestTokens: 30000,
    });
  });

  it('reads the FAST_JEV_* environment variables', () => {
    expect(
      resolvePluginOptions(
        {},
        {
          FAST_JEV_MODEL: 'typesafe/jev-1.13',
          FAST_JEV_PROVIDER: 'openrouter',
          FAST_JEV_MAX_SUMMARY_TOKENS: '32768',
        },
      ),
    ).toEqual({
      model: 'typesafe/jev-1.13',
      minReductionRatio: 0.25,
      maxSummaryTokens: 32768,
      provider: 'openrouter',
      maxStateTokens: 25000,
      maxRequestTokens: 30000,
    });
  });

  it('reads configured values and ignores malformed ones', () => {
    expect(
      resolvePluginOptions({
        provider: 'openrouter',
        apiKey: 'k',
        baseUrl: 'https://openrouter.ai/api/v1/systemone',
        goal: 'ship it',
        model: 'jev-1.13',
        minReductionRatio: 0.4,
        maxSummaryTokens: 2048,
        keepThreshold: 0.7,
        preserveRecentMessages: 'nope',
      }, {}),
    ).toEqual({
      model: 'jev-1.13',
      minReductionRatio: 0.4,
      maxSummaryTokens: 2048,
      provider: 'openrouter',
      maxStateTokens: 25000,
      maxRequestTokens: 30000,
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1/systemone',
      goal: 'ship it',
      keepThreshold: 0.7,
    });

    expect(resolvePluginOptions({ provider: 'openai' }, {}).provider).toBeUndefined();
  });
});

describe('fromHostMessages', () => {
  it('keeps text, tool calls and tool results', () => {
    const messages = fromHostMessages(
      host([
        user('Fix the failing test.'),
        assistant('Reading.', [{ id: 't1', name: 'Read', input: { file_path: 'a.ts' } }]),
        tool('t1', 'Read', 'contents'),
        tool('t2', 'Bash', 'boom', 'error'),
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
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 't2', text: 'boom', isError: true }],
      },
    ]);
  });

  it('handles json results, non-object inputs and ignores media and reasoning', () => {
    const messages = fromHostMessages(
      host([
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking out loud' },
            { type: 'tool-call', id: 't1', name: 'List', input: ['a', 'b'] },
            { type: 'media', media: { source: { type: 'url', url: 'x.png', mediaType: 'image/png' } } },
          ],
        },
        tool('t1', 'List', { files: ['a'] }, 'json'),
        { role: 'system', content: [{ type: 'text', text: 'system note' }] },
      ]),
    );
    expect(messages[0]).toEqual({
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 't1', tool: 'List', input: { value: ['a', 'b'] } }],
    });
    expect(messages[1]?.toolResults?.[0]?.text).toBe('{"files":["a"]}');
    expect(messages[2]).toEqual({ role: 'user', text: 'system note', toolUses: [] });
  });
});

describe('previous summary', () => {
  it('reads a readable checkpoint from the transcript', () => {
    expect(
      inBandSummary(host([{ role: 'user', content: [{ type: 'compaction', text: 'earlier work' }] }])),
    ).toEqual({ text: 'earlier work' });
  });

  it('flags a provider-encrypted checkpoint as unreadable', () => {
    expect(
      inBandSummary(host([{ role: 'user', content: [{ type: 'compaction', encrypted: 'blob' }] }])),
    ).toMatchObject({ opaque: true });
    expect(inBandSummary(host([user('plain')]))).toEqual({});
  });

  it('takes the last completed compaction of a session', () => {
    const entries = [
      { type: 'compaction', status: 'completed', summary: 'first summary' },
      { type: 'compaction', status: 'failed', summary: '' },
      { type: 'compaction', status: 'running', summary: '' },
    ];
    expect(contextSummary(entries)).toEqual({ text: 'first summary' });
    expect(contextSummary([{ type: 'user' }])).toEqual({});
    expect(contextSummary([{ type: 'compaction', status: 'completed', summary: '' }])).toMatchObject({
      opaque: true,
    });
  });

  it('carries the previous summary forward without duplicating it', () => {
    expect(carryPrevious(undefined, 'body')).toBe('body');
    expect(carryPrevious('older summary', 'body')).toBe('older summary\n\n---\n\nbody');
    expect(carryPrevious('older summary', 'older summary\n\n---\n\nbody')).toBe(
      'older summary\n\n---\n\nbody',
    );
  });
});

describe('buildSummary', () => {
  it('renders the pruned transcript and carries the previous summary', async () => {
    const seen: string[] = [];
    const outcome = await buildSummary(host(transcript()), options(), { text: 'from compaction one' }, asker(
      (name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1),
      seen,
    ));
    expect(seen.length).toBeGreaterThan(0);
    expect(outcome.summary).toMatch(/^from compaction one\n\n---\n\n## user/);
    expect(outcome.summary).toContain('tool Bash({"command":"npm test"})');
    expect(outcome.summary).not.toContain('export const x = 1;');
    expect(outcome.reduction ?? 0).toBeGreaterThan(0.25);
    expect(outcome.result?.stats.callsDropped).toBe(1);
  });

  it('falls back when Jev keeps everything', async () => {
    const outcome = await buildSummary(host(transcript()), options(), {}, asker(() => 1));
    expect(outcome.summary).toBeUndefined();
    expect(outcome.reason).toMatch(/below 25% minimum/);
  });

  it('falls back when the previous checkpoint cannot be read', async () => {
    const seen: string[] = [];
    const outcome = await buildSummary(
      host(transcript()),
      options(),
      { opaque: true, reason: 'the previous checkpoint is provider-encrypted' },
      asker(() => 0, seen),
    );
    expect(seen).toEqual([]);
    expect(outcome.reason).toMatch(/provider-encrypted/);
  });

  it('falls back when the rendered summary is too large for the slot', async () => {
    const outcome = await buildSummary(
      host(transcript()),
      options({ maxSummaryTokens: 4 }),
      {},
      asker(() => 0.1),
    );
    expect(outcome.summary).toBeUndefined();
    expect(outcome.reason).toMatch(/exceeds 4/);
  });
});

describe('handleCompaction', () => {
  it('records the pruned transcript as the compaction result', async () => {
    const { ctx, list } = context();
    const subject = event(transcript());
    const recorded = await handleCompaction(
      subject,
      ctx,
      options(),
      asker((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1)),
    );
    expect(recorded).toBe(true);
    expect(list).toHaveBeenCalledWith({ sessionID: 'ses_test' });
    expect(subject.result?.summary).toContain('tool Bash({"command":"npm test"})');
    expect(subject.result?.metadata).toMatchObject({
      fastJev: { carriedPreviousSummary: false },
    });
  });

  it('carries a previous summary found in the session context', async () => {
    const { ctx } = context([
      { type: 'compaction', status: 'completed', summary: 'what happened before' },
    ]);
    const subject = event(transcript());
    await handleCompaction(
      subject,
      ctx,
      options(),
      asker((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1)),
    );
    expect(subject.result?.summary).toMatch(/^what happened before\n\n---\n\n## user/);
    expect(subject.result?.metadata).toMatchObject({
      fastJev: { carriedPreviousSummary: true },
    });
  });

  it('leaves the result unset for an unreadable checkpoint, without asking the session', async () => {
    const { ctx, list } = context();
    const subject = event([
      { role: 'user', content: [{ type: 'compaction', encrypted: 'native blob' }] },
      user('recent work'),
    ]);
    const recorded = await handleCompaction(subject, ctx, options(), asker(() => 0));
    expect(recorded).toBe(false);
    expect(subject.result).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('leaves the result unset when Jev fails', async () => {
    const { ctx } = context();
    const subject = event(transcript());
    const failing: JevAsker = {
      async ask() {
        throw new Error('Jev is down');
      },
    };
    const recorded = await handleCompaction(subject, ctx, options(), failing);
    expect(recorded).toBe(false);
    expect(subject.result).toBeUndefined();
  });
});
