import { JevClient } from '../client.js';
import { applyActions, compact, resolveOptions } from '../compact.js';
import { envOverrides } from '../env-config.js';
import {
  apiKeyFor,
  inferJevProvider,
  isJevProvider,
  PROVIDERS,
  PROVIDER_OVERRIDE_ENV_KEY,
  type JevProvider,
} from '../request.js';
import { collectToolCalls, estimateTokens } from '../state.js';
import type {
  CallAction,
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ResolvedCompactOptions,
} from '../types.js';

/**
 * Options of the continuous pruner used by the OpenCode adapters. Every
 * `CompactOptions` key is passed to the library; the rest decides when a pass
 * runs and how Jev is reached.
 */
export interface PrunerOptions extends CompactOptions {
  /**
   * Where Jev is reached. `typesafe` is TypeSafe's own endpoint (needs
   * `TYPESAFE_API_KEY`), `openrouter` its System One route (needs
   * `OPENROUTER_API_KEY`), `opencode` OpenCode Console (needs
   * `OPENCODE_API_KEY`), `zen` OpenCode Zen's free Jev (no key needed).
   * Default: `typesafe` when a TypeSafe key is available, `openrouter` when
   * an OpenRouter key is, `zen` otherwise.
   */
  provider?: JevProvider;
  /** API key for the provider; defaults to the provider's environment variable. */
  apiKey?: string;
  /** Jev model name. Default: the provider's own (`jev-1.13-free` on Zen). */
  model?: string;
  /** System One endpoint override. */
  baseUrl?: string;
  /** Milliseconds without Jev requests after one fails. Default 60000. */
  cooldownMs?: number;
  /** Percentage of the context window at which a pass runs. Default 60. */
  compactAtPercent?: number;
  /** Context window assumed when the host does not report one. Default 200000. */
  contextTokens?: number;
  /**
   * Largest verbatim checkpoint (estimated tokens) an OpenCode 2 compaction
   * hook will supply instead of the built-in summary. Default 40000.
   */
  checkpointTokens?: number;
}

export interface ResolvedPrunerOptions extends ResolvedCompactOptions {
  provider: JevProvider;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  compactAtPercent: number;
  contextTokens: number;
  checkpointTokens: number;
  cooldownMs: number;
}

export const PRUNER_DEFAULTS = {
  compactAtPercent: 60,
  contextTokens: 200_000,
  checkpointTokens: 40_000,
  cooldownMs: 60_000,
} as const;

const NUMBER_KEYS = [
  'keepThreshold',
  'preserveRecentMessages',
  'maxStateTokens',
  'maxRequestTokens',
  'truncateHeadChars',
  'compactAtPercent',
  'contextTokens',
  'checkpointTokens',
  'cooldownMs',
] as const;

type NumberKey = (typeof NUMBER_KEYS)[number];

/**
 * Reads an untyped options bag (an OpenCode plugin's `options`) into resolved
 * pruner options. Anything missing or malformed takes the default. The provider
 * comes from the shared ladder (`inferJevProvider`), so a TypeSafe key is
 * reached at TypeSafe, an OpenRouter key at OpenRouter, and a lone
 * `OPENCODE_API_KEY` at OpenCode Console; with no key at all this adapter's own
 * terminal applies, OpenCode Zen's free Jev. `FAST_JEV_PROVIDER` and
 * `FAST_JEV_MODEL` in `env` stand in for the `provider` and `model` options
 * (options win), so a plugin-directory install that takes no options can still
 * choose; a model written the OpenCode way, `opencode/jev-1.13-free`, selects
 * Zen by itself.
 */
