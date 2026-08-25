export type DragNode = {
  id: string;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
};

export type DragDelta2D = { x: number; y: number };
export type DragDelta3D = DragDelta2D & { z: number };

export interface DragFieldOptions {
  firstHopWeight?: number;
  secondHopWeight?: number;
  maxNodes?: number;
  distanceFor?: (id: string) => number;
}

export interface DragRelaxationOptions {
  dimensions: 2 | 3;
  maxNodes?: number;
  collisionPadding?: number;
  collisionStrength?: number;
  linkStrength?: number;
  anchorStrength?: number;
  maxStep?: number;
  cellSize?: number;
  rootAnchor?: { x: number; y: number; z?: number };
  world?: DragRelaxationWorld;
}

export interface DragRelaxationWorldOptions {
  dimensions: 2 | 3;
  collisionPadding?: number;
  cellSize?: number;
}

export interface DragRelaxationWorld {
  dimensions: 2 | 3;
  radii: Map<string, number>;
  grid: Map<string, Set<string>>;
  cellById: Map<string, string>;
  nodeIndices: Map<string, number>;
  nodeCount: number;
  maxRadius: number;
  cellSize: number;
}

export interface DragRelaxationStepOptions {
  iterations?: number;
  temperature?: number;
}

type DragAnchor = { x: number; y: number; z: number };

export interface DragRelaxationState {
  rootId: string;
  dimensions: 2 | 3;
  weights: Map<string, number>;
  anchors: Map<string, DragAnchor>;
  restLengths: Map<string, number>;
  springPairs: Array<[string, string]>;
  springPairKeys: Set<string>;
  springIndexed: Set<string>;
  radii: Map<string, number>;
  grid: Map<string, Set<string>>;
  cellById: Map<string, string>;
  nodeIndices: Map<string, number>;
  nodeCount: number;
  maxRadius: number;
  maxNodes: number;
  collisionPadding: number;
  collisionStrength: number;
  linkStrength: number;
  anchorStrength: number;
  maxStep: number;
  cellSize: number;
}

export interface DragRelaxationResult {
  activeCount: number;
  added: number;
  collisions: number;
  movedIds: Set<string>;
  maxOverlap: number;
  maxDisplacement: number;
}

const DEFAULT_FIRST_HOP = 0.38;
const DEFAULT_SECOND_HOP = 0.13;
const DEFAULT_MAX_NODES = 640;

function finitePosition(node: DragNode) {
  return Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z ?? 0);
}

