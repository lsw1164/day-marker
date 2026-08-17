import { formatLong, type CalendarDate } from '@/domain/calendarDate'
import type { Milestone } from '@/domain/milestones'
import type { ItemResult } from '@/google/apply'
import type { PlanItem } from '@/google/plan'
import { COPY, outcomeLabel, statusLabel } from '@/ui/copy'
import type { Phase } from '@/ui/useDayMarker'

export interface Row {
  key: string
  name: string
  date: string
  badge: string
  checked: boolean
  selectable: boolean
  muted: boolean
  failed: boolean
}

export interface BuildRowsInput {
  phase: Phase
  milestones: Milestone[]
  plan: PlanItem[]
  results: ItemResult[]
  todayDate: CalendarDate
}

export function buildRows({
  phase,
  milestones,
  plan,
  results,
  todayDate,
}: BuildRowsInput): Row[] {
  if (phase === 'applying' || phase === 'done') {
    const byId = new Map(results.map((r) => [r.item.eventId, r]))
    return plan
      .filter((item) => item.selected)
      .map((item) => {
        const result = byId.get(item.eventId)
        return {
          key: item.milestone.key,
          name: item.milestone.label,
          date: formatLong(item.milestone.date),
          badge: result ? outcomeLabel(result.outcome) : COPY.queued,
          checked: true,
          selectable: false,
          muted: !result,
          failed: result?.outcome === 'failed',
        }
      })
  }

  if (phase === 'ready' && plan.length > 0) {
    return plan.map((item) => ({
      key: item.milestone.key,
      name: item.milestone.label,
      date: formatLong(item.milestone.date),
      badge: statusLabel(item),
      checked: item.selected,
      selectable: true,
      muted: item.past,
      failed: false,
    }))
  }

  // idle and probing: dates are known, calendar status is not.
  return milestones.map((milestone) => {
    const past = milestone.date < todayDate
    return {
      key: milestone.key,
      name: milestone.label,
      date: formatLong(milestone.date),
      badge: past ? COPY.statusPast : COPY.statusUnknown,
      checked: !past,
      selectable: false,
      muted: past,
      failed: false,
    }
  })
}
