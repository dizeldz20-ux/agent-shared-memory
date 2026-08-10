export type Layer = 'vault' | 'api' | 'web' | 'ops' | 'lab' | 'c2b' | 'ephemeral';

export interface BrainNode {
  id: string;
  label: string;
  layer: Layer;
  kind: 'root' | 'dir' | 'file' | 'page' | 'ephemeral';
  path: string;
  abs: string;
  meta?: { description?: string; tags?: string[]; pageType?: string };
  // added by force-graph at runtime
  x?: number; y?: number; z?: number;
}

export interface BrainLink {
  source: string | BrainNode;
  target: string | BrainNode;
  type: 'contains' | 'code' | 'link' | 'xlayer';
  weight?: number;
}

export interface BrainData {
  nodes: BrainNode[];
  links: BrainLink[];
}

export interface LiveEvent {
  ts: number;
  tool: string;
  cwd: string;
  session: string;
  path: string;
  node_id: string;
  matched: boolean;
  layer: string;
  label: string;
}

// DS hues on the dark canvas
export const LAYER_COLORS: Record<string, string> = {
  vault: '#33B1FF',
  api: '#51D5A5',
  web: '#F1C21B',
  ops: '#F5ACA3',
  lab: '#C9EDFF',
  c2b: '#C94236',
  ephemeral: '#E1E6EC',
};

export const LAYER_NAMES: Record<string, string> = {
  vault: 'כספת הידע',
  api: 'API',
  web: 'Web',
  ops: 'Ops',
  lab: 'Lab',
  c2b: 'C2B (המוח עצמו)',
  ephemeral: 'מחוץ למפה',
};
