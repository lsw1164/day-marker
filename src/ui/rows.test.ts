import { describe, expect, it } from 'vitest'
import { buildRows } from '@/ui/rows'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones } from '@/domain/milestones'
import type { PlanItem } from '@/google/plan'
import type { ItemResult } from '@/google/apply'
import { COPY } from '@/ui/copy'

const START = calendarDate('2026-01-01')
const TODAY = calendarDate('2026-06-01')
const MILESTONES = computeMilestones(START, 1)

function planItem(i: number, over: Partial<PlanItem> = {}): PlanItem {
  return {
    milestone: MILESTONES[i]!,
    eventId: `dm${i}`,
    status: 'new',
    past: false,
    selected: true,
    needsUpdate: false,
    ...over,
  }
}

describe('buildRows — idle', () => {
  it('renders every milestone with an unknown badge', () => {
    const rows = buildRows({
      phase: 'idle',
      milestones: MILESTONES,
      plan: [],
      results: [],
      todayDate: TODAY,
    })
    expect(rows).toHaveLength(4)
    expect(rows[1]?.badge).toBe(COPY.statusUnknown)
    expect(rows[1]?.name).toBe('Day 200')
    expect(rows[1]?.date).toBe('Jul 19, 2026')
    expect(rows[0]?.date).toBe('Apr 10, 2026')
  })

  it('marks past milestones even before connecting', () => {
    const rows = buildRows({
      phase: 'idle',
      milestones: MILESTONES,
      plan: [],
      results: [],
      todayDate: TODAY,
    })
    expect(rows[0]).toMatchObject({ badge: COPY.statusPast, checked: false, muted: true })
  })

  it('is not selectable before connecting', () => {
    const rows = buildRows({
      phase: 'idle',
      milestones: MILESTONES,
      plan: [],
      results: [],
      todayDate: TODAY,
    })
    expect(rows.every((r) => r.selectable === false)).toBe(true)
  })
})

describe('buildRows — ready', () => {
  it('shows the real status badge and selection', () => {
    const plan = [
      planItem(0, { status: 'exists', past: true, selected: false }),
      planItem(1, { status: 'deleted' }),
      planItem(2, { status: 'new' }),
    ]
    const rows = buildRows({ phase: 'ready', milestones: MILESTONES, plan, results: [], todayDate: TODAY })
    expect(rows.map((r) => r.badge)).toEqual([COPY.statusPast, COPY.statusDeleted, COPY.statusNew])
    expect(rows.map((r) => r.checked)).toEqual([false, true, true])
    expect(rows.every((r) => r.selectable)).toBe(true)
  })
})

describe('buildRows — applying and done', () => {
  const plan = [planItem(0), planItem(1), planItem(2, { selected: false })]

  it('shows only the selected items', () => {
    const rows = buildRows({ phase: 'applying', milestones: MILESTONES, plan, results: [], todayDate: TODAY })
    expect(rows).toHaveLength(2)
  })

  it('marks items without a result yet as queued', () => {
    const rows = buildRows({ phase: 'applying', milestones: MILESTONES, plan, results: [], todayDate: TODAY })
    expect(rows.every((r) => r.badge === COPY.queued)).toBe(true)
  })

  it('shows each landed outcome', () => {
    const results: ItemResult[] = [{ item: plan[0]!, outcome: 'added' }]
    const rows = buildRows({ phase: 'applying', milestones: MILESTONES, plan, results, todayDate: TODAY })
    expect(rows[0]?.badge).toBe('Added')
    expect(rows[1]?.badge).toBe(COPY.queued)
  })

  it('flags failures', () => {
    const results: ItemResult[] = [{ item: plan[0]!, outcome: 'failed', error: '401' }]
    const rows = buildRows({ phase: 'done', milestones: MILESTONES, plan, results, todayDate: TODAY })
    expect(rows[0]).toMatchObject({ badge: 'Failed', failed: true })
  })

  it('is not selectable while applying', () => {
    const rows = buildRows({ phase: 'applying', milestones: MILESTONES, plan, results: [], todayDate: TODAY })
    expect(rows.every((r) => r.selectable === false)).toBe(true)
  })
})
