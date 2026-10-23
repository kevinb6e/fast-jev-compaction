import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOOL_ENV,
  envBool,
  envNumber,
  envOverrides,
  NUMERIC_ENV,
} from '../src/env-config.ts';

describe('env-config', () => {
  it('envNumber accepts finite numbers and rejects junk', () => {
    expect(envNumber('0.1')).toBe(0.1);
    expect(envNumber(' 6 ')).toBe(6);
    expect(envNumber('1e3')).toBe(1000);
    expect(envNumber('')).toBeUndefined();
    expect(envNumber('   ')).toBeUndefined();
    expect(envNumber('abc')).toBeUndefined();
    expect(envNumber(undefined)).toBeUndefined();
  });

  it('envBool reads the documented spellings and leaves the rest unset', () => {
    for (const t of ['1', 'true', 'TRUE', 'yes', ' yes ']) expect(envBool(t)).toBe(true);
    for (const f of ['0', 'false', 'no', 'FALSE']) expect(envBool(f)).toBe(false);
    for (const u of ['maybe', '', undefined, '2']) expect(envBool(u)).toBeUndefined();
  });

  it('envOverrides pulls the numeric and bool keys present in the environment', () => {
    expect(
      envOverrides({
        FAST_JEV_MIN_REDUCTION: '0.1',
        FAST_JEV_PRESERVE_RECENT: '2',
        FAST_JEV_KEEP_THRESHOLD: '0.4',
        FAST_JEV_REQUIRE_KEEP_SIGNAL: 'true',
        FAST_JEV_BOGUS: 'nope',
      }),
    ).toEqual({
      minReductionRatio: 0.1,
      preserveRecentMessages: 2,
      keepThreshold: 0.4,
      requireKeepSignal: true,
    });
  });

  it('names every knob it reads', () => {
    const numeric = Object.fromEntries(NUMERIC_ENV.map(([name, key]) => [name, key]));
    expect(numeric['FAST_JEV_MIN_REDUCTION']).toBe('minReductionRatio');
    expect(numeric['FAST_JEV_PRESERVE_RECENT']).toBe('preserveRecentMessages');
    expect(numeric['FAST_JEV_KEEP_THRESHOLD']).toBe('keepThreshold');
    expect(numeric['FAST_JEV_COMPACT_AT_PERCENT']).toBe('compactAtPercent');
    expect(Object.fromEntries(BOOL_ENV.map(([name, key]) => [name, key]))).toMatchObject({
      'FAST_JEV_REQUIRE_KEEP_SIGNAL': 'requireKeepSignal',
    });
  });

  // The whole point of the shared contract: the names omp hard-codes and the
  // names every other adapter falls back to are one list. If a harness drifts,
  // a value exported once in a shell profile would silently stop reaching it.
  // Some knobs are host-only and omp cannot honor them (no native-summary
  // measurement, no per-adapter cooldown/trigger percent, library char floors);
  // those are excluded from the omp assertion but still shared by name.
  const OMP_UNAWARE = new Set([
    'FAST_JEV_INJECTED_MIN_CHARS',
    'FAST_JEV_REPLY_MIN_CHARS',
    'FAST_JEV_COOLDOWN_TOKENS',
    'FAST_JEV_COMPACT_AT_PERCENT',
    'FAST_JEV_MEASURE_NATIVE_SUMMARY',
  ]);
  it('pins the omp adapter to the same environment names', () => {
    const omp = readFileSync(new URL('../omp/index.ts', import.meta.url), 'utf8');
    for (const [name] of [...NUMERIC_ENV, ...BOOL_ENV]) {
      if (OMP_UNAWARE.has(name)) continue;
      const ompHonorsIt = omp.includes(`'${name}'`) || omp.includes(`"${name}"`);
      expect(ompHonorsIt, `omp must read ${name}`).toBe(true);
    }
  });
});
