import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { FogExp2, Vector3 } from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { BrainData, BrainNode } from './types';
import { LAYER_COLORS } from './types';
import {
  BRAIN3D_SCENE,
  CAMERA_PRESETS_3D,
  buildBrainGraph3D,
  buildRenderGraph3D,
  cameraFrameForNodes3D,
  digestBrainTargets,
  escapeHtml,
  focusNeighborhood3D,
  linkEndpointId,
  visibleLinks3D,
  type BrainLink3D,
  type BrainNode3D,
  type CameraPreset3D,
} from './brain3d';

declare global {
  interface Window {
    __c2b?: {
      network?: Record<string, unknown>;
      rings?: Record<string, unknown>;
      brain3d?: Record<string, unknown>;
    };
  }
}

const MUTED_LAYER_COLORS: Record<string, string> = {
  vault: '#1f668c',
  api: '#2a735d',
  web: '#806c1d',
  ops: '#7d5553',
  lab: '#68808d',
  c2b: '#7d302a',
  ephemeral: '#65717c',
};

interface Props {
  data: BrainData;
  active: Map<string, number>;
  layerVisible: Record<string, boolean>;
  selected: BrainNode | null;
  hovered: BrainNode | null;
  onSelect: (node: BrainNode | null) => void;
  onHover: (node: BrainNode | null) => void;
  motionEnabled: boolean;
  cameraPreset: CameraPreset3D;
  fgRef: MutableRefObject<any>;
}

