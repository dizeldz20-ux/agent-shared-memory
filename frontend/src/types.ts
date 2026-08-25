export type Layer = string;

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
  agent?: string;
  presence?: boolean;
  source?: string;
  phase?: 'start' | 'finish' | string;
  operation_id?: string;
  /** True when the agent adapter resolved this as a concrete file access. */
  file_access?: boolean;
}

export interface LiveActivitySource {
  nodeId: string;
  agent: string;
  until: number;
}

// Layer identity is reserved for filters and details. The primary 3D brain uses a
// restrained neural palette so the structure reads as one shared system.
export const LAYER_COLORS: Record<string, string> = {
  vault: '#8fd8d4',
  asm: '#e8f0ed',
  agents: '#9db8c8',
  skills: '#b1a7c8',
  acp: '#c6ad83',
  ops: '#b88d88',
  api: '#8fb8ae',
  web: '#a7b39a',
  lab: '#9aabb4',
  memory: '#d6c6a0',
  ephemeral: '#77868a',
};

export const LAYER_NAMES: Record<string, string> = {
  vault: 'Obsidian · ידע',
  asm: 'ASM · ליבה',
  agents: 'Agents',
  skills: 'Skills',
  acp: 'Agent Control Plane',
  api: 'API',
  web: 'Web',
  ops: 'Ops',
  lab: 'Lab',
  memory: 'זיכרון מיידי',
  ephemeral: 'מחוץ למפה',
};
