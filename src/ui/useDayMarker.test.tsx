import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDayMarker, type DayMarkerDeps } from '@/ui/useDayMarker'
import { COPY } from '@/ui/copy'
import { MISSING_CLIENT_ID, type Auth } from '@/google/auth'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { Unauthorized } from '@/google/errors'
import { calendarDate } from '@/domain/calendarDate'
import type { RetryDeps } from '@/lib/backoff'

const TODAY = calendarDate('2026-06-01')
const RETRY: RetryDeps = { attempts: 1, baseMs: 1, sleep: async () => {}, random: () => 0.5 }

function stubAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => 'tok'),
    clear: vi.fn(),
    ...overrides,
  }
}

function stubApi(getEvent: (id: string) => GoogleEvent | null = () => null): CalendarApi {
  return {
    getEvent: vi.fn(async (id: string) => getEvent(id)),
    insertEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    patchEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    listEvents: vi.fn(async () => ({ items: [] })),
  }
}

function deps(overrides: Partial<DayMarkerDeps> = {}): DayMarkerDeps {
  return {
    auth: stubAuth(),
    api: stubApi(),
    todayDate: TODAY,
    probeDelayMs: 0,
    retryDeps: RETRY,
    ...overrides,
  }
}

describe('useDayMarker — local computation', () => {
  it('starts idle with no milestones', () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    expect(result.current.phase).toBe('idle')
    expect(result.current.milestones).toEqual([])
  })

  it('computes milestones without connecting', () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01-01'))
    expect(result.current.milestones).toHaveLength(13)
    expect(result.current.connected).toBe(false)
  })

  it('clears milestones for an incomplete date', () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01'))
    expect(result.current.milestones).toEqual([])
  })

  it('recomputes when the range changes', () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01-01'))
    act(() => result.current.setYears(1))
    expect(result.current.milestones).toHaveLength(4)
  })
})

describe('useDayMarker — connecting and probing', () => {
  it('probes after connecting and reaches ready', async () => {
    const api = stubApi()
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(api.getEvent).toHaveBeenCalledTimes(13)
    expect(result.current.plan).toHaveLength(13)
  })

  it('preselects future milestones and leaves past ones off', async () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    const day100 = result.current.plan.find((i) => i.milestone.key === 'd100')
    expect(day100?.past).toBe(true)
    expect(day100?.selected).toBe(false)
  })

  it('surfaces a connect failure as an error and stays idle', async () => {
    const auth = stubAuth({
      connect: vi.fn(async () => {
        throw new Error('popup_closed')
      }),
    })
    const { result } = renderHook(() => useDayMarker(deps({ auth })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.error).toContain('popup_closed')
    expect(result.current.phase).toBe('idle')
  })

  it('translates a blocked popup into an actionable message', async () => {
    const auth = stubAuth({
      connect: vi.fn(async () => {
        throw new Error('popup_failed_to_open')
      }),
    })
    const { result } = renderHook(() => useDayMarker(deps({ auth })))
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.error).toBe(COPY.popupBlocked)
  })

  it('translates a missing client ID into setup instructions', async () => {
    const auth = stubAuth({
      connect: vi.fn(async () => {
        throw new Error(MISSING_CLIENT_ID)
      }),
    })
    const { result } = renderHook(() => useDayMarker(deps({ auth })))
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.error).toBe(COPY.missingClientId)
  })

  it('clears the pending flag and drops the connection when the probe fails', async () => {
    const api = stubApi()
    ;(api.getEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Unauthorized(401, 'authError', ''),
    )
    const auth = stubAuth()
    const { result } = renderHook(() => useDayMarker(deps({ api, auth })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.error).toContain('401'))
    expect(result.current.phase).toBe('idle')
    expect(result.current.connected).toBe(false)
    // The flag belongs to the probe that set it; leaving it set on the failure
    // path would outlive its owner.
    expect(result.current.reprobePending).toBe(false)
    expect(auth.clear).toHaveBeenCalled()
  })

  it('marks a re-probe pending as soon as the inputs change', async () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.reprobePending).toBe(false)

    // Synchronously true: the plan in hand was computed against the old label,
    // so nothing may be submitted until the fresh probe lands.
    act(() => result.current.setLabel('Us'))
    expect(result.current.reprobePending).toBe(true)
    // The plan itself is deliberately still there — only the action is blocked.
    expect(result.current.plan).toHaveLength(13)

    await waitFor(() => expect(result.current.reprobePending).toBe(false))
  })

  it('re-probes when the reminder changes', async () => {
    const api = stubApi()
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.setReminder('week1'))
    await waitFor(() => expect(api.getEvent).toHaveBeenCalledTimes(26))
  })
})

describe('useDayMarker — selection and counts', () => {
  it('toggles an item and updates the counts', async () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    const before = result.current.counts.add
    act(() => result.current.toggle('d300'))
    expect(result.current.counts.add).toBe(before - 1)
  })
})

describe('useDayMarker — submitting', () => {
  it('writes only the selected items and finishes done', async () => {
    const api = stubApi()
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    const selected = result.current.counts.selected
    await act(async () => {
      await result.current.submit()
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.results).toHaveLength(selected)
    expect(api.insertEvent).toHaveBeenCalledTimes(selected)
  })

  it('reports failures and exposes a failed count', async () => {
    const api = stubApi()
    ;(api.insertEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Unauthorized(401, 'authError', ''),
    )
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await act(async () => {
      await result.current.submit()
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.failedCount).toBeGreaterThan(0)
  })

  it('reset() re-probes rather than returning to a stale plan', async () => {
    const api = stubApi()
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await act(async () => {
      await result.current.submit()
    })
    const probesBeforeReset = (api.getEvent as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => result.current.reset())
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.results).toEqual([])
    // The plan in hand was stale after the write — every milestone must be
    // re-read, not reused.
    expect((api.getEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      probesBeforeReset + 13,
    )
  })
})
