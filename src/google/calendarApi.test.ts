import { describe, expect, it, vi } from 'vitest'
import {
  CALENDARS_URL,
  createCalendarApi,
  createCalendarsApi,
  eventsUrl,
} from '@/google/calendarApi'
import {
  Conflict,
  NotFound,
  RateLimited,
  ServerError,
  Unauthorized,
  isRetryable,
} from '@/google/errors'
import type { GoogleEventPayload } from '@/domain/eventPayload'
import { calendarDate } from '@/domain/calendarDate'

const payload = {
  id: 'dmabc12',
  summary: 'Day 100',
  description: 'Day Marker · Started 2026-01-01',
  start: { date: calendarDate('2026-04-10') },
  end: { date: calendarDate('2026-04-11') },
  transparency: 'transparent',
  status: 'confirmed',
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 900 }] },
  extendedProperties: {
    private: { dayMarkerVersion: '1', startDate: calendarDate('2026-01-01'), milestoneKey: 'd100' },
  },
} satisfies GoogleEventPayload

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function googleError(code: number, reason: string): unknown {
  return { error: { code, message: reason, errors: [{ domain: 'global', reason }] } }
}

const CALENDAR_ID = 'cal-1@group.calendar.google.com'
const EVENTS_URL = eventsUrl(CALENDAR_ID)

function apiWith(fetchImpl: typeof fetch) {
  return createCalendarApi(() => 'token-123', () => CALENDAR_ID, fetchImpl)
}

function calendarsWith(fetchImpl: typeof fetch) {
  return createCalendarsApi(() => 'token-123', fetchImpl)
}

describe('getEvent', () => {
  it('sends a bearer token to the app calendar', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'confirmed', summary: 'Day 100' }),
    ) as unknown as typeof fetch
    await apiWith(fetchImpl).getEvent('dmabc12')
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(`${EVENTS_URL}/dmabc12`)
    expect((init as RequestInit).method).toBe('GET')
    expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe('Bearer token-123')
  })

  it('returns the event when it exists', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'confirmed', summary: 'Day 100' }),
    ) as unknown as typeof fetch
    const event = await apiWith(fetchImpl).getEvent('dmabc12')
    expect(event).toMatchObject({ id: 'dmabc12', status: 'confirmed' })
  })

  it('returns a cancelled event rather than treating it as missing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'cancelled' }),
    ) as unknown as typeof fetch
    expect(await apiWith(fetchImpl).getEvent('dmabc12')).toMatchObject({ status: 'cancelled' })
  })

  it('returns null on 404 instead of throwing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, googleError(404, 'notFound')),
    ) as unknown as typeof fetch
    expect(await apiWith(fetchImpl).getEvent('dmabc12')).toBeNull()
  })
})

describe('eventsUrl', () => {
  /**
   * Secondary calendar IDs are email-shaped — `…@group.calendar.google.com`.
   * Interpolated raw they still resolve on Google's side today, but the ID is a
   * server-assigned string this app now carries into every path segment, so it
   * is escaped rather than trusted.
   */
  it('escapes the calendar ID it is given', () => {
    expect(eventsUrl('a b@group.calendar.google.com')).toBe(
      `${CALENDARS_URL}/a%20b%40group.calendar.google.com/events`,
    )
  })

  /**
   * The ID is not known when the api is constructed — it arrives from Drive
   * after the user connects. Capturing it at construction time would send every
   * request to `/calendars//events`.
   */
  it('is read at call time, not at construction time', async () => {
    let id = 'first'
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'confirmed' }),
    ) as unknown as typeof fetch
    const api = createCalendarApi(() => 'token-123', () => id, fetchImpl)

    await api.getEvent('dmabc12')
    id = 'second'
    await api.getEvent('dmabc12')

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(String(calls[0]![0])).toContain('/first/')
    expect(String(calls[1]![0])).toContain('/second/')
  })
})

describe('calendars', () => {
  it('returns null when the calendar is gone', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, googleError(404, 'notFound')),
    ) as unknown as typeof fetch
    expect(await calendarsWith(fetchImpl).getCalendar('cal-1')).toBeNull()
  })

  it('returns the calendar when it still exists', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'cal-1', summary: 'Day Marker' }),
    ) as unknown as typeof fetch
    expect(await calendarsWith(fetchImpl).getCalendar('cal-1')).toMatchObject({ id: 'cal-1' })
  })

  it('creates a secondary calendar with the given name', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'cal-new', summary: 'Day Marker' }),
    ) as unknown as typeof fetch
    const created = await calendarsWith(fetchImpl).insertCalendar('Day Marker')
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(CALENDARS_URL)
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ summary: 'Day Marker' })
    expect(created.id).toBe('cal-new')
  })
})

describe('error mapping', () => {
  it.each([
    [401, 'authError', Unauthorized],
    [403, 'insufficientPermissions', Unauthorized],
    // All four quota reasons Google uses on 403. Misclassifying any of them as
    // Unauthorized both blocks the retry and halts every queued write.
    [403, 'rateLimitExceeded', RateLimited],
    [403, 'userRateLimitExceeded', RateLimited],
    [403, 'quotaExceeded', RateLimited],
    [403, 'dailyLimitExceeded', RateLimited],
    [429, 'rateLimitExceeded', RateLimited],
    [409, 'duplicate', Conflict],
    [500, 'backendError', ServerError],
    [503, 'backendError', ServerError],
  ] as const)('maps %i/%s to the right type', async (status, reason, Expected) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(status, googleError(status, reason)),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).insertEvent(payload)).rejects.toBeInstanceOf(Expected)
  })

  it('surfaces a 404 from insertEvent as NotFound', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, googleError(404, 'notFound')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).patchEvent('dmabc12', payload)).rejects.toBeInstanceOf(NotFound)
  })

  it('keeps the status and Google’s reason on the error', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, googleError(409, 'duplicate')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).insertEvent(payload)).rejects.toMatchObject({
      status: 409,
      reason: 'duplicate',
    })
  })
})

