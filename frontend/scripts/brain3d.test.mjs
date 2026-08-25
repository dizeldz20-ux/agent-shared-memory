import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRAIN3D_SCENE,
  CAMERA_PRESETS_3D,
  CONNECTOME_LINK_BUDGETS,
  LIVE_SIGNAL_LIMITS,
  LIVE_SIGNAL_PRESENTATION,
  buildBatchedConnectome3D,
  buildBrainGraph3D,
  buildLiveSignalSegments3D,
  buildRenderGraph3D,
  cameraFrameForNodes3D,
  digestLiveSignalSegments3D,
  digestBrainTargets,
  escapeHtml,
  focusNeighborhood3D,
  pruneLiveSignalTimings,
  selectConnectomeLinks3D,
  syncBatchedConnectome3D,
  visibleLinks3D,
} from '../src/brain3d.ts';

test('live CONNECTOME presentation stays legible over the dense whole-brain atlas', () => {
  assert.ok(LIVE_SIGNAL_PRESENTATION.routeWidthPx >= 2);
  assert.ok(LIVE_SIGNAL_PRESENTATION.routeGlowWidthPx >= LIVE_SIGNAL_PRESENTATION.routeWidthPx * 2);
  assert.ok(LIVE_SIGNAL_PRESENTATION.sourceHaloSizePx > LIVE_SIGNAL_PRESENTATION.sourceNeuronSizePx);
  assert.ok(LIVE_SIGNAL_PRESENTATION.headSizePx > LIVE_SIGNAL_PRESENTATION.trailSizePx);
  assert.ok(LIVE_SIGNAL_PRESENTATION.staticLinkContrast <= 0.3);
});

const layers = ['asm', 'vault', 'api', 'web', 'ops', 'lab'];
const kinds = ['root', 'dir', 'file', 'page'];

function fixture() {
  const nodes = [];
  for (const [layerIndex, layer] of layers.entries()) {
    const count = layer === 'ops' ? 90 : 30;
    for (let index = 0; index < count; index++) {
      nodes.push({
        id: `${layer}:${String(index).padStart(3, '0')}`,
        label: `${layer} ${index}`,
        layer,
        kind: index === 0 ? 'root' : kinds[(index + layerIndex) % kinds.length],
        path: `${layer}/${index}`,
        abs: `private/${layer}/${index}`,
        x: 9999,
        y: -9999,
        z: 7777,
      });
    }
  }
  const links = [];
  for (let index = 1; index < nodes.length; index++) {
    links.push({
      source: nodes[index - 1].id,
      target: nodes[index].id,
      type: index % 11 === 0 ? 'xlayer' : index % 7 === 0 ? 'link' : index % 3 === 0 ? 'code' : 'contains',
    });
    if (index % 5 === 0) links.push({ source: nodes[0].id, target: nodes[index].id, type: 'contains' });
  }
  return { nodes, links };
}

function batchedFixture() {
  const structural = [
    { id: 'asm:root', label: 'ASM', layer: 'asm', kind: 'root', path: 'asm', abs: 'private/asm' },
    { id: 'lab:dir-a', label: 'Lab A', layer: 'lab', kind: 'dir', path: 'lab/a', abs: 'private/lab/a' },
    { id: 'ops:dir-b', label: 'Ops B', layer: 'ops', kind: 'dir', path: 'ops/b', abs: 'private/ops/b' },
    { id: 'vault:page-a', label: 'Page A', layer: 'vault', kind: 'page', path: 'vault/a', abs: 'private/vault/a' },
    { id: 'vault:page-b', label: 'Page B', layer: 'vault', kind: 'page', path: 'vault/b', abs: 'private/vault/b' },
  ];
  const files = Array.from({ length: 48 }, (_, index) => ({
    id: `file:${String(index).padStart(2, '0')}`,
    label: `File ${index}`,
    layer: index % 2 ? 'ops' : 'lab',
    kind: 'file',
    path: `project/file-${index}.ts`,
    abs: `private/project/file-${index}.ts`,
  }));
  const nodes = [...structural, ...files];
  const links = [
    ...structural.slice(1).map((node) => ({ source: structural[0].id, target: node.id, type: 'contains' })),
    ...files.map((node, index) => ({
      source: structural[1 + index % 2].id,
      target: node.id,
      type: 'contains',
    })),
    ...files.map((node, index) => ({ source: node.id, target: files[(index + 7) % files.length].id, type: 'code' })),
    ...files.map((node, index) => ({ source: node.id, target: files[(index + 11) % files.length].id, type: 'link' })),
    ...files.map((node, index) => ({ source: node.id, target: files[(index + 23) % files.length].id, type: 'xlayer' })),
  ];
  return { nodes, links };
}

