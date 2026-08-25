import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [app, brain, brain2d, brain3d, css, shot, html, feed, liveActivity, useLive, liveBatch, livePalette] = await Promise.all([
  readFile(new URL('src/App.tsx', root), 'utf8'),
  readFile(new URL('src/Brain.tsx', root), 'utf8'),
  readFile(new URL('src/Brain2D.tsx', root), 'utf8'),
  readFile(new URL('src/brain3d.ts', root), 'utf8'),
  readFile(new URL('src/asm.css', root), 'utf8'),
  readFile(new URL('asm-shot.mjs', root), 'utf8'),
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('src/Feed.tsx', root), 'utf8'),
  readFile(new URL('src/liveActivity.ts', root), 'utf8'),
  readFile(new URL('src/useLive.ts', root), 'utf8'),
  readFile(new URL('src/liveBatch.ts', root), 'utf8'),
  readFile(new URL('src/liveAgentPalette.ts', root), 'utf8'),
]);

test('App exposes a media-query-backed motion contract to both renderers', () => {
  assert.match(app, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(app, /data-motion=\{reduceMotion \? 'reduced' : 'full'\}/);
  assert.ok((app.match(/motionEnabled=\{!reduceMotion\}/g) ?? []).length >= 2, 'both renderers must receive motionEnabled');
});

test('CONNECTOME hover cannot rebuild the focus graph or retrigger camera framing', () => {
  assert.match(brain, /const focusId = selected\?\.id \?\? null;/);
  assert.doesNotMatch(brain, /const focusId = selected\?\.id \?\? hovered\?\.id/);
});

test('live events repaint activity without selecting, focusing, or navigating', () => {
  const start = app.indexOf('const handleEvents = useCallback');
  const end = app.indexOf('useLive(handleEvents', start);
  assert.ok(start >= 0 && end > start, 'live event handler must remain statically inspectable');
  const handler = app.slice(start, end);
  assert.match(handler, /setActivityRevision/);
  assert.doesNotMatch(handler, /setSelected|setHovered|setCameraPreset|\bfly\s*\(/);
});

test('MAP and CORTEX paint every node and data link independently from pointer LOD', () => {
  const drawNodeStart = brain2d.indexOf('const drawNode = useCallback');
  const drawNodeEnd = brain2d.indexOf('const drawBackgroundLinks = useCallback', drawNodeStart);
  assert.ok(drawNodeStart >= 0 && drawNodeEnd > drawNodeStart, '2D draw path must remain statically inspectable');
  const drawNode = brain2d.slice(drawNodeStart, drawNodeEnd);
  assert.doesNotMatch(drawNode, /if\s*\(\s*!nodeIsInteractive/, 'pointer LOD must never hide painted neurons');
  assert.match(drawNode, /ctx\.arc\(n\.x!, n\.y!, microRadius/);
  assert.match(brain2d, /const canvasGraph = useMemo\(\(\) => \(\{ nodes: graph\.nodes, links: \[\] \}\)/);
  assert.match(brain2d, /const drawBackgroundLinks = useCallback/);
  assert.match(brain2d, /layout: 'neural-atlas'/);
  assert.match(brain2d, /layout: 'cortical-sheet'/);
  assert.match(brain2d, /nodeCoverageRatio:/);
  assert.match(brain2d, /visibleLinkCount: backgroundLinkCount/);
});

test('CONNECTOME batches whole-brain node coverage and keeps every hierarchy tract visible', () => {
  assert.match(brain3d, /CONNECTOME_LINK_BUDGETS\s*=\s*\{[\s\S]*contains:\s*22000[\s\S]*code:\s*2000[\s\S]*link:\s*2000[\s\S]*xlayer:\s*1000/);
  assert.match(brain, /asm-data-neurons-all/);
  assert.match(brain, /asm-data-synapses-\$\{type\}/);
  assert.match(brain, /batchedNodeCount:\s*batchedConnectome\.nodeIndex\.size/);
  assert.match(brain, /batchedLinkCount:\s*batchedConnectome\.links\.length/);
  assert.match(brain, /nodeCoverageRatio:\s*graph\.nodes\.length\s*\?\s*batchedConnectome\.nodeIndex\.size\s*\/\s*graph\.nodes\.length\s*:\s*1/);
});

test('CONNECTOME has no animated whole-brain wave shader', () => {
  assert.doesNotMatch(brain, /uniform float uTime|shaderTimer|float impulse/);
  assert.match(brain, /asm-neuron-synapses/);
});

test('CONNECTOME live tracking is a local graph signal rendered above the pointer LOD', () => {
  assert.match(brain3d, /export function buildLiveSignalSegments3D/);
  assert.match(brain, /buildLiveSignalSegments3D\(\s*graph/);
  assert.match(brain, /const liveRouteLinks = graph\.links/);
  assert.match(brain, /new LineSegments2\(liveRouteGeometry, liveRouteMaterial\)/);
  assert.match(brain, /new LineSegments2\(liveRouteGeometry, liveRouteGlowMaterial\)/);
  assert.match(brain, /asm-live-signal-soma-halos/);
  assert.match(brain, /asm-live-signal-routes/);
  assert.match(brain, /asm-live-signal-heads/);
  assert.match(brain, /asm-live-signal-trails/);
  const liveLayer = brain.slice(
    brain.indexOf('const liveSomaPositions'),
    brain.indexOf('const fieldGeometry'),
  );
  assert.ok((liveLayer.match(/depthTest:\s*false/g) ?? []).length >= 4);
  assert.ok((liveLayer.match(/depthWrite:\s*false/g) ?? []).length >= 4);
  assert.ok((liveLayer.match(/frustumCulled\s*=\s*false/g) ?? []).length >= 6);
  assert.match(brain, /flow\.routeGeometry\.instanceCount = visibleSegments\.length/);
});

test('live structural graph updates cannot reframe a user-controlled 3D camera', () => {
  assert.match(brain, /fitCameraToViewportRef\.current\(transition\)/);
  assert.match(brain, /\}, \[cameraPreset, graphInstance, motionEnabled\]\);/);
  assert.doesNotMatch(brain, /\[cameraPreset,[^\]]*fitCameraToViewport[^\]]*graph\.nodes\.length/);
});

test('MAP and CORTEX project one shared graph-route signal without synthetic event trails', () => {
  assert.match(brain2d, /buildLiveSignalSegments3D\(/);
  assert.match(brain2d, /digestLiveSignalSegments3D/);
  assert.match(brain2d, /activeAgents:\s*Map<string, string>/);
  assert.match(brain2d, /liveSignalDigest/);
  assert.match(brain2d, /const liveRouteLinks = graph\.links/);
  assert.match(brain, /const liveRouteLinks = graph\.links/);
  assert.doesNotMatch(brain, /const visibleSignalTracts = batchedConnectome\.links/);
  assert.match(brain2d, /className="live-flow-canvas"/);
  assert.match(brain2d, /graph2ScreenCoords/);
  assert.match(brain2d, /requestAnimationFrame\(paint\)/);
  assert.doesNotMatch(brain2d, /time - lastPaint >= 84/);
  assert.doesNotMatch(brain2d, /TRAIL_TTL|for \(const e of trail\)|Math\.sin\(now \/ 520\)/);
});

test('CORTEX coordinates are pinned before graphData is committed and data-only updates do not fit', () => {
  assert.match(brain2d, /const prepared = useMemo\([\s\S]*applyCorticalRingPins\(graph\.nodes, rings\)/);
  assert.match(brain2d, /const shouldFrame = initializedLayoutRef\.current !== layout/);
  assert.match(brain2d, /if \(shouldFrame\) fitToSafeArea/);
  assert.doesNotMatch(brain2d, /setTimeout\([\s\S]{0,180}applyCorticalRingPins/);
});

test('CONNECTOME permits deep interior navigation without cursor-directed focus', () => {
  assert.match(brain, /const CAMERA_MIN_DISTANCE = 8/);
  assert.match(brain, /camera\.near = 0\.05/);
  assert.match(brain, /controls\.minDistance = CAMERA_MIN_DISTANCE/);
  assert.match(brain, /controls\.zoomToCursor = false/);
  assert.match(brain, /side:\s*FrontSide/);
});

test('live file trace is persistent and keeps a multi-file sequence', () => {
  assert.match(app, /LIVE FILE ACCESS/);
  assert.match(liveActivity, /export function fairFileActivity/);
  assert.match(liveActivity, /export function isFileAccessEvent/);
  assert.match(app, /fairFileActivity\(recent, 12\)/);
  assert.match(app, /reserved lane per agent/);
  assert.match(app, /agent-\$\{agentLane\(event\.agent\)\}/);
  assert.match(app, /borderInlineStartColor:\s*liveAgentPalette\(event\.agent\)\.trace/);
  assert.match(app, /className=\{count > 1 \? 'live-repeat active'/);
  assert.match(app, /title=\{event\.path\}>\{liveFilePath\(event\)\}/);
  assert.match(feed, /\{liveFilePath\(e\)\}/);
  assert.doesNotMatch(feed, /slice\(0, 80\)/);
  assert.doesNotMatch(app, /\{currentActivity\.length \? \(\s*<section/);
  assert.match(css, /\.live-trace-empty/);
  assert.match(livePalette, /claude:[\s\S]*soma:\s*'#8fe0b5'[\s\S]*route:\s*'#56ad85'/);
  assert.doesNotMatch(livePalette, /#d7a8c0|#9f6b86|#f3d5e3|#c789a6/);
});

test('WebSocket file activity is losslessly coalesced before React rendering', () => {
  assert.match(liveBatch, /LIVE_BATCH_WINDOW_MS = 80/);
  assert.match(liveBatch, /pending\.push\(\.\.\.items\)/);
  assert.match(liveBatch, /setTimeout\(flush, delay\)/);
  assert.match(liveBatch, /pending = \[\]/);
  assert.match(useLive, /createLiveBatcher<LiveEvent>/);
  const messageHandler = useLive.slice(useLive.indexOf('ws.onmessage'), useLive.indexOf('ws.onclose'));
  assert.match(messageHandler, /batcher\.enqueue\(evs\)/);
  assert.doesNotMatch(messageHandler, /cbRef\.current\(evs\)/);
});

test('live snapshot waits for graph indexes and stale signal refs are reclaimed', () => {
  assert.match(app, /useLive\(handleEvents, setWsUp, !STATIC_PREVIEW && Boolean\(data\)\)/);
  assert.match(app, /pruneExpiredLiveState\(now, activeRef\.current, activeAgentsRef\.current, activeSourcesRef\.current\)/);
  assert.match(liveActivity, /export function pruneExpiredLiveState/);
  assert.match(brain, /pruneLiveSignalTimings\(startedAt, liveStartRef\.current, liveExpiryRef\.current\)/);
  assert.match(brain, /liveStartRef\.current\.clear\(\);[\s\S]{0,80}liveExpiryRef\.current\.clear\(\)/);
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
