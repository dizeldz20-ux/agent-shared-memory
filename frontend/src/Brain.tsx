import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  FrontSide,
  Float32BufferAttribute,
  FogExp2,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  Points,
  PointsMaterial,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { BrainData, BrainNode, LiveActivitySource } from './types';
import {
  corticalFiberPositions,
  corticalFieldPositions,
  corticalMeshData,
  fieldDigest,
  neuronMorphologyPositions,
  translateNeuronMorphology,
} from './brainField';
import {
  BRAIN3D_SCENE,
  CAMERA_PRESETS_3D,
  LIVE_SIGNAL_LIMITS,
  LIVE_SIGNAL_PRESENTATION,
  buildBatchedConnectome3D,
  buildBrainGraph3D,
  buildLiveSignalSegments3D,
  buildRenderGraph3D,
  cameraFrameForNodes3D,
  digestLiveSignalSegments3D,
  digestBrainTargets,
  escapeHtml,
  focusNeighborhood3D,
  linkEndpointId,
  pruneLiveSignalTimings,
  syncBatchedConnectome3D,
  visibleLinks3D,
  type BrainLink3D,
  type BrainNode3D,
  type CameraPreset3D,
  type LiveSignalSegment3D,
} from './brain3d';
import {
  applyDragDelta,
  createDragRelaxation,
  createDragRelaxationWorld,
  dragInfluence as buildDragInfluence,
  pinAtCurrentPosition,
  stepDragRelaxation,
  type DragRelaxationState,
} from './dragField';
import {
  LIVE_AGENT_PALETTES as LIVE_AGENT_PALETTE_STRINGS,
  liveAgentLane,
} from './liveAgentPalette';

declare global {
  interface Window {
    __asm?: {
      network?: Record<string, unknown>;
      rings?: Record<string, unknown>;
      brain3d?: Record<string, unknown>;
    };
  }
}

let pointTexture: CanvasTexture | null = null;
let synapseTexture: CanvasTexture | null = null;
const CORTICAL_FIELD = corticalFieldPositions();
const CORTICAL_FIBERS = corticalFiberPositions();
const CORTICAL_MESH = corticalMeshData();
const CORTICAL_FIELD_DIGEST = fieldDigest(CORTICAL_FIELD);
/**
 * How close the camera may get to its orbit target.
 *
 * This was 105 (a shell you could never get inside), then 8 — and 8 is still a
 * wall: measured on the live graph, the distance pinned at exactly 8.00 and
 * seventy-two further wheel notches changed the camera by nothing at all, which
 * is why the interior reads as a frozen photograph. Paired with `zoomToCursor`
 * below, the target advances with you, so this is a floor on how close you may
 * come to the thing you aimed at rather than a floor on how deep you may go.
 */
const CAMERA_MIN_DISTANCE = 1.2;
const BRAIN_INTERIOR_RADIUS = 175;
/** How far ahead of the camera the orbit pivot is held while flying inside. */
const INTERIOR_PIVOT_DISTANCE = 45;
const LIVE_SEGMENT_CAPACITY = LIVE_SIGNAL_LIMITS.maxSources * LIVE_SIGNAL_LIMITS.maxSegmentsPerSource;
const LIVE_TRAIL_CAPACITY = LIVE_SEGMENT_CAPACITY * LIVE_SIGNAL_LIMITS.trailPointsPerSegment;

function collisionRadius3D(node: BrainNode3D) {
  const base = { root: 2.5, dir: 2, page: 1.55, file: 1.15, ephemeral: 1.45 }[node.kind] ?? 1.35;
  return base + Math.min(0.7, node.__degreeTier * 0.14);
}

interface LiveFlowBuffers {
  somaGeometry: BufferGeometry;
  somaPositions: Float32Array;
  somaColors: Float32Array;
  routeGeometry: LineSegmentsGeometry;
  routePositions: Float32Array;
  routeColors: Float32Array;
  headGeometry: BufferGeometry;
  headPositions: Float32Array;
  headColors: Float32Array;
  trailGeometry: BufferGeometry;
  trailPositions: Float32Array;
  trailColors: Float32Array;
}

interface InteriorMaterials {
  nodes: PointsMaterial;
  links: Array<{ material: LineBasicMaterial; opacity: number }>;
  field: PointsMaterial;
  fibers: LineBasicMaterial;
  morphology: LineBasicMaterial;
  synapses: PointsMaterial;
}

const LIVE_AGENT_PALETTES = Object.fromEntries(
  Object.entries(LIVE_AGENT_PALETTE_STRINGS).map(([lane, palette]) => [lane, {
    soma: new Color(palette.soma),
    route: new Color(palette.route),
    head: new Color(palette.head),
    trail: new Color(palette.trail),
  }]),
) as Record<keyof typeof LIVE_AGENT_PALETTE_STRINGS, {
  soma: Color;
  route: Color;
  head: Color;
  trail: Color;
}>;

function liveAgentPalette(agent?: string) {
  return LIVE_AGENT_PALETTES[liveAgentLane(agent)];
}

type OrbitPointerPosition = { x: number; y: number; set(x: number, y: number): OrbitPointerPosition };

function orbitPointerPosition(): OrbitPointerPosition {
  return {
    x: 0,
    y: 0,
    set(x, y) {
      this.x = x;
      this.y = y;
      return this;
    },
  };
}

function getPointTexture() {
  if (pointTexture) return pointTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d')!;
  context.clearRect(0, 0, 128, 128);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = 'rgba(255,255,255,.5)';
  context.lineWidth = 2;
  for (let branch = 0; branch < 7; branch++) {
    const angle = branch / 7 * Math.PI * 2 + 0.19;
    const sx = 64 + Math.cos(angle) * 13;
    const sy = 64 + Math.sin(angle) * 13;
    const mx = 64 + Math.cos(angle + (branch % 2 ? 0.14 : -0.12)) * 31;
    const my = 64 + Math.sin(angle + (branch % 2 ? 0.14 : -0.12)) * 31;
    const ex = 64 + Math.cos(angle + (branch % 3 - 1) * 0.1) * (48 + branch % 2 * 7);
    const ey = 64 + Math.sin(angle + (branch % 3 - 1) * 0.1) * (48 + branch % 2 * 7);
    context.beginPath();
    context.moveTo(sx, sy);
    context.quadraticCurveTo(mx, my, ex, ey);
    context.stroke();
    for (const fork of [-1, 1]) {
      context.globalAlpha = 0.62;
      context.beginPath();
      context.moveTo(ex, ey);
      context.lineTo(ex + Math.cos(angle + fork * 0.46) * 8, ey + Math.sin(angle + fork * 0.46) * 8);
      context.stroke();
    }
    context.globalAlpha = 1;
  }
  context.shadowColor = 'rgba(255,255,255,.68)';
  context.shadowBlur = 8;
  context.strokeStyle = 'rgba(255,255,255,.88)';
  context.lineWidth = 3;
  context.beginPath();
  for (let step = 0; step <= 18; step++) {
    const angle = step / 18 * Math.PI * 2;
    const radius = 11.5 + Math.sin(angle * 5) * 1.8 + Math.sin(angle * 3 + 0.7) * 1.1;
    const x = 64 + Math.cos(angle) * radius;
    const y = 64 + Math.sin(angle) * radius;
    if (step === 0) context.moveTo(x, y); else context.lineTo(x, y);
  }
  context.stroke();
  context.shadowBlur = 0;
  context.strokeStyle = 'rgba(255,255,255,.28)';
  context.lineWidth = 1;
  context.beginPath();
  context.arc(64, 64, 17, 0, Math.PI * 2);
  context.stroke();
  pointTexture = new CanvasTexture(canvas);
  return pointTexture;
}

