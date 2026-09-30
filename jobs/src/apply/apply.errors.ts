/** The file changed since the proposal was built (a live session edited it): retry next run. */
export class DeferredError extends Error {
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`deferred: ${path} changed since the proposal was built`, options);
    this.name = 'DeferredError';
  }
}

/** A move would replace a file that exists at its destination: nothing is ever overwritten. */
export class DestinationExistsError extends Error {
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`refused: ${path} already exists and would be replaced`, options);
    this.name = 'DestinationExistsError';
  }
}

export class UnknownOperationError extends Error {
  constructor(readonly opId: string, options?: ErrorOptions) {
    super(`no ledger operation ${opId} that can be restored`, options);
    this.name = 'UnknownOperationError';
  }
}
