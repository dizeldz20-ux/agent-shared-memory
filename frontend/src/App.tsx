import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain } from './Brain';
import { Brain2D, type Layout2D } from './Brain2D';
import { Feed } from './Feed';
import { useLive } from './useLive';
import { seedBrainPositions } from './brainShape';
import { CAMERA_PRESETS_3D, type CameraPreset3D } from './brain3d';
import type { BrainData, BrainNode, LiveEvent } from './types';
import { LAYER_COLORS, LAYER_NAMES } from './types';

const PULSE_MS = 3000;
const EPHEMERAL_TTL = 60000;
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
  const [follow, setFollow] = useState(false);
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
  const [cameraPreset, setCameraPreset] = useState<CameraPreset3D>('whole');
  const [reduceMotion, setReduceMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);

  const fgRef = useRef<any>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const activeRef = useRef(new Map<string, number>());
  const dataRef = useRef<BrainData | null>(null);
  dataRef.current = data;
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
        setData({ nodes: g.nodes, links: g.links });
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'graph load failed');
      });
    return () => { cancelled = true; };
  }, [retryLoad]);

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

  const handleEvents = useCallback((evs: LiveEvent[]) => {
    const now = Date.now();
    const newEphemerals: BrainNode[] = [];
    const newLinks: BrainData['links'] = [];
    const d = dataRef.current;
    for (const e of evs) {
      activeRef.current.set(e.node_id, now + PULSE_MS);
      if (!e.matched && d && !d.nodes.some((n) => n.id === e.node_id) &&
          !newEphemerals.some((n) => n.id === e.node_id)) {
        const project = e.node_id.split(':')[1] ?? 'misc';
        const anchorId = `ephemeral:${project}`;
        if (!d.nodes.some((n) => n.id === anchorId) && !newEphemerals.some((n) => n.id === anchorId)) {
          newEphemerals.push({ id: anchorId, label: project, layer: 'ephemeral', kind: 'root', path: '', abs: '' });
        }
        newEphemerals.push({ id: e.node_id, label: e.label, layer: 'ephemeral', kind: 'ephemeral', path: e.path, abs: e.path });
        newLinks.push({ source: anchorId, target: e.node_id, type: 'contains' });
        ephemeralBorn.current.set(e.node_id, now);
      } else if (!e.matched) {
        ephemeralBorn.current.set(e.node_id, now); // refresh TTL
      }
    }
    if (newEphemerals.length && d) {
      setData({ nodes: [...d.nodes, ...newEphemerals], links: [...d.links, ...newLinks] });
    }
    setEvents((prev) => [...evs.slice().reverse(), ...prev].slice(0, 300));
    // Highlight, never fly. The camera used to chase every tool call, which turned reading the
    // brain into being dragged around it — and the node is already unmistakable on its own
    // (white, enlarged, pulsing). Selecting it adds the focus ring and names the file in the
    // panel, which is the whole question "where is Claude right now" answered without motion.
    if (followRef.current && evs.length) {
      const last = evs[evs.length - 1];
      if (last.matched) {
        const touched = d?.nodes.find((node) => node.id === last.node_id);
        if (touched) setSelected(touched);
      }
    }
  }, []);

  useLive(handleEvents, setWsUp, !STATIC_PREVIEW);

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
      const expired = new Set<string>();
      for (const [id, born] of ephemeralBorn.current) {
        if (now - born > EPHEMERAL_TTL && !activeRef.current.has(id)) expired.add(id);
      }
      if (!expired.size) return;
      for (const id of expired) ephemeralBorn.current.delete(id);
      const liveEph = new Set(
        d.nodes.filter((n) => n.kind === 'ephemeral' && !expired.has(n.id)).map((n) => n.id.split(':')[1]));
      setData({
        nodes: d.nodes.filter((n) =>
          !expired.has(n.id) && !(n.layer === 'ephemeral' && n.kind === 'root' && !liveEph.has(n.label))),
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

  // Claude's recent path through the brain, chronological (for the 2D flow trail)
  const trail = useMemo(
    () => events
      .filter((e) => !sessionFilter || e.cwd === sessionFilter)
      .slice(0, 14)
      .reverse(),
    [events, sessionFilter]);

  const layerCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of data?.nodes ?? []) c[n.layer] = (c[n.layer] ?? 0) + 1;
    return c;
  }, [data]);

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
      data-testid="c2b-app"
      data-preview={STATIC_PREVIEW ? 'true' : 'false'}
      data-view={currentView}
      data-motion={reduceMotion ? 'reduced' : 'full'}
      dir="rtl"
    >
      {mode === '3d' ? (
        <Brain data={data} active={activeRef.current} layerVisible={layerVisible}
               selected={selected} hovered={hovered} onSelect={setSelected} onHover={setHovered}
               motionEnabled={!reduceMotion} cameraPreset={cameraPreset} fgRef={fgRef} />
      ) : (
        <Brain2D data={data} active={activeRef.current} layerVisible={layerVisible}
                 selected={selected} hovered={hovered} onSelect={setSelected} onHover={setHovered} fgRef={fgRef}
                 layout={layout2d} trail={trail} motionEnabled={!reduceMotion} />
      )}

      <header className="instrument-header">
        <div className="instrument-brand">
          <div className="brand-copy">
            <strong>C2B</strong>
            <span>המוח השני</span>
          </div>
          <span
            data-testid="connection-status"
            className={`connection-tag ${STATIC_PREVIEW ? 'demo' : wsUp ? 'live' : 'offline'}`}
          >
            {STATIC_PREVIEW ? 'מצב הדגמה' : wsUp ? 'מחובר בזמן אמת' : 'לא מחובר'}
          </span>
        </div>

        <div className="view-tabs" role="tablist" aria-label="תצוגת המוח" data-testid="view-tabs">
          {([
            ['3d', 'מוח 3D'],
            ['network', 'רשת 2D'],
            ['rings', 'טבעות 2D'],
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
              placeholder="חיפוש במוח"
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
              שכבות
            </button>
            {layersOpen ? (
              <div id="layer-menu" className="layer-menu" data-testid="layer-menu" role="group" aria-label="שכבות מוצגות">
                <div className="popover-title">שכבות מוצגות</div>
                {Object.keys(LAYER_NAMES).map((layer) => (
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
              aria-label="מעקב אחרי פעילות"
            />
            <span className="toggle-track" aria-hidden="true"><span /></span>
            <span>מעקב</span>
          </label>

          <button
            type="button"
            className="instrument-button activity-button"
            data-testid="activity-trigger"
            aria-expanded={activityOpen}
            aria-controls="activity-panel"
            onClick={() => setActivityOpen((open) => !open)}
          >
            פעילות
            {events.length ? <span className="activity-count">{Math.min(events.length, 99)}</span> : null}
          </button>
        </div>
      </header>

      {mode === '3d' ? (
        <nav className="camera-dock" aria-label="זוויות מצלמת מוח תלת ממד" data-testid="camera-dock">
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
        </nav>
      ) : null}

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
              <span className="panel-title">פעילות אחרונה</span>
              <span className="panel-caption">המסלול החי דרך המוח</span>
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
