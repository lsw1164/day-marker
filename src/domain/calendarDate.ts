declare const brand: unique symbol

/** A calendar day with no time and no timezone, as 'YYYY-MM-DD'. */
export type CalendarDate = string & { readonly [brand]: 'CalendarDate' }

const PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * All arithmetic runs at UTC noon. Noon is 12 hours from either midnight, so
 * no DST shift can move the date, and UTC removes local-offset surprises.
 */
function toUtcNoon(d: string): Date {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, day, 12))
}

function format(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0')
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isCalendarDate(v: string): v is CalendarDate {
  if (!PATTERN.test(v)) return false
  const parsed = toUtcNoon(v)
  // Round-tripping rejects impossible days like 2026-02-30, which Date rolls over.
  return !Number.isNaN(parsed.getTime()) && format(parsed) === v
}

export function calendarDate(v: string): CalendarDate {
  if (!isCalendarDate(v)) throw new RangeError(`Not a calendar date: ${v}`)
  return v
}

export function addDays(d: CalendarDate, n: number): CalendarDate {
  const date = toUtcNoon(d)
  date.setUTCDate(date.getUTCDate() + n)
  return format(date) as CalendarDate
}

export function addYears(d: CalendarDate, n: number): CalendarDate {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y + n, m - 1, day, 12))
  // Feb 29 in a common year rolls forward to Mar 1; pull it back to Feb 28.
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0)
  return format(target) as CalendarDate
}

export function today(now: Date = new Date()): CalendarDate {
  const y = String(now.getFullYear()).padStart(4, '0')
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}` as CalendarDate
}

const LONG = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

export function formatLong(d: CalendarDate): string {
  return LONG.format(toUtcNoon(d))
}
