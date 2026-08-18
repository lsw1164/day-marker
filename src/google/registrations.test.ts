import { describe, expect, it, vi } from 'vitest'
import { groupByStartDate, listRegistrations, DISCOVERY_FILTER } from '@/google/registrations'
import type { CalendarApi, EventListPage, GoogleEvent } from '@/google/calendarApi'
import { Unauthorized } from '@/google/errors'

function ev(
  id: string,
  startDate: string | undefined,
  milestoneKey: string,
  date: string,
  summary?: string,
): GoogleEvent {
  return {
    id,
    status: 'confirmed',
    ...(summary === undefined ? {} : { summary }),
    start: { date },
    extendedProperties: {
      private: {
        dayMarkerVersion: '1',
        ...(startDate === undefined ? {} : { startDate }),
        milestoneKey,
      },
    },
  }
}

describe('groupByStartDate', () => {
  it('groups events sharing a start date into one registration', () => {
    const out = groupByStartDate([
      ev('a', '2025-03-14', 'd100', '2025-06-21', 'Anna & Ben: Day 100'),
      ev('b', '2025-03-14', 'y1', '2026-03-14', 'Anna & Ben: 1 Year'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.startDate).toBe('2025-03-14')
    expect(out[0]?.count).toBe(2)
  })

  it('separates different start dates', () => {
    const out = groupByStartDate([
      ev('a', '2025-03-14', 'd100', '2025-06-21'),
      ev('b', '2026-01-01', 'd100', '2026-04-10'),
    ])
    expect(out.map((r) => r.startDate)).toEqual(['2026-01-01', '2025-03-14'])
  })

  it('sorts by start date descending, so a future registration sorts first', () => {
    // Deliberately not "newest": creation time is recorded nowhere, and a future
    // start date is the most relevant, not the most recently made.
    const out = groupByStartDate([
      ev('a', '2025-03-14', 'd100', '2025-06-21'),
      ev('b', '2027-05-05', 'd100', '2027-08-12'),
      ev('c', '2026-01-01', 'd100', '2026-04-10'),
    ])
    expect(out.map((r) => r.startDate)).toEqual(['2027-05-05', '2026-01-01', '2025-03-14'])
  })

  it('titles a registration from its earliest event, not whatever the API returned first', () => {
    const out = groupByStartDate([
      ev('b', '2025-03-14', 'y1', '2026-03-14', 'Anna & Ben: 1 Year'),
      ev('a', '2025-03-14', 'd100', '2025-06-21', 'Anna & Ben: Day 100'),
    ])
    // Google's events.list sets no orderBy, so input order is arbitrary. Titling
    // from the earliest event keeps the same registration from renaming itself
    // between loads.
    expect(out[0]?.title).toBe('Anna & Ben: Day 100')
  })

  it('falls back to the formatted start date when no summary exists', () => {
    const out = groupByStartDate([ev('a', '2025-03-14', 'd100', '2025-06-21')])
    expect(out[0]?.title).toBe('Mar 14, 2025')
  })

  it('sorts events within a registration by date', () => {
    const out = groupByStartDate([
      ev('b', '2025-03-14', 'y1', '2026-03-14'),
      ev('a', '2025-03-14', 'd100', '2025-06-21'),
    ])
    expect(out[0]?.events.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('labels each event from its milestone key', () => {
    const out = groupByStartDate([
      ev('a', '2025-03-14', 'd100', '2025-06-21'),
      ev('b', '2025-03-14', 'd1000', '2028-01-01'),
      ev('c', '2025-03-14', 'y1', '2026-03-14'),
      ev('d', '2025-03-14', 'y2', '2027-03-14'),
    ])
    expect(out[0]?.events.map((e) => e.label)).toEqual([
      'Day 100',
      '1 Year',
      '2 Years',
      'Day 1000',
    ])
  })

  it('does not invent a number for a truncated milestone key', () => {
    const out = groupByStartDate([
      ev('a', '2025-03-14', 'd', '2025-06-21'),
      ev('b', '2025-03-14', 'y', '2026-03-14'),
    ])
    expect(out[0]?.events.map((e) => e.label)).toEqual(['d', 'y'])
  })

  it('ignores events with no stamped start date', () => {
    // Someone else's event that happens to carry dayMarkerVersion, or a corrupted
    // one. It cannot be attributed to a registration, so it is not invented into one.
    const out = groupByStartDate([
      ev('a', undefined, 'd100', '2025-06-21'),
      ev('b', '2025-03-14', 'd100', '2025-06-21'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.count).toBe(1)
  })

  it('ignores events with an unparseable start date', () => {
    const out = groupByStartDate([ev('a', 'not-a-date', 'd100', '2025-06-21')])
    expect(out).toEqual([])
  })

  it('ignores events with no date of their own', () => {
    const bad: GoogleEvent = {
      id: 'a',
      status: 'confirmed',
      extendedProperties: { private: { dayMarkerVersion: '1', startDate: '2025-03-14' } },
    }
    expect(groupByStartDate([bad])).toEqual([])
  })

  it('returns nothing for an empty list', () => {
    expect(groupByStartDate([])).toEqual([])
  })
})

/**
 * A token-driven page server. Unlike a call-counting mock it checks that the
 * loop sends back exactly the token it was handed: an unrecognised token throws
 * instead of quietly serving the next page in sequence. The call ceiling turns a
 * non-terminating loop into an immediate, labelled failure -- a mock that runs
 * out of fixtures and returns an empty page would let that bug pass, which is
 * what the previous helper did.
 */
function apiServing(pages: Record<string, EventListPage>): CalendarApi {
  let calls = 0
  return {
    getEvent: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
    listEvents: vi.fn(async ({ pageToken }: { pageToken?: string }) => {
      calls += 1
      if (calls > 10) {
        throw new Error(`listEvents called ${calls} times: the pagination loop is not terminating`)
      }
      const page = pages[pageToken ?? '']
      if (!page) {
        throw new Error(`listEvents asked for an unknown pageToken: ${JSON.stringify(pageToken)}`)
      }
      return page
    }),
  }
}

describe('listRegistrations', () => {
  it('queries with the discovery filter', async () => {
    const api = apiServing({ '': { items: [] } })
    await listRegistrations(api)
    expect(api.listEvents).toHaveBeenCalledWith({
      privateExtendedProperty: DISCOVERY_FILTER,
      pageToken: undefined,
    })
  })

  it('follows nextPageToken across every page, in order', async () => {
    // The whole point: a registration that exists on page three must be findable.
    // Showing only page one would be worse than having no list at all.
    const api = apiServing({
      '': { items: [ev('a', '2025-03-14', 'd100', '2025-06-21')], nextPageToken: 'p2' },
      p2: { items: [ev('b', '2026-01-01', 'd100', '2026-04-10')], nextPageToken: 'p3' },
      p3: { items: [ev('c', '2027-05-05', 'd100', '2027-08-12')] },
    })
    const out = await listRegistrations(api)
    const calls = (api.listEvents as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map((c) => c[0].pageToken)).toEqual([undefined, 'p2', 'p3'])
    expect(calls.every((c) => c[0].privateExtendedProperty === DISCOVERY_FILTER)).toBe(true)
    expect(out.map((r) => r.startDate)).toEqual(['2027-05-05', '2026-01-01', '2025-03-14'])
  })

  it('stops after one page when there is no token', async () => {
    const api = apiServing({ '': { items: [] } })
    await listRegistrations(api)
    expect(api.listEvents).toHaveBeenCalledTimes(1)
  })

  it('merges pages that belong to the same registration', async () => {
    const api = apiServing({
      '': { items: [ev('a', '2025-03-14', 'd100', '2025-06-21')], nextPageToken: 'p2' },
      p2: { items: [ev('b', '2025-03-14', 'y1', '2026-03-14')] },
    })
    const out = await listRegistrations(api)
    expect(out).toHaveLength(1)
    expect(out[0]?.count).toBe(2)
  })

  it('propagates a failure rather than returning a partial list', async () => {
    // A partial list presented as complete is a lie about the user's calendar.
    const api: CalendarApi = {
      getEvent: vi.fn(),
      insertEvent: vi.fn(),
      patchEvent: vi.fn(),
      deleteEvent: vi.fn(),
      listEvents: vi.fn(async () => {
        throw new Unauthorized(401, 'authError', '')
      }),
    }
    await expect(listRegistrations(api)).rejects.toBeInstanceOf(Unauthorized)
  })
})