export function readPrunerOptions(
  options: Readonly<Record<string, unknown>> = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedPrunerOptions {
  const numbers: Partial<Record<NumberKey, number>> = {};
  for (const key of NUMBER_KEYS) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  // Parity with omp: a plugin that takes no options (a directory install) still
  // reads the shared `FAST_JEV_*` names. An explicit option always wins, so the
  // environment only fills the keys the options bag left unset.
  const over = envOverrides(env);
  for (const key of NUMBER_KEYS) {
    if (key in numbers) continue;
    const fromEnv = over[key];
    if (typeof fromEnv === 'number') numbers[key] = fromEnv;
  }
  const string = (key: string): string | undefined => {
    const value = options[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const apiKeyOption = string('apiKey');
  let model = string('model') ?? (env['FAST_JEV_MODEL'] || undefined);
  // An OpenCode-style model name selects Zen by itself; the prefix is stripped
  // so the slug that reaches the endpoint is the bare one.
  const opencodeModel = model?.startsWith('opencode/') ?? false;
  if (opencodeModel) model = model!.slice('opencode/'.length);

  // Named outright: the option, then `FAST_JEV_PROVIDER`, then OpenCode's own
  // model convention. Everything below that is inferred by the shared ladder.
  const named =
    string('provider') ??
    (env[PROVIDER_OVERRIDE_ENV_KEY] || undefined) ??
    (opencodeModel ? 'zen' : undefined);
  // The terminal is this adapter's own, and it is conditional: a supplied key
  // pins the endpoint (TypeSafe), while a keyless adapter falls back to Zen's
  // free Jev. `baseUrl` is deliberately not passed, because endpoint resolution
  // must not change the provider: a keyless baseUrl on Console works today, and
  // inferring `opencode` there would switch to a model that needs a key.
  const provider: ResolvedPrunerOptions['provider'] =
    inferJevProvider(
      { provider: isJevProvider(named) ? named : undefined },
      // A supplied key pins the endpoint, so the environment's keys must not
      // override it; an explicit provider override still applies.
      apiKeyOption === undefined
        ? env
        : { [PROVIDER_OVERRIDE_ENV_KEY]: env[PROVIDER_OVERRIDE_ENV_KEY] },
    ) ?? (apiKeyOption === undefined ? 'zen' : 'typesafe');

  const resolved: ResolvedPrunerOptions = {
    ...resolveOptions({
      goal: string('goal'),
      keepThreshold: numbers.keepThreshold,
      preserveRecentMessages: numbers.preserveRecentMessages,
      maxStateTokens: numbers.maxStateTokens,
      maxRequestTokens: numbers.maxRequestTokens,
      truncateHeadChars: numbers.truncateHeadChars,
    }),
    provider,
    model: model ?? PROVIDERS[provider].model,
    compactAtPercent: numbers.compactAtPercent ?? PRUNER_DEFAULTS.compactAtPercent,
    contextTokens: numbers.contextTokens ?? PRUNER_DEFAULTS.contextTokens,
    checkpointTokens: numbers.checkpointTokens ?? PRUNER_DEFAULTS.checkpointTokens,
    cooldownMs: Math.max(0, numbers.cooldownMs ?? PRUNER_DEFAULTS.cooldownMs),
  };
  const apiKey = apiKeyOption ?? apiKeyFor(provider, env);
  if (apiKey) resolved.apiKey = apiKey;
  // Zen and Console both name their own URL, so the log line and `missingKey`
  // say where the call goes; TypeSafe is the assumed default.
  const baseUrl =
    string('baseUrl') ??
    (provider === 'zen' || provider === 'opencode' ? PROVIDERS[provider].url : undefined);
  if (baseUrl) resolved.baseUrl = baseUrl;
  return resolved;
}

/** True when the options cannot reach Jev at all: a keyed provider without a key. */
export function missingKey(options: ResolvedPrunerOptions): boolean {
  return options.provider !== 'zen' && !options.apiKey && !options.baseUrl;
}

/** One line naming where Jev is reached, for startup logs. */
export function describeProvider(options: ResolvedPrunerOptions): string {
  const where = options.baseUrl ?? 'TypeSafe';
  const auth = options.apiKey ? 'with key' : 'no key';
  return `${options.model} at ${where} (${auth})`;
}

/** A `JevClient` for the resolved options; `fetchFn` is for tests. */
export function jevClient(options: ResolvedPrunerOptions, fetchFn?: typeof fetch): JevClient {
  return new JevClient({
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl,
    provider: options.provider,
    fetch: fetchFn,
  });
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Estimated tokens of a transcript's text, tool inputs and tool results. */
export function transcriptTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.text);
    for (const tool of message.toolUses) total += estimateTokens(stringify(tool.input));
    for (const result of message.toolResults ?? []) total += estimateTokens(result.text);
  }
  return total;
}

/**
 * A transcript as plain text, one line per utterance, tool calls followed by
 * their outcome. Results are read from the `text` of each tool_use, so a
 * message holding only tool_results contributes nothing.
 */
export function renderTranscript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.text.trim()) lines.push(`[User]: ${message.text}`);
      continue;
    }
    if (message.text.trim()) lines.push(`[Assistant]: ${message.text}`);
    for (const tool of message.toolUses) {
      lines.push(`[Assistant tool call]: ${tool.tool}(${stringify(tool.input)})`);
      if (tool.text !== undefined) {
        lines.push(`[Tool ${tool.isError ? 'error' : 'result'}]: ${tool.text}`);
      }
    }
  }
  return lines.join('\n\n');
}

export type PruneReason = 'under_threshold' | 'no_candidates' | 'no_new_calls' | 'cooldown' | 'pruned';

export interface PruneOutcome {
  reason: PruneReason;
  /** Every action decided so far for the session, keyed by `tool_use_id`. */
  actions: ReadonlyMap<string, CallAction>;
  /** Estimated tokens at which a pass runs. */
  threshold: number;
  /** Estimated tokens of the transcript with the previous actions applied. */
  tokensBefore: number;
  /** Estimated tokens with every action applied. */
  tokensAfter: number;
  /** The library result of the pass, when one ran. */
  result?: CompactResult;
}

