export class InvalidLedgerOpError extends Error {
  constructor(readonly fields: readonly string[], options?: ErrorOptions) {
    super(`invalid ledger operation: ${fields.join(', ')}`, options);
    this.name = 'InvalidLedgerOpError';
  }
}
