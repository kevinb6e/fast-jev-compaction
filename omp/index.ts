/**
 * omp (oh-my-pi) extension for fast-jev-compaction.
 *
 * omp summarises the prepared region of a session before it is discarded, so
 * the pruned transcript is rendered to text and returned as the compaction
 * summary. `firstKeptEntryId` and `tokensBefore` come straight from the
 * preparation, which keeps the recent messages exactly where omp put them.
 * Whenever Jev cannot shrink the transcript enough, or the rendered summary
 * would be too large for the compaction slot, the handler returns `undefined`
 * and omp runs its own summarizer.
 *
 * Install: add this file to `extensions:` in your omp config, see README.md.
 */
import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from '@oh-my-pi/pi-coding-agent';

import {
  applyRequestBudget,
  compact,
  DEFAULT_MODEL,
  defaultModelFor,
  endpointHost,
  environmentEndpoint,
  estimateTokens,
  hasKeepSignal,
  isJevProvider,
  JevClient,
  PROVIDER_OVERRIDE_ENV_KEY,
  renderTranscript,
  resolveJevEndpoint,
  resolveJevProvider,
} from '../src/index.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  JevProvider,
  Message,
  ToolResult,
  ToolUse,
} from '../src/index.js';

export const EXTENSION_ID = 'fast-jev-compaction';

type Preparation = SessionBeforeCompactEvent['preparation'];
type HostMessage = Preparation['messagesToSummarize'][number];
type OmpCompaction = NonNullable<SessionBeforeCompactResult['compaction']>;

/** The file bookkeeping omp stores on a compaction entry. */
export interface OmpFileLists {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface OmpOptions extends CompactOptions {
  provider?: JevProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  /** Minimum shrink of the rendered transcript, else omp's summarizer runs. */
  minReductionRatio: number;
  /** A run that kept nothing goes to omp's summarizer, unless this is off. */
  requireKeepSignal: boolean;
  /** Token ceiling for the rendered summary, else omp's summarizer runs. */
  maxSummaryTokens: number;
}

export const OMP_DEFAULTS = {
  model: DEFAULT_MODEL,
  minReductionRatio: 0.25,
  requireKeepSignal: false,
  maxSummaryTokens: 16384,
} as const;

type NumericKey =
  | 'keepThreshold'
  | 'preserveRecentMessages'
  | 'maxStateTokens'
  | 'maxRequestTokens'
  | 'truncateHeadChars'
  | 'minReductionRatio'
  | 'maxSummaryTokens';

const NUMERIC_ENV: ReadonlyArray<readonly [string, NumericKey]> = [
  ['FAST_JEV_KEEP_THRESHOLD', 'keepThreshold'],
  ['FAST_JEV_PRESERVE_RECENT', 'preserveRecentMessages'],
  ['FAST_JEV_MAX_STATE_TOKENS', 'maxStateTokens'],
  ['FAST_JEV_MAX_REQUEST_TOKENS', 'maxRequestTokens'],
  ['FAST_JEV_TRUNCATE_HEAD_CHARS', 'truncateHeadChars'],
  ['FAST_JEV_MIN_REDUCTION', 'minReductionRatio'],
  ['FAST_JEV_MAX_SUMMARY_TOKENS', 'maxSummaryTokens'],
];

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `1`/`true`/`yes` and `0`/`false`/`no`; anything else leaves the default. */
function envBool(value: string | undefined): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes') return true;
  if (text === '0' || text === 'false' || text === 'no') return false;
  return undefined;
}

