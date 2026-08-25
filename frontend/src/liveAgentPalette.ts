export type LiveAgentLane = 'codex' | 'claude' | 'gemini' | 'agent';

export interface LiveAgentPalette {
  soma: string;
  route: string;
  head: string;
  trail: string;
  trace: string;
}

/** One agent identity palette shared by MAP, CORTEX, CONNECTOME and the file trace. */
export const LIVE_AGENT_PALETTES: Record<LiveAgentLane, LiveAgentPalette> = {
  codex: {
    soma: '#f1c77f',
    route: '#b77d43',
    head: '#ffe5a3',
    trail: '#e9a257',
    trace: 'rgba(224, 189, 120, .75)',
  },
  claude: {
    soma: '#8fe0b5',
    route: '#56ad85',
    head: '#d9fbea',
    trail: '#69cca0',
    trace: 'rgba(105, 204, 160, .8)',
  },
  gemini: {
    soma: '#a9c7d9',
    route: '#6d91a4',
    head: '#d8edf5',
    trail: '#8eb6c8',
    trace: 'rgba(142, 182, 200, .76)',
  },
  agent: {
    soma: '#a8d0ca',
    route: '#638f89',
    head: '#d8f0ec',
    trail: '#83b8b0',
    trace: 'rgba(131, 184, 176, .76)',
  },
};

export function liveAgentLane(agent = ''): LiveAgentLane {
  if (/claude/i.test(agent)) return 'claude';
  if (/codex/i.test(agent)) return 'codex';
  if (/gemini/i.test(agent)) return 'gemini';
  return 'agent';
}

export function liveAgentPalette(agent?: string) {
  return LIVE_AGENT_PALETTES[liveAgentLane(agent)];
}