function linkKey(link) {
  return `${link.type}:${link.__sourceId}>${link.__targetId}`;
}

function countLinkTypes(links) {
  const counts = { contains: 0, code: 0, link: 0, xlayer: 0 };
  for (const link of links) counts[link.type || 'contains'] += 1;
  return counts;
}

test('buildBrainGraph3D clones source data and seeds deterministic order-independent targets', () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const forward = buildBrainGraph3D(input);
  const reversed = buildBrainGraph3D({ nodes: [...input.nodes].reverse(), links: [...input.links].reverse() });

  assert.notEqual(forward.nodes[0], input.nodes[0]);
  assert.notEqual(forward.links[0], input.links[0]);
  assert.equal(JSON.stringify(input), before);
  assert.equal(digestBrainTargets(forward.nodes), digestBrainTargets(reversed.nodes));
  assert.notEqual(forward.nodes[0].x, 9999);
  assert.notEqual(forward.nodes[0].z, 7777);
  assert.ok(forward.nodes.every((node) => node.fx === node.x && node.fy === node.y && node.fz === node.z));
});

test('3D targets stay bounded, bilateral, and keep the ASM nucleus compact', () => {
  const graph = buildBrainGraph3D(fixture());
  assert.ok(graph.nodes.every((node) => Math.abs(node.__targetX) <= 235));
  assert.ok(graph.nodes.every((node) => Math.abs(node.__targetY) <= 155));
  assert.ok(graph.nodes.every((node) => Math.abs(node.__targetZ) <= 190));

  const nonCore = graph.nodes.filter((node) => node.layer !== 'asm');
  assert.ok(nonCore.some((node) => node.__targetZ < -20));
  assert.ok(nonCore.some((node) => node.__targetZ > 20));

  const core = graph.nodes.filter((node) => node.layer === 'asm');
  assert.ok(core.length > 0);
  assert.ok(core.every((node) => Math.hypot(node.__targetX, node.__targetY, node.__targetZ) <= 76));
});

test('3D metrics use truthful bounded buckets and progressive neighborhood links', () => {
  const graph = buildBrainGraph3D(fixture());
  assert.ok(graph.nodeValueBuckets <= 24, `node value buckets ${graph.nodeValueBuckets}`);
  assert.ok(graph.styleBuckets <= 8, `style buckets ${graph.styleBuckets}`);
  assert.ok(graph.overviewVisibleLinkCount > 0);
  assert.ok(graph.overviewVisibleLinkCount < graph.links.length);

  const selectedId = graph.nodes.find((node) => graph.degree.get(node.id) > 2).id;
  const focus = focusNeighborhood3D(selectedId, graph.neighbors);
  assert.ok(focus.has(selectedId));
  assert.ok(focus.size > 1);
  const focusedLinks = visibleLinks3D(graph.links, focus, new Set());
  assert.ok(focusedLinks.length > 0);
  assert.ok(focusedLinks.length < graph.overviewVisibleLinkCount);
});

test('3D render budget keeps a semantic overview and expands the complete focus lens', () => {
  const graph = buildBrainGraph3D(fixture());
  const overviewLinks = visibleLinks3D(graph.links, null, new Set());
  const overview = buildRenderGraph3D(graph, overviewLinks, null);
  const overviewIds = new Set(overview.nodes.map((node) => node.id));

  assert.equal(overview.nodes.length, Math.min(1200, graph.nodes.length));
  assert.ok(overview.links.length < overviewLinks.length, `${overview.links.length} of ${overviewLinks.length} links`);
  assert.ok(overview.links.some((link) => link.type === 'xlayer'));
  assert.ok(overview.links.every((link) => overviewIds.has(link.__sourceId) && overviewIds.has(link.__targetId)));

  const selectedId = graph.nodes.find((node) => graph.degree.get(node.id) > 2).id;
  const focus = focusNeighborhood3D(selectedId, graph.neighbors);
  const activeId = graph.nodes.at(-1).id;
  const focusedLinks = visibleLinks3D(graph.links, focus, new Set([activeId]));
  const focused = buildRenderGraph3D(graph, focusedLinks, focus);
  const focusedIds = new Set(focused.nodes.map((node) => node.id));

  assert.ok([...focus].every((id) => focusedIds.has(id)));
  assert.equal(focused.links.length, focusedLinks.length);
  assert.ok(focused.links.every((link) => focusedIds.has(link.__sourceId) && focusedIds.has(link.__targetId)));
});

