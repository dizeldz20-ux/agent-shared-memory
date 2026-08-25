import type { AnatomicalNode2D } from './anatomical2d';
import type { Layer } from './types';

export const RING_ORDER: Layer[] = ['agents', 'vault', 'web', 'lab', 'acp', 'skills', 'api', 'ops', 'ephemeral'];
const LEFT_CORTEX = ['agents', 'vault', 'web', 'lab'];
const RIGHT_CORTEX = ['acp', 'skills', 'api', 'ops'];

export interface RingArc {
  start: number;
  end: number;
}

export interface CorticalBand {
  id: string;
  layer: Layer;
  subBand: number;
  side: -1 | 1;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
  arcs: RingArc[];
  anchorAngle: number;
  phase: number;
}

export interface RingPosition {
  id: string;
  layer: Layer;
  bandId: string;
  x: number;
  y: number;
  angle: number;
  offBandDistance: number;
}

export interface CorticalRingLayout {
  positions: Map<string, RingPosition>;
  bands: CorticalBand[];
  coreRadius: number;
  maxX: number;
  maxY: number;
  maxOffBandDistance: number;
  radialJitterMax: number;
  arcGapCountMin: number;
  arcGapCountMax: number;
  ellipseRatioMin: number;
  ellipseRatioMax: number;
}

