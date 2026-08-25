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
  'anchorCount',
  'atlasAspectRatio',
  'atlasMinimumSpacing',
  'backgroundLinkCount',
  'cameraPose',
  'curvatureBuckets',
  'focusSize',
  'focusVisibleLinkCount',
  'headerClippedNodeCount',
  'layout',
  'livePositionDigest',
  'liveSignalAgentCount',
  'liveSignalBeadCount',
  'liveSignalDigest',
  'liveSignalNodeCount',
  'liveSignalSegmentCount',
  'motion',
  'nodeCoverageRatio',
  'overviewVisibleLinkCount',
  'positionDigest',
  'selectedId',
  'simulationRunning',
  'styleBuckets',
  'totalLinkCount',
  'visibleNodeCount',
];
const RING_KEYS = [
  'activeLinkCount',
  'ambientEnabled',
  'arcGapCountMin',
  'backgroundLinkCount',
  'bandCount',
  'cameraPose',
  'coreRadius',
  'ellipseRatioMax',
  'ellipseRatioMin',
  'fitZoom',
  'geometryDigest',
  'layout',
  'liveSignalAgentCount',
  'liveSignalBeadCount',
  'liveSignalDigest',
  'liveSignalNodeCount',
  'liveSignalSegmentCount',
  'maxOffBandDistance',
  'maxRingPositionError',
  'nodeCoverageRatio',
  'pinnedNodeCount',
  'radialJitterMax',
  'selectedId',
  'totalNodeCount',
  'visibleLinkCount',
  'visibleNodeCount',
];
const BRAIN3D_KEYS = [
  'ambientParticlesEnabled',
  'batchedLinkCount',
  'batchedLinkDigest',
  'batchedNodeCount',
  'bloomRadius',
  'bloomStrength',
  'bloomThreshold',
  'brainInteriorRadius',
  'cameraDistance',
  'cameraMinDistance',
  'cameraNear',
  'cameraPose',
  'cameraPreset',
  'corticalFieldDigest',
  'corticalMeshVertexCount',
  'focusSize',
  'focusVisibleLinkCount',
  'fogDensity',
  'framingReady',
  'hoverTarget',
  'hoveredId',
  'insideBrain',
  'interactiveNodeCount',
  'layout',
  'liveSignalAgentCount',
  'liveSignalBeadCount',
  'liveSignalDigest',
  'liveSignalNodeCount',
  'liveSignalSegmentCount',
  'motion',
  'navigationEnabled',
  'neuronMorphologyCount',
  'nodeCoverageRatio',
  'nodeValueBuckets',
  'positionDigest',
  'refreshTicking',
  'selectedId',
  'sourceNodeCount',
  'styleBuckets',
  'topOccludedNodeCount',
  'totalLinkCount',
  'visibleLinkCount',
  'visibleLinkTypeCounts',
  'visibleNodeRatio',
  'visibleTractCoverageRatio',
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
  await page.waitForFunction(() => window.__asm?.network?.layout === 'neural-atlas');
  return page.evaluate(() => window.__asm.network);
}

async function readRings(page) {
  await page.waitForFunction(() => window.__asm?.rings?.layout === 'cortical-sheet');
  return page.evaluate(() => window.__asm.rings);
}

async function readBrain3D(page) {
  await page.waitForFunction(() => window.__asm?.brain3d?.layout === 'connectome');
  return page.evaluate(() => window.__asm.brain3d);
}

function assertDebugContract(network) {
  assert.deepEqual(Object.keys(network).sort(), DEBUG_KEYS);
  assert.equal(network.layout, 'neural-atlas');
  assert.equal(network.motion, true);
  assert.equal(network.simulationRunning, false);
  assert.match(network.positionDigest, /^[a-f0-9]{8}$/);
  assert.match(network.livePositionDigest, /^[a-f0-9]{8}$/);
  assert.match(network.liveSignalDigest, /^[a-f0-9]{8}$/);
  assert.ok(Array.isArray(network.cameraPose) && network.cameraPose.length === 3);
  assert.ok(network.anchorCount > 0, 'neural atlas must expose semantic anchors');
  assert.ok(network.atlasAspectRatio > 2, `neural atlas should use the wide viewport: ${network.atlasAspectRatio}`);
  assert.ok(network.atlasMinimumSpacing > 0, `neural atlas spacing ${network.atlasMinimumSpacing}`);
  assert.equal(network.nodeCoverageRatio, 1, 'every visible data node must be painted in the atlas background');
  assert.ok(network.visibleNodeCount >= 1600, 'demo atlas should expose the full public node scale');
  assert.equal(network.backgroundLinkCount, network.totalLinkCount, 'atlas background must retain every visible data link');
  assert.equal(network.overviewVisibleLinkCount, network.totalLinkCount, 'overview coverage is no longer a hidden-link LOD');
  assert.ok(network.totalLinkCount >= 5000, 'demo graph should expose full public topology scale');
  assert.ok(network.curvatureBuckets <= 7, `curvature buckets stay batched: ${network.curvatureBuckets}`);
  assert.ok(network.styleBuckets <= 8, `style buckets stay batched: ${network.styleBuckets}`);
  assert.ok(network.headerClippedNodeCount >= 0, 'header clipping must be measurable, not -1');
}

