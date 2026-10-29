import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { loadProject, REPO_ROOT } from '../config.js';
import { createEnvAdapter, loadDotEnv } from './envAdapter.js';

// The tests point the adapter at an empty dotenv file of their own: a filled `.env` at the repo root (README section 2
// has the reader write one) must not refill the variables a test removed on purpose.
let scratch: string;
let EMPTY_DOTENV: string;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'perf-envadapter-'));
  EMPTY_DOTENV = join(scratch, 'empty.env');
  await writeFile(EMPTY_DOTENV, '', 'utf8');
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const KEYS = ['PERF_SELFTEST_URL', 'PERF_TOKEN_URL', 'PERF_TOKEN_CLIENT_ID', 'PERF_SCOPE', 'PERF_USER_LOGIN', 'PERF_USER_PASSWORD'];

/** Runs fn with exactly the given PERF_* variables set (fake values), then restores the real environment. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FULL = {
  PERF_SELFTEST_URL: 'http://127.0.0.1:4567',
  PERF_TOKEN_URL: 'http://127.0.0.1:4567/oauth/token',
  PERF_TOKEN_CLIENT_ID: 'fake-client',
  PERF_SCOPE: 'fake-scope',
  PERF_USER_LOGIN: 'fake-login',
  PERF_USER_PASSWORD: 'fake-password',
};

test('resolves the selftest env from PERF_* variables', async () => {
  await withEnv(FULL, async () => {
    const project = await loadProject('selftest');
    const resolved = await createEnvAdapter(project, { dotenvFile: EMPTY_DOTENV }).resolveEnv('local');
    assert.equal(resolved.apiUrl, 'http://127.0.0.1:4567/api');
    assert.deepEqual(resolved.auth, {
      tokenUrl: 'http://127.0.0.1:4567/oauth/token',
      clientId: 'fake-client',
      scope: 'fake-scope',
    });
    assert.deepEqual(resolved.accounts, { User: { login: 'fake-login', password: 'fake-password' } });
  });
});

test('a missing variable is named in the error, and no value is', async () => {
  const { PERF_USER_PASSWORD: _omitted, ...partial } = FULL;
  await withEnv(partial, async () => {
    const project = await loadProject('selftest');
    await assert.rejects(
      () => createEnvAdapter(project, { dotenvFile: EMPTY_DOTENV }).resolveEnv('local'),
      (err: Error) => {
        assert.match(err.message, /PERF_USER_PASSWORD/);
        assert.doesNotMatch(err.message, /fake-/);
        return true;
      },
    );
  });
});

test('an unknown env is rejected', async () => {
  await withEnv(FULL, async () => {
    const project = await loadProject('selftest');
    await assert.rejects(() => createEnvAdapter(project, { dotenvFile: EMPTY_DOTENV }).resolveEnv('prod'), /env prod is not defined/);
  });
});

test('loadDotEnv fills missing variables and never overrides existing ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-dotenv-'));
  try {
    const file = join(dir, '.env');
    await writeFile(file, 'PERF_TOKEN_CLIENT_ID=from-file\nPERF_SCOPE=from-file\n', 'utf8');
    await withEnv({ PERF_TOKEN_CLIENT_ID: 'from-process' }, async () => {
      loadDotEnv(file);
      assert.equal(process.env.PERF_TOKEN_CLIENT_ID, 'from-process');
      assert.equal(process.env.PERF_SCOPE, 'from-file');
    });
    loadDotEnv(join(dir, 'missing.env')); // no file: nothing happens
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the adapter reads the repo .env by default and the dotenv file it is given otherwise', async () => {
  const filled = join(scratch, 'filled.env');
  await writeFile(filled, Object.entries(FULL).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf8');
  await withEnv({}, async () => {
    const project = await loadProject('selftest');
    const resolved = await createEnvAdapter(project, { dotenvFile: filled }).resolveEnv('local');
    assert.deepEqual(resolved.accounts, { User: { login: 'fake-login', password: 'fake-password' } });
  });
});

// README section 2 has the reader write a filled .env at the repo root. This file's tests must stay green with it there:
// they run here in a copy of the repo's runner/ that holds such a .env (the real repo root is never touched).
const IN_COPY = process.env.PERF_ENVADAPTER_IN_COPY === '1';
test('with the README section 2 .env at the repo root, these tests still pass', { timeout: 120_000, skip: IN_COPY && 'this is the copy' }, async () => {
  const copy = join(scratch, 'repo');
  await mkdir(copy, { recursive: true });
  await cp(join(REPO_ROOT, 'runner'), join(copy, 'runner'), { recursive: true, filter: (src) => !src.includes('node_modules') });
  await cp(join(REPO_ROOT, 'package.json'), join(copy, 'package.json'));
  await symlink(join(REPO_ROOT, 'node_modules'), join(copy, 'node_modules'));
  await writeFile(
    join(copy, '.env'),
    [
      'PERF_TOKEN_URL=http://127.0.0.1:4010/oauth/token',
      'PERF_TOKEN_CLIENT_ID=perf',
      'PERF_SCOPE=openid perf offline_access',
      'PERF_USER_LOGIN=perf',
      'PERF_USER_PASSWORD=perf',
      '',
    ].join('\n'),
    'utf8',
  );
  // NODE_TEST_CONTEXT would make the inner test run talk to this one's runner instead of printing its own report.
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  const env = { ...inherited, PERF_ENVADAPTER_IN_COPY: '1' };
  const args = ['--import', 'tsx', '--test', '--test-reporter=tap', join('runner', 'adapters', 'envAdapter.test.ts')];
  const { stdout } = await promisify(execFile)(process.execPath, args, {
    cwd: copy,
    env,
  }).catch((err: { stdout?: string; message: string }) => {
    throw new Error(`the copy's tests failed:\n${err.stdout ?? err.message}`);
  });
  assert.match(stdout, /^# fail 0$/m);
});
