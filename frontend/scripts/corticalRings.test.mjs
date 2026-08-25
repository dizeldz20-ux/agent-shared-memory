import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnatomicalGraph2D } from '../src/anatomical2d.ts';
import {
  applyCorticalRingPins,
  clearCorticalRingPins,
  computeCorticalRings,
  digestRingLayout,
  ringPoint,
} from '../src/corticalRings.ts';

const counts = { asm: 22, vault: 226, api: 241, web: 149, ops: 973, lab: 35 };

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

test('cortex forms open lobe folds with full, collision-light coverage', () => {
  const layout = computeCorticalRings(buildAnatomicalGraph2D(fixture()).nodes);
  const aspect = layout.maxX / layout.maxY;
  const populatedLayers = new Set(Object.keys(counts).filter((layer) => layer !== 'asm'));
  assert.ok(aspect >= 1.8 && aspect <= 3.4, `cortical sheet aspect ${aspect}`);
  assert.ok(layout.bands.length >= populatedLayers.size, `fold coverage ${layout.bands.length}/${populatedLayers.size}`);
  assert.ok([...populatedLayers].every((layer) => layout.bands.some((band) => band.layer === layer)), 'every populated lobe needs a fold');
  assert.deepEqual(new Set(layout.bands.map((band) => band.side)), new Set([-1, 1]), 'the complete cortex must use both hemispheres');
  assert.ok(layout.bands.every((band) => Math.sign(band.cx) === band.side), 'every band belongs to one hemisphere');
  assert.ok(layout.bands.every((band) => band.subBand === 0), 'open cortex should not recreate concentric sub-rings');
  assert.equal(layout.arcGapCountMin, 2);
  assert.equal(layout.arcGapCountMax, 2);
  assert.ok(layout.maxOffBandDistance > 10, 'the sheet must use area around each fold, not collapse onto a line');
  assert.ok(layout.maxOffBandDistance <= Math.max(...layout.bands.map((band) => band.ry)) + 1);
  assert.equal(layout.radialJitterMax, layout.maxOffBandDistance, 'reported fold depth must be measured');

  for (const band of layout.bands) {
    assert.ok(band.arcs.every((arc) => arc.start >= -1 && arc.end <= 1 && arc.start < arc.end), `normalized open arcs for ${band.id}`);
    const start = ringPoint(band, -0.97);
    const end = ringPoint(band, 0.97);
    assert.ok(Math.hypot(start.x - end.x, start.y - end.y) > band.rx * 1.9, `${band.id} must remain open`);
  }

  const bins = new Map();
  for (const position of layout.positions.values()) {
    const key = `${Math.round(position.x / 4)},${Math.round(position.y / 4)}`;
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const occupancies = [...bins.values()];
  const collided = occupancies.filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  assert.ok(collided / layout.positions.size < 0.01, `4-unit collision ratio ${collided / layout.positions.size}`);
  assert.ok(Math.max(...occupancies) <= 2, `maximum fold-cell occupancy ${Math.max(...occupancies)}`);

  const core = [...layout.positions.values()].filter((position) => position.layer === 'asm');
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
