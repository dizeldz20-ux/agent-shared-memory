/** The model cannot be used right now (rate limit, auth): stop the run, keep the state. */
export class ModelUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelUnavailableError';
  }
}

/** One call failed (bad output, crash, timeout): count a failure for the items it carried. */
export class ModelFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelFailedError';
  }
}