test('batched CONNECTOME covers every source node while keeping typed link buffers truthful', () => {
  const graph = buildBrainGraph3D(batchedFixture());
  const batch = buildBatchedConnectome3D(graph);

  assert.equal(batch.nodeIndex.size, graph.nodes.length);
  assert.equal(batch.nodePositions.length, graph.nodes.length * 3);
  assert.deepEqual(new Set(batch.nodeIndex.keys()), new Set(graph.nodes.map((node) => node.id)));
  for (const node of graph.nodes) {
    const index = batch.nodeIndex.get(node.id);
    assert.notEqual(index, undefined, `missing batched node ${node.id}`);
    assert.deepEqual(
      Array.from(batch.nodePositions.slice(index * 3, index * 3 + 3)),
      [Math.fround(node.x), Math.fround(node.y), Math.fround(node.z)],
    );
  }

  const counted = countLinkTypes(batch.links);
  assert.deepEqual(batch.linkTypeCounts, counted);
  assert.equal(batch.links.length, Object.values(batch.linkTypeCounts).reduce((sum, count) => sum + count, 0));
  for (const type of Object.keys(CONNECTOME_LINK_BUDGETS)) {
    assert.equal(batch.linkPositions[type].length, batch.linkTypeCounts[type] * 6);
    assert.ok(batch.linkTypeCounts[type] <= CONNECTOME_LINK_BUDGETS[type]);
  }
  const incident = new Set(batch.links.flatMap((link) => [link.__sourceId, link.__targetId]));
  assert.ok(graph.nodes.every((node) => incident.has(node.id)), 'every connected neuron needs an existing visible tract');
});

test('CONNECTOME link selection is deterministic, budgeted per type, and preserves structural contains edges', () => {
  const input = batchedFixture();
  const forward = buildBrainGraph3D(input);
  const reversed = buildBrainGraph3D({ nodes: [...input.nodes].reverse(), links: [...input.links].reverse() });
  const budgets = { contains: 12, code: 11, link: 9, xlayer: 7 };
  const forwardOrder = forward.links.map(linkKey);
  const selected = selectConnectomeLinks3D(forward, budgets);
  const reverseSelected = selectConnectomeLinks3D(reversed, budgets);

  assert.deepEqual(countLinkTypes(selected), budgets);
  assert.deepEqual(selected.map(linkKey), reverseSelected.map(linkKey));
  assert.deepEqual(forward.links.map(linkKey), forwardOrder, 'selection must not reorder the source graph');

  const structuralTargets = new Set(input.nodes
    .filter((node) => node.kind === 'dir' || node.kind === 'page')
    .map((node) => node.id));
  const selectedContainsTargets = new Set(selected
    .filter((link) => link.type === 'contains')
    .map((link) => link.__targetId));
  assert.ok([...structuralTargets].every((id) => selectedContainsTargets.has(id)));

  const forwardBatch = buildBatchedConnectome3D(forward);
  const reverseBatch = buildBatchedConnectome3D(reversed);
  assert.match(forwardBatch.digest, /^[a-f0-9]{8}$/);
  assert.equal(forwardBatch.digest, reverseBatch.digest);
  assert.deepEqual(forwardBatch.linkTypeCounts, reverseBatch.linkTypeCounts);
});