export const Brain = memo(function Brain({
  data,
  active,
  layerVisible,
  selected,
  hovered,
  onSelect,
  onHover,
  motionEnabled,
  cameraPreset,
  fgRef,
}: Props) {
  const graph = useMemo(() => buildBrainGraph3D(data), [data]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const positionDigest = useMemo(() => digestBrainTargets(graph.nodes), [graph.nodes]);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const [pulseTick, setPulseTick] = useState(0);
  const ambientCursor = useRef(0);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const framingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [framing, setFraming] = useState({ ready: false, visibleNodeRatio: 0, topOccludedNodeCount: 0 });
  const focusId = selected?.id ?? hovered?.id ?? null;
  const focusIds = useMemo(() => focusNeighborhood3D(focusId, graph.neighbors), [focusId, graph.neighbors]);

  const activeIds = useMemo(() => {
    const now = Date.now();
    const ids = new Set<string>();
    for (const [id, until] of active) {
      if (until >= now) ids.add(id);
      else active.delete(id);
    }
    return ids;
    // pulseTick deliberately refreshes the mutable live-event map.
  }, [active, pulseTick]);

  const structuralLinks = useMemo(
    () => visibleLinks3D(graph.links, focusIds, new Set()),
    [focusIds, graph.links],
  );
  const renderGraph = useMemo(
    () => buildRenderGraph3D(graph, structuralLinks, focusIds),
    [focusIds, graph, structuralLinks],
  );
  const visibleLinkSet = useMemo(() => new Set(renderGraph.links), [renderGraph.links]);
  const focusVisibleLinkCount = useMemo(
    () => focusIds ? visibleLinks3D(graph.links, focusIds, new Set()).length : 0,
    [focusIds, graph.links],
  );
  const ambientParticlesEnabled = motionEnabled
    && documentVisible
    && !focusIds
    && graph.nodes.length <= 900
    && graph.overviewVisibleLinkCount > 0;
  const refreshTicking = motionEnabled && documentVisible && activeIds.size > 0;
  const shouldIdleRenderer = !ambientParticlesEnabled;

  const pauseRenderer = useCallback(() => {
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = null;
    fgRef.current?.pauseAnimation?.();
  }, [fgRef]);

  const wakeRenderer = useCallback((duration = 900) => {
    if (!documentVisible) return;
    const fg = fgRef.current;
    if (!fg) return;
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = null;
    fg.resumeAnimation?.();
    if (shouldIdleRenderer) {
      pauseTimer.current = setTimeout(() => {
        pauseTimer.current = null;
        fgRef.current?.pauseAnimation?.();
      }, motionEnabled ? duration : 60);
    }
  }, [documentVisible, fgRef, motionEnabled, shouldIdleRenderer]);

  const fitCameraToViewport = useCallback((duration = 0) => {
    if (cameraPreset === 'selected') return;
    const fg = fgRef.current;
    const camera = fg?.camera?.();
    const renderer = fg?.renderer?.();
    if (!fg || !camera || !renderer?.domElement) return;
    const preset = CAMERA_PRESETS_3D[cameraPreset];
    const rect = renderer.domElement.getBoundingClientRect();
    const headerBottom = document.querySelector('.instrument-header')?.getBoundingClientRect().bottom ?? rect.top;
    const safeTop = Math.max(16, headerBottom - rect.top + 16);
    const frame = cameraFrameForNodes3D(
      renderGraph.nodes.filter((node) => layerVisible[node.layer] !== false),
      preset,
      {
        width: rect.width,
        height: rect.height,
        safeTop,
        bottomPadding: 24,
        fov: Number(camera.fov) || 50,
      },
    );
    wakeRenderer(duration + 650);
    fg.cameraPosition(frame.position, frame.lookAt, duration);
    if (framingTimer.current) clearTimeout(framingTimer.current);
    framingTimer.current = setTimeout(() => {
      framingTimer.current = null;
      const measure = () => {
        camera.updateProjectionMatrix?.();
        camera.updateMatrixWorld?.(true);
        let total = 0;
        let visible = 0;
        let topOccluded = 0;
        let minY = Number.POSITIVE_INFINITY;
        const projected = new Vector3();
        for (const node of renderGraph.nodes) {
          if (layerVisible[node.layer] === false) continue;
          total += 1;
          projected.set(node.x ?? 0, node.y ?? 0, node.z ?? 0).project(camera);
          if (projected.z < -1 || projected.z > 1) continue;
          const x = rect.left + (projected.x + 1) * rect.width / 2;
          const y = rect.top + (1 - projected.y) * rect.height / 2;
          minY = Math.min(minY, y);
          if (y < rect.top + safeTop) topOccluded += 1;
          if (x >= rect.left + 16 && x <= rect.right - 16 && y >= rect.top + safeTop && y <= rect.bottom - 24) visible += 1;
        }
        return { total, visible, topOccluded, minY };
      };

      const metrics = measure();
      setFraming({
        ready: true,
        visibleNodeRatio: metrics.total ? metrics.visible / metrics.total : 1,
        topOccludedNodeCount: metrics.topOccluded,
      });
    }, duration + 160);
  }, [cameraPreset, fgRef, layerVisible, renderGraph.nodes, wakeRenderer]);

  useEffect(() => {
    const updateVisibility = () => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    if (documentVisible) wakeRenderer(motionEnabled ? 1000 : 60);
    else pauseRenderer();
    return pauseRenderer;
  }, [documentVisible, motionEnabled, pauseRenderer, wakeRenderer]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const scene = fg.scene();
    const previousFog = scene.fog;
    scene.fog = new FogExp2(BRAIN3D_SCENE.fogColor, BRAIN3D_SCENE.fogDensity);
    const pass = new UnrealBloomPass(
      undefined as any,
      BRAIN3D_SCENE.bloomStrength,
      BRAIN3D_SCENE.bloomRadius,
      BRAIN3D_SCENE.bloomThreshold,
    );
    const composer = fg.postProcessingComposer();
    composer.addPass(pass);
    return () => {
      composer?.removePass?.(pass);
      scene.fog = previousFog;
    };
  }, [fgRef]);

  useEffect(() => {
    if (cameraPreset === 'selected' || !graph.nodes.length) return;
    const transition = motionEnabled ? 700 : 0;
    setFraming((current) => ({ ...current, ready: false }));
    const timeout = setTimeout(() => fitCameraToViewport(transition), 90);
    return () => clearTimeout(timeout);
  }, [cameraPreset, fgRef, fitCameraToViewport, graph.nodes.length, motionEnabled, wakeRenderer]);

  useEffect(() => {
    if (cameraPreset === 'selected') {
      setFraming((current) => ({ ...current, ready: false }));
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (timeout) clearTimeout(timeout);
      setFraming((current) => ({ ...current, ready: false }));
      timeout = setTimeout(() => fitCameraToViewport(0), 120);
    };
    addEventListener('resize', onResize);
    return () => {
      removeEventListener('resize', onResize);
      if (timeout) clearTimeout(timeout);
    };
  }, [cameraPreset, fitCameraToViewport]);

  useEffect(() => {
    if (!motionEnabled || !documentVisible) return;
    const interval = setInterval(() => {
      const now = Date.now();
      let hasLivePulse = false;
      for (const [id, until] of active) {
        if (until < now) active.delete(id);
        else hasLivePulse = true;
      }
      if (hasLivePulse) {
        setPulseTick((value) => value + 1);
        fgRef.current?.refresh?.();
      }
    }, 600);
    return () => clearInterval(interval);
  }, [active, documentVisible, fgRef, motionEnabled]);

  useEffect(() => {
    if (!ambientParticlesEnabled) return;
    const structural = graph.links.filter((link) => link.__overview);
    if (!structural.length) return;
    const interval = setInterval(() => {
      const fg = fgRef.current;
      if (!fg || document.hidden) return;
      for (let index = 0; index < 2; index++) {
        const link = structural[(ambientCursor.current * 97 + index * 541) % structural.length];
        const source = nodeById.get(linkEndpointId(link.source));
        const target = nodeById.get(linkEndpointId(link.target));
        if (layerVisible[source?.layer ?? ''] !== false && layerVisible[target?.layer ?? ''] !== false) fg.emitParticle(link);
      }
      ambientCursor.current += 1;
    }, 430);
    return () => clearInterval(interval);
  }, [ambientParticlesEnabled, fgRef, graph.links, layerVisible, nodeById]);

  useEffect(() => {
    window.__c2b = {
      ...(window.__c2b ?? {}),
      brain3d: {
        ambientParticlesEnabled,
        bloomRadius: BRAIN3D_SCENE.bloomRadius,
        bloomStrength: BRAIN3D_SCENE.bloomStrength,
        bloomThreshold: BRAIN3D_SCENE.bloomThreshold,
        cameraPreset,
        focusSize: focusIds?.size ?? 0,
        focusVisibleLinkCount,
        fogDensity: BRAIN3D_SCENE.fogDensity,
        framingReady: framing.ready,
        hoveredId: hovered?.id ?? null,
        layout: 'connectome',
        motion: motionEnabled,
        nodeValueBuckets: graph.nodeValueBuckets,
        positionDigest,
        refreshTicking,
        selectedId: selected?.id ?? null,
        styleBuckets: graph.styleBuckets,
        topOccludedNodeCount: framing.topOccludedNodeCount,
        totalLinkCount: graph.links.length,
        visibleNodeRatio: framing.visibleNodeRatio,
        visibleLinkCount: renderGraph.links.length,
      },
    };
  }, [
    ambientParticlesEnabled,
    cameraPreset,
    focusIds,
    focusVisibleLinkCount,
    framing,
    graph.links.length,
    graph.nodeValueBuckets,
    graph.styleBuckets,
    hovered,
    motionEnabled,
    positionDigest,
    refreshTicking,
    selected,
    renderGraph.links.length,
  ]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    wakeRenderer(selected ? 1100 : hovered ? 260 : 180);
    fg.refresh?.();
  }, [fgRef, hovered, renderGraph.links.length, selected, wakeRenderer]);

  useEffect(() => () => {
    if (framingTimer.current) clearTimeout(framingTimer.current);
    if (window.__c2b) delete window.__c2b.brain3d;
  }, []);

  const isActive = useCallback((id: string) => activeIds.has(id), [activeIds]);
  const isFocused = useCallback((id: string) => focusIds?.has(id) ?? false, [focusIds]);

  const nodeColor = useCallback((node: BrainNode3D) => {
    if (isActive(node.id) || selected?.id === node.id) return '#ffffff';
    if (hovered?.id === node.id || isFocused(node.id)) return LAYER_COLORS[node.layer] ?? '#9EA5AD';
    if (focusIds) return '#1d2530';
    if (node.kind === 'root' || node.kind === 'dir') return MUTED_LAYER_COLORS[node.layer] ?? '#65717c';
    return LAYER_COLORS[node.layer] ?? '#9EA5AD';
  }, [focusIds, hovered, isActive, isFocused, selected]);

  const nodeVal = useCallback((node: BrainNode3D) => {
    if (isActive(node.id) || selected?.id === node.id) return 18;
    if (hovered?.id === node.id) return 12;
    if (focusIds?.has(node.id)) return Math.max(6, node.__value);
    return node.__value;
  }, [focusIds, hovered, isActive, selected]);

  const nodeVisibility = useCallback(
    (node: BrainNode3D) => layerVisible[node.layer] !== false,
    [layerVisible],
  );

  const linkLayersVisible = useCallback((link: BrainLink3D) => {
    const source = nodeById.get(linkEndpointId(link.source));
    const target = nodeById.get(linkEndpointId(link.target));
    return layerVisible[source?.layer ?? ''] !== false && layerVisible[target?.layer ?? ''] !== false;
  }, [layerVisible, nodeById]);

  const linkVisibility = useCallback(
    (link: BrainLink3D) => visibleLinkSet.has(link) && linkLayersVisible(link),
    [linkLayersVisible, visibleLinkSet],
  );

  const linkIsActive = useCallback((link: BrainLink3D) => {
    const source = linkEndpointId(link.source);
    const target = linkEndpointId(link.target);
    return activeIds.has(source) || activeIds.has(target);
  }, [activeIds]);

  const linkIsFocused = useCallback((link: BrainLink3D) => {
    if (!focusIds) return false;
    return focusIds.has(linkEndpointId(link.source)) && focusIds.has(linkEndpointId(link.target));
  }, [focusIds]);

  const nodeLabel = useCallback((node: BrainNode3D) => {
    const description = node.meta?.description
      ? `<div class="tip-desc">${escapeHtml(node.meta.description)}</div>`
      : '';
    return `<div class="tip"><div class="tip-title">${escapeHtml(node.label)}</div><div class="tip-path">${escapeHtml(node.path || '')}</div>${description}</div>`;
  }, []);

  return (
    <ForceGraph3D
      ref={fgRef}
      graphData={renderGraph}
      backgroundColor={BRAIN3D_SCENE.fogColor}
      showNavInfo={false}
      nodeColor={nodeColor}
      nodeVal={nodeVal}
      nodeRelSize={2.35}
      nodeOpacity={0.86}
      nodeResolution={10}
      nodeLabel={nodeLabel}
      nodeVisibility={nodeVisibility}
      linkVisibility={linkVisibility}
      // These alphas are multiplied by linkOpacity below, so the number here is not what you see:
      // the quietest tier used to be 0.08 × 0.48 ≈ 4% — a connection nobody could follow with
      // their eye. The tiers still rank the same way, they just start from
      // a visible floor; the structure of the brain is the links, not the dots.
      linkColor={(link: BrainLink3D) => {
        if (linkIsActive(link)) return 'rgba(255,255,255,0.95)';
        if (linkIsFocused(link)) return 'rgba(51,177,255,0.88)';
        if (link.type === 'xlayer') return 'rgba(245,172,163,0.62)';
        if (link.type === 'link') return 'rgba(51,177,255,0.5)';
        if (link.type === 'code') return 'rgba(81,213,165,0.36)';
        return 'rgba(158,165,173,0.28)';
      }}
      linkWidth={(link: BrainLink3D) => linkIsActive(link) ? 1.4 : linkIsFocused(link) ? 0.95 : link.type === 'xlayer' ? 0.7 : 0.4}
      linkOpacity={0.85}
      linkDirectionalParticles={(link: BrainLink3D) => {
        if (shouldIdleRenderer || !motionEnabled || !documentVisible || !linkVisibility(link)) return 0;
        if (linkIsActive(link)) return 3;
        const source = linkEndpointId(link.source);
        const target = linkEndpointId(link.target);
        return selected && (source === selected.id || target === selected.id) ? 2 : 0;
      }}
      linkDirectionalParticleWidth={1.25}
      linkDirectionalParticleSpeed={0.008}
      linkDirectionalParticleColor={(link: BrainLink3D) => {
        const target = nodeById.get(linkEndpointId(link.target));
        return LAYER_COLORS[target?.layer ?? ''] ?? '#E1E6EC';
      }}
      linkCurvature={(link: BrainLink3D) => link.type === 'xlayer' ? 0.18 : link.type === 'link' ? 0.08 : 0}
      onNodeClick={(node: BrainNode3D) => { wakeRenderer(1100); onSelect(node); }}
      onNodeHover={(node: BrainNode3D | null) => { if (node) wakeRenderer(260); onHover(node); }}
      onBackgroundClick={() => { wakeRenderer(180); onHover(null); onSelect(null); }}
      warmupTicks={1}
      cooldownTicks={1}
      cooldownTime={0}
    />
  );
});
