import { describe, expect, it } from 'vitest'
import { calendarDayUrl } from '@/ui/links'
import { calendarDate } from '@/domain/calendarDate'

describe('calendarDayUrl', () => {
  it('points Google Calendar at the day view', () => {
    expect(calendarDayUrl(calendarDate('2026-04-10'))).toBe(
      'https://calendar.google.com/calendar/r/day/2026/4/10',
    )
  })

  it('strips leading zeros, which the day view requires', () => {
    expect(calendarDayUrl(calendarDate('2026-01-05'))).toBe(
      'https://calendar.google.com/calendar/r/day/2026/1/5',
    )
  })
})
