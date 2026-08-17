export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`Google Calendar API ${status} (${reason})${detail ? `: ${detail}` : ''}`)
    this.name = new.target.name
  }
}

/** Token missing, expired, revoked, or lacking the required scope. */
export class Unauthorized extends ApiError {}
/** Quota or per-user rate limit. Retryable. */
export class RateLimited extends ApiError {}
/** The event ID already exists on this calendar, including reserved deleted IDs. */
export class Conflict extends ApiError {}
export class NotFound extends ApiError {}
/** 5xx. Retryable. */
export class ServerError extends ApiError {}

export function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimited || error instanceof ServerError) return true
  // fetch rejects with TypeError when the network itself failed.
  return error instanceof TypeError
}
