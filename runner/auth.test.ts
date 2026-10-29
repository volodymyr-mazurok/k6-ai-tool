import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveStaticHeader } from './auth.js';
import { ConfigError } from './config.js';

test('resolveStaticHeader replaces ${env:NAME} from the environment and leaves ${random:N} for k6', () => {
  const header = resolveStaticHeader(
    { type: 'static_header', header: 'X-Api-Key', value: 'key ${env:PERF_TEST_KEY} ${random:4}' },
    { PERF_TEST_KEY: 'abc123' },
  );
  assert.deepEqual(header, { header: { name: 'X-Api-Key', value: 'key abc123 ${random:4}' }, secretParts: ['abc123'] });
  assert.deepEqual(resolveStaticHeader({ type: 'static_header', header: 'Authorization', value: 'token ${random:16}' }, {}), {
    header: { name: 'Authorization', value: 'token ${random:16}' },
    secretParts: [],
  });
});

test('resolveStaticHeader refuses a variable whose value holds "${", without showing the value', () => {
  assert.throws(
    () => resolveStaticHeader({ type: 'static_header', header: 'X-Api-Key', value: '${env:PERF_NESTED}' }, { PERF_NESTED: 'abc${random:4}' }),
    (err: Error) => /PERF_NESTED holds "\$\{"/.test(err.message) && !err.message.includes('abc'),
  );
});

test('resolveStaticHeader refuses a value shorter than 4 characters (the scan could not redact it), without showing it', () => {
  assert.throws(
    () => resolveStaticHeader({ type: 'static_header', header: 'X-Api-Key', value: '${env:PERF_SHORT}' }, { PERF_SHORT: 'q7z' }),
    (err: Error) => err instanceof ConfigError && /PERF_SHORT is shorter than 4 characters/.test(err.message) && !err.message.includes('q7z'),
  );
});

test('resolveStaticHeader names a missing variable and never shows a value', () => {
  assert.throws(
    () => resolveStaticHeader({ type: 'static_header', header: 'X-Api-Key', value: '${env:PERF_MISSING}' }, { OTHER: 'secret-value' }),
    (err: Error) => /PERF_MISSING is not set/.test(err.message) && /\.env/.test(err.message) && !err.message.includes('secret-value'),
  );
  assert.throws(() => resolveStaticHeader({ type: 'static_header', header: 'X-Api-Key', value: '${env:PERF_EMPTY}' }, { PERF_EMPTY: '' }), /PERF_EMPTY is not set/);
});
