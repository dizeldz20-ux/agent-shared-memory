import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjacencyFromLinks,
  applyDragDelta,
  createDragRelaxation,
  createDragRelaxationWorld,
  dragInfluence,
  pinAtCurrentPosition,
  stepDragRelaxation,
} from '../src/dragField.ts';

function fixture() {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const links = [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
    { source: 'b', target: 'd' },
    { source: 'd', target: 'e' },
  ];
  return { ids, neighbors: adjacencyFromLinks(ids, links) };
}

test('drag field follows direct and second-hop synapses with deterministic decay', () => {
  const { neighbors } = fixture();
  const influence = dragInfluence('a', neighbors);
  assert.deepEqual([...influence], [
    ['a', 1],
    ['b', 0.38],
    ['c', 0.38],
    ['d', 0.13],
  ]);
  assert.equal(influence.has('e'), false, 'third-hop nodes stay outside the local drag field');
});

test('drag field cap is respected even for high-degree project roots', () => {
  const neighbors = new Map([['root', new Set(Array.from({ length: 1000 }, (_, index) => `n${index}`))]]);
  const influence = dragInfluence('root', neighbors, { maxNodes: 48 });
  assert.equal(influence.size, 48);
  assert.equal(influence.get('root'), 1);
});

test('drag field can rank connected neurons by physical proximity before applying its cap', () => {
  const neighbors = new Map([
    ['root', new Set(['far', 'near', 'middle'])],
    ['far', new Set(['root'])],
    ['near', new Set(['root'])],
    ['middle', new Set(['root'])],
  ]);
  const distances = new Map([['far', 40], ['near', 2], ['middle', 12]]);
  const influence = dragInfluence('root', neighbors, {
    maxNodes: 3,
    distanceFor: (id) => distances.get(id) ?? 0,
  });
  assert.deepEqual([...influence.keys()], ['root', 'near', 'middle']);
});

test('incremental 2D drag moves pinned neighbours while the library owns the grabbed node', () => {
  const nodes = new Map([
    ['a', { id: 'a', x: 10, y: 20, fx: 10, fy: 20 }],
    ['b', { id: 'b', x: 0, y: 0, fx: 0, fy: 0 }],
    ['d', { id: 'd', x: -2, y: 5, fx: -2, fy: 5 }],
  ]);
  const influence = new Map([['a', 1], ['b', 0.38], ['d', 0.13]]);
  assert.equal(applyDragDelta(nodes, influence, { x: 10, y: -5 }), 2);
  assert.deepEqual({ x: nodes.get('a').x, y: nodes.get('a').y }, { x: 10, y: 20 });
  assert.equal(nodes.get('b').x, 3.8);
  assert.equal(nodes.get('b').y, -1.9);
  assert.equal(nodes.get('d').x, -0.7);
  assert.equal(nodes.get('d').y, 4.35);
  assert.equal(nodes.get('b').fx, nodes.get('b').x);
  assert.equal(nodes.get('b').fy, nodes.get('b').y);
});

test('3D drag and release persist the deformed connectome position', () => {
  const node = { id: 'b', x: 1, y: 2, z: 3 };
  const nodes = new Map([['b', node]]);
  applyDragDelta(nodes, new Map([['root', 1], ['b', 0.5]]), { x: 4, y: -2, z: 6 });
  pinAtCurrentPosition(node, 3);
  assert.deepEqual({ x: node.x, y: node.y, z: node.z }, { x: 3, y: 1, z: 6 });
  assert.deepEqual({ fx: node.fx, fy: node.fy, fz: node.fz }, { fx: 3, fy: 1, fz: 6 });
});