function anchorOf(node: DragNode): DragAnchor {
  return { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 };
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function cellCoordinates(node: DragNode, state: Pick<DragRelaxationState, 'cellSize' | 'dimensions'>) {
  return {
    x: Math.floor((node.x ?? 0) / state.cellSize),
    y: Math.floor((node.y ?? 0) / state.cellSize),
    z: state.dimensions === 3 ? Math.floor((node.z ?? 0) / state.cellSize) : 0,
  };
}

function cellKey(x: number, y: number, z: number, dimensions: 2 | 3) {
  return dimensions === 3 ? `${x}:${y}:${z}` : `${x}:${y}`;
}

function syncGridNode(
  state: Pick<DragRelaxationState, 'cellSize' | 'dimensions' | 'grid' | 'cellById'>,
  id: string,
  node: DragNode,
) {
  if (!finitePosition(node)) return;
  const coords = cellCoordinates(node, state);
  const nextKey = cellKey(coords.x, coords.y, coords.z, state.dimensions);
  const previousKey = state.cellById.get(id);
  if (previousKey === nextKey) return;
  if (previousKey) {
    const previous = state.grid.get(previousKey);
    previous?.delete(id);
    if (!previous?.size) state.grid.delete(previousKey);
  }
  const bucket = state.grid.get(nextKey) ?? new Set<string>();
  bucket.add(id);
  state.grid.set(nextKey, bucket);
  state.cellById.set(id, nextKey);
}

function activateNode(
  state: DragRelaxationState,
  id: string,
  nodeById: Map<string, DragNode>,
  weight = 0,
) {
  if (state.weights.has(id)) return false;
  if (state.weights.size >= state.maxNodes) return false;
  const node = nodeById.get(id);
  if (!node || !finitePosition(node)) return false;
  state.weights.set(id, weight);
  state.anchors.set(id, anchorOf(node));
  syncGridNode(state, id, node);
  return true;
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function deterministicDirection(a: string, b: string, dimensions: 2 | 3) {
  const forward = a <= b;
  const low = forward ? a : b;
  const high = forward ? b : a;
  const first = stableHash(`${low}\u0000${high}:direction`) / 4294967295;
  const angle = first * Math.PI * 2;
  const sign = forward ? 1 : -1;
  if (dimensions === 2) return { x: Math.cos(angle) * sign, y: Math.sin(angle) * sign, z: 0 };
  const second = stableHash(`${low}\u0000${high}:elevation`) / 4294967295;
  const z = second * 2 - 1;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: Math.cos(angle) * radial * sign, y: Math.sin(angle) * radial * sign, z: z * sign };
}

function inverseMass(state: DragRelaxationState, id: string) {
  if (id === state.rootId) return 0;
  const radius = Math.max(0.25, state.radii.get(id) ?? 1);
  return 1 / (radius * radius);
}

function displaceNode(
  state: DragRelaxationState,
  node: DragNode,
  dx: number,
  dy: number,
  dz: number,
  movedIds: Set<string>,
  frameMotion: Map<string, DragAnchor>,
) {
  const length = Math.hypot(dx, dy, state.dimensions === 3 ? dz : 0);
  if (!Number.isFinite(length) || length <= 1e-7) return false;
  const spent = frameMotion.get(node.id) ?? { x: 0, y: 0, z: 0 };
  const remaining = Math.max(0, state.maxStep - Math.hypot(spent.x, spent.y, state.dimensions === 3 ? spent.z : 0));
  if (remaining <= 1e-7) return false;
  const clamp = Math.min(1, remaining / length);
  const moveX = dx * clamp;
  const moveY = dy * clamp;
  const moveZ = state.dimensions === 3 ? dz * clamp : 0;
  frameMotion.set(node.id, { x: spent.x + moveX, y: spent.y + moveY, z: spent.z + moveZ });
  node.x = (node.x ?? 0) + moveX;
  node.y = (node.y ?? 0) + moveY;
  node.fx = node.x;
  node.fy = node.y;
  node.vx = (node.vx ?? 0) * 0.34 + moveX * 0.66;
  node.vy = (node.vy ?? 0) * 0.34 + moveY * 0.66;
  if (state.dimensions === 3) {
    node.z = (node.z ?? 0) + moveZ;
    node.fz = node.z;
    node.vz = (node.vz ?? 0) * 0.34 + moveZ * 0.66;
  }
  movedIds.add(node.id);
  return true;
}

function splitConstraint(
  state: DragRelaxationState,
  aId: string,
  a: DragNode,
  bId: string,
  b: DragNode,
  dx: number,
  dy: number,
  dz: number,
  movedIds: Set<string>,
  frameMotion: Map<string, DragAnchor>,
) {
  const aMass = inverseMass(state, aId);
  const bMass = inverseMass(state, bId);
  const total = aMass + bMass;
  if (total <= 0) return;
  if (aMass > 0) displaceNode(state, a, dx * (aMass / total), dy * (aMass / total), dz * (aMass / total), movedIds, frameMotion);
  if (bMass > 0) displaceNode(state, b, -dx * (bMass / total), -dy * (bMass / total), -dz * (bMass / total), movedIds, frameMotion);
  syncGridNode(state, aId, a);
  syncGridNode(state, bId, b);
}

/** Build the immutable-size spatial world once per graph/layout, then reuse it. */
export function createDragRelaxationWorld(
  nodeById: Map<string, DragNode>,
  radiusFor: (node: DragNode) => number,
  options: DragRelaxationWorldOptions,
): DragRelaxationWorld {
  const radii = new Map<string, number>();
  const nodeIndices = new Map<string, number>();
  let maxRadius = 0.25;
  for (const [id, node] of nodeById) {
    nodeIndices.set(id, nodeIndices.size);
    const radius = Math.max(0.25, Math.min(50, Number(radiusFor(node)) || 1));
    radii.set(id, radius);
    maxRadius = Math.max(maxRadius, radius);
  }
  const collisionPadding = Math.max(0, options.collisionPadding ?? (options.dimensions === 3 ? 0.32 : 0.38));
  const world: DragRelaxationWorld = {
    dimensions: options.dimensions,
    radii,
    grid: new Map(),
    cellById: new Map(),
    nodeIndices,
    nodeCount: Math.max(1, nodeIndices.size),
    maxRadius,
    cellSize: Math.max(2, options.cellSize ?? (maxRadius * 2 + collisionPadding)),
  };
  for (const [id, node] of nodeById) syncGridNode(world, id, node);
  return world;
}

/**
 * Create one local collision world for a pointer transaction. Every mapped
 * node is indexed once, but only the bounded `weights` set is allowed to move.
 * A collision can admit a nearby unconnected node into that set, which is the
 * small chain reaction missing from the previous weighted-copy drag.
 */
export function createDragRelaxation(
  rootId: string,
  nodeById: Map<string, DragNode>,
  influence: Map<string, number>,
  radiusFor: (node: DragNode) => number,
  options: DragRelaxationOptions,
) {
  const dimensions = options.dimensions;
  const maxNodes = Math.max(2, Math.floor(options.maxNodes ?? (dimensions === 3 ? 192 : 720)));
  const collisionPadding = Math.max(0, options.collisionPadding ?? (dimensions === 3 ? 0.32 : 0.38));
  const world = options.world?.dimensions === dimensions
    ? options.world
    : createDragRelaxationWorld(nodeById, radiusFor, {
      dimensions,
      collisionPadding,
      cellSize: options.cellSize,
    });
  const state: DragRelaxationState = {
    rootId,
    dimensions,
    weights: new Map(),
    anchors: new Map(),
    restLengths: new Map(),
    springPairs: [],
    springPairKeys: new Set(),
    springIndexed: new Set(),
    radii: world.radii,
    grid: world.grid,
    cellById: world.cellById,
    nodeIndices: world.nodeIndices,
    nodeCount: world.nodeCount,
    maxRadius: world.maxRadius,
    maxNodes,
    collisionPadding,
    collisionStrength: Math.max(0, options.collisionStrength ?? 0.72),
    linkStrength: Math.max(0, options.linkStrength ?? (dimensions === 3 ? 0.075 : 0.09)),
    anchorStrength: Math.max(0, options.anchorStrength ?? (dimensions === 3 ? 0.008 : 0.012)),
    maxStep: Math.max(0.1, options.maxStep ?? (dimensions === 3 ? 2.4 : 4.8)),
    cellSize: world.cellSize,
  };

  // Always retain the grabbed node even when a malformed caller omitted it.
  activateNode(state, rootId, nodeById, 1);
  if (options.rootAnchor && state.anchors.has(rootId)) {
    state.anchors.set(rootId, {
      x: options.rootAnchor.x,
      y: options.rootAnchor.y,
      z: options.rootAnchor.z ?? nodeById.get(rootId)?.z ?? 0,
    });
  }
  for (const [id, weight] of influence) {
    if (id === rootId) continue;
    if (state.weights.size >= state.maxNodes) break;
    activateNode(state, id, nodeById, Math.max(0, Math.min(1, weight)));
  }
  return state;
}

function constraintDirection(
  state: DragRelaxationState,
  aId: string,
  a: DragNode,
  bId: string,
  b: DragNode,
) {
  const dx = (b.x ?? 0) - (a.x ?? 0);
  const dy = (b.y ?? 0) - (a.y ?? 0);
  const dz = state.dimensions === 3 ? (b.z ?? 0) - (a.z ?? 0) : 0;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > 1e-7) return { x: dx / distance, y: dy / distance, z: dz / distance, distance };
  return { ...deterministicDirection(aId, bId, state.dimensions), distance: 0 };
}

