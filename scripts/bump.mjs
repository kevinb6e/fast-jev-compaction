#!/usr/bin/env node
/**
 * Sets the plugin version in every manifest that carries one.
 *
 * Claude Code keys its plugin updates on `.claude-plugin/plugin.json`, so a
 * version that lags a merge behind means `claude plugin update` reports
 * "already at the latest version" and keeps running the old code, silently.
 * The same version also names the marketplace entry and the npm package, so
 * all three move together or they drift apart.
 *
 * `package-lock.json` carries the version too, in its root and its own-package
 * entry. npm owns that file's format, so it is re-synced by npm rather than
 * written here, and `tests/manifest.test.ts` fails if it lags.
 *
 *   node scripts/bump.mjs patch      # 0.3.0 -> 0.3.1
 *   node scripts/bump.mjs minor|major
 *   node scripts/bump.mjs 1.2.3      # exact version; also repairs drift
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFESTS = ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const SEMVER = /^\d+\.\d+\.\d+$/;

const versionIn = (file) => {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  return manifest.plugins ? manifest.plugins[0].version : manifest.version;
};

const setVersionIn = (file, version) => {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.plugins) manifest.plugins[0].version = version;
  else manifest.version = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
};

/** Rewrites the lockfile's version fields from `package.json` via npm itself. */
const syncLockfile = () => {
  try {
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      stdio: 'pipe',
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    console.error(`Failed to sync package-lock.json: ${detail}`);
    console.error('The manifests are bumped; run `npm install --package-lock-only` before committing.');
    process.exit(1);
  }
};

const argument = process.argv[2] ?? 'patch';
const current = versionIn('package.json');

let next;
if (SEMVER.test(argument)) {
  next = argument;
} else {
  const found = MANIFESTS.map(versionIn);
  if (new Set(found).size > 1) {
    console.error(`Manifests disagree: ${MANIFESTS.map((f, i) => `${f}=${found[i]}`).join(', ')}`);
    console.error('Pass an exact version (e.g. `node scripts/bump.mjs 1.2.3`) to set them together.');
    process.exit(1);
  }
  const [major, minor, patch] = current.split('.').map(Number);
  next =
    argument === 'major' ? `${major + 1}.0.0`
    : argument === 'minor' ? `${major}.${minor + 1}.0`
    : argument === 'patch' ? `${major}.${minor}.${patch + 1}`
    : null;
  if (!next) {
    console.error(`Unknown argument "${argument}": use major, minor, patch or an exact version.`);
    process.exit(1);
  }
}

for (const file of MANIFESTS) setVersionIn(file, next);
syncLockfile();
console.log(`${current} -> ${next} in ${MANIFESTS.join(', ')} and package-lock.json`);