test('syncBatchedConnectome3D patches only one moved node and every incident endpoint', () => {
  const graph = buildBrainGraph3D(batchedFixture());
  const batch = buildBatchedConnectome3D(graph);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const moved = nodeById.get('file:00');
  assert.ok(moved);
  const endpoints = batch.linkOffsets.get(moved.id) ?? [];
  assert.ok(endpoints.length >= 4, `expected incident endpoints for every link type, got ${endpoints.length}`);
  assert.deepEqual(new Set(endpoints.map((endpoint) => endpoint.type)), new Set(Object.keys(CONNECTOME_LINK_BUDGETS)));

  const beforeNodes = batch.nodePositions.slice();
  const beforeLinks = Object.fromEntries(Object.entries(batch.linkPositions).map(([type, positions]) => [type, positions.slice()]));
  moved.x += 13.25;
  moved.y -= 7.5;
  moved.z += 4.75;
  const changedTypes = syncBatchedConnectome3D(batch, nodeById, [moved.id, 'missing:node']);

  assert.deepEqual(changedTypes, new Set(endpoints.map((endpoint) => endpoint.type)));
  const nodeOffset = batch.nodeIndex.get(moved.id) * 3;
  const expectedPosition = [Math.fround(moved.x), Math.fround(moved.y), Math.fround(moved.z)];
  assert.deepEqual(Array.from(batch.nodePositions.slice(nodeOffset, nodeOffset + 3)), expectedPosition);
  for (let index = 0; index < batch.nodePositions.length; index++) {
    if (index >= nodeOffset && index < nodeOffset + 3) continue;
    assert.equal(batch.nodePositions[index], beforeNodes[index], `unexpected node position write at ${index}`);
  }

  const touchedByType = new Map(Object.keys(CONNECTOME_LINK_BUDGETS).map((type) => [type, new Set()]));
  for (const endpoint of endpoints) {
    touchedByType.get(endpoint.type).add(endpoint.offset);
    assert.deepEqual(
      Array.from(batch.linkPositions[endpoint.type].slice(endpoint.offset, endpoint.offset + 3)),
      expectedPosition,
    );
  }
  for (const [type, positions] of Object.entries(batch.linkPositions)) {
    const touchedOffsets = touchedByType.get(type);
    for (let index = 0; index < positions.length; index++) {
      const endpointOffset = index - index % 3;
      if (touchedOffsets.has(endpointOffset)) continue;
      assert.equal(positions[index], beforeLinks[type][index], `unexpected ${type} endpoint write at ${index}`);
    }
  }
});

test('live action potentials follow every real tract type outside the pointer LOD', () => {
  const input = batchedFixture();
  const graph = buildBrainGraph3D(input);
  const reversed = buildBrainGraph3D({ nodes: [...input.nodes].reverse(), links: [...input.links].reverse() });
  const visible = buildBatchedConnectome3D(graph);
  const reversedVisible = buildBatchedConnectome3D(reversed);
  const visibleTracts = visible.links;
  const reversedTracts = reversedVisible.links;
  const activeId = 'file:00';
  const route = buildLiveSignalSegments3D(graph, [activeId], {}, visibleTracts);
  const reverseRoute = buildLiveSignalSegments3D(reversed, [activeId], {}, reversedTracts);
  const key = (segment) => `${segment.originId}:${segment.depth}:${segment.type}:${segment.sourceId}>${segment.targetId}`;
  const realEdges = new Set(visibleTracts.flatMap((link) => [
    `${link.__sourceId}>${link.__targetId}`,
    `${link.__targetId}>${link.__sourceId}`,
  ]));

  assert.ok(route.length >= 4, `expected a visible branch, got ${route.length} segment(s)`);
  assert.ok(route.length <= LIVE_SIGNAL_LIMITS.maxSegmentsPerSource);
  assert.deepEqual(route.map(key), reverseRoute.map(key));
  assert.ok(route.every((segment) => segment.originId === activeId));
  assert.ok(route.every((segment) => segment.depth < LIVE_SIGNAL_LIMITS.maxHops));
  assert.ok(route.every((segment) => realEdges.has(`${segment.sourceId}>${segment.targetId}`)));
  assert.ok(route.some((segment) => segment.type !== 'contains'), 'live current should cross a real semantic/code tract');
  assert.ok(route.filter((segment) => segment.depth === 0).every((segment) => segment.sourceId === activeId));

  const discoveredAtDepth = new Map([[activeId, -1]]);
  for (const segment of route) {
    assert.ok(discoveredAtDepth.has(segment.sourceId), `disconnected live segment ${key(segment)}`);
    discoveredAtDepth.set(segment.targetId, segment.depth);
  }
  assert.deepEqual(buildLiveSignalSegments3D(graph, ['missing:file'], {}, visibleTracts), []);
});

test('parallel agent sources retain independent routes even when hierarchy tracts overlap', () => {
  const graph = buildBrainGraph3D(batchedFixture());
  const tracts = buildBatchedConnectome3D(graph).links.filter((link) => link.type === 'contains');
  const sources = ['file:00', 'file:02'];
  const route = buildLiveSignalSegments3D(graph, sources, {}, tracts);
  const reversedSources = buildLiveSignalSegments3D(graph, [...sources].reverse(), {}, tracts);

  for (const source of sources) {
    assert.ok(route.some((segment) => segment.originId === source), `missing parallel lane ${source}`);
  }
  assert.equal(digestLiveSignalSegments3D(route), digestLiveSignalSegments3D(reversedSources));
  assert.match(digestLiveSignalSegments3D(route), /^[a-f0-9]{8}$/);
});

