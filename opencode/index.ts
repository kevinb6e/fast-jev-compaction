/**
 * OpenCode (V2) adapter for fast-jev-compaction.
 *
 * OpenCode replaces the older conversation with a summary, so the pruned
 * transcript is rendered to text and handed back through the compaction hook.
 * Whenever Jev cannot shrink the transcript enough, or the rendered summary
 * would be too large for the compaction slot, the hook leaves `event.result`
 * unset and OpenCode's own summarizer runs instead.
 *
 * Install: point `plugins` in `opencode.json(c)` at this file, see README.md.
 */
import type { Context, Plugin } from '@opencode/plugin/promise/plugin';
import type { SessionCompaction } from '@opencode/plugin/promise/session';

import {
  applyRequestBudget,
  compact,
  DEFAULT_MODEL,
  estimateTokens,
  isJevProvider,
  JevClient,
  renderTranscript,
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

export const PLUGIN_ID = 'fast-jev-compaction';

type HostMessage = SessionCompaction['messages'][number];

export interface OpenCodeOptions extends CompactOptions {
  provider?: JevProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  /** Minimum shrink of the rendered transcript, else the host summarizer runs. */
  minReductionRatio: number;
  /** Token ceiling for the rendered summary, else the host summarizer runs. */
  maxSummaryTokens: number;
}

export const OPENCODE_DEFAULTS = {
  model: DEFAULT_MODEL,
  minReductionRatio: 0.25,
  maxSummaryTokens: 16384,
} as const;

const COMPACT_NUMERIC_OPTIONS = [
  'keepThreshold',
  'preserveRecentMessages',
  'maxStateTokens',
  'maxRequestTokens',
  'truncateHeadChars',
] as const;

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionNumber(
  options: Readonly<Record<string, unknown>>,
  key: string,
  env: Readonly<Record<string, string | undefined>>,
  envKey: string,
  fallback: number,
): number {
  const value = options[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = envNumber(string(value) ?? env[envKey]);
  if (parsed !== undefined) return parsed;
  return fallback;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `options` from `opencode.json(c)` and `FAST_JEV_*` env vars; anything missing takes the defaults. */
export function resolvePluginOptions(
  options: Readonly<Record<string, unknown>> = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpenCodeOptions {
  const resolved: OpenCodeOptions = {
    model:
      string(options['model']) ?? env['FAST_JEV_MODEL'] ?? OPENCODE_DEFAULTS.model,
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      env,
      'FAST_JEV_MIN_REDUCTION',
      OPENCODE_DEFAULTS.minReductionRatio,
    ),
    maxSummaryTokens: optionNumber(
      options,
      'maxSummaryTokens',
      env,
      'FAST_JEV_MAX_SUMMARY_TOKENS',
      OPENCODE_DEFAULTS.maxSummaryTokens,
    ),
  };
  const provider = string(options['provider']) ?? env['FAST_JEV_PROVIDER'];
  if (isJevProvider(provider)) resolved.provider = provider;
  const apiKey = string(options['apiKey']) ?? env['FAST_JEV_API_KEY'];
  if (apiKey) resolved.apiKey = apiKey;
  const baseUrl = string(options['baseUrl']) ?? env['FAST_JEV_BASE_URL'];
  if (baseUrl) resolved.baseUrl = baseUrl;
  const goal = string(options['goal']) ?? env['FAST_JEV_GOAL'];
  if (goal) resolved.goal = goal;
  for (const key of COMPACT_NUMERIC_OPTIONS) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      resolved[key] = value;
      continue;
    }
  }
  // A model swap has to carry its own context budget; the decision models range
  // from 7 168 to 524 288 usable request tokens.
  return applyRequestBudget(resolved);
}

function toInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

function toResultText(result: { readonly type: string; readonly value: unknown }): string {
  if (result.type === 'content' && Array.isArray(result.value)) {
    return result.value
      .map((item) => {
        if (typeof item !== 'object' || item === null) return '';
        const entry = item as { type?: unknown; text?: unknown; mime?: unknown; uri?: unknown };
        if (entry.type === 'text' && typeof entry.text === 'string') return entry.text;
        if (entry.type === 'file') return `[attached ${String(entry.mime ?? 'file')}: ${String(entry.uri ?? '')}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  const value = result.value;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Maps the transcript OpenCode is summarising onto the library's messages:
 * assistant messages keep their text and tool calls, tool messages become the
 * results, everything else (media, reasoning, effort markers) is left out.
 */
export function fromHostMessages(messages: readonly HostMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    const text: string[] = [];
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        text.push(part.text);
      } else if (part.type === 'tool-call') {
        toolUses.push({ tool_use_id: part.id, tool: part.name, input: toInput(part.input) });
      } else if (part.type === 'tool-result') {
        toolResults.push({
          tool_use_id: part.id,
          text: toResultText(part.result),
          isError: part.result.type === 'error',
        });
      }
    }
    const entry: Message = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: text.join('\n'),
      toolUses,
    };
    if (toolResults.length > 0) entry.toolResults = toolResults;
    converted.push(entry);
  }
  return converted;
}

/** What a previous compaction left behind, for a summary that must carry it forward. */
export interface PriorSummary {
  /** Readable previous summary text. */
  text?: string;
  /** A previous checkpoint exists but cannot be read into a new summary. */
  opaque?: boolean;
  /** Why it cannot be read, for the fallback log line. */
  reason?: string;
}

/**
 * A previous summary that rides along inside the transcript, read from a
 * `compaction` part: `text` is the summary, `encrypted` is a provider-native
 * checkpoint no summary can preserve.
 */
export function inBandSummary(messages: readonly HostMessage[]): PriorSummary {
  let prior: PriorSummary = {};
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'compaction') continue;
      if (typeof part.text === 'string' && part.text.trim().length > 0) {
        prior = { text: part.text };
      } else if (typeof part.encrypted === 'string' && part.encrypted.length > 0) {
        prior = { opaque: true, reason: 'the previous checkpoint is provider-encrypted' };
      }
    }
  }
  return prior;
}

/** The shape of `ctx.session.context()` entries this adapter reads. */
export interface ContextEntry {
  readonly type?: unknown;
  readonly status?: unknown;
  readonly summary?: unknown;
}

/**
 * The last completed compaction summary of a session, from its context
 * messages. Running and failed compactions are skipped: only a completed one
 * replaced history, and an empty summary there is a checkpoint we cannot read.
 */
export function contextSummary(messages: readonly ContextEntry[]): PriorSummary {
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index];
    if (!entry || entry.type !== 'compaction') continue;
    if (entry.status !== undefined && entry.status !== 'completed') continue;
    const summary = entry.summary;
    if (typeof summary === 'string' && summary.trim().length > 0) return { text: summary };
    return { opaque: true, reason: 'the previous compaction has no readable summary' };
  }
  return {};
}

/** Carries the previous summary forward, unless the transcript already holds it. */
export function carryPrevious(previous: string | undefined, body: string): string {
  if (!previous) return body;
  const probe = previous.trim().slice(0, 200);
  if (probe.length > 0 && body.includes(probe)) return body;
  return `${previous.trim()}\n\n---\n\n${body}`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export interface SummaryOutcome {
  /** The summary to record; missing means the host summarizer should run. */
  summary?: string;
  /** Why the host summarizer should run, when `summary` is missing. */
  reason?: string;
  result?: CompactResult;
  reduction?: number;
}

/**
 * Runs Jev over the transcript and renders the pruned result. The reduction is
 * measured on the rendered text (what the slot actually receives), and the
 * previous summary counts toward the token ceiling but not toward the
 * reduction, since it is carried verbatim either way.
 */
export async function buildSummary(
  hostMessages: readonly HostMessage[],
  options: OpenCodeOptions,
  previous: PriorSummary = {},
  asker?: JevAsker,
): Promise<SummaryOutcome> {
  if (previous.opaque) return { reason: previous.reason ?? 'previous summary is not readable' };

  const messages = fromHostMessages(hostMessages);
  const original = renderTranscript(messages);
  const client =
    asker ??
    new JevClient({
      apiKey: options.apiKey,
      provider: options.provider,
      baseUrl: options.baseUrl,
      model: options.model,
    });
  const result = await compact(messages, client, options);
  const pruned = renderTranscript(result.messages);
  const reduction =
    original.length > 0 ? (original.length - pruned.length) / original.length : 0;
  if (reduction < options.minReductionRatio) {
    return {
      reason: `reduction ${percent(reduction)} below ${percent(options.minReductionRatio)} minimum`,
      result,
      reduction,
    };
  }
  const summary = carryPrevious(previous.text, pruned);
  const tokens = estimateTokens(summary);
  if (tokens > options.maxSummaryTokens) {
    return {
      reason: `summary of ~${tokens} tokens exceeds ${options.maxSummaryTokens}`,
      result,
      reduction,
    };
  }
  return { summary, result, reduction };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(text: string): void {
  console.log(`[${PLUGIN_ID}] ${text}`);
}

function statsLine(outcome: SummaryOutcome): string {
  const { result, reduction } = outcome;
  if (!result) return `${percent(reduction ?? 0)} reduction`;
  const { stats } = result;
  return [
    `${percent(reduction ?? 0)} reduction`,
    `${stats.resultsDropped} results truncated`,
    `${stats.callsDropped} calls dropped`,
    `~${stats.stateTokens} state tokens in ${stats.requests} request(s)`,
    `${stats.ms}ms`,
  ].join(', ');
}

async function readPrior(ctx: Context, event: SessionCompaction): Promise<PriorSummary> {
  const band = inBandSummary(event.messages);
  if (band.text || band.opaque) return band;
  try {
    const context = await ctx.session.context({ sessionID: event.sessionID });
    return contextSummary(context);
  } catch (error) {
    return {
      opaque: true,
      reason: `cannot read the session context (${messageOf(error)})`,
    };
  }
}

/**
 * The `compaction` hook: Jev's pruned transcript when it shrinks the transcript
 * enough, otherwise nothing, which lets OpenCode summarise it the way it
 * normally would. Returns whether `event.result` was recorded.
 */
export async function handleCompaction(
  event: SessionCompaction,
  ctx: Context,
  options: OpenCodeOptions = resolvePluginOptions(ctx.options),
  asker?: JevAsker,
): Promise<boolean> {
  try {
    const prior = await readPrior(ctx, event);
    const outcome = await buildSummary(event.messages, options, prior, asker);
    if (!outcome.summary) {
      log(`falls back to OpenCode's summarizer: ${outcome.reason}`);
      return false;
    }
    event.result = {
      summary: outcome.summary,
      metadata: {
        fastJev: {
          reduction: outcome.reduction ?? 0,
          messages: outcome.result?.stats.messagesAfter ?? 0,
          resultsDropped: outcome.result?.stats.resultsDropped ?? 0,
          callsDropped: outcome.result?.stats.callsDropped ?? 0,
          provider: options.provider ?? 'auto',
          carriedPreviousSummary: Boolean(prior.text),
        },
      },
    };
    log(`recorded summary (${statsLine(outcome)})`);
    return true;
  } catch (error) {
    log(`falls back to OpenCode's summarizer: ${messageOf(error)}`);
    return false;
  }
}

const plugin: Plugin = {
  id: PLUGIN_ID,
  async setup(ctx: Context) {
    const options = resolvePluginOptions(ctx.options);
    await ctx.session.hook('compaction', async (event: SessionCompaction) => {
      await handleCompaction(event, ctx, options);
    });
  },
};

export default plugin;
