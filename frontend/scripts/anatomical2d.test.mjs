import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnatomicalGraph2D,
  createAnatomicalForce2D,
  digestAnatomicalTargets,
} from '../src/anatomical2d.ts';

const layers = ['asm', 'vault', 'api', 'web', 'ops', 'lab', 'ephemeral'];
const kinds = ['root', 'dir', 'file', 'page', 'ephemeral'];

function fixture() {
  const nodes = [];
  let i = 0;
  for (const layer of layers) {
    const count = layer === 'ops' ? 973 : layer === 'asm' ? 42 : 105;
    for (let j = 0; j < count; j++) {
      nodes.push({
        id: `${layer}:${String(j).padStart(4, '0')}`,
        label: `${layer} ${j}`,
        layer,
        kind: j === 0 ? 'root' : j % 11 === 0 ? 'dir' : kinds[(i + j) % kinds.length],
        path: `${layer}/${j}`,
        abs: `abs/${layer}/${j}`,
        x: 9999,
        y: -9999,
      });
      i++;
    }
  }
  const links = [];
  for (let j = 1; j < nodes.length; j++) {
    links.push({ source: nodes[Math.max(0, j - 1)].id, target: nodes[j].id, type: j % 7 === 0 ? 'xlayer' : j % 5 === 0 ? 'link' : j % 3 === 0 ? 'code' : 'contains' });
    if (j % 2 === 0) links.push({ source: nodes[0].id, target: nodes[j].id, type: 'contains' });
    if (j % 9 === 0) links.push({ source: nodes[j].id, target: nodes[(j * 17) % nodes.length].id, type: 'link' });
  }
  return { nodes, links };
}

test('buildAnatomicalGraph2D clones data, seeds deterministic targets, and never mutates input', () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const a = buildAnatomicalGraph2D(input);
  const b = buildAnatomicalGraph2D(input);
  assert.notEqual(a.nodes[0], input.nodes[0]);
  assert.notEqual(a.links[0], input.links[0]);
  assert.equal(JSON.stringify(input), before);
  assert.equal(digestAnatomicalTargets(a.nodes), digestAnatomicalTargets(b.nodes));
  assert.notEqual(a.nodes[0].x, 9999);
});

test('targets expose a wide bilateral neural atlas with a restrained shared core', () => {
  const graph = buildAnatomicalGraph2D(fixture());
  const xs = graph.nodes.map((n) => n.__targetX);
  const ys = graph.nodes.map((n) => n.__targetY);
  const actualWidth = Math.max(...xs) - Math.min(...xs);
  const actualHeight = Math.max(...ys) - Math.min(...ys);
  const atlasWidth = graph.atlas.maxX - graph.atlas.minX;
  const atlasHeight = graph.atlas.maxY - graph.atlas.minY;

  assert.equal(graph.atlas.positions.size, graph.nodes.length, 'every source neuron needs an atlas target');
  assert.ok(actualWidth >= 1600, `atlas should use the wide workspace, got ${actualWidth}`);
  assert.ok(actualHeight >= 450, `atlas should use the safe vertical band, got ${actualHeight}`);
  assert.ok(atlasWidth >= actualWidth && atlasHeight >= actualHeight, 'reported bounds must cover every neuron');
  assert.ok(graph.atlas.aspectRatio >= 2 && graph.atlas.aspectRatio <= 3.4, `atlas aspect ${graph.atlas.aspectRatio}`);
  assert.ok(graph.atlas.minimumSpacing >= 1.5, `minimum spacing ${graph.atlas.minimumSpacing}`);
  assert.ok(graph.atlas.anchorCount > 20 && graph.atlas.anchorCount < graph.nodes.length, `anchor count ${graph.atlas.anchorCount}`);

  const core = graph.nodes.filter((node) => node.layer === 'asm');
  assert.ok(core.every((node) => node.__hemisphere === 'center'));
  assert.ok(core.every((node) => Math.abs(node.__targetX) <= 80 && Math.abs(node.__targetY) <= 60));
  const tissue = graph.nodes.filter((node) => node.layer !== 'asm');
  assert.ok(tissue.every((node) => node.__hemisphere === 'left' || node.__hemisphere === 'right'));
  assert.deepEqual(new Set(tissue.map((node) => node.__hemisphere)), new Set(['left', 'right']));
  assert.ok(tissue.every((node) => typeof node.__anchorId === 'string' && node.__anchorId.length > 0));
  const nearFissure = tissue.filter((node) => Math.abs(node.__targetX) < 18).length;
  assert.ok(nearFissure < tissue.length * 0.01, `central fissure too crowded ${nearFissure}`);
});

test('link style buckets are real bounded discrete values', () => {
  const graph = buildAnatomicalGraph2D(fixture());
  assert.ok(new Set(graph.links.map((l) => l.__curvature)).size <= 7);
  assert.ok(new Set(graph.links.map((l) => l.__styleKey)).size <= 8);
  for (const link of graph.links) assert.equal(typeof link.__curvature, 'number');
});

test('force initialize captures runtime nodes and moves late nodes', () => {
  const graph = buildAnatomicalGraph2D(fixture());
  const force = createAnatomicalForce2D();
  const runtime = graph.nodes.slice(0, 5).map((n) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0 }));
  const late = { ...graph.nodes[100], x: 0, y: 0, vx: 0, vy: 0 };
  force.initialize(runtime);
  force(1);
  assert.ok(runtime.some((n) => Math.abs(n.vx) + Math.abs(n.vy) > 0));
  force.initialize([...runtime, late]);
  force(1);
  assert.ok(Math.abs(late.vx) + Math.abs(late.vy) > 0, 'late node should move after initialize(nextNodes)');
});
