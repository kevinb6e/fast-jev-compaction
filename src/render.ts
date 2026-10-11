import type { Message } from './types.js';

function serialise(input: unknown): string {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return '[unserialisable input]';
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * Renders a transcript as plain text, for hosts that only accept a summary in
 * the compaction slot. Tool calls keep their input; a call that already carries
 * its output prints it right there, and a result whose text is carried by its
 * call is skipped so the same output never appears twice.
 */
export function renderTranscript(messages: readonly Message[]): string {
  const names = new Map<string, string>();
  const carried = new Set<string>();
  for (const message of messages) {
    for (const tool of message.toolUses) {
      names.set(tool.tool_use_id, tool.tool);
      if ((tool.text ?? '').length > 0) carried.add(tool.tool_use_id);
    }
  }

  const blocks: string[] = [];
  for (const message of messages) {
    const lines: string[] = [];
    if (message.text.trim().length > 0) lines.push(message.text);
    for (const tool of message.toolUses) {
      lines.push(`tool ${tool.tool}(${serialise(tool.input)})`);
      if (tool.text) lines.push(indent(tool.text));
    }
    for (const result of message.toolResults ?? []) {
      if (carried.has(result.tool_use_id)) continue;
      const label = names.get(result.tool_use_id) ?? result.tool_use_id;
      lines.push(`result ${label}${result.isError ? ' (error)' : ''}:`);
      lines.push(indent(result.text));
    }
    if (lines.length === 0) continue;
    blocks.push(`## ${message.role}\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n');
}
