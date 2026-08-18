import type { GoogleEventPayload } from '@/domain/eventPayload'
import { ApiError, Conflict, NotFound, RateLimited, ServerError, Unauthorized } from '@/google/errors'

export const EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export interface GoogleEvent {
  id: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] }
  /** All-day events carry `date`; both fields are optional because a malformed
   *  response must degrade rather than crash. */
  start?: { date?: string }
  /** Where Day Marker stamps dayMarkerVersion, startDate, and milestoneKey. */
  extendedProperties?: { private?: Record<string, string> }
}

export interface EventListPage {
  items: GoogleEvent[]
  nextPageToken?: string
}

export interface CalendarApi {
  getEvent(id: string): Promise<GoogleEvent | null>
  insertEvent(payload: GoogleEventPayload): Promise<GoogleEvent>
  patchEvent(id: string, payload: GoogleEventPayload): Promise<GoogleEvent>
  listEvents(query: {
    privateExtendedProperty: string
    pageToken?: string
  }): Promise<EventListPage>
  deleteEvent(id: string): Promise<'deleted' | 'alreadyGone'>
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

function toError(status: number, reason: string, detail: string): ApiError {
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

export function createCalendarApi(
  getToken: () => string,
  fetchImpl: typeof fetch = fetch,
): CalendarApi {
  async function request(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
    async listEvents({ privateExtendedProperty, pageToken }) {
      const url = new URL(EVENTS_URL)
      url.searchParams.set('privateExtendedProperty', privateExtendedProperty)
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      // showDeleted is deliberately left at its default of false: a cancelled
      // event must not appear in a list of what is currently registered.
      //
      // singleEvents is likewise left at its default of false, and that is load
      // bearing rather than incidental. Day Marker never writes a `recurrence`
      // field, so this changes nothing today -- but a user can add a repeat rule
      // to one of our events by hand in the Calendar UI. Left at false we get
      // the recurring master, once, carrying our stamps and our deterministic
      // id, and deleting that id removes the whole series. Set to true we would
      // instead get one instance per occurrence, all carrying the same inherited
      // stamps, so the registrations list would show a milestone many times over
      // and deleting an instance id would cancel a single occurrence rather than
      // the registration. Do not "fix" this by asking for expanded instances.
      const response = await request(url.toString(), 'GET')
      if (response.ok) {
        const body = (await response.json()) as Partial<EventListPage>
        return { items: body.items ?? [], nextPageToken: body.nextPageToken }
      }
      const { reason, detail } = await readError(response)
      throw toError(response.status, reason, detail)
    },
    async deleteEvent(id) {
      const response = await request(`${EVENTS_URL}/${id}`, 'DELETE')
      if (response.ok) return 'deleted'
      // 404: never existed or fully purged. 410: existed, already deleted. Both
      // mean the end state we wanted already holds.
      if (response.status === 404 || response.status === 410) return 'alreadyGone'
      const { reason, detail } = await readError(response)
      throw toError(response.status, reason, detail)
    },
  }
}
