// What `perf setup` hands the project's adapter: the `standing_data` mapping of a feature workload of the project (the
// first feature, by name, that declares one), with `--set key=value` flags laid over it key by key. The runner does not
// know what the keys mean; the adapter parses and validates them and says what it needs when they are missing.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, loadFeature, type Project } from './config.js';

export type StandingSpec = Record<string, unknown>;

/** `--set key=value` pairs as a mapping; numeric-looking values (`40`, `-2`, `0.5`) become numbers, anything else stays text. */
export function parseSetPairs(pairs: string[]): StandingSpec {
  const spec: StandingSpec = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const key = at < 0 ? '' : pair.slice(0, at);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ConfigError(`--set needs key=value with a key of letters, digits and underscores (got "${pair}")`);
    }
    const value = pair.slice(at + 1);
    spec[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return spec;
}

/** The first feature (by name) whose workload.yaml declares standing_data. Features that cannot load are skipped. */
async function workloadStanding(project: Project): Promise<{ feature: string; standing: StandingSpec } | undefined> {
  let entries;
  try {
    entries = await readdir(join(project.dir, 'features'), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  for (const name of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    try {
      const standing = (await loadFeature(project, name)).workload.standingData;
      if (standing) return { feature: name, standing };
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
    }
  }
  return undefined;
}

/**
 * The spec to set up: `standing_data` of any feature workload of the project, with the `--set` values on top.
 * `source` says where the values came from, for the log. The spec may be empty: the adapter decides what it needs.
 * @throws {ConfigError} for a `--set` that is not key=value
 */
export async function resolveStandingSpec(project: Project, sets: string[]): Promise<{ spec: StandingSpec; source: string }> {
  const given = parseSetPairs(sets);
  const declared = await workloadStanding(project);
  const parts = [declared && `standing_data of feature ${declared.feature}`, sets.length > 0 && '--set'].filter(Boolean);
  return { spec: { ...declared?.standing, ...given }, source: parts.length > 0 ? parts.join(' + ') : 'nothing declared' };
}
