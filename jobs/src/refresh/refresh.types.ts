export interface RefreshOptions {
  /** The ASM checkout: sources.json, merge.py, the hooks and skills to deploy. */
  readonly repo: string;
  /** The runtime every agent reads, usually ~/.asm. */
  readonly runtime: string;
  /** The user's home: the skill folders live under it. */
  readonly home: string;
  /** Re-extract only sources with a file newer than their extract, or an extract over 3 days old. */
  readonly changedOnly: boolean;
  /** Rebuild and deploy the graph files and nothing else. */
  readonly brainOnly: boolean;
  readonly env: NodeJS.ProcessEnv;
}

/** What happened to each mapped source, by raw id. */
export interface ExtractStats {
  readonly extracted: string[];
  readonly failed: string[];
  /** Sources whose folder is gone: their last extract stays, now stale. */
  readonly missing: string[];
  readonly unchanged: string[];
}

export interface RefreshResult {
  readonly stats: ExtractStats;
  /** How the running UI server took the new graph, or that none runs. */
  readonly reload: string;
}

export interface RefreshLog {
  info(line: string): void;
  warn(line: string): void;
  /** A tool's own output, passed through as it comes. */
  output(text: string): void;
}

/** A step the rest of the refresh cannot do without failed: nothing after it runs. */
export class RefreshError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RefreshError';
  }
}