test('two agents touching the same neuron retain two independently coloured route origins', () => {
  const graph = buildBrainGraph3D(batchedFixture());
  const tracts = buildBatchedConnectome3D(graph).links.filter((link) => link.type === 'contains');
  const route = buildLiveSignalSegments3D(graph, [
    { id: 'file:00', originId: 'codex\u0000file:00' },
    { id: 'file:00', originId: 'claude\u0000file:00' },
  ], {}, tracts);

  assert.ok(route.some((segment) => segment.originId.startsWith('codex')));
  assert.ok(route.some((segment) => segment.originId.startsWith('claude')));
  assert.equal(
    route.filter((segment) => segment.originId.startsWith('codex')).length,
    route.filter((segment) => segment.originId.startsWith('claude')).length,
  );
});

test('expired live animation clocks are reclaimed and the timing maps stay paired', () => {
  const starts = new Map(Array.from({ length: 200 }, (_, index) => [`expired:${index}`, index]));
  const expiries = new Map(Array.from({ length: 200 }, (_, index) => [`expired:${index}`, 500 + index]));
  starts.set('active', 900);
  expiries.set('active', 1100);
  starts.set('orphan-start', 900);
  expiries.set('orphan-expiry', 1100);

  assert.equal(pruneLiveSignalTimings(1000, starts, expiries), 202);
  assert.deepEqual([...starts], [['active', 900]]);
  assert.deepEqual([...expiries], [['active', 1100]]);
});

test('3D scene constants, camera axis, and tooltip escaping are explicit', () => {
  assert.deepEqual(BRAIN3D_SCENE, {
    fogColor: '#030708',
    fogDensity: 0.00072,
    bloomStrength: 0.2,
    bloomRadius: 0.1,
    bloomThreshold: 0.82,
  });
  assert.deepEqual(Object.keys(CAMERA_PRESETS_3D).sort(), ['left', 'right', 'whole']);
  assert.ok(CAMERA_PRESETS_3D.left.position.z < 0);
  assert.ok(CAMERA_PRESETS_3D.right.position.z > 0);
  assert.ok(CAMERA_PRESETS_3D.whole.position.x > Math.abs(CAMERA_PRESETS_3D.whole.position.z));
  assert.equal(escapeHtml('<img src=x onerror="boom"> &'), '&lt;img src=x onerror=&quot;boom&quot;&gt; &amp;');
});

test('3D camera framing is deterministic and keeps every node inside the safe viewport', () => {
  const nodes = buildBrainGraph3D(fixture()).nodes;
  const viewport = { width: 1366, height: 768, safeTop: 112, bottomPadding: 24, fov: 50 };
  const frame = cameraFrameForNodes3D(nodes, CAMERA_PRESETS_3D.whole, viewport);
  const reversed = cameraFrameForNodes3D([...nodes].reverse(), CAMERA_PRESETS_3D.whole, viewport);
  assert.deepEqual(frame, reversed);

  const normalize = (value) => {
    const length = Math.hypot(value.x, value.y, value.z) || 1;
    return { x: value.x / length, y: value.y / length, z: value.z / length };
  };
  const cross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const view = normalize({
    x: frame.lookAt.x - frame.position.x,
    y: frame.lookAt.y - frame.position.y,
    z: frame.lookAt.z - frame.position.z,
  });
  const right = normalize(cross(view, { x: 0, y: 1, z: 0 }));
  const up = normalize(cross(right, view));
  const tanVertical = Math.tan(viewport.fov * Math.PI / 360);
  const tanHorizontal = tanVertical * viewport.width / viewport.height;

  for (const node of nodes) {
    const relative = {
      x: node.x - frame.position.x,
      y: node.y - frame.position.y,
      z: node.z - frame.position.z,
    };
    const depth = dot(relative, view);
    assert.ok(depth > 0);
    const ndcX = dot(relative, right) / (depth * tanHorizontal);
    const ndcY = dot(relative, up) / (depth * tanVertical);
    const screenY = (1 - ndcY) * viewport.height / 2;
    assert.ok(Math.abs(ndcX) <= 0.96, `horizontal NDC ${ndcX}`);
    assert.ok(screenY >= viewport.safeTop, `screen y ${screenY}`);
    assert.ok(screenY <= viewport.height - viewport.bottomPadding, `screen y ${screenY}`);
  }
});
