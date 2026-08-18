import { describe, expect, it, vi } from 'vitest'
import { applyPlan, HALTED_MESSAGE, type ItemResult } from '@/google/apply'
import type { CalendarApi } from '@/google/calendarApi'
import { Conflict, RateLimited, Unauthorized } from '@/google/errors'
import type { PlanItem, PlanStatus } from '@/google/plan'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones } from '@/domain/milestones'
import type { EventOptions } from '@/domain/eventPayload'
import type { RetryDeps } from '@/lib/backoff'

const START = calendarDate('2026-01-01')
const OPTIONS: EventOptions = { start: START, label: '', reminder: 'day1' }

const RETRY: RetryDeps = { attempts: 3, baseMs: 1, sleep: async () => {}, random: () => 0.5 }

// Thirteen milestones, so a test can use more items than APPLY_CONCURRENCY (3).
// The halt can only short-circuit items still QUEUED, so a 3-item test would
// leave nothing queued and could never observe it.
const MILESTONES = computeMilestones(START, 3)

function item(index: number, status: PlanStatus, needsUpdate = false): PlanItem {
  return {
    milestone: MILESTONES[index]!,
    eventId: `dmtest${index}`,
    status,
    past: false,
    selected: true,
    needsUpdate,
  }
}

function stubApi(overrides: Partial<CalendarApi> = {}): CalendarApi {
  return {
    getEvent: vi.fn(async () => null),
    insertEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    patchEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    listEvents: vi.fn(async () => ({ items: [] })),
    deleteEvent: vi.fn(async () => 'deleted' as const),
    ...overrides,
  }
}

