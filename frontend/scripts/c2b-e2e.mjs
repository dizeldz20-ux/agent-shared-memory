import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const PORT = 5941;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let serverOutput = '';
const DEBUG_KEYS = [
  'curvatureBuckets',
  'focusSize',
  'focusVisibleLinkCount',
  'headerClippedNodeCount',
  'layout',
  'livePositionDigest',
  'motion',
  'overviewVisibleLinkCount',
  'positionDigest',
  'selectedId',
  'simulationRunning',
  'styleBuckets',
  'totalLinkCount',
];
const RING_KEYS = [
  'activeLinkCount',
  'ambientEnabled',
  'arcGapCountMin',
  'backgroundLinkCount',
  'bandCount',
  'coreRadius',
  'ellipseRatioMax',
  'ellipseRatioMin',
  'fitZoom',
  'geometryDigest',
  'layout',
  'maxOffBandDistance',
  'pinnedNodeCount',
  'radialJitterMax',
  'selectedId',
  'totalNodeCount',
  'visibleLinkCount',
];
const BRAIN3D_KEYS = [
  'ambientParticlesEnabled',
  'bloomRadius',
  'bloomStrength',
  'bloomThreshold',
  'cameraPreset',
  'focusSize',
  'focusVisibleLinkCount',
  'fogDensity',
  'framingReady',
  'hoveredId',
  'layout',
  'motion',
  'nodeValueBuckets',
  'positionDigest',
  'refreshTicking',
  'selectedId',
  'styleBuckets',
  'topOccludedNodeCount',
  'totalLinkCount',
  'visibleLinkCount',
  'visibleNodeRatio',
];