describe('isRetryable', () => {
  it('accepts rate limits and server errors', () => {
    expect(isRetryable(new RateLimited(429, 'rateLimitExceeded', ''))).toBe(true)
    expect(isRetryable(new ServerError(503, 'backendError', ''))).toBe(true)
  })

  it('rejects auth, conflict and not-found', () => {
    expect(isRetryable(new Unauthorized(401, 'authError', ''))).toBe(false)
    expect(isRetryable(new Conflict(409, 'duplicate', ''))).toBe(false)
    expect(isRetryable(new NotFound(404, 'notFound', ''))).toBe(false)
  })

  it('accepts a bare network failure', () => {
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true)
  })
})

describe('insertEvent and patchEvent', () => {
  it('POSTs the payload to the collection', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'confirmed' }),
    ) as unknown as typeof fetch
    await apiWith(fetchImpl).insertEvent(payload)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(EVENTS_URL)
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ id: 'dmabc12' })
  })

  it('PATCHes the payload to the item', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'confirmed' }),
    ) as unknown as typeof fetch
    await apiWith(fetchImpl).patchEvent('dmabc12', payload)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(`${EVENTS_URL}/dmabc12`)
    expect((init as RequestInit).method).toBe('PATCH')
  })
})

describe('listEvents', () => {
  it('sends the private-property filter and returns one page', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        items: [{ id: 'dm1', status: 'confirmed', summary: 'Day 100' }],
      }),
    ) as unknown as typeof fetch
    const page = await apiWith(fetchImpl).listEvents({
      privateExtendedProperty: 'dayMarkerVersion=1',
    })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toContain('privateExtendedProperty=dayMarkerVersion%3D1')
    expect((init as RequestInit).method).toBe('GET')
    expect(page.items).toHaveLength(1)
    expect(page.nextPageToken).toBeUndefined()
  })

  it('passes a page token through when given one', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items: [] })) as unknown as typeof fetch
    await apiWith(fetchImpl).listEvents({
      privateExtendedProperty: 'dayMarkerVersion=1',
      pageToken: 'tok-2',
    })
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toContain('pageToken=tok-2')
  })

  it('surfaces nextPageToken so the caller can follow it', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { items: [], nextPageToken: 'tok-2' }),
    ) as unknown as typeof fetch
    const page = await apiWith(fetchImpl).listEvents({
      privateExtendedProperty: 'dayMarkerVersion=1',
    })
    expect(page.nextPageToken).toBe('tok-2')
  })

  it('defaults items to an empty array when the body omits it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch
    const page = await apiWith(fetchImpl).listEvents({
      privateExtendedProperty: 'dayMarkerVersion=1',
    })
    expect(page.items).toEqual([])
  })

  it('does not ask for deleted events', async () => {
    // showDeleted defaults to false, and we rely on that: a cancelled event must
    // not appear in a list whose whole purpose is "what is currently registered".
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items: [] })) as unknown as typeof fetch
    await apiWith(fetchImpl).listEvents({ privateExtendedProperty: 'dayMarkerVersion=1' })
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).not.toContain('showDeleted')
  })

  it('does not ask for expanded recurring instances', async () => {
    // singleEvents defaults to false, and that is load-bearing, not incidental
    // (see the long comment in calendarApi.ts). Set to true, a hand-added
    // repeat rule on one of our events would come back as one row per
    // occurrence instead of the recurring master, inflating a registration's
    // count and making a delete of that id cancel a single occurrence rather
    // than removing the registration.
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items: [] })) as unknown as typeof fetch
    await apiWith(fetchImpl).listEvents({ privateExtendedProperty: 'dayMarkerVersion=1' })
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).not.toContain('singleEvents')
  })

  it('maps a failure through the existing error types', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, googleError(401, 'authError')),
    ) as unknown as typeof fetch
    await expect(
      apiWith(fetchImpl).listEvents({ privateExtendedProperty: 'dayMarkerVersion=1' }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })
})

describe('deleteEvent', () => {
  it('DELETEs the event', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const outcome = await apiWith(fetchImpl).deleteEvent('dmabc12')
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(`${EVENTS_URL}/dmabc12`)
    expect((init as RequestInit).method).toBe('DELETE')
    expect(outcome).toBe('deleted')
  })

  it('sends no body or Content-Type', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await apiWith(fetchImpl).deleteEvent('dmabc12')
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect((init as RequestInit).body).toBeUndefined()
    expect(new Headers((init as RequestInit).headers).get('Content-Type')).toBeNull()
  })

  it.each([404, 410])('reports %i as already gone, not a failure', async (status) => {
    // The user deleted this by hand. Nothing is broken, so calling it a failure
    // would send them hunting a problem that does not exist.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(status, googleError(status, 'notFound')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).deleteEvent('dmabc12')).resolves.toBe('alreadyGone')
  })

  it('still throws on a real failure', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, googleError(401, 'authError')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).deleteEvent('dmabc12')).rejects.toBeInstanceOf(Unauthorized)
  })

  it('treats a rate limit as retryable, exactly as writes do', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, googleError(429, 'rateLimitExceeded')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).deleteEvent('dmabc12')).rejects.toBeInstanceOf(RateLimited)
  })
})
