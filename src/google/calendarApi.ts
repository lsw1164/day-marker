import type { GoogleEventPayload } from '@/domain/eventPayload'
import { ApiError, Conflict, NotFound, RateLimited, ServerError, Unauthorized } from '@/google/errors'

export const EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export interface GoogleEvent {
  id: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] }
}

export interface CalendarApi {
  getEvent(id: string): Promise<GoogleEvent | null>
  insertEvent(payload: GoogleEventPayload): Promise<GoogleEvent>
  patchEvent(id: string, payload: GoogleEventPayload): Promise<GoogleEvent>
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string }[] }
}

async function readError(response: Response): Promise<{ reason: string; detail: string }> {
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

function toError(status: number, reason: string, detail: string): ApiError {
  if (status === 401) return new Unauthorized(status, reason, detail)
  if (status === 403) {
    // 403 is overloaded: quota problems are retryable, permission problems are not.
    return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
      ? new RateLimited(status, reason, detail)
      : new Unauthorized(status, reason, detail)
  }
  if (status === 404) return new NotFound(status, reason, detail)
  if (status === 409) return new Conflict(status, reason, detail)
  if (status === 429) return new RateLimited(status, reason, detail)
  if (status >= 500) return new ServerError(status, reason, detail)
  return new ApiError(status, reason, detail)
}

export function createCalendarApi(
  getToken: () => string,
  fetchImpl: typeof fetch = fetch,
): CalendarApi {
  async function request(
    url: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
  ): Promise<Response> {
    return fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function unwrap(response: Response): Promise<GoogleEvent> {
    if (response.ok) return (await response.json()) as GoogleEvent
    const { reason, detail } = await readError(response)
    throw toError(response.status, reason, detail)
  }

  return {
    async getEvent(id) {
      const response = await request(`${EVENTS_URL}/${id}`, 'GET')
      // A missing event is an expected answer here, not a failure.
      if (response.status === 404) return null
      return unwrap(response)
    },
    async insertEvent(payload) {
      return unwrap(await request(EVENTS_URL, 'POST', payload))
    },
    async patchEvent(id, payload) {
      return unwrap(await request(`${EVENTS_URL}/${id}`, 'PATCH', payload))
    },
  }
}
