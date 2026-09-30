import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [app, brain, brain2d, brain3d, css, shot, html, feed, liveActivity, useLive, liveBatch, livePalette, deck, roster] = await Promise.all([
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
  readFile(new URL('src/LiveDeck.tsx', root), 'utf8'),
  readFile(new URL('src/liveRoster.ts', root), 'utf8'),
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

  // The sprite is viewport-bounded, the painting is not: a node outside the view
  // still gets its micro dot, so culling can never remove a neuron from the map.
  assert.match(brain2d, /const nearView = !view/);
  assert.match(brain2d, /const detailed = \(nearView && \(scale >= 2\.35/);
  assert.match(brain2d, /visibleRectRef\.current = null;\s*\/\/ no transform to read/);
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

test('CONNECTOME can be flown through, not merely approached', () => {
  assert.match(brain, /const CAMERA_MIN_DISTANCE = 1\.2/);
  assert.match(brain, /camera\.near = 0\.05/);
  assert.match(brain, /controls\.minDistance = CAMERA_MIN_DISTANCE/);
  assert.match(brain, /side:\s*FrontSide/);

  // A dolly can only approach its target, so any floor is a wall you hit and
  // the interior freezes there. Inside the shell the wheel translates the camera
  // along its view direction and carries the pivot with it — no floor exists.
  assert.match(brain, /const INTERIOR_PIVOT_DISTANCE = 45/);
  assert.match(brain, /camera\.position\.addScaledVector\(forward, event\.deltaY < 0 \? magnitude : -magnitude\)/);
  assert.match(brain, /controls\.target\.copy\(camera\.position\)\.addScaledVector\(forward, INTERIOR_PIVOT_DISTANCE\)/);
  assert.match(brain, /host\.addEventListener\('wheel', onWheel, \{ passive: false, capture: true \}\)/);
  // Leaving the shell must not hand the dolly a pivot stranded in open space.
  assert.match(brain, /controls\.target\.set\(0, 0, 0\)/);

  // Outside, the wheel steers at what you aimed at instead of converging on one
  // fixed point forever. This was off because zoom-to-cursor fed a hover handler
  // that rebuilt focus and reframed the camera; hover is visual-only now.
  assert.match(brain, /controls\.zoomToCursor = true/);
  assert.match(brain, /const focusId = selected\?\.id \?\? null;/);

  assert.match(app, /SCROLL FLIES IN · DRAG LOOKS AROUND · RIGHT-DRAG PANS/);
});

test('live file trace is persistent and keeps a multi-file sequence', () => {
  assert.match(liveActivity, /export function laneFileActivity/);
  assert.match(liveActivity, /export function isFileAccessEvent/);
  assert.match(deck, /laneFileActivity\(windowed, FILES_PER_AGENT\)/);
  assert.match(deck, /className=\{count > 1 \? 'live-repeat active num'/);
  assert.match(deck, /title=\{event\.path\}>\{liveFilePath\(event\)\}/);
  assert.match(deck, /agent-\$\{agent\.lane\}/);
  assert.match(deck, /liveAgentPalette\(agent\.agent\)\.trace/);
  assert.match(feed, /\{liveFilePath\(e\)\}/);
  assert.doesNotMatch(feed, /slice\(0, 80\)/);
  assert.match(css, /\.live-trace-empty/);
  assert.match(livePalette, /claude:[\s\S]*soma:\s*'#8fe0b5'[\s\S]*route:\s*'#56ad85'/);
  assert.doesNotMatch(livePalette, /#d7a8c0|#9f6b86|#f3d5e3|#c789a6/);
});

test('one roster answers "how many agents", and every claim carries its age', () => {
  // The strip and the trace header are rendered by one component from one clock.
  // Two independent readings a screen apart is the defect this replaced.
  assert.match(deck, /const agentsReading = connected \? `\$\{liveCount\}\/\$\{roster\.length\}` : '—'/);
  assert.ok((deck.match(/\{agentsReading\}/g) ?? []).length >= 2, 'strip and trace must print the same reading');
  assert.doesNotMatch(app, /ACTIVE_AGENT_MS|agentSeenRef|currentAgentCount/);
  assert.match(app, /recordSightings\(normalizedEvents, sightingsRef\.current, now\)/);

  // An age on every row, refreshed every second — a row with no age is a row
  // claiming to be happening now.
  assert.match(deck, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
  assert.match(deck, /\{formatAge\(agent\.ageMs\)\}/);
  assert.match(deck, /\{formatAge\(Math\.max\(0, now - event\.ts \* 1000\)\)\}/);

  // Graded window: a reserved row belongs to an agent touching files now.
  assert.match(roster, /export const AGENT_LIVE_MS = 15_000/);
  assert.match(roster, /export const AGENT_WINDOW_MS = 90_000/);
  assert.doesNotMatch(liveActivity, /fairFileActivity/);

  // Inference is drawn differently from a report, and unknown is not zero.
  assert.match(deck, /data-source=\{agent\.inferred \? 'inferred' : 'hook'\}/);
  assert.match(css, /\.agent-dot\[data-source="inferred"\]/);
  assert.match(css, /\[data-state="unknown"\]/);
  assert.match(deck, /const agentsState = connected \? \(liveCount \? 'live' : 'idle'\) : 'unknown'/);

  // One state table drives colour, glow and pulse; nothing may fork it.
  for (const token of ['--state-ink', '--state-edge', '--state-glow', '--state-dim']) {
    assert.ok(css.includes(token), `state table must define ${token}`);
  }
  // Mixed values take their direction from their own first strong character.
  assert.match(css, /\.live-file \{[^}]*unicode-bidi: plaintext/);
  // The graph on screen is a snapshot and must say how old it is.
  assert.match(deck, /daysSince\(graph\.generatedAt, now\)/);
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
