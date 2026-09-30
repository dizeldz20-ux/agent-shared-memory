export class McpClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpClientError';
  }
}
