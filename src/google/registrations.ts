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

export function groupByStartDate(events: GoogleEvent[]): Registration[] {
  const groups = new Map<CalendarDate, RegistrationEvent[]>()
  const titles = new Map<CalendarDate, string | undefined>()

  for (const event of events) {
    const props = event.extendedProperties?.private
    const start = props?.startDate
    const date = event.start?.date
    // An event we cannot attribute to a registration is skipped rather than
    // invented into one: no start date, no date of its own, or either unparseable.
    if (!start || !isCalendarDate(start)) continue
    if (!date || !isCalendarDate(date)) continue

    const list = groups.get(start) ?? []
    list.push({ id: event.id, date, label: labelFor(props?.milestoneKey ?? '') })
    groups.set(start, list)
    if (!titles.has(start)) titles.set(start, event.summary)
  }

  return [...groups.entries()]
    .map(([startDate, list]) => {
      const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      return {
        startDate,
        // The first event's summary shows the user's label if they set one, with
        // no extra field stamped and nothing to migrate for existing events.
        title: titles.get(startDate) ?? formatLong(startDate),
        count: sorted.length,
        events: sorted,
      }
    })
    // Descending string comparison, which is chronological for YYYY-MM-DD.
    .sort((a, b) => (a.startDate > b.startDate ? -1 : a.startDate < b.startDate ? 1 : 0))
}
