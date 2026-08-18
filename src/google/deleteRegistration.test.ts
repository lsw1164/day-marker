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

function apiWith(deleteEvent: CalendarApi['deleteEvent']): CalendarApi {
  return {
    getEvent: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    listEvents: vi.fn(),
    deleteEvent,
  } as unknown as CalendarApi
}

describe('deleteRegistration', () => {
  it('reports every event as deleted on a clean run', async () => {
    const api = apiWith(vi.fn(async () => 'deleted' as const))
    const out = await deleteRegistration(api, evs(3), () => {}, RETRY)
    expect(out.map((r) => r.outcome)).toEqual(['deleted', 'deleted', 'deleted'])
  })

  it('passes alreadyGone straight through as a success', async () => {
    const api = apiWith(vi.fn(async () => 'alreadyGone' as const))
    const out = await deleteRegistration(api, evs(2), () => {}, RETRY)
    expect(out.map((r) => r.outcome)).toEqual(['alreadyGone', 'alreadyGone'])
    expect(out.every((r) => r.error === undefined)).toBe(true)
  })

  it('retries a rate limit and then succeeds', async () => {
    let calls = 0
    const api = apiWith(
      vi.fn(async () => {
        calls += 1
        if (calls < 3) throw new RateLimited(429, 'rateLimitExceeded', '')
        return 'deleted' as const
      }),
    )
    const out = await deleteRegistration(api, evs(1), () => {}, RETRY)
    expect(out[0]?.outcome).toBe('deleted')
    expect(calls).toBe(3)
  })

  it('retries a rate limit and lands on alreadyGone as a success', async () => {
    // The first attempt can time out on the client side after the delete has
    // already landed at Google. The retry then sees a 404/410, which
    // deleteEvent resolves as 'alreadyGone' rather than throwing -- so the
    // retried outcome must still read as success, not 'failed'.
    let calls = 0
    const api = apiWith(
      vi.fn(async () => {
        calls += 1
        if (calls < 2) throw new RateLimited(429, 'rateLimitExceeded', '')
        return 'alreadyGone' as const
      }),
    )
    const out = await deleteRegistration(api, evs(1), () => {}, RETRY)
    expect(out[0]?.outcome).toBe('alreadyGone')
    expect(out[0]?.error).toBeUndefined()
    expect(calls).toBe(2)
  })

  it('fails an item once the attempts run out', async () => {
    const api = apiWith(
      vi.fn(async () => {
        throw new RateLimited(429, 'rateLimitExceeded', '')
      }),
    )
    const out = await deleteRegistration(api, evs(1), () => {}, RETRY)
    expect(out[0]?.outcome).toBe('failed')
    expect(out[0]?.error).toContain('429')
  })

  it('halts after a 401 and stops sending doomed requests', async () => {
    // FIVE events against a concurrency of 3. The halt can only short-circuit
    // items still QUEUED, so a 3-item version asserts something impossible.
    const deleteEvent = vi.fn(async () => {
      throw new Unauthorized(401, 'authError', '')
    })
    const out = await deleteRegistration(apiWith(deleteEvent), evs(5), () => {}, RETRY)
    expect(out).toHaveLength(5)
    expect(out.every((r) => r.outcome === 'failed')).toBe(true)
    expect(out.filter((r) => r.error === DELETE_HALTED)).toHaveLength(2)
    expect(deleteEvent).toHaveBeenCalledTimes(3)
  })

  it('preserves what already succeeded when the token dies mid-run', async () => {
    let calls = 0
    const deleteEvent = vi.fn(async () => {
      calls += 1
      if (calls > 1) throw new Unauthorized(401, 'authError', '')
      return 'deleted' as const
    })
    const out = await deleteRegistration(apiWith(deleteEvent), evs(3), () => {}, RETRY, 1)
    expect(out[0]?.outcome).toBe('deleted')
    expect(out.slice(1).every((r) => r.outcome === 'failed')).toBe(true)
  })

  it('reports each item once, as it lands, and returns them in input order', async () => {
    const seen: string[] = []
    const api = apiWith(vi.fn(async () => 'deleted' as const))
    const out = await deleteRegistration(api, evs(3), (r) => seen.push(r.event.id), RETRY)
    expect(seen).toHaveLength(3)
    expect(out.map((r) => r.event.id)).toEqual(['dm0', 'dm1', 'dm2'])
  })

  it('does nothing when given no events', async () => {
    const deleteEvent = vi.fn()
    const out = await deleteRegistration(apiWith(deleteEvent), [], () => {}, RETRY)
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
      deleteRegistration(apiWith(deleteEvent), evs(1), onProgress, RETRY),
    ).rejects.toThrow('render exploded')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.outcome).toBe('deleted')
    expect(seen[0]?.error).toBeUndefined()
  })
})
