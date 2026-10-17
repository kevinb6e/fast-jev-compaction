import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, hasKeepSignal, reductionRatio, resolveOptions } from '../src/compact.js';
import { renderTranscript } from '../src/render.js';
import { estimateTokens } from '../src/state.js';
import {
  apiKeyFor,
  buildJevRequest,
  defaultModelFor,
  endpointHost,
  environmentEndpoint,
  isJevProvider,
  missingApiKeyError,
  parseJevResponse,
  PROVIDER_OVERRIDE_ENV_KEY,
  PROVIDERS,
  resolveJevEndpoint,
  resolveJevProvider,
  type JevEndpointOptions,
  type JevProvider,
} from '../src/request.js';
import { applyRequestBudget } from '../src/models.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  requireKeepSignal: false,
  measureNativeSummary: false,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  provider?: JevProvider;
  baseUrl?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  requireKeepSignal: boolean;
  measureNativeSummary: boolean;
  metricsPath?: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionBool(options: PluginOptions, key: string, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'injectedMinChars',
    'replyMinChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    requireKeepSignal: optionBool(
      options,
      'requireKeepSignal',
      HOOK_DEFAULTS.requireKeepSignal,
    ),
    measureNativeSummary: optionBool(
      options,
      'measureNativeSummary',
      HOOK_DEFAULTS.measureNativeSummary,
    ),
  };
  const model = optionString(options, 'model');
  if (model) config.model = model;
  const metricsPath = optionString(options, 'metricsPath');
  if (metricsPath) config.metricsPath = metricsPath;
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const provider = optionString(options, 'provider');
  if (isJevProvider(provider)) config.provider = provider;
  const baseUrl = optionString(options, 'baseUrl');
  if (baseUrl) config.baseUrl = baseUrl;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  endpoint: JevEndpointOptions = {},
): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model, ...endpoint }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Where Jev is reached, for the log. */
export function describeProvider(config: HookConfig): string {
  return `${config.model ?? defaultModelFor(config.provider ?? 'typesafe')} at ${config.baseUrl ?? 'TypeSafe'} (${config.apiKey ? 'with key' : 'no key'})`;
}

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  // No environment lookup here: `register` has already resolved the provider
  // from the engine's env, so an unconfigured run names TypeSafe's key.
  const provider = resolveJevProvider({ provider: config.provider, baseUrl: config.baseUrl });
  const model = config.model ?? defaultModelFor(provider);
  // A model swap has to carry its own context budget: the ceilings differ by
  // two orders of magnitude across the decision models.
  const options = applyRequestBudget({ ...config, model });
  // OpenCode Zen's free Jev needs no key; every other provider does, unless an
  // endpoint override points at a proxy that adds its own.
  if (!options.apiKey && provider !== 'zen' && !options.baseUrl) {
    throw missingApiKeyError(provider);
  }
  const result = await compact(
    messages,
    jevAsker(fetchFn, options.apiKey ?? '', model, { provider, baseUrl: options.baseUrl }),
    options,
  );
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult, host?: string): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.textsRemoved > 0 ? `${stats.textsRemoved} text blocks removed` : '',
    stats.duplicatesRemoved > 0 ? `${stats.duplicatesRemoved} duplicates removed` : '',
    stats.repliesAbridged > 0 ? `${stats.repliesAbridged} replies abridged` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)${
    host ? ` via ${host}` : ''
  }`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  const calls = result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    );
  const texts = result.textDecisions
    .filter((d) => d.reason !== 'pinned' && d.reason !== 'small')
    .map((d) => `${d.id}:${d.kind}:${d.reason}/keep=${d.keep.toFixed(2)}`);
  return [...calls, ...texts].join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

/**
 * Evidence for the token and cost claims, written per compaction: what the
 * transcript weighed before and after, the state the decisions needed, and
 * (optionally) what the built-in summarizer would have produced.
 */
export type CompactionMeasurement = {
  at: string; // ISO timestamp
  trigger: string; // event.trigger
  outcome: 'replaced' | 'fallback';
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  tokensBefore: number; // estimated, same basis as tokensAfter
  tokensAfter: number; // estimated
  reduction: number; // (charsBefore - charsAfter) / charsBefore, 0 when charsBefore is 0
  stateTokens: number;
  requests: number;
  ms: number;
  contextTokens?: number; // real value from $.session.usage().context.tokens when present
  contextPercent?: number; // $.session.usage().context.percent when present
  fallbackReason?: string; // only on outcome 'fallback'
  nativeSummaryMessages?: number; // built-in compaction result, when measured
  nativeSummaryTokens?: number; // estimated with the same estimator
};

/**
 * Sizes a compaction from the same estimator and renderer the library uses, so
 * the numbers line up with the ones `result.stats` reports. Pure: the caller
 * supplies the timestamp and the transcripts.
 */
export function measurementOf(input: {
  at: string;
  trigger: string;
  outcome: CompactionMeasurement['outcome'];
  before: readonly Message[];
  after: readonly Message[];
  stateTokens: number;
  requests: number;
  ms: number;
  contextTokens?: number;
  contextPercent?: number;
  fallbackReason?: string;
  nativeSummary?: readonly Message[];
}): CompactionMeasurement {
  const beforeText = renderTranscript(input.before);
  const afterText = renderTranscript(input.after);
  const charsBefore = beforeText.length;
  const charsAfter = afterText.length;
  const measurement: CompactionMeasurement = {
    at: input.at,
    trigger: input.trigger,
    outcome: input.outcome,
    messagesBefore: input.before.length,
    messagesAfter: input.after.length,
    charsBefore,
    charsAfter,
    tokensBefore: estimateTokens(beforeText),
    tokensAfter: estimateTokens(afterText),
    reduction: charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore,
    stateTokens: input.stateTokens,
    requests: input.requests,
    ms: input.ms,
  };
  if (input.contextTokens !== undefined) measurement.contextTokens = input.contextTokens;
  if (input.contextPercent !== undefined) measurement.contextPercent = input.contextPercent;
  if (input.fallbackReason !== undefined) measurement.fallbackReason = input.fallbackReason;
  if (input.nativeSummary) {
    measurement.nativeSummaryMessages = input.nativeSummary.length;
    measurement.nativeSummaryTokens = estimateTokens(renderTranscript(input.nativeSummary));
  }
  return measurement;
}

/** The slice of `$` the measurement logger touches. */
type MeasurementLog = {
  ui: { log: (text: string) => void };
  fs: {
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
  };
};

/**
 * Always logs the measurement, and appends it to the JSONL file when one is
 * configured. Best-effort throughout: a missing file is created, and a failed
 * write is logged in one line rather than allowed to break the compaction.
 */
export async function logMeasurement(
  $: MeasurementLog,
  m: CompactionMeasurement,
  metricsPath?: string,
): Promise<void> {
  const line = JSON.stringify(m);
  $.ui.log(`fast-jev-compaction:measure ${line}`);
  if (!metricsPath) return;
  try {
    let existing = '';
    try {
      existing = await $.fs.read(metricsPath);
    } catch {
      existing = '';
    }
    await $.fs.write(metricsPath, existing + line + '\n');
  } catch (error) {
    $.ui.log(
      `fast-jev-compaction:measure failed to write ${metricsPath} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

