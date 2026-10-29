// Gate for the committed HAR summaries (projects/<project>/features/<feature>/recordings/*.json): they are evidence for
// journeys and must never carry credentials. A hit here means a summary was written by hand, by an older scrubber, or the
// scrubber missed a secret: fix runner/har.ts, regenerate the summary, then delete the raw HAR.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECTS = fileURLToPath(new URL('../projects', import.meta.url));
const FORBIDDEN = /bearer|password|cookie|authorization|access_token|eyJ[\w-]+\.|code=|secret/i;

// Every recordings/*.json anywhere under projects/, as paths relative to projects/.
function recordingFiles(): string[] {
  return readdirSync(PROJECTS, { recursive: true, encoding: 'utf8' })
    .filter((file) => /(^|[\\/])recordings[\\/][^\\/]+\.json$/.test(file))
    .sort();
}

test('the forbidden-content pattern catches the usual credential shapes', () => {
  for (const sample of ['Bearer abc', 'PASSWORD', 'Set-Cookie', 'Authorization', 'access_token', 'eyJhbGciOiJSUzI1NiJ9.e30', '?code=1', 'ClientSecret']) {
    assert.match(sample, FORBIDDEN, `${sample} must be caught`);
  }
  for (const sample of ['/analyst/form', 'OrderColumn', 'Search', 'Smithson', '3f2c9a1e-5b7d-4e8a-9c01-0a1b2c3d4e5f']) {
    assert.doesNotMatch(sample, FORBIDDEN, `${sample} must pass`);
  }
});

// A boilerplate checkout has no project with recordings; the check is then skipped, not green by accident.
const FILES = recordingFiles();
test('committed HAR summaries contain no credentials', { skip: FILES.length === 0 ? 'no projects/**/recordings/*.json committed' : false }, () => {
  const files = FILES;

  const hits = files.flatMap((file) => {
    const text = readFileSync(join(PROJECTS, file), 'utf8');
    return text.split('\n').flatMap((line, i) => (FORBIDDEN.test(line) ? [`${file.split(sep).join('/')}:${i + 1}`] : []));
  });
  assert.deepEqual(hits, [], 'recordings must not contain bearer|password|cookie|authorization|access_token|JWT|code=|secret');
});
