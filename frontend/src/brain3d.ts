import type { BrainData, BrainLink, BrainNode } from './types';

export const BRAIN3D_SCENE = {
  fogColor: '#030708',
  fogDensity: 0.00072,
  bloomStrength: 0.2,
  bloomRadius: 0.1,
  bloomThreshold: 0.82,
} as const;

export const CAMERA_PRESETS_3D = {
  whole: { position: { x: 590, y: 64, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } },
  left: { position: { x: 80, y: 70, z: -520 }, lookAt: { x: 0, y: 0, z: -24 } },
  right: { position: { x: 80, y: 70, z: 520 }, lookAt: { x: 0, y: 0, z: 24 } },
} as const;

export type CameraPreset3D = keyof typeof CAMERA_PRESETS_3D | 'selected';

type Point3D = { x: number; y: number; z: number };

export interface CameraViewport3D {
  width: number;
  height: number;
  safeTop: number;
  bottomPadding: number;
  fov: number;
}

export type BrainNode3D = BrainNode & {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx: number;
  fy: number;
  fz: number;
  tr?: number;
  __targetX: number;
  __targetY: number;
  __targetZ: number;
  __value: number;
  __degreeTier: number;
};

export type BrainLink3D = BrainLink & {
  source: string | BrainNode3D;
  target: string | BrainNode3D;
  __sourceId: string;
  __targetId: string;
  __tier: number;
  __styleKey: string;
  __overview: boolean;
};

export interface BrainGraph3D {
  nodes: BrainNode3D[];
  links: BrainLink3D[];
  degree: Map<string, number>;
  neighbors: Map<string, Set<string>>;
  nodeValueBuckets: number;
  styleBuckets: number;
  overviewVisibleLinkCount: number;
}

export interface LiveSignalSegment3D {
  originId: string;
  sourceId: string;
  targetId: string;
  depth: number;
  type: BrainLink['type'];
}

export const LIVE_SIGNAL_LIMITS = {
  // The live layer is a small GPU/canvas overlay. It can span the local file
  // hierarchy plus semantic/code bridges without rebuilding the 20k-node atlas.
  maxSources: 16,
  maxSegmentsPerSource: 64,
  maxHops: 4,
  branchesPerNode: 4,
  trailPointsPerSegment: 3,
} as const;

/** Screen-space presentation keeps multi-agent action potentials legible over the dense atlas. */
export const LIVE_SIGNAL_PRESENTATION = {
  routeWidthPx: 2,
  routeGlowWidthPx: 4.4,
  sourceNeuronSizePx: 54,
  sourceHaloSizePx: 86,
  headSizePx: 10.5,
  trailSizePx: 5.6,
  staticNodeContrast: 0.56,
  staticLinkContrast: 0.24,
  staticFieldContrast: 0.5,
  staticMorphologyContrast: 0.66,
} as const;

export const LIVE_SIGNAL_DURATION_MS = 9000;

/** Keep the two per-origin animation clocks paired and bounded in long-lived views. */
export function pruneLiveSignalTimings(
  now: number,
  starts: Map<string, number>,
  expiries: Map<string, number>,
) {
  let removed = 0;
  for (const [key, until] of expiries) {
    if (until > now && starts.has(key)) continue;
    expiries.delete(key);
    starts.delete(key);
    removed += 1;
  }
  for (const key of starts.keys()) {
    if (expiries.has(key)) continue;
    starts.delete(key);
    removed += 1;
  }
  return removed;
}

export const CONNECTOME_LINK_BUDGETS = {
  // Every non-root neuron has one hierarchy tract. Keeping all of them makes a
  // live action potential travel over a line that was already present on screen.
  contains: 22000,
  code: 2000,
  // These sparse semantic/vault edges are cheap enough to retain completely and
  // cover pages that intentionally have no containment parent.
  link: 2000,
  xlayer: 1000,
} as const;

export type ConnectomeLinkType = keyof typeof CONNECTOME_LINK_BUDGETS;

