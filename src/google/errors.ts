export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`Google API ${status} (${reason})${detail ? `: ${detail}` : ''}`)
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

interface GoogleErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string }[] }
}

/** Google's error envelope is the same shape on Calendar and on Drive. */
export async function readError(
  response: Response,
): Promise<{ reason: string; detail: string }> {
  try {
    const body = (await response.json()) as GoogleErrorBody
    return {
      reason: body.error?.errors?.[0]?.reason ?? 'unknown',
      detail: body.error?.message ?? '',
    }
  } catch {
    return { reason: 'unknown', detail: '' }
  }
}

/**
 * Every reason Google returns on a 403 that means "too many requests" rather
 * than "you may not do this". All four must map to RateLimited: classifying one
 * as Unauthorized makes `isRetryable` refuse it *and* trips `applyPlan`'s
 * `halted` flag, so a transient quota blip would report the connection as
 * expired and cancel every write still queued behind it.
 */
const QUOTA_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
])

export function toError(status: number, reason: string, detail: string): ApiError {
  if (status === 401) return new Unauthorized(status, reason, detail)
  if (status === 403) {
    // 403 is overloaded: quota problems are retryable, permission problems are not.
    return QUOTA_REASONS.has(reason)
      ? new RateLimited(status, reason, detail)
      : new Unauthorized(status, reason, detail)
  }
  if (status === 404) return new NotFound(status, reason, detail)
  if (status === 409) return new Conflict(status, reason, detail)
  if (status === 429) return new RateLimited(status, reason, detail)
  if (status >= 500) return new ServerError(status, reason, detail)
  return new ApiError(status, reason, detail)
}
