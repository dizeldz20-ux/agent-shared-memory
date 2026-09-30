import type { LiveEvent } from './types';
import { LAYER_COLORS } from './types';
import { liveEventKey, liveFilePath } from './liveActivity';
import { isInferred } from './liveRoster';

interface Props {
  events: LiveEvent[];
  sessions: string[];
  sessionFilter: string;
  onSessionFilter: (s: string) => void;
  onJump: (nodeId: string) => void;
}

const shortCwd = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || cwd;
const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function Feed({ events, sessions, sessionFilter, onSessionFilter, onJump }: Props) {
  const shown = events.filter((e) => !sessionFilter || e.cwd === sessionFilter);
  return (
    <div className="feed">
      <div className="feed-head">
        <span className="feed-summary">{shown.length} אירועים מוצגים</span>
        <label className="session-filter">
          <span className="sr-only">סינון לפי סשן</span>
          <select aria-label="סינון פעילות לפי סשן" value={sessionFilter} onChange={(e) => onSessionFilter(e.target.value)}>
          <option value="">כל הסשנים</option>
          {sessions.map((s) => (
            <option key={s} value={s}>{shortCwd(s)}</option>
          ))}
          </select>
        </label>
      </div>
      <div className="feed-list">
        {shown.length === 0 && <div className="feed-empty">ממתין לאות מאחד הסוכנים…</div>}
        {shown.map((e) => (
          <button
            type="button"
            key={liveEventKey(e)}
            className="feed-row"
            onClick={() => !e.presence && onJump(e.node_id)}
            disabled={Boolean(e.presence)}
          >
            <span className="layer-swatch" style={{ backgroundColor: LAYER_COLORS[e.layer] ?? '#9EA5AD' }} aria-hidden="true" />
            <span className="feed-agent">{e.agent || 'AGENT'}</span>
            {isInferred(e.source) ? (
              <span className="feed-source" title="ASM גזר את הפעילות מקריאת קובץ rollout — לא דווחה על ידי hook">rollout</span>
            ) : null}
            <span className="feed-tool">{e.tool}</span>
            <span className="feed-label" title={e.path}>{liveFilePath(e)}</span>
            <span className="feed-time">{fmtTime(e.ts)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
