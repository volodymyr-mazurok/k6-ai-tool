// Runs pizza.js in k6 (smoke) against a small fake of QuickPizza that answers with the shapes of the QuickPizza OpenAPI
// document (quotes, doughs, tools, a recommended pizza) and wants `Authorization: token <16 characters>` where the real app
// does. It checks what the script sends and that every content check can fail. The step list is read from journey.yaml.
// Needs k6 on the PATH, like tests/k6/glue.test.ts. Nothing here leaves the machine.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveStaticHeader } from '../../../../runner/auth.js';
import { loadFeature, loadProject } from '../../../../runner/config.js';
import { countScriptErrors } from '../../../../runner/k6.js';
import { stepsPerIteration } from '../../../../runner/run.js';
import { runK6Script, type K6RunResult } from '../../../../tests/k6/harness.js';

const SCRIPT = fileURLToPath(new URL('./pizza.js', import.meta.url));
const PROJECT = await loadProject('quickpizza');
const FEATURE = await loadFeature(PROJECT, 'pizza');
const IDS = FEATURE.journeys.flatMap((j) => j.steps.map((s) => `${j.key}.${s.name}`));
const RECOMMEND_IDS = ['pizza.recommend'];

type Fault =
  | 'none'
  | 'html' // every answer is a 502 HTML page
  | 'html200' // every answer is 200 with an HTML body
  | 'emptyLists' // quotes, doughs and tools are empty lists
  | 'noPizza' // the recommendation has no pizza object
  | 'noId' // the pizza has no id
  | 'pepperoni' // the pizza holds the excluded ingredient
  | 'knife' // the pizza is cut with the excluded tool
  | 'fewIngredients' // only the three base ingredients
  | 'manyIngredients'; // more than the base and six toppings

interface Call {
  method: string;
  path: string;
  authorization?: string;
  body?: Record<string, any>;
}

