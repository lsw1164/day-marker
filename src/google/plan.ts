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

  const settled = await mapWithLimit(milestones, PROBE_CONCURRENCY, async (milestone) => {
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
  })

  // A probe failure means we cannot describe the calendar honestly, so surface it.
  const failure = settled.find((r) => r.status === 'rejected')
  if (failure && failure.status === 'rejected') throw failure.reason

  return settled.map((r) => (r as PromiseFulfilledResult<PlanItem>).value)
}
