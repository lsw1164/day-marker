import { describe, expect, it, vi } from 'vitest'
import { buildPlan } from '@/google/plan'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { Unauthorized } from '@/google/errors'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones } from '@/domain/milestones'
import type { EventOptions } from '@/domain/eventPayload'

const START = calendarDate('2026-01-01')
const TODAY = calendarDate('2026-06-01')
const OPTIONS: EventOptions = { start: START, label: '', reminder: 'day1' }

function apiReturning(byId: (id: string) => GoogleEvent | null): CalendarApi {
  return {
    getEvent: vi.fn(async (id: string) => byId(id)),
    insertEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    patchEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
  }
}

describe('buildPlan — classification', () => {
  it('marks a missing event as new', async () => {
    const plan = await buildPlan(apiReturning(() => null), computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan.every((i) => i.status === 'new')).toBe(true)
  })

  it('marks a confirmed event as exists', async () => {
    const api = apiReturning((id) => ({
      id,
      status: 'confirmed',
      summary: 'Day 100',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 900 }] },
    }))
    const plan = await buildPlan(api, computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan[0]?.status).toBe('exists')
  })

  it('marks a cancelled event as deleted', async () => {
    const api = apiReturning((id) => ({ id, status: 'cancelled' }))
    const plan = await buildPlan(api, computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan.every((i) => i.status === 'deleted')).toBe(true)
  })
})

describe('buildPlan — needsUpdate', () => {
  const matching = (id: string): GoogleEvent => ({
    id,
    status: 'confirmed',
    summary: 'Day 100',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 900 }] },
  })

  it('is false when title and reminder already match', async () => {
    const plan = await buildPlan(apiReturning(matching), computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan.find((i) => i.milestone.key === 'd100')?.needsUpdate).toBe(false)
  })

  it('is true when the label changed the title', async () => {
    const plan = await buildPlan(
      apiReturning(matching),
      computeMilestones(START, 1),
      { ...OPTIONS, label: 'Us' },
      TODAY,
    )
    expect(plan.find((i) => i.milestone.key === 'd100')?.needsUpdate).toBe(true)
  })

  it('is true when the reminder preset changed', async () => {
    const plan = await buildPlan(
      apiReturning(matching),
      computeMilestones(START, 1),
      { ...OPTIONS, reminder: 'week1' },
      TODAY,
    )
    expect(plan.find((i) => i.milestone.key === 'd100')?.needsUpdate).toBe(true)
  })

  it('is true when the existing event has no reminder override but one is wanted', async () => {
    const api = apiReturning((id) => ({ id, status: 'confirmed', summary: 'Day 100' }))
    const plan = await buildPlan(api, computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan.find((i) => i.milestone.key === 'd100')?.needsUpdate).toBe(true)
  })
})

describe('buildPlan — past and selection', () => {
  it('flags milestones before today as past', async () => {
    const plan = await buildPlan(apiReturning(() => null), computeMilestones(START, 1), OPTIONS, TODAY)
    // Day 100 is 2026-04-10 (past); Day 200 is 2026-07-19 (future).
    expect(plan.find((i) => i.milestone.key === 'd100')?.past).toBe(true)
    expect(plan.find((i) => i.milestone.key === 'd200')?.past).toBe(false)
  })

  it('does not treat today itself as past', async () => {
    const onToday = calendarDate('2026-04-10')
    const plan = await buildPlan(apiReturning(() => null), computeMilestones(START, 1), OPTIONS, onToday)
    expect(plan.find((i) => i.milestone.key === 'd100')?.past).toBe(false)
  })

  it('preselects everything except past milestones', async () => {
    const plan = await buildPlan(apiReturning(() => null), computeMilestones(START, 1), OPTIONS, TODAY)
    for (const item of plan) expect(item.selected).toBe(!item.past)
  })

  it('marks nothing as past for a start date in the future', async () => {
    // Planning ahead is legitimate: every milestone is future, so nothing is unchecked.
    const future = calendarDate('2027-01-01')
    const plan = await buildPlan(
      apiReturning(() => null),
      computeMilestones(future, 3),
      { ...OPTIONS, start: future },
      TODAY,
    )
    expect(plan).toHaveLength(13)
    expect(plan.some((i) => i.past)).toBe(false)
    expect(plan.every((i) => i.selected)).toBe(true)
  })
})

describe('buildPlan — mechanics', () => {
  it('probes one distinct event ID per milestone', async () => {
    const api = apiReturning(() => null)
    const milestones = computeMilestones(START, 3)
    const plan = await buildPlan(api, milestones, OPTIONS, TODAY)
    expect(api.getEvent).toHaveBeenCalledTimes(13)
    expect(new Set(plan.map((i) => i.eventId)).size).toBe(13)
  })

  it('keeps milestone order', async () => {
    const milestones = computeMilestones(START, 3)
    const plan = await buildPlan(apiReturning(() => null), milestones, OPTIONS, TODAY)
    expect(plan.map((i) => i.milestone.key)).toEqual(milestones.map((m) => m.key))
  })

  it('propagates an auth failure rather than reporting a bogus plan', async () => {
    const api: CalendarApi = {
      getEvent: vi.fn(async () => {
        throw new Unauthorized(401, 'authError', '')
      }),
      insertEvent: vi.fn(),
      patchEvent: vi.fn(),
    } as unknown as CalendarApi
    await expect(
      buildPlan(api, computeMilestones(START, 1), OPTIONS, TODAY),
    ).rejects.toBeInstanceOf(Unauthorized)
  })
})
