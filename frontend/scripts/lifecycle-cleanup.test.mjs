import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const useLiveSource = await readFile(new URL('src/useLive.ts', root), 'utf8');
const e2eSource = await readFile(new URL('scripts/c2b-e2e.mjs', root), 'utf8');

const normalize = (text) => text.replace(/\r\n/g, '\n');

const useLive = normalize(useLiveSource);
const e2e = normalize(e2eSource);

test('useLive declares and clears reconnect lifecycle guards', () => {
  assert.match(useLive, /let\s+retryTimer\b/);
  assert.match(useLive, /if\s*\(dead\)\s*return;/);
  assert.match(useLive, /if\s*\(retryTimer\)\s*clearTimeout\(retryTimer\);/);
});

test('c2b e2e owns browser and process-tree cleanup with a strict response gate', () => {
  assert.match(e2e, /(?:let|const)\s+browser\b/);
  assert.match(e2e, /browser\s*=\s*await\s+chromium\.launch/);
  assert.match(e2e, /finally\s*\{[\s\S]*await\s+browser\.close\(\);[\s\S]*await\s+stopServer\(server\);[\s\S]*\}/);
  assert.match(e2e, /spawn\('taskkill',\s*\['\/PID',[\s\S]*'\/T',\s*'\/F'\]/);
  assert.match(e2e, /assert\.deepEqual\(failedResponses,\s*\[\]\);/);
  assert.match(e2e, /assert\.deepEqual\(errors,\s*\[\]\);/);
});