/**
 * Resolves the provider and its key from the plugin's `userConfig`, then the
 * engine's environment, then the settings `env` block. The provider comes from
 * the `provider` option, then `FAST_JEV_PROVIDER` when it names one, then
 * whatever keys are actually set: a lone `OPENROUTER_API_KEY` calls Jev through
 * OpenRouter, a lone `OPENCODE_API_KEY` through OpenCode Console.
 */
export async function getCredentials(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<{ apiKey?: string; provider: JevProvider; baseUrl?: string }> {
  const settings = await $.settings.read();
  const settingsEnv = settings['env'];
  const fromSettings = (name: string): string | undefined => {
    const value =
      settingsEnv && typeof settingsEnv === 'object'
        ? (settingsEnv as Record<string, unknown>)[name]
        : undefined;
    return typeof value === 'string' && value ? value : undefined;
  };
  const prefer = (fromEnv: string | undefined, name: string): string | undefined =>
    fromEnv ?? fromSettings(name);

  // `$.env.get` requires a literal name - the engine lists the variables a
  // module reads by reading its source, so it refuses a computed one. Each
  // variable is therefore spelled out here; `PROVIDERS` names which provider
  // uses which, and the provider test pins the two together.
  const env: Record<string, string | undefined> = {
    [PROVIDERS.typesafe.envKey]: prefer(await $.env.get('TYPESAFE_API_KEY'), 'TYPESAFE_API_KEY'),
    [PROVIDERS.openrouter.envKey]: prefer(
      await $.env.get('OPENROUTER_API_KEY'),
      'OPENROUTER_API_KEY',
    ),
    [PROVIDERS.opencode.envKey]: prefer(await $.env.get('OPENCODE_API_KEY'), 'OPENCODE_API_KEY'),
    [PROVIDER_OVERRIDE_ENV_KEY]: prefer(
      await $.env.get('FAST_JEV_PROVIDER'),
      PROVIDER_OVERRIDE_ENV_KEY,
    ),
    JEV_BASE_URL: prefer(await $.env.get('JEV_BASE_URL'), 'JEV_BASE_URL'),
    TYPESAFE_BASE_URL: prefer(await $.env.get('TYPESAFE_BASE_URL'), 'TYPESAFE_BASE_URL'),
  };
  const override = env[PROVIDER_OVERRIDE_ENV_KEY];
  // A supplied key pins the endpoint; an implicit one is found through `env`.
  const provider = resolveJevProvider(
    {
      provider: config.provider ?? (isJevProvider(override) ? override : undefined),
      baseUrl: config.baseUrl,
    },
    config.apiKey === undefined ? env : undefined,
  );
  const apiKey = config.apiKey ?? apiKeyFor(provider, env);
  // A configured endpoint wins; otherwise the environment decides where the
  // transcript goes, which is why the outcome line names the host.
  const baseUrl = config.baseUrl ?? environmentEndpoint(env, provider);
  return {
    ...(apiKey ? { apiKey } : {}),
    provider,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

/** Why the event goes back to the host's summarizer, or null to apply the prune. */
export function hookFallbackReason(
  result: CompactResult,
  config: Pick<HookConfig, 'minReductionRatio' | 'requireKeepSignal'>,
  host?: string,
): string | null {
  if (config.requireKeepSignal && !hasKeepSignal(result)) {
    return `no keep signal (${summarize(result, host)})`;
  }
  return reductionRatio(result) < config.minReductionRatio
    ? `below ${percent(config.minReductionRatio)} minimum: ${summarize(result, host)}`
    : null;
}

/** The context window's fill, best-effort: a usage failure just drops the fields. */
async function contextFigures($: {
  session: { usage: () => Promise<{ context: { tokens?: number; percent?: number } }> };
}): Promise<{ contextTokens?: number; contextPercent?: number }> {
  try {
    const { context } = await $.session.usage();
    const figures: { contextTokens?: number; contextPercent?: number } = {};
    if (typeof context.tokens === 'number') figures.contextTokens = context.tokens;
    if (typeof context.percent === 'number') figures.contextPercent = context.percent;
    return figures;
  } catch {
    return {};
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    const started = Date.now();
    const at = new Date().toISOString();
    const usage = await contextFigures($);
    // `FAST_JEV_METRICS` is spelled out here rather than in `getCredentials`,
    // whose environment reads a test pins to the provider maps.
    let metricsPath = configured.metricsPath;
    if (metricsPath === undefined) {
      try {
        metricsPath = await $.env.get('FAST_JEV_METRICS');
      } catch {
        metricsPath = undefined;
      }
    }
    try {
      const credentials = await getCredentials($, configured);
      const config = { ...configured, ...credentials, instructions: event.instructions };
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      const host = endpointHost(
        resolveJevEndpoint({ provider: config.provider, baseUrl: config.baseUrl }).url,
      );
      const reason = hookFallbackReason(result, config, host);
      if (reason) {
        notify($, `fallback to built-in summary (${reason})`);
        const native = await next(event);
        await logMeasurement(
          $,
          measurementOf({
            at,
            trigger: event.trigger,
            outcome: 'fallback',
            before: event.messages,
            after: native.messages ?? event.messages,
            stateTokens: result.stats.stateTokens,
            requests: result.stats.requests,
            ms: Date.now() - started,
            ...usage,
            fallbackReason: reason,
            ...(native.messages ? { nativeSummary: native.messages } : {}),
          }),
          metricsPath,
        );
        return native;
      }
      let nativeSummary: readonly SessionMessage[] | undefined;
      if (config.measureNativeSummary) {
        try {
          nativeSummary = (await next(event)).messages;
        } catch {
          nativeSummary = undefined;
        }
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result, host)})`,
      );
      await logMeasurement(
        $,
        measurementOf({
          at,
          trigger: event.trigger,
          outcome: 'replaced',
          before: event.messages,
          after: messages,
          stateTokens: result.stats.stateTokens,
          requests: result.stats.requests,
          ms: Date.now() - started,
          ...usage,
          ...(nativeSummary ? { nativeSummary } : {}),
        }),
        metricsPath,
      );
      return { messages };
    } catch (error) {
      const reasonText = error instanceof Error ? error.message : String(error);
      notify($, `fallback to built-in summary (${reasonText})`);
      const native = await next(event);
      await logMeasurement(
        $,
        measurementOf({
          at,
          trigger: event.trigger,
          outcome: 'fallback',
          before: event.messages,
          after: native.messages ?? event.messages,
          stateTokens: 0,
          requests: 0,
          ms: Date.now() - started,
          ...usage,
          fallbackReason: reasonText,
          ...(native.messages ? { nativeSummary: native.messages } : {}),
        }),
        metricsPath,
      );
      return native;
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
