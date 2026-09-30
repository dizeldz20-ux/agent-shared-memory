import { useEffect, useMemo, useState } from 'react';
import {
  laneFileActivity,
  liveAction,
  liveFilePath,
  type LiveFileActivity,
} from './liveActivity';
import { liveAgentPalette } from './liveAgentPalette';
import {
  AGENT_FUTURE_SKEW_MS,
  AGENT_WINDOW_MS,
  type AgentPresence,
  type AgentSighting,
  agentRoster,
  daysSince,
  formatAge,
} from './liveRoster';
import type { LiveEvent } from './types';

/** Files shown under each agent. Agents do not compete for rows. */
const FILES_PER_AGENT = 3;
/** A graph snapshot older than this is worth saying out loud. */
const STALE_GRAPH_DAYS = 2;

export interface DeckGraph {
  nodes: number;
  links: number;
  knowledge: number;
  generatedAt?: string | null;
}

interface Props {
  sightings: Map<string, AgentSighting>;
  events: LiveEvent[];
  /** Bumped by the event handler; the deck re-reads the sighting map on change. */
  revision: number;
  wsUp: boolean;
  preview: boolean;
  graph: DeckGraph;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

interface AgentGroup {
  agent: AgentPresence;
  files: LiveFileActivity[];
}

/**
 * Every live claim on screen, rendered from ONE clock and ONE roster.
 *
 * The metric strip and the trace used to be two independent readings a screen
 * apart: the strip counted any event including presence pings over a flat 120 s
 * window, the trace counted only file access. Two numbers, one question, and
 * neither carried an age — so a single Codex touch from a minute and a half ago
 * was drawn exactly like Claude editing a file right now.
 *
 * Panels that must agree are rendered by the same component from the same
 * snapshot. That is the whole reason this file exists.
 */
export function LiveDeck({
  sightings, events, revision, wsUp, preview, graph, collapsed, onToggleCollapsed,
}: Props) {
  const [now, setNow] = useState(() => Date.now());

  // One second, not ten. An age printed on screen is a claim about the present
  // tense, and it may not be a tenth of a minute behind the truth.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const roster = useMemo(
    () => agentRoster(sightings, now),
    // `sightings` is a mutable ref map; `revision` is what says it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sightings, revision, now],
  );

  const groups = useMemo<AgentGroup[]>(() => {
    const windowed = events.filter((event) => {
      const age = now - event.ts * 1000;
      return age >= -AGENT_FUTURE_SKEW_MS && age <= AGENT_WINDOW_MS;
    });
    const byLane = laneFileActivity(windowed, FILES_PER_AGENT);
    const ordered = roster.map((agent) => ({ agent, files: byLane.get(agent.lane) ?? [] }));
    // A lane with files but no sighting cannot normally happen — both are fed by
    // the same batch — but dropping its rows silently would be the same class of
    // lie this component exists to remove.
    const known = new Set(roster.map((agent) => agent.lane));
    for (const [lane, files] of byLane) {
      if (known.has(lane)) continue;
      const newest = files[0].event;
      const ageMs = Math.max(0, now - newest.ts * 1000);
      ordered.push({
        agent: {
          lane,
          agent: newest.agent || 'AGENT',
          lastTs: newest.ts,
          inferred: (newest.source ?? 'hook') !== 'hook',
          ageMs,
          state: 'recent',
        },
        files,
      });
    }
    return ordered;
  }, [events, now, roster]);

  const liveCount = roster.filter((agent) => agent.state === 'live').length;
  const connected = preview || wsUp;
  // "Unknown" is not "none". With the stream down ASM cannot know whether an
  // agent started working a second ago, and printing 0 would assert that it did
  // not. The roster it last saw is still a fact and stays on screen, aging.
  const agentsReading = connected ? `${liveCount}/${roster.length}` : '—';
  const agentsState = connected ? (liveCount ? 'live' : 'idle') : 'unknown';
  const graphAgeDays = daysSince(graph.generatedAt, now);
  const graphStale = graphAgeDays !== null && graphAgeDays >= STALE_GRAPH_DAYS;