function anchorDistance(state: DragRelaxationState, aId: string, bId: string) {
  const a = state.anchors.get(aId);
  const b = state.anchors.get(bId);
  if (!a || !b) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y, state.dimensions === 3 ? b.z - a.z : 0);
}

/**
 * Index each active node's real synapses once per pointer transaction. A root
 * can have thousands of children, so rebuilding and sorting all of its links
 * on every animation frame creates exactly the jank this local solver avoids.
 * Collision-admitted nodes are indexed lazily when they join the moving field.
 */
function indexActiveSprings(
  state: DragRelaxationState,
  neighbors: Map<string, Set<string>>,
) {
  if (state.springIndexed.size === state.weights.size) return;
  let added = false;
  for (const aId of [...state.weights.keys()].sort()) {
    if (state.springIndexed.has(aId)) continue;
    for (const bId of [...(neighbors.get(aId) ?? [])].sort()) {
      if (!state.weights.has(bId)) continue;
      const key = pairKey(aId, bId);
      if (state.springPairKeys.has(key)) continue;
      state.springPairKeys.add(key);
      state.springPairs.push(aId < bId ? [aId, bId] : [bId, aId]);
      added = true;
    }
    state.springIndexed.add(aId);
  }
  if (added) {
    state.springPairs.sort(([aSource, aTarget], [bSource, bTarget]) => (
      aSource.localeCompare(bSource) || aTarget.localeCompare(bTarget)
    ));
  }
}

