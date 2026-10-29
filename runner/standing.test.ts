import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, loadProject, type Project } from './config.js';
import { resolveStandingSpec } from './standing.js';

const JOURNEYS = `
journeys:
  - name: flow
    key: f
    role: User
    steps:
      - { name: one, request: POST /a }
`;

function workload(standing: string): string {
  return `
business_unit: users
business_action: actions
mix: { flow: 100 }
think_time: { min: 1s, max: 2s }
${standing}
`;
}

/** A project whose features/<name>/ folders hold the given workload (and a valid journey); `null` makes a folder with recordings only. */
async function withFeatures(features: Record<string, string | null>, fn: (project: Project) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'perf-standing-'));
  try {
    for (const [name, yaml] of Object.entries(features)) {
      await mkdir(join(dir, 'features', name, 'recordings'), { recursive: true });
      if (yaml === null) continue;
      await writeFile(join(dir, 'features', name, 'journey.yaml'), JOURNEYS, 'utf8');
      await writeFile(join(dir, 'features', name, 'workload.yaml'), yaml, 'utf8');
    }
    await fn({ ...(await loadProject('selftest')), dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STANDING = 'standing_data: { widgets: 40, colour: red, nested: { depth: 2 } }';

test('standing_data is a free map: any keys, passed on untouched', async () => {
  await withFeatures({ one: workload(STANDING) }, async (project) => {
    const r = await resolveStandingSpec(project, []);
    assert.deepEqual(r.spec, { widgets: 40, colour: 'red', nested: { depth: 2 } });
    assert.match(r.source, /standing_data of feature one/);
  });
});

test('--set values win over the workload standing_data, key by key; numbers are parsed as numbers', async () => {
  await withFeatures({ other: null, one: workload(STANDING), plain: workload('') }, async (project) => {
    const r = await resolveStandingSpec(project, ['widgets=3', 'ratio=0.5', 'label=a=b', 'zero=0', 'neg=-2']);
    assert.deepEqual(r.spec, { widgets: 3, colour: 'red', nested: { depth: 2 }, ratio: 0.5, label: 'a=b', zero: 0, neg: -2 });
    assert.match(r.source, /--set/);
    assert.match(r.source, /one/);
  });
});

test('with nothing declared and nothing set, the spec is empty (the adapter says what it needs)', async () => {
  await withFeatures({ plain: workload(''), none: null }, async (project) => {
    const r = await resolveStandingSpec(project, []);
    assert.deepEqual(r.spec, {});
    assert.match(r.source, /nothing declared/);
  });
});

test('--set needs key=value with a plain key', async () => {
  await withFeatures({ plain: workload('') }, async (project) => {
    for (const bad of ['widgets', '=3', 'wid gets=3', '1x=2']) {
      await assert.rejects(() => resolveStandingSpec(project, [bad]), (err: Error) => err instanceof ConfigError && /--set needs key=value/.test(err.message), bad);
    }
  });
});
