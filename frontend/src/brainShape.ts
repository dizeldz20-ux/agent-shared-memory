// Brain-shaped layout: a custom d3 force that herds nodes into a layered,
// volumetric brain — anatomical depth layers instead of one hollow shell:
//   pages (knowledge)  -> outer cortex
//   files              -> mid gray-matter band
//   dirs               -> deep white-matter hubs
//   roots              -> core
// Axes: x = front-back, y = up-down, z = left-right.
import type { BrainNode } from './types';

export const A = 230; // ellipsoid radius, front-back
export const B = 150; // up-down
export const C = 185; // left-right

// depth layer per node kind: [center radius, jitter] (relative 0..1)
const KIND_RADIUS: Record<string, [number, number]> = {
  root: [0.15, 0.05],
  dir: [0.4, 0.08],
  file: [0.66, 0.16],
  page: [0.92, 0.05],
  ephemeral: [0.58, 0.1],
};

// lobes: code layers in four quadrants (right/left hemisphere x front/back);
// vault = top band bridging everything (corpus callosum); ephemeral sinks to
// the brain-stem area at the bottom.
const LOBE_Z: Record<string, number> = { api: 0.55, web: -0.55, ops: 0.55, lab: -0.55 };
const LOBE_X: Record<string, number> = { api: 0.4, web: 0.4, ops: -0.45, lab: -0.45 };
const LOBE_Y: Record<string, number> = { vault: 0.5, ephemeral: -0.85 };

function hash01(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0) / 4294967295;
}

function targetRadius(n: BrainNode): number {
  const [center, jitter] = KIND_RADIUS[n.kind] ?? [0.66, 0.12];
  const r = center + (hash01(`${n.id}:radius`) * 2 - 1) * jitter;
  // C2B maps itself as a compact nucleus at the brain's core (the thalamus)
  return n.layer === 'c2b' ? r * 0.28 : r;
}

/** Seed initial positions in the correct lobe AND depth layer. */
export function seedBrainPositions(nodes: BrainNode[]) {
  for (const n of nodes as any[]) {
    if (n.tr == null) n.tr = targetRadius(n);
    if (n.x != null) continue;
    const r = n.tr;
    const theta = hash01(`${n.id}:theta`) * Math.PI * 2;
    const phi = Math.acos(2 * hash01(`${n.id}:phi`) - 1);
    let px = r * Math.sin(phi) * Math.cos(theta);
    let py = r * Math.cos(phi);
    let pz = r * Math.sin(phi) * Math.sin(theta);
    const tz = LOBE_Z[n.layer];
    if (tz !== undefined) pz = tz * r + pz * 0.45;
    const tx = LOBE_X[n.layer];
    if (tx !== undefined) px = tx * r + px * 0.5;
    const ty = LOBE_Y[n.layer];
    if (ty !== undefined) py = ty * r + py * 0.3;
    n.x = px * A; n.y = py * B; n.z = pz * C;
  }
}

/** Custom d3 force: spring each node to ITS OWN depth radius + fissure + lobe bias. */
export function makeBrainForce() {
  let nodes: BrainNode[] = [];
  const force = (alpha: number) => {
    for (const n of nodes as any[]) {
      const px = (n.x || 0) / A, py = (n.y || 0) / B, pz = (n.z || 0) / C;
      const r = Math.hypot(px, py, pz) || 1e-6;
      const tr = n.tr ?? (n.tr = targetRadius(n));
      const k = ((tr - r) / r) * 0.9 * alpha;
      n.vx += n.x * k; n.vy += n.y * k; n.vz += n.z * k;
      // longitudinal fissure along the top — only in the outer layers,
      // the deep core stays whole
      if (py > 0 && r > 0.5 && Math.abs(pz) < 0.24) {
        n.vz += (pz >= 0 ? 1 : -1) * 4 * alpha;
      }
      // lobe bias scaled by the node's own depth so deep nodes gather
      // near the center and outer nodes spread to their hemisphere
      const tz = LOBE_Z[n.layer];
      if (tz !== undefined) n.vz += (tz * tr * C - n.z) * 0.16 * alpha;
      const tx = LOBE_X[n.layer];
      if (tx !== undefined) n.vx += (tx * tr * A - n.x) * 0.14 * alpha;
      const ty = LOBE_Y[n.layer];
      if (ty !== undefined) n.vy += (ty * tr * B - n.y) * 0.16 * alpha;
    }
  };
  (force as any).initialize = (ns: BrainNode[]) => { nodes = ns; };
  return force;
}
