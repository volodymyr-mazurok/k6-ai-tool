// projects/_template/ is the copyable skeleton for a new project. It is never run, but it must stay loadable and in step
// with the schema, or a newcomer copies something that fails on the first command.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadFeature, loadProject } from '../runner/config.js';

const TEMPLATE = fileURLToPath(new URL('../projects/_template', import.meta.url));
const read = (file: string): string => readFileSync(`${TEMPLATE}/${file}`, 'utf8');

test('the template project and its example feature load and agree with each other', async () => {
  const project = await loadProject('_template');
  assert.deepEqual(project.roles, ['Analyst']);
  assert.ok(project.envs.staging, 'one example env');

  const feature = await loadFeature(project, 'example');
  assert.equal(feature.readOnly, true);
  for (const journey of feature.journeys) {
    assert.ok(project.roles!.includes(journey.role), `journey ${journey.name} uses a role the project lists`);
    assert.ok(Object.hasOwn(feature.workload.mix, journey.name), `journey ${journey.name} is in the mix`);
  }
  for (const route of feature.journeys.flatMap((j) => j.steps.filter((s) => s.method === 'POST').map((s) => s.route))) {
    assert.ok(project.readOnlyPostRoutes.includes(route), `POST ${route} is listed in read_only_post_routes, or the read-only check refuses it`);
  }
});

test('example.js is valid JavaScript and exports each journey exec and every step id the journey names', async () => {
  const feature = await loadFeature(await loadProject('_template'), 'example');
  execFileSync(process.execPath, ['--check', `${TEMPLATE}/features/example/example.js`]);
  const script = read('features/example/example.js');
  for (const journey of feature.journeys) {
    assert.match(script, new RegExp(`export function ${journey.exec}\\(`), `example.js exports ${journey.exec}`);
    for (const step of journey.steps) {
      assert.ok(script.includes(`'${journey.key}.${step.name}'`), `example.js sends ${journey.key}.${step.name}`);
    }
  }
});

test('the template carries the files a feature needs, and README section 10 points to it', () => {
  const guide = read('README.md');
  for (const heading of ['## What this project tests', '## Envs', '## Secrets: where they live', '## Forbidden paths', '## How to run']) {
    assert.ok(guide.includes(heading), `the project guide skeleton has "${heading}"`);
  }
  for (const file of ['project.yaml', 'README.md', 'features/example/journey.yaml', 'features/example/workload.yaml', 'features/example/example.js', 'features/example/context.md']) {
    assert.ok(read(file).length > 0, `${file} exists`);
  }
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  assert.ok(readme.includes('projects/_template/'), 'README names projects/_template/');
});