describe('applyPlan — outcomes', () => {
  it('inserts a new item and reports "added"', async () => {
    const api = stubApi()
    const [result] = await applyPlan(api, [item(0, 'new')], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('added')
    expect(api.insertEvent).toHaveBeenCalledTimes(1)
  })

  it('patches a deleted item and reports "restored"', async () => {
    const api = stubApi()
    const [result] = await applyPlan(api, [item(0, 'deleted')], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('restored')
    expect(api.patchEvent).toHaveBeenCalledTimes(1)
  })

  it('patches a drifted existing item and reports "updated"', async () => {
    const api = stubApi()
    const [result] = await applyPlan(api, [item(0, 'exists', true)], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('updated')
    expect(api.patchEvent).toHaveBeenCalledTimes(1)
  })

  it('skips an unchanged existing item without any write', async () => {
    const api = stubApi()
    const [result] = await applyPlan(api, [item(0, 'exists', false)], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('skipped')
    expect(api.patchEvent).not.toHaveBeenCalled()
    expect(api.insertEvent).not.toHaveBeenCalled()
  })

  it('sends the payload built from the milestone and options', async () => {
    const insertEvent = vi.fn(async () => ({ id: 'x', status: 'confirmed' as const }))
    await applyPlan(stubApi({ insertEvent }), [item(0, 'new')], { ...OPTIONS, label: 'Us' }, () => {}, RETRY)
    expect(insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dmtest0', summary: 'Us: Day 100' }),
    )
  })
})

describe('applyPlan — 409 fallback', () => {
  it('falls back to PATCH when a "new" insert hits a reserved ID', async () => {
    const insertEvent = vi.fn(async () => {
      throw new Conflict(409, 'duplicate', '')
    })
    const patchEvent = vi.fn(async () => ({ id: 'x', status: 'confirmed' as const }))
    const [result] = await applyPlan(
      stubApi({ insertEvent, patchEvent }),
      [item(0, 'new')],
      OPTIONS,
      () => {},
      RETRY,
    )
    expect(result?.outcome).toBe('updated')
    expect(patchEvent).toHaveBeenCalledTimes(1)
  })

  it('fails the item honestly when the fallback PATCH also fails', async () => {
    const insertEvent = vi.fn(async () => {
      throw new Conflict(409, 'duplicate', '')
    })
    const patchEvent = vi.fn(async () => {
      throw new Conflict(409, 'duplicate', 'cannot reuse id')
    })
    const [result] = await applyPlan(
      stubApi({ insertEvent, patchEvent }),
      [item(0, 'new')],
      OPTIONS,
      () => {},
      RETRY,
    )
    expect(result?.outcome).toBe('failed')
    expect(result?.error).toContain('409')
  })
})

describe('applyPlan — retry', () => {
  it('retries a rate limit and then succeeds', async () => {
    let calls = 0
    const insertEvent = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new RateLimited(429, 'rateLimitExceeded', '')
      return { id: 'x', status: 'confirmed' as const }
    })
    const [result] = await applyPlan(stubApi({ insertEvent }), [item(0, 'new')], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('added')
    expect(calls).toBe(3)
  })

  it('fails the item after the attempts run out', async () => {
    const insertEvent = vi.fn(async () => {
      throw new RateLimited(429, 'rateLimitExceeded', '')
    })
    const [result] = await applyPlan(stubApi({ insertEvent }), [item(0, 'new')], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('failed')
    expect(insertEvent).toHaveBeenCalledTimes(3)
  })
})

describe('applyPlan — halting on auth loss', () => {
  it('stops writing after a 401 and marks the rest failed', async () => {
    const insertEvent = vi.fn(async () => {
      throw new Unauthorized(401, 'authError', '')
    })
    // FIVE items against APPLY_CONCURRENCY of 3. The halt can only short-circuit
    // items still QUEUED: the first three are already in flight when the 401
    // lands, so they fail with the real error, and items 4 and 5 are the ones the
    // halt actually protects. A 3-item version of this test asserts something
    // structurally impossible — nothing is ever queued, so HALTED_MESSAGE can
    // never appear.
    const items = [item(0, 'new'), item(1, 'new'), item(2, 'new'), item(3, 'new'), item(4, 'new')]
    const results = await applyPlan(stubApi({ insertEvent }), items, OPTIONS, () => {}, RETRY)
    expect(results).toHaveLength(5)
    expect(results.every((r) => r.outcome === 'failed')).toBe(true)
    expect(results.filter((r) => r.error === HALTED_MESSAGE)).toHaveLength(2)
    // The point of halting: two doomed requests were never sent.
    expect(insertEvent).toHaveBeenCalledTimes(3)
  })

  it('keeps results that already succeeded', async () => {
    let calls = 0
    const insertEvent = vi.fn(async () => {
      calls += 1
      if (calls > 1) throw new Unauthorized(401, 'authError', '')
      return { id: 'x', status: 'confirmed' as const }
    })
    const items = [item(0, 'new'), item(1, 'new'), item(2, 'new')]
    // Concurrency 1 keeps the ordering deterministic for this assertion.
    const results = await applyPlan(stubApi({ insertEvent }), items, OPTIONS, () => {}, RETRY, 1)
    expect(results[0]?.outcome).toBe('added')
    expect(results.slice(1).every((r) => r.outcome === 'failed')).toBe(true)
  })
})

describe('applyPlan — a throwing progress callback', () => {
  it('rejects instead of resolving with undefined entries', async () => {
    // onProgress runs outside the try in the halted branch and again inside the
    // catch, so a throwing callback really does reject the slot. The old
    // unconditional `as PromiseFulfilledResult<ItemResult>` turned that into an
    // array of `undefined` — straight into React state, crashing the result
    // screen on `result.item.eventId`.
    const onProgress = () => {
      throw new Error('render exploded')
    }
    await expect(
      applyPlan(stubApi(), [item(0, 'new')], OPTIONS, onProgress, RETRY),
    ).rejects.toThrow('render exploded')
  })
})

describe('applyPlan — progress', () => {
  it('reports every item exactly once, as it lands', async () => {
    const seen: ItemResult[] = []
    const items = [item(0, 'new'), item(1, 'new'), item(2, 'new')]
    const results = await applyPlan(stubApi(), items, OPTIONS, (r) => seen.push(r), RETRY)
    expect(seen).toHaveLength(3)
    expect(seen.map((r) => r.item.eventId).sort()).toEqual(results.map((r) => r.item.eventId).sort())
  })

  it('returns results in input order', async () => {
    const items = [item(0, 'new'), item(1, 'new'), item(2, 'new')]
    const results = await applyPlan(stubApi(), items, OPTIONS, () => {}, RETRY)
    expect(results.map((r) => r.item.eventId)).toEqual(['dmtest0', 'dmtest1', 'dmtest2'])
  })
})
