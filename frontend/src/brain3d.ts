import type { BrainData, BrainLink, BrainNode } from './types';

export const BRAIN3D_SCENE = {
  fogColor: '#05070d',
  fogDensity: 0.00155,
  bloomStrength: 0.56,
  bloomRadius: 0.42,
  bloomThreshold: 0.38,
} as const;

export const CAMERA_PRESETS_3D = {
  whole: { position: { x: 340, y: 170, z: 480 }, lookAt: { x: 0, y: 0, z: 0 } },
  left: { position: { x: 120, y: 90, z: -470 }, lookAt: { x: 0, y: 0, z: -34 } },
  right: { position: { x: 120, y: 90, z: 470 }, lookAt: { x: 0, y: 0, z: 34 } },
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
  const radius = visibleNodes.reduce((value, node) => Math.max(
    value,
    Math.hypot(node.x - center.x, node.y - center.y, node.z - center.z),
  ), 0) + 18;
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
  const distance = radius / Math.sin(limitingHalfFov) * 1.05;
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

const AXIS = { x: 230, y: 150, z: 185 } as const;
const KIND_RADIUS: Record<string, [number, number]> = {
  root: [0.15, 0.05],
  dir: [0.4, 0.08],
  file: [0.66, 0.16],
  page: [0.92, 0.05],
  ephemeral: [0.58, 0.1],
};
const LOBE_Z: Record<string, number> = { api: 0.55, web: -0.55, ops: 0.55, lab: -0.55 };
const LOBE_X: Record<string, number> = { api: 0.4, web: 0.4, ops: -0.45, lab: -0.45 };
const LOBE_Y: Record<string, number> = { vault: 0.5, ephemeral: -0.85 };

function seedClonedPositions(nodes: BrainNode[]) {
  for (const node of nodes as Array<BrainNode & { tr?: number }>) {
    const [center, jitter] = KIND_RADIUS[node.kind] ?? [0.66, 0.12];
    const rawRadius = center + (hash01(`${node.id}:radius`) * 2 - 1) * jitter;
    const radius = node.layer === 'c2b' ? rawRadius * 0.28 : rawRadius;
    const theta = hash01(`${node.id}:theta`) * Math.PI * 2;
    const phi = Math.acos(2 * hash01(`${node.id}:phi`) - 1);
    let x = radius * Math.sin(phi) * Math.cos(theta);
    let y = radius * Math.cos(phi);
    let z = radius * Math.sin(phi) * Math.sin(theta);
    const lobeZ = LOBE_Z[node.layer];
    if (lobeZ !== undefined) z = lobeZ * radius + z * 0.45;
    const lobeX = LOBE_X[node.layer];
    if (lobeX !== undefined) x = lobeX * radius + x * 0.5;
    const lobeY = LOBE_Y[node.layer];
    if (lobeY !== undefined) y = lobeY * radius + y * 0.3;
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
    const rootEdge = kindById.get(link.__sourceId) === 'root' || kindById.get(link.__targetId) === 'root';
    const overview = link.type === 'xlayer'
      || link.type === 'link'
      || rootEdge
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
    for (const node of graph.nodes) {
      if (node.kind !== 'file' || node.__degreeTier >= 1) nodeIds.add(node.id);
    }
  }

  const kindById = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const links = visibleLinks.filter((link) => {
    if (!nodeIds.has(link.__sourceId) || !nodeIds.has(link.__targetId)) return false;
    if (focusIds) return true;
    const rootEdge = kindById.get(link.__sourceId) === 'root' || kindById.get(link.__targetId) === 'root';
    return link.type === 'xlayer'
      || rootEdge
      || hash32(`${link.__sourceId}>${link.__targetId}`) % 4 === 0;
  });

  return {
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    links,
  };
}

export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
