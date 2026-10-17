import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Claude Code reads the plugin version from `.claude-plugin/plugin.json` and
 * skips an update when it has not moved, so a manifest left behind by a merge
 * means the installed plugin keeps running the old code with no warning. The
 * three manifests are bumped together by `scripts/bump.mjs`, which re-syncs
 * `package-lock.json` through npm; this is the guard that fails when any of the
 * four drifts.
 */
const versionIn = (path: string): string => {
  const manifest = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  return manifest.plugins ? manifest.plugins[0].version : manifest.version;
};

/** The lockfile keeps the version in its root and in its own-package entry. */
const lockfileVersions = (): { root: string; own: string } => {
  const lock = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
  ) as { version: string; packages: Record<string, { version?: string }> };
  return { root: lock.version, own: lock.packages['']?.version ?? '' };
};

describe('manifest versions', () => {
  it('agree across package.json and both plugin manifests', () => {
    const pkg = versionIn('package.json');
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionIn('.claude-plugin/plugin.json')).toBe(pkg);
    expect(versionIn('.claude-plugin/marketplace.json')).toBe(pkg);
  });

  it('agree with both version fields in package-lock.json', () => {
    const pkg = versionIn('package.json');
    const lock = lockfileVersions();
    expect(lock.root).toBe(pkg);
    expect(lock.own).toBe(pkg);
  });
});