function assertRingContract(rings) {
  assert.deepEqual(Object.keys(rings).sort(), RING_KEYS);
  assert.equal(rings.layout, 'cortical-sheet');
  assert.equal(rings.ambientEnabled, false);
  assert.ok(Number.isInteger(rings.activeLinkCount) && rings.activeLinkCount >= 0);
  assert.match(rings.geometryDigest, /^[a-f0-9]{8}$/);
  assert.match(rings.liveSignalDigest, /^[a-f0-9]{8}$/);
  assert.ok(Array.isArray(rings.cameraPose) && rings.cameraPose.length === 3);
  assert.equal(rings.arcGapCountMin, 2, 'each cortical fold is an open two-segment sheet');
  assert.ok(rings.backgroundLinkCount >= 5000, 'cortical sheet must retain the full background topology');
  assert.equal(rings.visibleLinkCount, rings.backgroundLinkCount);
  assert.ok(rings.bandCount >= 4 && rings.bandCount <= 12, `macro cortical sheet count ${rings.bandCount}`);
  assert.ok(rings.coreRadius >= 20 && rings.coreRadius <= 40);
  assert.ok(rings.ellipseRatioMin > 1 && rings.ellipseRatioMax < 30, `open sheet aspect range ${rings.ellipseRatioMin}..${rings.ellipseRatioMax}`);
  assert.ok(rings.fitZoom > 0.4 && rings.fitZoom < 3);
  assert.equal(rings.pinnedNodeCount, rings.totalNodeCount);
  assert.ok(rings.maxRingPositionError < 0.001, `CORTEX positions must be pinned before paint: ${rings.maxRingPositionError}`);
  assert.ok(rings.totalNodeCount >= 1600);
  assert.equal(rings.radialJitterMax, rings.maxOffBandDistance);
  assert.equal(rings.visibleNodeCount, rings.totalNodeCount);
  assert.equal(rings.nodeCoverageRatio, 1, 'every cortical-sheet node must be painted');
  assert.ok(rings.activeLinkCount <= rings.visibleLinkCount);
}

