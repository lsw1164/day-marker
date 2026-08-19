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

  it('names the account when the address is known', () => {
    // What the optional userinfo.email scope buys: the link stops guessing which
    // of a user's accounts holds the calendar.
    expect(calendarMonthUrl(calendarDate('2026-11-24'), 'anna@example.com')).toBe(
      'https://calendar.google.com/calendar/r/month/2026/11/24?authuser=anna%40example.com',
    )
  })

  it('falls back to the first account when the address is unknown', () => {
    // Asserted on its own because it is a deliberate tradeoff, not incidental
    // formatting: /u/0/ sends a multi-account user to whichever calendar happens
    // to be first, and that is the price of them declining the scope.
    expect(calendarMonthUrl(calendarDate('2026-11-24'))).toContain('/calendar/u/0/r/')
  })

  it('escapes the address, which contains an @', () => {
    expect(calendarMonthUrl(calendarDate('2026-11-24'), 'a+b@example.com')).toContain(
      'authuser=a%2Bb%40example.com',
    )
  })
})