interface Fake {
  url: string;
  calls: Call[];
  setFault(fault: Fault): void;
  stop(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const HTML = '<html><body><h1>502 Bad Gateway</h1></body></html>';
/** QuickPizza's rule: `token` or `bearer`, a space, exactly 16 characters. */
const VALID_TOKEN = /^(token|bearer) \S{16}$/i;

const ingredient = (id: number, name: string) => ({ id, name, caloriesPerSlice: 50, vegetarian: true });

function pizzaAnswer(fault: Fault): unknown {
  const base = [ingredient(1, 'Extra-virgin olive oil'), ingredient(2, 'San Marzano tomatoes'), ingredient(3, 'Mozzarella')];
  const toppings =
    fault === 'fewIngredients'
      ? []
      : fault === 'manyIngredients'
        ? Array.from({ length: 7 }, (_v, i) => ingredient(10 + i, `Topping ${i}`))
        : [ingredient(10, fault === 'pepperoni' ? 'Pepperoni' : 'Basil'), ingredient(11, 'Olives')];
  if (fault === 'noPizza') return { calories: 400, vegetarian: true };
  const pizza: Record<string, unknown> = {
    name: 'The Random Margherita',
    dough: { id: 1, name: 'Thin', caloriesPerSlice: 150 },
    ingredients: [...base, ...toppings],
    tool: fault === 'knife' ? 'Knife' : 'Pizza cutter',
  };
  if (fault !== 'noId') pizza.id = 4711;
  return { pizza, calories: 400, vegetarian: true };
}

async function startFake(): Promise<Fake> {
  const calls: Call[] = [];
  let fault: Fault = 'none';
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://fake').pathname;
      const text = await readBody(req);
      const call: Call = { method: req.method ?? '', path };
      if (req.headers.authorization !== undefined) call.authorization = req.headers.authorization;
      if (text) call.body = JSON.parse(text) as Record<string, any>;
      calls.push(call);

      if (fault === 'html') return send(res, 502, 'text/html', HTML);
      if (fault === 'html200') return send(res, 200, 'text/html', HTML);
      const list = (key: string, items: unknown[]) => send(res, 200, 'application/json', JSON.stringify({ [key]: fault === 'emptyLists' ? [] : items }));
      if (req.method === 'GET' && path === '/api/quotes') return list('quotes', ['In crust we trust.']);
      // Everything else of the journey needs the token header, as on the real app.
      if (!VALID_TOKEN.test(req.headers.authorization ?? '')) return send(res, 401, 'application/json', '{"error":"unauthorized"}');
      if (req.method === 'GET' && path === '/api/doughs') return list('doughs', [{ id: 1, name: 'Thin', caloriesPerSlice: 150 }]);
      if (req.method === 'GET' && path === '/api/tools') return list('tools', ['Pizza cutter', 'Scissors']);
      if (req.method === 'POST' && path === '/api/pizza') return send(res, 200, 'application/json', JSON.stringify(pizzaAnswer(fault)));
      return send(res, 404, 'application/json', '{}');
    })().catch((err: unknown) => send(res, 500, 'text/plain', String(err)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setFault: (next) => {
      fault = next;
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** The run config the runner writes for a smoke of this feature, pointed at the fake. */
function runConfig(fake: Fake): object {
  return {
    runId: 'quickpizza-test',
    apiUrl: fake.url,
    profile: { type: 'smoke', totalSec: 10 },
    caps: { maxVus: 5, maxRps: 5 },
    mix: FEATURE.workload.mix,
    thinkTime: FEATURE.workload.thinkTime,
    stepsPerIteration: Object.fromEntries(FEATURE.journeys.map((j) => [j.name, stepsPerIteration(j)])),
    journeys: FEATURE.journeys.map((j) => ({
      name: j.name,
      key: j.key,
      role: j.role,
      exec: j.exec,
      steps: j.steps.map((s) => ({ name: s.name, optionalShare: s.optionalShare })),
    })),
    abort: { errorRate: PROJECT.abort.errorRate, p95Ms: PROJECT.abort.p95Ms },
    auth: { type: 'static_header', header: 'Authorization' },
  };
}

interface Summary {
  metrics: Record<string, { values: Record<string, number> }>;
}

async function withRun(fault: Fault, fn: (r: K6RunResult, fake: Fake, summary: () => Promise<Summary>) => Promise<void>): Promise<void> {
  if (PROJECT.auth.type !== 'static_header') throw new Error('the quickpizza project signs in with a static header');
  const fake = await startFake();
  let runDir: string | undefined;
  try {
    fake.setFault(fault);
    const result = await runK6Script(SCRIPT, runConfig(fake), { accounts: {}, header: resolveStaticHeader(PROJECT.auth, {}).header });
    runDir = result.runDir;
    await fn(result, fake, async () => JSON.parse(await readFile(join(result.runDir, 'summary.json'), 'utf8')) as Summary);
  } finally {
    await fake.stop();
    if (runDir) await rm(runDir, { recursive: true, force: true });
  }
}

const output = (r: K6RunResult): string => `${r.stdout}\n${r.stderr}`;

function rate(summary: Summary, id: string): number {
  const m = summary.metrics[`checks{name:${id}}`];
  assert.ok(m, `summary.json has no checks for ${id}`);
  return m.values.rate!;
}

function assertNoScriptError(r: K6RunResult): void {
  assert.equal(countScriptErrors(output(r)), 0, `the script threw (the runner counts these as script errors):\n${output(r)}`);
}

test('smoke: every step once, in order, with the token where the app wants it and the restrictions as the body', async () => {
  await withRun('none', async (r, fake, summary) => {
    assert.equal(r.code, 0, output(r));
    assertNoScriptError(r);
    const s = await summary();
    for (const id of IDS) {
      assert.equal(s.metrics[`http_req_duration{name:${id}}`]?.values.count, 1, `${id} was sent once`);
      assert.equal(rate(s, id), 1, `every check of ${id} passed`);
    }
    assert.ok(!(s.metrics['http_req_duration{name:auth_token}']?.values.count! > 0), 'no token request: the header needs no login');

    assert.deepEqual(
      fake.calls.map((c) => `${c.method} ${c.path}`),
      ['GET /api/quotes', 'GET /api/doughs', 'GET /api/tools', 'POST /api/pizza'],
    );
    const [quotes, doughs, tools, recommend] = fake.calls;
    assert.equal(quotes!.authorization, undefined, 'the public quotes are fetched without a token');
    for (const call of [doughs, tools, recommend]) assert.match(call!.authorization ?? '', /^token [a-z0-9]{16}$/);
    assert.equal(new Set([doughs, tools, recommend].map((c) => c!.authorization)).size, 1, 'one VU keeps one token');
    assert.deepEqual(recommend!.body, {
      maxCaloriesPerSlice: 500,
      mustBeVegetarian: false,
      excludedIngredients: ['Pepperoni'],
      excludedTools: ['Knife'],
      maxNumberOfToppings: 6,
      minNumberOfToppings: 2,
    });
  });
});

test('an HTML error page, and an HTML page behind a 200, fail every check without a script exception', async () => {
  for (const fault of ['html', 'html200'] as Fault[]) {
    await withRun(fault, async (r, _fake, summary) => {
      assert.notEqual(r.code, 0, `${fault}: the smoke fails`);
      assertNoScriptError(r);
      const s = await summary();
      for (const id of IDS) {
        // a 502 fails the status check too; behind a 200 only the content checks can catch it
        if (fault === 'html') assert.equal(rate(s, id), 0, `${id} fails every check on a 502 page`);
        else assert.ok(rate(s, id) < 1 && rate(s, id) > 0, `${id}: the status check passed, the content checks failed`);
      }
    });
  }
});

// Step ids a fault must fail; every other step must still pass.
const FAULTS: [Fault, string, string[]][] = [
  ['emptyLists', 'empty quotes, doughs and tools', ['pizza.quotes', 'pizza.catalog_doughs', 'pizza.catalog_tools']],
  ['noPizza', 'a recommendation without a pizza', RECOMMEND_IDS],
  ['noId', 'a pizza without an id', RECOMMEND_IDS],
  ['pepperoni', 'the excluded ingredient on the pizza', RECOMMEND_IDS],
  ['knife', 'the excluded tool', RECOMMEND_IDS],
  ['fewIngredients', 'only the base ingredients, no topping', RECOMMEND_IDS],
  ['manyIngredients', 'more toppings than allowed', RECOMMEND_IDS],
];
for (const [fault, what, failing] of FAULTS) {
  test(`a check fails on ${what}`, async () => {
    await withRun(fault, async (r, _fake, summary) => {
      assert.notEqual(r.code, 0, `${fault}: the smoke fails`);
      assertNoScriptError(r);
      const s = await summary();
      for (const id of failing) assert.ok(rate(s, id) < 1, `${id} must fail on ${fault}`);
      for (const id of IDS.filter((x) => !failing.includes(x))) assert.equal(rate(s, id), 1, `${id} is unaffected by ${fault}`);
    });
  });
}