test('local relaxation admits a spatial collider and separates it from the fixed root', () => {
  const nodes = new Map([
    ['root', { id: 'root', x: 0, y: 0 }],
    ['nearby', { id: 'nearby', x: 0.4, y: 0 }],
    ['far', { id: 'far', x: 80, y: 50 }],
  ]);
  const neighbors = adjacencyFromLinks(nodes.keys(), []);
  const state = createDragRelaxation(
    'root',
    nodes,
    new Map([['root', 1]]),
    () => 2,
    { dimensions: 2, maxNodes: 8, collisionPadding: 0.2, anchorStrength: 0 },
  );
  const result = stepDragRelaxation(state, nodes, neighbors, { iterations: 4 });
  assert.equal(result.added, 1);
  assert.equal(state.weights.has('nearby'), true, 'an unconnected spatial neighbour joins the local field');
  assert.deepEqual({ x: nodes.get('root').x, y: nodes.get('root').y }, { x: 0, y: 0 });
  assert.ok(Math.hypot(nodes.get('nearby').x, nodes.get('nearby').y) > 4, 'collider clears both soma radii');
  assert.deepEqual({ x: nodes.get('far').x, y: nodes.get('far').y }, { x: 80, y: 50 });
});

test('real-link spring continues reorganizing after the grabbed node moves', () => {
  const nodes = new Map([
    ['root', { id: 'root', x: 0, y: 0 }],
    ['linked', { id: 'linked', x: 10, y: 0 }],
  ]);
  const neighbors = adjacencyFromLinks(nodes.keys(), [{ source: 'root', target: 'linked' }]);
  const state = createDragRelaxation(
    'root',
    nodes,
    new Map([['root', 1], ['linked', 0.38]]),
    () => 1,
    { dimensions: 2, linkStrength: 0.2, anchorStrength: 0, collisionPadding: 0 },
  );
  nodes.get('root').x = 5;
  nodes.get('root').fx = 5;
  const before = nodes.get('linked').x;
  stepDragRelaxation(state, nodes, neighbors, { iterations: 3 });
  assert.ok(nodes.get('linked').x > before, 'the spring restores its drag-start rest length');
  assert.equal(nodes.get('root').x, 5, 'the pointer-owned root is an immovable constraint');
});

test('first callback root anchor preserves the pre-drag spring geometry', () => {
  const nodes = new Map([
    ['root', { id: 'root', x: 5, y: 0 }],
    ['linked', { id: 'linked', x: 10, y: 0 }],
  ]);
  const neighbors = adjacencyFromLinks(nodes.keys(), [{ source: 'root', target: 'linked' }]);
  const state = createDragRelaxation(
    'root',
    nodes,
    new Map([['root', 1], ['linked', 0.38]]),
    () => 1,
    { dimensions: 2, rootAnchor: { x: 0, y: 0 }, linkStrength: 0.25, anchorStrength: 0 },
  );
  stepDragRelaxation(state, nodes, neighbors, { iterations: 2 });
  assert.ok(nodes.get('linked').x > 10, 'the first drag delta remains part of the spring deformation');
  assert.deepEqual(state.anchors.get('root'), { x: 0, y: 0, z: 0 });
});

test('high-degree spring adjacency is indexed once instead of rescanned every frame', () => {
  let adjacencyScans = 0;
  class CountingSet extends Set {
    [Symbol.iterator]() {
      adjacencyScans += 1;
      return super[Symbol.iterator]();
    }
  }
  const nodes = new Map([
    ['root', { id: 'root', x: 0, y: 0 }],
    ['linked', { id: 'linked', x: 10, y: 0 }],
  ]);
  const neighbors = new Map([
    ['root', new CountingSet(['linked'])],
    ['linked', new CountingSet(['root'])],
  ]);
  const state = createDragRelaxation(
    'root',
    nodes,
    new Map([['root', 1], ['linked', 0.38]]),
    () => 1,
    { dimensions: 2, anchorStrength: 0 },
  );
  stepDragRelaxation(state, nodes, neighbors);
  const scansAfterIndex = adjacencyScans;
  stepDragRelaxation(state, nodes, neighbors);
  stepDragRelaxation(state, nodes, neighbors);
  assert.equal(adjacencyScans, scansAfterIndex, 'settling frames reuse the indexed spring pairs');
  assert.equal(state.springPairs.length, 1);
});

