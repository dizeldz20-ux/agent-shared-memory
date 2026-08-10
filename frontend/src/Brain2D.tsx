import { useEffect, useCallback, useMemo, useRef, useState, memo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { BrainData, BrainNode, LiveEvent } from './types';
import { LAYER_COLORS, LAYER_NAMES } from './types';
import {
  buildAnatomicalGraph2D,
  createAnatomicalForce2D,
  digestAnatomicalTargets,
  hash01,
  hash32,
  linkIds,
  safeFrame2D,
  type AnatomicalGraph2D,
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
  clearCorticalRingPins,
  computeCorticalRings,
  digestRingLayout,
  ringPoint,
} from './corticalRings';

const DIM = '#4a5561';
const TRAIL_TTL = 90000;

export type Layout2D = 'graph' | 'rings';

interface Props {
  data: BrainData;
  active: Map<string, number>;
  layerVisible: Record<string, boolean>;
  selected: BrainNode | null;
  hovered: BrainNode | null;
  onSelect: (n: BrainNode | null) => void;
  onHover: (n: BrainNode | null) => void;
  fgRef: React.MutableRefObject<any>;
  layout: Layout2D;
  trail: LiveEvent[];
  motionEnabled: boolean;
}

declare global {
  interface Window { __c2b?: { network?: Record<string, unknown>; rings?: Record<string, unknown>; brain3d?: Record<string, unknown> } }
}

function nodeRadius(node: BrainNode, degree: number) {
  const base = { root: 10, dir: 6.5, page: 4, file: 2.2, ephemeral: 3 }[node.kind] ?? 3;
  return base + Math.min(4, Math.log2(degree + 1) * 0.7);
}

function linkEnds(link: any) {
  const source = link.__sourceId ?? (typeof link.source === 'object' ? link.source.id : link.source);
  const target = link.__targetId ?? (typeof link.target === 'object' ? link.target.id : link.target);
  return { source, target };
}

function linkKey(link: AnatomicalLink2D) {
  return `${link.__sourceId}>${link.__targetId}:${link.type}`;
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
  data, active, layerVisible, selected, hovered, onSelect, onHover, fgRef, layout, trail, motionEnabled,
}: Props) {
  const graph = useMemo<AnatomicalGraph2D>(() => buildAnatomicalGraph2D(data), [data]);
  const rings = useMemo(() => computeCorticalRings(graph.nodes), [graph]);
  const [ringPinnedCount, setRingPinnedCount] = useState(0);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const selectedId = selected?.id ?? null;
  const hoveredId = hovered?.id ?? null;

  const graphMetrics = useMemo(() => {
    const degree = new Map<string, number>();
    const neighbors = new Map<string, Set<string>>();
    for (const node of graph.nodes) neighbors.set(node.id, new Set());
    for (const link of graph.links) {
      const { source, target } = linkEnds(link);
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
      neighbors.get(source)?.add(target);
      neighbors.get(target)?.add(source);
    }
    return { degree, neighbors };
  }, [graph]);

  const focusId = selectedId ?? hoveredId;
  const focusIds = useMemo(() => {
    if (!focusId) return null;
    return new Set([focusId, ...(graphMetrics.neighbors.get(focusId) ?? [])]);
  }, [focusId, graphMetrics]);

  const ringLinkState = useMemo(() => {
    if (layout !== 'rings') return { keys: new Set<string>(), activeCount: 0 };
    const newestTrailTs = trail.at(-1)?.ts ?? 0;
    const now = Math.max(Date.now(), newestTrailTs * 1000);
    const ranked = graph.links
      .map((link) => {
        const activeNow = (active.get(link.__sourceId) ?? 0) >= now || (active.get(link.__targetId) ?? 0) >= now;
        const focused = !!focusIds && focusIds.has(link.__sourceId) && focusIds.has(link.__targetId);
        if (!activeNow && !focused) return null;
        const directFocus = !!focusId && (link.__sourceId === focusId || link.__targetId === focusId);
        return { link, activeNow, priority: directFocus ? 0 : activeNow ? 1 : 2 };
      })
      .filter((entry): entry is { link: AnatomicalLink2D; activeNow: boolean; priority: number } => entry !== null)
      .sort((a, b) => a.priority - b.priority || b.link.__tier - a.link.__tier || linkKey(a.link).localeCompare(linkKey(b.link)))
      .slice(0, 64);
    return {
      keys: new Set(ranked.map(({ link }) => linkKey(link))),
      activeCount: ranked.filter(({ activeNow }) => activeNow).length,
    };
  }, [active, focusId, focusIds, graph, layout, trail]);
  const ringVisibleLinks = ringLinkState.keys;
  const ringActiveLinkCount = ringLinkState.activeCount;

  const ringFitZoom = useMemo(() => {
    const width = typeof window === 'undefined' ? 1600 : window.innerWidth;
    const height = typeof window === 'undefined' ? 900 : window.innerHeight;
    const horizontal = (width - 128) / Math.max(1, rings.maxX * 2);
    const vertical = (height - 150) / Math.max(1, rings.maxY * 2);
    return Math.max(0.45, Math.min(2.4, Math.min(horizontal, vertical) * 0.9));
  }, [rings]);

  const isActive = useCallback((id: string) => {
    const until = active.get(id);
    if (!until) return false;
    if (until < Date.now()) { active.delete(id); return false; }
    return true;
  }, [active]);

  const visibleLink = useCallback((l: AnatomicalLink2D, zoom = 1, forceFocus = false) => {
    const s = nodeById.get(l.__sourceId);
    const t = nodeById.get(l.__targetId);
    if (s && layerVisible[s.layer] === false) return false;
    if (t && layerVisible[t.layer] === false) return false;
    if (layout === 'rings') return ringVisibleLinks.has(linkKey(l));
    if (focusIds || forceFocus) {
      const ids = focusIds ?? (selectedId ? new Set([selectedId, ...(graphMetrics.neighbors.get(selectedId) ?? [])]) : null);
      return !!ids && ids.has(l.__sourceId) && ids.has(l.__targetId);
    }
    if (zoom > 1.35) return true;
    return l.type === 'xlayer' || l.type === 'link' || s?.kind === 'root' || t?.kind === 'root' || s?.kind === 'dir' || t?.kind === 'dir' || isActive(l.__sourceId) || isActive(l.__targetId);
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
      bottomPadding: 24,
    });
    // The brain only grows while the layout expands, so the fitted zoom only
    // shrinks. Re-frame on real growth and stay still otherwise: a camera that
    // nudges every tick never lets the UI settle.
    if (from === 'settled' && frame.k > lastFit.current * 0.99) return;
    lastFit.current = frame.k;
    fg.zoom(frame.k, ms);
    fg.centerAt(frame.x, frame.y, ms);
  }, [fgRef, graph.nodes, graphMetrics]);

  useEffect(() => {
    if (!graph.nodes.length) return;
    if (window.__c2b) delete window.__c2b.rings;
    lastFit.current = Infinity;
    setRingPinnedCount(0);
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const id = setTimeout(() => {
      const fg = fgRef.current;
      if (!fg) return;
      try {
        if (layout === 'rings') {
          setRingPinnedCount(applyCorticalRingPins(graph.nodes, rings));
          fg.d3Force('anatomy', null);
          fg.centerAt(0, 0, 0);
          fg.zoom(ringFitZoom, 0);
          fg.refresh();
          if (motionEnabled) fg.resumeAnimation?.();
          else fg.pauseAnimation?.();
        } else if (!motionEnabled) {
          clearCorticalRingPins(graph.nodes);
          for (const node of graph.nodes) {
            node.x = node.__targetX;
            node.y = node.__targetY;
            node.vx = 0;
            node.vy = 0;
          }
          fg.d3Force('anatomy', null);
          fitToSafeArea(0);
          fg.refresh();
          fg.pauseAnimation?.();
        } else {
          clearCorticalRingPins(graph.nodes);
          fg.resumeAnimation?.();
          fg.d3Force('charge')?.strength((n: BrainNode) => n.kind === 'root' ? -30 : n.kind === 'dir' ? -16 : -3.5);
          fg.d3Force('link')?.distance((l: any) => l.type === 'contains' ? 16 : 32).strength((l: any) => l.type === 'contains' ? 0.018 : 0.01);
          fg.d3Force('anatomy', createAnatomicalForce2D());
          fg.d3ReheatSimulation();
          fitTimer = setTimeout(() => fitToSafeArea(600, 'targets'), 400);
        }
      } catch { /* engine not ready */ }
    }, 150);
    return () => {
      clearTimeout(id);
      if (fitTimer) clearTimeout(fitTimer);
    };
  }, [graph, layout, fgRef, fitToSafeArea, motionEnabled, ringFitZoom, rings]);

  useEffect(() => {
    if (layout !== 'graph' || !motionEnabled || focusIds || document.hidden) return;
    const t = setInterval(() => {
      const fg = fgRef.current;
      if (!fg || document.hidden || !graph.links.length) return;
      for (let i = 0; i < 2; i++) {
        const link = graph.links[(hash01(`${Date.now()}:${i}`) * graph.links.length) | 0];
        if (visibleLink(link, fg.zoom?.() ?? 1)) fg.emitParticle(link);
      }
    }, 520);
    return () => clearInterval(t);
  }, [graph, fgRef, focusIds, layout, motionEnabled, visibleLink]);

  useEffect(() => {
    if (layout !== 'graph') return;
    const overviewVisibleLinkCount = graph.links.filter((l: any) => {
      const { source: sid, target: tid } = linkIds(l);
      const s = nodeById.get(sid);
      const t = nodeById.get(tid);
      if (s && layerVisible[s.layer] === false) return false;
      if (t && layerVisible[t.layer] === false) return false;
      return l.type === 'xlayer' || l.type === 'link' || s?.kind === 'root' || t?.kind === 'root' || s?.kind === 'dir' || t?.kind === 'dir' || isActive(sid) || isActive(tid);
    }).length;
    const focusVisibleLinkCount = focusIds ? graph.links.filter((l) => visibleLink(l, 1, true)).length : 0;
    const network: Record<string, unknown> = {
      curvatureBuckets: new Set(graph.links.map((l) => l.__curvature)).size,
      focusSize: focusIds?.size ?? 0,
      focusVisibleLinkCount,
      layout: 'anatomical',
      motion: motionEnabled,
      overviewVisibleLinkCount,
      positionDigest: digestAnatomicalTargets(graph.nodes),
      selectedId,
      simulationRunning: motionEnabled,
      styleBuckets: new Set(graph.links.map((l) => l.__styleKey)).size,
      totalLinkCount: graph.links.length,
    };
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
    window.__c2b = {
      ...(window.__c2b ?? {}),
      network,
    };
  }, [focusIds, graph, layout, motionEnabled, selectedId, visibleLink]);

  useEffect(() => {
    if (layout !== 'rings' || ringPinnedCount !== graph.nodes.length) return;
    window.__c2b = {
      ...(window.__c2b ?? {}),
      rings: {
        activeLinkCount: ringActiveLinkCount,
        ambientEnabled: false,
        arcGapCountMin: rings.arcGapCountMin,
        backgroundLinkCount: 0,
        bandCount: rings.bands.length,
        coreRadius: rings.coreRadius,
        ellipseRatioMax: rings.ellipseRatioMax,
        ellipseRatioMin: rings.ellipseRatioMin,
        fitZoom: ringFitZoom,
        geometryDigest: digestRingLayout(rings),
        layout: 'cortical',
        maxOffBandDistance: rings.maxOffBandDistance,
        pinnedNodeCount: ringPinnedCount,
        radialJitterMax: rings.radialJitterMax,
        selectedId,
        totalNodeCount: graph.nodes.length,
        visibleLinkCount: ringVisibleLinks.size,
      },
    };
  }, [graph.nodes.length, layout, ringActiveLinkCount, ringFitZoom, ringPinnedCount, rings, ringVisibleLinks.size, selectedId]);

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

  const drawNode = useCallback((n: AnatomicalNode2D, ctx: CanvasRenderingContext2D, scale: number) => {
    ctx.save();
    const degree = graphMetrics.degree.get(n.id) ?? 0;
    const activeNow = isActive(n.id);
    const isFocus = focusIds?.has(n.id) ?? false;
    const picked = selectedId === n.id || hoveredId === n.id;
    const color = LAYER_COLORS[n.layer] ?? DIM;
    const ringScale = layout === 'rings' ? (n.layer === 'c2b' ? 0.5 : 0.72) : 1;
    const r = nodeRadius(n, degree) * ringScale * (activeNow || picked ? 1.22 : 1);
    const dim = focusIds && !isFocus ? (layout === 'rings' ? 0.12 : 0.2) : layout === 'rings' && n.layer === 'c2b' ? 0.58 : 1;
    ctx.globalAlpha = dim;

    if (n.kind === 'root' || n.kind === 'dir') {
      const field = ctx.createRadialGradient(n.x!, n.y!, 0, n.x!, n.y!, r * (n.kind === 'root' ? 5.4 : 3.4));
      field.addColorStop(0, alphaColor(color, layout === 'rings' ? 0.08 : 0.16));
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
      // Somas are pre-baked sprites: glow, lit body, rim light. See neuronSprite.ts.
      const soma = neuronSprite(color, state, n.kind === 'file' || n.kind === 'root' || activeNow);
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
      : picked || activeNow || (isFocus && n.kind !== 'file') || (scale > 1.35 && n.kind !== 'file') || scale > 3.5;
    if (showLabel) {
      ctx.font = `${picked ? 600 : 400} ${Math.max(10 / scale, 1.8)}px system-ui, Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = picked ? '#ffffff' : 'rgba(225,230,236,0.78)';
      ctx.fillText(n.label, n.x!, n.y! + r + 2);
    }
    ctx.restore();
  }, [focusIds, graphMetrics, hoveredId, isActive, layout, neuronSprite, selectedId]);

  const drawField = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    if (layout === 'rings') {
      const field = ctx.createRadialGradient(0, 0, rings.coreRadius, 0, 0, Math.max(rings.maxX, rings.maxY));
      field.addColorStop(0, 'rgba(51,177,255,0.045)');
      field.addColorStop(0.48, 'rgba(81,213,165,0.022)');
      field.addColorStop(1, 'rgba(6,9,19,0)');
      ctx.fillStyle = field;
      ctx.beginPath();
      ctx.ellipse(0, 0, rings.maxX * 1.04, rings.maxY * 1.08, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const band of rings.bands) {
        const color = LAYER_COLORS[band.layer] ?? '#E1E6EC';
        ctx.strokeStyle = alphaColor(color, band.subBand === 0 ? 0.082 : 0.048);
        ctx.lineWidth = (band.subBand === 0 ? 1.05 : 0.72) / scale;
        for (const arc of band.arcs) {
          ctx.beginPath();
          ctx.ellipse(0, 0, band.rx, band.ry, band.rotation, arc.start, arc.end);
          ctx.stroke();
        }
      }
      ctx.restore();
      return;
    }
    const halo = ctx.createRadialGradient(0, 5, 60, 0, 5, 390);
    halo.addColorStop(0, 'rgba(51,177,255,0.045)');
    halo.addColorStop(0.55, 'rgba(81,213,165,0.035)');
    halo.addColorStop(1, 'rgba(6,9,19,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.ellipse(0, 15, 365, 245, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(225,230,236,0.10)';
    ctx.lineWidth = 1.2 / scale;
    ctx.beginPath(); ctx.moveTo(-18, -210); ctx.bezierCurveTo(-42, -110, -22, -36, -32, 32); ctx.bezierCurveTo(-44, 108, -24, 158, -10, 218); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(18, -210); ctx.bezierCurveTo(42, -110, 22, -36, 32, 32); ctx.bezierCurveTo(44, 108, 24, 158, 10, 218); ctx.stroke();
    for (let i = 0; i < 56; i++) {
      const side = i % 2 ? -1 : 1;
      const y = -190 + (i * 47) % 390;
      const x = side * (52 + (i * 29) % 245);
      ctx.strokeStyle = `rgba(158,165,173,${0.018 + (i % 5) * 0.004})`;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x * 0.72, y + 18 * side, x * 0.46, y + 36); ctx.stroke();
    }
    ctx.restore();
  }, [layout, rings]);

  const drawOverlay = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    const now = Date.now();
    const pts: { x: number; y: number; layer: string; age: number }[] = [];
    for (const e of trail) {
      const n = nodeById.get(e.node_id);
      if (n?.x != null && n.y != null && now - e.ts * 1000 < TRAIL_TTL) pts.push({ x: n.x, y: n.y, layer: e.layer, age: (now - e.ts * 1000) / TRAIL_TTL });
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], alpha = 0.75 * (1 - b.age);
      if (alpha <= 0.03) continue;
      ctx.save();
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, `rgba(225,230,236,${alpha * 0.4})`); grad.addColorStop(1, LAYER_COLORS[b.layer] ?? '#fff');
      ctx.strokeStyle = grad; ctx.globalAlpha = alpha; ctx.lineWidth = 1.6 / scale;
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      if (layout === 'rings') {
        const bend = (i % 2 ? -1 : 1) * 18;
        ctx.quadraticCurveTo((a.x + b.x) / 2 - (b.y - a.y) * 0.08, (a.y + b.y) / 2 + (b.x - a.x) * 0.08 + bend, b.x, b.y);
      } else {
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
    }
    if (layout === 'rings') {
      ctx.save();
      const pulse = motionEnabled ? 1 + 0.035 * Math.sin(now / 520) : 1;
      const radius = rings.coreRadius * pulse;
      const membrane = ctx.createRadialGradient(0, 0, radius * 0.15, 0, 0, radius * 1.65);
      membrane.addColorStop(0, 'rgba(51,177,255,0.22)');
      membrane.addColorStop(0.55, 'rgba(40,47,239,0.10)');
      membrane.addColorStop(1, 'rgba(6,9,19,0)');
      ctx.fillStyle = membrane;
      ctx.beginPath(); ctx.ellipse(0, 0, radius * 1.65, radius * 1.18, -0.08, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(201,237,255,0.56)';
      ctx.lineWidth = 1.1 / scale;
      ctx.beginPath(); ctx.ellipse(0, 0, radius, radius * 0.72, -0.08, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(51,177,255,0.24)';
      ctx.beginPath(); ctx.ellipse(0, 0, radius * 1.28, radius * 0.92, -0.08, 0, Math.PI * 2); ctx.stroke();
      ctx.font = `600 ${Math.max(12 / scale, 5)}px system-ui, Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(225,230,236,0.88)'; ctx.fillText('C2B', 0, 0);

      const outerBands = new Map<string, (typeof rings.bands)[number]>();
      for (const band of rings.bands) outerBands.set(band.layer, band);
      for (const band of outerBands.values()) {
        const anchor = ringPoint(band, band.anchorAngle, 13);
        const color = LAYER_COLORS[band.layer] ?? '#E1E6EC';
        ctx.strokeStyle = alphaColor(color, 0.24);
        ctx.lineWidth = 0.8 / scale;
        ctx.beginPath(); ctx.moveTo(anchor.x * 0.97, anchor.y * 0.97); ctx.lineTo(anchor.x, anchor.y); ctx.stroke();
        ctx.font = `600 ${Math.max(10 / scale, 4)}px system-ui, Arial, sans-serif`;
        ctx.textAlign = anchor.x < 0 ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = alphaColor(color, 0.72);
        ctx.fillText(LAYER_NAMES[band.layer] ?? band.layer, anchor.x + (anchor.x < 0 ? -4 : 4), anchor.y);
      }

      const newest = pts.at(-1);
      if (newest) {
        ctx.strokeStyle = alphaColor(LAYER_COLORS[newest.layer] ?? '#E1E6EC', 0.42 * (1 - newest.age));
        ctx.lineWidth = 1.35 / scale;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(newest.x * 0.42 - newest.y * 0.08, newest.y * 0.42 + newest.x * 0.08, newest.x, newest.y); ctx.stroke();
      }
      ctx.restore();
    }
  }, [trail, nodeById, layout, motionEnabled, rings]);

  return (
    <ForceGraph2D
      ref={fgRef}
      graphData={graph as any}
      backgroundColor="#060913"
      autoPauseRedraw={!motionEnabled}
      nodeCanvasObject={drawNode}
      nodePointerAreaPaint={(n: any, color, ctx, scale) => {
        const r = nodeRadius(n, graphMetrics.degree.get(n.id) ?? 0) + 6 / (scale || 1);
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();
      }}
      onRenderFramePre={drawField}
      onRenderFramePost={drawOverlay}
      nodeVisibility={(n: any) => layerVisible[n.layer] !== false}
      linkVisibility={(l: any) => visibleLink(l, fgRef.current?.zoom?.() ?? 1)}
      linkCurvature={(l: AnatomicalLink2D) => layout === 'rings' ? l.__curvature * 0.28 : l.__curvature}
      linkColor={(l: AnatomicalLink2D) => {
        const focused = focusIds?.has(l.__sourceId) && focusIds?.has(l.__targetId);
        const activeNow = isActive(l.__sourceId) || isActive(l.__targetId);
        // Firing axons go near-white; resting tissue stays a faint coloured filament.
        if (activeNow) return 'rgba(226,244,255,0.82)';
        // Same floor as the 3D view: the tiers still rank, but resting tissue at 0.07 was a
        // filament nobody could trace between two dots.
        const alpha = focused ? 0.9 : l.type === 'xlayer' ? 0.58 : l.type === 'link' ? 0.5 : l.type === 'code' ? 0.38 : 0.26;
        return l.type === 'xlayer' ? `rgba(255,186,176,${alpha})` : l.type === 'link' ? `rgba(90,196,255,${alpha})` : l.type === 'code' ? `rgba(96,232,182,${alpha})` : `rgba(170,180,192,${alpha})`;
      }}
      linkWidth={(l: AnatomicalLink2D) => {
        const activeNow = isActive(l.__sourceId) || isActive(l.__targetId);
        const focused = focusIds?.has(l.__sourceId) && focusIds?.has(l.__targetId);
        if (layout === 'rings') return activeNow || focused ? 1.8 : 1.35;
        return activeNow || l.__sourceId === selectedId || l.__targetId === selectedId ? 1.8 : l.type === 'xlayer' ? 1 : 0.6;
      }}
      linkDirectionalParticles={(l: AnatomicalLink2D) => layout === 'graph' && motionEnabled && !document.hidden && !focusIds && (isActive(l.__sourceId) || isActive(l.__targetId)) ? 3 : 0}
      linkDirectionalParticleWidth={2.4}
      linkDirectionalParticleSpeed={0.012}
      linkDirectionalParticleColor={(l: AnatomicalLink2D) => LAYER_COLORS[nodeById.get(l.__targetId)?.layer ?? ''] ?? '#E1E6EC'}
      onNodeClick={(n: any) => onSelect(n as BrainNode)}
      onNodeHover={(n: any) => onHover(n as BrainNode | null)}
      onBackgroundClick={() => { onHover(null); onSelect(null); }}
      onEngineTick={() => {
        // Track the brain while it expands, instead of framing it once mid-flight
        // and leaving the cortex under the header until the engine stops.
        if (layout !== 'graph') return;
        tick.current += 1;
        if (tick.current % 6 === 0) fitToSafeArea(0, 'settled');
      }}
      onEngineStop={() => {
        tick.current = 0;
        if (layout !== 'graph') return;
        lastFit.current = Infinity; // settled: take the exact frame, not the growth guard
        fitToSafeArea(600, 'settled');
      }}
      warmupTicks={motionEnabled ? 100 : 0}
      cooldownTime={motionEnabled ? 12000 : 0}
    />
  );
});
