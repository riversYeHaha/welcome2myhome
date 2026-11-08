/** Domain error carrying the public API code, HTTP status and user-facing message. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
