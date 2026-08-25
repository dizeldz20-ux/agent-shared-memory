import { useEffect, useCallback, useLayoutEffect, useMemo, useRef, useState, memo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { BrainData, BrainNode, LiveActivitySource } from './types';
import { LAYER_COLORS } from './types';
import {
  buildAnatomicalGraph2D,
  digestAnatomicalTargets,
  hash01,
  hash32,
  linkIds,
  safeFrame2D,
  type AnatomicalLink2D,
  type AnatomicalNode2D,
} from './anatomical2d';
import {
  NEURON_GLOW,
  mixColor,
  neuronSpriteKey,
  neuronSpriteSize,
  paintNeuron,
  rgba,
  type NeuronState,
} from './neuronSprite';
import {
  applyCorticalRingPins,
  computeCorticalRings,
  digestRingLayout,
  ringPoint,
} from './corticalRings';
import {
  applyDragDelta,
  createDragRelaxation,
  createDragRelaxationWorld,
  dragInfluence as buildDragInfluence,
  pinAtCurrentPosition,
  stepDragRelaxation,
  type DragRelaxationState,
} from './dragField';
import { liveAgentPalette } from './liveAgentPalette';
import {
  LIVE_SIGNAL_DURATION_MS,
  LIVE_SIGNAL_LIMITS,
  buildLiveSignalSegments3D,
  digestLiveSignalSegments3D,
} from './brain3d';

export type Layout2D = 'graph' | 'rings';

interface Props {
  data: BrainData;
  active: Map<string, number>;
  activeAgents: Map<string, string>;
  activeSources: Map<string, LiveActivitySource>;
  layerVisible: Record<string, boolean>;
  selected: BrainNode | null;
  hovered: BrainNode | null;
  onSelect: (n: BrainNode | null) => void;
  onHover: (n: BrainNode | null) => void;
  fgRef: React.MutableRefObject<any>;
  layout: Layout2D;
  motionEnabled: boolean;
  layoutResetToken: number;
  activityRevision: number;
  positionCache: Map<string, { x: number; y: number }>;
}

declare global {
  interface Window { __asm?: { network?: Record<string, unknown>; rings?: Record<string, unknown>; brain3d?: Record<string, unknown> } }
}

function nodeRadius(node: BrainNode, degree: number) {
  const base = { root: 6.4, dir: 3.8, page: 2.35, file: 1.45, ephemeral: 2.4 }[node.kind] ?? 2;
  return base + Math.min(2.6, Math.log2(degree + 1) * 0.42);
}

function collisionRadius2D(node: BrainNode, degree: number) {
  const base = { root: 5.2, dir: 3.25, page: 1.85, file: 1.2, ephemeral: 1.7 }[node.kind] ?? 1.5;
  return base + Math.min(1.5, Math.log2(degree + 1) * 0.24);
}

function linkEnds(link: any) {
  const source = link.__sourceId ?? (typeof link.source === 'object' ? link.source.id : link.source);
  const target = link.__targetId ?? (typeof link.target === 'object' ? link.target.id : link.target);
  return { source, target };
}

function linkKey(link: AnatomicalLink2D) {
  return `${link.__sourceId}>${link.__targetId}:${link.type}`;
}

function liveEdgeKey(sourceId: string, targetId: string) {
  return sourceId < targetId ? `${sourceId}\u0000${targetId}` : `${targetId}\u0000${sourceId}`;
}

type BackgroundLinkType = 'contains' | 'code' | 'link' | 'xlayer';
type LinkPathTarget = Pick<Path2D, 'moveTo' | 'lineTo' | 'quadraticCurveTo'>;
type BackgroundPathCache = {
  key: string;
  paths: Record<BackgroundLinkType, Path2D>;
  counts: Record<BackgroundLinkType, number>;
};

function backgroundLinkType(link: AnatomicalLink2D): BackgroundLinkType {
  return link.type === 'code' || link.type === 'link' || link.type === 'xlayer'
    ? link.type
    : 'contains';
}

function traceBackgroundLink(
  path: LinkPathTarget,
  link: AnatomicalLink2D,
  source: AnatomicalNode2D,
  target: AnatomicalNode2D,
) {
  const sourceX = source.x ?? 0;
  const sourceY = source.y ?? 0;
  const targetX = target.x ?? 0;
  const targetY = target.y ?? 0;
  const type = backgroundLinkType(link);
  path.moveTo(sourceX, sourceY);
  if (type === 'contains') {
    path.lineTo(targetX, targetY);
    return type;
  }
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const direction = hash32(`${link.__sourceId}>${link.__targetId}:curve`) % 2 ? 1 : -1;
  const baseBend = type === 'xlayer'
    ? Math.min(190, distance * 0.2) * (0.72 + Math.abs(link.__curvature) * 1.15)
    : Math.min(52, distance * (type === 'link' ? 0.085 : 0.045));
  const bend = baseBend * direction;
  path.quadraticCurveTo(
    (sourceX + targetX) / 2 + normalX * bend,
    (sourceY + targetY) / 2 + normalY * bend,
    targetX,
    targetY,
  );
  return type;
}

function emptyBackgroundPathCache(key: string): BackgroundPathCache {
  return {
    key,
    paths: {
      contains: new Path2D(),
      code: new Path2D(),
      link: new Path2D(),
      xlayer: new Path2D(),
    },
    counts: { contains: 0, code: 0, link: 0, xlayer: 0 },
  };
}

function appendBackgroundLink(
  cache: BackgroundPathCache,
  link: AnatomicalLink2D,
  source: AnatomicalNode2D,
  target: AnatomicalNode2D,
) {
  const type = backgroundLinkType(link);
  traceBackgroundLink(cache.paths[type], link, source, target);
  cache.counts[type] += 1;
}

function alphaColor(color: string, alpha: number) {
  const hex = color.replace('#', '');
  if (hex.length !== 6) return color;
  const value = Number.parseInt(hex, 16);
  return `rgba(${value >> 16},${(value >> 8) & 255},${value & 255},${alpha})`;
}

function digestLivePositions(nodes: AnatomicalNode2D[]) {
  const canonical = nodes
    .map((node) => `${node.id}:${(node.x ?? 0).toFixed(2)},${(node.y ?? 0).toFixed(2)}`)
    .sort()
    .join('|');
  return hash32(canonical).toString(16).padStart(8, '0');
}

export const Brain2D = memo(function Brain2D({
  data, active, activeAgents, activeSources, layerVisible, selected, hovered, onSelect, onHover, fgRef, layout, motionEnabled, layoutResetToken, activityRevision, positionCache,
}: Props) {
  // Prepare the selected layout before ForceGraph receives graphData. In CORTEX,
  // a live structural add must never expose the atlas/MAP coordinates for even a
  // single frame while an effect catches up.
  const prepared = useMemo(() => {
    const graph = buildAnatomicalGraph2D(data);
    const rings = computeCorticalRings(graph.nodes);
    const ringPinnedCount = layout === 'rings' ? applyCorticalRingPins(graph.nodes, rings) : 0;
    const validIds = new Set(graph.nodes.map((node) => node.id));
    for (const id of positionCache.keys()) if (!validIds.has(id)) positionCache.delete(id);
    for (const node of graph.nodes) {
      const cached = positionCache.get(node.id);
      if (!cached) continue;
      node.x = cached.x;
      node.y = cached.y;
      node.fx = cached.x;
      node.fy = cached.y;
      node.vx = 0;
      node.vy = 0;
    }
    return { graph, rings, ringPinnedCount };
  }, [data, layout, layoutResetToken, positionCache]);
  const { graph, rings, ringPinnedCount } = prepared;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragField, setDragField] = useState<Map<string, number>>(() => new Map());
  const draggingIdRef = useRef<string | null>(null);
  const dragFieldRef = useRef<Map<string, number>>(new Map());
  const relaxationRef = useRef<DragRelaxationState | null>(null);
  const dragDeltaRef = useRef({ x: 0, y: 0 });
  const dragFrameRef = useRef<number | null>(null);
  const settleFrameRef = useRef<number | null>(null);
  const settleStepRef = useRef(0);
  const settleQuietRef = useRef(0);
  const lastCollisionCount = useRef(0);
  const collisionCountTotal = useRef(0);
  const lastRelaxingNodeCount = useRef(0);
  const lastDragNeighborCount = useRef(0);
  const initializedLayoutRef = useRef<Layout2D | null>(null);
  const initializedResetTokenRef = useRef(layoutResetToken);
  const backgroundPaths = useRef<BackgroundPathCache | null>(null);
  const backgroundRebuildRef = useRef({ generation: 0, frame: null as number | null, pending: false });
  const foregroundDragLinksRef = useRef<Set<AnatomicalLink2D>>(new Set());
  const deformedLinksRef = useRef<Set<AnatomicalLink2D>>(new Set());
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const physicsNodeById = useMemo(
    () => new Map(graph.nodes.filter((node) => layerVisible[node.layer] !== false).map((node) => [node.id, node])),
    [graph.nodes, layerVisible],
  );
  // Route only across links already painted in the shared MAP/CORTEX graph,
  // including hierarchy, code, memory and cross-layer synapses.
  const liveRouteLinks = graph.links;
  const selectedId = selected?.id ?? null;
  const hoveredId = hovered?.id ?? null;
  const layerSignature = useMemo(() => Object.entries(layerVisible).sort(([a], [b]) => a.localeCompare(b)).map(([layer, visible]) => `${layer}:${visible ? 1 : 0}`).join('|'), [layerVisible]);

  const cancelBackgroundRebuild = useCallback(() => {
    const rebuild = backgroundRebuildRef.current;
    rebuild.generation += 1;
    if (rebuild.frame != null) cancelAnimationFrame(rebuild.frame);
    rebuild.frame = null;
    rebuild.pending = false;
  }, []);

  const graphMetrics = useMemo(() => {
    const degree = new Map<string, number>();
    const neighbors = new Map<string, Set<string>>();
    const incidentLinks = new Map<string, AnatomicalLink2D[]>();
    for (const node of graph.nodes) neighbors.set(node.id, new Set());
    for (const link of graph.links) {
      const { source, target } = linkEnds(link);
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
      neighbors.get(source)?.add(target);
      neighbors.get(target)?.add(source);
      const sourceLinks = incidentLinks.get(source) ?? [];
      sourceLinks.push(link);
      incidentLinks.set(source, sourceLinks);
      const targetLinks = incidentLinks.get(target) ?? [];
      targetLinks.push(link);
      incidentLinks.set(target, targetLinks);
    }
    return { degree, neighbors, incidentLinks };
  }, [graph]);
  const relaxationWorld = useMemo(() => createDragRelaxationWorld(
    physicsNodeById,
    (candidate) => collisionRadius2D(candidate as AnatomicalNode2D, graphMetrics.degree.get(candidate.id) ?? 0),
    { dimensions: 2, collisionPadding: 0.42 },
  ), [graphMetrics.degree, physicsNodeById]);
  const liveSources = useMemo(() => {
    const now = Date.now();
    const candidates = [...activeSources.entries()]
      .filter(([, source]) => {
        const node = nodeById.get(source.nodeId);
        return Boolean(node) && source.until >= now && layerVisible[node!.layer] !== false;
      })
      .sort((a, b) => b[1].until - a[1].until || a[0].localeCompare(b[0]));
    const lanes = new Map<string, Array<[string, LiveActivitySource]>>();
    for (const candidate of candidates) {
      const laneId = candidate[1].agent;
      const lane = lanes.get(laneId) ?? [];
      lane.push(candidate);
      lanes.set(laneId, lane);
    }
    const sources: Array<[string, LiveActivitySource]> = [];
    const orderedLanes = [...lanes.values()];
    for (let depth = 0; sources.length < LIVE_SIGNAL_LIMITS.maxSources; depth++) {
      let added = false;
      for (const lane of orderedLanes) {
        const candidate = lane[depth];
        if (!candidate) continue;
        sources.push(candidate);
        added = true;
        if (sources.length >= LIVE_SIGNAL_LIMITS.maxSources) break;
      }
      if (!added) break;
    }
    return sources;
    // activeSources is a mutable ref; activityRevision is its render token.
  }, [activeSources, activityRevision, layerVisible, nodeById]);
  const liveSegments = useMemo(() => buildLiveSignalSegments3D(
    { ...graph, degree: graphMetrics.degree } as any,
    liveSources.map(([key, source]) => ({ id: source.nodeId, originId: key })),
    {},
    liveRouteLinks as any,
  ).filter((segment) => {
    const source = nodeById.get(segment.sourceId);
    const target = nodeById.get(segment.targetId);
    return Boolean(source && target)
      && layerVisible[source!.layer] !== false
      && layerVisible[target!.layer] !== false;
  }), [graph, graphMetrics.degree, layerVisible, liveRouteLinks, liveSources, nodeById]);
  const liveEdgeKeys = useMemo(
    () => new Set(liveSegments.map((segment) => liveEdgeKey(segment.sourceId, segment.targetId))),
    [liveSegments],
  );
  const liveSignalDigest = useMemo(() => digestLiveSignalSegments3D(liveSegments), [liveSegments]);
  const canvasGraph = useMemo(() => ({ nodes: graph.nodes, links: [] }), [graph.nodes]);

  // Hover is a local highlight only. It must not hide the global topology.
  const focusId = draggingId ?? selectedId;
  const focusIds = useMemo(() => {
    if (!focusId) return null;
    return new Set([focusId, ...(graphMetrics.neighbors.get(focusId) ?? [])]);
  }, [focusId, graphMetrics]);

  const ringLinkState = useMemo(() => {
    if (layout !== 'rings') return { keys: new Set<string>(), activeCount: 0 };
    const ranked = graph.links
      .map((link) => {
        const activeNow = liveEdgeKeys.has(liveEdgeKey(link.__sourceId, link.__targetId));
        const focused = !!focusIds && focusIds.has(link.__sourceId) && focusIds.has(link.__targetId);
        if (!activeNow && !focused) return null;
        const directFocus = !!focusId && (link.__sourceId === focusId || link.__targetId === focusId);
        return { link, activeNow, priority: directFocus ? 0 : activeNow ? 1 : 2 };
      })
      .filter((entry): entry is { link: AnatomicalLink2D; activeNow: boolean; priority: number } => entry !== null)
      .sort((a, b) => a.priority - b.priority || b.link.__tier - a.link.__tier || linkKey(a.link).localeCompare(linkKey(b.link)))
      .slice(0, 320);
    return {
      keys: new Set(ranked.map(({ link }) => linkKey(link))),
      activeCount: ranked.filter(({ activeNow }) => activeNow).length,
    };
  }, [focusId, focusIds, graph, layout, liveEdgeKeys]);
  const ringVisibleLinks = ringLinkState.keys;
  const ringActiveLinkCount = ringLinkState.activeCount;

  const isActive = useCallback((id: string) => {
    const until = active.get(id);
    if (!until) return false;
    if (until < Date.now()) { active.delete(id); activeAgents.delete(id); return false; }
    return true;
  }, [active, activeAgents]);

  const backgroundLinkCount = useMemo(() => graph.links.filter((link) => {
    const source = nodeById.get(link.__sourceId);
    const target = nodeById.get(link.__targetId);
    return layerVisible[source?.layer ?? ''] !== false && layerVisible[target?.layer ?? ''] !== false;
  }).length, [graph.links, layerVisible, nodeById]);
  const visibleNodeCount = useMemo(
    () => graph.nodes.filter((node) => layerVisible[node.layer] !== false).length,
    [graph.nodes, layerVisible],
  );

  const visibleLink = useCallback((l: AnatomicalLink2D, zoom = 1, forceFocus = false) => {
    const s = nodeById.get(l.__sourceId);
    const t = nodeById.get(l.__targetId);
    if (s && layerVisible[s.layer] === false) return false;
    if (t && layerVisible[t.layer] === false) return false;
    if (dragFieldRef.current.size && (dragFieldRef.current.has(l.__sourceId) || dragFieldRef.current.has(l.__targetId))) return true;
    if (layout === 'rings') return ringVisibleLinks.has(linkKey(l));
    if (focusIds || forceFocus) {
      const ids = focusIds ?? (selectedId ? new Set([selectedId, ...(graphMetrics.neighbors.get(selectedId) ?? [])]) : null);
      return !!ids && ids.has(l.__sourceId) && ids.has(l.__targetId);
    }
    return isActive(l.__sourceId) || isActive(l.__targetId);
  }, [focusIds, graphMetrics, isActive, layerVisible, layout, nodeById, ringVisibleLinks, selectedId]);

  /**
   * `zoomToFit` frames the whole canvas, which the header overlays. Frame the band
   * below it instead: anatomical targets while the layout is still expanding,
   * settled positions once the engine stops (see `onEngineStop`).
   */
  const fitToSafeArea = useCallback((ms: number, from: 'targets' | 'settled' = 'settled') => {
    const fg = fgRef.current;
    const canvas = document.querySelector('.force-graph-container canvas') as HTMLCanvasElement | null;
    if (!fg || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const headerBottom = document.querySelector('.instrument-header')?.getBoundingClientRect().bottom ?? rect.top;
    const points = from === 'targets'
      ? graph.nodes.map((n) => ({ x: n.__targetX, y: n.__targetY, kind: n.kind, __degree: graphMetrics.degree.get(n.id) ?? 0 }))
      : graph.nodes.map((n) => ({ x: n.x, y: n.y, kind: n.kind, __degree: graphMetrics.degree.get(n.id) ?? 0 }));
    const frame = safeFrame2D(points, {
      width: rect.width,
      height: rect.height,
      safeTop: Math.max(16, headerBottom - rect.top + 16),
      bottomPadding: 104,
    });
    // The brain only grows while the layout expands, so the fitted zoom only
    // shrinks. Re-frame on real growth and stay still otherwise: a camera that
    // nudges every tick never lets the UI settle.
    if (from === 'settled' && frame.k > lastFit.current * 0.99) return;
    lastFit.current = frame.k;
    fg.zoom(frame.k, ms);
    fg.centerAt(frame.x, frame.y, ms);
  }, [fgRef, graph.nodes, graphMetrics]);

  useLayoutEffect(() => {
    if (!graph.nodes.length) return;
    const shouldFrame = initializedLayoutRef.current !== layout
      || initializedResetTokenRef.current !== layoutResetToken;
    initializedLayoutRef.current = layout;
    initializedResetTokenRef.current = layoutResetToken;
    if (layout !== 'rings' && window.__asm) delete window.__asm.rings;
    if (dragFrameRef.current != null) cancelAnimationFrame(dragFrameRef.current);
    if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current);
    dragFrameRef.current = null;
    settleFrameRef.current = null;
    relaxationRef.current = null;
    dragDeltaRef.current = { x: 0, y: 0 };
    settleQuietRef.current = 0;
    settleStepRef.current = 0;
    draggingIdRef.current = null;
    dragFieldRef.current = new Map();
    foregroundDragLinksRef.current = new Set();
    deformedLinksRef.current = new Set();
    cancelBackgroundRebuild();
    lastDragNeighborCount.current = 0;
    setDraggingId(null);
    setDragField(new Map());
    backgroundPaths.current = null;
    if (shouldFrame) lastFit.current = Infinity;
    const fg = fgRef.current;
    if (!fg) return;
    try {
      fg.d3Force('charge', null);
      fg.d3Force('link', null);
      fg.d3Force('anatomy', null);
      if (shouldFrame) fitToSafeArea(0, layout === 'rings' ? 'settled' : 'targets');
      fg.refresh?.();
      if (motionEnabled) fg.resumeAnimation?.();
      else fg.pauseAnimation?.();
    } catch (error) {
      console.error('ASM 2D layout initialization failed', error);
    }
  }, [cancelBackgroundRebuild, graph, layout, fgRef, fitToSafeArea, layoutResetToken, motionEnabled, rings]);

  useEffect(() => () => {
    if (dragFrameRef.current != null) cancelAnimationFrame(dragFrameRef.current);
    if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current);
    dragFrameRef.current = null;
    settleFrameRef.current = null;
    relaxationRef.current = null;
    foregroundDragLinksRef.current = new Set();
    deformedLinksRef.current = new Set();
    cancelBackgroundRebuild();
  }, [cancelBackgroundRebuild]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.refresh?.();
    const expiries = liveSources.map(([, source]) => source.until).filter((until) => until >= Date.now());
    if (!expiries.length) return;
    const timer = setTimeout(() => fg.refresh?.(), Math.max(24, Math.min(...expiries) - Date.now() + 24));
    return () => clearTimeout(timer);
  }, [activityRevision, fgRef, liveSources]);

  useEffect(() => {
    const canvas = liveCanvasRef.current;
    const fg = fgRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !fg?.graph2ScreenCoords) return;
    let animationFrame = 0;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;

    const clear = () => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };

    const paint = () => {
      const now = Date.now();
      const sources = new Map(liveSources.filter(([, source]) => source.until >= now));
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const pixelWidth = Math.round(width * pixelRatio);
      const pixelHeight = Math.round(height * pixelRatio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!sources.size) {
        canvas.dataset.liveSegments = '0';
        canvas.dataset.liveSources = '0';
        return;
      }

      const screenPoints = new Map<string, { x: number; y: number }>();
      const screenPoint = (nodeId: string) => {
        const cached = screenPoints.get(nodeId);
        if (cached) return cached;
        const node = nodeById.get(nodeId);
        if (!node || node.x == null || node.y == null) return null;
        const point = fg.graph2ScreenCoords(node.x, node.y);
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        screenPoints.set(nodeId, point);
        return point;
      };

      context.save();
      context.globalCompositeOperation = 'screen';
      let paintedSegments = 0;
      for (let index = 0; index < liveSegments.length; index++) {
        const segment = liveSegments[index];
        const liveSource = sources.get(segment.originId);
        if (!liveSource) continue;
        const source = screenPoint(segment.sourceId);
        const target = screenPoint(segment.targetId);
        if (!source || !target) continue;
        const palette = liveAgentPalette(liveSource.agent);
        context.globalAlpha = 0.76;
        context.strokeStyle = palette.route;
        context.lineWidth = 1.35;
        context.shadowBlur = 0;
        context.beginPath();
        context.moveTo(source.x, source.y);
        context.lineTo(target.x, target.y);
        context.stroke();
        paintedSegments += 1;

        const elapsed = motionEnabled ? now - (liveSource.until - LIVE_SIGNAL_DURATION_MS) : 620;
        const rawPhase = elapsed / 1060 - segment.depth * 0.16 + (index % 11) * 0.029;
        const phase = ((rawPhase % 1) + 1) % 1;
        for (let trailIndex = LIVE_SIGNAL_LIMITS.trailPointsPerSegment; trailIndex >= 1; trailIndex--) {
          const trailPhase = ((phase - trailIndex * 0.052) % 1 + 1) % 1;
          context.globalAlpha = 0.24 + (LIVE_SIGNAL_LIMITS.trailPointsPerSegment - trailIndex) * 0.16;
          context.fillStyle = palette.trail;
          context.beginPath();
          context.arc(
            source.x + (target.x - source.x) * trailPhase,
            source.y + (target.y - source.y) * trailPhase,
            1.7,
            0,
            Math.PI * 2,
          );
          context.fill();
        }
        context.globalAlpha = 0.98;
        context.fillStyle = palette.head;
        context.beginPath();
        context.arc(
          source.x + (target.x - source.x) * phase,
          source.y + (target.y - source.y) * phase,
          3.1,
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      for (const [, liveSource] of sources) {
        const point = screenPoint(liveSource.nodeId);
        if (!point) continue;
        const palette = liveAgentPalette(liveSource.agent);
        context.globalAlpha = 0.96;
        context.strokeStyle = palette.soma;
        context.lineWidth = 1.8;
        context.beginPath();
        context.arc(point.x, point.y, 8, 0, Math.PI * 2);
        context.stroke();
        context.globalAlpha = 0.24;
        context.lineWidth = 1;
        context.beginPath();
        context.arc(point.x, point.y, 12, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();
      canvas.dataset.liveSegments = String(paintedSegments);
      canvas.dataset.liveSources = String(sources.size);

      if (motionEnabled) animationFrame = requestAnimationFrame(paint);
      else {
        const nextExpiry = Math.min(...[...sources.values()].map((source) => source.until));
        expiryTimer = setTimeout(paint, Math.max(24, nextExpiry - Date.now() + 24));
      }
    };

    animationFrame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(animationFrame);
      if (expiryTimer) clearTimeout(expiryTimer);
      canvas.dataset.liveSegments = '0';
      canvas.dataset.liveSources = '0';
      clear();
    };
  }, [activityRevision, fgRef, liveSegments, liveSources, motionEnabled, nodeById]);

  useEffect(() => {
    if (layout !== 'graph') return;
    const focusVisibleLinkCount = focusIds ? graph.links.filter((l) => visibleLink(l, 1, true)).length : 0;
    const network: Record<string, unknown> = {
      anchorCount: graph.atlas.anchorCount,
      atlasAspectRatio: graph.atlas.aspectRatio,
      atlasMinimumSpacing: graph.atlas.minimumSpacing,
      backgroundLinkCount,
      curvatureBuckets: new Set(graph.links.map((l) => l.__curvature)).size,
      focusSize: focusIds?.size ?? 0,
      focusVisibleLinkCount,
      layout: 'neural-atlas',
      liveSignalAgentCount: new Set(liveSources.map(([, source]) => source.agent)).size,
      liveSignalBeadCount: liveSegments.length * (1 + LIVE_SIGNAL_LIMITS.trailPointsPerSegment),
      liveSignalDigest,
      liveSignalNodeCount: liveSources.length,
      liveSignalSegmentCount: liveSegments.length,
      motion: motionEnabled,
      nodeCoverageRatio: graph.nodes.length ? visibleNodeCount / graph.nodes.length : 1,
      overviewVisibleLinkCount: backgroundLinkCount,
      positionDigest: digestAnatomicalTargets(graph.nodes),
      selectedId,
      styleBuckets: new Set(graph.links.map((l) => l.__styleKey)).size,
      totalLinkCount: graph.links.length,
      visibleNodeCount,
    };
    Object.defineProperty(network, 'simulationRunning', {
      enumerable: true,
      get: () => Boolean(draggingIdRef.current || settleFrameRef.current != null),
    });
    // Live proof that the fit actually reserved the header band; a unit test cannot
    // catch a wrong canvas handle or a fit that never ran.
    Object.defineProperty(network, 'headerClippedNodeCount', {
      enumerable: true,
      get: () => {
        const fg = fgRef.current;
        const canvas = document.querySelector('.force-graph-container canvas');
        if (!fg?.graph2ScreenCoords || !canvas) return -1;
        const rect = canvas.getBoundingClientRect();
        const headerBottom = document.querySelector('.instrument-header')?.getBoundingClientRect().bottom ?? rect.top;
        let clipped = 0;
        for (const node of graph.nodes) {
          if (layerVisible[node.layer] === false) continue;
          if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
          const screen = fg.graph2ScreenCoords(node.x, node.y);
          if (rect.top + screen.y < headerBottom) clipped += 1;
        }
        return clipped;
      },
    });
    Object.defineProperty(network, 'livePositionDigest', {
      enumerable: true,
      get: () => digestLivePositions(graph.nodes),
    });
    Object.defineProperty(network, 'cameraPose', {
      enumerable: true,
      get: () => {
        const fg = fgRef.current;
        const center = fg?.centerAt?.() ?? { x: 0, y: 0 };
        return [Number(center.x ?? 0), Number(center.y ?? 0), Number(fg?.zoom?.() ?? 1)];
      },
    });
    Object.defineProperty(network, 'draggingId', {
      enumerable: false,
      get: () => draggingIdRef.current,
    });
    Object.defineProperty(network, 'hoveredId', {
      enumerable: false,
      get: () => hoveredId,
    });
    Object.defineProperty(network, 'lastDragNeighborCount', {
      enumerable: false,
      get: () => lastDragNeighborCount.current,
    });
    Object.defineProperty(network, 'lastCollisionCount', {
      enumerable: false,
      get: () => lastCollisionCount.current,
    });
    Object.defineProperty(network, 'collisionCountTotal', {
      enumerable: false,
      get: () => collisionCountTotal.current,
    });
    Object.defineProperty(network, 'relaxingNodeCount', {
      enumerable: false,
      get: () => lastRelaxingNodeCount.current,
    });
    Object.defineProperty(network, 'backgroundRebuildPending', {
      enumerable: false,
      get: () => backgroundRebuildRef.current.pending,
    });
    Object.defineProperty(network, 'deformedLinkCount', {
      enumerable: false,
      get: () => deformedLinksRef.current.size,
    });
    Object.defineProperty(network, 'nodePosition', {
      enumerable: false,
      value: (id: string) => {
        const node = nodeById.get(id);
        return node ? { x: node.x ?? 0, y: node.y ?? 0 } : null;
      },
    });
    Object.defineProperty(network, 'collisionProbe', {
      enumerable: false,
      get: () => {
        const fg = fgRef.current;
        const canvas = document.querySelector('.force-graph-container canvas') as HTMLCanvasElement | null;
        const source = graph.nodes.find((node) => node.kind === 'root' && layerVisible[node.layer] !== false);
        if (!fg?.graph2ScreenCoords || !canvas || !source || source.x == null || source.y == null) return null;
        const connected = graphMetrics.neighbors.get(source.id) ?? new Set<string>();
        let target: AnatomicalNode2D | undefined;
        let nearest = Number.POSITIVE_INFINITY;
        for (const candidate of graph.nodes) {
          if (candidate.id === source.id || connected.has(candidate.id) || layerVisible[candidate.layer] === false) continue;
          if (candidate.x == null || candidate.y == null) continue;
          const distance = (candidate.x - source.x) ** 2 + (candidate.y - source.y) ** 2;
          if (distance < nearest) { nearest = distance; target = candidate; }
        }
        if (!target || target.x == null || target.y == null) return null;
        const sourceScreen = fg.graph2ScreenCoords(source.x, source.y);
        const targetScreen = fg.graph2ScreenCoords(target.x, target.y);
        const rect = canvas.getBoundingClientRect();
        return {
          sourceId: source.id,
          targetId: target.id,
          source: { x: rect.left + sourceScreen.x, y: rect.top + sourceScreen.y },
          target: { x: rect.left + targetScreen.x, y: rect.top + targetScreen.y },
        };
      },
    });
    Object.defineProperty(network, 'interactionTarget', {
      enumerable: false,
      get: () => {
        const fg = fgRef.current;
        const canvas = document.querySelector('.force-graph-container canvas') as HTMLCanvasElement | null;
        const target = nodeById.get(selectedId ?? '') ?? graph.nodes.find((node) => node.kind === 'root');
        if (!fg?.graph2ScreenCoords || !canvas || !target || target.x == null || target.y == null) return null;
        const screen = fg.graph2ScreenCoords(target.x, target.y);
        const rect = canvas.getBoundingClientRect();
        return { id: target.id, x: rect.left + screen.x, y: rect.top + screen.y };
      },
    });
    window.__asm = {
      ...(window.__asm ?? {}),
      network,
    };
  }, [
    activeAgents,
    backgroundLinkCount,
    focusIds,
    graph,
    layout,
    liveSegments.length,
    liveSignalDigest,
    liveSources,
    motionEnabled,
    selectedId,
    visibleLink,
    visibleNodeCount,
  ]);

  useEffect(() => {
    if (layout !== 'rings' || ringPinnedCount !== graph.nodes.length) return;
    const ringsDebug: Record<string, unknown> = {
      activeLinkCount: ringActiveLinkCount,
      ambientEnabled: false,
      arcGapCountMin: rings.arcGapCountMin,
      backgroundLinkCount,
      bandCount: rings.bands.length,
      coreRadius: rings.coreRadius,
      ellipseRatioMax: rings.ellipseRatioMax,
      ellipseRatioMin: rings.ellipseRatioMin,
      fitZoom: lastFit.current,
      geometryDigest: digestRingLayout(rings),
      layout: 'cortical-sheet',
      liveSignalAgentCount: new Set(liveSources.map(([, source]) => source.agent)).size,
      liveSignalBeadCount: liveSegments.length * (1 + LIVE_SIGNAL_LIMITS.trailPointsPerSegment),
      liveSignalDigest,
      liveSignalNodeCount: liveSources.length,
      liveSignalSegmentCount: liveSegments.length,
      maxOffBandDistance: rings.maxOffBandDistance,
      maxRingPositionError: graph.nodes.reduce((maximum, node) => {
        const target = rings.positions.get(node.id);
        if (!target || node.x == null || node.y == null) return Number.POSITIVE_INFINITY;
        return Math.max(maximum, Math.hypot(node.x - target.x, node.y - target.y));
      }, 0),
      pinnedNodeCount: ringPinnedCount,
      radialJitterMax: rings.radialJitterMax,
      selectedId,
      totalNodeCount: graph.nodes.length,
      nodeCoverageRatio: graph.nodes.length ? visibleNodeCount / graph.nodes.length : 1,
      visibleLinkCount: backgroundLinkCount,
      visibleNodeCount,
    };
    Object.defineProperty(ringsDebug, 'draggingId', {
      enumerable: false,
      get: () => draggingIdRef.current,
    });
    Object.defineProperty(ringsDebug, 'cameraPose', {
      enumerable: true,
      get: () => {
        const fg = fgRef.current;
        const center = fg?.centerAt?.() ?? { x: 0, y: 0 };
        return [Number(center.x ?? 0), Number(center.y ?? 0), Number(fg?.zoom?.() ?? 1)];
      },
    });
    Object.defineProperty(ringsDebug, 'hoveredId', {
      enumerable: false,
      get: () => hoveredId,
    });
    Object.defineProperty(ringsDebug, 'lastDragNeighborCount', {
      enumerable: false,
      get: () => lastDragNeighborCount.current,
    });
    Object.defineProperty(ringsDebug, 'lastCollisionCount', {
      enumerable: false,
      get: () => lastCollisionCount.current,
    });
    Object.defineProperty(ringsDebug, 'collisionCountTotal', {
      enumerable: false,
      get: () => collisionCountTotal.current,
    });
    Object.defineProperty(ringsDebug, 'relaxingNodeCount', {
      enumerable: false,
      get: () => lastRelaxingNodeCount.current,
    });
    Object.defineProperty(ringsDebug, 'backgroundRebuildPending', {
      enumerable: false,
      get: () => backgroundRebuildRef.current.pending,
    });
    Object.defineProperty(ringsDebug, 'deformedLinkCount', {
      enumerable: false,
      get: () => deformedLinksRef.current.size,
    });
    Object.defineProperty(ringsDebug, 'simulationRunning', {
      enumerable: false,
      get: () => Boolean(draggingIdRef.current || settleFrameRef.current != null),
    });
    Object.defineProperty(ringsDebug, 'nodePosition', {
      enumerable: false,
      value: (id: string) => {
        const node = nodeById.get(id);
        return node ? { x: node.x ?? 0, y: node.y ?? 0 } : null;
      },
    });
    Object.defineProperty(ringsDebug, 'collisionProbe', {
      enumerable: false,
      get: () => {
        const fg = fgRef.current;
        const canvas = document.querySelector('.force-graph-container canvas') as HTMLCanvasElement | null;
        const source = graph.nodes.reduce<AnatomicalNode2D | undefined>((best, node) => {
          if (layerVisible[node.layer] === false || node.x == null || node.y == null) return best;
          if (!best || best.x == null || best.y == null) return node;
          return node.x * node.x + node.y * node.y > best.x * best.x + best.y * best.y ? node : best;
        }, undefined);
        if (!fg?.graph2ScreenCoords || !canvas || !source || source.x == null || source.y == null) return null;
        const connected = graphMetrics.neighbors.get(source.id) ?? new Set<string>();
        let target: AnatomicalNode2D | undefined;
        let nearest = Number.POSITIVE_INFINITY;
        for (const candidate of graph.nodes) {
          if (candidate.id === source.id || connected.has(candidate.id) || layerVisible[candidate.layer] === false) continue;
          if (candidate.x == null || candidate.y == null) continue;
          const distance = (candidate.x - source.x) ** 2 + (candidate.y - source.y) ** 2;
          if (distance < nearest) { nearest = distance; target = candidate; }
        }
        if (!target || target.x == null || target.y == null) return null;
        const sourceScreen = fg.graph2ScreenCoords(source.x, source.y);
        const targetScreen = fg.graph2ScreenCoords(target.x, target.y);
        const rect = canvas.getBoundingClientRect();
        return {
          sourceId: source.id,
          targetId: target.id,
          source: { x: rect.left + sourceScreen.x, y: rect.top + sourceScreen.y },
          target: { x: rect.left + targetScreen.x, y: rect.top + targetScreen.y },
        };
      },
    });
    Object.defineProperty(ringsDebug, 'collisionProbeFor', {
      enumerable: false,
      value: (sourceId: string) => {
        const fg = fgRef.current;
        const canvas = document.querySelector('.force-graph-container canvas') as HTMLCanvasElement | null;
        const source = nodeById.get(sourceId);
        if (!fg?.graph2ScreenCoords || !canvas || !source || source.x == null || source.y == null) return null;
        const connected = graphMetrics.neighbors.get(source.id) ?? new Set<string>();
        let target: AnatomicalNode2D | undefined;
        let nearest = Number.POSITIVE_INFINITY;
        for (const candidate of graph.nodes) {
          if (candidate.id === source.id || connected.has(candidate.id) || layerVisible[candidate.layer] === false) continue;
          if (candidate.x == null || candidate.y == null) continue;
          const distance = (candidate.x - source.x) ** 2 + (candidate.y - source.y) ** 2;
          if (distance < nearest) { nearest = distance; target = candidate; }
        }
        if (!target || target.x == null || target.y == null) return null;
        const sourceScreen = fg.graph2ScreenCoords(source.x, source.y);
        const targetScreen = fg.graph2ScreenCoords(target.x, target.y);
        const rect = canvas.getBoundingClientRect();
        return {
          sourceId: source.id,
          targetId: target.id,
          source: { x: rect.left + sourceScreen.x, y: rect.top + sourceScreen.y },
          target: { x: rect.left + targetScreen.x, y: rect.top + targetScreen.y },
        };
      },
    });
    Object.defineProperty(ringsDebug, 'interactionTarget', {
      enumerable: false,
      get: () => {
        const fg = fgRef.current;
        const canvas = document.querySelector('.force-graph-container canvas') as HTMLCanvasElement | null;
        const target = nodeById.get(selectedId ?? '') ?? graph.nodes.find((node) => node.kind === 'root');
        if (!fg?.graph2ScreenCoords || !canvas || !target || target.x == null || target.y == null) return null;
        const screen = fg.graph2ScreenCoords(target.x, target.y);
        const rect = canvas.getBoundingClientRect();
        return { id: target.id, x: rect.left + screen.x, y: rect.top + screen.y };
      },
    });
    window.__asm = {
      ...(window.__asm ?? {}),
      rings: ringsDebug,
    };
  }, [
    activeAgents,
    backgroundLinkCount,
    graph.nodes.length,
    graphMetrics.neighbors,
    hoveredId,
    layerVisible,
    layout,
    liveSegments.length,
    liveSignalDigest,
    liveSources,
    ringActiveLinkCount,
    ringPinnedCount,
    rings,
    selectedId,
    visibleNodeCount,
  ]);

  const tick = useRef(0);
  const lastFit = useRef(Infinity);
  const sprites = useRef(new Map<string, HTMLCanvasElement>());
  const neuronSprite = useCallback((color: string, state: NeuronState, core: boolean) => {
    const key = neuronSpriteKey(color, state, core);
    let sprite = sprites.current.get(key);
    if (!sprite) {
      const size = neuronSpriteSize();
      sprite = document.createElement('canvas');
      sprite.width = size;
      sprite.height = size;
      const spriteCtx = sprite.getContext('2d');
      if (!spriteCtx) return null;
      paintNeuron(spriteCtx, color, state, core);
      sprites.current.set(key, sprite);
    }
    return sprite;
  }, []);

  const nodeIsInteractive = useCallback((n: AnatomicalNode2D, scale: number) => {
    const degree = graphMetrics.degree.get(n.id) ?? 0;
    const activeNow = isActive(n.id);
    const picked = selectedId === n.id || hoveredId === n.id || draggingId === n.id;
    const isFocus = focusIds?.has(n.id) ?? false;
    return scale >= 0.55 || n.kind === 'root' || (n.kind === 'dir' && degree >= 8)
      || (n.kind === 'page' && hash32(`${n.id}:page-lod`) % 3 === 0)
      || degree >= 16 || hash32(`${n.id}:lod`) % (layout === 'rings' ? 18 : 16) === 0
      || scale >= 4 || activeNow || picked || isFocus;
  }, [draggingId, focusIds, graphMetrics.degree, hoveredId, isActive, layout, selectedId]);

  const drawNode = useCallback((n: AnatomicalNode2D, ctx: CanvasRenderingContext2D, scale: number) => {
    const degree = graphMetrics.degree.get(n.id) ?? 0;
    const activeNow = isActive(n.id);
    const isFocus = focusIds?.has(n.id) ?? false;
    const dragged = draggingId === n.id;
    const pulled = dragField.has(n.id);
    const picked = selectedId === n.id || hoveredId === n.id || dragged;
    ctx.save();
    const color = dragged ? '#f2fbf7' : activeNow ? '#d8bf91' : picked ? '#eef7f3' : pulled ? '#a9e0dc' : n.layer === 'asm' ? '#a7cfca' : '#78918f';
    const ringScale = layout === 'rings' ? (n.layer === 'asm' ? 0.54 : 0.64) : 0.82;
    const r = nodeRadius(n, degree) * ringScale * (activeNow || picked ? 1.22 : 1);
    const dim = focusIds && !isFocus ? (layout === 'rings' ? 0.1 : 0.16) : layout === 'rings' && n.layer === 'asm' ? 0.68 : 1;
    ctx.globalAlpha = dim;

    const detailed = scale >= 2.35 || n.kind === 'root' || n.kind === 'dir' || activeNow || picked || isFocus || pulled;
    if (!detailed) {
      const screenRadius = n.kind === 'page' ? 0.82 : 0.58;
      const microRadius = Math.max(0.28, screenRadius / Math.max(0.2, scale));
      ctx.globalAlpha = (focusIds && !isFocus ? 0.16 : layout === 'rings' ? 0.5 : 0.58);
      ctx.fillStyle = n.layer === 'asm' ? '#b6ded9' : n.kind === 'page' ? '#9eb4b2' : '#73918f';
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, microRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    if (n.kind === 'root' || n.kind === 'dir') {
      const field = ctx.createRadialGradient(n.x!, n.y!, 0, n.x!, n.y!, r * (n.kind === 'root' ? 4.2 : 2.8));
      field.addColorStop(0, alphaColor(color, layout === 'rings' ? 0.045 : 0.075));
      field.addColorStop(1, 'rgba(6,9,19,0)');
      ctx.fillStyle = field;
      ctx.beginPath(); ctx.arc(n.x!, n.y!, r * (n.kind === 'root' ? 5.4 : 3.4), 0, 2 * Math.PI); ctx.fill();
    }

    const state: NeuronState = picked ? 'picked' : activeNow ? 'active' : isFocus ? 'focus' : 'idle';
    const rim = rgba(picked ? '#FFFFFF' : mixColor(color, '#FFFFFF', 0.5), 0.7);
    ctx.strokeStyle = rim;
    ctx.lineWidth = Math.max(0.7 / scale, 0.25);

    if (n.kind === 'ephemeral') {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(n.x!, n.y! - r); ctx.lineTo(n.x! + r, n.y!); ctx.lineTo(n.x!, n.y! + r); ctx.lineTo(n.x! - r, n.y!); ctx.closePath();
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else {
      const soma = neuronSprite(color, state, n.kind === 'root' || activeNow || picked);
      const extent = r * NEURON_GLOW;
      if (soma) ctx.drawImage(soma, n.x! - extent, n.y! - extent, extent * 2, extent * 2);
      else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI); ctx.fill(); }

      if (n.kind === 'dir') {
        // Dendrites: the axon stubs that make a hub read as a cell, not a dot.
        ctx.globalAlpha = dim * 0.75;
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2 + hash01(n.id) * 0.6;
          ctx.beginPath(); ctx.moveTo(n.x! + Math.cos(a) * r * 0.9, n.y! + Math.sin(a) * r * 0.9);
          ctx.lineTo(n.x! + Math.cos(a) * r * 2.1, n.y! + Math.sin(a) * r * 2.1); ctx.stroke();
        }
        ctx.globalAlpha = dim;
      }
    }
    ctx.shadowBlur = 0;
    const showLabel = layout === 'rings'
      ? picked || activeNow
      : picked || activeNow || (isFocus && n.kind !== 'file')
        || (scale > 7 && (n.kind === 'root' || n.kind === 'dir')) || scale > 10;
    if (showLabel) {
      ctx.font = `${picked ? 600 : 400} ${Math.max(10 / scale, 1.8)}px system-ui, Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = picked ? '#ffffff' : 'rgba(225,230,236,0.78)';
      ctx.fillText(n.label, n.x!, n.y! + r + 2);
    }
    ctx.restore();
  }, [dragField, draggingId, focusIds, graphMetrics, hoveredId, isActive, layout, neuronSprite, selectedId]);

  const drawBackgroundLinks = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    const key = `${layout}:${layerSignature}`;
    let cache = backgroundPaths.current;
    if (!cache || cache.key !== key) {
      cache = emptyBackgroundPathCache(key);
      for (const link of graph.links) {
        const source = nodeById.get(link.__sourceId);
        const target = nodeById.get(link.__targetId);
        if (!source || !target || source.x == null || source.y == null || target.x == null || target.y == null) continue;
        if (layerVisible[source.layer] === false || layerVisible[target.layer] === false) continue;
        appendBackgroundLink(cache, link, source, target);
      }
      backgroundPaths.current = cache;
    }

    const dim = focusIds ? 0.46 : 1;
    const cortex = layout === 'rings';
    const styles = {
      code: { color: `rgba(91,127,125,${(cortex ? 0.004 : 0.006) * dim})`, width: 0.28 },
      contains: { color: `rgba(113,153,150,${(cortex ? 0.024 : 0.032) * dim})`, width: 0.36 },
      link: { color: `rgba(137,177,173,${(cortex ? 0.034 : 0.045) * dim})`, width: 0.44 },
      xlayer: { color: `rgba(170,206,200,${(cortex ? 0.04 : 0.052) * dim})`, width: 0.52 },
    } as const;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (const type of ['code', 'contains', 'link', 'xlayer'] as const) {
      if (!cache.counts[type]) continue;
      ctx.strokeStyle = styles[type].color;
      ctx.lineWidth = styles[type].width / Math.max(0.2, scale);
      ctx.stroke(cache.paths[type]);
    }
    ctx.restore();
  }, [focusIds, graph.links, layerSignature, layerVisible, layout, nodeById]);

  const scheduleBackgroundRebuild = useCallback(() => {
    cancelBackgroundRebuild();
    const rebuild = backgroundRebuildRef.current;
    const generation = rebuild.generation;
    const cache = emptyBackgroundPathCache(`${layout}:${layerSignature}`);
    let linkIndex = 0;
    rebuild.pending = true;

    const buildChunk = () => {
      const current = backgroundRebuildRef.current;
      if (current.generation !== generation) return;
      const startedAt = performance.now();
      let processed = 0;
      // Keep each slice below a frame's rendering budget. The old topology stays
      // visible while the replacement Path2D is assembled, then swaps atomically.
      while (linkIndex < graph.links.length && processed < 720 && performance.now() - startedAt < 3.25) {
        const link = graph.links[linkIndex++];
        processed += 1;
        const source = nodeById.get(link.__sourceId);
        const target = nodeById.get(link.__targetId);
        if (!source || !target || source.x == null || source.y == null || target.x == null || target.y == null) continue;
        if (layerVisible[source.layer] === false || layerVisible[target.layer] === false) continue;
        appendBackgroundLink(cache, link, source, target);
      }
      if (linkIndex < graph.links.length) {
        current.frame = requestAnimationFrame(buildChunk);
        return;
      }
      current.frame = null;
      current.pending = false;
      backgroundPaths.current = cache;
      deformedLinksRef.current = new Set();
      fgRef.current?.refresh?.();
      if (!motionEnabled) fgRef.current?.pauseAnimation?.();
    };

    rebuild.frame = requestAnimationFrame(buildChunk);
  }, [cancelBackgroundRebuild, fgRef, graph.links, layerSignature, layerVisible, layout, motionEnabled, nodeById]);

  const drawField = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    if (layout === 'rings') {
      const field = ctx.createRadialGradient(0, 0, rings.coreRadius, 0, 0, Math.max(rings.maxX, rings.maxY));
      field.addColorStop(0, 'rgba(151,189,187,0.025)');
      field.addColorStop(0.48, 'rgba(113,150,147,0.016)');
      field.addColorStop(1, 'rgba(6,9,19,0)');
      ctx.fillStyle = field;
      ctx.beginPath();
      ctx.ellipse(0, 0, rings.maxX * 1.04, rings.maxY * 1.08, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const band of rings.bands) {
        ctx.strokeStyle = `rgba(128,163,159,${band.subBand === 0 ? 0.095 : 0.055})`;
        ctx.lineWidth = (band.subBand === 0 ? 0.9 : 0.62) / scale;
        for (const arc of band.arcs) {
          ctx.beginPath();
          for (let index = 0; index <= 42; index++) {
            const angle = arc.start + (arc.end - arc.start) * index / 42;
            const point = ringPoint(band, angle);
            if (index === 0) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
      return;
    }
    for (const side of [-1, 1]) {
      const centerX = side * 520;
      const halo = ctx.createRadialGradient(centerX, 0, 90, centerX, 0, 540);
      halo.addColorStop(0, 'rgba(128,163,159,0.018)');
      halo.addColorStop(1, 'rgba(3,7,8,0)');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.ellipse(centerX, 0, 478, 382, side * 0.012, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(170,203,198,0.075)';
      ctx.lineWidth = 0.9 / scale;
      ctx.beginPath();
      for (let index = 0; index <= 128; index++) {
        const angle = index / 128 * Math.PI * 2;
        const wobble = 1 + 0.038 * Math.sin(angle * 5 + side * 0.7) + 0.02 * Math.sin(angle * 11 - side);
        const x = centerX + Math.cos(angle) * 475 * wobble;
        const y = Math.sin(angle) * 378 * (1 + (wobble - 1) * 0.68);
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      for (let i = 0; i < 26; i++) {
        const y = -342 + i * 27;
        const x = centerX + side * (28 + (i * 73) % 330);
        ctx.strokeStyle = `rgba(128,163,159,${0.02 + (i % 4) * 0.006})`;
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.bezierCurveTo(x - side * 95, y + 14, x - side * 190, y + 34, x - side * 305, y + 48);
        ctx.stroke();
      }
    }
    ctx.restore();
  }, [layout, rings]);

  const drawSceneBackground = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    drawField(ctx, scale);
    drawBackgroundLinks(ctx, scale);
  }, [drawBackgroundLinks, drawField]);

  const drawForegroundLinks = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    const links = new Set<AnatomicalLink2D>(foregroundDragLinksRef.current);
    for (const link of deformedLinksRef.current) {
      if (links.size >= 5200) break;
      links.add(link);
    }
    if (focusId) {
      for (const link of graphMetrics.incidentLinks.get(focusId) ?? []) {
        if (links.size >= 5200) break;
        links.add(link);
      }
    }
    if (!links.size) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    let drawn = 0;
    for (const link of links) {
      if (drawn++ >= 5200) break;
      const source = nodeById.get(link.__sourceId);
      const target = nodeById.get(link.__targetId);
      if (!source || !target || source.x == null || source.y == null || target.x == null || target.y == null) continue;
      if (layerVisible[source.layer] === false || layerVisible[target.layer] === false) continue;
      const directDrag = !!draggingIdRef.current && (source.id === draggingIdRef.current || target.id === draggingIdRef.current);
      const directFocus = !!focusId && (source.id === focusId || target.id === focusId);
      ctx.strokeStyle = directDrag ? 'rgba(220,247,241,0.94)'
        : directFocus ? 'rgba(169,224,220,0.74)'
          : 'rgba(128,163,159,0.32)';
      ctx.lineWidth = (directDrag ? 1.45 : directFocus ? 0.92 : 0.5) / Math.max(0.2, scale);
      ctx.beginPath();
      traceBackgroundLink(ctx, link, source, target);
      ctx.stroke();
    }
    ctx.restore();
  }, [focusId, graphMetrics.incidentLinks, layerVisible, nodeById]);

  const drawOverlay = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    drawForegroundLinks(ctx, scale);
    if (layout === 'rings') {
      ctx.save();
      const radius = rings.coreRadius;
      const membrane = ctx.createRadialGradient(0, 0, radius * 0.15, 0, 0, radius * 1.65);
      membrane.addColorStop(0, 'rgba(169,224,220,0.14)');
      membrane.addColorStop(0.55, 'rgba(113,150,147,0.055)');
      membrane.addColorStop(1, 'rgba(6,9,19,0)');
      ctx.fillStyle = membrane;
      ctx.beginPath(); ctx.ellipse(0, 0, radius * 1.65, radius * 1.18, -0.08, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(201,232,227,0.42)';
      ctx.lineWidth = 1.1 / scale;
      ctx.beginPath(); ctx.ellipse(0, 0, radius, radius * 0.72, -0.08, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(128,163,159,0.18)';
      ctx.beginPath(); ctx.ellipse(0, 0, radius * 1.28, radius * 0.92, -0.08, 0, Math.PI * 2); ctx.stroke();
      ctx.font = `600 ${Math.max(12 / scale, 5)}px system-ui, Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(225,230,236,0.88)'; ctx.fillText('ASM', 0, 0);
      ctx.restore();
    }
  }, [drawForegroundLinks, layout, rings]);

  const cancelPhysicsFrames = useCallback(() => {
    if (dragFrameRef.current != null) cancelAnimationFrame(dragFrameRef.current);
    if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current);
    dragFrameRef.current = null;
    settleFrameRef.current = null;
  }, []);

  const updateForegroundDragLinks = useCallback((moving: Map<string, number>, rootId: string) => {
    const next = new Set<AnatomicalLink2D>();
    const addIncident = (id: string) => {
      for (const link of graphMetrics.incidentLinks.get(id) ?? []) {
        if (next.size >= 5200) return false;
        next.add(link);
      }
      return next.size < 5200;
    };
    // The grabbed soma's own axons have first claim on the dynamic budget.
    addIncident(rootId);
    if (next.size < 5200) {
      for (const id of [...moving.keys()].sort()) {
        if (id === rootId || !addIncident(id)) break;
      }
    }
    foregroundDragLinksRef.current = next;
  }, [graphMetrics.incidentLinks]);

  const solveRelaxation = useCallback((iterations: number, temperature: number) => {
    const state = relaxationRef.current;
    if (!state) return null;
    const delta = dragDeltaRef.current;
    if (delta.x || delta.y) {
      applyDragDelta(nodeById, state.weights, delta);
      dragDeltaRef.current = { x: 0, y: 0 };
    }
    const result = stepDragRelaxation(
      state,
      physicsNodeById,
      graphMetrics.neighbors,
      { iterations, temperature },
    );
    for (const id of state.weights.keys()) {
      const moved = nodeById.get(id);
      if (!moved) continue;
      pinAtCurrentPosition(moved, 2);
      positionCache.set(id, { x: moved.x ?? 0, y: moved.y ?? 0 });
    }
    dragFieldRef.current = state.weights;
    lastCollisionCount.current = result.collisions;
    collisionCountTotal.current += result.collisions;
    lastRelaxingNodeCount.current = result.activeCount;
    lastDragNeighborCount.current = Math.max(0, result.activeCount - 1);
    if (result.added) {
      setDragField(new Map(state.weights));
      updateForegroundDragLinks(state.weights, state.rootId);
    }
    fgRef.current?.resumeAnimation?.();
    return result;
  }, [fgRef, graphMetrics.neighbors, nodeById, physicsNodeById, positionCache, updateForegroundDragLinks]);

  const finishRelaxation = useCallback(() => {
    cancelPhysicsFrames();
    const state = relaxationRef.current;
    if (state) {
      for (const id of state.weights.keys()) {
        const moved = nodeById.get(id);
        if (!moved) continue;
        pinAtCurrentPosition(moved, 2);
        positionCache.set(id, { x: moved.x ?? 0, y: moved.y ?? 0 });
      }
    }
    relaxationRef.current = null;
    dragDeltaRef.current = { x: 0, y: 0 };
    settleQuietRef.current = 0;
    draggingIdRef.current = null;
    dragFieldRef.current = new Map();
    const persistent = new Set<AnatomicalLink2D>();
    for (const link of foregroundDragLinksRef.current) {
      if (persistent.size >= 5200) break;
      persistent.add(link);
    }
    for (const link of deformedLinksRef.current) {
      if (persistent.size >= 5200) break;
      persistent.add(link);
    }
    deformedLinksRef.current = persistent;
    foregroundDragLinksRef.current = new Set();
    setDraggingId(null);
    setDragField(new Map());
    fgRef.current?.refresh?.();
    if (persistent.size) scheduleBackgroundRebuild();
    if (!motionEnabled) fgRef.current?.pauseAnimation?.();
  }, [cancelPhysicsFrames, fgRef, motionEnabled, nodeById, positionCache, scheduleBackgroundRebuild]);

  const handleNodeDrag = useCallback((node: AnatomicalNode2D, translate: { x: number; y: number }) => {
    if (draggingIdRef.current !== node.id || !relaxationRef.current) {
      if (relaxationRef.current || draggingIdRef.current || settleFrameRef.current != null) finishRelaxation();
      cancelBackgroundRebuild();
      const rootX = node.x ?? 0;
      const rootY = node.y ?? 0;
      const influence = buildDragInfluence(node.id, graphMetrics.neighbors, {
        maxNodes: 520,
        distanceFor: (id) => {
          const candidate = nodeById.get(id);
          return candidate ? Math.hypot((candidate.x ?? 0) - rootX, (candidate.y ?? 0) - rootY) : Number.POSITIVE_INFINITY;
        },
      });
      const state = createDragRelaxation(
        node.id,
        physicsNodeById,
        influence,
        (candidate) => collisionRadius2D(candidate as AnatomicalNode2D, graphMetrics.degree.get(candidate.id) ?? 0),
        {
          dimensions: 2,
          maxNodes: 720,
          collisionPadding: 0.42,
          collisionStrength: 0.76,
          linkStrength: 0.092,
          anchorStrength: layout === 'rings' ? 0.015 : 0.011,
          maxStep: 4.6,
          rootAnchor: { x: rootX - translate.x, y: rootY - translate.y },
          world: relaxationWorld,
        },
      );
      relaxationRef.current = state;
      draggingIdRef.current = node.id;
      dragFieldRef.current = state.weights;
      lastDragNeighborCount.current = Math.max(0, state.weights.size - 1);
      lastRelaxingNodeCount.current = state.weights.size;
      collisionCountTotal.current = 0;
      settleStepRef.current = 0;
      settleQuietRef.current = 0;
      updateForegroundDragLinks(state.weights, node.id);
      setDraggingId(node.id);
      setDragField(new Map(state.weights));
      onHover(null);
    }
    dragDeltaRef.current.x += translate.x;
    dragDeltaRef.current.y += translate.y;
    if (dragFrameRef.current == null) {
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = null;
        // Pointer motion gets one bounded PBD pass per frame; additional passes
        // belong to the release settle, where they cannot compete with input.
        solveRelaxation(1, 1);
      });
    }
  }, [cancelBackgroundRebuild, finishRelaxation, graphMetrics.degree, graphMetrics.neighbors, layout, nodeById, onHover, physicsNodeById, relaxationWorld, solveRelaxation, updateForegroundDragLinks]);

  const handleNodeDragEnd = useCallback((node: AnatomicalNode2D) => {
    if (dragFrameRef.current != null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    const current = relaxationRef.current;
    const dense = Boolean(current && (current.weights.size > 360 || current.springPairs.length > 960));
    solveRelaxation(dense ? 1 : 2, 1);
    pinAtCurrentPosition(node, 2);
    positionCache.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
    if (!motionEnabled) {
      solveRelaxation(dense ? 2 : 5, 0.42);
      finishRelaxation();
      return;
    }
    const settle = () => {
      settleStepRef.current += 1;
      const progress = settleStepRef.current / 28;
      const activeState = relaxationRef.current;
      const iterations = activeState && (activeState.weights.size > 360 || activeState.springPairs.length > 960) ? 1 : 2;
      const result = solveRelaxation(iterations, Math.max(0.18, 1 - progress * 0.88));
      const quiet = Boolean(result && result.maxDisplacement < 0.045 && result.maxOverlap < 0.12);
      settleQuietRef.current = quiet ? settleQuietRef.current + 1 : 0;
      if (settleStepRef.current < 28 && settleQuietRef.current < 3 && relaxationRef.current) {
        settleFrameRef.current = requestAnimationFrame(settle);
      } else {
        finishRelaxation();
      }
    };
    settleFrameRef.current = requestAnimationFrame(settle);
  }, [finishRelaxation, motionEnabled, positionCache, solveRelaxation]);

  return (
    <div className="brain-2d-stage">
      <ForceGraph2D
        ref={fgRef}
      graphData={canvasGraph as any}
      backgroundColor="#030708"
      autoPauseRedraw={true}
      enableNodeDrag={true}
      nodeCanvasObject={drawNode}
      nodePointerAreaPaint={(n: any, color, ctx, scale) => {
        if (!nodeIsInteractive(n, scale)) return;
        const r = nodeRadius(n, graphMetrics.degree.get(n.id) ?? 0) + 6 / (scale || 1);
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();
      }}
      onRenderFramePre={drawSceneBackground}
      onRenderFramePost={drawOverlay}
      nodeVisibility={(n: any) => layerVisible[n.layer] !== false}
      linkVisibility={(l: any) => visibleLink(l, fgRef.current?.zoom?.() ?? 1)}
      linkCurvature={(l: AnatomicalLink2D) => layout === 'rings' ? l.__curvature * 0.28 : l.__curvature}
      linkColor={(l: AnatomicalLink2D) => {
        const dragged = !!draggingId && ((l.__sourceId === draggingId && dragField.has(l.__targetId))
          || (l.__targetId === draggingId && dragField.has(l.__sourceId)));
        const focused = focusIds?.has(l.__sourceId) && focusIds?.has(l.__targetId);
        const activeNow = isActive(l.__sourceId) || isActive(l.__targetId);
        // Firing axons go near-white; resting tissue stays a faint coloured filament.
        if (dragged) return 'rgba(220,247,241,0.94)';
        if (activeNow) return 'rgba(224,232,213,0.78)';
        const alpha = focused ? 0.72 : l.type === 'xlayer' ? 0.2 : l.type === 'link' ? 0.15 : l.type === 'code' ? 0.11 : 0.065;
        return `rgba(128,163,159,${alpha})`;
      }}
      linkWidth={(l: AnatomicalLink2D) => {
        const activeNow = isActive(l.__sourceId) || isActive(l.__targetId);
        const focused = focusIds?.has(l.__sourceId) && focusIds?.has(l.__targetId);
        if (layout === 'rings') return activeNow || focused ? 1.25 : 0.55;
        return activeNow || l.__sourceId === selectedId || l.__targetId === selectedId ? 1.4 : l.type === 'xlayer' ? 0.62 : 0.38;
      }}
      onNodeClick={(n: any) => onSelect(n as BrainNode)}
      onNodeHover={(n: any) => { if (!draggingIdRef.current) onHover(n as BrainNode | null); }}
      onNodeDrag={handleNodeDrag as any}
      onNodeDragEnd={handleNodeDragEnd as any}
      onBackgroundClick={() => { onHover(null); onSelect(null); }}
      onEngineStop={() => {
        tick.current = 0;
      }}
      warmupTicks={0}
        cooldownTime={0}
      />
      <canvas
        ref={liveCanvasRef}
        className="live-flow-canvas"
        data-testid="live-flow-canvas"
        aria-hidden="true"
      />
    </div>
  );
});
