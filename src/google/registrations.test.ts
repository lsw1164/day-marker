import { describe, expect, it } from 'vitest'
import { groupByStartDate } from '@/google/registrations'
import type { GoogleEvent } from '@/google/calendarApi'

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
