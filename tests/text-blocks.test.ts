import { describe, expect, it } from 'vitest';
import {
  batchItems,
  collectTextBlocks,
  compact,
  questionsFor,
  resolveOptions,
  textQuestionsFor,
  type JevAsker,
  type JevQuestions,
  type Message,
  type TextBlock,
} from '../src/index.js';

function message(role: Message['role'], text: string): Message {
  return { role, text, toolUses: [] };
}

type Seen = { state: unknown; questions: string[] };

/** A lone half of a surrogate pair: what the decision endpoint rejects. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: answer(name) }])),
      };
    },
  };
}

const skillBody = `Base directory for this skill: /home/u/.claude/plugins/cache/ui-ux-pro-max/2.5.0/skills/ui-ux-pro-max\n\n# UI/UX Pro Max\n${'- rule about contrast and spacing\n'.repeat(80)}`;
const contextReport = `## Context Usage\n\n| Tool | Tokens |\n${'| mcp__x__tool | 300 |\n'.repeat(120)}`;
const postCompact = `<local-command-stdout>Compacted (ctrl+o to see full summary)\nPostCompact ${'hook output '.repeat(40)}</local-command-stdout>`;
const longReply = `Resultado da investigação.\n${'Detalhe do que foi feito e por quê. '.repeat(120)}\nFim da resposta.`;

function transcript(): Message[] {
  return [
    message('user', 'Monte o painel do Claude Code.'),
    message('user', `<command-name>/ui-ux-pro-max</command-name>\n${skillBody}\nARGUMENTS: o que recomenda?`),
    message('assistant', longReply),
    message('user', `${postCompact}\nveja ai`),
    message('user', contextReport),
    message('user', `${postCompact}\noi`),
    message('assistant', 'curto'),
    message('user', 'segue'),
  ];
}

const options = { ...resolveOptions(), preserveRecentMessages: 2 };

describe('text blocks', () => {
  it('finds injected blocks and long replies, and flags the earlier of two identical blocks', () => {
    const blocks = collectTextBlocks(transcript(), options);
    expect(blocks.map((block) => [block.index, block.kind])).toEqual([
      [1, 'skill'],
      [2, 'reply'],
      [3, 'command_output'],
      [4, 'context_report'],
      [5, 'command_output'],
    ]);
    expect(blocks.find((block) => block.kind === 'skill')?.label).toBe('skill ui-ux-pro-max');
    expect(blocks.filter((block) => block.duplicate).map((block) => block.index)).toEqual([3]);
  });

  it('removes what Jev drops, keeps the typed text and the ARGUMENTS line', async () => {
    const seen: Seen[] = [];
    const result = await compact(transcript(), fakeJev(() => 0.1, seen), options);
    const texts = result.messages.map((m) => m.text);
    expect(texts[1]).toContain('[fast-jev-compaction removed skill ui-ux-pro-max');
    expect(texts[1]).toContain('ARGUMENTS: o que recomenda?');
    expect(texts[1]).not.toContain('rule about contrast');
    expect(texts[3]).toBe('[fast-jev-compaction removed command output "Compacted (ctrl+o to see full summary)": repeated later]\nveja ai');
    expect(texts[4]).toMatch(/^\[fast-jev-compaction removed \/context report: \d+ chars\]$/);
    expect(texts[2]).toContain('Resultado da investigação.');
    expect(texts[2]).toContain('Fim da resposta.');
    expect(texts[2]).toContain('abridged');
    expect(texts[0]).toBe('Monte o painel do Claude Code.');
    expect(result.stats).toMatchObject({ textsRemoved: 2, duplicatesRemoved: 1, repliesAbridged: 1 });
    expect(seen.flatMap((s) => s.questions)).not.toContain('text_x3');
  });

  it('keeps blocks Jev wants and never asks about pinned messages', async () => {
    const seen: Seen[] = [];
    const messages = transcript();
    const result = await compact(messages, fakeJev(() => 0.9, seen), options);
    expect(result.messages[2]).toBe(messages[2]);
    expect(result.messages[1]!.text).toBe(messages[1]!.text);
    expect(result.messages[5]!.text).toBe(messages[5]!.text);
    const asked = seen.flatMap((s) => s.questions);
    expect(asked).toEqual(['text_x1', 'text_x2', 'text_x4']);
  });

  it('abridges a long reply around surrogate pairs, and leaves aligned cuts alone', async () => {
    const straddling = `${'a'.repeat(599)}🎯${'b'.repeat(3000)}🚀${'c'.repeat(299)}`;
    const result = await compact(
      [message('user', 'faça'), message('assistant', straddling)],
      fakeJev(() => 0.1),
      { ...resolveOptions(), preserveRecentMessages: 0 },
    );
    const abridged = result.messages[1]?.text ?? '';

    expect(abridged).toBe(
      `${'a'.repeat(599)}\n[fast-jev-compaction abridged 3002 chars of this reply]\n🚀${'c'.repeat(299)}`,
    );
    expect(LONE_SURROGATE.test(abridged)).toBe(false);

    const aligned = `${'a'.repeat(600)}🎯${'b'.repeat(3000)}`;
    const plain = await compact(
      [message('user', 'faça'), message('assistant', aligned)],
      fakeJev(() => 0.1),
      { ...resolveOptions(), preserveRecentMessages: 0 },
    );
    expect(plain.messages[1]?.text).toBe(
      `${'a'.repeat(600)}\n[fast-jev-compaction abridged ${aligned.length - 900} chars of this reply]\n${'b'.repeat(300)}`,
    );
  });

  it('shows injected blocks to Jev as an id note, not their contents', async () => {
    const seen: Seen[] = [];
    await compact(transcript(), fakeJev(() => 0.9, seen), options);
    const state = JSON.stringify(seen[0]!.state);
    expect(state).toContain('[x1: skill ui-ux-pro-max');
    expect(state).not.toContain('rule about contrast');
    expect(state).toContain('"text_block":"x2"');
  });

  it('leaves all message text alone when both thresholds are 0', async () => {
    const off = { ...options, injectedMinChars: 0, replyMinChars: 0 };
    const result = await compact(transcript(), fakeJev(() => 0), off);
    expect(result.messages.map((m) => m.text)).toEqual(transcript().map((m) => m.text));
    expect(result.stats.texts).toBe(0);
  });

  it('shares the 128-question ceiling with tool calls', () => {
    const blocks = collectTextBlocks(transcript(), options);
    const items = [
      ...Array.from({ length: 200 }, (_, i) => ({ call: `t${i + 1}` })),
      ...blocks.map((block) => ({ block })),
    ];
    const questionsOf = (item: { call: string } | { block: TextBlock }): JevQuestions =>
      'call' in item
        ? questionsFor({
            id: item.call,
            tool_use_id: '',
            tool: 'Read',
            input: {},
            callIndex: 0,
            resultIndex: 0,
            resultChars: 0,
            isError: false,
            pinned: false,
          })
        : textQuestionsFor(item.block);
    const state = { tokens: 1000 };
    const batches = batchItems(items, questionsOf, state.tokens, options);
    expect(batches.flat()).toHaveLength(items.length);
    for (const batch of batches) {
      const asked = batch.reduce((sum, item) => sum + Object.keys(questionsOf(item)).length, 0);
      expect(asked).toBeLessThanOrEqual(128);
    }
  });
});
