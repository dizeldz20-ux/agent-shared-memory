import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [app, css, shot, html] = await Promise.all([
  readFile(new URL('src/App.tsx', root), 'utf8'),
  readFile(new URL('src/index.css', root), 'utf8'),
  readFile(new URL('c2b-shot.mjs', root), 'utf8'),
  readFile(new URL('index.html', root), 'utf8'),
]);

test('App exposes a media-query-backed motion contract to both renderers', () => {
  assert.match(app, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(app, /data-motion=\{reduceMotion \? 'reduced' : 'full'\}/);
  assert.ok((app.match(/motionEnabled=\{!reduceMotion\}/g) ?? []).length >= 2, 'both renderers must receive motionEnabled');
});

test('CSS uses a local system font stack, dynamic viewport units, logical RTL geometry, and all required breakpoints', () => {
  assert.match(css, /font-family:\s*system-ui/);
  assert.doesNotMatch(css, /@font-face/);
  assert.match(css, /min-height:\s*100dvh/);
  assert.doesNotMatch(css, /100vh/);
  assert.match(css, /@media\s*\(max-width:\s*1200px\)/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)/);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/);
  assert.match(css, /max-height:\s*58dvh/);
  assert.match(css, /\.camera-dock[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /inset-inline-(?:start|end)/);
});

test('HTML no longer depends on remote Google Fonts', () => {
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
});

test('screenshot harness is parameterized, preview-safe, and contains no private path', () => {
  assert.match(shot, /process\.argv\[3\]/);
  assert.match(shot, /Number\(process\.argv\[4\]/);
  assert.match(shot, /Number\(process\.argv\[5\]/);
  assert.match(shot, /Number\(process\.argv\[6\]/);
  assert.match(shot, /reducedMotion/);
  assert.match(shot, /url\.port\s*===\s*'8930'/);
  assert.match(shot, /finally\s*\{[\s\S]*browser\.close\(\)/);
  assert.doesNotMatch(shot, /C:[\\/]Users[\\/]|OneDrive/);
});