/** Reads the `FAST_JEV_*` environment; anything missing takes the defaults. */
export function resolveOmpOptions(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OmpOptions {
  const options: OmpOptions = {
    // Filled in below once the provider is known: an unset model follows the
    // resolved provider, so `FAST_JEV_PROVIDER=opencode` cannot ship a slug that
    // host rejects. `OMP_DEFAULTS.model` stays exported for callers that read it.
    model: env['FAST_JEV_MODEL'] || '',
    minReductionRatio: envNumber(env['FAST_JEV_MIN_REDUCTION']) ?? OMP_DEFAULTS.minReductionRatio,
    requireKeepSignal:
      envBool(env['FAST_JEV_REQUIRE_KEEP_SIGNAL']) ?? OMP_DEFAULTS.requireKeepSignal,
    maxSummaryTokens:
      envNumber(env['FAST_JEV_MAX_SUMMARY_TOKENS']) ?? OMP_DEFAULTS.maxSummaryTokens,
  };
  const provider = env[PROVIDER_OVERRIDE_ENV_KEY];
  if (isJevProvider(provider)) options.provider = provider;
  const apiKey = env['FAST_JEV_API_KEY'];
  if (apiKey) options.apiKey = apiKey;
  const baseUrl =
    env['FAST_JEV_BASE_URL'] ?? environmentEndpoint(env, resolveJevProvider(options, env));
  if (baseUrl) options.baseUrl = baseUrl;
  const goal = env['FAST_JEV_GOAL'];
  if (goal) options.goal = goal;
  for (const [name, key] of NUMERIC_ENV) {
    const value = envNumber(env[name]);
    if (value !== undefined) options[key] = value;
  }
  if (!options.model) options.model = defaultModelFor(resolveJevProvider(options, env));
  // A model swap has to carry its own context budget; the decision models range
  // from 7 168 to 524 288 usable request tokens.
  return applyRequestBudget(options);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as readonly unknown[]) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === 'text' && typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

function toMessage(message: HostMessage): Message | undefined {
  switch (message.role) {
    case 'assistant': {
      const text: string[] = [];
      const toolUses: ToolUse[] = [];
      for (const block of message.content) {
        if (block.type === 'text') text.push(block.text);
        else if (block.type === 'toolCall') {
          toolUses.push({ tool_use_id: block.id, tool: block.name, input: block.arguments });
        }
      }
      return { role: 'assistant', text: text.join('\n'), toolUses };
    }
    case 'toolResult': {
      const toolResult: ToolResult = {
        tool_use_id: message.toolCallId,
        text: textOf(message.content),
        isError: message.isError,
      };
      return { role: 'user', text: '', toolUses: [], toolResults: [toolResult] };
    }
    case 'bashExecution': {
      const exit = message.exitCode ? ` (exit ${message.exitCode})` : '';
      const text = [`$ ${message.command}${exit}`, message.output].filter(Boolean).join('\n');
      return text.trim() ? { role: 'user', text, toolUses: [] } : undefined;
    }
    case 'pythonExecution': {
      const exit = message.exitCode ? ` (exit ${message.exitCode})` : '';
      const text = [`>>> ${message.code}${exit}`, message.output].filter(Boolean).join('\n');
      return text.trim() ? { role: 'user', text, toolUses: [] } : undefined;
    }
    case 'branchSummary':
      return { role: 'user', text: `[branch summary]\n${message.summary}`, toolUses: [] };
    case 'compactionSummary':
      return { role: 'user', text: `[context summary]\n${message.summary}`, toolUses: [] };
    case 'fileMention': {
      const lines = message.files.map((file) =>
        file.content
          ? `@${file.path}\n${file.content}`
          : `@${file.path}${file.skippedReason ? ` (omitted: ${file.skippedReason})` : ''}`,
      );
      return lines.length > 0 ? { role: 'user', text: lines.join('\n\n'), toolUses: [] } : undefined;
    }
    default: {
      const text = textOf((message as { content?: unknown }).content);
      return text.trim() ? { role: 'user', text, toolUses: [] } : undefined;
    }
  }
}

/**
 * Maps the prepared region onto the library's messages: assistant messages
 * keep their text and tool calls, tool results become the paired results, and
 * the agent's own message types (shell runs, file mentions, summaries) render
 * as the text they stand for.
 */
export function fromAgentMessages(messages: readonly HostMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    const entry = toMessage(message);
    if (entry) converted.push(entry);
  }
  return converted;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILES_TAG_LIMIT = 20;

/** omp's file bookkeeping: modified = written or edited, read = read only. */
export function fileLists(fileOps: {
  read: ReadonlySet<string>;
  written: ReadonlySet<string>;
  edited: ReadonlySet<string>;
}): OmpFileLists {
  const modified = new Set(
    [...fileOps.edited, ...fileOps.written].filter((path) => !URL_SCHEME.test(path)),
  );
  const readFiles = [...fileOps.read]
    .filter((path) => !URL_SCHEME.test(path) && !modified.has(path))
    .sort();
  return { readFiles, modifiedFiles: [...modified].sort() };
}

function stripFilesTag(summary: string): string {
  return summary
    .replace(/<files>[\s\S]*?<\/files>\s*/g, '')
    .replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, '')
    .replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, '');
}

function filesTag(files: OmpFileLists, readSet: ReadonlySet<string>): string {
  const { readFiles, modifiedFiles } = files;
  if (readFiles.length === 0 && modifiedFiles.length === 0) return '';
  const mode = new Map<string, string>();
  for (const file of readFiles) mode.set(file, 'Read');
  for (const file of modifiedFiles) mode.set(file, readSet.has(file) ? 'RW' : 'Write');
  const all = [...mode.keys()].sort();
  const lines = all
    .slice(0, FILES_TAG_LIMIT)
    .map((file) => `${file} (${mode.get(file) ?? 'Read'})`);
  if (all.length > FILES_TAG_LIMIT) lines.push(`[…${all.length - FILES_TAG_LIMIT} files elided…]`);
  return `<files>\n${lines.join('\n')}\n</files>`;
}

/** omp keeps a cumulative `<files>` tag on summaries; stripping first makes repeated compactions idempotent. */
export function appendFilesTag(
  summary: string,
  files: OmpFileLists,
  readSet: ReadonlySet<string>,
): string {
  const base = stripFilesTag(summary).replace(/\s+$/, '');
  const tag = filesTag(files, readSet);
  if (!tag) return base;
  if (!base) return tag;
  return `${base}\n\n${tag}`;
}

