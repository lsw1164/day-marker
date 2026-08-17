import { describe, expect, it, vi } from 'vitest'
import { createCalendarApi, EVENTS_URL } from '@/google/calendarApi'
import { Conflict, NotFound, RateLimited, ServerError, Unauthorized, isRetryable } from '@/google/errors'
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

function apiWith(fetchImpl: typeof fetch) {
  return createCalendarApi(() => 'token-123', fetchImpl)
}

describe('getEvent', () => {
  it('sends a bearer token to the primary calendar', async () => {
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

describe('error mapping', () => {
  it.each([
    [401, 'authError', Unauthorized],
    [403, 'insufficientPermissions', Unauthorized],
    [403, 'rateLimitExceeded', RateLimited],
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
