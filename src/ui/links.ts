import type { CalendarDate } from '@/domain/calendarDate'

/**
 * Google Calendar's month view, scrolled to the milestone's own date:
 * /u/0/r/month/2026/11/24. Month rather than day because an anniversary is
 * one all-day entry -- the day view shows it alone against an empty grid,
 * while the month view shows it in the run of dates around it.
 *
 * Unpadded numbers: the route rejects /2026/04/10.
 *
 * `authuser` names the account when we know it, which is what the optional
 * `userinfo.email` scope buys. Without it the link has to fall back to /u/0/ --
 * the FIRST signed-in account, which is right for the single-account case and
 * wrong for a user whose Day Marker calendar lives under their second: they
 * would land on the wrong calendar and not find the event. Naming the address
 * removes that guess; falling back keeps the link working for anyone who
 * declined the scope.
 */
export function calendarMonthUrl(date: CalendarDate, email = ''): string {
  const [y, m, d] = date.split('-').map(Number)
  const path = `r/month/${y}/${m}/${d}`
  return email
    ? `https://calendar.google.com/calendar/${path}?authuser=${encodeURIComponent(email)}`
    : `https://calendar.google.com/calendar/u/0/${path}`
}