function hash32(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function hash01(value: string) {
  return hash32(value) / 4294967295;
}

function stableNodeOrder(a: AnatomicalNode2D, b: AnatomicalNode2D) {
  return (a.path || a.label || a.id).localeCompare(b.path || b.label || b.id) || a.id.localeCompare(b.id);
}

function brokenArcs(id: string) {
  const gap = 0.045 + hash01(`${id}:gap-size`) * 0.035;
  return [
    { start: -0.97, end: -gap },
    { start: gap, end: 0.97 },
  ];
}

export function ringPoint(band: Pick<CorticalBand, 'cx' | 'cy' | 'rx' | 'ry' | 'rotation' | 'phase'>, angle: number, radialOffset = 0) {
  // `angle` is a normalized -1..1 position along an open cortical fold. The old
  // implementation closed every band into an ellipse, producing the concentric
  // eye/butterfly shape. Open folds read as a layered cerebral sheet instead.
  const u = Math.max(-1, Math.min(1, angle));
  const envelope = Math.sqrt(Math.max(0.03, 1 - u * u));
  const x = u * band.rx;
  const wave = Math.sin((u + 1) * Math.PI * 2.15 + band.phase)
    * Math.min(38, Math.max(12, band.ry * 0.36)) * envelope;
  const secondary = Math.sin((u + 1) * Math.PI * 5.2 - band.phase * 0.7)
    * Math.min(8, Math.max(2.8, band.ry * 0.09)) * envelope;
  const y = wave + secondary + radialOffset;
  const cos = Math.cos(band.rotation);
  const sin = Math.sin(band.rotation);
  return { x: band.cx + x * cos - y * sin, y: band.cy + x * sin + y * cos };
}

function stripeHeights(layers: Array<{ layer: Layer; count: number }>, totalHeight: number, gap: number) {
  if (!layers.length) return [];
  const usable = totalHeight - gap * Math.max(0, layers.length - 1);
  const weights = layers.map(({ count }) => Math.sqrt(Math.max(1, count)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const raw = weights.map((value) => Math.max(72, usable * value / totalWeight));
  const scale = usable / raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value * scale);
}

function foldGrid(count: number, band: CorticalBand) {
  if (!count) return [];
  const area = Math.PI * band.rx * Math.max(8, band.ry);
  let spacing = Math.max(2.1, Math.sqrt(area / count) * 0.9);
  let points: Array<{ x: number; y: number; distance: number; angle: number }> = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    points = [];
    const rowStep = spacing * 0.8660254038;
    let row = 0;
    for (let localY = -band.ry + rowStep * 0.55; localY <= band.ry - rowStep * 0.35; localY += rowStep, row++) {
      const v = localY / Math.max(1, band.ry);
      const halfRow = band.rx * Math.sqrt(Math.max(0, 1 - v * v));
      const rowPoints: typeof points = [];
      for (let localX = -halfRow + spacing * (row % 2 ? 0.92 : 0.45); localX <= halfRow - spacing * 0.35; localX += spacing) {
        const u = localX / Math.max(1, band.rx);
        const centerline = ringPoint(band, u);
        const cos = Math.cos(band.rotation);
        const sin = Math.sin(band.rotation);
        rowPoints.push({
          x: centerline.x - localY * sin,
          y: centerline.y + localY * cos,
          distance: Math.abs(localY),
          angle: u,
        });
      }
      if (row % 2) rowPoints.reverse();
      points.push(...rowPoints);
    }
    if (points.length >= count) break;
    spacing *= 0.93;
  }
  // Very thin population-weighted bands can under-fill their hex rows after
  // the bounded refinement loop. Never let a valid neuron disappear (or feed
  // an undefined point into the renderer): finish the sheet with a stable
  // phyllotaxis packing inside the same open cortical envelope.
  const golden = Math.PI * (3 - Math.sqrt(5));
  while (points.length < count) {
    const index = points.length;
    const radius = Math.sqrt((index + 0.5) / Math.max(1, count)) * 0.96;
    const angle = index * golden + band.phase;
    const localX = Math.cos(angle) * band.rx * radius;
    const localY = Math.sin(angle) * band.ry * radius;
    const u = localX / Math.max(1, band.rx);
    const centerline = ringPoint(band, u);
    const cos = Math.cos(band.rotation);
    const sin = Math.sin(band.rotation);
    points.push({
      x: centerline.x - localY * sin,
      y: centerline.y + localY * cos,
      distance: Math.abs(localY),
      angle: u,
    });
  }
  return points.slice(0, count);
}

export function computeCorticalRings(nodes: AnatomicalNode2D[]): CorticalRingLayout {
  const positions = new Map<string, RingPosition>();
  const bands: CorticalBand[] = [];
  const coreRadius = 31;
  const core = nodes.filter((node) => node.layer === 'asm').sort(stableNodeOrder);

  core.forEach((node, index) => {
    const angle = core.length ? index / core.length * Math.PI * 2 - Math.PI / 2 : 0;
    const radius = node.kind === 'root' ? 0 : 8 + Math.sqrt((index + 0.5) / Math.max(1, core.length)) * (coreRadius - 10);
    positions.set(node.id, {
      id: node.id,
      layer: node.layer,
      bandId: 'asm:core',
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.72,
      angle,
      offBandDistance: 0,
    });
  });

  let maxOffBandDistance = 0;
  const knownLayers = new Set(RING_ORDER);
  const layerOrder = [
    ...RING_ORDER,
    ...[...new Set(nodes.map((node) => node.layer))]
      .filter((layer) => layer !== 'asm' && !knownLayers.has(layer))
      .sort(),
  ];
  const populated = layerOrder
    .map((layer) => ({ layer, members: nodes.filter((node) => node.layer === layer).sort(stableNodeOrder) }))
    .filter(({ layer, members }) => layer !== 'asm' && members.length > 0);
  const totalHeight = 680;
  const gap = 9;

  for (const side of [-1, 1] as const) {
    const preferred = side < 0 ? LEFT_CORTEX : RIGHT_CORTEX;
    const sideLayers = populated
      .filter(({ layer }) => {
        if (preferred.includes(layer)) return true;
        if (LEFT_CORTEX.includes(layer) || RIGHT_CORTEX.includes(layer)) return false;
        return (hash32(`${layer}:cortical-side`) % 2 ? 1 : -1) === side;
      })
      .sort((a, b) => {
        const ai = preferred.indexOf(a.layer);
        const bi = preferred.indexOf(b.layer);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.layer.localeCompare(b.layer);
      });
    const heights = stripeHeights(sideLayers.map(({ layer, members }) => ({ layer, count: members.length })), totalHeight, gap);
    let cursor = -totalHeight / 2;
    sideLayers.forEach(({ layer, members }, index) => {
      const height = heights[index];
      const id = `${layer}:fold:${side < 0 ? 'l' : 'r'}`;
      const innerRelay = members.length < 900;
      const band: CorticalBand = {
        id,
        layer,
        subBand: 0,
        side,
        cx: side * (innerRelay ? 350 : 500),
        cy: cursor + height / 2,
        rx: innerRelay ? 300 : 430,
        ry: Math.max(18, height / 2 - 3),
        rotation: side * (hash01(`${id}:rotation`) - 0.5) * 0.035,
        arcs: brokenArcs(id),
        anchorAngle: 0,
        phase: hash01(`${id}:folds`) * Math.PI * 2,
      };
      bands.push(band);
      const points = foldGrid(members.length, band);
      members.forEach((node, positionIndex) => {
        const point = points[positionIndex];
        maxOffBandDistance = Math.max(maxOffBandDistance, point.distance);
        positions.set(node.id, {
          id: node.id,
          layer: node.layer,
          bandId: id,
          x: point.x,
          y: point.y,
          angle: point.angle,
          offBandDistance: point.distance,
        });
      });
      cursor += height + gap;
    });
  }

  const ratios = bands.map((band) => band.rx / Math.max(1, band.ry));
  const gapCounts = bands.map((band) => band.arcs.length);
  const xs = [...positions.values()].map((position) => Math.abs(position.x));
  const ys = [...positions.values()].map((position) => Math.abs(position.y));
  return {
    positions,
    bands,
    coreRadius,
    maxX: Math.max(coreRadius, ...xs),
    maxY: Math.max(coreRadius, ...ys),
    maxOffBandDistance,
    radialJitterMax: maxOffBandDistance,
    arcGapCountMin: gapCounts.length ? Math.min(...gapCounts) : 0,
    arcGapCountMax: gapCounts.length ? Math.max(...gapCounts) : 0,
    ellipseRatioMin: ratios.length ? Math.min(...ratios) : 0,
    ellipseRatioMax: ratios.length ? Math.max(...ratios) : 0,
  };
}

export function digestRingLayout(layout: CorticalRingLayout) {
  const value = [...layout.positions.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((position) => `${position.id}:${position.bandId}:${position.x.toFixed(2)},${position.y.toFixed(2)}`)
    .join('|');
  return hash32(value).toString(16).padStart(8, '0');
}

export function applyCorticalRingPins(nodes: AnatomicalNode2D[], layout: CorticalRingLayout) {
  let pinned = 0;
  for (const node of nodes) {
    const position = layout.positions.get(node.id);
    if (!position) continue;
    node.x = position.x;
    node.y = position.y;
    node.fx = position.x;
    node.fy = position.y;
    node.vx = 0;
    node.vy = 0;
    pinned++;
  }
  return pinned;
}

export function clearCorticalRingPins(nodes: AnatomicalNode2D[]) {
  for (const node of nodes) {
    node.fx = undefined;
    node.fy = undefined;
    node.x = node.__targetX;
    node.y = node.__targetY;
    node.vx = 0;
    node.vy = 0;
  }
}
