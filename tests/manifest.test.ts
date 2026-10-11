import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Claude Code reads the plugin version from `.claude-plugin/plugin.json` and
 * skips an update when it has not moved, so a manifest left behind by a merge
 * means the installed plugin keeps running the old code with no warning. The
 * three manifests are bumped together by `scripts/bump.mjs`; this is the guard
 * that fails when one of them drifts.
 */
const versionIn = (path: string): string => {
  const manifest = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  return manifest.plugins ? manifest.plugins[0].version : manifest.version;
};

describe('manifest versions', () => {
  it('agree across package.json and both plugin manifests', () => {
    const pkg = versionIn('package.json');
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionIn('.claude-plugin/plugin.json')).toBe(pkg);
    expect(versionIn('.claude-plugin/marketplace.json')).toBe(pkg);
  });
});
