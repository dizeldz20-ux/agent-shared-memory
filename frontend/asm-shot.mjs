import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const shot = resolve(process.argv[2] || 'asm.png');
const url = new URL(process.argv[3] || 'http://127.0.0.1:8930/');
const width = Number(process.argv[4] || 1600);
const height = Number(process.argv[5] || 900);
const settleMs = Number(process.argv[6] || 9000);
const motion = process.argv[7] === 'reduce' ? 'reduce' : 'no-preference';

if (!Number.isFinite(width) || width < 320 || !Number.isFinite(height) || height < 480 || !Number.isFinite(settleMs) || settleMs < 0) {
  throw new Error('Usage: node asm-shot.mjs <path> <url> <width> <height> <settleMs> [reduce|full]');
}

await mkdir(dirname(shot), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  const page = await browser.newPage({
    viewport: { width, height },
    reducedMotion: motion,
  });
  const errors = [];
  const failedResponses = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => message.type() === 'error' && errors.push(`console: ${message.text()}`));
  page.on('response', (response) => response.status() >= 400 && failedResponses.push(`${response.status()} ${response.url()}`));
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(settleMs);

  const localLive = ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '8930';
  if (localLive) {
    await fetch(new URL('/api/events', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'Read',
        cwd: 'C:/demo',
        session: 'screenshot',
        paths: ['C:/demo/ASM/frontend/src/App.tsx'],
        agent: 'Codex',
      }),
    });
    await page.waitForTimeout(1200);
  }

  await page.screenshot({ path: shot });
  if (failedResponses.length || errors.length) {
    throw new Error([...failedResponses, ...errors].join('\n'));
  }
  console.log(JSON.stringify({ shot, url: url.toString(), width, height, settleMs, reducedMotion: motion }, null, 2));
} finally {
  await browser.close();
}
