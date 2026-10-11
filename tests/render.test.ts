import { describe, expect, it } from 'vitest';
import { renderTranscript } from '../src/render.js';
import type { Message } from '../src/types.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

describe('renderTranscript', () => {
  it('renders roles, tool calls and results', () => {
    const messages: Message[] = [
      message('user', 'Fix the failing test.'),
      message('assistant', '', {
        toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' } }],
      }),
      message('user', '', {
        toolResults: [{ tool_use_id: 't1', text: 'FAIL expected 2', isError: true }],
      }),
      message('assistant', 'Two tests fail.'),
    ];
    expect(renderTranscript(messages)).toBe(
      [
        '## user',
        'Fix the failing test.',
        '',
        '## assistant',
        'tool Bash({"command":"npm test"})',
        '',
        '## user',
        'result Bash (error):',
        '  FAIL expected 2',
        '',
        '## assistant',
        'Two tests fail.',
      ].join('\n'),
    );
  });

  it('prints the output of a call that already carries it, and skips its result', () => {
    const messages: Message[] = [
      message('assistant', '', {
        toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' }, text: 'line one' }],
      }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: 'line one' }] }),
    ];
    const rendered = renderTranscript(messages);
    expect(rendered).toBe(['## assistant', 'tool Read({"file_path":"a.ts"})', '  line one'].join('\n'));
    expect(rendered.match(/line one/g)).toHaveLength(1);
  });

  it('labels an unpaired result by its id and skips empty messages', () => {
    const messages: Message[] = [
      message('user', ''),
      message('user', '', { toolResults: [{ tool_use_id: 'orphan', text: 'leftover' }] }),
    ];
    expect(renderTranscript(messages)).toBe('## user\nresult orphan:\n  leftover');
  });

  it('indents multi-line results and keeps empty tool inputs readable', () => {
    const messages: Message[] = [
      message('assistant', '', {
        toolUses: [{ tool_use_id: 't1', tool: 'Write', input: {} }],
      }),
      message('user', '', {
        toolResults: [{ tool_use_id: 't1', text: 'first\nsecond' }],
      }),
    ];
    expect(renderTranscript(messages)).toBe(
      ['## assistant', 'tool Write({})', '', '## user', 'result Write:', '  first', '  second'].join('\n'),
    );
  });

  it('renders nothing for an empty transcript', () => {
    expect(renderTranscript([])).toBe('');
    expect(renderTranscript([message('user', '   ')])).toBe('');
  });
});
