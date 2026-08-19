import { describe, expect, it } from 'vitest'
import { calendarMonthUrl } from '@/ui/links'
import { calendarDate } from '@/domain/calendarDate'

describe('calendarMonthUrl', () => {
  it('opens the month view on the milestone date', () => {
    expect(calendarMonthUrl(calendarDate('2026-11-24'))).toBe(
      'https://calendar.google.com/calendar/u/0/r/month/2026/11/24',
    )
  })

  it('strips leading zeros, which the route requires', () => {
    expect(calendarMonthUrl(calendarDate('2026-01-05'))).toBe(
      'https://calendar.google.com/calendar/u/0/r/month/2026/1/5',
    )
  })

  it('addresses the first signed-in account explicitly', () => {
    // Asserted on its own because it is a deliberate tradeoff, not incidental
    // formatting: dropping /u/0/ lets Google pick, and pinning it sends a
    // multi-account user to whichever calendar happens to be first.
    expect(calendarMonthUrl(calendarDate('2026-11-24'))).toContain('/calendar/u/0/r/')
  })
})
