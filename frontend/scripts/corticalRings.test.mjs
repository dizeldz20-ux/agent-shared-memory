import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnatomicalGraph2D } from '../src/anatomical2d.ts';
import {
  applyCorticalRingPins,
  clearCorticalRingPins,
  computeCorticalRings,
  digestRingLayout,
} from '../src/corticalRings.ts';

const counts = { c2b: 22, vault: 226, api: 241, web: 149, ops: 973, lab: 35 };

function fixture() {
  const nodes = [];
  for (const [layer, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index++) {
      nodes.push({
        id: `${layer}:${String(index).padStart(4, '0')}`,
        label: `${layer} ${index}`,
        layer,
        kind: index === 0 ? 'root' : index % 17 === 0 ? 'dir' : index % 7 === 0 ? 'page' : 'file',
        path: `${layer}/${index}`,
        abs: `private/${layer}/${index}`,
      });
    }
  }
  return { nodes, links: [] };
}

test('cortical rings are deterministic and independent of source order', () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const forward = computeCorticalRings(buildAnatomicalGraph2D(input).nodes);
  const reversed = computeCorticalRings(buildAnatomicalGraph2D({ ...input, nodes: [...input.nodes].reverse() }).nodes);
  assert.equal(digestRingLayout(forward), digestRingLayout(reversed));
  assert.equal(forward.positions.size, input.nodes.length);
  assert.equal(JSON.stringify(input), before);
});

test('rings form organic elliptical bands with gaps and a restrained core', () => {
  const layout = computeCorticalRings(buildAnatomicalGraph2D(fixture()).nodes);
  const ratios = layout.bands.map((band) => band.ry / band.rx);
  assert.ok(Math.min(...ratios) >= 0.58, `ellipse ratio minimum ${Math.min(...ratios)}`);
  assert.ok(Math.max(...ratios) <= 0.82, `ellipse ratio maximum ${Math.max(...ratios)}`);
  assert.ok(new Set(ratios.map((ratio) => ratio.toFixed(3))).size >= 3, 'rings need multiple ellipse ratios');
  assert.ok(layout.bands.filter((band) => band.layer === 'ops').length >= 4, 'heavy Ops layer needs sub-bands');
  assert.ok(layout.arcGapCountMin >= 4 && layout.arcGapCountMax <= 6, `gap range ${layout.arcGapCountMin}..${layout.arcGapCountMax}`);
  assert.ok(layout.maxOffBandDistance < 5, `off-band distance ${layout.maxOffBandDistance}`);
  assert.ok(layout.radialJitterMax < 5, `radial jitter ${layout.radialJitterMax}`);
  assert.equal(layout.radialJitterMax, layout.maxOffBandDistance, 'reported radial jitter must be measured, not a limit constant');
  const core = [...layout.positions.values()].filter((position) => position.layer === 'c2b');
  assert.ok(core.length > 0);
  assert.ok(core.every((position) => Math.hypot(position.x, position.y) <= layout.coreRadius));
});

test('ring pins apply to the 2D clone and clear back to anatomical targets', () => {
  const source = fixture();
  const graph = buildAnatomicalGraph2D(source);
  const layout = computeCorticalRings(graph.nodes);
  assert.equal(applyCorticalRingPins(graph.nodes, layout), graph.nodes.length);
  for (const node of graph.nodes) {
    const position = layout.positions.get(node.id);
    assert.equal(node.fx, position.x);
    assert.equal(node.fy, position.y);
    assert.equal(node.x, position.x);
    assert.equal(node.y, position.y);
  }
  clearCorticalRingPins(graph.nodes);
  for (const node of graph.nodes) {
    assert.equal(node.fx, undefined);
    assert.equal(node.fy, undefined);
    assert.equal(node.x, node.__targetX);
    assert.equal(node.y, node.__targetY);
  }
  assert.equal(source.nodes.some((node) => 'fx' in node || 'fy' in node), false);
});
