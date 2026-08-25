import type { BrainData, BrainNode } from './types';

export type AtlasHemisphere = 'left' | 'right' | 'center';

export interface NeuralAtlasPosition {
  id: string;
  x: number;
  y: number;
  hemisphere: AtlasHemisphere;
  region: string;
  anchorId: string;
}

export interface NeuralAtlasLayout {
  positions: Map<string, NeuralAtlasPosition>;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minimumSpacing: number;
  aspectRatio: number;
  anchorCount: number;
}

type Zone = {
  layer: string;
  side: -1 | 1;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
};

type AtlasGroup = { anchor: string; members: BrainNode[]; radius: number; x: number; y: number; spacing: number };

const ATLAS_HALF_WIDTH = 1010;
const ATLAS_HALF_HEIGHT = 380;
const HEMISPHERE_CENTER = 520;
const HEMISPHERE_RADIUS_X = 475;
const LEFT_ORDER = ['agents', 'web', 'lab', 'vault'];
const RIGHT_ORDER = ['acp', 'api', 'ops', 'skills'];

// The atlas is deliberately lobe-based rather than a stack of horizontal
// categories. Large code families occupy the four cerebral quadrants while
// memory/skills sit near the corpus callosum. This keeps cross-agent knowledge
// edges short and makes the overview read as one brain instead of a chart.
const LOBE_ZONES: Record<string, Omit<Zone, 'layer'>> = {
  agents: { side: -1, cx: -565, cy: -150, rx: 430, ry: 170 },
  lab: { side: -1, cx: -575, cy: 160, rx: 410, ry: 170 },
  vault: { side: -1, cx: -145, cy: 235, rx: 105, ry: 82 },
  web: { side: -1, cx: -170, cy: -125, rx: 112, ry: 76 },
  acp: { side: 1, cx: 565, cy: -150, rx: 430, ry: 170 },
  ops: { side: 1, cx: 590, cy: 160, rx: 395, ry: 170 },
  skills: { side: 1, cx: 145, cy: 235, rx: 105, ry: 82 },
  api: { side: 1, cx: 170, cy: -125, rx: 112, ry: 76 },
  ephemeral: { side: 1, cx: 150, cy: 34, rx: 82, ry: 58 },
};

