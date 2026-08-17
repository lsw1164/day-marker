import { describe, expect, it } from 'vitest'
import {
  addDays,
  addYears,
  calendarDate,
  formatLong,
  isCalendarDate,
  today,
} from '@/domain/calendarDate'

describe('calendarDate', () => {
  it('accepts a well-formed date', () => {
    expect(calendarDate('2026-01-01')).toBe('2026-01-01')
  })

  it.each(['2026-1-1', '20260101', 'not-a-date', '2026-02-30', '2026-13-01'])(
    'rejects %s',
    (bad) => {
      expect(isCalendarDate(bad)).toBe(false)
      expect(() => calendarDate(bad)).toThrow(RangeError)
    },
  )
})

describe('addDays', () => {
  it('adds within a month', () => {
    expect(addDays(calendarDate('2026-01-01'), 5)).toBe('2026-01-06')
  })

  it('crosses a month boundary', () => {
    expect(addDays(calendarDate('2026-01-31'), 1)).toBe('2026-02-01')
  })

  it('crosses a year boundary', () => {
    expect(addDays(calendarDate('2026-12-31'), 1)).toBe('2027-01-01')
  })

  it('handles a leap day', () => {
    expect(addDays(calendarDate('2024-02-28'), 1)).toBe('2024-02-29')
  })

  it('subtracts with a negative offset', () => {
    expect(addDays(calendarDate('2026-01-01'), -1)).toBe('2025-12-31')
  })

  it('survives a spring-forward DST boundary', () => {
    // US DST begins 2026-03-08. A local-midnight Date would slip a day here.
    expect(addDays(calendarDate('2026-03-07'), 1)).toBe('2026-03-08')
    expect(addDays(calendarDate('2026-03-08'), 1)).toBe('2026-03-09')
  })
})

describe('addYears', () => {
  it('keeps the same month and day', () => {
    expect(addYears(calendarDate('2026-01-01'), 1)).toBe('2027-01-01')
  })

  it('clamps Feb 29 to Feb 28 in a common year', () => {
    expect(addYears(calendarDate('2024-02-29'), 1)).toBe('2025-02-28')
  })

  it('keeps Feb 29 when the target year is also a leap year', () => {
    expect(addYears(calendarDate('2024-02-29'), 4)).toBe('2028-02-29')
  })

  it('is not 365-day arithmetic', () => {
    // 2024 is a leap year, so start + 365 days would be 2025-02-28.
    expect(addYears(calendarDate('2024-03-01'), 1)).toBe('2025-03-01')
  })
})

describe('today', () => {
  it('uses the local calendar day, not UTC', () => {
    // 23:30 local on Jan 1 is already Jan 2 in UTC for positive offsets,
    // but the user's "today" is still Jan 1.
    const localLateEvening = new Date(2026, 0, 1, 23, 30)
    expect(today(localLateEvening)).toBe('2026-01-01')
  })
})

describe('formatLong', () => {
  it('renders a human-readable date', () => {
    expect(formatLong(calendarDate('2025-03-14'))).toBe('Mar 14, 2025')
  })
})