export interface BatchedConnectome3D {
  nodePositions: Float32Array;
  nodeIndex: Map<string, number>;
  linkPositions: Record<ConnectomeLinkType, Float32Array>;
  linkOffsets: Map<string, Array<{ type: ConnectomeLinkType; offset: number }>>;
  links: BrainLink3D[];
  linkTypeCounts: Record<ConnectomeLinkType, number>;
  digest: string;
}

function normalize3D(value: Point3D): Point3D {
  const length = Math.hypot(value.x, value.y, value.z) || 1;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function cross3D(a: Point3D, b: Point3D): Point3D {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function cameraFrameForNodes3D(
  nodes: BrainNode3D[],
  preset: { position: Point3D; lookAt: Point3D },
  viewport: CameraViewport3D,
) {
  const visibleNodes = nodes.length ? nodes : [{ x: 0, y: 0, z: 0 } as BrainNode3D];
  const bounds = visibleNodes.reduce((result, node) => ({
    minX: Math.min(result.minX, node.x),
    maxX: Math.max(result.maxX, node.x),
    minY: Math.min(result.minY, node.y),
    maxY: Math.max(result.maxY, node.y),
    minZ: Math.min(result.minZ, node.z),
    maxZ: Math.max(result.maxZ, node.z),
  }), {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  });
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
  const view = normalize3D({
    x: preset.lookAt.x - preset.position.x,
    y: preset.lookAt.y - preset.position.y,
    z: preset.lookAt.z - preset.position.z,
  });
  let right = normalize3D(cross3D(view, { x: 0, y: 1, z: 0 }));
  if (Math.hypot(right.x, right.y, right.z) < 0.5) right = { x: 1, y: 0, z: 0 };
  const up = normalize3D(cross3D(right, view));
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const safeTop = Math.max(0, Math.min(height - 1, viewport.safeTop));
  const bottomPadding = Math.max(0, Math.min(height - safeTop - 1, viewport.bottomPadding));
  const verticalHalfFov = Math.max(0.01, viewport.fov * Math.PI / 360);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * width / height);
  const availableHeight = Math.max(1, height - safeTop - bottomPadding);
  const availableWidth = Math.max(1, width - 32);
  const safeVerticalHalfFov = Math.atan(Math.tan(verticalHalfFov) * availableHeight / height);
  const safeHorizontalHalfFov = Math.atan(Math.tan(horizontalHalfFov) * availableWidth / width);
  const limitingHalfFov = Math.max(0.01, Math.min(safeVerticalHalfFov, safeHorizontalHalfFov));
  let halfWidth = 18;
  let halfHeight = 18;
  for (const node of visibleNodes) {
    const relative = { x: node.x - center.x, y: node.y - center.y, z: node.z - center.z };
    halfWidth = Math.max(halfWidth, Math.abs(relative.x * right.x + relative.y * right.y + relative.z * right.z) + 18);
    halfHeight = Math.max(halfHeight, Math.abs(relative.x * up.x + relative.y * up.y + relative.z * up.z) + 18);
  }
  const distance = Math.max(
    halfWidth / Math.tan(safeHorizontalHalfFov),
    halfHeight / Math.tan(safeVerticalHalfFov),
  ) * 1.085;
  const desiredCenterY = (safeTop + height - bottomPadding) / 2;
  const centerShiftPixels = desiredCenterY - height / 2;
  const worldPerPixel = 2 * distance * Math.tan(verticalHalfFov) / height;
  const shift = centerShiftPixels * worldPerPixel;
  const lookAt = {
    x: center.x + up.x * shift,
    y: center.y + up.y * shift,
    z: center.z + up.z * shift,
  };
  const position = {
    x: center.x - view.x * distance + up.x * shift,
    y: center.y - view.y * distance + up.y * shift,
    z: center.z - view.z * distance + up.z * shift,
  };
  return { position, lookAt };
}

function hash32(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function hash01(value: string) {
  return hash32(value) / 4294967295;
}

const AXIS = { x: 190, y: 124, z: 145 } as const;
const KIND_RADIUS: Record<string, [number, number]> = {
  root: [0.31, 0.045],
  dir: [0.46, 0.08],
  file: [0.74, 0.12],
  page: [0.9, 0.045],
  ephemeral: [0.63, 0.08],
};

function layerBias(layer: string) {
  if (layer === 'vault') return { x: 0, y: 0.16, z: 0 };
  if (layer === 'ephemeral') return { x: -0.08, y: -0.34, z: 0 };
  if (layer === 'asm') return { x: 0, y: 0, z: 0 };
  const angle = hash01(`${layer}:lobe`) * Math.PI * 2;
  return { x: Math.cos(angle) * 0.09, y: Math.sin(angle * 1.7) * 0.05, z: Math.sin(angle) * 0.08 };
}

function seedClonedPositions(nodes: BrainNode[]) {
  for (const node of nodes as Array<BrainNode & { tr?: number }>) {
    const [center, jitter] = KIND_RADIUS[node.kind] ?? [0.66, 0.12];
    const rawRadius = center + (hash01(`${node.id}:radius`) * 2 - 1) * jitter;
    const radius = node.layer === 'asm' ? rawRadius * 0.27 : rawRadius;
    const theta = hash01(`${node.id}:theta`) * Math.PI * 2;
    const phi = Math.acos(2 * hash01(`${node.id}:phi`) - 1);
    let x = radius * Math.sin(phi) * Math.cos(theta);
    let y = radius * Math.cos(phi);
    const localLateral = radius * Math.sin(phi) * Math.sin(theta);
    const lowerTaper = 0.64 + 0.36 * Math.pow(Math.max(0, (y + 1) / 2), 0.34);
    x *= lowerTaper;
    if (y < -0.58) y = -0.58 + (y + 0.58) * 0.72;
    // Subtle semantic lobe bias keeps each layer locally legible without pulling the
    // connectome out of anatomical shape. The hemisphere remains data-driven.
    const bias = layerBias(node.layer);
    x += bias.x * radius;
    y += bias.y * radius;
    let z: number;
    if (node.layer === 'asm') {
      z = localLateral * 0.28 + bias.z * radius;
    } else {
      const side = hash01(`${node.id}:hemisphere`) >= 0.5 ? 1 : -1;
      const center = 0.1 + radius * 0.37;
      z = side * center + localLateral * 0.29 * lowerTaper + bias.z * radius * 0.35;
      if (Math.sign(z) !== side || Math.abs(z) < 0.065) z = side * (0.065 + Math.abs(z) * 0.12);
    }
    node.tr = radius;
    node.x = x * AXIS.x;
    node.y = y * AXIS.y;
    node.z = z * AXIS.z;
  }
}

export function linkEndpointId(value: unknown) {
  return typeof value === 'object' && value && 'id' in value ? String((value as BrainNode).id) : String(value);
}

function cloneNode(node: BrainNode) {
  const runtime = node as BrainNode & Record<string, unknown>;
  const {
    x: _x, y: _y, z: _z,
    vx: _vx, vy: _vy, vz: _vz,
    fx: _fx, fy: _fy, fz: _fz,
    index: _index, tr: _tr,
    __targetX: _targetX, __targetY: _targetY, __targetZ: _targetZ,
    __value: _value, __degreeTier: _degreeTier,
    ...clean
  } = runtime;
  return {
    ...clean,
    meta: node.meta ? { ...node.meta, tags: node.meta.tags ? [...node.meta.tags] : undefined } : undefined,
  } as BrainNode;
}

function degreeTier(value: number) {
  if (value >= 64) return 3;
  if (value >= 24) return 2;
  if (value >= 8) return 1;
  return 0;
}

const KIND_VALUE: Record<string, number> = { root: 10, dir: 6, page: 4, file: 2, ephemeral: 3 };
const LINK_TIER: Record<string, number> = { contains: 0, code: 1, link: 2, xlayer: 3 };

export function buildBrainGraph3D(data: BrainData): BrainGraph3D {
  const seeded = data.nodes.map(cloneNode);
  seedClonedPositions(seeded);

  const kindById = new Map(seeded.map((node) => [node.id, node.kind]));
  const degree = new Map<string, number>();
  const neighbors = new Map<string, Set<string>>(seeded.map((node) => [node.id, new Set<string>()]));

  const clonedLinks = data.links.map((link) => {
    const source = linkEndpointId(link.source);
    const target = linkEndpointId(link.target);
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
    neighbors.get(source)?.add(target);
    neighbors.get(target)?.add(source);
    return { ...link, source, target, __sourceId: source, __targetId: target };
  });

  const nodes = seeded.map((node) => {
    const tier = degreeTier(degree.get(node.id) ?? 0);
    return {
      ...node,
      x: node.x ?? 0,
      y: node.y ?? 0,
      z: node.z ?? 0,
      vx: 0,
      vy: 0,
      vz: 0,
      fx: node.x ?? 0,
      fy: node.y ?? 0,
      fz: node.z ?? 0,
      __targetX: node.x ?? 0,
      __targetY: node.y ?? 0,
      __targetZ: node.z ?? 0,
      __value: (KIND_VALUE[node.kind] ?? 3) + tier * 2,
      __degreeTier: tier,
    } as BrainNode3D;
  });

  const links = clonedLinks.map((link) => {
    const tier = LINK_TIER[link.type] ?? 0;
    const endpointDegree = Math.max(degree.get(link.__sourceId) ?? 0, degree.get(link.__targetId) ?? 0);
    const sourceKind = kindById.get(link.__sourceId);
    const targetKind = kindById.get(link.__targetId);
    const rootEdge = sourceKind === 'root' || targetKind === 'root';
    const structuralRootEdge = rootEdge
      && hash32(`${link.__sourceId}>${link.__targetId}:root`) % 29 === 0;
    const overview = link.type === 'xlayer'
      || link.type === 'link'
      || structuralRootEdge
      || (link.type === 'code' && endpointDegree >= 24 && hash32(`${link.__sourceId}>${link.__targetId}`) % 3 === 0);
    return {
      ...link,
      __tier: tier,
      __overview: overview,
      __styleKey: `${tier}:${overview ? 1 : 0}`,
    } as BrainLink3D;
  });

  return {
    nodes,
    links,
    degree,
    neighbors,
    nodeValueBuckets: new Set(nodes.map((node) => node.__value)).size,
    styleBuckets: new Set(links.map((link) => link.__styleKey)).size,
    overviewVisibleLinkCount: links.filter((link) => link.__overview).length,
  };
}

export function digestBrainTargets(nodes: BrainNode3D[]) {
  const canonical = [...nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => `${node.id}:${node.__targetX.toFixed(3)},${node.__targetY.toFixed(3)},${node.__targetZ.toFixed(3)}`)
    .join('|');
  return hash32(canonical).toString(16).padStart(8, '0');
}

export function focusNeighborhood3D(id: string | null, neighbors: Map<string, Set<string>>) {
  if (!id) return null;
  return new Set([id, ...(neighbors.get(id) ?? [])]);
}

/**
 * Build a small deterministic action-potential route over the real knowledge graph.
 * This route is deliberately independent from the interactive ForceGraph LOD: an
 * ordinary file can light its parent/code neighbours even when it is not one of the
 * 1,200 sprites retained for pointer hit-testing.
 */
export function buildLiveSignalSegments3D(
  graph: BrainGraph3D,
  sourceIds: Iterable<string | { id: string; originId: string }>,
  limits: Partial<typeof LIVE_SIGNAL_LIMITS> = {},
  routeLinks: BrainLink3D[] = graph.links,
) {
  const maxSources = Math.max(0, Math.floor(limits.maxSources ?? LIVE_SIGNAL_LIMITS.maxSources));
  const maxSegmentsPerSource = Math.max(0, Math.floor(
    limits.maxSegmentsPerSource ?? LIVE_SIGNAL_LIMITS.maxSegmentsPerSource,
  ));
  const maxHops = Math.max(0, Math.floor(limits.maxHops ?? LIVE_SIGNAL_LIMITS.maxHops));
  const branchesPerNode = Math.max(1, Math.floor(
    limits.branchesPerNode ?? LIVE_SIGNAL_LIMITS.branchesPerNode,
  ));
  const known = new Set(graph.nodes.map((node) => node.id));
  const linksByNode = new Map<string, BrainLink3D[]>();
  for (const link of routeLinks) {
    const sourceLinks = linksByNode.get(link.__sourceId) ?? [];
    sourceLinks.push(link);
    linksByNode.set(link.__sourceId, sourceLinks);
    const targetLinks = linksByNode.get(link.__targetId) ?? [];
    targetLinks.push(link);
    linksByNode.set(link.__targetId, targetLinks);
  }

  const typePriority: Record<BrainLink['type'], number> = {
    code: 0,
    xlayer: 1,
    link: 2,
    contains: 3,
  };
  const sources: Array<{ id: string; originId: string }> = [];
  const seenOrigins = new Set<string>();
  for (const source of sourceIds) {
    const id = typeof source === 'string' ? source : source.id;
    const originId = typeof source === 'string' ? source : source.originId;
    if (!known.has(id) || seenOrigins.has(originId)) continue;
    seenOrigins.add(originId);
    sources.push({ id, originId });
    if (sources.length >= maxSources) break;
  }
  const segments: LiveSignalSegment3D[] = [];

  for (const { id: originNodeId, originId } of sources) {
    // A shared tract may carry signals from two agents at once. Deduplicate only
    // within one source so a busy lane cannot visually erase another agent.
    const sourceEdges = new Set<string>();
    const visited = new Set([originNodeId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: originNodeId, depth: 0 }];
    let sourceSegmentCount = 0;
    while (queue.length && sourceSegmentCount < maxSegmentsPerSource) {
      const current = queue.shift()!;
      if (current.depth >= maxHops) continue;
      const candidates = (linksByNode.get(current.id) ?? [])
        .map((link) => ({
          link,
          neighborId: link.__sourceId === current.id ? link.__targetId : link.__sourceId,
        }))
        .filter(({ neighborId }) => known.has(neighborId) && !visited.has(neighborId))
        .sort((a, b) => {
          const aParent = a.link.type === 'contains' && a.link.__targetId === current.id ? 0 : 1;
          const bParent = b.link.type === 'contains' && b.link.__targetId === current.id ? 0 : 1;
          return aParent - bParent
            || typePriority[a.link.type] - typePriority[b.link.type]
            || (graph.degree.get(b.neighborId) ?? 0) - (graph.degree.get(a.neighborId) ?? 0)
            || `${a.link.type}:${a.neighborId}`.localeCompare(`${b.link.type}:${b.neighborId}`);
        })
        .slice(0, current.depth === 0 ? branchesPerNode + 1 : branchesPerNode);

      for (const { link, neighborId } of candidates) {
        if (sourceSegmentCount >= maxSegmentsPerSource) break;
        visited.add(neighborId);
        queue.push({ id: neighborId, depth: current.depth + 1 });
        const edgeKey = [current.id, neighborId].sort().join('\u0000');
        if (sourceEdges.has(edgeKey)) continue;
        sourceEdges.add(edgeKey);
        segments.push({
          originId,
          sourceId: current.id,
          targetId: neighborId,
          depth: current.depth,
          type: link.type,
        });
        sourceSegmentCount += 1;
      }
    }
  }
  return segments;
}

export function digestLiveSignalSegments3D(segments: LiveSignalSegment3D[]) {
  const canonical = segments
    .map((segment) => `${segment.originId}:${segment.depth}:${segment.type}:${segment.sourceId}>${segment.targetId}`)
    .sort()
    .join('|');
  return hash32(canonical).toString(16).padStart(8, '0');
}

export function visibleLinks3D(links: BrainLink3D[], focusIds: Set<string> | null, activeIds: Set<string>) {
  return links.filter((link) => {
    const source = linkEndpointId(link.source);
    const target = linkEndpointId(link.target);
    const active = activeIds.has(source) || activeIds.has(target);
    if (focusIds) return active || (focusIds.has(source) && focusIds.has(target));
    return active || link.__overview;
  });
}

export function buildRenderGraph3D(
  graph: BrainGraph3D,
  visibleLinks: BrainLink3D[],
  focusIds: Set<string> | null,
) {
  const nodeIds = new Set<string>();
  if (focusIds) {
    for (const id of focusIds) nodeIds.add(id);
    for (const link of visibleLinks) {
      nodeIds.add(linkEndpointId(link.source));
      nodeIds.add(linkEndpointId(link.target));
    }
  } else {
    const priority = (node: BrainNode3D) => node.kind === 'root' ? 0
      : node.kind === 'dir' ? 1
        : node.kind === 'page' ? 2
          : node.__degreeTier >= 3 ? 3
            : node.__degreeTier >= 2 ? 4
              : 5;
    graph.nodes
      .slice()
      .sort((a, b) => priority(a) - priority(b)
        || (graph.degree.get(b.id) ?? 0) - (graph.degree.get(a.id) ?? 0)
        || hash32(a.id) - hash32(b.id))
      .slice(0, 1200)
      .forEach((node) => nodeIds.add(node.id));
  }

  const kindById = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const candidates = visibleLinks.filter((link) => {
    if (!nodeIds.has(link.__sourceId) || !nodeIds.has(link.__targetId)) return false;
    if (focusIds) return true;
    const rootEdge = kindById.get(link.__sourceId) === 'root' || kindById.get(link.__targetId) === 'root';
    return link.type === 'xlayer'
      || rootEdge
      || hash32(`${link.__sourceId}>${link.__targetId}`) % 6 === 0;
  });
  let links = candidates;
  if (!focusIds) {
    const degreeBudget = new Map<string, number>();
    links = candidates
      .slice()
      .sort((a, b) => b.__tier - a.__tier
        || hash32(`${a.__sourceId}>${a.__targetId}`) - hash32(`${b.__sourceId}>${b.__targetId}`))
      .filter((link) => {
        const sourceCap = kindById.get(link.__sourceId) === 'root' ? 10 : 16;
        const targetCap = kindById.get(link.__targetId) === 'root' ? 10 : 16;
        const sourceCount = degreeBudget.get(link.__sourceId) ?? 0;
        const targetCount = degreeBudget.get(link.__targetId) ?? 0;
        if (sourceCount >= sourceCap || targetCount >= targetCap) return false;
        degreeBudget.set(link.__sourceId, sourceCount + 1);
        degreeBudget.set(link.__targetId, targetCount + 1);
        return true;
      })
      .slice(0, 720);
  }

  return {
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    links,
  };
}

function linkDistanceSquared3D(link: BrainLink3D, nodeById: Map<string, BrainNode3D>) {
  const source = nodeById.get(link.__sourceId);
  const target = nodeById.get(link.__targetId);
  if (!source || !target) return Number.POSITIVE_INFINITY;
  return (source.x - target.x) ** 2 + (source.y - target.y) ** 2 + (source.z - target.z) ** 2;
}

/**
 * A deterministic whole-brain tract sample. The interactive ForceGraph layer is
 * intentionally small; this batched layer restores the local hierarchy and the
 * semantic cross-brain fibers in four draw calls.
 */
export function selectConnectomeLinks3D(
  graph: BrainGraph3D,
  budgets: Record<ConnectomeLinkType, number> = CONNECTOME_LINK_BUDGETS,
) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const kindById = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const selected: BrainLink3D[] = [];
  for (const type of Object.keys(CONNECTOME_LINK_BUDGETS) as ConnectomeLinkType[]) {
    const candidates = graph.links.filter((link) => (link.type || 'contains') === type);
    candidates.sort((a, b) => {
      if (type === 'contains') {
        const aStructural = ['root', 'dir', 'page'].includes(kindById.get(a.__targetId) ?? '') ? 0 : 1;
        const bStructural = ['root', 'dir', 'page'].includes(kindById.get(b.__targetId) ?? '') ? 0 : 1;
        if (aStructural !== bStructural) return aStructural - bStructural;
      }
      const distance = linkDistanceSquared3D(a, nodeById) - linkDistanceSquared3D(b, nodeById);
      return distance || hash32(`${a.__sourceId}>${a.__targetId}:${type}`) - hash32(`${b.__sourceId}>${b.__targetId}:${type}`);
    });
    selected.push(...candidates.slice(0, Math.max(0, Math.floor(budgets[type] ?? 0))));
  }
  return selected;
}

export function buildBatchedConnectome3D(graph: BrainGraph3D): BatchedConnectome3D {
  const nodeIndex = new Map<string, number>();
  const nodePositions = new Float32Array(graph.nodes.length * 3);
  graph.nodes.forEach((node, index) => {
    nodeIndex.set(node.id, index);
    nodePositions.set([node.x, node.y, node.z], index * 3);
  });
  const links = selectConnectomeLinks3D(graph);
  const grouped = new Map<ConnectomeLinkType, BrainLink3D[]>(
    (Object.keys(CONNECTOME_LINK_BUDGETS) as ConnectomeLinkType[]).map((type) => [type, []]),
  );
  for (const link of links) grouped.get((link.type || 'contains') as ConnectomeLinkType)?.push(link);
  const linkOffsets = new Map<string, Array<{ type: ConnectomeLinkType; offset: number }>>();
  const linkPositions = {} as Record<ConnectomeLinkType, Float32Array>;
  const linkTypeCounts = {} as Record<ConnectomeLinkType, number>;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const type of Object.keys(CONNECTOME_LINK_BUDGETS) as ConnectomeLinkType[]) {
    const typeLinks = grouped.get(type) ?? [];
    const positions = new Float32Array(typeLinks.length * 6);
    typeLinks.forEach((link, index) => {
      const source = nodeById.get(link.__sourceId);
      const target = nodeById.get(link.__targetId);
      if (!source || !target) return;
      const offset = index * 6;
      positions.set([source.x, source.y, source.z, target.x, target.y, target.z], offset);
      const sourceOffsets = linkOffsets.get(source.id) ?? [];
      sourceOffsets.push({ type, offset });
      linkOffsets.set(source.id, sourceOffsets);
      const targetOffsets = linkOffsets.get(target.id) ?? [];
      targetOffsets.push({ type, offset: offset + 3 });
      linkOffsets.set(target.id, targetOffsets);
    });
    linkPositions[type] = positions;
    linkTypeCounts[type] = typeLinks.length;
  }
  const canonical = links
    .map((link) => `${link.type}:${link.__sourceId}>${link.__targetId}`)
    .sort()
    .join('|');
  return {
    nodePositions,
    nodeIndex,
    linkPositions,
    linkOffsets,
    links,
    linkTypeCounts,
    digest: hash32(canonical).toString(16).padStart(8, '0'),
  };
}

export function syncBatchedConnectome3D(
  batch: BatchedConnectome3D,
  nodeById: Map<string, BrainNode3D>,
  ids?: Iterable<string>,
) {
  const changedTypes = new Set<ConnectomeLinkType>();
  const changedIds = ids ? [...ids] : [...batch.nodeIndex.keys()];
  for (const id of changedIds) {
    const node = nodeById.get(id);
    const index = batch.nodeIndex.get(id);
    if (!node || index == null) continue;
    batch.nodePositions.set([node.x, node.y, node.z], index * 3);
    for (const endpoint of batch.linkOffsets.get(id) ?? []) {
      batch.linkPositions[endpoint.type].set([node.x, node.y, node.z], endpoint.offset);
      changedTypes.add(endpoint.type);
    }
  }
  return changedTypes;
}

export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