/** Run a few deterministic position-based force iterations for one animation frame. */
export function stepDragRelaxation(
  state: DragRelaxationState,
  nodeById: Map<string, DragNode>,
  neighbors: Map<string, Set<string>>,
  stepOptions: DragRelaxationStepOptions = {},
): DragRelaxationResult {
  const iterations = Math.max(1, Math.min(8, Math.floor(stepOptions.iterations ?? 2)));
  const temperature = Math.max(0.12, Math.min(1, stepOptions.temperature ?? 1));
  const movedIds = new Set<string>();
  const frameMotion = new Map<string, DragAnchor>();
  let added = 0;
  let collisions = 0;
  let maxOverlap = 0;

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const id of state.weights.keys()) {
      const node = nodeById.get(id);
      if (node) syncGridNode(state, id, node);
    }

    const seenPairs = new Set<number>();
    const activeIds = [...state.weights.keys()].sort();
    for (const aId of activeIds) {
      const a = nodeById.get(aId);
      if (!a || !finitePosition(a)) continue;
      const aRadius = state.radii.get(aId) ?? 1;
      const coords = cellCoordinates(a, state);
      const range = Math.max(1, Math.ceil((aRadius + state.maxRadius + state.collisionPadding) / state.cellSize));
      for (let x = coords.x - range; x <= coords.x + range; x++) {
        for (let y = coords.y - range; y <= coords.y + range; y++) {
          const minZ = state.dimensions === 3 ? coords.z - range : 0;
          const maxZ = state.dimensions === 3 ? coords.z + range : 0;
          for (let z = minZ; z <= maxZ; z++) {
            const bucket = state.grid.get(cellKey(x, y, z, state.dimensions));
            if (!bucket) continue;
            for (const bId of bucket) {
              if (bId === aId) continue;
              const aIndex = state.nodeIndices.get(aId);
              const bIndex = state.nodeIndices.get(bId);
              if (aIndex == null || bIndex == null) continue;
              const key = Math.min(aIndex, bIndex) * state.nodeCount + Math.max(aIndex, bIndex);
              if (seenPairs.has(key)) continue;
              seenPairs.add(key);
              const b = nodeById.get(bId);
              if (!b || !finitePosition(b)) continue;
              const direction = constraintDirection(state, aId, a, bId, b);
              const desired = aRadius + (state.radii.get(bId) ?? 1) + state.collisionPadding;
              const overlap = desired - direction.distance;
              if (overlap <= 0) continue;
              if (!state.weights.has(bId) && activateNode(state, bId, nodeById, 0)) added += 1;
              const bCanMove = state.weights.has(bId);
              const correction = Math.min(state.maxStep, overlap * state.collisionStrength);
              // `splitConstraint` expects A's displacement; separate the pair by
              // moving A opposite the A→B unit vector and B in its direction.
              if (bCanMove) {
                splitConstraint(
                  state,
                  aId,
                  a,
                  bId,
                  b,
                  -direction.x * correction,
                  -direction.y * correction,
                  -direction.z * correction,
                  movedIds,
                  frameMotion,
                );
              } else if (aId !== state.rootId) {
                displaceNode(
                  state,
                  a,
                  -direction.x * correction,
                  -direction.y * correction,
                  -direction.z * correction,
                  movedIds,
                  frameMotion,
                );
                syncGridNode(state, aId, a);
              }
              collisions += 1;
              maxOverlap = Math.max(maxOverlap, overlap);
            }
          }
        }
      }
    }

    indexActiveSprings(state, neighbors);
    for (const [aId, bId] of state.springPairs) {
      const a = nodeById.get(aId);
      if (!a) continue;
      const b = nodeById.get(bId);
      if (!b) continue;
      const key = pairKey(aId, bId);
      const direction = constraintDirection(state, aId, a, bId, b);
      let rest = state.restLengths.get(key);
      if (rest == null) {
        rest = Math.max(
          anchorDistance(state, aId, bId),
          (state.radii.get(aId) ?? 1) + (state.radii.get(bId) ?? 1) + state.collisionPadding,
        );
        state.restLengths.set(key, rest);
      }
      const error = direction.distance - rest;
      if (Math.abs(error) <= 1e-4) continue;
      const correction = Math.max(-state.maxStep, Math.min(state.maxStep, error * state.linkStrength * temperature));
      splitConstraint(
        state,
        aId,
        a,
        bId,
        b,
        direction.x * correction,
        direction.y * correction,
        direction.z * correction,
        movedIds,
        frameMotion,
      );
    }

    for (const [id, weight] of state.weights) {
      if (id === state.rootId) continue;
      const node = nodeById.get(id);
      const anchor = state.anchors.get(id);
      if (!node || !anchor) continue;
      const strength = state.anchorStrength * (1 - Math.min(0.88, weight)) * temperature;
      displaceNode(
        state,
        node,
        (anchor.x - (node.x ?? 0)) * strength,
        (anchor.y - (node.y ?? 0)) * strength,
        (anchor.z - (node.z ?? 0)) * strength,
        movedIds,
        frameMotion,
      );
      syncGridNode(state, id, node);
    }
  }

  return {
    activeCount: state.weights.size,
    added,
    collisions,
    movedIds,
    maxOverlap,
    maxDisplacement: Math.max(0, ...[...frameMotion.values()].map((motion) => (
      Math.hypot(motion.x, motion.y, state.dimensions === 3 ? motion.z : 0)
    ))),
  };
}

