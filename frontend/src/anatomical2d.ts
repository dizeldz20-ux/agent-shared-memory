import type { BrainData, BrainNode } from './types';

export type AnatomicalNode2D = BrainNode & {
  __targetX: number;
  __targetY: number;
  __hemisphere: 'left' | 'right' | 'center';
  __region: string;
  fx?: number;
  fy?: number;
  vx?: number;
  vy?: number;
};

export type AnatomicalLink2D = BrainData['links'][number] & {
  source: string;
  target: string;
  __sourceId: string;
  __targetId: string;
  __curvature: number;
  __styleKey: string;
  __tier: number;
};

export type AnatomicalGraph2D = { nodes: AnatomicalNode2D[]; links: AnatomicalLink2D[] };

export function hash32(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function hash01(value: string) {
  return hash32(value) / 4294967295;
}

function linkId(value: unknown) {
  return typeof value === 'object' && value && 'id' in value ? String((value as BrainNode).id) : String(value);
}

const LAYER_BANDS: Record<string, { y: number; sx: number; sy: number; regions: string[] }> = {
  c2b: { y: 0, sx: 24, sy: 24, regions: ['bridge'] },
  vault: { y: -150, sx: 118, sy: 40, regions: ['upper-left', 'upper-right', 'bridge-left', 'bridge-right'] },
  api: { y: -88, sx: 135, sy: 58, regions: ['front-left', 'front-right', 'upper-left', 'upper-right'] },
  web: { y: 42, sx: 148, sy: 66, regions: ['middle-left', 'middle-right', 'lower-left', 'lower-right'] },
  ops: { y: 104, sx: 170, sy: 78, regions: ['rear-left', 'rear-right', 'middle-left', 'middle-right', 'lower-left', 'lower-right', 'upper-left', 'upper-right'] },
  lab: { y: 154, sx: 125, sy: 48, regions: ['posterior-left', 'posterior-right', 'lower-left', 'lower-right'] },
  ephemeral: { y: 192, sx: 68, sy: 26, regions: ['stem-left', 'stem-right', 'bridge'] },
};

function kindSpread(kind: string) {
  if (kind === 'root') return 0.16;
  if (kind === 'dir') return 0.45;
  if (kind === 'page') return 0.78;
  if (kind === 'ephemeral') return 0.55;
  return 0.9;
}

function regionBase(region: string, bandY: number) {
  const left = region.includes('left');
  const right = region.includes('right');
  const side = left ? -1 : right ? 1 : 0;
  const x = region.includes('bridge') ? side * 58 : side * 168;
  const y = bandY + (region.includes('upper') || region.includes('front') ? -22 : region.includes('lower') || region.includes('posterior') || region.includes('stem') ? 20 : 0);
  return { x, y, hemisphere: side < 0 ? 'left' : side > 0 ? 'right' : 'center' } as const;
}

function targetFor(node: BrainNode, indexInLayer: number) {
  const band = LAYER_BANDS[node.layer] ?? LAYER_BANDS.ephemeral;
  const regions = band.regions;
  const region = regions[indexInLayer % regions.length];
  const base = regionBase(region, band.y);
  const angle = hash01(`${node.id}:a`) * Math.PI * 2;
  const radial = Math.sqrt(hash01(`${node.id}:r`));
  const spread = kindSpread(node.kind);
  let x = base.x + Math.cos(angle) * band.sx * radial * spread;
  let y = base.y + Math.sin(angle) * band.sy * radial * spread;

  if (node.kind === 'root') {
    x = base.hemisphere === 'center' ? 0 : base.x * 0.62;
    y = band.y;
  }
  if (base.hemisphere !== 'center' && Math.abs(x) < 28) x = 28 * (base.hemisphere === 'left' ? -1 : 1);
  x = Math.max(-320, Math.min(320, x));
  y = Math.max(-220, Math.min(220, y));
  return { x, y, hemisphere: base.hemisphere, region };
}

const CURVATURES = [-0.24, -0.16, -0.08, 0, 0.08, 0.16, 0.24];
const TYPE_STYLE: Record<string, number> = { contains: 0, code: 1, link: 2, xlayer: 3 };

export function buildAnatomicalGraph2D(data: BrainData): AnatomicalGraph2D {
  const layerCounts = new Map<string, number>();
  const nodes = data.nodes.map((node) => {
    const index = layerCounts.get(node.layer) ?? 0;
    layerCounts.set(node.layer, index + 1);
    const target = targetFor(node, index);
    return {
      ...node,
      x: target.x,
      y: target.y,
      vx: 0,
      vy: 0,
      fx: undefined,
      fy: undefined,
      __targetX: target.x,
      __targetY: target.y,
      __hemisphere: target.hemisphere,
      __region: target.region,
    } as AnatomicalNode2D;
  });
  const links = data.links.map((link) => {
    const source = linkId(link.source);
    const target = linkId(link.target);
    const type = link.type ?? 'contains';
    const tier = TYPE_STYLE[type] ?? 0;
    const curve = CURVATURES[hash32(`${source}>${target}`) % CURVATURES.length];
    return {
      ...link,
      source,
      target,
      __sourceId: source,
      __targetId: target,
      __curvature: curve,
      __tier: tier,
      __styleKey: `${tier}:${hash32(`${source}|${target}`) % 2}`,
    } as AnatomicalLink2D;
  });
  return { nodes, links };
}

export function linkIds(link: AnatomicalLink2D | BrainData['links'][number]) {
  return {
    source: '__sourceId' in link ? link.__sourceId : linkId(link.source),
    target: '__targetId' in link ? link.__targetId : linkId(link.target),
  };
}

export function digestAnatomicalTargets(nodes: Pick<AnatomicalNode2D, 'id' | '__targetX' | '__targetY'>[]) {
  const parts = nodes
    .map((n) => `${n.id}:${Math.round(n.__targetX)},${Math.round(n.__targetY)}`)
    .sort();
  let hash = 2166136261;
  for (const part of parts) for (let i = 0; i < part.length; i++) hash = Math.imul(hash ^ part.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function nodeRadius2D(kind: string, degree: number) {
  const base = ({ root: 10, dir: 6.5, page: 4, file: 2.2, ephemeral: 3 } as Record<string, number>)[kind] ?? 3;
  return base + Math.min(4, Math.log2(degree + 1) * 0.7);
}

export interface Viewport2D {
  width: number;
  height: number;
  safeTop: number;
  bottomPadding: number;
}

/**
 * Frame the 2D brain into the band below the fixed header.
 * `zoomToFit` fits the whole canvas, which the header overlays, so the top of the
 * cortex was clipped. Returns the `centerAt`/`zoom` pair that the 3D path gets
 * from `cameraFrameForNodes3D`.
 *
 * Frames whatever points it is handed. Callers pass the anatomical targets while
 * the simulation is still expanding, then re-frame on the settled positions at
 * `onEngineStop` — charge repulsion pushes somas past their targets, so targets
 * alone under-measure the brain and the cortex ends up under the header.
 */
export function safeFrame2D(
  nodes: Array<{ x?: number; y?: number; kind?: string; __degree?: number }>,
  viewport: Viewport2D,
) {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const safeTop = Math.max(0, Math.min(height - 1, viewport.safeTop));
  const bottomPadding = Math.max(0, Math.min(height - safeTop - 1, viewport.bottomPadding));
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  let margin = 0;
  for (const node of nodes) {
    const x = node.x as number;
    const y = node.y as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
    margin = Math.max(margin, nodeRadius2D(node.kind ?? 'file', node.__degree ?? 0));
  }
  if (!Number.isFinite(bounds.minX)) return { x: 0, y: 0, k: 1 };

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const availableWidth = Math.max(1, width - 32);
  const availableHeight = Math.max(1, height - safeTop - bottomPadding);
  const spanX = Math.max(1e-6, bounds.maxX - bounds.minX + margin * 2);
  const spanY = Math.max(1e-6, bounds.maxY - bounds.minY + margin * 2);
  const k = Math.min(availableWidth / spanX, availableHeight / spanY);

  // centerAt places a graph point at the canvas center; offset it so the graph
  // center lands in the middle of the visible band instead.
  const bandCenterY = safeTop + availableHeight / 2;
  return { x: centerX, y: centerY - (bandCenterY - height / 2) / k, k };
}

export function createAnatomicalForce2D() {
  let nodes: Array<AnatomicalNode2D & { x?: number; y?: number; vx?: number; vy?: number }> = [];
  const force = (alpha: number) => {
    for (const node of nodes) {
      const tx = node.__targetX ?? 0;
      const ty = node.__targetY ?? 0;
      node.vx = (node.vx ?? 0) + (tx - (node.x ?? 0)) * 0.16 * alpha;
      node.vy = (node.vy ?? 0) + (ty - (node.y ?? 0)) * 0.16 * alpha;
      if (node.__hemisphere !== 'center' && Math.abs(node.x ?? 0) < 24 && Math.abs(node.y ?? 0) > 24) {
        node.vx += (node.__hemisphere === 'left' ? -1 : 1) * 3.1 * alpha;
      }
    }
  };
  force.initialize = (nextNodes: typeof nodes) => {
    nodes = nextNodes;
    for (const node of nodes) {
      if (node.x == null) node.x = node.__targetX;
      if (node.y == null) node.y = node.__targetY;
      if (node.vx == null) node.vx = 0;
      if (node.vy == null) node.vy = 0;
    }
  };
  return force;
}
