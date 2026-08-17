import type { CalendarDate } from '@/domain/calendarDate'
import { eventIdFor } from '@/domain/eventId'
import { titleFor, type EventOptions } from '@/domain/eventPayload'
import type { Milestone } from '@/domain/milestones'
import { REMINDER_MINUTES } from '@/domain/reminders'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { mapWithLimit } from '@/lib/mapWithLimit'

export type PlanStatus = 'new' | 'exists' | 'deleted'

export interface PlanItem {
  milestone: Milestone
  eventId: string
  status: PlanStatus
  /** The milestone date is before today. Orthogonal to status; only affects selection. */
  past: boolean
  selected: boolean
  /** Only meaningful for status 'exists': the title or reminder drifted. */
  needsUpdate: boolean
}

export const PROBE_CONCURRENCY = 3

export function existingMinutes(event: GoogleEvent): number | null {
  const overrides = event.reminders?.overrides
  if (!overrides || overrides.length === 0) return null
  return overrides[0]?.minutes ?? null
}

export async function buildPlan(
  api: CalendarApi,
  milestones: Milestone[],
  options: EventOptions,
  todayDate: CalendarDate,
): Promise<PlanItem[]> {
  const wantedMinutes = REMINDER_MINUTES[options.reminder]

  // The `Promise<PlanItem>` annotation is load-bearing, and it needs a named
  // function to sit on: inline in the mapWithLimit call, `status: 'new'` widened
  // to `string` and the cast that used to end this function erased the mismatch,
  // so a `status: 'nwe'` typo compiled clean and shipped a PlanItem that no
  // branch of `applyOne` recognises.
  const probe = async (milestone: Milestone): Promise<PlanItem> => {
    const eventId = await eventIdFor(options.start, milestone.key)
    const existing = await api.getEvent(eventId)
    const past = milestone.date < todayDate

    if (existing === null) {
      return { milestone, eventId, status: 'new', past, selected: !past, needsUpdate: false }
    }
    if (existing.status === 'cancelled') {
      return { milestone, eventId, status: 'deleted', past, selected: !past, needsUpdate: false }
    }
    const needsUpdate =
      existing.summary !== titleFor(milestone, options.label) ||
      existingMinutes(existing) !== wantedMinutes
    return { milestone, eventId, status: 'exists', past, selected: !past, needsUpdate }
  }

  const settled = await mapWithLimit(milestones, PROBE_CONCURRENCY, probe)

  // A probe failure means we cannot describe the calendar honestly, so surface
  // it. Narrowing per slot rather than asserting `PromiseFulfilledResult`: the
  // assertion would happily read `.value` off a rejected slot as a PlanItem.
  return settled.map((r) => {
    if (r.status === 'rejected') throw r.reason
    return r.value
  })
}
