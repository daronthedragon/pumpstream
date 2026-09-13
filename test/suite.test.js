import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The test script names its files explicitly, so a new test file runs green
 * locally and then never runs again. This is the guard: write a *.test.js and
 * forget to wire it up, and the suite says so.
 */

const dir = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

test('every test file is actually in the npm test script', async () => {
  const pkg = JSON.parse(await readFile(root + '/package.json', 'utf8'));
  const script = pkg.scripts.test;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.test.js'));

  assert.ok(files.length > 5, 'found suspiciously few test files');
  const missing = files.filter((f) => !script.includes(`test/${f}`));
  assert.deepEqual(
    missing,
    [],
    `not run by \`npm test\` — add to package.json: ${missing.join(', ')}`
  );
});

test('the test script does not name a file that no longer exists', async () => {
  const pkg = JSON.parse(await readFile(root + '/package.json', 'utf8'));
  const named = [...pkg.scripts.test.matchAll(/test\/([\w.-]+\.test\.js)/g)].map((m) => m[1]);
  const present = new Set(await readdir(dir));
  const gone = named.filter((f) => !present.has(f));
  assert.deepEqual(gone, [], `named in package.json but missing: ${gone.join(', ')}`);
});