test('spatial world is built once and reused across pointer transactions', () => {
  const nodes = new Map([
    ['root', { id: 'root', x: 0, y: 0 }],
    ['neighbor', { id: 'neighbor', x: 8, y: 0 }],
  ]);
  let radiusCalls = 0;
  const world = createDragRelaxationWorld(nodes, () => { radiusCalls += 1; return 1; }, { dimensions: 2 });
  const callsAfterBuild = radiusCalls;
  const first = createDragRelaxation('root', nodes, new Map([['root', 1]]), () => { radiusCalls += 1; return 1; }, { dimensions: 2, world });
  const second = createDragRelaxation('neighbor', nodes, new Map([['neighbor', 1]]), () => { radiusCalls += 1; return 1; }, { dimensions: 2, world });
  assert.equal(radiusCalls, callsAfterBuild, 'a new drag does not rebuild radii or the whole grid');
  assert.equal(first.grid, world.grid);
  assert.equal(second.grid, world.grid);
});

test('per-frame displacement remains bounded through dense multi-iteration collisions', () => {
  const nodes = new Map(Array.from({ length: 18 }, (_, index) => [
    `n${index}`,
    { id: `n${index}`, x: 0, y: 0, z: 0 },
  ]));
  const starts = new Map([...nodes].map(([id, node]) => [id, { x: node.x, y: node.y, z: node.z }]));
  const state = createDragRelaxation(
    'n0',
    nodes,
    new Map([['n0', 1]]),
    () => 1,
    { dimensions: 3, maxNodes: 18, maxStep: 1.2, anchorStrength: 0 },
  );
  const result = stepDragRelaxation(state, nodes, adjacencyFromLinks(nodes.keys(), []), { iterations: 8 });
  assert.ok(result.maxDisplacement <= 1.200001, result.maxDisplacement);
  for (const [id, node] of nodes) {
    const start = starts.get(id);
    assert.ok(Math.hypot(node.x - start.x, node.y - start.y, node.z - start.z) <= 1.200001, id);
  }
});

test('collision cascade stays bounded for dense high-degree fields', () => {
  const nodes = new Map(Array.from({ length: 80 }, (_, index) => [
    `n${index}`,
    { id: `n${index}`, x: (index % 4) * 0.05, y: Math.floor(index / 4) * 0.05 },
  ]));
  const neighbors = adjacencyFromLinks(nodes.keys(), []);
  const state = createDragRelaxation(
    'n0',
    nodes,
    new Map([['n0', 1]]),
    () => 1,
    { dimensions: 2, maxNodes: 12, anchorStrength: 0 },
  );
  stepDragRelaxation(state, nodes, neighbors, { iterations: 3 });
  assert.equal(state.weights.size, 12);
});

test('coincident fallback is deterministic in 2D and finite in 3D', () => {
  const solve = (dimensions) => {
    const nodes = new Map([
      ['a', { id: 'a', x: 0, y: 0, z: 0 }],
      ['b', { id: 'b', x: 0, y: 0, z: 0 }],
    ]);
    const state = createDragRelaxation(
      'a',
      nodes,
      new Map([['a', 1]]),
      () => 1,
      { dimensions, maxNodes: 4, anchorStrength: 0 },
    );
    stepDragRelaxation(state, nodes, adjacencyFromLinks(nodes.keys(), []), { iterations: 2 });
    return { x: nodes.get('b').x, y: nodes.get('b').y, z: nodes.get('b').z ?? 0 };
  };
  assert.deepEqual(solve(2), solve(2));
  assert.deepEqual(solve(3), solve(3));
  assert.ok(Object.values(solve(3)).every(Number.isFinite));
});

test('coincident fallback reverses exactly when pair order reverses', () => {
  const solve = (rootId) => {
    const otherId = rootId === 'a' ? 'b' : 'a';
    const nodes = new Map([
      ['a', { id: 'a', x: 0, y: 0 }],
      ['b', { id: 'b', x: 0, y: 0 }],
    ]);
    const state = createDragRelaxation(rootId, nodes, new Map([[rootId, 1]]), () => 1, { dimensions: 2, anchorStrength: 0 });
    stepDragRelaxation(state, nodes, adjacencyFromLinks(nodes.keys(), []));
    return nodes.get(otherId);
  };
  const b = solve('a');
  const a = solve('b');
  assert.ok(Math.abs(a.x + b.x) < 1e-9);
  assert.ok(Math.abs(a.y + b.y) < 1e-9);
});
