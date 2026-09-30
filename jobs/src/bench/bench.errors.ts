export class SnapshotExistsError extends Error {
  constructor(readonly dir: string, options?: ErrorOptions) {
    super(`a frozen snapshot already exists at ${dir}; snapshots are never overwritten`, options);
    this.name = 'SnapshotExistsError';
  }
}

export class UsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UsageError';
  }
}