/**
 * Build a bounded, deterministic elastic field around a dragged node. Direct
 * synapses follow strongly; their neighbours receive a smaller after-pull. The
 * cap protects the main thread when a project root has thousands of children.
 */
export function dragInfluence(
  rootId: string,
  neighbors: Map<string, Set<string>>,
  options: DragFieldOptions = {},
) {
  const firstHopWeight = options.firstHopWeight ?? DEFAULT_FIRST_HOP;
  const secondHopWeight = options.secondHopWeight ?? DEFAULT_SECOND_HOP;
  const maxNodes = Math.max(1, options.maxNodes ?? DEFAULT_MAX_NODES);
  const influence = new Map<string, number>([[rootId, 1]]);
  const distanceFor = options.distanceFor;
  const ranked = (ids: Iterable<string>) => [...ids].sort((a, b) => {
    const aDistance = distanceFor ? distanceFor(a) : 0;
    const bDistance = distanceFor ? distanceFor(b) : 0;
    const finiteA = Number.isFinite(aDistance) ? aDistance : Number.POSITIVE_INFINITY;
    const finiteB = Number.isFinite(bDistance) ? bDistance : Number.POSITIVE_INFINITY;
    return finiteA - finiteB || a.localeCompare(b);
  });

  const addLevel = (ids: Iterable<string>, weight: number) => {
    for (const id of ranked(ids)) {
      if (influence.size >= maxNodes) break;
      if (!influence.has(id)) influence.set(id, weight);
    }
  };

  const firstHop = neighbors.get(rootId) ?? new Set<string>();
  addLevel(firstHop, firstHopWeight);
  if (influence.size >= maxNodes) return influence;

  const secondHop = new Set<string>();
  for (const id of firstHop) {
    for (const neighborId of neighbors.get(id) ?? []) {
      if (neighborId !== rootId && !influence.has(neighborId)) secondHop.add(neighborId);
    }
  }
  addLevel(secondHop, secondHopWeight);
  return influence;
}

