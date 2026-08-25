import assert from 'node:assert/strict';
import test from 'node:test';
import { computeNeuralAtlas2D, digestNeuralAtlas } from '../src/neuralAtlas2d.ts';

const REPRESENTATIVE_COUNTS = {
  asm: 53,
  agents: 6053,
  acp: 5687,
  lab: 4720,
  ops: 2448,
  skills: 165,
  vault: 562,
};

const SMALL_COUNTS = { asm: 24, agents: 540, acp: 460, lab: 320, ops: 260, vault: 180 };

function hierarchyFixture(counts) {
  const nodes = [];
  const links = [];
  const leaves = [];

  for (const [layer, count] of Object.entries(counts)) {
    const root = `${layer}:root`;
    nodes.push({ id: root, label: root, layer, kind: 'root', path: `${layer}/`, abs: `/fixture/${layer}` });

    if (layer === 'asm') {
      for (let index = 1; index < count; index++) {
        const id = `${layer}:core:${index}`;
        nodes.push({ id, label: id, layer, kind: index % 11 === 0 ? 'dir' : 'file', path: `${layer}/${index}`, abs: `/fixture/${layer}/${index}` });
        links.push({ source: root, target: id, type: 'contains' });
      }
      continue;
    }

    const directoryCount = Math.max(2, Math.ceil((count - 1) / 58));
    const directories = [];
    for (let index = 0; index < directoryCount; index++) {
      const id = `${layer}:dir:${String(index).padStart(3, '0')}`;
      directories.push(id);
      nodes.push({ id, label: id, layer, kind: 'dir', path: `${layer}/d${index}`, abs: `/fixture/${layer}/d${index}` });
      links.push({ source: root, target: id, type: 'contains' });
    }

    const leafCount = count - directoryCount - 1;
    for (let index = 0; index < leafCount; index++) {
      const directory = directories[index % directories.length];
      const id = `${layer}:file:${String(index).padStart(5, '0')}`;
      nodes.push({
        id,
        label: id,
        layer,
        kind: index % 17 === 0 ? 'page' : 'file',
        path: `${layer}/${directory.split(':').at(-1)}/${index}`,
        abs: `/fixture/${layer}/${index}`,
      });
      leaves.push(id);
      links.push({ source: directory, target: id, type: 'contains' });
      if (index > 0) links.push({ source: `${layer}:file:${String(index - 1).padStart(5, '0')}`, target: id, type: 'code' });
    }
  }

  for (let index = 0; index < leaves.length; index += 97) {
    links.push({ source: leaves[index], target: leaves[(index * 17 + 31) % leaves.length], type: 'xlayer' });
  }
  return { nodes, links };
}

function spatialOccupancy(positions, cellSize) {
  const cells = new Map();
  for (const position of positions.values()) {
    const key = `${Math.round(position.x / cellSize)},${Math.round(position.y / cellSize)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const counts = [...cells.values()];
  return {
    collided: counts.filter((count) => count > 1).reduce((sum, count) => sum + count, 0),
    max: Math.max(...counts),
  };
}

function median(values) {
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

test('neural atlas is deterministic, source-order independent, complete, and immutable', () => {
  const input = hierarchyFixture(SMALL_COUNTS);
  const before = JSON.stringify(input);
  const forward = computeNeuralAtlas2D(input);
  const reversed = computeNeuralAtlas2D({
    nodes: input.nodes.slice().reverse(),
    links: input.links.slice().reverse(),
  });

  assert.equal(digestNeuralAtlas(forward), digestNeuralAtlas(reversed));
  assert.equal(forward.positions.size, input.nodes.length);
  assert.equal(JSON.stringify(input), before);
  assert.ok([...forward.positions.values()].every((position) => Number.isFinite(position.x) && Number.isFinite(position.y)));
  assert.ok([...forward.positions.values()].every((position) => typeof position.anchorId === 'string' && position.anchorId.length > 0));
});

test('live-scale atlas stays wide and collision-light while retaining every neuron', () => {
  const input = hierarchyFixture(REPRESENTATIVE_COUNTS);
  const layout = computeNeuralAtlas2D(input);
  const positions = [...layout.positions.values()];
  const xs = positions.map((position) => position.x);
  const ys = positions.map((position) => position.y);
  const actualWidth = Math.max(...xs) - Math.min(...xs);
  const actualHeight = Math.max(...ys) - Math.min(...ys);
  const occupancy = spatialOccupancy(layout.positions, 2);

  assert.equal(input.nodes.length, 19688, 'fixture must continue matching the live graph scale');
  assert.equal(layout.positions.size, input.nodes.length);
  assert.ok(actualWidth >= 1600, `actual width ${actualWidth}`);
  assert.ok(actualHeight >= 540, `actual height ${actualHeight}`);
  assert.ok(layout.aspectRatio >= 2 && layout.aspectRatio <= 3.4, `aspect ${layout.aspectRatio}`);
  assert.ok(layout.minimumSpacing >= 1.5, `minimum spacing ${layout.minimumSpacing}`);
  assert.ok(occupancy.collided / layout.positions.size < 0.05, `2-unit collision ratio ${occupancy.collided / layout.positions.size}`);
  assert.ok(occupancy.max <= 3, `maximum 2-unit occupancy ${occupancy.max}`);

  const core = positions.filter((position) => position.hemisphere === 'center');
  const tissue = positions.filter((position) => position.hemisphere !== 'center');
  assert.ok(core.length > 0 && tissue.length > 0);
  assert.deepEqual(new Set(tissue.map((position) => position.hemisphere)), new Set(['left', 'right']));
  assert.ok(core.every((position) => Math.abs(position.x) <= 90 && Math.abs(position.y) <= 70));
});

test('containment topology keeps files measurably closer to their directory anchor', () => {
  const input = hierarchyFixture(SMALL_COUNTS);
  const layout = computeNeuralAtlas2D(input);
  const parents = new Map(input.links.filter((link) => link.type === 'contains').map((link) => [link.target, link.source]));
  const directoriesByLayer = new Map();
  for (const node of input.nodes.filter((node) => node.kind === 'dir' && node.layer !== 'asm')) {
    const directories = directoriesByLayer.get(node.layer) ?? [];
    directories.push(node.id);
    directoriesByLayer.set(node.layer, directories);
  }

  const localDistances = [];
  const unrelatedDistances = [];
  for (const node of input.nodes.filter((item) => (item.kind === 'file' || item.kind === 'page') && item.layer !== 'asm')) {
    const anchorId = parents.get(node.id);
    const position = layout.positions.get(node.id);
    const anchor = layout.positions.get(anchorId);
    assert.equal(position.anchorId, anchorId, `${node.id} should inherit its structural directory`);
    localDistances.push(Math.hypot(position.x - anchor.x, position.y - anchor.y));

    const directories = directoriesByLayer.get(node.layer);
    const anchorIndex = directories.indexOf(anchorId);
    const unrelated = layout.positions.get(directories[(anchorIndex + 1) % directories.length]);
    unrelatedDistances.push(Math.hypot(position.x - unrelated.x, position.y - unrelated.y));
  }

  assert.ok(median(localDistances) < median(unrelatedDistances) * 0.55, `local ${median(localDistances)} vs unrelated ${median(unrelatedDistances)}`);
});