function getSynapseTexture() {
  if (synapseTexture) return synapseTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d')!;
  const glow = context.createRadialGradient(16, 16, 1, 16, 16, 14);
  glow.addColorStop(0, 'rgba(255,255,255,.95)');
  glow.addColorStop(0.24, 'rgba(255,255,255,.5)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, 32, 32);
  synapseTexture = new CanvasTexture(canvas);
  return synapseTexture;
}

interface Props {
  data: BrainData;
  active: Map<string, number>;
  activeAgents: Map<string, string>;
  activeSources: Map<string, LiveActivitySource>;
  layerVisible: Record<string, boolean>;
  selected: BrainNode | null;
  hovered: BrainNode | null;
  onSelect: (node: BrainNode | null) => void;
  onHover: (node: BrainNode | null) => void;
  motionEnabled: boolean;
  cameraPreset: CameraPreset3D;
  layoutResetToken: number;
  activityRevision: number;
  fgRef: MutableRefObject<any>;
  positionCache: Map<string, { x: number; y: number; z: number }>;
}

export const Brain = memo(function Brain({
  data,
  active,
  activeAgents,
  activeSources,
  layerVisible,
  selected,
  hovered,
  onSelect,
  onHover,
  motionEnabled,
  cameraPreset,
  layoutResetToken,
  activityRevision,
  fgRef,
  positionCache,
}: Props) {
  const graph = useMemo(() => {
    const next = buildBrainGraph3D(data);
    const validIds = new Set(next.nodes.map((node) => node.id));
    for (const id of positionCache.keys()) if (!validIds.has(id)) positionCache.delete(id);
    for (const node of next.nodes) {
      const cached = positionCache.get(node.id);
      if (!cached) continue;
      node.x = cached.x;
      node.y = cached.y;
      node.z = cached.z;
      node.fx = cached.x;
      node.fy = cached.y;
      node.fz = cached.z;
      node.vx = 0;
      node.vy = 0;
      node.vz = 0;
    }
    return next;
  }, [data, layoutResetToken, positionCache]);
  const batchedConnectome = useMemo(() => buildBatchedConnectome3D(graph), [graph]);
  // MAP, CORTEX and CONNECTOME resolve activity over the same real graph edges.
  // The static background remains budgeted, while the tiny live overlay may use
  // any existing tract without creating synthetic shortcut lines.
  const liveRouteLinks = graph.links;
  const visibleTractNodeCount = useMemo(() => new Set(
    batchedConnectome.links.flatMap((link) => [link.__sourceId, link.__targetId]),
  ).size, [batchedConnectome.links]);
  const morphology = useMemo(() => neuronMorphologyPositions(graph.nodes), [graph.nodes]);
  const morphologyRangesById = useMemo(
    () => new Map(morphology.ranges.map((range) => [range.id, range])),
    [morphology.ranges],
  );
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const physicsNodeById = useMemo(
    () => new Map(graph.nodes.filter((node) => layerVisible[node.layer] !== false).map((node) => [node.id, node])),
    [graph.nodes, layerVisible],
  );
  const relaxationWorld = useMemo(() => createDragRelaxationWorld(
    physicsNodeById,
    (candidate) => collisionRadius3D(candidate as BrainNode3D),
    { dimensions: 3, collisionPadding: 0.28 },
  ), [physicsNodeById]);
  const positionDigest = useMemo(() => digestBrainTargets(graph.nodes), [graph.nodes]);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const [pulseTick, setPulseTick] = useState(0);
  const [graphInstance, setGraphInstance] = useState<any>(null);
  const ambientCursor = useRef(0);
  const draggingIdRef = useRef<string | null>(null);
  const dragFieldRef = useRef<Map<string, number>>(new Map());
  const relaxationRef = useRef<DragRelaxationState | null>(null);
  const dragDeltaRef = useRef({ x: 0, y: 0, z: 0 });
  const dragFrameRef = useRef<number | null>(null);
  const settleFrameRef = useRef<number | null>(null);
  const settleStepRef = useRef(0);
  const settleQuietRef = useRef(0);
  const lastCollisionCount = useRef(0);
  const collisionCountTotal = useRef(0);
  const lastRelaxingNodeCount = useRef(0);
  const lastDragNeighborCount = useRef(0);
  const pointerDownRef = useRef(false);
  const lastLayoutReset = useRef(layoutResetToken);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const framingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spriteMaterials = useRef(new Map<string, SpriteMaterial>());
  const batchGeometryRef = useRef<{
    node: BufferGeometry;
    links: Partial<Record<'contains' | 'code' | 'link' | 'xlayer', BufferGeometry>>;
  } | null>(null);
  const morphologyGeometryRef = useRef<{
    segments: BufferGeometry;
    synapses: BufferGeometry;
    lastAnchors: Map<string, { x: number; y: number; z: number }>;
  } | null>(null);
  const liveFlowRef = useRef<LiveFlowBuffers | null>(null);
  const liveFlowStatsRef = useRef({
    agentCount: 0,
    nodeCount: 0,
    segmentCount: 0,
    beadCount: 0,
    digest: digestLiveSignalSegments3D([]),
  });
  const liveStartRef = useRef(new Map<string, number>());
  const liveExpiryRef = useRef(new Map<string, number>());
  const interiorMaterialsRef = useRef<InteriorMaterials | null>(null);
  const insideBrainRef = useRef(false);
  const [framing, setFraming] = useState({ ready: false, visibleNodeRatio: 0, topOccludedNodeCount: 0 });
  // Hover is strictly a visual highlight. Letting it rebuild the focus subgraph
  // changed the camera frame beneath the pointer, which immediately hovered a
  // different node and produced a zoom/focus feedback loop. Selection is stable.
  const focusId = selected?.id ?? null;
  const focusIds = useMemo(() => focusNeighborhood3D(focusId, graph.neighbors), [focusId, graph.neighbors]);

  useEffect(() => () => {
    liveStartRef.current.clear();
    liveExpiryRef.current.clear();
  }, []);

  useEffect(() => {
    const restorePointerControls = () => {
      pointerDownRef.current = false;
      const controls = fgRef.current?.controls?.() as {
        _pointers?: number[];
        _pointerPositions?: Record<number, OrbitPointerPosition>;
        enabled?: boolean;
      } | undefined;
      if (controls?._pointers) controls._pointers.length = 0;
      if (controls?._pointerPositions) controls._pointerPositions = {};
      if (controls) controls.enabled = true;
    };
    if (dragFrameRef.current != null) cancelAnimationFrame(dragFrameRef.current);
    if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current);
    dragFrameRef.current = null;
    settleFrameRef.current = null;
    relaxationRef.current = null;
    dragDeltaRef.current = { x: 0, y: 0, z: 0 };
    settleQuietRef.current = 0;
    draggingIdRef.current = null;
    dragFieldRef.current = new Map();
    restorePointerControls();
    return () => {
      if (dragFrameRef.current != null) cancelAnimationFrame(dragFrameRef.current);
      if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current);
      dragFrameRef.current = null;
      settleFrameRef.current = null;
      relaxationRef.current = null;
      dragDeltaRef.current = { x: 0, y: 0, z: 0 };
      draggingIdRef.current = null;
      dragFieldRef.current = new Map();
      restorePointerControls();
    };
  }, [fgRef, graph]);

  const activeIds = useMemo(() => {
    const now = Date.now();
    const ids = new Set<string>();
    for (const [id, until] of active) {
      if (until >= now) ids.add(id);
      else {
        active.delete(id);
        activeAgents.delete(id);
      }
    }
    return ids;
    // pulseTick deliberately refreshes the mutable live-event map.
  }, [active, activeAgents, activityRevision, pulseTick]);

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
  // OrbitControls are rendered by the same loop. Pausing that loop made wheel/drag
  // navigation appear broken on the production-size graph, even though controls were
  // technically attached. Keep the visible scene live and only pause a hidden tab.
  const shouldIdleRenderer = !documentVisible;

  const attachGraph = useCallback((instance: any) => {
    fgRef.current = instance;
    if (instance) setGraphInstance((current: any) => current === instance ? current : instance);
  }, [fgRef]);

  const pauseRenderer = useCallback(() => {
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = null;
    fgRef.current?.pauseAnimation?.();
  }, [fgRef]);

  const wakeRenderer = useCallback((duration = 900) => {
    if (!documentVisible) return;
    const fg = graphInstance;
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
  }, [documentVisible, fgRef, graphInstance, motionEnabled, shouldIdleRenderer]);

  const syncBatchPositions = useCallback((ids?: Iterable<string>) => {
    const changedTypes = syncBatchedConnectome3D(batchedConnectome, nodeById, ids);
    const geometries = batchGeometryRef.current;
    const nodeAttribute = geometries?.node.getAttribute('position');
    if (nodeAttribute) nodeAttribute.needsUpdate = true;
    for (const type of changedTypes) {
      const attribute = geometries?.links[type]?.getAttribute('position');
      if (attribute) attribute.needsUpdate = true;
    }
  }, [batchedConnectome, nodeById]);

  const syncMorphologyPositions = useCallback((ids: Iterable<string>) => {
    const buffers = morphologyGeometryRef.current;
    if (!buffers) return;
    const segmentAttribute = buffers.segments.getAttribute('position');
    const synapseAttribute = buffers.synapses.getAttribute('position');
    const segments = segmentAttribute?.array as Float32Array | undefined;
    const synapses = synapseAttribute?.array as Float32Array | undefined;
    if (!segments || !synapses) return;
    let changed = false;
    for (const id of ids) {
      const range = morphologyRangesById.get(id);
      const node = nodeById.get(id);
      const previous = buffers.lastAnchors.get(id);
      if (!range || !node || !previous) continue;
      const dx = node.x - previous.x;
      const dy = node.y - previous.y;
      const dz = node.z - previous.z;
      if (!translateNeuronMorphology(segments, synapses, range, dx, dy, dz)) continue;
      buffers.lastAnchors.set(id, { x: node.x, y: node.y, z: node.z });
      changed = true;
    }
    if (changed) {
      segmentAttribute!.needsUpdate = true;
      synapseAttribute!.needsUpdate = true;
    }
  }, [morphologyRangesById, nodeById]);

  const updateInteriorPresentation = useCallback(() => {
    const camera = fgRef.current?.camera?.();
    const target = fgRef.current?.controls?.()?.target ?? { x: 0, y: 0, z: 0 };
    if (!camera?.position) return;
    const distance = Math.hypot(
      camera.position.x - target.x,
      camera.position.y - target.y,
      camera.position.z - target.z,
    );
    const interiorMix = Math.max(0, Math.min(1, (BRAIN_INTERIOR_RADIUS - distance) / 112));
    insideBrainRef.current = distance < BRAIN_INTERIOR_RADIUS;
    const materials = interiorMaterialsRef.current;
    if (!materials) return;
    const liveActive = liveFlowStatsRef.current.nodeCount > 0;
    const nodeContrast = liveActive ? LIVE_SIGNAL_PRESENTATION.staticNodeContrast : 1;
    const linkContrast = liveActive ? LIVE_SIGNAL_PRESENTATION.staticLinkContrast : 1;
    const fieldContrast = liveActive ? LIVE_SIGNAL_PRESENTATION.staticFieldContrast : 1;
    const morphologyContrast = liveActive ? LIVE_SIGNAL_PRESENTATION.staticMorphologyContrast : 1;

    // Inside the connectome, suppress only the whole-brain wiring veil and reveal
    // the cellular morphology. The live action-potential layer remains untouched.
    materials.nodes.opacity = (0.28 - interiorMix * 0.12) * nodeContrast;
    for (const { material, opacity } of materials.links) {
      material.opacity = opacity * (1 - interiorMix * 0.82) * linkContrast;
    }
    materials.field.opacity = (0.075 - interiorMix * 0.05) * fieldContrast;
    materials.fibers.opacity = (0.09 - interiorMix * 0.065) * fieldContrast;
    materials.morphology.opacity = (0.18 + interiorMix * 0.07) * morphologyContrast;
    materials.synapses.opacity = (0.4 + interiorMix * 0.18) * morphologyContrast;
  }, [fgRef]);

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
    const frameNodes = [
      ...renderGraph.nodes.filter((node) => layerVisible[node.layer] !== false),
      ...[
        { x: -212, y: 0, z: 0 }, { x: 212, y: 0, z: 0 },
        { x: 0, y: -140, z: 0 }, { x: 0, y: 140, z: 0 },
        { x: 0, y: 0, z: -160 }, { x: 0, y: 0, z: 160 },
      ] as BrainNode3D[],
    ];
    const frame = cameraFrameForNodes3D(
      frameNodes,
      preset,
      {
        width: rect.width,
        height: rect.height,
        safeTop,
        bottomPadding: 48,
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
  // Structural live events may replace the graph data, but they are not camera
  // intent. Keep the latest fitter callable without making its changing closure
  // a reason to reframe a user-controlled orbit/zoom.
  const fitCameraToViewportRef = useRef(fitCameraToViewport);
  fitCameraToViewportRef.current = fitCameraToViewport;

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
    const previousBackground = scene.background;
    scene.fog = new FogExp2(BRAIN3D_SCENE.fogColor, BRAIN3D_SCENE.fogDensity);
    scene.background = new Color(BRAIN3D_SCENE.fogColor);

    // The full 19k-node knowledge graph is one GPU point cloud. Only the semantic
    // hubs below remain individual Sprites for hit testing and labels.
    const dataNodeGeometry = new BufferGeometry();
    dataNodeGeometry.setAttribute('position', new Float32BufferAttribute(batchedConnectome.nodePositions, 3));
    const dataNodeColors = new Float32Array(graph.nodes.length * 3);
    graph.nodes.forEach((node, index) => {
      const base = node.layer === 'asm' ? '#b5ded9'
        : node.kind === 'root' ? '#d4e6e2'
          : node.kind === 'dir' ? '#9dc0bc'
            : node.kind === 'page' ? '#91aaa8'
              : '#6f9290';
      const color = layerVisible[node.layer] === false ? new Color(0, 0, 0) : new Color(base);
      dataNodeColors.set([color.r, color.g, color.b], index * 3);
    });
    dataNodeGeometry.setAttribute('color', new Float32BufferAttribute(dataNodeColors, 3));
    const dataNodeMaterial = new PointsMaterial({
      size: 1.9,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.28,
      vertexColors: true,
      map: getSynapseTexture(),
      alphaTest: 0.025,
      depthTest: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const dataNodes = new Points(dataNodeGeometry, dataNodeMaterial);
    dataNodes.name = 'asm-data-neurons-all';
    dataNodes.renderOrder = 0;
    scene.add(dataNodes);

    const batchLinkStyles = {
      contains: { color: '#789f9c', opacity: 0.065 },
      code: { color: '#628785', opacity: 0.13 },
      link: { color: '#82aaa6', opacity: 0.2 },
      xlayer: { color: '#9bc3be', opacity: 0.28 },
    } as const;
    const dataLinkGeometries: Partial<Record<keyof typeof batchLinkStyles, BufferGeometry>> = {};
    const dataLinkObjects: LineSegments[] = [];
    const dataLinkMaterials: Array<{ material: LineBasicMaterial; opacity: number }> = [];
    for (const type of Object.keys(batchLinkStyles) as Array<keyof typeof batchLinkStyles>) {
      const positions = batchedConnectome.linkPositions[type];
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      const typeLinks = batchedConnectome.links.filter((link) => (link.type || 'contains') === type);
      const colors = new Float32Array(typeLinks.length * 6);
      typeLinks.forEach((link, index) => {
        const source = nodeById.get(link.__sourceId);
        const target = nodeById.get(link.__targetId);
        const visible = layerVisible[source?.layer ?? ''] !== false && layerVisible[target?.layer ?? ''] !== false;
        const value = visible ? 1 : 0;
        colors.set([value, value, value, value, value, value], index * 6);
      });
      geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
      const style = batchLinkStyles[type];
      const material = new LineBasicMaterial({
        color: style.color,
        transparent: true,
        opacity: style.opacity,
        vertexColors: true,
        depthWrite: false,
      });
      const object = new LineSegments(geometry, material);
      object.name = `asm-data-synapses-${type}`;
      object.renderOrder = 0;
      scene.add(object);
      dataLinkGeometries[type] = geometry;
      dataLinkObjects.push(object);
      dataLinkMaterials.push({ material, opacity: style.opacity });
    }
    batchGeometryRef.current = { node: dataNodeGeometry, links: dataLinkGeometries };

    const liveSomaPositions = new Float32Array(LIVE_SIGNAL_LIMITS.maxSources * 3);
    const liveSomaColors = new Float32Array(LIVE_SIGNAL_LIMITS.maxSources * 3);
    const liveSomaGeometry = new BufferGeometry();
    liveSomaGeometry.setAttribute('position', new Float32BufferAttribute(liveSomaPositions, 3));
    liveSomaGeometry.setAttribute('color', new Float32BufferAttribute(liveSomaColors, 3));
    liveSomaGeometry.setDrawRange(0, 0);
    const liveSomaMaterial = new PointsMaterial({
      color: '#ffffff',
      vertexColors: true,
      size: LIVE_SIGNAL_PRESENTATION.sourceNeuronSizePx,
      sizeAttenuation: false,
      map: getPointTexture(),
      alphaTest: 0.035,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const liveSomas = new Points(liveSomaGeometry, liveSomaMaterial);
    liveSomas.name = 'asm-live-signal-somas';
    liveSomas.renderOrder = 12;
    liveSomas.frustumCulled = false;
    scene.add(liveSomas);

    const liveSomaHaloMaterial = new PointsMaterial({
      color: '#ffffff',
      vertexColors: true,
      size: LIVE_SIGNAL_PRESENTATION.sourceHaloSizePx,
      sizeAttenuation: false,
      map: getSynapseTexture(),
      alphaTest: 0.008,
      transparent: true,
      opacity: 0.58,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const liveSomaHalos = new Points(liveSomaGeometry, liveSomaHaloMaterial);
    liveSomaHalos.name = 'asm-live-signal-soma-halos';
    liveSomaHalos.renderOrder = 11;
    liveSomaHalos.frustumCulled = false;
    scene.add(liveSomaHalos);

    const liveRoutePositions = new Float32Array(LIVE_SEGMENT_CAPACITY * 6);
    const liveRouteColors = new Float32Array(LIVE_SEGMENT_CAPACITY * 6);
    const liveRouteGeometry = new LineSegmentsGeometry();
    liveRouteGeometry.setPositions(liveRoutePositions);
    liveRouteGeometry.setColors(liveRouteColors);
    liveRouteGeometry.instanceCount = 0;
    liveRouteGeometry.getAttribute('instanceStart')?.data?.setUsage(DynamicDrawUsage);
    liveRouteGeometry.getAttribute('instanceColorStart')?.data?.setUsage(DynamicDrawUsage);
    const liveRouteGlowMaterial = new LineMaterial({
      color: '#ffffff',
      vertexColors: true,
      linewidth: LIVE_SIGNAL_PRESENTATION.routeGlowWidthPx,
      transparent: true,
      opacity: 0.07,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const liveRouteGlows = new LineSegments2(liveRouteGeometry, liveRouteGlowMaterial);
    liveRouteGlows.name = 'asm-live-signal-route-glows';
    liveRouteGlows.renderOrder = 8;
    liveRouteGlows.frustumCulled = false;
    scene.add(liveRouteGlows);

    const liveRouteMaterial = new LineMaterial({
      color: '#ffffff',
      vertexColors: true,
      linewidth: LIVE_SIGNAL_PRESENTATION.routeWidthPx,
      transparent: true,
      opacity: 0.46,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const liveRoutes = new LineSegments2(liveRouteGeometry, liveRouteMaterial);
    liveRoutes.name = 'asm-live-signal-routes';
    liveRoutes.renderOrder = 9;
    liveRoutes.frustumCulled = false;
    scene.add(liveRoutes);

    const liveHeadPositions = new Float32Array(LIVE_SEGMENT_CAPACITY * 3);
    const liveHeadColors = new Float32Array(LIVE_SEGMENT_CAPACITY * 3);
    const liveHeadGeometry = new BufferGeometry();
    liveHeadGeometry.setAttribute('position', new Float32BufferAttribute(liveHeadPositions, 3));
    liveHeadGeometry.setAttribute('color', new Float32BufferAttribute(liveHeadColors, 3));
    liveHeadGeometry.setDrawRange(0, 0);
    const liveHeadMaterial = new PointsMaterial({
      color: '#ffffff',
      vertexColors: true,
      size: LIVE_SIGNAL_PRESENTATION.headSizePx,
      sizeAttenuation: false,
      map: getSynapseTexture(),
      alphaTest: 0.015,
      transparent: true,
      opacity: 0.98,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const liveHeads = new Points(liveHeadGeometry, liveHeadMaterial);
    liveHeads.name = 'asm-live-signal-heads';
    liveHeads.renderOrder = 13;
    liveHeads.frustumCulled = false;
    scene.add(liveHeads);

    const liveTrailPositions = new Float32Array(LIVE_TRAIL_CAPACITY * 3);
    const liveTrailColors = new Float32Array(LIVE_TRAIL_CAPACITY * 3);
    const liveTrailGeometry = new BufferGeometry();
    liveTrailGeometry.setAttribute('position', new Float32BufferAttribute(liveTrailPositions, 3));
    liveTrailGeometry.setAttribute('color', new Float32BufferAttribute(liveTrailColors, 3));
    liveTrailGeometry.setDrawRange(0, 0);
    const liveTrailMaterial = new PointsMaterial({
      color: '#ffffff',
      vertexColors: true,
      size: LIVE_SIGNAL_PRESENTATION.trailSizePx,
      sizeAttenuation: false,
      map: getSynapseTexture(),
      alphaTest: 0.015,
      transparent: true,
      opacity: 0.82,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const liveTrails = new Points(liveTrailGeometry, liveTrailMaterial);
    liveTrails.name = 'asm-live-signal-trails';
    liveTrails.renderOrder = 10;
    liveTrails.frustumCulled = false;
    scene.add(liveTrails);

    liveFlowRef.current = {
      somaGeometry: liveSomaGeometry,
      somaPositions: liveSomaPositions,
      somaColors: liveSomaColors,
      routeGeometry: liveRouteGeometry,
      routePositions: liveRoutePositions,
      routeColors: liveRouteColors,
      headGeometry: liveHeadGeometry,
      headPositions: liveHeadPositions,
      headColors: liveHeadColors,
      trailGeometry: liveTrailGeometry,
      trailPositions: liveTrailPositions,
      trailColors: liveTrailColors,
    };

    const fieldGeometry = new BufferGeometry();
    fieldGeometry.setAttribute('position', new Float32BufferAttribute(CORTICAL_FIELD, 3));
    const fieldMaterial = new PointsMaterial({
      color: '#91b4b2',
      size: 0.4,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.075,
      map: getSynapseTexture(),
      alphaTest: 0.02,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const field = new Points(fieldGeometry, fieldMaterial);
    field.name = 'asm-cortical-field';
    field.renderOrder = -1;
    scene.add(field);

    const fiberGeometry = new BufferGeometry();
    fiberGeometry.setAttribute('position', new Float32BufferAttribute(CORTICAL_FIBERS, 3));
    const fiberMaterial = new LineBasicMaterial({
      color: '#789a98',
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const fibers = new LineSegments(fiberGeometry, fiberMaterial);
    fibers.name = 'asm-cortical-fibers';
    fibers.renderOrder = -2;
    scene.add(fibers);

    const shellGeometry = new BufferGeometry();
    shellGeometry.setAttribute('position', new Float32BufferAttribute(CORTICAL_MESH.positions, 3));
    shellGeometry.setIndex(Array.from(CORTICAL_MESH.indices));
    shellGeometry.computeVertexNormals();
    const shellMaterial = new ShaderMaterial({
      vertexShader: `
        varying vec3 vLocalPosition;
        varying vec3 vViewNormal;
        void main() {
          vLocalPosition = position;
          vViewNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vLocalPosition;
        varying vec3 vViewNormal;
        void main() {
          float fissureRise = clamp((vLocalPosition.y + 36.0) / 42.0, 0.0, 1.0);
          float fissureWidth = (4.4 + 2.2 * pow(clamp((vLocalPosition.y + 36.0) / 170.0, 0.0, 1.0), 1.4)) * fissureRise;
          if (fissureWidth > 0.5 && abs(vLocalPosition.z) < fissureWidth) discard;
          float rim = pow(1.0 - abs(vViewNormal.z), 2.15);
          float fold = 0.5 + 0.5 * sin(vLocalPosition.y * 0.085 + sin(vLocalPosition.z * 0.05) * 2.2);
          vec3 tissue = vec3(0.39, 0.64, 0.62);
          float alpha = 0.0015 + rim * 0.0065 + fold * 0.0012;
          gl_FragColor = vec4(tissue, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: FrontSide,
      blending: AdditiveBlending,
    });
    const shell = new Mesh(shellGeometry, shellMaterial);
    shell.name = 'asm-living-cortical-shell';
    shell.renderOrder = -3;
    scene.add(shell);

    const morphologyGeometry = new BufferGeometry();
    morphologyGeometry.setAttribute('position', new Float32BufferAttribute(morphology.segments, 3));
    const morphologyMaterial = new LineBasicMaterial({
      color: '#91b4b2',
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const morphologyLines = new LineSegments(morphologyGeometry, morphologyMaterial);
    morphologyLines.name = 'asm-neuron-dendrites';
    morphologyLines.renderOrder = 1;
    scene.add(morphologyLines);

    const synapseGeometry = new BufferGeometry();
    synapseGeometry.setAttribute('position', new Float32BufferAttribute(morphology.synapses, 3));
    const synapseMaterial = new PointsMaterial({
      color: '#b7d8d4',
      size: 1.45,
      sizeAttenuation: true,
      map: getSynapseTexture(),
      alphaTest: 0.02,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const synapses = new Points(synapseGeometry, synapseMaterial);
    synapses.name = 'asm-neuron-synapses';
    synapses.renderOrder = 2;
    scene.add(synapses);

    morphologyGeometryRef.current = {
      segments: morphologyGeometry,
      synapses: synapseGeometry,
      lastAnchors: new Map(morphology.ranges.map((range) => [
        range.id,
        { x: range.x, y: range.y, z: range.z },
      ])),
    };

    interiorMaterialsRef.current = {
      nodes: dataNodeMaterial,
      links: dataLinkMaterials,
      field: fieldMaterial,
      fibers: fiberMaterial,
      morphology: morphologyMaterial,
      synapses: synapseMaterial,
    };
    updateInteriorPresentation();

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
      liveFlowRef.current = null;
      interiorMaterialsRef.current = null;
      batchGeometryRef.current = null;
      if (morphologyGeometryRef.current?.segments === morphologyGeometry) morphologyGeometryRef.current = null;
      scene.remove(liveTrails);
      scene.remove(liveHeads);
      scene.remove(liveRoutes);
      scene.remove(liveRouteGlows);
      scene.remove(liveSomas);
      scene.remove(liveSomaHalos);
      scene.remove(dataNodes);
      for (const object of dataLinkObjects) {
        scene.remove(object);
        object.geometry.dispose();
        (object.material as LineBasicMaterial).dispose();
      }
      scene.remove(synapses);
      scene.remove(morphologyLines);
      scene.remove(shell);
      scene.remove(fibers);
      scene.remove(field);
      liveTrailGeometry.dispose();
      liveTrailMaterial.dispose();
      liveHeadGeometry.dispose();
      liveHeadMaterial.dispose();
      liveRouteGeometry.dispose();
      liveRouteMaterial.dispose();
      liveRouteGlowMaterial.dispose();
      liveSomaGeometry.dispose();
      liveSomaMaterial.dispose();
      liveSomaHaloMaterial.dispose();
      dataNodeGeometry.dispose();
      dataNodeMaterial.dispose();
      synapseGeometry.dispose();
      synapseMaterial.dispose();
      morphologyGeometry.dispose();
      morphologyMaterial.dispose();
      shellGeometry.dispose();
      shellMaterial.dispose();
      fiberGeometry.dispose();
      fiberMaterial.dispose();
      fieldGeometry.dispose();
      fieldMaterial.dispose();
      scene.fog = previousFog;
      scene.background = previousBackground;
    };
  }, [
    batchedConnectome,
    documentVisible,
    graph.nodes,
    graphInstance,
    layerVisible,
    morphology,
    nodeById,
    updateInteriorPresentation,
  ]);

  useEffect(() => {
    const flow = liveFlowRef.current;
    if (!flow) return;
    let animationFrame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    pruneLiveSignalTimings(startedAt, liveStartRef.current, liveExpiryRef.current);
    const candidates = [...activeSources.entries()]
      .filter(([, source]) => {
        const node = nodeById.get(source.nodeId);
        return Boolean(node) && source.until >= startedAt && layerVisible[node!.layer] !== false;
      })
      .sort((a, b) => b[1].until - a[1].until || a[0].localeCompare(b[0]));
    const sourceLanes = new Map<string, Array<[string, LiveActivitySource]>>();
    for (const candidate of candidates) {
      const lane = sourceLanes.get(candidate[1].agent) ?? [];
      lane.push(candidate);
      sourceLanes.set(candidate[1].agent, lane);
    }
    const sources: Array<[string, LiveActivitySource]> = [];
    const orderedSourceLanes = [...sourceLanes.values()];
    for (let depth = 0; sources.length < LIVE_SIGNAL_LIMITS.maxSources; depth++) {
      let added = false;
      for (const lane of orderedSourceLanes) {
        const candidate = lane[depth];
        if (!candidate) continue;
        sources.push(candidate);
        added = true;
        if (sources.length >= LIVE_SIGNAL_LIMITS.maxSources) break;
      }
      if (!added) break;
    }

    for (const [key, source] of sources) {
      if (liveExpiryRef.current.get(key) !== source.until) {
        liveExpiryRef.current.set(key, source.until);
        liveStartRef.current.set(key, startedAt);
      }
    }
    const sourceByKey = new Map(sources);
    const segments = buildLiveSignalSegments3D(
      graph,
      sources.map(([key, source]) => ({ id: source.nodeId, originId: key })),
      {},
      liveRouteLinks,
    )
      .filter((segment) => {
        const source = nodeById.get(segment.sourceId);
        const target = nodeById.get(segment.targetId);
        return Boolean(source && target)
          && layerVisible[source!.layer] !== false
          && layerVisible[target!.layer] !== false;
      });

    const markGeometry = (geometry: BufferGeometry) => {
      const position = geometry.getAttribute('position');
      const color = geometry.getAttribute('color');
      if (position) position.needsUpdate = true;
      if (color) color.needsUpdate = true;
    };
    const markRouteGeometry = () => {
      const positions = flow.routeGeometry.getAttribute('instanceStart');
      const colors = flow.routeGeometry.getAttribute('instanceColorStart');
      if (positions?.data) positions.data.needsUpdate = true;
      else if (positions) positions.needsUpdate = true;
      if (colors?.data) colors.data.needsUpdate = true;
      else if (colors) colors.needsUpdate = true;
    };
    const clear = () => {
      flow.somaGeometry.setDrawRange(0, 0);
      flow.routeGeometry.instanceCount = 0;
      flow.headGeometry.setDrawRange(0, 0);
      flow.trailGeometry.setDrawRange(0, 0);
      liveFlowStatsRef.current = {
        agentCount: 0,
        nodeCount: 0,
        segmentCount: 0,
        beadCount: 0,
        digest: digestLiveSignalSegments3D([]),
      };
      updateInteriorPresentation();
    };

    const render = () => {
      const now = Date.now();
      const visibleSources = sources.filter(([, source]) => source.until >= now);
      const visibleIds = new Set(visibleSources.map(([key]) => key));
      visibleSources.forEach(([, source], index) => {
        const node = nodeById.get(source.nodeId);
        if (!node) return;
        const soma = liveAgentPalette(source.agent).soma;
        flow.somaPositions.set([node.x, node.y, node.z], index * 3);
        flow.somaColors.set([soma.r, soma.g, soma.b], index * 3);
      });

      const visibleSegments = segments.filter((segment) => visibleIds.has(segment.originId));
      visibleSegments.forEach((segment, index) => {
        const source = nodeById.get(segment.sourceId)!;
        const target = nodeById.get(segment.targetId)!;
        const palette = liveAgentPalette(sourceByKey.get(segment.originId)?.agent);
        flow.routePositions.set(
          [source.x, source.y, source.z, target.x, target.y, target.z],
          index * 6,
        );
        flow.routeColors.set([
          palette.route.r, palette.route.g, palette.route.b,
          palette.route.r, palette.route.g, palette.route.b,
        ], index * 6);
        const elapsed = motionEnabled ? now - (liveStartRef.current.get(segment.originId) ?? now) : 620;
        const rawPhase = elapsed / 1180 - segment.depth * 0.2 + (index % 7) * 0.037;
        const phase = ((rawPhase % 1) + 1) % 1;
        flow.headPositions.set([
          source.x + (target.x - source.x) * phase,
          source.y + (target.y - source.y) * phase,
          source.z + (target.z - source.z) * phase,
        ], index * 3);
        flow.headColors.set([palette.head.r, palette.head.g, palette.head.b], index * 3);
        for (let trailIndex = 0; trailIndex < LIVE_SIGNAL_LIMITS.trailPointsPerSegment; trailIndex++) {
          const rawTrailPhase = phase - (trailIndex + 1) * 0.065;
          const trailPhase = ((rawTrailPhase % 1) + 1) % 1;
          const offset = (index * LIVE_SIGNAL_LIMITS.trailPointsPerSegment + trailIndex) * 3;
          flow.trailPositions.set([
            source.x + (target.x - source.x) * trailPhase,
            source.y + (target.y - source.y) * trailPhase,
            source.z + (target.z - source.z) * trailPhase,
          ], offset);
          flow.trailColors.set([palette.trail.r, palette.trail.g, palette.trail.b], offset);
        }
      });

      flow.somaGeometry.setDrawRange(0, visibleSources.length);
      flow.routeGeometry.instanceCount = visibleSegments.length;
      flow.headGeometry.setDrawRange(0, visibleSegments.length);
      flow.trailGeometry.setDrawRange(
        0,
        visibleSegments.length * LIVE_SIGNAL_LIMITS.trailPointsPerSegment,
      );
      markGeometry(flow.somaGeometry);
      markRouteGeometry();
      markGeometry(flow.headGeometry);
      markGeometry(flow.trailGeometry);
      liveFlowStatsRef.current = {
        agentCount: new Set(visibleSources.map(([, source]) => source.agent)).size,
        nodeCount: visibleSources.length,
        segmentCount: visibleSegments.length,
        beadCount: visibleSegments.length * (1 + LIVE_SIGNAL_LIMITS.trailPointsPerSegment),
        digest: digestLiveSignalSegments3D(visibleSegments),
      };
      updateInteriorPresentation();

      if (!visibleSources.length) {
        clear();
        return;
      }
      if (motionEnabled && documentVisible) {
        animationFrame = requestAnimationFrame(render);
      } else {
        const nextExpiry = Math.min(...visibleSources.map(([, source]) => source.until));
        timer = setTimeout(render, Math.max(32, nextExpiry - Date.now() + 32));
      }
    };
    wakeRenderer(Math.max(600, ...sources.map(([, source]) => source.until - startedAt + 180)));
    render();
    return () => {
      cancelAnimationFrame(animationFrame);
      if (timer) clearTimeout(timer);
    };
  }, [
    active,
    activeAgents,
    activeSources,
    activityRevision,
    documentVisible,
    graph,
    graphInstance,
    layerVisible,
    motionEnabled,
    nodeById,
    updateInteriorPresentation,
    liveRouteLinks,
    wakeRenderer,
  ]);

  useEffect(() => {
    const controls = graphInstance?.controls?.();
    if (!controls) return;
    const camera = graphInstance?.camera?.();
    if (camera) {
      camera.near = 0.05;
      camera.updateProjectionMatrix?.();
    }
    controls.enableDamping = motionEnabled;
    controls.dampingFactor = 0.075;
    controls.minDistance = CAMERA_MIN_DISTANCE;
    controls.maxDistance = 1350;
    // The wheel travels toward the pointer instead of converging, forever, on
    // one fixed point. With a stationary target every zoom approached the same
    // spot in the nucleus, so "further in" was never a direction you could pick
    // — measured: the target never moved once across a full dive.
    //
    // This was off because zoom-to-cursor used to feed the hover handler, which
    // rebuilt the focus subgraph and reframed the camera, which moved the node
    // under the cursor: the pointer/zoom feedback glitch. Hover has since been
    // visual-only — it cannot change focus or the camera — so the loop has no
    // source left, and the assertions below hold that shut.
    if ('zoomToCursor' in controls) controls.zoomToCursor = true;
    const renderNavigation = () => {
      updateInteriorPresentation();
      graphInstance?.resumeAnimation?.();
    };
    updateInteriorPresentation();
    controls.addEventListener?.('start', renderNavigation);
    controls.addEventListener?.('change', renderNavigation);
    return () => {
      controls.removeEventListener?.('start', renderNavigation);
      controls.removeEventListener?.('change', renderNavigation);
    };
  }, [graphInstance, motionEnabled, updateInteriorPresentation]);

  // ── flying, once you are inside ──────────────────────────────────────────
  // A wheel that dollies can only ever approach its orbit target, so "further
  // in" stops existing the moment you arrive: measured on the live graph, the
  // distance pinned at the floor and seventy-two more notches moved the camera
  // by exactly nothing, which is why the interior read as a frozen photograph.
  // Lowering the floor only moved the wall. Inside the shell the wheel instead
  // translates the camera along its view direction and carries the orbit pivot
  // with it, so there is no floor to reach and orbiting turns your head rather
  // than swinging you around a point on the far side of the brain.
  useEffect(() => {
    const fg = graphInstance;
    const canvas = fg?.renderer?.()?.domElement as HTMLCanvasElement | undefined;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const onWheel = (event: WheelEvent) => {
      const camera = fg?.camera?.();
      const controls = fg?.controls?.();
      if (!camera?.position || !controls?.target) return;
      // Outside the shell the normal dolly still applies, so you can aim at a
      // lobe and approach it. Flying back out through the shell hands it back —
      // but never with the pivot the flight left 45 units ahead in open space,
      // because dollying toward THAT is how you get stranded staring at nothing.
      // Re-aiming it at the brain is a user-initiated gesture, not the camera
      // moving on its own, so it does not touch the hover contract.
      if (camera.position.length() >= BRAIN_INTERIOR_RADIUS) {
        if (controls.target.length() >= BRAIN_INTERIOR_RADIUS) {
          controls.target.set(0, 0, 0);
          controls.update?.();
          wakeRenderer();
        }
        return;
      }
      // Capture phase on the host: OrbitControls listens on the canvas itself,
      // so stopping here is what keeps both handlers from acting on one notch.
      event.preventDefault();
      event.stopPropagation();
      const forward = camera.getWorldDirection(new Vector3());
      const magnitude = Math.min(18, Math.max(2, Math.abs(event.deltaY) * 0.06));
      camera.position.addScaledVector(forward, event.deltaY < 0 ? magnitude : -magnitude);
      controls.target.copy(camera.position).addScaledVector(forward, INTERIOR_PIVOT_DISTANCE);
      controls.update?.();
      updateInteriorPresentation();
      wakeRenderer();
    };
    host.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => host.removeEventListener('wheel', onWheel, { capture: true });
  }, [graphInstance, updateInteriorPresentation, wakeRenderer]);

  useEffect(() => {
    const canvas = graphInstance?.renderer?.()?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;
    const pointerDown = () => { pointerDownRef.current = true; };
    const pointerUp = () => {
      setTimeout(() => {
        if (!draggingIdRef.current) pointerDownRef.current = false;
      }, 0);
    };
    canvas.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('pointercancel', pointerUp, true);
    return () => {
      canvas.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('pointercancel', pointerUp, true);
    };
  }, [graphInstance]);

  useEffect(() => {
    if (cameraPreset === 'selected' || !graph.nodes.length) return;
    const transition = motionEnabled ? 700 : 0;
    setFraming((current) => ({ ...current, ready: false }));
    const timeout = setTimeout(() => fitCameraToViewportRef.current(transition), 90);
    return () => clearTimeout(timeout);
  }, [cameraPreset, graphInstance, motionEnabled]);

  useEffect(() => {
    if (!graphInstance || lastLayoutReset.current === layoutResetToken) return;
    lastLayoutReset.current = layoutResetToken;
    if (dragFrameRef.current != null) cancelAnimationFrame(dragFrameRef.current);
    if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current);
    dragFrameRef.current = null;
    settleFrameRef.current = null;
    relaxationRef.current = null;
    dragDeltaRef.current = { x: 0, y: 0, z: 0 };
    settleQuietRef.current = 0;
    for (const node of graph.nodes) {
      node.x = node.__targetX;
      node.y = node.__targetY;
      node.z = node.__targetZ;
      node.fx = node.__targetX;
      node.fy = node.__targetY;
      node.fz = node.__targetZ;
      node.vx = 0;
      node.vy = 0;
      node.vz = 0;
    }
    draggingIdRef.current = null;
    dragFieldRef.current = new Map();
    lastDragNeighborCount.current = 0;
    pointerDownRef.current = false;
    syncBatchPositions();
    graphInstance.refresh?.();
    const timer = setTimeout(() => fitCameraToViewport(motionEnabled ? 520 : 0), 40);
    return () => clearTimeout(timer);
  }, [fitCameraToViewport, graph.nodes, graphInstance, layoutResetToken, motionEnabled, syncBatchPositions]);

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
      // 3d-force-graph replaces DragControls when React updates its scene props.
      // Hold visual pulse state steady for the few milliseconds of a native drag;
      // live events remain in the shared map and are painted immediately after.
      if (draggingIdRef.current) return;
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
    const brain3d: Record<string, unknown> = {
        ambientParticlesEnabled,
        batchedLinkCount: batchedConnectome.links.length,
        batchedLinkDigest: batchedConnectome.digest,
        batchedNodeCount: batchedConnectome.nodeIndex.size,
        bloomRadius: BRAIN3D_SCENE.bloomRadius,
        bloomStrength: BRAIN3D_SCENE.bloomStrength,
        bloomThreshold: BRAIN3D_SCENE.bloomThreshold,
        brainInteriorRadius: BRAIN_INTERIOR_RADIUS,
        cameraMinDistance: CAMERA_MIN_DISTANCE,
        cameraPreset,
        corticalFieldDigest: CORTICAL_FIELD_DIGEST,
        corticalMeshVertexCount: CORTICAL_MESH.positions.length / 3,
        focusSize: focusIds?.size ?? 0,
        focusVisibleLinkCount,
        fogDensity: BRAIN3D_SCENE.fogDensity,
        framingReady: framing.ready,
        hoveredId: hovered?.id ?? null,
        layout: 'connectome',
        motion: motionEnabled,
        navigationEnabled: true,
        neuronMorphologyCount: morphology.neuronCount,
        nodeCoverageRatio: graph.nodes.length ? batchedConnectome.nodeIndex.size / graph.nodes.length : 1,
        visibleTractCoverageRatio: graph.nodes.length ? visibleTractNodeCount / graph.nodes.length : 1,
        nodeValueBuckets: graph.nodeValueBuckets,
        positionDigest,
        refreshTicking,
        selectedId: selected?.id ?? null,
        styleBuckets: graph.styleBuckets,
        sourceNodeCount: graph.nodes.length,
        topOccludedNodeCount: framing.topOccludedNodeCount,
        totalLinkCount: graph.links.length,
        interactiveNodeCount: renderGraph.nodes.length,
        visibleLinkTypeCounts: batchedConnectome.linkTypeCounts,
        visibleNodeRatio: framing.visibleNodeRatio,
        visibleLinkCount: renderGraph.links.length,
    };
    Object.defineProperty(brain3d, 'cameraDistance', {
      enumerable: true,
      get: () => {
        const camera = fgRef.current?.camera?.();
        const target = fgRef.current?.controls?.()?.target ?? { x: 0, y: 0, z: 0 };
        return camera?.position ? Math.hypot(camera.position.x - target.x, camera.position.y - target.y, camera.position.z - target.z) : -1;
      },
    });
    Object.defineProperty(brain3d, 'cameraNear', {
      enumerable: true,
      get: () => Number(fgRef.current?.camera?.()?.near ?? -1),
    });
    Object.defineProperty(brain3d, 'cameraPose', {
      enumerable: true,
      get: () => {
        const camera = fgRef.current?.camera?.();
        const target = fgRef.current?.controls?.()?.target;
        if (!camera?.position || !target) return null;
        return [camera.position.x, camera.position.y, camera.position.z, target.x, target.y, target.z];
      },
    });
    Object.defineProperty(brain3d, 'insideBrain', {
      enumerable: true,
      get: () => insideBrainRef.current,
    });
    Object.defineProperty(brain3d, 'liveSignalNodeCount', {
      enumerable: true,
      get: () => liveFlowStatsRef.current.nodeCount,
    });
    Object.defineProperty(brain3d, 'liveSignalAgentCount', {
      enumerable: true,
      get: () => liveFlowStatsRef.current.agentCount,
    });
    Object.defineProperty(brain3d, 'liveSignalSegmentCount', {
      enumerable: true,
      get: () => liveFlowStatsRef.current.segmentCount,
    });
    Object.defineProperty(brain3d, 'liveSignalBeadCount', {
      enumerable: true,
      get: () => liveFlowStatsRef.current.beadCount,
    });
    Object.defineProperty(brain3d, 'liveSignalDigest', {
      enumerable: true,
      get: () => liveFlowStatsRef.current.digest,
    });
    Object.defineProperty(brain3d, 'hoverTarget', {
      enumerable: true,
      get: () => {
        const fg = fgRef.current;
        const camera = fg?.camera?.();
        const canvas = fg?.renderer?.()?.domElement as HTMLCanvasElement | undefined;
        const target = renderGraph.nodes.find((node) => node.id === selected?.id)
          ?? renderGraph.nodes.find((node) => node.kind === 'root')
          ?? renderGraph.nodes[0];
        if (!camera || !canvas || !target) return null;
        const rect = canvas.getBoundingClientRect();
        const projected = new Vector3(target.x, target.y, target.z).project(camera);
        return {
          x: rect.left + (projected.x + 1) * rect.width / 2,
          y: rect.top + (1 - projected.y) * rect.height / 2,
          id: target.id,
        };
      },
    });
    Object.defineProperty(brain3d, 'draggingId', {
      enumerable: false,
      get: () => draggingIdRef.current,
    });
    Object.defineProperty(brain3d, 'lastDragNeighborCount', {
      enumerable: false,
      get: () => lastDragNeighborCount.current,
    });
    Object.defineProperty(brain3d, 'lastCollisionCount', {
      enumerable: false,
      get: () => lastCollisionCount.current,
    });
    Object.defineProperty(brain3d, 'collisionCountTotal', {
      enumerable: false,
      get: () => collisionCountTotal.current,
    });
    Object.defineProperty(brain3d, 'relaxingNodeCount', {
      enumerable: false,
      get: () => lastRelaxingNodeCount.current,
    });
    Object.defineProperty(brain3d, 'simulationRunning', {
      enumerable: false,
      get: () => Boolean(draggingIdRef.current || settleFrameRef.current != null),
    });
    Object.defineProperty(brain3d, 'nodePosition', {
      enumerable: false,
      value: (id: string) => {
        const node = nodeById.get(id);
        return node ? { x: node.x, y: node.y, z: node.z } : null;
      },
    });
    window.__asm = {
      ...(window.__asm ?? {}),
      brain3d,
    };
  }, [
    ambientParticlesEnabled,
    batchedConnectome,
    cameraPreset,
    focusIds,
    focusVisibleLinkCount,
    fgRef,
    framing,
    graph.links.length,
    graph.nodes.length,
    graph.nodeValueBuckets,
    graph.styleBuckets,
    hovered,
    motionEnabled,
    morphology.neuronCount,
    nodeById,
    positionDigest,
    refreshTicking,
    selected,
    renderGraph.links.length,
    renderGraph.nodes.length,
  ]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    wakeRenderer(selected ? 1100 : hovered ? 260 : 180);
    fg.refresh?.();
  }, [fgRef, hovered, renderGraph.links.length, selected, wakeRenderer]);

  useEffect(() => () => {
    if (framingTimer.current) clearTimeout(framingTimer.current);
    for (const material of spriteMaterials.current.values()) material.dispose();
    spriteMaterials.current.clear();
    if (window.__asm) delete window.__asm.brain3d;
  }, []);

  const isActive = useCallback((id: string) => activeIds.has(id), [activeIds]);
  const isFocused = useCallback((id: string) => focusIds?.has(id) ?? false, [focusIds]);

  const nodeObject = useCallback((node: BrainNode3D) => {
    const active = isActive(node.id);
    const picked = selected?.id === node.id;
    const near = hovered?.id === node.id || isFocused(node.id);
    const dim = Boolean(focusIds) && !near && !picked && !active;
    const color = active ? '#f3d7a4'
      : picked ? '#f2fbf7'
        : near ? '#a9e0dc'
          : node.layer === 'asm' ? '#a7cfca'
          : node.kind === 'root' || node.kind === 'dir' ? '#94aba9'
            : '#73908f';
    const opacity = dim ? 0.06
      : active || picked ? 0.96
        : near ? 0.82
          : node.layer === 'asm' ? 0.62
            : node.kind === 'root' ? 0.72
              : node.kind === 'dir' ? 0.56
                : 0.34;
    const key = `${color}:${opacity}`;
    let material = spriteMaterials.current.get(key);
    if (!material) {
      material = new SpriteMaterial({
        map: getPointTexture(),
        color,
        opacity,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      spriteMaterials.current.set(key, material);
    }
    const sprite = new Sprite(material);
    const size = active || picked ? 13.2
      : near ? 10.2
        : node.layer === 'asm' && node.kind === 'root' ? 14
          : node.kind === 'root' ? 10.8
            : node.kind === 'dir' ? 8.4
              : node.kind === 'page' ? 6.8
                : 6.2;
    sprite.scale.set(size, size, 1);
    return sprite;
  }, [focusIds, hovered, isActive, isFocused, selected]);

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

  const linkIsDragged = useCallback((link: BrainLink3D) => {
    const draggingId = draggingIdRef.current;
    const dragField = dragFieldRef.current;
    if (!draggingId) return false;
    const source = linkEndpointId(link.source);
    const target = linkEndpointId(link.target);
    return (source === draggingId && dragField.has(target))
      || (target === draggingId && dragField.has(source));
  }, []);

  const cancelPhysicsFrames = useCallback(() => {
    if (dragFrameRef.current != null) cancelAnimationFrame(dragFrameRef.current);
    if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current);
    dragFrameRef.current = null;
    settleFrameRef.current = null;
  }, []);

  const solveRelaxation = useCallback((iterations: number, temperature: number) => {
    const state = relaxationRef.current;
    if (!state) return null;
    const delta = dragDeltaRef.current;
    const movedByPointer = Boolean(delta.x || delta.y || delta.z);
    if (delta.x || delta.y || delta.z) {
      applyDragDelta(nodeById, state.weights, delta);
      dragDeltaRef.current = { x: 0, y: 0, z: 0 };
    }
    const result = stepDragRelaxation(
      state,
      physicsNodeById,
      graph.neighbors,
      { iterations, temperature },
    );
    const changedIds = movedByPointer ? new Set(state.weights.keys()) : new Set(result.movedIds);
    changedIds.add(state.rootId);
    for (const id of changedIds) {
      const moved = nodeById.get(id);
      if (!moved) continue;
      pinAtCurrentPosition(moved, 3);
      positionCache.set(id, { x: moved.x, y: moved.y, z: moved.z });
    }
    dragFieldRef.current = state.weights;
    lastCollisionCount.current = result.collisions;
    collisionCountTotal.current += result.collisions;
    lastRelaxingNodeCount.current = result.activeCount;
    lastDragNeighborCount.current = Math.max(0, result.activeCount - 1);
    syncBatchPositions(changedIds);
    syncMorphologyPositions(changedIds);
    wakeRenderer(520);
    return result;
  }, [graph.neighbors, nodeById, physicsNodeById, positionCache, syncBatchPositions, syncMorphologyPositions, wakeRenderer]);

  const finishRelaxation = useCallback(() => {
    cancelPhysicsFrames();
    const state = relaxationRef.current;
    if (state) {
      for (const id of state.weights.keys()) {
        const moved = nodeById.get(id);
        if (!moved) continue;
        pinAtCurrentPosition(moved, 3);
        positionCache.set(id, { x: moved.x, y: moved.y, z: moved.z });
      }
      syncBatchPositions(state.weights.keys());
      syncMorphologyPositions(state.weights.keys());
    }
    relaxationRef.current = null;
    dragDeltaRef.current = { x: 0, y: 0, z: 0 };
    settleQuietRef.current = 0;
    draggingIdRef.current = null;
    dragFieldRef.current = new Map();
    pointerDownRef.current = false;
    fgRef.current?.refresh?.();
    wakeRenderer(560);
  }, [cancelPhysicsFrames, fgRef, nodeById, positionCache, syncBatchPositions, syncMorphologyPositions, wakeRenderer]);

  const handleNodeDrag = useCallback((node: BrainNode3D, translate: { x: number; y: number; z: number }) => {
    if (draggingIdRef.current !== node.id || !relaxationRef.current) {
      // A first drag has nothing to finish. Refreshing here rebuilds
      // DragControls while its pointer transaction is still active.
      if (relaxationRef.current) finishRelaxation();
      const rootX = node.x;
      const rootY = node.y;
      const rootZ = node.z;
      const influence = buildDragInfluence(node.id, graph.neighbors, {
        maxNodes: 144,
        distanceFor: (id) => {
          const candidate = nodeById.get(id);
          return candidate
            ? Math.hypot(candidate.x - rootX, candidate.y - rootY, candidate.z - rootZ)
            : Number.POSITIVE_INFINITY;
        },
      });
      const state = createDragRelaxation(
        node.id,
        physicsNodeById,
        influence,
        (candidate) => collisionRadius3D(candidate as BrainNode3D),
        {
          dimensions: 3,
          maxNodes: 192,
          collisionPadding: 0.28,
          collisionStrength: 0.7,
          linkStrength: 0.072,
          anchorStrength: 0.0065,
          maxStep: 2.3,
          rootAnchor: {
            x: rootX - translate.x,
            y: rootY - translate.y,
            z: rootZ - translate.z,
          },
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
    }
    dragDeltaRef.current.x += translate.x;
    dragDeltaRef.current.y += translate.y;
    dragDeltaRef.current.z += translate.z;
    if (dragFrameRef.current == null) {
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = null;
        solveRelaxation(2, 1);
      });
    }
  }, [finishRelaxation, graph.neighbors, nodeById, physicsNodeById, relaxationWorld, solveRelaxation]);

  const handleNodeDragEnd = useCallback((node: BrainNode3D) => {
    if (dragFrameRef.current != null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    pinAtCurrentPosition(node, 3);
    positionCache.set(node.id, { x: node.x, y: node.y, z: node.z });
    const runtimeNode = node as BrainNode3D & { __initialPos?: { x: number; y: number; z: number } };
    const duplicateDragGuard = { x: node.x, y: node.y, z: node.z };
    // 3d-force-graph can briefly retain two DragControls listeners when the live
    // scene updates during a drag. Its first listener deletes __initialPos; the
    // second then reads `.x` from undefined. Re-seed a zero-delta end position
    // until every listener from this pointer transaction has unwound.
    runtimeNode.__initialPos = duplicateDragGuard;
    const graphController = fgRef.current;
    const orbitControls = graphController?.controls?.() as {
      _pointers?: number[];
      _pointerPositions?: Record<number, OrbitPointerPosition>;
      enabled?: boolean;
    } | undefined;
    // 3d-force-graph emits a synthetic touch pointerup after a node drag.
    // OrbitControls may carry a stale pointer whose position was already
    // removed by the real mouse event. Seed a disposable, internally coherent
    // two-pointer ledger: the synthetic id 0 is removed, the sentinel remains
    // valid for OrbitControls' one-pointer correction branch, then both vanish
    // on the next task.
    if (orbitControls?._pointers && orbitControls._pointerPositions) {
      orbitControls._pointers.splice(0, orbitControls._pointers.length, 0, -1);
      orbitControls._pointerPositions = {
        0: orbitPointerPosition(),
        [-1]: orbitPointerPosition(),
      };
    }
    // Three's DragControls is still unwinding its dragend listener here. A
    // synchronous refresh can replace the controls and make a second listener
    // read an already-cleared __initialPos. Clear the interaction on the next
    // task, after the native dragend transaction is complete. Only then start
    // the bounded collision settle so DragControls cannot be replaced mid-end.
    setTimeout(() => {
      if (runtimeNode.__initialPos === duplicateDragGuard) delete runtimeNode.__initialPos;
      if (orbitControls?._pointers) orbitControls._pointers.length = 0;
      if (orbitControls?._pointerPositions) orbitControls._pointerPositions = {};
      if (orbitControls) orbitControls.enabled = true;
      if (draggingIdRef.current !== node.id || !relaxationRef.current) return;
      // Apply the final pointer delta only after DragControls and OrbitControls
      // have completely unwound this pointer transaction.
      solveRelaxation(3, 1);
      if (!motionEnabled) {
        solveRelaxation(5, 0.42);
        finishRelaxation();
        return;
      }
      const settle = () => {
        settleStepRef.current += 1;
        const progress = settleStepRef.current / 18;
        const result = solveRelaxation(2, Math.max(0.2, 1 - progress * 0.86));
        const quiet = Boolean(result && result.maxDisplacement < 0.025 && result.maxOverlap < 0.08);
        settleQuietRef.current = quiet ? settleQuietRef.current + 1 : 0;
        if (settleStepRef.current < 18 && settleQuietRef.current < 3 && relaxationRef.current) {
          settleFrameRef.current = requestAnimationFrame(settle);
        } else {
          finishRelaxation();
        }
      };
      settleFrameRef.current = requestAnimationFrame(settle);
    }, 0);
  }, [finishRelaxation, motionEnabled, positionCache, solveRelaxation]);

  const nodeLabel = useCallback((node: BrainNode3D) => {
    const description = node.meta?.description
      ? `<div class="tip-desc">${escapeHtml(node.meta.description)}</div>`
      : '';
    return `<div class="tip"><div class="tip-title">${escapeHtml(node.label)}</div><div class="tip-path">${escapeHtml(node.path || '')}</div>${description}</div>`;
  }, []);

  return (
    <ForceGraph3D
      ref={attachGraph as any}
      graphData={renderGraph}
      backgroundColor={BRAIN3D_SCENE.fogColor}
      showNavInfo={false}
      enableNavigationControls={true}
      enableNodeDrag={true}
      controlType="orbit"
      nodeThreeObject={nodeObject}
      nodeLabel={nodeLabel}
      nodeVisibility={nodeVisibility}
      linkVisibility={linkVisibility}
      linkColor={(link: BrainLink3D) => {
        if (linkIsDragged(link)) return 'rgba(220,247,241,0.94)';
        if (linkIsActive(link)) return 'rgba(243,215,164,0.9)';
        if (linkIsFocused(link)) return 'rgba(169,224,220,0.72)';
        if (link.type === 'xlayer') return 'rgba(151,189,187,0.16)';
        if (link.type === 'link') return 'rgba(126,169,168,0.11)';
        if (link.type === 'code') return 'rgba(113,148,147,0.075)';
        return 'rgba(105,130,130,0.045)';
      }}
      linkWidth={(link: BrainLink3D) => linkIsDragged(link) ? 1.15 : linkIsActive(link) ? 1 : linkIsFocused(link) ? 0.66 : link.type === 'xlayer' ? 0.34 : 0.17}
      linkOpacity={0.46}
      linkDirectionalParticles={(link: BrainLink3D) => {
        if (shouldIdleRenderer || !motionEnabled || !documentVisible || !linkVisibility(link)) return 0;
        if (linkIsActive(link)) return 2;
        const source = linkEndpointId(link.source);
        const target = linkEndpointId(link.target);
        return selected && (source === selected.id || target === selected.id) ? 2 : 0;
      }}
      linkDirectionalParticleWidth={0.9}
      linkDirectionalParticleSpeed={0.005}
      linkDirectionalParticleColor={() => '#d7e6df'}
      linkCurvature={(link: BrainLink3D) => link.type === 'xlayer' ? 0.24 : link.type === 'link' ? 0.12 : link.type === 'code' ? 0.04 : 0}
      onNodeClick={(node: BrainNode3D) => { wakeRenderer(1100); onSelect(node); }}
      onNodeHover={(node: BrainNode3D | null) => { if (pointerDownRef.current || draggingIdRef.current) return; if (node) wakeRenderer(260); onHover(node); }}
      onNodeDrag={handleNodeDrag as any}
      onNodeDragEnd={handleNodeDragEnd as any}
      onBackgroundClick={() => { wakeRenderer(180); onHover(null); onSelect(null); }}
      warmupTicks={1}
      cooldownTicks={1}
      cooldownTime={0}
    />
  );
});
