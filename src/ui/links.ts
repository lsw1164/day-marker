import type { CalendarDate } from '@/domain/calendarDate'

/** Google Calendar's day view wants unpadded numbers: /r/day/2026/4/10. */
export function calendarDayUrl(date: CalendarDate): string {
  const [y, m, d] = date.split('-').map(Number)
  return `https://calendar.google.com/calendar/r/day/${y}/${m}/${d}`
}