function hash32(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function hash01(value: string) {
  return hash32(value) / 4294967295;
}

function endpointId(value: unknown) {
  return typeof value === 'object' && value && 'id' in value ? String((value as BrainNode).id) : String(value);
}

function stableNodeOrder(a: BrainNode, b: BrainNode) {
  const kindRank = (node: BrainNode) => node.kind === 'root' ? 0 : node.kind === 'dir' ? 1 : node.kind === 'page' ? 2 : 3;
  return kindRank(a) - kindRank(b)
    || (a.path || a.label || a.id).localeCompare(b.path || b.label || b.id)
    || a.id.localeCompare(b.id);
}

function sideForLayer(layer: string): -1 | 1 {
  if (LEFT_ORDER.includes(layer)) return -1;
  if (RIGHT_ORDER.includes(layer)) return 1;
  return hash32(`${layer}:atlas-side`) % 2 ? 1 : -1;
}

function allocateZones(nodesByLayer: Map<string, BrainNode[]>) {
  const zones = new Map<string, Zone>();
  const nonCoreLayers = [...nodesByLayer.keys()].filter((layer) => layer !== 'asm');
  const unknownBySide = new Map<-1 | 1, string[]>([[-1, []], [1, []]]);
  for (const layer of nonCoreLayers.sort()) {
    const known = LOBE_ZONES[layer];
    if (known) zones.set(layer, { layer, ...known });
    else unknownBySide.get(sideForLayer(layer))!.push(layer);
  }
  // Future layers still get a stable inner relay rather than disappearing.
  for (const side of [-1, 1] as const) {
    const unknown = unknownBySide.get(side) ?? [];
    unknown.forEach((layer, index) => {
      const angle = (index + 1) / (unknown.length + 1) * Math.PI - Math.PI / 2;
      zones.set(layer, {
        layer,
        side,
        cx: side * (HEMISPHERE_CENTER - 260 + Math.cos(angle) * 52),
        cy: Math.sin(angle) * (ATLAS_HALF_HEIGHT - 112),
        rx: Math.min(145, HEMISPHERE_RADIUS_X * 0.3),
        ry: 78,
      });
    });
  }
  return zones;
}

function buildParentMap(data: BrainData) {
  const parent = new Map<string, string>();
  const contains = data.links
    .filter((link) => link.type === 'contains')
    .map((link) => ({ source: endpointId(link.source), target: endpointId(link.target) }))
    .sort((a, b) => a.target.localeCompare(b.target) || a.source.localeCompare(b.source));
  for (const link of contains) if (!parent.has(link.target)) parent.set(link.target, link.source);
  return parent;
}

function anchorForNode(node: BrainNode, parent: Map<string, string>, byId: Map<string, BrainNode>, layerRoot: Map<string, string>) {
  if (node.kind === 'root' || node.kind === 'dir') return node.id;
  let current = node.id;
  const visited = new Set<string>();
  for (let depth = 0; depth < 80 && parent.has(current); depth++) {
    const next = parent.get(current)!;
    if (visited.has(next)) break;
    visited.add(next);
    const candidate = byId.get(next);
    if (candidate?.kind === 'dir' || candidate?.kind === 'root') return candidate.id;
    current = next;
  }
  return layerRoot.get(node.layer) ?? node.id;
}

function placeAtlasGroups(groups: AtlasGroup[], zone: Zone) {
  const placed: AtlasGroup[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (const group of groups) {
    let best = { x: zone.cx, y: zone.cy, overlap: Infinity };
    const phase = hash01(`${group.anchor}:cluster-phase`) * Math.PI * 2;
    for (let candidate = 0; candidate < 1800; candidate++) {
      const radius = Math.sqrt((candidate + 0.5) / 1800);
      const angle = candidate * golden + phase;
      const availableX = Math.max(8, zone.rx - group.radius - 5);
      const availableY = Math.max(8, zone.ry - group.radius - 5);
      const x = zone.cx + Math.cos(angle) * availableX * radius;
      const y = zone.cy + Math.sin(angle) * availableY * radius;
      let overlap = 0;
      for (const other of placed) {
        const required = group.radius + other.radius + Math.max(4, Math.min(group.spacing, other.spacing) * 0.65);
        const distance = Math.hypot(x - other.x, y - other.y);
        if (distance < required) overlap += required - distance;
      }
      if (overlap < best.overlap) best = { x, y, overlap };
      if (overlap <= 0.01) break;
    }
    group.x = best.x;
    group.y = best.y;
    placed.push(group);
  }
}

function positionAtlasGroup(group: AtlasGroup, positions: Map<string, NeuralAtlasPosition>, zone: Zone) {
  const anchorIndex = group.members.findIndex((node) => node.id === group.anchor);
  const ordered = group.members.slice();
  if (anchorIndex > 0) [ordered[0], ordered[anchorIndex]] = [ordered[anchorIndex], ordered[0]];
  const phase = hash01(`${group.anchor}:member-phase`) * Math.PI * 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  ordered.forEach((node, index) => {
    const isAnchor = node.id === group.anchor;
    const radial = isAnchor ? 0 : Math.min(group.radius * 0.94, group.spacing * Math.sqrt(index / Math.PI));
    const angle = index * golden + phase;
    const x = group.x + Math.cos(angle) * radial;
    const y = group.y + Math.sin(angle) * radial * (0.88 + hash01(`${group.anchor}:elliptic`) * 0.12);
    positions.set(node.id, {
      id: node.id,
      x,
      y,
      hemisphere: zone.side < 0 ? 'left' : 'right',
      region: `${node.layer}:${group.anchor}`,
      anchorId: group.anchor,
    });
  });
}

function assignLayer(
  layerNodes: BrainNode[],
  zone: Zone,
  parent: Map<string, string>,
  byId: Map<string, BrainNode>,
  layerRoot: Map<string, string>,
  positions: Map<string, NeuralAtlasPosition>,
) {
  const groups = new Map<string, BrainNode[]>();
  for (const node of layerNodes) {
    const anchor = anchorForNode(node, parent, byId, layerRoot);
    const members = groups.get(anchor) ?? [];
    members.push(node);
    groups.set(anchor, members);
  }
  const orderedGroups = [...groups.entries()]
    .map(([anchor, members]) => ({ anchor, members: members.sort(stableNodeOrder) }))
    .sort((a, b) => b.members.length - a.members.length || a.anchor.localeCompare(b.anchor));
  const area = Math.PI * zone.rx * zone.ry;
  const spacing = Math.max(2.5, Math.sqrt(area / Math.max(1, layerNodes.length)) * 0.7);
  const atlasGroups: AtlasGroup[] = orderedGroups.map((group) => {
    const naturalRadius = spacing * Math.sqrt(Math.max(1, group.members.length) / Math.PI) + (group.members.length > 1 ? 5 : 1.5);
    const maxRadius = Math.max(8, Math.min(zone.rx, zone.ry) * 0.84);
    const radius = Math.min(naturalRadius, maxRadius);
    const localSpacing = group.members.length > 1
      ? Math.min(spacing, Math.max(1.6, (radius - 3) * Math.sqrt(Math.PI / group.members.length)))
      : spacing;
    return { ...group, radius, spacing: localSpacing, x: zone.cx, y: zone.cy };
  });
  placeAtlasGroups(atlasGroups, zone);
  for (const group of atlasGroups) positionAtlasGroup(group, positions, zone);
  return Math.min(...atlasGroups.map((group) => group.spacing), spacing);
}

export function computeNeuralAtlas2D(data: BrainData): NeuralAtlasLayout {
  const nodes = data.nodes.slice().sort(stableNodeOrder);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const nodesByLayer = new Map<string, BrainNode[]>();
  const layerRoot = new Map<string, string>();
  for (const node of nodes) {
    const members = nodesByLayer.get(node.layer) ?? [];
    members.push(node);
    nodesByLayer.set(node.layer, members);
    if (node.kind === 'root' && !layerRoot.has(node.layer)) layerRoot.set(node.layer, node.id);
  }
  const parent = buildParentMap(data);
  const zones = allocateZones(nodesByLayer);
  const positions = new Map<string, NeuralAtlasPosition>();
  let minimumSpacing = Infinity;
  let anchorCount = 0;

  for (const [layer, layerNodes] of [...nodesByLayer.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (layer === 'asm') continue;
    const zone = zones.get(layer);
    if (!zone) continue;
    minimumSpacing = Math.min(minimumSpacing, assignLayer(layerNodes, zone, parent, byId, layerRoot, positions));
    anchorCount += new Set(layerNodes.map((node) => anchorForNode(node, parent, byId, layerRoot))).size;
  }

  const core = (nodesByLayer.get('asm') ?? []).slice().sort(stableNodeOrder);
  core.forEach((node, index) => {
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    const radius = node.kind === 'root' ? 0 : 12 + Math.sqrt((index + 0.5) / Math.max(1, core.length)) * 62;
    positions.set(node.id, {
      id: node.id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.72,
      hemisphere: 'center',
      region: 'shared-core',
      anchorId: layerRoot.get('asm') ?? node.id,
    });
  });
  if (core.length) anchorCount += 1;

  // No node may disappear because a future graph introduces a layer without a
  // zone. Put such nodes in a restrained central relay, deterministically.
  for (const node of nodes) {
    if (positions.has(node.id)) continue;
    const angle = hash01(`${node.id}:fallback`) * Math.PI * 2;
    const radius = 86 + hash01(`${node.id}:fallback-radius`) * 28;
    positions.set(node.id, {
      id: node.id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.62,
      hemisphere: 'center',
      region: `${node.layer}:relay`,
      anchorId: node.id,
    });
  }

  const values = [...positions.values()];
  const minX = Math.min(...values.map((position) => position.x), -ATLAS_HALF_WIDTH);
  const maxX = Math.max(...values.map((position) => position.x), ATLAS_HALF_WIDTH);
  const minY = Math.min(...values.map((position) => position.y), -ATLAS_HALF_HEIGHT);
  const maxY = Math.max(...values.map((position) => position.y), ATLAS_HALF_HEIGHT);
  return {
    positions,
    minX,
    maxX,
    minY,
    maxY,
    minimumSpacing: Number.isFinite(minimumSpacing) ? minimumSpacing : 0,
    aspectRatio: (maxX - minX) / Math.max(1, maxY - minY),
    anchorCount,
  };
}

export function digestNeuralAtlas(layout: NeuralAtlasLayout) {
  const value = [...layout.positions.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((position) => `${position.id}:${position.anchorId}:${position.x.toFixed(2)},${position.y.toFixed(2)}`)
    .join('|');
  return hash32(value).toString(16).padStart(8, '0');
}
