import { compact, JevClient, reductionRatio, type Message } from '../src/index.js';

// Decision-model benchmark. Run from the repo root:
// TRIALS=3 npx tsx benchmarks/bench-models.ts <model> ...
// Needs OPENROUTER_API_KEY in the environment.

let n = 0;
function call(tool: string, input: Record<string, unknown>, output: string, isError = false): Message[] {
  const tool_use_id = `toolu_${++n}`;
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id, tool, input, text: output, isError }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id, text: output, isError }] },
  ];
}
const user = (text: string): Message => ({ role: 'user', text, toolUses: [] });
const assistant = (text: string): Message => ({ role: 'assistant', text, toolUses: [] });
const parserTs = `export function parse(tokens: Token[]): Node {\n${'  // …\n'.repeat(120)}}\n`;
const legacyTs = `// legacy parser, do not touch\n${'export const legacy = true;\n'.repeat(80)}`;
const messages: Message[] = [
  user('Fix the failing parser test in the checkout service. Do not touch legacy/. Keep the public parser API backward compatible.'),
  assistant('I will inspect the test and the parser implementation first.'),
  ...call('Glob', { pattern: 'src/**/*.ts' }, 'src/parser.ts\nsrc/parser.test.ts\nsrc/legacy/parser.ts'),
  ...call('Read', { file_path: 'src/legacy/parser.ts' }, legacyTs),
  assistant('The legacy parser is unrelated; looking at the public one.'),
  ...call('Read', { file_path: 'src/parser.ts' }, parserTs),
  ...call('Bash', { command: 'npx vitest run src/parser.test.ts' }, 'FAIL src/parser.test.ts\n  parser > accepts a trailing comma\n    Expected: true\n    Received: false\n    at src/parser.test.ts:42:11', true),
  assistant('The parser rejects a comma before the closing brace because the token loop stops too early. Adding one transition without changing the exported API.'),
  ...call('Edit', { file_path: 'src/parser.ts', old_string: 'if (token === COMMA) advance();', new_string: 'if (token === COMMA) {\n  if (next === CLOSE_BRACE) continue;\n  advance();\n}' }, 'The file src/parser.ts has been updated.'),
  ...call('Bash', { command: 'npx vitest run src/parser.test.ts' }, 'PASS src/parser.test.ts\n  ✓ accepts a trailing comma (4 ms)'),
  assistant('The focused test passes. Running the full suite next.'),
  ...call('Bash', { command: 'npm test' }, 'PASS src/parser.test.ts\nPASS src/checkout.test.ts\nTest Suites: 2 passed, 2 total'),
  assistant('Everything passes. The change is isolated to the parser and the public API is unchanged.'),
  user('Great. Next, add a changelog entry for this fix.'),
];

const models = process.argv.slice(2);
const trials = Number(process.env.TRIALS ?? 3);

async function main() {
  for (const model of models) {
    for (let i = 0; i < trials; i++) {
      const usage: Array<Record<string, any>> = [];
      let raw = '';
      const trackedFetch: typeof fetch = async (input, init) => {
        const res = await fetch(input, init);
        const text = await res.text();
        raw = text;
        try {
          const body = JSON.parse(text);
          usage.push({ input_tokens: body.usage?.input_tokens, output_tokens: body.usage?.output_tokens, cost: body.usage?.cost, model: body.model });
        } catch { /* keep raw for errors */ }
        return new Response(text, { status: res.status, headers: res.headers });
      };
      const client = new JevClient({ provider: 'openrouter', model, apiKey: process.env.OPENROUTER_API_KEY, fetch: trackedFetch });
      try {
        const result = await compact(messages, client, { preserveRecentMessages: 2 });
        console.log(JSON.stringify({ model, trial: i + 1, ok: true, returnedModel: usage.map((u) => u.model), inputTokens: usage.reduce((s, u) => s + (u.input_tokens ?? 0), 0), costUsd: usage.reduce((s, u) => s + (u.cost ?? 0), 0), requests: result.stats.requests, ms: result.stats.ms, charsAfter: result.stats.charsAfter, reduction: Number(reductionRatio(result).toFixed(3)), messagesAfter: result.stats.messagesAfter, kept: result.stats.kept, resultsDropped: result.stats.resultsDropped, callsDropped: result.stats.callsDropped }));
      } catch (e) {
        console.log(JSON.stringify({ model, trial: i + 1, ok: false, error: String(e).slice(0, 220), raw: raw.slice(0, 220) }));
      }
    }
  }
}
main();
