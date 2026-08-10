import type { AnatomicalNode2D } from './anatomical2d';
import type { Layer } from './types';

export const RING_ORDER: Layer[] = ['vault', 'api', 'web', 'ops', 'lab', 'ephemeral'];

export interface RingArc {
  start: number;
  end: number;
}

export interface CorticalBand {
  id: string;
  layer: Layer;
  subBand: number;
  rx: number;
  ry: number;
  rotation: number;
  arcs: RingArc[];
  anchorAngle: number;
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
  const gapCount = 4 + (hash32(`${id}:gaps`) % 3);
  const gap = 0.1 + hash01(`${id}:gap-size`) * 0.05;
  const span = (Math.PI * 2 - gapCount * gap) / gapCount;
  const offset = hash01(`${id}:offset`) * Math.PI * 2;
  return Array.from({ length: gapCount }, (_, index) => {
    const start = offset + index * (span + gap) + gap * 0.5;
    return { start, end: start + span };
  });
}

export function ringPoint(band: Pick<CorticalBand, 'rx' | 'ry' | 'rotation'>, angle: number, radialOffset = 0) {
  const rx = band.rx + radialOffset;
  const ry = band.ry + radialOffset * (band.ry / band.rx);
  const x = Math.cos(angle) * rx;
  const y = Math.sin(angle) * ry;
  const cos = Math.cos(band.rotation);
  const sin = Math.sin(band.rotation);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

export function computeCorticalRings(nodes: AnatomicalNode2D[]): CorticalRingLayout {
  const positions = new Map<string, RingPosition>();
  const bands: CorticalBand[] = [];
  const coreRadius = 28;
  const core = nodes.filter((node) => node.layer === 'c2b').sort(stableNodeOrder);

  core.forEach((node, index) => {
    const angle = core.length ? index / core.length * Math.PI * 2 - Math.PI / 2 : 0;
    const radius = node.kind === 'root' ? 0 : 7 + hash01(`${node.id}:core`) * (coreRadius - 9);
    positions.set(node.id, {
      id: node.id,
      layer: node.layer,
      bandId: 'c2b:core',
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.72,
      angle,
      offBandDistance: 0,
    });
  });

  let radius = 78;
  let maxOffBandDistance = 0;
  for (let layerIndex = 0; layerIndex < RING_ORDER.length; layerIndex++) {
    const layer = RING_ORDER[layerIndex];
    const members = nodes.filter((node) => node.layer === layer).sort(stableNodeOrder);
    if (!members.length) continue;
    radius += 16;
    const minimumBands = layer === 'ops' ? 4 : 1;
    const maximumPerBand = Math.ceil(members.length / minimumBands);
    let index = 0;
    let subBand = 0;

    while (index < members.length) {
      const naturalCapacity = Math.max(36, Math.floor(Math.PI * 2 * radius / 5.6));
      const capacity = Math.max(1, Math.min(naturalCapacity, maximumPerBand));
      const slice = members.slice(index, index + capacity);
      const id = `${layer}:${subBand}`;
      const ratio = 0.62 + hash01(`${id}:ratio`) * 0.16;
      const band: CorticalBand = {
        id,
        layer,
        subBand,
        rx: radius,
        ry: radius * ratio,
        rotation: (hash01(`${id}:rotation`) - 0.5) * 0.14,
        arcs: brokenArcs(id),
        anchorAngle: -Math.PI / 2 + layerIndex * 0.52 + subBand * 0.04,
      };
      bands.push(band);
      const phase = hash01(`${id}:phase`) * Math.PI * 2;
      slice.forEach((node, positionIndex) => {
        const angle = phase + positionIndex / slice.length * Math.PI * 2 + (hash01(`${node.id}:angle`) - 0.5) * 0.024;
        const radialOffset = (hash01(`${node.id}:radial`) - 0.5) * 9.2;
        const point = ringPoint(band, angle, radialOffset);
        maxOffBandDistance = Math.max(maxOffBandDistance, Math.abs(radialOffset));
        positions.set(node.id, {
          id: node.id,
          layer: node.layer,
          bandId: id,
          x: point.x,
          y: point.y,
          angle,
          offBandDistance: Math.abs(radialOffset),
        });
      });
      index += slice.length;
      subBand++;
      radius += 17;
    }
    radius += 22;
  }

  const ratios = bands.map((band) => band.ry / band.rx);
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
