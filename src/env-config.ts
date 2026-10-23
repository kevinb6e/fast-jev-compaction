/**
 * The single source of truth for the `FAST_JEV_*` environment contract shared by
 * every harness. omp reads these names natively; the Claude Code hook, the
 * OpenCode plugin, and the Pi port fall back to them so that one exported block
 * in a shell profile governs the tuning knobs everywhere.
 *
 * Precedence is always: the harness's own explicit option (userConfig / plugin
 * options / settings.json) wins, then the environment, then the built-in
 * default. The names here must match the ones `omp/index.ts` reads; the parity
 * test pins them together.
 */

/** Numeric `FAST_JEV_*` names and the config key each one sets. */
export const NUMERIC_ENV: ReadonlyArray<readonly [string, string]> = [
  ['FAST_JEV_KEEP_THRESHOLD', 'keepThreshold'],
  ['FAST_JEV_PRESERVE_RECENT', 'preserveRecentMessages'],
  ['FAST_JEV_MAX_STATE_TOKENS', 'maxStateTokens'],
  ['FAST_JEV_MAX_REQUEST_TOKENS', 'maxRequestTokens'],
  ['FAST_JEV_TRUNCATE_HEAD_CHARS', 'truncateHeadChars'],
  ['FAST_JEV_INJECTED_MIN_CHARS', 'injectedMinChars'],
  ['FAST_JEV_REPLY_MIN_CHARS', 'replyMinChars'],
  ['FAST_JEV_COMPACT_AT_PERCENT', 'compactAtPercent'],
  ['FAST_JEV_MIN_REDUCTION', 'minReductionRatio'],
  ['FAST_JEV_MAX_SUMMARY_TOKENS', 'maxSummaryTokens'],
  ['FAST_JEV_COOLDOWN_TOKENS', 'cooldownTokens'],
];

/** Boolean `FAST_JEV_*` names and the config key each one sets. */
export const BOOL_ENV: ReadonlyArray<readonly [string, string]> = [
  ['FAST_JEV_REQUIRE_KEEP_SIGNAL', 'requireKeepSignal'],
  ['FAST_JEV_MEASURE_NATIVE_SUMMARY', 'measureNativeSummary'],
];

/** A `1`/`0`/`true`/`yes` spelling; anything else (including `''`) is unset. */
export function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `1`/`true`/`yes` and `0`/`false`/`no`; anything else leaves the default. */
export function envBool(value: string | undefined): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes') return true;
  if (text === '0' || text === 'false' || text === 'no') return false;
  return undefined;
}

/**
 * The numeric/bool overrides present in `env`, keyed by config name. Adapters
 * spread this *under* their explicit options so an option always wins.
 */
export function envOverrides(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [name, key] of NUMERIC_ENV) {
    const value = envNumber(env[name]);
    if (value !== undefined) out[key] = value;
  }
  for (const [name, key] of BOOL_ENV) {
    const value = envBool(env[name]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}