export interface PruneInput {
  /** The session's context window, when the host reports it. */
  contextTokens?: number;
  /** Overrides the option, so a host can count in its own message units. */
  preserveRecentMessages?: number;
  /** Runs a pass regardless of the threshold and of new calls. */
  force?: boolean;
}

interface SessionState {
  actions: Map<string, CallAction>;
  asked: Set<string>;
}

/**
 * Continuous compaction for hosts that expose the messages of every model
 * request but no hook that replaces a compaction: decisions are remembered
 * per session and re-applied to each request, and Jev is asked again only
 * when the transcript is above the threshold and holds a call it has not
 * been asked about. A result Jev drops stays dropped; a call it kept can be
 * dropped by a later pass. After a failed request nothing is asked for
 * `cooldownMs`, so an unreachable Jev costs one failure per cooldown, not one
 * per request.
 */
export class SessionPruner {
  private readonly sessions = new Map<string, SessionState>();
  /** When the last Jev failure happened; requests pause for `cooldownMs` after it. */
  private failedAt: number | undefined;

  constructor(
    private readonly asker: JevAsker,
    readonly options: ResolvedPrunerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while a recent Jev failure keeps requests paused. */
  coolingDown(): boolean {
    return this.failedAt !== undefined && this.now() - this.failedAt < this.options.cooldownMs;
  }

  /** The actions decided so far for a session. */
  actions(session: string): ReadonlyMap<string, CallAction> {
    return this.sessions.get(session)?.actions ?? new Map();
  }

  forget(session: string): void {
    this.sessions.delete(session);
  }

  private state(session: string): SessionState {
    let state = this.sessions.get(session);
    if (!state) {
      state = { actions: new Map(), asked: new Set() };
      this.sessions.set(session, state);
    }
    return state;
  }

  async prune(
    session: string,
    messages: readonly Message[],
    input: PruneInput = {},
  ): Promise<PruneOutcome> {
    const state = this.state(session);
    const headChars = this.options.truncateHeadChars;
    const applied = applyActions(messages, state.actions, headChars);
    const tokensBefore = transcriptTokens(applied);
    const contextTokens = input.contextTokens ?? this.options.contextTokens;
    const threshold = Math.floor((contextTokens * this.options.compactAtPercent) / 100);
    const base = { actions: state.actions, threshold, tokensBefore, tokensAfter: tokensBefore };
    if (!input.force && tokensBefore < threshold) return { ...base, reason: 'under_threshold' };

    const preserveRecentMessages = input.preserveRecentMessages ?? this.options.preserveRecentMessages;
    const candidates = collectToolCalls(applied, preserveRecentMessages).filter((call) => !call.pinned);
    if (candidates.length === 0) return { ...base, reason: 'no_candidates' };
    if (!input.force && candidates.every((call) => state.asked.has(call.tool_use_id))) {
      return { ...base, reason: 'no_new_calls' };
    }
    if (!input.force && this.coolingDown()) return { ...base, reason: 'cooldown' };

    let result: CompactResult;
    try {
      // Call-only passes: text blocks are the library's own feature, and the
      // pruner remembers call actions per session, so text questions are left
      // out to keep the measurement and the remembered state in step.
      result = await compact(applied, this.asker, {
        ...this.options,
        preserveRecentMessages,
        injectedMinChars: 0,
        replyMinChars: 0,
      });
    } catch (error) {
      this.failedAt = this.now();
      throw error;
    }
    this.failedAt = undefined;
    for (const call of candidates) state.asked.add(call.tool_use_id);
    for (const decision of result.decisions) {
      if (decision.action === 'keep') continue;
      const current = state.actions.get(decision.tool_use_id);
      if (decision.action === 'drop_call' || current === undefined) {
        state.actions.set(decision.tool_use_id, decision.action);
      }
    }
    const tokensAfter = transcriptTokens(applyActions(messages, state.actions, headChars));
    return { ...base, reason: 'pruned', result, tokensAfter };
  }
}

/** One line describing a pass, for logs and toasts. */
export function describeOutcome(outcome: PruneOutcome): string {
  const stats = outcome.result?.stats;
  const decisions = stats
    ? [
        stats.kept > 0 ? `${stats.kept} kept` : '',
        stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
        stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : '',
        stats.pinned > 0 ? `${stats.pinned} pinned` : '',
      ]
        .filter(Boolean)
        .join(', ') || 'no tool calls'
    : outcome.reason;
  const requests = stats ? ` in ${stats.requests} request(s)` : '';
  return `${decisions}; ~${outcome.tokensBefore} → ~${outcome.tokensAfter} tokens (threshold ${outcome.threshold})${requests}`;
}
