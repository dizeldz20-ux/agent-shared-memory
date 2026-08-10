import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRAIN3D_SCENE,
  CAMERA_PRESETS_3D,
  buildBrainGraph3D,
  buildRenderGraph3D,
  cameraFrameForNodes3D,
  digestBrainTargets,
  escapeHtml,
  focusNeighborhood3D,
  visibleLinks3D,
} from '../src/brain3d.ts';

const layers = ['c2b', 'vault', 'api', 'web', 'ops', 'lab'];
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

test('3D targets stay bounded, bilateral, and keep the C2B nucleus compact', () => {
  const graph = buildBrainGraph3D(fixture());
  assert.ok(graph.nodes.every((node) => Math.abs(node.__targetX) <= 235));
  assert.ok(graph.nodes.every((node) => Math.abs(node.__targetY) <= 155));
  assert.ok(graph.nodes.every((node) => Math.abs(node.__targetZ) <= 190));

  const nonCore = graph.nodes.filter((node) => node.layer !== 'c2b');
  assert.ok(nonCore.some((node) => node.__targetZ < -20));
  assert.ok(nonCore.some((node) => node.__targetZ > 20));

  const core = graph.nodes.filter((node) => node.layer === 'c2b');
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

  assert.ok(overview.nodes.length < graph.nodes.length, `${overview.nodes.length} of ${graph.nodes.length} nodes`);
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

test('3D scene constants, camera axis, and tooltip escaping are explicit', () => {
  assert.deepEqual(BRAIN3D_SCENE, {
    fogColor: '#05070d',
    fogDensity: 0.00155,
    bloomStrength: 0.56,
    bloomRadius: 0.42,
    bloomThreshold: 0.38,
  });
  assert.deepEqual(Object.keys(CAMERA_PRESETS_3D).sort(), ['left', 'right', 'whole']);
  assert.ok(CAMERA_PRESETS_3D.left.position.z < 0);
  assert.ok(CAMERA_PRESETS_3D.right.position.z > 0);
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
