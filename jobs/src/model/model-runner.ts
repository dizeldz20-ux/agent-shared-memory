export interface ModelUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cost_usd: number | null;
}

export interface ModelResult {
  readonly text: string;
  readonly usage: ModelUsage;
}

/** One prompt in, one text out. The jobs depend on this, never on a concrete CLI. */
export interface ModelRunner {
  run(prompt: string): Promise<ModelResult>;
}