export interface SummaryOutcome {
  /** The summary to record; missing means omp's summarizer should run. */
  summary?: string;
  /** Why omp's summarizer should run, when `summary` is missing. */
  reason?: string;
  result?: CompactResult;
  reduction?: number;
  /** File bookkeeping to store with the compaction entry. */
  files?: OmpFileLists;
}

/**
 * Runs Jev over the prepared region and renders the pruned result. The
 * reduction is measured on the rendered text (what the slot actually receives)
 * and spans the turn prefix on a split turn; the previous summary and the
 * `<files>` tag count toward the token ceiling but not toward the reduction,
 * since they are carried verbatim either way.
 */
export async function buildSummary(
  preparation: Preparation,
  options: OmpOptions,
  asker?: JevAsker,
): Promise<SummaryOutcome> {
  const files = fileLists(preparation.fileOps);
  const body = fromAgentMessages(preparation.messagesToSummarize);
  const turnPrefix =
    preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0
      ? fromAgentMessages(preparation.turnPrefixMessages)
      : [];

  const originalLength = renderTranscript(body).length + renderTranscript(turnPrefix).length;
  const client =
    asker ??
    new JevClient({
      apiKey: options.apiKey,
      provider: options.provider,
      baseUrl: options.baseUrl,
      model: options.model,
    });

  const result = await compact(body, client, options);
  const prunedBody = renderTranscript(result.messages);
  const turnResult = turnPrefix.length > 0 ? await compact(turnPrefix, client, options) : undefined;
  const prunedTurn = turnResult ? renderTranscript(turnResult.messages) : '';
  const reduction =
    originalLength > 0 ? (originalLength - (prunedBody.length + prunedTurn.length)) / originalLength : 0;
  if (options.requireKeepSignal && !hasKeepSignal(result)) {
    return { reason: 'no keep signal: Jev dropped every call it judged', result, reduction, files };
  }
  if (reduction < options.minReductionRatio) {
    return {
      reason: `reduction ${percent(reduction)} below ${percent(options.minReductionRatio)} minimum`,
      result,
      reduction,
      files,
    };
  }

  const sections: string[] = [];
  const previous = preparation.previousSummary?.trim();
  if (previous) sections.push(previous);
  sections.push(prunedBody);
  if (prunedTurn.trim()) sections.push(`**Turn Context (split turn):**\n\n${prunedTurn}`);
  const summary = appendFilesTag(sections.join('\n\n---\n\n'), files, preparation.fileOps.read);

  const tokens = estimateTokens(summary);
  if (tokens > options.maxSummaryTokens) {
    return {
      reason: `summary of ~${tokens} tokens exceeds ${options.maxSummaryTokens}`,
      result,
      reduction,
      files,
    };
  }
  return { summary, result, reduction, files };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statsLine(outcome: SummaryOutcome, host?: string): string {
  const parts = [`${percent(outcome.reduction ?? 0)} reduction`];
  if (outcome.result) {
    parts.push(
      `${outcome.result.stats.resultsDropped} results truncated`,
      `${outcome.result.stats.callsDropped} calls dropped`,
      `~${outcome.result.stats.stateTokens} state tokens in ${outcome.result.stats.requests} request(s)`,
      `${outcome.result.stats.ms}ms`,
    );
  }
  if (host) parts.push(`via ${host}`);
  return parts.join(', ');
}

/**
 * The `session_before_compact` handler: Jev's pruned transcript when it shrinks
 * the prepared region enough, otherwise nothing, which lets omp summarise it
 * the way it normally would.
 */
export async function handleBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: {
    ui: { notify: (message: string, type?: 'info' | 'warning' | 'error') => void };
  },
  options: OmpOptions = resolveOmpOptions(),
  asker?: JevAsker,
): Promise<SessionBeforeCompactResult | undefined> {
  if (event.signal?.aborted) return undefined;
  try {
    const outcome = await buildSummary(
      event.preparation,
      { ...options, instructions: event.customInstructions ?? options.instructions },
      asker,
    );
    if (!outcome.summary) {
      ctx.ui.notify(`${EXTENSION_ID}: falling back to omp's summarizer (${outcome.reason})`, 'warning');
      return undefined;
    }
    const preparation = event.preparation;
    ctx.ui.notify(
      `${EXTENSION_ID}: ${statsLine(
        outcome,
        endpointHost(
          resolveJevEndpoint({ provider: options.provider, baseUrl: options.baseUrl }).url,
        ),
      )}`,
      'info',
    );
    return {
      compaction: {
        summary: outcome.summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: outcome.files ?? { readFiles: [], modifiedFiles: [] },
      } satisfies OmpCompaction,
    };
  } catch (error) {
    ctx.ui.notify(
      `${EXTENSION_ID}: falling back to omp's summarizer (${messageOf(error)})`,
      'warning',
    );
    return undefined;
  }
}

export default function fastJevCompaction(pi: ExtensionAPI): void {
  const options = resolveOmpOptions();
  pi.on('session_before_compact', (event, ctx) => handleBeforeCompact(event, ctx, options));
}