/** Move already-pinned neighbours by the incremental drag delta. */
export function applyDragDelta(
  nodeById: Map<string, DragNode>,
  influence: Map<string, number>,
  delta: DragDelta2D | DragDelta3D,
) {
  let moved = 0;
  for (const [id, weight] of influence) {
    if (weight >= 1) continue; // the force-graph library moves the grabbed node
    const node = nodeById.get(id);
    if (!node) continue;
    const nextX = (node.x ?? 0) + delta.x * weight;
    const nextY = (node.y ?? 0) + delta.y * weight;
    node.x = nextX;
    node.y = nextY;
    node.fx = nextX;
    node.fy = nextY;
    node.vx = delta.x * weight * 0.16;
    node.vy = delta.y * weight * 0.16;
    if ('z' in delta) {
      const nextZ = (node.z ?? 0) + delta.z * weight;
      node.z = nextZ;
      node.fz = nextZ;
      node.vz = delta.z * weight * 0.16;
    }
    moved++;
  }
  return moved;
}

export function pinAtCurrentPosition(node: DragNode, dimensions: 2 | 3) {
  node.fx = node.x ?? 0;
  node.fy = node.y ?? 0;
  node.vx = 0;
  node.vy = 0;
  if (dimensions === 3) {
    node.fz = node.z ?? 0;
    node.vz = 0;
  }
}

export function adjacencyFromLinks(
  nodeIds: Iterable<string>,
  links: Iterable<{ source: unknown; target: unknown; __sourceId?: string; __targetId?: string }>,
) {
  const neighbors = new Map<string, Set<string>>();
  for (const id of nodeIds) neighbors.set(id, new Set());
  const endpointId = (value: unknown) => typeof value === 'object' && value && 'id' in value
    ? String((value as { id: unknown }).id)
    : String(value);
  for (const link of links) {
    const source = link.__sourceId ?? endpointId(link.source);
    const target = link.__targetId ?? endpointId(link.target);
    if (!neighbors.has(source) || !neighbors.has(target)) continue;
    neighbors.get(source)!.add(target);
    neighbors.get(target)!.add(source);
  }
  return neighbors;
}
