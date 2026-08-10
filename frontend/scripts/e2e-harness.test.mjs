import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./c2b-e2e.mjs', import.meta.url), 'utf8');

test('preview server is isolated and cannot silently move to a foreign port', () => {
  assert.match(source, /'--strictPort'/);
  assert.match(source, /waitForServer\(server\)/);
  assert.match(source, /server\.exitCode/);
});

test('Windows teardown reaps the spawned Vite process tree', () => {
  assert.match(source, /taskkill/i);
  assert.match(source, /'\/T'/);
  assert.match(source, /'\/F'/);
});

test('console failures are not hidden by a generic 404 exemption', () => {
  assert.doesNotMatch(
    source,
    /error === 'Failed to load resource: the server responded with a status of 404 \(Not Found\)'/,
  );
  assert.match(source, /page\.route\('\*\*\/favicon\.ico'/);
});