function assertBrain3DContract(brain) {
  assert.deepEqual(Object.keys(brain).sort(), BRAIN3D_KEYS);
  assert.equal(brain.layout, 'connectome');
  assert.equal(brain.motion, true);
  assert.match(brain.positionDigest, /^[a-f0-9]{8}$/);
  assert.match(brain.corticalFieldDigest, /^[a-f0-9]{8}$/);
  assert.equal(brain.fogDensity, 0.00072);
  assert.equal(brain.bloomStrength, 0.2);
  assert.equal(brain.bloomRadius, 0.1);
  assert.equal(brain.bloomThreshold, 0.82);
  assert.equal(brain.navigationEnabled, true);
  assert.equal(brain.cameraMinDistance, 8);
  assert.equal(brain.cameraNear, 0.05);
  assert.equal(brain.brainInteriorRadius, 175);
  assert.ok(Array.isArray(brain.cameraPose) && brain.cameraPose.length === 6);
  assert.ok(brain.corticalMeshVertexCount > 5000);
  assert.ok(brain.neuronMorphologyCount >= 100);
  assert.ok(brain.cameraDistance > 0);
  assert.ok(brain.nodeValueBuckets <= 24, `3D node value buckets ${brain.nodeValueBuckets}`);
  assert.ok(brain.styleBuckets <= 8, `3D style buckets ${brain.styleBuckets}`);
  assert.equal(brain.batchedNodeCount, brain.sourceNodeCount, 'GPU point batch must contain every source neuron');
  assert.equal(brain.nodeCoverageRatio, 1, 'CONNECTOME point cloud must cover every source neuron');
  assert.ok(brain.visibleTractCoverageRatio >= 0.999, 'every connected neuron must have a pre-existing visible tract');
  assert.match(brain.liveSignalDigest, /^[a-f0-9]{8}$/);
  assert.ok(brain.interactiveNodeCount > 0 && brain.interactiveNodeCount < brain.sourceNodeCount, 'only semantic hubs should remain interactive sprites');
  assert.match(brain.batchedLinkDigest, /^[a-f0-9]{8}$/);
  assert.equal(
    Object.values(brain.visibleLinkTypeCounts).reduce((sum, count) => sum + count, 0),
    brain.batchedLinkCount,
    'batched link-type counts must cover the complete GPU tract sample',
  );
  assert.ok(brain.batchedLinkCount >= 5000, `batched whole-brain tract coverage ${brain.batchedLinkCount}`);
  assert.ok(brain.batchedLinkCount < brain.totalLinkCount, 'batched background remains a bounded GPU tract sample');
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
  const app = page.locator('[data-testid="asm-app"]');
  await app.waitFor();
  assert.equal(await app.getAttribute('data-preview'), 'true');
  assert.equal(await app.getAttribute('data-motion'), 'full');

  const viewTabs = page.locator('[data-testid="view-tabs"]');
  await viewTabs.waitFor();
  assert.equal(await viewTabs.getAttribute('role'), 'tablist');
  assert.equal(await page.locator('[data-testid="view-network"]').getAttribute('aria-selected'), 'true');
  assert.deepEqual(
    await page.locator('[role="tab"]').allTextContents(),
    ['CONNECTOME', 'MAP', 'CORTEX'],
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
  assert.equal(initialRings.visibleLinkCount, initialRings.totalLinkCount ?? initialRings.backgroundLinkCount);
  await page.waitForFunction(() => (window.__asm?.rings?.activeLinkCount ?? 0) > 0);
  const liveRings = await readRings(page);
  assertRingContract(liveRings);
  assert.equal(liveRings.selectedId, null, 'live cortical activity must not auto-select a node');
  assert.ok(liveRings.activeLinkCount > 0, 'demo activity must expose a live radial pathway');
  assert.ok(liveRings.visibleLinkCount >= liveRings.activeLinkCount);
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="live-flow-canvas"]')?.dataset.liveSegments) > 0);
  const initialRingDigest = liveRings.geometryDigest;
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/task5-rings-overview-1600x900.png', import.meta.url)) });

  // CORTEX uses the same Obsidian-style local physics as MAP: an unconnected
  // spatial neighbour must make room, linked neurons settle, and the camera
  // remains entirely user-owned throughout the transaction.
  await page.waitForFunction(() => window.__asm?.rings?.collisionProbe);
  const ringDragBefore = await page.evaluate(() => {
    const rings = window.__asm.rings;
    const probe = rings.collisionProbe;
    return {
      probe,
      camera: rings.cameraPose,
      target: rings.nodePosition(probe.targetId),
    };
  });
  await page.mouse.move(ringDragBefore.probe.source.x, ringDragBefore.probe.source.y);
  await page.waitForFunction(() => window.__asm?.rings?.hoveredId !== null);
  const ringDraggedId = await page.evaluate(() => window.__asm.rings.hoveredId);
  const ringActualProbe = await page.evaluate((id) => {
    const rings = window.__asm.rings;
    const probe = rings.collisionProbeFor(id);
    return { probe, target: rings.nodePosition(probe.targetId) };
  }, ringDraggedId);
  const ringVector = {
    x: ringActualProbe.probe.target.x - ringActualProbe.probe.source.x,
    y: ringActualProbe.probe.target.y - ringActualProbe.probe.source.y,
  };
  const ringVectorLength = Math.hypot(ringVector.x, ringVector.y) || 1;
  await page.mouse.down();
  await page.mouse.move(
    ringActualProbe.probe.target.x + ringVector.x / ringVectorLength * 42,
    ringActualProbe.probe.target.y + ringVector.y / ringVectorLength * 42,
    { steps: 24 },
  );
  await page.waitForFunction((id) => window.__asm?.rings?.draggingId === id, ringDraggedId);
  const ringDragDuring = await page.evaluate(() => ({
    collisions: window.__asm.rings.collisionCountTotal,
    relaxing: window.__asm.rings.relaxingNodeCount,
    running: window.__asm.rings.simulationRunning,
  }));
  await page.mouse.up();
  await page.waitForFunction(() => window.__asm?.rings?.simulationRunning === false, null, { timeout: 4000 });
  await page.waitForFunction(
    () => window.__asm?.rings?.backgroundRebuildPending === false && window.__asm?.rings?.deformedLinkCount === 0,
    null,
    { timeout: 8000 },
  );
  const ringDragAfter = await page.evaluate(({ targetId }) => ({
    camera: window.__asm.rings.cameraPose,
    target: window.__asm.rings.nodePosition(targetId),
    collisions: window.__asm.rings.collisionCountTotal,
  }), { targetId: ringActualProbe.probe.targetId });
  assert.ok(ringDragDuring.running && ringDragDuring.relaxing > 1);
  assert.ok(ringDragAfter.collisions > 0, 'CORTEX drag must resolve real soma collisions');
  assert.ok(
    Math.hypot(ringDragAfter.target.x - ringActualProbe.target.x, ringDragAfter.target.y - ringActualProbe.target.y) > 0.5,
    'an unconnected CORTEX neighbour must move out of the dragged soma path',
  );
  assert.ok(
    ringDragAfter.camera.every((value, index) => Math.abs(value - ringDragBefore.camera[index]) < 0.01),
    'CORTEX collision settling must not reframe the camera',
  );
  await page.locator('[data-testid="field-reset"]').click();
  await page.waitForFunction(({ id, x, y }) => {
    const position = window.__asm?.rings?.nodePosition?.(id);
    return position && Math.hypot(position.x - x, position.y - y) < 0.001;
  }, { id: ringActualProbe.probe.targetId, ...ringActualProbe.target });
  assertRingContract(await readRings(page));
  await page.locator('[data-testid="view-network"]').evaluate((element) => element.click());
  assert.equal(await app.getAttribute('data-view'), 'network');

  // The fixed header overlays the canvas. The wide atlas still has to reserve that
  // band while keeping every data neuron in the global background field.
  await page.waitForFunction(() => window.__asm?.network?.headerClippedNodeCount === 0, null, { timeout: 20000 })
    .catch(async () => {
      const stuck = await page.evaluate(() => window.__asm?.network?.headerClippedNodeCount);
      assert.fail(`network never framed clear of the header: ${stuck} somas still behind it`);
    });

  const initial = await readNetwork(page);
  assertDebugContract(initial);
  assert.equal(initial.focusSize, 0);
  assert.equal(initial.selectedId, null);
  assert.equal(initial.focusVisibleLinkCount, 0);
  const initialDigest = initial.positionDigest;
  const initialLiveDigest = initial.livePositionDigest;

  // A preview event is emitted every 1.8 seconds. It may light a neuron and its
  // axons, but it must not select/focus anything or alter the atlas coordinates.
  await page.waitForTimeout(2100);
  const liveNetwork = await readNetwork(page);
  assertDebugContract(liveNetwork);
  assert.equal(liveNetwork.selectedId, null, 'live MAP activity must not auto-select a node');
  assert.equal(liveNetwork.focusSize, 0, 'live MAP activity must not auto-focus a neighborhood');
  assert.equal(liveNetwork.livePositionDigest, initialLiveDigest, 'live MAP activity must not move the atlas');
  assert.ok(
    Number(await page.locator('[data-testid="live-flow-canvas"]').getAttribute('data-live-segments')) > 0,
    'the independent MAP overlay must actually paint live current',
  );

  // Exercise the full browser drag path, not only the pure solver. The nearby
  // node is deliberately unconnected so movement proves spatial collision and
  // reflow rather than the old weighted neighbour copy.
  await page.waitForFunction(() => window.__asm?.network?.collisionProbe);
  const mapDragBefore = await page.evaluate(() => {
    const network = window.__asm.network;
    const probe = network.collisionProbe;
    return {
      probe,
      camera: network.cameraPose,
      digest: network.livePositionDigest,
      target: network.nodePosition(probe.targetId),
    };
  });
  await page.evaluate(() => {
    window.__asmDragFrames = [];
    let previous = performance.now();
    const started = previous;
    const sample = (now) => {
      window.__asmDragFrames.push(now - previous);
      previous = now;
      if (now - started < 1800) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.move(mapDragBefore.probe.source.x, mapDragBefore.probe.source.y);
  await page.waitForTimeout(180);
  await page.mouse.down();
  await page.mouse.move(mapDragBefore.probe.target.x, mapDragBefore.probe.target.y, { steps: 24 });
  await page.waitForFunction((id) => window.__asm?.network?.draggingId === id, mapDragBefore.probe.sourceId);
  const mapDragDuring = await page.evaluate(() => ({
    collisions: window.__asm.network.collisionCountTotal,
    relaxing: window.__asm.network.relaxingNodeCount,
    running: window.__asm.network.simulationRunning,
  }));
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__asm.network.simulationRunning), true, 'MAP must visibly settle after release');
  await page.waitForFunction(() => window.__asm?.network?.simulationRunning === false, null, { timeout: 4000 });
  await page.waitForFunction(
    () => window.__asm?.network?.backgroundRebuildPending === false && window.__asm?.network?.deformedLinkCount === 0,
    null,
    { timeout: 8000 },
  );
  await page.waitForTimeout(250);
  const mapDragAfter = await page.evaluate(({ targetId }) => {
    const network = window.__asm.network;
    const frames = window.__asmDragFrames.slice(1).sort((a, b) => a - b);
    return {
      camera: network.cameraPose,
      digest: network.livePositionDigest,
      target: network.nodePosition(targetId),
      collisions: network.collisionCountTotal,
      p95: frames[Math.floor(frames.length * 0.95)],
    };
  }, { targetId: mapDragBefore.probe.targetId });
  assert.ok(mapDragDuring.running && mapDragDuring.relaxing > 1);
  assert.ok(mapDragAfter.collisions > 0, 'MAP drag must resolve real soma collisions');
  assert.notEqual(mapDragAfter.digest, mapDragBefore.digest, 'MAP positions must deform after a drag');
  assert.ok(
    Math.hypot(mapDragAfter.target.x - mapDragBefore.target.x, mapDragAfter.target.y - mapDragBefore.target.y) > 0.5,
    'an unconnected MAP neighbour must be displaced by collision',
  );
  assert.ok(
    mapDragAfter.camera.every((value, index) => Math.abs(value - mapDragBefore.camera[index]) < 0.01),
    'MAP collision settling must not move the camera',
  );
  assert.ok(mapDragAfter.p95 < 42, `MAP drag p95 frame interval ${mapDragAfter.p95}ms`);
  await page.locator('[data-testid="view-rings"]').click();
  await readRings(page);
  await page.locator('[data-testid="view-network"]').click();
  await readNetwork(page);
  const persistedMapTarget = await page.evaluate((id) => window.__asm.network.nodePosition(id), mapDragBefore.probe.targetId);
  assert.ok(
    Math.hypot(persistedMapTarget.x - mapDragAfter.target.x, persistedMapTarget.y - mapDragAfter.target.y) < 0.001,
    'MAP deformation must persist across view switches',
  );
  await page.locator('[data-testid="field-reset"]').click();
  await page.waitForFunction((digest) => window.__asm?.network?.livePositionDigest === digest, mapDragBefore.digest);

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
  await page.waitForFunction(() => (window.__asm?.network?.focusSize ?? 0) > 1);
  const focused = await readNetwork(page);
  assertDebugContract(focused);
  assert.ok(typeof focused.selectedId === 'string' && focused.selectedId.length > 0);
  assert.ok(focused.focusSize > 1, 'search selection should expose one-hop focus size');
  assert.ok(focused.focusVisibleLinkCount > 0, 'focus visible links should be non-zero');
  assert.ok(focused.focusVisibleLinkCount < focused.overviewVisibleLinkCount, 'focus should show fewer links than overview');
  await page.locator('[data-testid="view-rings"]').evaluate((element) => element.click());
  await page.waitForFunction(() => (window.__asm?.rings?.activeLinkCount ?? 0) > 0);
  const selectedRings = await readRings(page);
  assertRingContract(selectedRings);
  assert.equal(selectedRings.geometryDigest, initialRingDigest);
  assert.ok(typeof selectedRings.selectedId === 'string' && selectedRings.selectedId.length > 0);
  assert.equal(selectedRings.visibleLinkCount, selectedRings.backgroundLinkCount, 'selection must retain the full cortical background');
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
  await page.waitForFunction(() => window.__asm?.brain3d?.cameraPreset === 'left');
  await page.locator('[data-testid="camera-right"]').click();
  await page.waitForFunction(() => window.__asm?.brain3d?.cameraPreset === 'right');
  await page.locator('[data-testid="camera-whole"]').click();
  await page.waitForFunction(() => window.__asm?.brain3d?.cameraPreset === 'whole');
  await page.waitForFunction(() => window.__asm?.brain3d?.framingReady === true);
  const wholeBrain = await readBrain3D(page);
  assertBrain3DContract(wholeBrain);
  assert.equal(wholeBrain.selectedId, null);
  assert.equal(wholeBrain.focusSize, 0);
  assert.equal(wholeBrain.focusVisibleLinkCount, 0);
  assert.ok(wholeBrain.hoverTarget?.x > 0 && wholeBrain.hoverTarget?.y > 0);

  // CONNECTOME keeps the camera fixed while a bounded 3D collision field
  // reorganizes the real GPU soma/link buffers. This catches the historical
  // full-refresh/DragControls loop that made each mouse move take ~0.5s.
  await page.mouse.move(wholeBrain.hoverTarget.x, wholeBrain.hoverTarget.y);
  await page.waitForFunction(() => window.__asm?.brain3d?.hoveredId !== null);
  const brainDragBefore = await page.evaluate(() => {
    const brain = window.__asm.brain3d;
    const id = brain.hoveredId;
    return { id, camera: brain.cameraPose, position: brain.nodePosition(id) };
  });
  await page.evaluate(() => {
    window.__asmDragFrames3D = [];
    let previous = performance.now();
    const started = previous;
    const sample = (now) => {
      window.__asmDragFrames3D.push(now - previous);
      previous = now;
      if (now - started < 1800) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.down();
  await page.mouse.move(wholeBrain.hoverTarget.x + 82, wholeBrain.hoverTarget.y + 32, { steps: 24 });
  await page.waitForFunction((id) => window.__asm?.brain3d?.draggingId === id, brainDragBefore.id);
  const brainDragDuring = await page.evaluate(() => ({
    collisions: window.__asm.brain3d.collisionCountTotal,
    relaxing: window.__asm.brain3d.relaxingNodeCount,
    running: window.__asm.brain3d.simulationRunning,
  }));
  await page.mouse.up();
  await page.waitForFunction(() => window.__asm?.brain3d?.simulationRunning === false, null, { timeout: 3000 });
  await page.waitForTimeout(250);
  const brainDragAfter = await page.evaluate(({ id }) => {
    const brain = window.__asm.brain3d;
    const frames = window.__asmDragFrames3D.slice(1).sort((a, b) => a - b);
    return {
      camera: brain.cameraPose,
      position: brain.nodePosition(id),
      collisions: brain.collisionCountTotal,
      p95: frames[Math.floor(frames.length * 0.95)],
    };
  }, { id: brainDragBefore.id });
  assert.ok(brainDragDuring.running && brainDragDuring.relaxing > 1);
  assert.ok(brainDragAfter.collisions > 0, 'CONNECTOME drag must resolve real 3D soma collisions');
  assert.ok(
    Math.hypot(
      brainDragAfter.position.x - brainDragBefore.position.x,
      brainDragAfter.position.y - brainDragBefore.position.y,
      brainDragAfter.position.z - brainDragBefore.position.z,
    ) > 1,
    'CONNECTOME neuron must retain its user deformation',
  );
  assert.ok(
    brainDragAfter.camera.every((value, index) => Math.abs(value - brainDragBefore.camera[index]) < 0.01),
    'CONNECTOME settling must not move the camera',
  );
  assert.ok(brainDragAfter.p95 < 50, `CONNECTOME drag p95 frame interval ${brainDragAfter.p95}ms`);
  await page.locator('[data-testid="view-network"]').click();
  await readNetwork(page);
  await page.locator('[data-testid="view-3d"]').click();
  await page.waitForFunction(() => window.__asm?.brain3d?.framingReady === true);
  const persistedBrainPosition = await page.evaluate((id) => window.__asm.brain3d.nodePosition(id), brainDragBefore.id);
  assert.ok(
    Math.hypot(
      persistedBrainPosition.x - brainDragAfter.position.x,
      persistedBrainPosition.y - brainDragAfter.position.y,
      persistedBrainPosition.z - brainDragAfter.position.z,
    ) < 0.001,
    'CONNECTOME deformation must persist across view switches',
  );
  await page.locator('[data-testid="field-reset"]').click();
  await page.waitForFunction(({ id, position }) => {
    const current = window.__asm?.brain3d?.nodePosition?.(id);
    return current && Math.hypot(
      current.x - position.x,
      current.y - position.y,
      current.z - position.z,
    ) < 0.001;
  }, { id: brainDragBefore.id, position: brainDragBefore.position });
  await page.waitForFunction(() => window.__asm?.brain3d?.framingReady === true);
  const preLiveDistance = wholeBrain.cameraDistance;
  await page.waitForTimeout(2100);
  const liveBrain = await readBrain3D(page);
  assertBrain3DContract(liveBrain);
  assert.equal(liveBrain.selectedId, null, 'live CONNECTOME activity must not auto-select a neuron');
  assert.equal(liveBrain.focusSize, 0, 'live CONNECTOME activity must not auto-focus a neighborhood');
  assert.ok(Math.abs(liveBrain.cameraDistance - preLiveDistance) < 0.5, 'live CONNECTOME activity must not move the camera');
  assert.ok(liveBrain.liveSignalNodeCount > 0, 'live CONNECTOME activity must light a source neuron');
  assert.ok(liveBrain.liveSignalAgentCount >= 2, 'parallel preview agents must retain separate live signal lanes');
  assert.ok(liveBrain.liveSignalSegmentCount >= 4, 'live CONNECTOME activity must expose an actual graph route');
  assert.ok(
    liveBrain.liveSignalBeadCount >= liveBrain.liveSignalSegmentCount * 3,
    'every live route segment must carry a visible moving head and trail',
  );
  assert.ok(
    liveBrain.cameraPose.every((value, index) => Math.abs(value - wholeBrain.cameraPose[index]) < 0.05),
    'live CONNECTOME activity must preserve the complete camera pose',
  );
  const traceAgents = new Set(await page.locator('[data-testid="live-trace"] .live-agent').allTextContents());
  assert.ok(traceAgents.has('Codex'), 'fair live trace must retain Codex while another agent is busy');
  assert.ok(traceAgents.has('Claude Code'), 'fair live trace must retain Claude while Codex is busy');
  const claudeTraceColor = await page.locator('[data-testid="live-trace"] .live-trace-row')
    .filter({ hasText: 'Claude Code' })
    .first()
    .evaluate((row) => getComputedStyle(row).borderInlineStartColor);
  assert.equal(claudeTraceColor, 'rgba(105, 204, 160, 0.8)', 'Claude must keep the shared system-green identity');
  const traceFiles = await page.locator('[data-testid="live-trace"] .live-file').evaluateAll((nodes) => nodes.map((node) => ({
    path: node.getAttribute('title'),
    text: node.textContent,
    width: node.getBoundingClientRect().width,
    fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
  })));
  assert.ok(traceFiles.length >= 2, 'the live trace must expose a visible multi-file ledger');
  assert.ok(traceFiles.every((file) => file.path?.includes('demo/') && file.text?.includes('demo/')), JSON.stringify(traceFiles));
  assert.ok(traceFiles.every((file) => file.width >= 110 && file.fontSize >= 10), JSON.stringify(traceFiles));
  await page.locator('[data-testid="live-trace-toggle"]').click();
  assert.ok((await page.locator('[data-testid="live-trace"]').getAttribute('class'))?.includes('collapsed'));
  assert.equal(await page.locator('[data-testid="live-trace"] .live-trace-row:visible').count(), 0);
  await page.locator('[data-testid="live-trace-toggle"]').click();
  assert.ok(!(await page.locator('[data-testid="live-trace"]').getAttribute('class'))?.includes('collapsed'));
  const preHoverDistance = wholeBrain.cameraDistance;
  await page.mouse.move(wholeBrain.hoverTarget.x, wholeBrain.hoverTarget.y);
  await page.waitForFunction(() => window.__asm?.brain3d?.hoveredId !== null);
  await page.waitForTimeout(450);
  const hoveredBrain = await readBrain3D(page);
  assert.equal(hoveredBrain.focusSize, 0, 'hover must not rebuild the focus subgraph');
  assert.ok(Math.abs(hoveredBrain.cameraDistance - preHoverDistance) < 0.5, 'hover must not move the camera');
  await page.mouse.move(40, 400);
  for (let step = 0; step < 9; step++) {
    await page.locator('[data-testid="camera-zoom-in"]').click();
    await page.waitForTimeout(260);
  }
  await page.waitForFunction(() => window.__asm?.brain3d?.cameraDistance < 60);
  const zoomedBrain = await readBrain3D(page);
  assert.ok(zoomedBrain.cameraDistance < 60, 'repeated zoom must reach the deep connectome interior');
  assert.equal(zoomedBrain.insideBrain, true, 'deep zoom must expose the brain from inside');
  assert.ok(zoomedBrain.cameraMinDistance <= 8, 'OrbitControls must not clamp the camera at the former 105-unit shell');
  await page.waitForTimeout(450);
  const stableInterior = await readBrain3D(page);
  assert.ok(stableInterior.cameraDistance < 61, 'the interior camera must not snap back to the outside frame');
  await page.locator('[data-testid="camera-whole"]').click();
  await page.waitForFunction(() => window.__asm?.brain3d?.cameraPreset === 'whole');
  await page.waitForTimeout(4500);
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/task6-3d-whole-1600x900.png', import.meta.url)) });

  await page.locator('[data-testid="search-input"]').fill('זיכרון 001');
  await page.locator('[data-testid="search-input"]').press('Enter');
  await page.locator('[data-testid="inspector"]').waitFor();
  await page.waitForFunction(() => (window.__asm?.brain3d?.focusSize ?? 0) > 1);
  await page.locator('[data-testid="camera-selected"]').click();
  await page.waitForFunction(() => window.__asm?.brain3d?.cameraPreset === 'selected');
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
  assert.ok(frameStats.median < 42, JSON.stringify(frameStats));

  const secondaryRequests = [];
  const secondaryErrors = [];
  const secondaryFailedResponses = [];
  const responsiveResults = [];

  // Hold the preview stream until the user has established a free 2D camera.
  // One unmatched event then exercises the structural graph merge that used to
  // paint MAP coordinates inside CORTEX for ~250ms and auto-fit twice.
  const cortexPage = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  cortexPage.on('request', (request) => secondaryRequests.push(request.url()));
  cortexPage.on('response', (response) => response.status() >= 400 && secondaryFailedResponses.push(`${response.status()} ${response.url()}`));
  cortexPage.on('pageerror', (error) => secondaryErrors.push(error.message));
  cortexPage.on('console', (message) => message.type() === 'error' && secondaryErrors.push(message.text()));
  await cortexPage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  let heldCortexEvents;
  let resolveCortexEvents;
  const cortexEventsRequested = new Promise((resolve) => { resolveCortexEvents = resolve; });
  await cortexPage.route('**/demo/events.json', (route) => {
    heldCortexEvents = route;
    resolveCortexEvents();
  });
  await cortexPage.goto(`${ORIGIN}/?mode=2d`, { waitUntil: 'domcontentloaded' });
  await cortexEventsRequested;
  const cortexApp = cortexPage.locator('[data-testid="asm-app"]');
  await cortexApp.waitFor();
  await cortexPage.locator('[data-testid="view-rings"]').click();
  const cortexBeforeZoom = await readRings(cortexPage);
  assertRingContract(cortexBeforeZoom);
  for (let step = 0; step < 3; step++) {
    await cortexPage.locator('[data-testid="map-zoom-in"]').click();
    await cortexPage.waitForTimeout(240);
  }
  await cortexPage.waitForTimeout(320);
  const cortexBaseline = await readRings(cortexPage);
  await cortexPage.evaluate(() => { window.__asmRegressionCanvas = document.querySelector('.force-graph-container canvas'); });
  await heldCortexEvents.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{
      ts: 0,
      tool: 'Edit',
      cwd: 'demo/cortex-regression',
      session: 'cortex-regression',
      agent: 'Claude Code',
      path: '/virtual/cortex-regression.ts',
      node_id: 'unmatched:cortex-regression:file',
      matched: false,
      layer: 'ephemeral',
      label: 'cortex-regression.ts',
    }]),
  });
  const cortexRegression = await cortexPage.evaluate(async ({ baselinePose, baselineTotal }) => {
    const result = {
      canvasChanged: false,
      maxPoseDelta: 0,
      maxRingPositionError: 0,
      maxTotalNodeCount: baselineTotal,
      missingRingDebug: false,
      viewChanged: false,
    };
    const start = performance.now();
    await new Promise((resolve) => {
      const sample = (now) => {
        const rings = window.__asm?.rings;
        result.canvasChanged ||= document.querySelector('.force-graph-container canvas') !== window.__asmRegressionCanvas;
        result.viewChanged ||= document.querySelector('[data-testid="asm-app"]')?.getAttribute('data-view') !== 'rings';
        result.missingRingDebug ||= !rings;
        if (rings) {
          result.maxTotalNodeCount = Math.max(result.maxTotalNodeCount, Number(rings.totalNodeCount));
          result.maxRingPositionError = Math.max(result.maxRingPositionError, Number(rings.maxRingPositionError));
          const pose = rings.cameraPose;
          if (Array.isArray(pose)) {
            result.maxPoseDelta = Math.max(
              result.maxPoseDelta,
              ...pose.map((value, index) => Math.abs(value - baselinePose[index])),
            );
          }
        }
        if (now - start >= 3900) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return result;
  }, { baselinePose: cortexBaseline.cameraPose, baselineTotal: cortexBaseline.totalNodeCount });
  assert.equal(cortexRegression.canvasChanged, false, 'CORTEX must retain one canvas during a live structural merge');
  assert.equal(cortexRegression.viewChanged, false, 'live activity must never change the selected view');
  assert.equal(cortexRegression.missingRingDebug, false, 'CORTEX must never fall through to a MAP initialization gap');
  assert.ok(cortexRegression.maxTotalNodeCount >= cortexBaseline.totalNodeCount + 2, JSON.stringify(cortexRegression));
  assert.ok(cortexRegression.maxRingPositionError < 0.001, JSON.stringify(cortexRegression));
  assert.ok(cortexRegression.maxPoseDelta < 0.05, `live CORTEX merge moved the free camera: ${JSON.stringify(cortexRegression)}`);
  const liveCortex = await readRings(cortexPage);
  assert.ok(liveCortex.liveSignalSegmentCount > 0, 'CORTEX must render the common graph route');
  await cortexPage.locator('[data-testid="view-network"]').click();
  const parityMap = await readNetwork(cortexPage);
  assert.equal(parityMap.liveSignalDigest, liveCortex.liveSignalDigest, 'MAP and CORTEX must project the same live topology');
  assert.equal(parityMap.liveSignalSegmentCount, liveCortex.liveSignalSegmentCount);
  await cortexPage.locator('[data-testid="view-3d"]').click();
  const parityBrain = await readBrain3D(cortexPage);
  assert.equal(parityBrain.liveSignalDigest, liveCortex.liveSignalDigest, 'all three views must share one live topology');
  assert.equal(parityBrain.liveSignalSegmentCount, liveCortex.liveSignalSegmentCount);
  await cortexPage.close();

  // The 3D regression uses a separate held unmatched event so the graph identity
  // changes only after the user has zoomed and orbited away from the preset.
  const freeCameraPage = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  freeCameraPage.on('request', (request) => secondaryRequests.push(request.url()));
  freeCameraPage.on('response', (response) => response.status() >= 400 && secondaryFailedResponses.push(`${response.status()} ${response.url()}`));
  freeCameraPage.on('pageerror', (error) => secondaryErrors.push(error.message));
  freeCameraPage.on('console', (message) => message.type() === 'error' && secondaryErrors.push(message.text()));
  await freeCameraPage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  let heldCameraEvents;
  let resolveCameraEvents;
  const cameraEventsRequested = new Promise((resolve) => { resolveCameraEvents = resolve; });
  await freeCameraPage.route('**/demo/events.json', (route) => {
    heldCameraEvents = route;
    resolveCameraEvents();
  });
  await freeCameraPage.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await cameraEventsRequested;
  await freeCameraPage.locator('[data-testid="asm-app"]').waitFor();
  await freeCameraPage.waitForFunction(() => window.__asm?.brain3d?.framingReady === true);
  for (let step = 0; step < 5; step++) {
    await freeCameraPage.locator('[data-testid="camera-zoom-in"]').click();
    await freeCameraPage.waitForTimeout(240);
  }
  const freeCanvas = freeCameraPage.locator('canvas').first();
  const freeCanvasBox = await freeCanvas.boundingBox();
  assert.ok(freeCanvasBox);
  await freeCameraPage.mouse.move(freeCanvasBox.x + 56, freeCanvasBox.y + freeCanvasBox.height - 92);
  await freeCameraPage.mouse.down();
  await freeCameraPage.mouse.move(freeCanvasBox.x + 138, freeCanvasBox.y + freeCanvasBox.height - 128, { steps: 8 });
  await freeCameraPage.mouse.up();
  await freeCameraPage.waitForTimeout(700);
  const freeCameraBaseline = await readBrain3D(freeCameraPage);
  await freeCameraPage.evaluate(() => { window.__asmRegressionCanvas = document.querySelector('canvas'); });
  await heldCameraEvents.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{
      ts: 0,
      tool: 'Edit',
      cwd: 'demo/camera-regression',
      session: 'camera-regression',
      agent: 'Codex',
      path: '/virtual/camera-regression.ts',
      node_id: 'unmatched:camera-regression:file',
      matched: false,
      layer: 'ephemeral',
      label: 'camera-regression.ts',
    }]),
  });
  await freeCameraPage.waitForFunction(
    (before) => (window.__asm?.brain3d?.sourceNodeCount ?? 0) >= before + 2,
    freeCameraBaseline.sourceNodeCount,
    { timeout: 6000 },
  );
  await freeCameraPage.waitForTimeout(1150);
  const freeCameraAfter = await readBrain3D(freeCameraPage);
  assert.equal(
    await freeCameraPage.evaluate(() => document.querySelector('canvas') === window.__asmRegressionCanvas),
    true,
    'live graph merge must retain the 3D canvas',
  );
  assert.ok(
    freeCameraAfter.cameraPose.every((value, index) => Math.abs(value - freeCameraBaseline.cameraPose[index]) < 0.05),
    `unmatched live activity reframed the free camera: ${JSON.stringify({ before: freeCameraBaseline.cameraPose, after: freeCameraAfter.cameraPose })}`,
  );
  assert.equal(freeCameraAfter.selectedId, freeCameraBaseline.selectedId);
  assert.equal(freeCameraAfter.focusSize, freeCameraBaseline.focusSize);
  assert.ok(freeCameraAfter.liveSignalSegmentCount > 0, 'the camera must stay fixed while the new live route renders');
  await freeCameraPage.close();

  for (const [width, height] of [[1600, 900], [1100, 800], [860, 780]]) {
    const responsivePage = await browser.newPage({ viewport: { width, height } });
    responsivePage.on('request', (request) => secondaryRequests.push(request.url()));
    responsivePage.on('response', (response) => response.status() >= 400 && secondaryFailedResponses.push(`${response.status()} ${response.url()}`));
    responsivePage.on('pageerror', (error) => secondaryErrors.push(error.message));
    responsivePage.on('console', (message) => message.type() === 'error' && secondaryErrors.push(message.text()));
    await responsivePage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
    await responsivePage.goto(`${ORIGIN}/?mode=2d`, { waitUntil: 'networkidle' });
    const responsiveApp = responsivePage.locator('[data-testid="asm-app"]');
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

  const compactPage = await browser.newPage({ viewport: { width: 320, height: 720 } });
  compactPage.on('request', (request) => secondaryRequests.push(request.url()));
  compactPage.on('response', (response) => response.status() >= 400 && secondaryFailedResponses.push(`${response.status()} ${response.url()}`));
  compactPage.on('pageerror', (error) => secondaryErrors.push(error.message));
  compactPage.on('console', (message) => message.type() === 'error' && secondaryErrors.push(message.text()));
  await compactPage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  await compactPage.goto(`${ORIGIN}/?mode=2d`, { waitUntil: 'networkidle' });
  const compactToggle = compactPage.locator('[data-testid="live-trace-toggle"]');
  await compactToggle.click();
  const compactGeometry = await compactPage.evaluate(() => {
    const panelRect = document.querySelector('[data-testid="live-trace"]')?.getBoundingClientRect();
    const toggleRect = document.querySelector('[data-testid="live-trace-toggle"]')?.getBoundingClientRect();
    const values = (rect) => rect ? {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    } : null;
    return { panel: values(panelRect), toggle: values(toggleRect), width: innerWidth };
  });
  assert.ok(compactGeometry.panel && compactGeometry.toggle, JSON.stringify(compactGeometry));
  assert.ok(compactGeometry.toggle.width > 20 && compactGeometry.toggle.height >= 15, JSON.stringify(compactGeometry));
  assert.ok(compactGeometry.toggle.left >= compactGeometry.panel.left, JSON.stringify(compactGeometry));
  assert.ok(compactGeometry.toggle.right <= compactGeometry.panel.right, JSON.stringify(compactGeometry));
  assert.ok(compactGeometry.toggle.top >= compactGeometry.panel.top, JSON.stringify(compactGeometry));
  assert.ok(compactGeometry.toggle.bottom <= compactGeometry.panel.bottom, JSON.stringify(compactGeometry));
  assert.ok(compactGeometry.toggle.right <= compactGeometry.width, JSON.stringify(compactGeometry));
  await compactToggle.click();
  assert.ok(!(await compactPage.locator('[data-testid="live-trace"]').getAttribute('class'))?.includes('collapsed'));
  await compactPage.close();

  const framingPage = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  framingPage.on('request', (request) => secondaryRequests.push(request.url()));
  framingPage.on('response', (response) => response.status() >= 400 && secondaryFailedResponses.push(`${response.status()} ${response.url()}`));
  framingPage.on('pageerror', (error) => secondaryErrors.push(error.message));
  framingPage.on('console', (message) => message.type() === 'error' && secondaryErrors.push(message.text()));
  await framingPage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  await framingPage.goto(`${ORIGIN}/?mode=2d`, { waitUntil: 'networkidle' });
  await framingPage.locator('[data-testid="asm-app"]').waitFor();
  await framingPage.locator('[data-testid="view-3d"]').evaluate((element) => element.click());
  await framingPage.waitForFunction(() => window.__asm?.brain3d?.layout === 'connectome');
  await framingPage.locator('[data-testid="camera-whole"]').evaluate((element) => element.click());
  await framingPage.waitForFunction(() => window.__asm?.brain3d?.framingReady === true);
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
  const reducedApp = reducedPage.locator('[data-testid="asm-app"]');
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
  await reducedPage.waitForFunction(() => window.__asm?.brain3d?.layout === 'connectome');
  await reducedPage.waitForFunction(() => window.__asm?.brain3d?.framingReady === true);
  const reducedBrain = await reducedPage.evaluate(() => window.__asm.brain3d);
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
