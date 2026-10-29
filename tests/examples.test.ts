import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMockServer, type MockServer } from '../runner/selftest/server.js';

const HELLO = fileURLToPath(new URL('../examples/hello.js', import.meta.url));
const K6_TIMEOUT_MS = 120_000;

let mock: MockServer;

before(async () => {
  mock = await startMockServer();
});

after(async () => {
  await mock.stop();
});

interface K6Result {
  code: number;
  out: string;
}

/** `k6 run <args>` with a clean k6 environment: no inherited K6_* option can change what the example does. */
function k6(...args: string[]): Promise<K6Result> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(k6_|base_url$)/i.test(key)) env[key] = value;
  }
  env.K6_NO_USAGE_REPORT = 'true';
  return new Promise((resolve) => {
    const child = spawn('k6', ['run', '--no-color', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: K6_TIMEOUT_MS, killSignal: 'SIGKILL' });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', (err) => resolve({ code: -1, out: `${out}\ncould not run k6: ${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

test('examples/hello.js runs against the mock (exit 0)', async () => {
  const tokensBefore = mock.tokenCalls();
  const { code, out } = await k6('-e', `BASE_URL=${mock.url}`, HELLO);
  assert.equal(code, 0, out);
  assert.equal(mock.tokenCalls() - tokensBefore, 1, 'one token request for the whole test, made in setup()');
  assert.match(out, /checks_succeeded\.*: 100\.00%/, 'every check passed');
  assert.match(out, /http_req_failed\.*: 0\.00%/, 'no request failed');
  assert.match(out, /2 max VUs/, 'two virtual users');
  assert.match(out, /2 looping VUs for 10s/, 'for ten seconds');
});

test('examples/hello.js without BASE_URL stops with a message that says what to pass', async () => {
  const { code, out } = await k6(HELLO);
  assert.notEqual(code, 0);
  assert.match(out, /BASE_URL/);
  assert.match(out, /-e BASE_URL=/);
});

test('examples/hello.js fails (exit 99) when the thresholds are broken: the mock answering 500s', async () => {
  mock.setFailRate(1);
  try {
    // --vus and --duration on the command line beat the script's options: a short run is enough to trip the threshold
    const { code, out } = await k6('-e', `BASE_URL=${mock.url}`, '--vus', '1', '--duration', '3s', HELLO);
    assert.equal(code, 99, out);
    assert.match(out, /thresholds on metrics/);
  } finally {
    mock.setFailRate(0);
  }
});
