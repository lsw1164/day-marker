import { formatLong, isCalendarDate, type CalendarDate } from '@/domain/calendarDate'
import type { GoogleEvent } from '@/google/calendarApi'

/**
 * The discovery predicate. If `dayMarkerVersion` is ever bumped, this must match
 * every live version or older registrations become invisible.
 */
export const DISCOVERY_FILTER = 'dayMarkerVersion=1'

export interface RegistrationEvent {
  id: string
  date: CalendarDate
  label: string
}

export interface Registration {
  /** The registration key: the start date, stamped on every one of its events. */
  startDate: CalendarDate
  title: string
  count: number
  events: RegistrationEvent[]
}

/** `d100` → `Day 100`, `y1` → `1 Year`, `y2` → `2 Years`. */
function labelFor(milestoneKey: string): string {
  const n = Number(milestoneKey.slice(1))
  if (!Number.isFinite(n)) return milestoneKey
  if (milestoneKey.startsWith('d')) return `Day ${n}`
  if (milestoneKey.startsWith('y')) return n === 1 ? '1 Year' : `${n} Years`
  return milestoneKey
}

/**
 * The per-event accumulator, carrying `summary` only until the title is read
 * from the earliest-dated event -- `RegistrationEvent` itself has no summary
 * field, since nothing downstream needs it.
 */
type Attributed = RegistrationEvent & { summary?: string }

export function groupByStartDate(events: GoogleEvent[]): Registration[] {
  const groups = new Map<CalendarDate, Attributed[]>()

  for (const event of events) {
    const props = event.extendedProperties?.private
    const start = props?.startDate
    const date = event.start?.date
    // An event we cannot attribute to a registration is skipped rather than
    // invented into one: no start date, no date of its own, or either unparseable.
    if (!start || !isCalendarDate(start)) continue
    if (!date || !isCalendarDate(date)) continue

    const list = groups.get(start) ?? []
    list.push({
      id: event.id,
      date,
      label: labelFor(props?.milestoneKey ?? ''),
      summary: event.summary,
    })
    groups.set(start, list)
  }

  return [...groups.entries()]
    .map(([startDate, list]) => {
      const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      return {
        startDate,
        // Google's events.list sets no orderBy, so input order is arbitrary.
        // Titling from the earliest-dated event keeps a registration from
        // renaming itself between loads depending on API response order.
        // `sorted[0]` covers both an empty summary and (impossibly) an empty
        // group in one expression.
        title: sorted[0]?.summary ?? formatLong(startDate),
        count: sorted.length,
        events: sorted,
      }
    })
    // Descending string comparison, which is chronological for YYYY-MM-DD.
    .sort((a, b) => (a.startDate > b.startDate ? -1 : a.startDate < b.startDate ? 1 : 0))
}
