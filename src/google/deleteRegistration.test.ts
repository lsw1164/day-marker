import { describe, expect, it, vi } from 'vitest'
import {
  deleteRegistration,
  DELETE_HALTED,
  type DeleteResult,
  type RegistrationEvent,
} from '@/google/registrations'
import type { CalendarApi } from '@/google/calendarApi'
import { RateLimited, Unauthorized } from '@/google/errors'
import { calendarDate } from '@/domain/calendarDate'
import type { RetryDeps } from '@/lib/backoff'

const RETRY: RetryDeps = { attempts: 3, baseMs: 1, sleep: async () => {}, random: () => 0.5 }

function evs(n: number): RegistrationEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `dm${i}`,
    date: calendarDate('2026-01-01'),
    label: `Day ${(i + 1) * 100}`,
  }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Mirrors apply.test.ts's stubApi rather than casting through `unknown`: a
// bare `as unknown as CalendarApi` unchecks the three stubs this suite
// doesn't exercise, and Task 4 removed exactly that cast pattern so a
// CalendarApi signature change breaks mocks at compile time instead of
// silently passing a mock that no longer matches.
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

describe('deleteRegistration', () => {
  it('reports every event as deleted on a clean run, deleting exactly the ids it was given', async () => {
    const deleteEvent = vi.fn(async (_id: string) => 'deleted' as const)
    const out = await deleteRegistration(stubApi({ deleteEvent }), evs(3), () => {}, RETRY)
    expect(out.map((r) => r.outcome)).toEqual(['deleted', 'deleted', 'deleted'])
    // The count of calls proves nothing about *which* events were touched.
    // A mutant that deletes events[0] three times, or appends a stray
    // character to every id, still makes three calls and still resolves
    // 'deleted' three times -- only the actual arguments catch it.
    expect(deleteEvent.mock.calls.map((c) => c[0])).toEqual(['dm0', 'dm1', 'dm2'])
  })

  it('passes alreadyGone straight through as a success', async () => {
    const deleteEvent = vi.fn(async () => 'alreadyGone' as const)
    const out = await deleteRegistration(stubApi({ deleteEvent }), evs(2), () => {}, RETRY)
    expect(out.map((r) => r.outcome)).toEqual(['alreadyGone', 'alreadyGone'])
    expect(out.every((r) => r.error === undefined)).toBe(true)
  })

  it('retries a rate limit and then succeeds', async () => {
    let calls = 0
    const deleteEvent = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new RateLimited(429, 'rateLimitExceeded', '')
      return 'deleted' as const
    })
    const out = await deleteRegistration(stubApi({ deleteEvent }), evs(1), () => {}, RETRY)
    expect(out[0]?.outcome).toBe('deleted')
    expect(calls).toBe(3)
  })

  it('retries a rate limit and lands on alreadyGone as a success', async () => {
    // The first attempt can time out on the client side after the delete has
    // already landed at Google. The retry then sees a 404/410, which
    // deleteEvent resolves as 'alreadyGone' rather than throwing -- so the
    // retried outcome must still read as success, not 'failed'.
    let calls = 0
    const deleteEvent = vi.fn(async () => {
      calls += 1
      if (calls < 2) throw new RateLimited(429, 'rateLimitExceeded', '')
      return 'alreadyGone' as const
    })
    const out = await deleteRegistration(stubApi({ deleteEvent }), evs(1), () => {}, RETRY)
    expect(out[0]?.outcome).toBe('alreadyGone')
    expect(out[0]?.error).toBeUndefined()
    expect(calls).toBe(2)
  })

  it('fails an item once the attempts run out', async () => {
    const deleteEvent = vi.fn(async () => {
      throw new RateLimited(429, 'rateLimitExceeded', '')
    })
    const out = await deleteRegistration(stubApi({ deleteEvent }), evs(1), () => {}, RETRY)
    expect(out[0]?.outcome).toBe('failed')
    expect(out[0]?.error).toContain('429')
  })

  it('halts after a 401 and stops sending doomed requests', async () => {
    // FIVE events against a concurrency of 3. The three initial workers all
    // claim their indices, and hence all make their own real attempt, before
    // any of them can observe another's failure -- so when the underlying
    // cause is a dead token, all three independently get a real 401, not
    // just whichever one happens to set `halted` first. All three are
    // stamped DELETE_HALTED for the same reason the two never-attempted rows
    // (dm3, dm4) are: the run halted on a dead token, and DELETE_HALTED
    // records that fact about the run, not merely "this item was skipped".
    // Only two events (dm3, dm4) are ever attributed to being *unattempted*,
    // which the deleteEvent-call-count assertion below still pins.
    const deleteEvent = vi.fn(async () => {
      throw new Unauthorized(401, 'authError', '')
    })
    const seen: string[] = []
    const out = await deleteRegistration(
      stubApi({ deleteEvent }),
      evs(5),
      (r) => seen.push(r.event.id),
      RETRY,
    )
    expect(out).toHaveLength(5)
    expect(out.every((r) => r.outcome === 'failed')).toBe(true)
    const halted = out.filter((r) => r.error === DELETE_HALTED)
    expect(halted).toHaveLength(5)
    expect(halted.map((r) => r.event.id).sort()).toEqual(['dm0', 'dm1', 'dm2', 'dm3', 'dm4'])
    // The three initial workers each make exactly one real attempt; dm3 and
    // dm4 never call deleteEvent at all -- that is the actual, narrower claim
    // "stops sending doomed requests" makes, and it is unaffected by which
    // string ends up in `error`.
    expect(deleteEvent).toHaveBeenCalledTimes(3)
    // onProgress must still fire for every one of the five events, including
    // the two that were never attempted -- a silently dropped progress call
    // would leave a live results screen stuck at "3 of 5" forever.
    expect(seen).toHaveLength(5)
    expect(seen).toEqual(expect.arrayContaining(['dm0', 'dm1', 'dm2', 'dm3', 'dm4']))
  })

  it('stamps DELETE_HALTED on a halt with nothing queued behind it', async () => {
    // At concurrency 3, a run of 3 or fewer events has nothing left queued
    // once the initial workers claim every index -- so before this fix, a
    // halt on a small registration produced only raw 401 text and no
    // DELETE_HALTED anywhere, silently disabling ui/'s reconnect path for
    // exactly the registrations most likely to have drifted out of sync
    // with the calendar (few events left to delete because most were
    // already removed by hand).
    const deleteEvent = vi.fn(async () => {
      throw new Unauthorized(401, 'authError', '')
    })
    const out = await deleteRegistration(stubApi({ deleteEvent }), evs(3), () => {}, RETRY)
    expect(out.every((r) => r.outcome === 'failed')).toBe(true)
    expect(out.some((r) => r.error === DELETE_HALTED)).toBe(true)
  })

  it('stamps DELETE_HALTED on a halted single-event run', async () => {
    const deleteEvent = vi.fn(async () => {
      throw new Unauthorized(401, 'authError', '')
    })
    const out = await deleteRegistration(stubApi({ deleteEvent }), evs(1), () => {}, RETRY)
    expect(out[0]?.outcome).toBe('failed')
    expect(out[0]?.error).toBe(DELETE_HALTED)
  })

  it('preserves what already succeeded when the token dies mid-run', async () => {
    let calls = 0
    const deleteEvent = vi.fn(async () => {
      calls += 1
      if (calls > 1) throw new Unauthorized(401, 'authError', '')
      return 'deleted' as const
    })
    const out = await deleteRegistration(stubApi({ deleteEvent }), evs(3), () => {}, RETRY, 1)
    expect(out[0]?.outcome).toBe('deleted')
    expect(out.slice(1).every((r) => r.outcome === 'failed')).toBe(true)
  })

  it('reports each item once, as it lands, and returns them in input order', async () => {
    const seen: string[] = []
    const deleteEvent = vi.fn(async () => 'deleted' as const)
    const out = await deleteRegistration(
      stubApi({ deleteEvent }),
      evs(3),
      (r) => seen.push(r.event.id),
      RETRY,
    )
    expect(seen).toHaveLength(3)
    expect(out.map((r) => r.event.id)).toEqual(['dm0', 'dm1', 'dm2'])
  })

  it('keeps every row aligned with its own event when a mixed run lands out of order', async () => {
    // All nine other tests use mocks that resolve identically and instantly,
    // so completion order coincidentally equals input order every time --
    // which means a "simpler" refactor that just appends results as they
    // land, instead of writing them into their original slot, would pass
    // every one of them. This test forces genuinely different completion
    // times so that refactor is observably wrong: dm2 answers fastest, dm0
    // second, and dm1 slowest because it's rate-limited on every attempt and
    // really sleeps between them.
    const byId: Record<string, () => Promise<'deleted' | 'alreadyGone'>> = {
      dm0: async () => {
        await sleep(30)
        return 'deleted' as const
      },
      dm1: async () => {
        await sleep(20)
        throw new RateLimited(429, 'rateLimitExceeded', '')
      },
      dm2: async () => {
        await sleep(1)
        return 'alreadyGone' as const
      },
    }
    const deleteEvent = vi.fn(async (id: string) => {
      const handler = byId[id]
      if (!handler) throw new Error(`unexpected id: ${id}`)
      return handler()
    })
    const seen: string[] = []
    const out = await deleteRegistration(
      stubApi({ deleteEvent }),
      evs(3),
      (r) => seen.push(r.event.id),
      RETRY,
    )
    // Every id was targeted exactly once each attempt; dm1 is retried up to
    // RETRY.attempts times, so check the set of distinct ids touched rather
    // than a call count.
    expect(new Set(deleteEvent.mock.calls.map((c) => c[0]))).toEqual(new Set(['dm0', 'dm1', 'dm2']))
    // Observed empirically: dm2 (~1ms) lands first, dm0 (~30ms) second, and
    // dm1 last because it retries three times (~20ms per attempt, no backoff
    // delay since RETRY.sleep is a no-op) before it gives up. This is the
    // proof that "as it lands" and "in input order" are different orderings
    // for the same run.
    expect(seen).toEqual(['dm2', 'dm0', 'dm1'])
    expect(out.map((r): [string, DeleteResult['outcome']] => [r.event.id, r.outcome])).toEqual([
      ['dm0', 'deleted'],
      ['dm1', 'failed'],
      ['dm2', 'alreadyGone'],
    ])
  })

  it('does nothing when given no events', async () => {
    const deleteEvent = vi.fn()
    const out = await deleteRegistration(stubApi({ deleteEvent }), [], () => {}, RETRY)
    expect(out).toEqual([])
    expect(deleteEvent).not.toHaveBeenCalled()
  })

  it('rejects rather than mislabel a completed deletion when onProgress throws', async () => {
    // Regression test: onProgress used to run *inside* the try, so a
    // callback that threw while handling a genuine success fell into the
    // catch block below it, which rewrote the already-successful outcome as
    // 'failed' with the callback's own error message -- reporting a deleted
    // event as not deleted, on a path with no undo -- and then called
    // onProgress a *second* time with that fabricated failure, which is what
    // actually produced the rejection. A bare `.rejects.toThrow` cannot tell
    // that apart from the fixed behaviour, because both end up rejecting
    // with the same message: this asserts onProgress was only ever called
    // once, and with the true 'deleted' outcome, before the reject happened.
    const seen: DeleteResult[] = []
    const onProgress = (result: DeleteResult) => {
      seen.push(result)
      throw new Error('render exploded')
    }
    const deleteEvent = vi.fn(async () => 'deleted' as const)
    await expect(
      deleteRegistration(stubApi({ deleteEvent }), evs(1), onProgress, RETRY),
    ).rejects.toThrow('render exploded')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.outcome).toBe('deleted')
    expect(seen[0]?.error).toBeUndefined()
  })
})