  return (
    <>
      <section className="brain-metrics" aria-label="מדדי הזיכרון המשותף" data-testid="brain-metrics">
        <div><strong className="num">{graph.nodes.toLocaleString()}</strong><span>NEURONS</span></div>
        <div><strong className="num">{graph.links.toLocaleString()}</strong><span>SYNAPSES</span></div>
        <div><strong className="num">{graph.knowledge.toLocaleString()}</strong><span>MEMORIES</span></div>
        <div data-state={agentsState} data-testid="metric-agents">
          <strong className="num">{agentsReading}</strong><span>AGENTS</span>
        </div>
        {graphAgeDays !== null ? (
          <div
            className="metric-footnote"
            data-state={graphStale ? 'warn' : 'ok'}
            data-testid="graph-age"
            title={graphStale ? 'הגרף לא נסרק מחדש — הריצו את refresh.sh' : 'הגרף עדכני'}
          >
            <span>GRAPH</span>
            <strong className="num">{graphAgeDays < 1 ? 'today' : `${Math.floor(graphAgeDays)}d`}</strong>
          </div>
        ) : null}
      </section>

      <section
        className={collapsed ? 'live-trace panel collapsed' : 'live-trace panel'}
        data-state={agentsState}
        aria-label="סוכנים והקבצים שהם ניגשים אליהם"
        data-testid="live-trace"
      >
        <h2 className="live-trace-head">
          <span>סוכנים על הקבצים</span>
          <b className="num" data-testid="live-trace-count">{agentsReading}</b>
          <span className={connected ? 'live-stream up' : 'live-stream'} data-testid="live-stream">
            {preview ? 'SIMULATION' : wsUp ? 'STREAMING' : 'RECONNECTING'}
          </span>
          <button
            type="button"
            className="live-trace-toggle"
            data-testid="live-trace-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'פתיחת חלון הסוכנים' : 'מזעור חלון הסוכנים'}
            onClick={onToggleCollapsed}
          >
            {collapsed ? 'פתח' : 'מזער'}
          </button>
          <em className="num" aria-hidden="true">01</em>
        </h2>

        <div className="live-trace-body">
          {groups.map(({ agent, files }) => (
            <div className={`agent-group agent-${agent.lane}`} key={agent.lane} data-state={agent.state}>
              <div
                className="agent-head"
                style={{ '--lane': liveAgentPalette(agent.agent).trace } as React.CSSProperties}
              >
                <i
                  className="agent-dot"
                  data-source={agent.inferred ? 'inferred' : 'hook'}
                  aria-hidden="true"
                />
                <span className="agent-name">{agent.agent}</span>
                {agent.inferred ? (
                  <span
                    className="agent-source"
                    title="ASM גזר את הפעילות מקריאת קובץ rollout — לא דווחה על ידי hook"
                  >rollout</span>
                ) : null}
                <span className="agent-age num">{formatAge(agent.ageMs)}</span>
              </div>
              {files.length ? files.map(({ event, count, key }) => (
                <div className="live-trace-row" key={key}>
                  <span className="live-action">{liveAction(event.tool)}</span>
                  <span className="live-file" title={event.path}>{liveFilePath(event)}</span>
                  <span className={count > 1 ? 'live-repeat active num' : 'live-repeat num'} aria-label={`${count} גישות לקובץ`}>×{count}</span>
                  <span className="live-age num">{formatAge(Math.max(0, now - event.ts * 1000))}</span>
                </div>
              )) : (
                <div className="live-trace-row quiet">
                  <span className="live-file">ללא גישה לקובץ בחלון הזה</span>
                </div>
              )}
            </div>
          ))}
          {!groups.length ? (
            <div className="live-trace-empty">
              {connected ? 'החיבור פעיל · ממתין לפעולת סוכן' : 'אין חיבור לשרת · לא ידוע אם סוכן פעיל כרגע'}
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}