async function waitForServer(server) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`Vite preview exited with ${server.exitCode}\n${serverOutput}`);
    }
    if (!serverOutput.includes('Local')) {
      await sleep(250);
      continue;
    }
    try {
      const response = await fetch(ORIGIN);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Vite preview did not start\n${serverOutput}`);
}

async function stopServer(server) {
  if (!server.pid || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    await once(killer, 'exit').catch(() => {});
  } else {
    server.kill('SIGTERM');
  }
  if (server.exitCode === null) {
    await Promise.race([once(server, 'exit').catch(() => {}), sleep(5000)]);
  }
}

async function readNetwork(page) {
  await page.waitForFunction(() => window.__c2b?.network?.layout === 'anatomical');
  return page.evaluate(() => window.__c2b.network);
}

async function readRings(page) {
  await page.waitForFunction(() => window.__c2b?.rings?.layout === 'cortical');
  return page.evaluate(() => window.__c2b.rings);
}

async function readBrain3D(page) {
  await page.waitForFunction(() => window.__c2b?.brain3d?.layout === 'connectome');
  return page.evaluate(() => window.__c2b.brain3d);
}

function assertDebugContract(network) {
  assert.deepEqual(Object.keys(network).sort(), DEBUG_KEYS);
  assert.equal(network.layout, 'anatomical');
  assert.equal(network.motion, true);
  assert.equal(network.simulationRunning, true);
  assert.match(network.positionDigest, /^[a-f0-9]{8}$/);
  assert.match(network.livePositionDigest, /^[a-f0-9]{8}$/);
  assert.ok(network.overviewVisibleLinkCount > 0, 'overview visible links should be non-zero');
  assert.ok(network.overviewVisibleLinkCount < network.totalLinkCount, 'overview should progressively suppress links');
  assert.ok(network.totalLinkCount >= 5000, 'demo graph should expose full public topology scale');
  assert.ok(network.curvatureBuckets <= 7, `curvature buckets stay batched: ${network.curvatureBuckets}`);
  assert.ok(network.styleBuckets <= 8, `style buckets stay batched: ${network.styleBuckets}`);
  assert.ok(network.headerClippedNodeCount >= 0, 'header clipping must be measurable, not -1');
}

function assertRingContract(rings) {
  assert.deepEqual(Object.keys(rings).sort(), RING_KEYS);
  assert.equal(rings.layout, 'cortical');
  assert.equal(rings.ambientEnabled, false);
  assert.ok(Number.isInteger(rings.activeLinkCount) && rings.activeLinkCount >= 0);
  assert.match(rings.geometryDigest, /^[a-f0-9]{8}$/);
  assert.ok(rings.arcGapCountMin >= 4 && rings.arcGapCountMin <= 6);
  assert.equal(rings.backgroundLinkCount, 0);
  assert.ok(rings.bandCount >= 10, `organic band count ${rings.bandCount}`);
  assert.ok(rings.coreRadius >= 20 && rings.coreRadius <= 40);
  assert.ok(rings.ellipseRatioMin >= 0.58 && rings.ellipseRatioMax <= 0.82);
  assert.ok(rings.fitZoom > 0.4 && rings.fitZoom < 3);
  assert.ok(rings.maxOffBandDistance < 5);
  assert.equal(rings.pinnedNodeCount, rings.totalNodeCount);
  assert.ok(rings.totalNodeCount >= 1600);
  assert.ok(rings.radialJitterMax < 5);
  assert.equal(rings.radialJitterMax, rings.maxOffBandDistance);
  assert.ok(rings.activeLinkCount <= rings.visibleLinkCount);
}

function assertBrain3DContract(brain) {
  assert.deepEqual(Object.keys(brain).sort(), BRAIN3D_KEYS);
  assert.equal(brain.layout, 'connectome');
  assert.equal(brain.motion, true);
  assert.match(brain.positionDigest, /^[a-f0-9]{8}$/);
  assert.equal(brain.fogDensity, 0.00155);
  assert.equal(brain.bloomStrength, 0.56);
  assert.equal(brain.bloomRadius, 0.42);
  assert.equal(brain.bloomThreshold, 0.38);
  assert.ok(brain.nodeValueBuckets <= 24, `3D node value buckets ${brain.nodeValueBuckets}`);
  assert.ok(brain.styleBuckets <= 8, `3D style buckets ${brain.styleBuckets}`);
  assert.ok(brain.visibleLinkCount > 0 && brain.visibleLinkCount < brain.totalLinkCount);
  assert.ok(brain.totalLinkCount >= 5000);
  assert.equal(typeof brain.framingReady, 'boolean');
  assert.equal(typeof brain.visibleNodeRatio, 'number');
  assert.equal(typeof brain.topOccludedNodeCount, 'number');
  if (brain.cameraPreset === 'whole') {
    assert.equal(brain.framingReady, true, 'whole-brain camera fit must finish before acceptance');
    assert.ok(brain.visibleNodeRatio >= 0.97, JSON.stringify(brain));
    assert.equal(brain.topOccludedNodeCount, 0, 'whole-brain nodes must not render behind the header');
  }
}

const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const server = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => { serverOutput += chunk; });
server.stderr.on('data', (chunk) => { serverOutput += chunk; });
let browser;

try {
  await waitForServer(server);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const requests = [];
  const errors = [];
  const failedResponses = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  await page.goto(`${ORIGIN}/?mode=2d`, { waitUntil: 'networkidle' });
  const app = page.locator('[data-testid="c2b-app"]');
  await app.waitFor();
  assert.equal(await app.getAttribute('data-preview'), 'true');
  assert.equal(await app.getAttribute('data-motion'), 'full');

  const viewTabs = page.locator('[data-testid="view-tabs"]');
  await viewTabs.waitFor();
  assert.equal(await viewTabs.getAttribute('role'), 'tablist');
  assert.equal(await page.locator('[data-testid="view-network"]').getAttribute('aria-selected'), 'true');
  assert.deepEqual(
    await page.locator('[role="tab"]').allTextContents(),
    ['מוח 3D', 'רשת 2D', 'טבעות 2D'],
  );

  const nodeSearch = page.locator('[data-testid="search-input"]');
  assert.equal(await nodeSearch.getAttribute('role'), 'combobox');
  assert.equal(await nodeSearch.getAttribute('aria-autocomplete'), 'list');
  assert.equal(await nodeSearch.getAttribute('aria-controls'), 'node-search-results');
  await nodeSearch.fill('זיכרון');
  const nodeResults = page.locator('#node-search-results[role="listbox"]');
  await nodeResults.waitFor();
  assert.ok(await nodeResults.locator('[role="option"]').count() > 1, 'node search must expose keyboard-selectable graph nodes');
  await nodeSearch.press('ArrowDown');
  assert.match(await nodeSearch.getAttribute('aria-activedescendant'), /^node-option-/);
  await nodeSearch.press('Enter');
  await page.locator('[data-testid="inspector"]').waitFor();
  await page.locator('[data-testid="inspector"] [aria-label="סגירת פרטי צומת"]').click();
  assert.equal(await page.locator('[data-testid="inspector"]').count(), 0);

  await page.locator('[data-testid="view-rings"]').evaluate((element) => element.click());
  assert.equal(await app.getAttribute('data-view'), 'rings');
  assert.equal(await page.locator('[data-testid="view-rings"]').getAttribute('aria-selected'), 'true');
  const initialRings = await readRings(page);
  assertRingContract(initialRings);
  assert.equal(initialRings.selectedId, null);
  assert.ok(initialRings.visibleLinkCount >= 0 && initialRings.visibleLinkCount <= 64);
  await page.waitForFunction(() => (window.__c2b?.rings?.activeLinkCount ?? 0) > 0);
  const liveRings = await readRings(page);
  assertRingContract(liveRings);
  assert.equal(liveRings.selectedId, null);
  assert.ok(liveRings.activeLinkCount > 0, 'demo activity must expose a live radial pathway');
  assert.ok(liveRings.visibleLinkCount >= liveRings.activeLinkCount && liveRings.visibleLinkCount <= 64);
  const initialRingDigest = liveRings.geometryDigest;
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/task5-rings-overview-1600x900.png', import.meta.url)) });
  await page.locator('[data-testid="view-network"]').evaluate((element) => element.click());
  assert.equal(await app.getAttribute('data-view'), 'network');

  // The fixed header overlays the canvas. The layout expands for a few seconds, so
  // the camera must converge to a frame that leaves nothing permanently hidden.
  await page.waitForFunction(() => window.__c2b?.network?.headerClippedNodeCount === 0, null, { timeout: 20000 })
    .catch(async () => {
      const stuck = await page.evaluate(() => window.__c2b?.network?.headerClippedNodeCount);
      assert.fail(`network never framed clear of the header: ${stuck} somas still behind it`);
    });

  const initial = await readNetwork(page);
  assertDebugContract(initial);
  assert.equal(initial.focusSize, 0);
  assert.equal(initial.selectedId, null);
  assert.equal(initial.focusVisibleLinkCount, 0);
  const initialDigest = initial.positionDigest;

  await page.reload({ waitUntil: 'networkidle' });
  await app.waitFor();
  const reloaded = await readNetwork(page);
  assertDebugContract(reloaded);
  assert.equal(reloaded.focusSize, 0);
  assert.equal(reloaded.selectedId, null);
  assert.equal(reloaded.positionDigest, initialDigest, 'pre-simulation target digest must survive reloads');

  await page.locator('[data-testid="search-input"]').fill('זיכרון 001');
  await page.locator('[data-testid="search-input"]').press('Enter');
  await page.locator('[data-testid="inspector"]').waitFor();
  assert.match(await page.locator('[data-testid="inspector"]').innerText(), /זיכרון 001/);
  await page.waitForFunction(() => (window.__c2b?.network?.focusSize ?? 0) > 1);
  const focused = await readNetwork(page);
  assertDebugContract(focused);
  assert.ok(typeof focused.selectedId === 'string' && focused.selectedId.length > 0);
  assert.ok(focused.focusSize > 1, 'search selection should expose one-hop focus size');
  assert.ok(focused.focusVisibleLinkCount > 0, 'focus visible links should be non-zero');
  assert.ok(focused.focusVisibleLinkCount < focused.overviewVisibleLinkCount, 'focus should show fewer links than overview');
  await page.locator('[data-testid="view-rings"]').evaluate((element) => element.click());
  await page.waitForFunction(() => (window.__c2b?.rings?.activeLinkCount ?? 0) > 0);
  const selectedRings = await readRings(page);
  assertRingContract(selectedRings);
  assert.equal(selectedRings.geometryDigest, initialRingDigest);
  assert.ok(typeof selectedRings.selectedId === 'string' && selectedRings.selectedId.length > 0);
  assert.ok(selectedRings.visibleLinkCount > 0 && selectedRings.visibleLinkCount <= 64, `selected radial links ${selectedRings.visibleLinkCount}`);
  assert.ok(selectedRings.activeLinkCount > 0, 'focused rings must retain the live active path');
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/task5-rings-selected-1600x900.png', import.meta.url)) });
  await page.locator('[data-testid="view-network"]').evaluate((element) => element.click());
  await page.locator('[data-testid="inspector"] [aria-label="סגירת פרטי צומת"]').click();
  assert.equal(await page.locator('[data-testid="inspector"]').count(), 0);

  await page.keyboard.press('/');
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    'search-input',
  );
  await page.locator('[data-testid="search-input"]').fill('זיכרון 001');
  await page.locator('[data-testid="search-input"]').press('Enter');
  await page.locator('[data-testid="inspector"]').waitFor();
  await page.locator('[data-testid="inspector"] [aria-label="סגירת פרטי צומת"]').click();
  assert.equal(await page.locator('[data-testid="inspector"]').count(), 0);

  await page.locator('[data-testid="view-3d"]').click();
  assert.equal(await app.getAttribute('data-view'), '3d');
  await page.locator('[data-testid="camera-whole"]').click();
  await page.locator('[data-testid="camera-left"]').click();
  await page.waitForFunction(() => window.__c2b?.brain3d?.cameraPreset === 'left');
  await page.locator('[data-testid="camera-right"]').click();
  await page.waitForFunction(() => window.__c2b?.brain3d?.cameraPreset === 'right');
  await page.locator('[data-testid="camera-whole"]').click();
  await page.waitForFunction(() => window.__c2b?.brain3d?.cameraPreset === 'whole');
  await page.waitForFunction(() => window.__c2b?.brain3d?.framingReady === true);
  const wholeBrain = await readBrain3D(page);
  assertBrain3DContract(wholeBrain);
  assert.equal(wholeBrain.selectedId, null);
  assert.equal(wholeBrain.focusSize, 0);
  assert.equal(wholeBrain.focusVisibleLinkCount, 0);
  await page.waitForTimeout(4500);
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/task6-3d-whole-1600x900.png', import.meta.url)) });

  await page.locator('[data-testid="search-input"]').fill('זיכרון 001');
  await page.locator('[data-testid="search-input"]').press('Enter');
  await page.locator('[data-testid="inspector"]').waitFor();
  await page.waitForFunction(() => (window.__c2b?.brain3d?.focusSize ?? 0) > 1);
  await page.locator('[data-testid="camera-selected"]').click();
  await page.waitForFunction(() => window.__c2b?.brain3d?.cameraPreset === 'selected');
  const focusedBrain = await readBrain3D(page);
  assertBrain3DContract(focusedBrain);
  assert.ok(typeof focusedBrain.selectedId === 'string' && focusedBrain.selectedId.length > 0);
  assert.ok(focusedBrain.focusSize > 1);
  assert.ok(focusedBrain.focusVisibleLinkCount > 0);
  assert.ok(focusedBrain.focusVisibleLinkCount < wholeBrain.visibleLinkCount);
  await page.waitForTimeout(900);
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/task6-3d-focus-1600x900.png', import.meta.url)) });
  await page.locator('[data-testid="inspector"] [aria-label="סגירת פרטי צומת"]').click();
  assert.equal(await page.locator('[data-testid="inspector"]').count(), 0);

  await page.locator('[data-testid="layer-trigger"]').click();
  await page.locator('[data-testid="layer-menu"]').waitFor();
  await page.locator('[data-testid="activity-trigger"]').click();
  await page.locator('[data-testid="activity-panel"]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-testid="layer-menu"]').count(), 0);
  assert.equal(await page.locator('[data-testid="activity-panel"]').count(), 0);

  await page.waitForTimeout(2500);
  const frameStats = await page.evaluate(async () => {
    const samples = [];
    let previous = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => {
        samples.push(now - previous);
        previous = now;
        if (samples.length >= 121) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    samples.shift();
    samples.sort((a, b) => a - b);
    return {
      median: samples[Math.floor(samples.length / 2)],
      p95: samples[Math.floor(samples.length * 0.95)],
    };
  });
  assert.ok(frameStats.median < 27, JSON.stringify(frameStats));

  const secondaryRequests = [];
  const secondaryErrors = [];
  const secondaryFailedResponses = [];
  const responsiveResults = [];
  for (const [width, height] of [[1600, 900], [1100, 800], [860, 780]]) {
    const responsivePage = await browser.newPage({ viewport: { width, height } });
    responsivePage.on('request', (request) => secondaryRequests.push(request.url()));
    responsivePage.on('response', (response) => response.status() >= 400 && secondaryFailedResponses.push(`${response.status()} ${response.url()}`));
    responsivePage.on('pageerror', (error) => secondaryErrors.push(error.message));
    responsivePage.on('console', (message) => message.type() === 'error' && secondaryErrors.push(message.text()));
    await responsivePage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
    await responsivePage.goto(`${ORIGIN}/?mode=2d`, { waitUntil: 'networkidle' });
    const responsiveApp = responsivePage.locator('[data-testid="c2b-app"]');
    await responsiveApp.waitFor();
    assert.equal(await responsiveApp.getAttribute('data-motion'), 'full');
    assert.equal(await responsivePage.locator('[data-testid="view-tabs"]').isVisible(), true);
    await responsivePage.locator('[data-testid="search-input"]').fill('זיכרון 001');
    await responsivePage.locator('[data-testid="search-input"]').press('Enter');
    const responsiveInspector = responsivePage.locator('[data-testid="inspector"]');
    await responsiveInspector.waitFor();
    const geometry = await responsivePage.evaluate(() => {
      const root = document.documentElement;
      const header = document.querySelector('.instrument-header');
      const inspector = document.querySelector('[data-testid="inspector"]');
      const headerRect = header.getBoundingClientRect();
      const inspectorRect = inspector.getBoundingClientRect();
      const rowCenters = [...header.children].map((child) => {
        const rect = child.getBoundingClientRect();
        return Math.round((rect.top + rect.height / 2) / 8) * 8;
      });
      return {
        overflowX: root.scrollWidth - innerWidth,
        overflowY: root.scrollHeight - innerHeight,
        headerHeight: headerRect.height,
        headerRows: new Set(rowCenters).size,
        inspector: { x: inspectorRect.x, y: inspectorRect.y, width: inspectorRect.width, height: inspectorRect.height, bottom: inspectorRect.bottom, right: inspectorRect.right },
      };
    });
    assert.ok(geometry.overflowX <= 0, `${width}px horizontal overflow ${geometry.overflowX}`);
    assert.ok(geometry.overflowY <= 0, `${width}px vertical overflow ${geometry.overflowY}`);
    if (width > 1200) {
      assert.equal(geometry.headerRows, 1, JSON.stringify(geometry));
      assert.ok(geometry.inspector.right >= width - 17, JSON.stringify(geometry.inspector));
    } else if (width > 900) {
      assert.equal(geometry.headerRows, 2, JSON.stringify(geometry));
      assert.ok(geometry.inspector.width >= 280 && geometry.inspector.width <= 296, JSON.stringify(geometry.inspector));
      assert.ok(geometry.inspector.right >= width - 17, JSON.stringify(geometry.inspector));
    } else {
      assert.ok(geometry.inspector.x <= 9 && geometry.inspector.width >= width - 18, JSON.stringify(geometry.inspector));
      assert.ok(geometry.inspector.height <= height * 0.58 + 2, JSON.stringify(geometry.inspector));
      assert.ok(geometry.inspector.bottom >= height - 9, JSON.stringify(geometry.inspector));
    }
    responsiveResults.push({ width, height, ...geometry });
    await responsivePage.close();
  }

  const framingPage = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  framingPage.on('request', (request) => secondaryRequests.push(request.url()));
  framingPage.on('response', (response) => response.status() >= 400 && secondaryFailedResponses.push(`${response.status()} ${response.url()}`));
  framingPage.on('pageerror', (error) => secondaryErrors.push(error.message));
  framingPage.on('console', (message) => message.type() === 'error' && secondaryErrors.push(message.text()));
  await framingPage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  await framingPage.goto(`${ORIGIN}/?mode=2d`, { waitUntil: 'networkidle' });
  await framingPage.locator('[data-testid="c2b-app"]').waitFor();
  await framingPage.locator('[data-testid="view-3d"]').evaluate((element) => element.click());
  await framingPage.waitForFunction(() => window.__c2b?.brain3d?.layout === 'connectome');
  await framingPage.locator('[data-testid="camera-whole"]').evaluate((element) => element.click());
  await framingPage.waitForFunction(() => window.__c2b?.brain3d?.framingReady === true);
  const framedBrain = await readBrain3D(framingPage);
  assertBrain3DContract(framedBrain);
  await framingPage.screenshot({ path: fileURLToPath(new URL('../artifacts/task7-3d-framing-1366x768.png', import.meta.url)) });
  await framingPage.close();

  const reducedPage = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  reducedPage.on('request', (request) => secondaryRequests.push(request.url()));
  reducedPage.on('response', (response) => response.status() >= 400 && secondaryFailedResponses.push(`${response.status()} ${response.url()}`));
  reducedPage.on('pageerror', (error) => secondaryErrors.push(error.message));
  reducedPage.on('console', (message) => message.type() === 'error' && secondaryErrors.push(message.text()));
  await reducedPage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  await reducedPage.goto(`${ORIGIN}/?mode=2d`, { waitUntil: 'networkidle' });
  const reducedApp = reducedPage.locator('[data-testid="c2b-app"]');
  await reducedApp.waitFor();
  assert.equal(await reducedApp.getAttribute('data-motion'), 'reduced');
  const reducedNetworkStart = await readNetwork(reducedPage);
  assert.equal(reducedNetworkStart.motion, false);
  assert.equal(reducedNetworkStart.simulationRunning, false);
  assert.match(reducedNetworkStart.livePositionDigest, /^[a-f0-9]{8}$/);
  await reducedPage.waitForTimeout(600);
  const reducedNetworkStable = await readNetwork(reducedPage);
  assert.equal(
    reducedNetworkStable.livePositionDigest,
    reducedNetworkStart.livePositionDigest,
    'reduced-motion 2D nodes must remain position-stable',
  );
  assert.equal(await reducedPage.locator('[data-testid="view-tabs"]').isVisible(), true);
  const reducedViewport = await reducedPage.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - innerWidth,
    overflowY: document.documentElement.scrollHeight - innerHeight,
    transitionDuration: getComputedStyle(document.querySelector('[data-testid="view-network"]')).transitionDuration,
  }));
  assert.ok(reducedViewport.overflowX <= 0, JSON.stringify(reducedViewport));
  assert.ok(reducedViewport.overflowY <= 0, JSON.stringify(reducedViewport));
  assert.ok(parseFloat(reducedViewport.transitionDuration) <= 0.00001, JSON.stringify(reducedViewport));
  await reducedPage.keyboard.press('Tab');
  const focusRing = await reducedPage.evaluate(() => {
    const activeElement = document.activeElement;
    const style = getComputedStyle(activeElement);
    return { tag: activeElement?.tagName, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  assert.ok(['BUTTON', 'INPUT', 'SELECT'].includes(focusRing.tag), JSON.stringify(focusRing));
  assert.notEqual(focusRing.outlineStyle, 'none');
  assert.ok(parseFloat(focusRing.outlineWidth) >= 2, JSON.stringify(focusRing));
  await reducedPage.locator('[data-testid="search-input"]').fill('זיכרון 001');
  await reducedPage.locator('[data-testid="search-input"]').press('Enter');
  const reducedInspector = reducedPage.locator('[data-testid="inspector"]');
  await reducedInspector.waitFor();
  const reducedInspectorBox = await reducedInspector.boundingBox();
  assert.ok(reducedInspectorBox.height <= 844 * 0.58 + 2, JSON.stringify(reducedInspectorBox));
  assert.ok(reducedInspectorBox.x <= 9 && reducedInspectorBox.width >= 372, JSON.stringify(reducedInspectorBox));
  await reducedPage.locator('[data-testid="inspector"] [aria-label="סגירת פרטי צומת"]').click();
  await reducedPage.locator('[data-testid="view-3d"]').click();
  await reducedPage.waitForFunction(() => window.__c2b?.brain3d?.layout === 'connectome');
  await reducedPage.waitForFunction(() => window.__c2b?.brain3d?.framingReady === true);
  const reducedBrain = await reducedPage.evaluate(() => window.__c2b.brain3d);
  assert.equal(reducedBrain.motion, false);
  assert.equal(reducedBrain.ambientParticlesEnabled, false);
  assert.equal(reducedBrain.refreshTicking, false);
  assert.ok(reducedBrain.visibleNodeRatio >= 0.97, `mobile whole-brain visible node ratio ${reducedBrain.visibleNodeRatio}`);
  assert.equal(reducedBrain.topOccludedNodeCount, 0);
  assert.equal(await reducedPage.locator('[data-testid="camera-dock"]').isVisible(), true);
  await reducedPage.screenshot({ path: fileURLToPath(new URL('../artifacts/task7-mobile-reduced-390x844.png', import.meta.url)) });
  await reducedPage.close();

  assert.equal(secondaryRequests.some((url) => url.includes('/api/') || url.includes('/ws')), false, secondaryRequests.join('\n'));
  assert.deepEqual(secondaryFailedResponses, []);
  assert.deepEqual(secondaryErrors, []);

  const connectionStatus = page.locator('[data-testid="connection-status"]');
  assert.notEqual((await connectionStatus.innerText()).trim(), '');
  assert.equal(await connectionStatus.locator('.dot').count(), 0);
  assert.equal(requests.some((url) => url.includes('/api/') || url.includes('/ws')), false, requests.join('\n'));
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ requestCount: requests.length, requests, failedResponses, errors, frameStats, responsiveResults, reducedViewport }, null, 2));
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
