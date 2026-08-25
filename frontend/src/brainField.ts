const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

type SurfacePoint = { x: number; y: number; z: number };
type NeuralAnchor = { id: string; x: number; y: number; z: number; kind?: string };

export interface CorticalMeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface NeuronMorphologyRange {
  id: string;
  x: number;
  y: number;
  z: number;
  segmentStart: number;
  segmentEnd: number;
  synapseStart: number;
  synapseEnd: number;
}

export interface NeuronMorphologyData {
  segments: Float32Array;
  synapses: Float32Array;
  neuronCount: number;
  ranges: NeuronMorphologyRange[];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function signedPow(value: number, exponent: number) {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

function hash32(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function hash01(value: string) {
  return hash32(value) / 4294967295;
}

/**
 * A folded cerebral super-ellipsoid. The screen silhouette is one continuous
 * cerebrum; the longitudinal fissure is cut from its dorsal surface at render
 * time. This avoids the paired-sphere / butterfly shape of the first prototype.
 */
function brainSurface(latitude: number, longitude: number, phase = 0, inset = 0): SurfacePoint {
  const sinLat = Math.sin(latitude);
  const cosLat = Math.max(0, Math.cos(latitude));
  const ring = Math.pow(cosLat, 0.72);
  const vertical = signedPow(sinLat, 0.86);
  const depth = signedPow(Math.cos(longitude), 0.76);
  const lateral = signedPow(Math.sin(longitude), 0.72);
  const lowerTaper = 1 - 0.19 * Math.pow(Math.max(0, -vertical), 1.7);
  const folds = 1
    + 0.019 * Math.sin(longitude * 9 + latitude * 7 + phase)
    + 0.011 * Math.sin(longitude * 17 - latitude * 11 + phase * 0.71)
    + 0.005 * Math.sin(longitude * 31 + latitude * 19);
  const scale = Math.max(0.72, 1 - inset);
  return {
    x: (depth * 202 * ring * folds * lowerTaper + 8 * (1 - vertical * vertical)) * scale,
    y: vertical * 134 * (1 + 0.018 * Math.sin(longitude * 5 + phase)) * scale,
    z: lateral * 153 * ring * folds * lowerTaper * scale,
  };
}

function insideFissure(point: SurfacePoint) {
  const rise = clamp((point.y + 36) / 42, 0, 1);
  const width = (4.4 + 2.2 * Math.pow(clamp((point.y + 36) / 170, 0, 1), 1.4)) * rise;
  return width > 0.5 && Math.abs(point.z) < width;
}

/** Dense but translucent cortical membrane points, with a real central fissure. */
export function corticalFieldPositions(count = 9200) {
  const safeCount = Math.max(0, Math.floor(count));
  const values: number[] = [];
  let candidate = 0;
  while (values.length < safeCount * 3) {
    const y = 1 - 2 * ((candidate + 0.5) / Math.max(safeCount * 1.08, 1));
    const latitude = Math.asin(clamp(y, -1, 1));
    const longitude = candidate * GOLDEN_ANGLE;
    const point = brainSurface(latitude, longitude, candidate * 0.011, 0.004 + hash01(`${candidate}:inset`) * 0.018);
    candidate++;
    if (insideFissure(point)) continue;
    values.push(point.x, point.y, point.z);
  }
  return new Float32Array(values);
}

function frontDepth(y: number, z: number, side: -1 | 1) {
  const yn = clamp(y / 134, -0.98, 0.98);
  const taper = 1 - 0.19 * Math.pow(Math.max(0, -yn), 1.7);
  const zn = Math.abs(z) / (153 * taper);
  const remaining = Math.sqrt(Math.max(0.015, 1 - yn * yn - zn * zn));
  return side * (202 * remaining + 5);
}

/**
 * Broken, sinuous gyri on the front and back cortical membranes. These paths
 * carry the brain silhouette when graph links are quiet.
 */
export function corticalFiberPositions(pathsPerHemisphere = 46, segmentsPerPath = 42) {
  const pathCount = Math.max(4, Math.floor(pathsPerHemisphere));
  const segments = Math.max(5, Math.floor(segmentsPerPath));
  const values: number[] = [];
  for (const hemisphere of [-1, 1] as const) {
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
      const baseY = -105 + (pathIndex + 0.5) / pathCount * 222;
      const phase = pathIndex * 1.317 + (hemisphere > 0 ? 0.73 : 0);
      const face: -1 | 1 = pathIndex % 5 === 0 ? -1 : 1;
      let previous: SurfacePoint | null = null;
      for (let step = 0; step <= segments; step++) {
        const t = step / segments;
        const y = baseY + 6.5 * Math.sin(t * Math.PI * 3 + phase) + 2.4 * Math.sin(t * Math.PI * 9 - phase);
        const lateralLimit = 153 * Math.sqrt(Math.max(0.02, 1 - Math.pow(y / 137, 2)));
        const z = hemisphere * (13 + t * Math.max(4, lateralLimit - 16));
        const point = {
          x: frontDepth(y, z, face) + face * 2.3 * Math.sin(t * Math.PI * 7 + phase),
          y,
          z,
        };
        if (previous) values.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
        previous = point;
      }
    }

    // A smaller family of rising folds breaks the horizontal scan-line rhythm.
    const risingCount = Math.ceil(pathCount * 0.38);
    for (let pathIndex = 0; pathIndex < risingCount; pathIndex++) {
      const phase = pathIndex * 2.09 + (hemisphere > 0 ? 0.31 : 0);
      const lateral = 0.18 + (pathIndex + 0.5) / risingCount * 0.72;
      let previous: SurfacePoint | null = null;
      for (let step = 0; step <= segments; step++) {
        const t = step / segments;
        const y = -99 + t * 207;
        const lateralLimit = 153 * Math.sqrt(Math.max(0.02, 1 - Math.pow(y / 137, 2)));
        const z = hemisphere * lateralLimit * clamp(lateral + 0.045 * Math.sin(t * Math.PI * 5 + phase), 0.12, 0.94);
        const point = { x: frontDepth(y, z, 1) + 1.8 * Math.sin(t * Math.PI * 8 + phase), y, z };
        if (previous) values.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
        previous = point;
      }
    }
  }
  return new Float32Array(values);
}

/** Indexed folded shell used by the living translucent Three.js cortex shader. */
export function corticalMeshData(latitudeSegments = 68, longitudeSegments = 112): CorticalMeshData {
  const latCount = Math.max(12, Math.floor(latitudeSegments));
  const lonCount = Math.max(24, Math.floor(longitudeSegments));
  const positions: number[] = [];
  const indices: number[] = [];
  for (let latIndex = 0; latIndex <= latCount; latIndex++) {
    const latitude = -Math.PI / 2 + latIndex / latCount * Math.PI;
    for (let lonIndex = 0; lonIndex <= lonCount; lonIndex++) {
      const longitude = lonIndex / lonCount * Math.PI * 2;
      const point = brainSurface(latitude, longitude, 0);
      positions.push(point.x, point.y, point.z);
    }
  }
  const stride = lonCount + 1;
  for (let latIndex = 0; latIndex < latCount; latIndex++) {
    for (let lonIndex = 0; lonIndex < lonCount; lonIndex++) {
      const a = latIndex * stride + lonIndex;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function normalize(x: number, y: number, z: number) {
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

/**
 * Procedural neuron morphology for semantic hubs: soma anchors sprout curved
 * dendrites, terminal twigs, a longer axon and synaptic tips. All neurons share
 * one batched geometry, so the tissue stays fast enough to navigate.
 */
export function neuronMorphologyPositions(anchors: NeuralAnchor[], limit = 480): NeuronMorphologyData {
  const priority = (node: NeuralAnchor) => node.kind === 'root' ? 0 : node.kind === 'dir' ? 1 : 2;
  const ranked = anchors
    .filter((node) => node.kind === 'root' || node.kind === 'dir' || hash32(`${node.id}:neuron`) % 7 === 0)
    .sort((a, b) => priority(a) - priority(b) || hash32(a.id) - hash32(b.id))
    .slice(0, Math.max(0, Math.floor(limit)));
  const segments: number[] = [];
  const synapses: number[] = [];
  const ranges: NeuronMorphologyData['ranges'] = [];

  for (const node of ranked) {
    const segmentStart = segments.length;
    const synapseStart = synapses.length;
    const branchCount = node.kind === 'root' ? 6 : node.kind === 'dir' ? 5 : 3;
    for (let branch = 0; branch < branchCount; branch++) {
      const azimuth = hash01(`${node.id}:${branch}:az`) * Math.PI * 2;
      const elevation = (hash01(`${node.id}:${branch}:el`) - 0.5) * Math.PI * 0.82;
      const direction = normalize(Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth));
      const total = (node.kind === 'root' ? 15 : 10) + hash01(`${node.id}:${branch}:len`) * 9;
      let previous = { x: node.x, y: node.y, z: node.z };
      for (let step = 1; step <= 3; step++) {
        const distance = total * step / 3;
        const curl = (hash01(`${node.id}:${branch}:${step}:curl`) - 0.5) * 4.8;
        const next = {
          x: node.x + direction.x * distance + Math.sin(azimuth + step) * curl,
          y: node.y + direction.y * distance + Math.cos(elevation + step) * curl * 0.7,
          z: node.z + direction.z * distance + Math.cos(azimuth - step) * curl,
        };
        segments.push(previous.x, previous.y, previous.z, next.x, next.y, next.z);
        previous = next;
      }
      for (const fork of [-1, 1]) {
        const forkLength = 3.5 + hash01(`${node.id}:${branch}:${fork}:fork`) * 4.5;
        const tip = {
          x: previous.x + direction.x * forkLength + fork * direction.z * 2.2,
          y: previous.y + direction.y * forkLength + fork * 1.4,
          z: previous.z + direction.z * forkLength - fork * direction.x * 2.2,
        };
        segments.push(previous.x, previous.y, previous.z, tip.x, tip.y, tip.z);
        synapses.push(tip.x, tip.y, tip.z);
      }
    }

    // One longer, thinner axon leaves every neuron toward a shared-memory tract.
    const axonDirection = normalize(-node.x * 0.32 + (hash01(`${node.id}:axon-x`) - 0.5), -node.y * 0.12, -node.z * 0.32);
    let previous = { x: node.x, y: node.y, z: node.z };
    const axonLength = 22 + hash01(`${node.id}:axon-length`) * 26;
    for (let step = 1; step <= 4; step++) {
      const distance = axonLength * step / 4;
      const next = {
        x: node.x + axonDirection.x * distance + Math.sin(step + hash01(node.id) * 6) * 2.2,
        y: node.y + axonDirection.y * distance + Math.cos(step * 1.7) * 1.5,
        z: node.z + axonDirection.z * distance + Math.sin(step * 1.3) * 2,
      };
      segments.push(previous.x, previous.y, previous.z, next.x, next.y, next.z);
      previous = next;
    }
    synapses.push(previous.x, previous.y, previous.z);
    ranges.push({
      id: node.id,
      x: node.x,
      y: node.y,
      z: node.z,
      segmentStart,
      segmentEnd: segments.length,
      synapseStart,
      synapseEnd: synapses.length,
    });
  }

  return {
    segments: new Float32Array(segments),
    synapses: new Float32Array(synapses),
    neuronCount: ranked.length,
    ranges,
  };
}

/** Translate one batched cell so its dendrites and synapses follow its soma. */
export function translateNeuronMorphology(
  segments: Float32Array,
  synapses: Float32Array,
  range: NeuronMorphologyRange,
  dx: number,
  dy: number,
  dz: number,
) {
  if (![dx, dy, dz].every(Number.isFinite) || Math.hypot(dx, dy, dz) <= 1e-7) return false;
  for (let index = range.segmentStart; index < range.segmentEnd; index += 3) {
    segments[index] += dx;
    segments[index + 1] += dy;
    segments[index + 2] += dz;
  }
  for (let index = range.synapseStart; index < range.synapseEnd; index += 3) {
    synapses[index] += dx;
    synapses[index + 1] += dy;
    synapses[index + 2] += dz;
  }
  return true;
}

export function fieldDigest(positions: Float32Array) {
  let hash = 2166136261;
  for (let index = 0; index < positions.length; index += 11) {
    hash = Math.imul(hash ^ Math.round(positions[index] * 100), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
