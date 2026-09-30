import type { LiveEvent } from './types';

/**
 * One roster, one state table.
 *
 * Every panel that answers "which agents are working" reads this module. It used
 * to be answered twice from two different sources — the metric strip counted any
 * event including presence pings, the trace header counted only file access — so
 * the same screen showed two different numbers for the same question.
 *
 * The window is graded rather than flat. A single flat 120 s window with nothing
 * on screen to say how old a row was is what made an idle Codex look busy:
 * measured over the recorded stream, 32% of the rows the trace displayed were
 * more than 20 s old and up to 120 s old, drawn identically to work happening
 * now.
 */
export const AGENT_LIVE_MS = 15_000;
export const AGENT_WINDOW_MS = 90_000;

/** The server tolerates this much clock skew; a sighting must not be stricter. */
export const AGENT_FUTURE_SKEW_MS = 30_000;

export type AgentState = 'live' | 'recent';

export interface AgentSighting {
  lane: string;
  /** Display name as the newest event spelled it. */
  agent: string;
  /** Seconds, exactly as the event carries it. */
  lastTs: number;
  /**
   * True when nothing reported this work — ASM derived it by tailing a rollout
   * file on disk. 3,456 of the 3,463 Codex events in the recorded log are this,
   * and a screen that draws them like a hook's is asserting more than it knows.
   */
  inferred: boolean;
}

export interface AgentPresence extends AgentSighting {
  ageMs: number;
  state: AgentState;
}

/** Anything that is not a hook is ASM's own inference about another process. */
export function isInferred(source?: string) {
  return (source ?? 'hook') !== 'hook';
}

export function agentLane(agent = 'Agent') {
  if (/claude/i.test(agent)) return 'claude';
  if (/codex/i.test(agent)) return 'codex';
  if (/gemini/i.test(agent)) return 'gemini';
  return agent.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'agent';
}

export function agentState(ageMs: number): AgentState {
  return ageMs <= AGENT_LIVE_MS ? 'live' : 'recent';
}

/** Drop sightings that left the window. Returns true when the roster changed. */
export function pruneSightings(sightings: Map<string, AgentSighting>, now: number) {
  let changed = false;
  for (const [lane, sighting] of sightings) {
    if (now - sighting.lastTs * 1000 <= AGENT_WINDOW_MS) continue;
    sightings.delete(lane);
    changed = true;
  }
  return changed;
}

/** Fold a batch of events into the sighting map. Returns true when it changed. */
export function recordSightings(
  events: LiveEvent[],
  sightings: Map<string, AgentSighting>,
  now: number,
) {
  let changed = pruneSightings(sightings, now);
  for (const event of events) {
    const ts = event.ts * 1000;
    const age = now - ts;
    if (age > AGENT_WINDOW_MS || age < -AGENT_FUTURE_SKEW_MS) continue;
    const lane = agentLane(event.agent);
    const previous = sightings.get(lane);
    // Hydration and the rollout tail can both deliver out of order. The newest
    // sighting owns the lane, including whether it was inferred or reported.
    if (previous && previous.lastTs >= event.ts) continue;
    sightings.set(lane, {
      lane,
      agent: (event.agent || '').trim() || 'AGENT',
      lastTs: event.ts,
      inferred: isInferred(event.source),
    });
    changed = true;
  }
  return changed;
}

/** The roster, freshest first. The single answer to "how many agents". */
export function agentRoster(sightings: Map<string, AgentSighting>, now: number): AgentPresence[] {
  const roster: AgentPresence[] = [];
  for (const sighting of sightings.values()) {
    const ageMs = Math.max(0, now - sighting.lastTs * 1000);
    if (ageMs > AGENT_WINDOW_MS) continue;
    roster.push({ ...sighting, ageMs, state: agentState(ageMs) });
  }
  return roster.sort((a, b) => a.ageMs - b.ageMs);
}

/**
 * Age in the trace's own register: LTR, tabular, no Hebrew. A row printed with
 * no age at all is a row claiming to be happening now, which is the specific
 * thing this interface was getting wrong.
 */
export function formatAge(ageMs: number) {
  if (ageMs < 2000) return 'now';
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
  const minutes = Math.floor(ageMs / 60_000);
  const seconds = Math.floor((ageMs % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Elapsed wall time in days, for a graph snapshot that may be stale. */
export function daysSince(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const generated = Date.parse(iso);
  if (Number.isNaN(generated)) return null;
  return Math.max(0, (now - generated) / 86_400_000);
}
