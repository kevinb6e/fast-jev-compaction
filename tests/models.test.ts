import { describe, expect, it } from 'vitest';
import {
  applyRequestBudget,
  DECISION_MODEL_CEILINGS,
  resolveRequestBudget,
  UNKNOWN_MODEL_REQUEST_TOKENS,
} from '../src/models.js';

describe('resolveRequestBudget', () => {
  it("keeps the shipped Jev budget unchanged", () => {
    expect(resolveRequestBudget('typesafe/jev-1.13')).toEqual({
      maxRequestTokens: 30_000,
      maxStateTokens: 25_000,
      source: 'measured',
    });
  });

  it('scales to the model, which is the whole point', () => {
    // measured at 524 288 vs kev-4b's 7 168: two orders of magnitude apart
    expect(resolveRequestBudget('openai/gpt-6-luna-decisions').maxRequestTokens).toBe(524_288);
    expect(resolveRequestBudget('jaredpalmer/kev-4b').maxRequestTokens).toBe(7_168);
  });

  it('falls back small for an unlisted model rather than risking a 400', () => {
    const budget = resolveRequestBudget('someone/new-decision-model');
    expect(budget.maxRequestTokens).toBe(UNKNOWN_MODEL_REQUEST_TOKENS);
    expect(budget.source).toBe('fallback');
    // a request over the limit fails outright and loses Jev entirely, so the
    // fallback is smaller than the default rather than equal to it
    expect(budget.maxRequestTokens).toBeLessThan(DECISION_MODEL_CEILINGS['typesafe/jev-1.13']!);
  });

  it('handles no model at all', () => {
    expect(resolveRequestBudget(undefined).source).toBe('fallback');
  });

  it('lets an explicit option win, and drags the state with it', () => {
    expect(resolveRequestBudget('jaredpalmer/kev-4b', { maxRequestTokens: 99_000 })).toEqual({
      maxRequestTokens: 99_000,
      maxStateTokens: 82_500,
      source: 'measured',
    });
    expect(
      resolveRequestBudget('openai/gpt-6-luna-decisions', { maxStateTokens: 1_000 }).maxStateTokens,
    ).toBe(1_000);
  });

  it('never returns a budget below one token', () => {
    for (const budget of [resolveRequestBudget('typesafe/jev-1.13', { maxRequestTokens: 0.4, maxStateTokens: -5 })]) {
      expect(budget.maxRequestTokens).toBeGreaterThanOrEqual(1);
      expect(budget.maxStateTokens).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('applyRequestBudget', () => {
  it('fills both budgets from the model and keeps the other options', () => {
    expect(applyRequestBudget({ model: 'jaredpalmer/kev-4b', keepThreshold: 0.7 })).toEqual({
      model: 'jaredpalmer/kev-4b',
      keepThreshold: 0.7,
      maxRequestTokens: 7_168,
      maxStateTokens: 5_973,
    });
  });

  it('leaves a caller-set budget alone', () => {
    const filled = applyRequestBudget({ model: 'jaredpalmer/kev-4b', maxRequestTokens: 3_000 });
    expect(filled.maxRequestTokens).toBe(3_000);
    expect(filled.maxStateTokens).toBe(2_500);
  });
});
