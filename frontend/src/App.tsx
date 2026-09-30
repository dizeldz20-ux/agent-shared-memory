import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain } from './Brain';
import { Brain2D, type Layout2D } from './Brain2D';
import { Feed } from './Feed';
import { useLive } from './useLive';
import { seedBrainPositions } from './brainShape';
import { CAMERA_PRESETS_3D, LIVE_SIGNAL_DURATION_MS, type CameraPreset3D } from './brain3d';
import {
  agentLane,
  canonicalLiveEvent,
  isFileAccessEvent,
  mergeFileEvents,
  pruneExpiredLiveState,
} from './liveActivity';
import { LiveDeck } from './LiveDeck';
import { type AgentSighting, pruneSightings, recordSightings } from './liveRoster';
import type { BrainData, BrainNode, LiveActivitySource, LiveEvent } from './types';
import { LAYER_COLORS, LAYER_NAMES } from './types';

const EPHEMERAL_TTL = 60000;
const EPHEMERAL_FLUSH_MS = 550;
export const STATIC_PREVIEW = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_STATIC_PREVIEW === '1' || location.port === '5931';
const assetUrl = (name: string) => new URL(`demo/${name}`, document.baseURI).toString();
type ViewId = '3d' | 'network' | 'rings';

export default function App() {
  const [data, setData] = useState<BrainData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retryLoad, setRetryLoad] = useState(0);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [selected, setSelected] = useState<BrainNode | null>(null);
  const [hovered, setHovered] = useState<BrainNode | null>(null);
  const [follow, setFollow] = useState(true);
  const [wsUp, setWsUp] = useState(false);
  const [sessionFilter, setSessionFilter] = useState('');
  const [layerVisible, setLayerVisible] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [mode, setMode] = useState<'3d' | '2d'>(
    () => (new URLSearchParams(location.search).get('mode') === '2d' ? '2d' : '3d'));
  const [layout2d, setLayout2d] = useState<Layout2D>(
    () => (new URLSearchParams(location.search).get('layout') === 'rings' ? 'rings' : 'graph'));
  const [layersOpen, setLayersOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [liveTraceCollapsed, setLiveTraceCollapsed] = useState(() => {
    try { return localStorage.getItem('asm-live-trace-collapsed') === '1'; }
    catch { return false; }
  });
  const [cameraPreset, setCameraPreset] = useState<CameraPreset3D>('whole');
  const [layoutResetToken, setLayoutResetToken] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [activityRevision, setActivityRevision] = useState(0);
  const [rosterRevision, setRosterRevision] = useState(0);
  const [graphGeneratedAt, setGraphGeneratedAt] = useState<string | null>(null);

  const fgRef = useRef<any>(null);
  const layoutPositionsRef = useRef({
    connectome: new Map<string, { x: number; y: number; z: number }>(),
    graph: new Map<string, { x: number; y: number }>(),
    rings: new Map<string, { x: number; y: number }>(),
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const activeRef = useRef(new Map<string, number>());
  const activeAgentsRef = useRef(new Map<string, string>());
  const activeSourcesRef = useRef(new Map<string, LiveActivitySource>());
  const sightingsRef = useRef(new Map<string, AgentSighting>());
  const dataRef = useRef<BrainData | null>(null);
  dataRef.current = data;
  const nodeIdsRef = useRef(new Set<string>());
  const nodeByIdRef = useRef(new Map<string, BrainNode>());
  const queuedEphemeralNodes = useRef(new Map<string, BrainNode>());
  const queuedEphemeralLinks = useRef(new Map<string, BrainData['links'][number]>());
  const ephemeralFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;
  const ephemeralBorn = useRef(new Map<string, number>());

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    try { localStorage.setItem('asm-live-trace-collapsed', liveTraceCollapsed ? '1' : '0'); }
    catch { /* private browsing can disable storage; collapsing still works in-memory */ }
  }, [liveTraceCollapsed]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      if (pruneExpiredLiveState(
        now, activeRef.current, activeAgentsRef.current, activeSourcesRef.current,
      )) setActivityRevision((revision) => revision + 1);
      // The deck ages its own rows every second off one clock; this only keeps
      // the sighting map from holding lanes whose window closed while it was quiet.
      if (pruneSightings(sightingsRef.current, now)) setRosterRevision((revision) => revision + 1);
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    fetch(STATIC_PREVIEW ? assetUrl('brain.json') : '/api/graph')
      .then((response) => {
        if (!response.ok) throw new Error(`graph ${response.status}`);
        return response.json();
      })
      .then((g) => {
        if (cancelled) return;
        seedBrainPositions(g.nodes);
        setGraphGeneratedAt(typeof g.generatedAt === 'string' ? g.generatedAt : null);
        setData({ nodes: g.nodes, links: g.links });
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'graph load failed');
      });
    return () => { cancelled = true; };
  }, [retryLoad]);

  useEffect(() => {
    nodeIdsRef.current = new Set((data?.nodes ?? []).map((node) => node.id));
    nodeByIdRef.current = new Map((data?.nodes ?? []).map((node) => [node.id, node]));
  }, [data]);

  useEffect(() => () => {
    if (ephemeralFlushTimer.current) clearTimeout(ephemeralFlushTimer.current);
  }, []);

  const fly = useCallback((nodeId: string) => {
    const d = dataRef.current;
    const fg = fgRef.current;
    const n = (fg?.graphData?.().nodes ?? []).find((x: BrainNode) => x.id === nodeId)
      ?? d?.nodes.find((x) => x.id === nodeId);
    if (!n || !fg || n.x == null) return;
    if (modeRef.current === '2d') {
      fg.centerAt(n.x, n.y, 800);
      fg.zoom(3.2, 800);
      return;
    }
    const dist = Math.hypot(n.x!, n.y!, n.z!) || 1;
    const k = 1 + 90 / dist;
    setCameraPreset('selected');
    fg.cameraPosition({ x: n.x! * k, y: n.y! * k, z: n.z! * k }, n, 900);
  }, []);

  const applyCameraPreset = useCallback((preset: keyof typeof CAMERA_PRESETS_3D) => {
    setCameraPreset(preset);
    if (modeRef.current !== '3d') return;
    const camera = CAMERA_PRESETS_3D[preset];
    fgRef.current?.cameraPosition(camera.position, camera.lookAt, 700);
  }, []);

  const zoomCamera3D = useCallback((direction: 1 | -1) => {
    if (modeRef.current !== '3d') return;
    const fg = fgRef.current;
    const canvas = fg?.renderer?.()?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    fg.resumeAnimation?.();
    // The buttons are the wheel. Scaling the camera toward its orbit target here
    // instead would collapse it onto the pivot and freeze the interior again —
    // the exact defect the wheel stopped having — and would leave two different
    // answers on one screen for what "zoom in" means.
    for (let notch = 0; notch < 3; notch++) {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: direction * 120,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      }));
    }
  }, []);

  const zoomCamera2D = useCallback((factor: number) => {
    if (modeRef.current !== '2d') return;
    const fg = fgRef.current;
    const current = Number(fg?.zoom?.()) || 1;
    fg?.zoom?.(Math.max(0.2, Math.min(18, current * factor)), reduceMotion ? 0 : 220);
  }, [reduceMotion]);

  const resetInteractiveField = useCallback(() => {
    setHovered(null);
    setSelected(null);
    if (modeRef.current === '3d') {
      layoutPositionsRef.current.connectome.clear();
      setCameraPreset('whole');
    } else {
      layoutPositionsRef.current[layout2d].clear();
    }
    setLayoutResetToken((token) => token + 1);
  }, [layout2d]);

  const handleEvents = useCallback((evs: LiveEvent[]) => {
    const now = Date.now();
    const newEphemerals: BrainNode[] = [];
    const newLinks: BrainData['links'] = [];
    const d = dataRef.current;
    pruneExpiredLiveState(now, activeRef.current, activeAgentsRef.current, activeSourcesRef.current);
    const normalizedEvents = evs.map((event) => canonicalLiveEvent(event, nodeByIdRef.current));
    // Presence pings and file access both prove an agent is alive, so the roster
    // is fed by every event. Nothing else on screen may answer "how many agents".
    if (recordSightings(normalizedEvents, sightingsRef.current, now)) {
      setRosterRevision((revision) => revision + 1);
    }

    // Presence and command/build telemetry still updates the agent heartbeat,
    // but only verified file access is allowed to occupy the visual trace or
    // trigger an expensive graph update.
    const fileEvents = normalizedEvents.filter((event) => isFileAccessEvent(event, nodeByIdRef.current));
    for (const e of fileEvents) {
      const age = now - e.ts * 1000;
      if (followRef.current && age >= -30000 && age <= 15000) {
        const lane = agentLane(e.agent);
        const until = now + LIVE_SIGNAL_DURATION_MS;
        activeRef.current.set(e.node_id, Math.max(until, activeRef.current.get(e.node_id) ?? 0));
        activeAgentsRef.current.set(e.node_id, lane);
        activeSourcesRef.current.set(`${lane}\u0000${e.node_id}`, { nodeId: e.node_id, agent: lane, until });
      }
      if (!e.matched && d && !nodeIdsRef.current.has(e.node_id) &&
          !queuedEphemeralNodes.current.has(e.node_id) &&
          !newEphemerals.some((n) => n.id === e.node_id) && age <= EPHEMERAL_TTL) {
        const projectId = e.node_id.split(':')[1] ?? 'misc';
        const projectLabel = projectId.replace(/-[a-f0-9]{8}$/i, '');
        const anchorId = `ephemeral:${projectId}`;
        if (!nodeIdsRef.current.has(anchorId) && !queuedEphemeralNodes.current.has(anchorId) &&
            !newEphemerals.some((n) => n.id === anchorId)) {
          newEphemerals.push({ id: anchorId, label: projectLabel, layer: 'ephemeral', kind: 'root', path: '', abs: '' });
        }
        newEphemerals.push({ id: e.node_id, label: e.label, layer: 'ephemeral', kind: 'ephemeral', path: e.path, abs: e.path });
        newLinks.push({ source: anchorId, target: e.node_id, type: 'contains' });
        ephemeralBorn.current.set(e.node_id, now);
      } else if (!e.matched) {
        ephemeralBorn.current.set(e.node_id, now); // refresh TTL
      }
    }
    if (newEphemerals.length && d) {
      for (const node of newEphemerals) queuedEphemeralNodes.current.set(node.id, node);
      for (const link of newLinks) {
        const source = typeof link.source === 'object' ? link.source.id : link.source;
        const target = typeof link.target === 'object' ? link.target.id : link.target;
        queuedEphemeralLinks.current.set(`${source}>${target}:${link.type ?? 'contains'}`, link);
      }
      // Let the activity row and matched-node pulse paint first. Folding an
      // unmapped file into the 20k-node atlas is deliberately deferred and
      // coalesced, so a burst of tool calls causes one structural render rather
      // than blocking the live trace once per file.
      if (!ephemeralFlushTimer.current) {
        ephemeralFlushTimer.current = setTimeout(() => {
          ephemeralFlushTimer.current = null;
          const pendingNodes = [...queuedEphemeralNodes.current.values()];
          const pendingLinks = [...queuedEphemeralLinks.current.values()];
          queuedEphemeralNodes.current.clear();
          queuedEphemeralLinks.current.clear();
          setData((current) => {
            if (!current || !pendingNodes.length) return current;
            const known = new Set(current.nodes.map((node) => node.id));
            const nodes = pendingNodes.filter((node) => !known.has(node.id));
            if (!nodes.length) return current;
            for (const node of nodes) known.add(node.id);
            nodeIdsRef.current = known;
            const existingLinks = new Set(current.links.map((link) => {
              const source = typeof link.source === 'object' ? link.source.id : link.source;
              const target = typeof link.target === 'object' ? link.target.id : link.target;
              return `${source}>${target}:${link.type ?? 'contains'}`;
            }));
            const links = pendingLinks.filter((link) => {
              const source = typeof link.source === 'object' ? link.source.id : link.source;
              const target = typeof link.target === 'object' ? link.target.id : link.target;
              return !existingLinks.has(`${source}>${target}:${link.type ?? 'contains'}`);
            });
            return { nodes: [...current.nodes, ...nodes], links: [...current.links, ...links] };
          });
        }, EPHEMERAL_FLUSH_MS);
      }
    }
    if (fileEvents.length) {
      setEvents((prev) => mergeFileEvents(fileEvents, prev));
    }
    // Live tracking is an immediate visual signal only. It must never select a
    // node, rebuild a focus subgraph, or move either camera.
    if (fileEvents.length) setActivityRevision((revision) => revision + 1);
  }, []);

  // Connect only after the graph indexes exist. The server immediately sends a
  // recent snapshot, and consuming it before graph load would lose unmatched
  // source neurons/routes even though their rows reached the activity feed.
  useLive(handleEvents, setWsUp, !STATIC_PREVIEW && Boolean(data));

  useEffect(() => {
    if (!STATIC_PREVIEW || !data) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    fetch(assetUrl('events.json'))
      .then((response) => {
        if (!response.ok) throw new Error(`demo events ${response.status}`);
        return response.json();
      })
      .then((demoEvents: LiveEvent[]) => {
        if (cancelled || !demoEvents.length) return;
        let index = 0;
        timer = setInterval(() => {
          const template = demoEvents[index++ % demoEvents.length];
          handleEvents([{ ...template, ts: Date.now() / 1000 }]);
        }, 1800);
      })
      .catch(() => {});
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [data, handleEvents]);

  // GC expired ephemeral nodes
  useEffect(() => {
    const t = setInterval(() => {
      const d = dataRef.current;
      if (!d) return;
      const now = Date.now();
      pruneExpiredLiveState(now, activeRef.current, activeAgentsRef.current, activeSourcesRef.current);
      const expired = new Set<string>();
      for (const [id, born] of ephemeralBorn.current) {
        if (now - born > EPHEMERAL_TTL && (activeRef.current.get(id) ?? 0) <= now) expired.add(id);
      }
      if (!expired.size) return;
      for (const id of expired) ephemeralBorn.current.delete(id);
      const liveEph = new Set(
        d.nodes
          .filter((n) => n.kind === 'ephemeral' && !expired.has(n.id))
          .map((n) => `ephemeral:${n.id.split(':')[1]}`));
      setData({
        nodes: d.nodes.filter((n) =>
          !expired.has(n.id) && !(n.layer === 'ephemeral' && n.kind === 'root' && !liveEph.has(n.id))),
        links: d.links.filter((l) => {
          const s = typeof l.source === 'object' ? (l.source as BrainNode).id : (l.source as string);
          const t2 = typeof l.target === 'object' ? (l.target as BrainNode).id : (l.target as string);
          return !expired.has(s) && !expired.has(t2);
        }),
      });
    }, 30000);
    return () => clearInterval(t);
  }, []);

  const sessions = useMemo(
    () => [...new Set(events.map((e) => e.cwd).filter(Boolean))], [events]);

  const layerCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of data?.nodes ?? []) c[n.layer] = (c[n.layer] ?? 0) + 1;
    return c;
  }, [data]);

  const deckGraph = useMemo(() => ({
    nodes: data?.nodes.length ?? 0,
    links: data?.links.length ?? 0,
    knowledge: data?.nodes.filter((node) => node.kind === 'page').length ?? 0,
    generatedAt: graphGeneratedAt,
  }), [data, graphGeneratedAt]);

  const neighbors = useMemo(() => {
    if (!selected || !data) return [];
    const out: BrainNode[] = [];
    for (const l of data.links) {
      const s = typeof l.source === 'object' ? (l.source as BrainNode) : data.nodes.find((n) => n.id === l.source);
      const t = typeof l.target === 'object' ? (l.target as BrainNode) : data.nodes.find((n) => n.id === l.target);
      if (s?.id === selected.id && t) out.push(t);
      else if (t?.id === selected.id && s) out.push(s);
      if (out.length >= 12) break;
    }
    return out;
  }, [selected, data]);

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];
    return data.nodes.filter(
      (node) => node.label.toLowerCase().includes(q)
        || node.path.toLowerCase().includes(q)
        || node.meta?.description?.toLowerCase().includes(q),
    ).slice(0, 8);
  }, [data, query]);

  const selectSearchResult = useCallback((node: BrainNode) => {
    setSelected(node);
    setSearchOpen(false);
    setActiveSuggestion(-1);
    fly(node.id);
  }, [fly]);

  const search = useCallback(() => {
    const node = searchMatches[Math.max(activeSuggestion, 0)];
    if (node) selectSearchResult(node);
  }, [activeSuggestion, searchMatches, selectSearchResult]);

  const currentView: ViewId = mode === '3d' ? '3d' : layout2d === 'rings' ? 'rings' : 'network';
  const setView = (view: ViewId) => {
    setHovered(null);
    if (view === '3d') {
      setMode('3d');
      setCameraPreset('whole');
    }
    else {
      setMode('2d');
      setLayout2d(view === 'rings' ? 'rings' : 'graph');
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const editing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.isContentEditable;
      if (event.key === '/' && !editing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') {
        setLayersOpen(false);
        setActivityOpen(false);
        setSearchOpen(false);
        setSelected(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!data) return (
    <div className="loading" dir="rtl">
      {loadError ? (
        <>
          <div>טעינת המוח נכשלה: {loadError}</div>
          <button onClick={() => setRetryLoad((value) => value + 1)}>נסה שוב</button>
        </>
      ) : 'טוען את המוח…'}
    </div>
  );

  return (
    <div
      className="app"
      data-testid="asm-app"
      data-preview={STATIC_PREVIEW ? 'true' : 'false'}
      data-view={currentView}
      data-motion={reduceMotion ? 'reduced' : 'full'}
      dir="rtl"
    >
      {mode === '3d' ? (
        <Brain data={data} active={activeRef.current} activeAgents={activeAgentsRef.current} activeSources={activeSourcesRef.current} layerVisible={layerVisible}
               selected={selected} hovered={hovered} onSelect={setSelected} onHover={setHovered}
               motionEnabled={!reduceMotion} cameraPreset={cameraPreset} layoutResetToken={layoutResetToken}
               activityRevision={activityRevision} fgRef={fgRef} positionCache={layoutPositionsRef.current.connectome} />
      ) : (
        <Brain2D data={data} active={activeRef.current} activeAgents={activeAgentsRef.current} activeSources={activeSourcesRef.current} layerVisible={layerVisible}
                 selected={selected} hovered={hovered} onSelect={setSelected} onHover={setHovered} fgRef={fgRef}
                 layout={layout2d} motionEnabled={!reduceMotion} layoutResetToken={layoutResetToken}
                 activityRevision={activityRevision} positionCache={layoutPositionsRef.current[layout2d]} />
      )}

      <header className="instrument-header">
        <div className="instrument-brand">
          <div className="brand-mark" aria-hidden="true"><i /><i /><i /></div>
          <div className="brand-copy">
            <strong>ASM</strong>
            <span>AGENT SHARED MEMORY</span>
          </div>
          <span
            data-testid="connection-status"
            className={`connection-tag ${STATIC_PREVIEW ? 'demo' : wsUp ? 'live' : 'offline'}`}
          >
            {STATIC_PREVIEW ? 'SIMULATION' : wsUp ? 'SYNCED' : 'OFFLINE'}
          </span>
        </div>

        <div className="view-tabs" role="tablist" aria-label="תצוגת המוח" data-testid="view-tabs">
          {([
            ['3d', 'CONNECTOME'],
            ['network', 'MAP'],
            ['rings', 'CORTEX'],
          ] as const).map(([view, label]) => (
            <button
              key={view}
              type="button"
              role="tab"
              data-testid={`view-${view}`}
              aria-selected={currentView === view}
              className={currentView === view ? 'view-tab active' : 'view-tab'}
              onClick={() => setView(view)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="instrument-actions">
          <div className="search-control">
            <label className="sr-only" htmlFor="node-search-input">חיפוש במוח</label>
            <input
              id="node-search-input"
              ref={searchRef}
              data-testid="search-input"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={searchOpen && searchMatches.length > 0}
              aria-controls="node-search-results"
              aria-activedescendant={searchOpen && activeSuggestion >= 0 ? `node-option-${activeSuggestion}` : undefined}
              value={query}
              placeholder="חיפוש בזיכרון"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveSuggestion(-1);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(searchMatches.length > 0)}
              onBlur={() => setSearchOpen(false)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && searchMatches.length) {
                  event.preventDefault();
                  setSearchOpen(true);
                  setActiveSuggestion((index) => (index + 1) % searchMatches.length);
                } else if (event.key === 'ArrowUp' && searchMatches.length) {
                  event.preventDefault();
                  setSearchOpen(true);
                  setActiveSuggestion((index) => (index <= 0 ? searchMatches.length - 1 : index - 1));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  search();
                } else if (event.key === 'Escape') {
                  setSearchOpen(false);
                }
              }}
            />
            <kbd aria-hidden="true">/</kbd>
            {searchOpen && searchMatches.length ? (
              <div id="node-search-results" className="search-results" role="listbox" aria-label="תוצאות חיפוש במוח">
                {searchMatches.map((node, index) => (
                  <button
                    key={node.id}
                    id={`node-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={activeSuggestion === index}
                    className="search-option"
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectSearchResult(node)}
                  >
                    <span>{node.label}</span>
                    <small>{LAYER_NAMES[node.layer] ?? node.layer}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="layer-control">
            <button
              type="button"
              className="instrument-button"
              data-testid="layer-trigger"
              aria-expanded={layersOpen}
              aria-controls="layer-menu"
              onClick={() => setLayersOpen((open) => !open)}
            >
              שכבות מידע
            </button>
            {layersOpen ? (
              <div id="layer-menu" className="layer-menu" data-testid="layer-menu" role="group" aria-label="שכבות מוצגות">
                <div className="popover-title">שכבות מוצגות</div>
                {Object.keys(layerCounts).sort((a, b) => (layerCounts[b] ?? 0) - (layerCounts[a] ?? 0)).map((layer) => (
                  <label className="layer-option" key={layer}>
                    <input
                      type="checkbox"
                      checked={layerVisible[layer] !== false}
                      onChange={(event) => setLayerVisible((visible) => ({ ...visible, [layer]: event.target.checked }))}
                    />
                    <span className="layer-swatch" style={{ backgroundColor: LAYER_COLORS[layer] }} aria-hidden="true" />
                    <span>{LAYER_NAMES[layer]}</span>
                    <span className="layer-count">{layerCounts[layer] ?? 0}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>

          <label className="follow-control">
            <input
              type="checkbox"
              data-testid="follow-toggle"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
              aria-label="הצגת אות פעילות חי ללא מיקוד מצלמה"
            />
            <span className="toggle-track" aria-hidden="true"><span /></span>
            <span>אות חי</span>
          </label>

          <button
            type="button"
            className="instrument-button activity-button"
            data-testid="activity-trigger"
            aria-expanded={activityOpen}
            aria-controls="activity-panel"
            onClick={() => setActivityOpen((open) => !open)}
          >
            קבצים חיים
            {events.length ? <span className="activity-count">{Math.min(events.length, 99)}</span> : null}
          </button>
        </div>
      </header>

      <section className="brain-intro" aria-label="תקציר ASM">
        <span className="eyebrow">UNIFIED COGNITIVE FIELD · LOCAL / OFFLINE</span>
        <h1>זיכרון אחד.<br />לכל הסוכנים.</h1>
        <p>קוד, החלטות וידע אנושי מחוברים למפה אחת — Claude ו‑Codex קוראים וכותבים לאותו מקור אמת.</p>
      </section>

      <LiveDeck
        sightings={sightingsRef.current}
        events={events}
        revision={rosterRevision}
        wsUp={wsUp}
        preview={STATIC_PREVIEW}
        graph={deckGraph}
        collapsed={liveTraceCollapsed}
        onToggleCollapsed={() => setLiveTraceCollapsed((collapsed) => !collapsed)}
      />

      <nav className="camera-dock" aria-label={mode === '3d' ? 'זוויות ואינטראקציה במוח תלת ממד' : 'ניווט ואינטראקציה במפת המוח'} data-testid="camera-dock">
        {mode === '3d' ? (
          <>
            <button type="button" className="camera-button zoom-button" data-testid="camera-zoom-in" aria-label="התקרבות למוח" onClick={() => zoomCamera3D(-1)}>+</button>
            {([
              ['whole', 'כל המוח'],
              ['left', 'שמאל'],
              ['right', 'ימין'],
            ] as const).map(([preset, label]) => (
              <button
                key={preset}
                type="button"
                className={cameraPreset === preset ? 'camera-button active' : 'camera-button'}
                data-testid={`camera-${preset}`}
                aria-pressed={cameraPreset === preset}
                onClick={() => applyCameraPreset(preset)}
              >
                {label}
              </button>
            ))}
            <button type="button" className="camera-button" data-testid="field-reset" onClick={resetInteractiveField}>איפוס שדה</button>
            <button type="button" className="camera-button zoom-button" data-testid="camera-zoom-out" aria-label="התרחקות מהמוח" onClick={() => zoomCamera3D(1)}>−</button>
            <span className="camera-hint" aria-hidden="true">SCROLL FLIES IN · DRAG LOOKS AROUND · RIGHT-DRAG PANS · DRAG A NEURON MOVES IT</span>
          </>
        ) : (
          <>
            <button type="button" className="camera-button zoom-button" data-testid="map-zoom-in" aria-label="התקרבות למפה" onClick={() => zoomCamera2D(1.24)}>+</button>
            <button type="button" className="camera-button" data-testid="field-reset" onClick={resetInteractiveField}>איפוס שדה</button>
            <button type="button" className="camera-button zoom-button" data-testid="map-zoom-out" aria-label="התרחקות מהמפה" onClick={() => zoomCamera2D(0.81)}>−</button>
            <span className="camera-hint" aria-hidden="true">DRAG NEURON · COLLISION FIELD REFLOWS · SCROLL ZOOM</span>
          </>
        )}
      </nav>

      {selected ? (
        <aside className="details inspector" data-testid="inspector" aria-label="פרטי צומת">
          <div className="details-head">
            <span className="layer-swatch large" style={{ backgroundColor: LAYER_COLORS[selected.layer] }} aria-hidden="true" />
            <span className="panel-title">{selected.label}</span>
            <button type="button" className="text-button" aria-label="סגירת פרטי צומת" onClick={() => setSelected(null)}>סגור</button>
          </div>
          {selected.path ? <div className="mono">{selected.path}</div> : null}
          {selected.meta?.description ? <p>{selected.meta.description}</p> : null}
          {selected.meta?.tags?.length ? (
            <div className="tags">{selected.meta.tags.slice(0, 8).map((tag) => <span key={tag} className="tag">{tag}</span>)}</div>
          ) : null}
          {neighbors.length > 0 ? (
            <div className="neighbors">
              <div className="panel-sub">קשרים</div>
              {neighbors.map((node) => (
                <button type="button" key={node.id} className="neighbor" onClick={() => { setSelected(node); fly(node.id); }}>
                  <span className="layer-swatch" style={{ backgroundColor: LAYER_COLORS[node.layer] ?? '#9EA5AD' }} aria-hidden="true" />
                  {node.label}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="jump" data-testid="camera-selected" onClick={() => fly(selected.id)}>מרכז במצלמה</button>
        </aside>
      ) : null}

      {activityOpen ? (
        <aside id="activity-panel" className="activity-panel" data-testid="activity-panel" aria-label="פעילות אחרונה">
          <div className="activity-panel-head">
            <div>
              <span className="panel-title">קבצים שניגשו אליהם</span>
              <span className="panel-caption">נתיב מדויק, פעולה, סוכן וזמן · ללא אירועי build כלליים</span>
            </div>
            <button type="button" className="text-button" aria-label="סגירת חלונית הפעילות" onClick={() => setActivityOpen(false)}>סגור</button>
          </div>
          <Feed
            events={events}
            sessions={sessions}
            sessionFilter={sessionFilter}
            onSessionFilter={setSessionFilter}
            onJump={(id) => { fly(id); const node = data.nodes.find((item) => item.id === id); if (node) setSelected(node); }}
          />
        </aside>
      ) : null}
    </div>
  );
}
