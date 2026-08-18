import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useRegistrations, type RegistrationsDeps } from '@/ui/useRegistrations'
import type { Auth } from '@/google/auth'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { Unauthorized } from '@/google/errors'
import { DELETE_HALTED } from '@/google/registrations'
import { calendarDate } from '@/domain/calendarDate'
import { COPY } from '@/ui/copy'
import type { RetryDeps } from '@/lib/backoff'

const RETRY: RetryDeps = { attempts: 1, baseMs: 1, sleep: async () => {}, random: () => 0.5 }

function ev(id: string, startDate: string, key: string, date: string): GoogleEvent {
  return {
    id,
    status: 'confirmed',
    summary: `Anna & Ben: ${key}`,
    start: { date },
    extendedProperties: { private: { dayMarkerVersion: '1', startDate, milestoneKey: key } },
  }
}

function deps(over: Partial<RegistrationsDeps> = {}): RegistrationsDeps {
  const auth: Auth = {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => 'tok'),
    clear: vi.fn(),
  }
  const api = {
    getEvent: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(async () => 'deleted' as const),
    listEvents: vi.fn(async () => ({
      items: [ev('a', '2025-03-14', 'd100', '2025-06-21'), ev('b', '2025-03-14', 'y1', '2026-03-14')],
    })),
  } as unknown as CalendarApi
  return { auth, api, retryDeps: RETRY, ...over }
}

describe('useRegistrations', () => {
  it('loads on mount when a token already exists', async () => {
    const { result } = renderHook(() => useRegistrations(deps()))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.registrations).toHaveLength(1)
    expect(result.current.registrations[0]?.count).toBe(2)
  })

  it('stays idle with no token and does not query', async () => {
    const d = deps()
    ;(d.auth.token as ReturnType<typeof vi.fn>).mockReturnValue(null)
    const { result } = renderHook(() => useRegistrations(d))
    expect(result.current.phase).toBe('idle')
    expect(result.current.connected).toBe(false)
    expect(d.api.listEvents).not.toHaveBeenCalled()
  })

  it('loads after connecting', async () => {
    const d = deps()
    ;(d.auth.token as ReturnType<typeof vi.fn>).mockReturnValue(null)
    const { result } = renderHook(() => useRegistrations(d))
    ;(d.auth.token as ReturnType<typeof vi.fn>).mockReturnValue('tok')
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(d.api.listEvents).toHaveBeenCalled()
  })

  it('clears the previously-loaded list when a later refresh fails', async () => {
    // The brief's own version of this test rejected on the very first load,
    // before `registrations` was ever populated -- so `toEqual([])` passed
    // whether or not the catch branch actually cleared anything; the fixture
    // already satisfied the assertion. Succeeding once first, and failing on
    // a subsequent refresh, is what makes the clear a real behaviour to test:
    // without it, the stale one-item list would still be sitting in state.
    const d = deps()
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.registrations).toHaveLength(1)

    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('list exploded'))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.registrations).toEqual([])
  })

  it('flips connected to false after an Unauthorized load failure', async () => {
    // The token died; nothing further can be read with it, so the connect
    // prompt -- not a silent error banner over an empty list -- is the honest
    // next screen. useDayMarker does this on any probe failure; this hook
    // only does it for an auth failure specifically, because PAGINATION_LOOPED
    // is a real non-auth failure mode here and its own copy says "please try
    // again", which would be a lie if this had just signed the user out.
    const d = deps()
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Unauthorized(401, 'authError', ''),
    )
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.connected).toBe(false)
    expect(d.auth.clear).toHaveBeenCalled()
  })

  it('opens and cancels a confirm without deleting', async () => {
    const d = deps()
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))
    expect(result.current.confirming).toBe('2025-03-14')
    act(() => result.current.cancelConfirm())
    expect(result.current.confirming).toBeNull()
    expect(d.api.deleteEvent).not.toHaveBeenCalled()
  })

  it('deletes only the confirmed registration and lands in done', async () => {
    const d = deps()
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))
    await act(async () => {
      await result.current.confirmDelete()
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.results).toHaveLength(2)
    expect(d.api.deleteEvent).toHaveBeenCalledTimes(2)
  })

  it('refreshes the list when returning from done', async () => {
    // The list in hand is stale: the events just deleted are gone from the
    // calendar, so showing the old grouping would misreport what is registered.
    const d = deps()
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))
    await act(async () => {
      await result.current.confirmDelete()
    })
    const before = (d.api.listEvents as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => result.current.backToList())
    await waitFor(() =>
      expect((d.api.listEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1),
    )
  })

  it('does nothing when confirmDelete is called with nothing confirmed', async () => {
    const d = deps()
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await act(async () => {
      await result.current.confirmDelete()
    })
    expect(d.api.deleteEvent).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('ready')
  })

  // --- Supplementary tests beyond the brief -----------------------------
  //
  // These target the three hazards flagged for this task: a caller that
  // re-enters confirmDelete before the first run settles, stale `results`
  // leaking into a second confirm screen, and refresh() racing a delete. Each
  // is written to fail against the brief's reference implementation (which
  // guards confirmDelete only with a `registrations.find` lookup, and has no
  // guard at all on refresh) and pass only once the corresponding guard is in
  // place — see task-8-report.md for the RED runs.

  it('ignores a second confirmDelete call while one is already in flight', async () => {
    // A React state read (`phase`) inside a useCallback closure cannot catch
    // two synchronous calls in the same tick -- both see the same pre-update
    // `phase` value, because setPhase('deleting') has not flushed yet. Only a
    // plain ref, mutated synchronously before any await, can. This test fires
    // both calls in the same tick specifically to exercise that gap.
    const d = deps()
    // A queue, not a single variable: two concurrent deleteEvent calls (one
    // per event) each get their own resolver, and overwriting a single
    // variable would silently strand whichever call was not the last to
    // register -- its promise would never settle and the run would hang
    // rather than fail loudly.
    const resolvers: ((v: 'deleted') => void)[] = []
    ;(d.api.deleteEvent as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    )
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))

    let firstDone = false
    let secondDone = false
    act(() => {
      void result.current.confirmDelete().then(() => (firstDone = true))
      void result.current.confirmDelete().then(() => (secondDone = true))
    })

    await waitFor(() => expect(result.current.phase).toBe('deleting'))
    // Only the first call's two events should have started a delete. A
    // second, unguarded run would have started two more (4 total).
    expect(d.api.deleteEvent).toHaveBeenCalledTimes(2)

    act(() => resolvers.forEach((r) => r('deleted')))
    await waitFor(() => expect(firstDone && secondDone).toBe(true))
    await waitFor(() => expect(result.current.phase).toBe('done'))
    expect(d.api.deleteEvent).toHaveBeenCalledTimes(2)
    expect(result.current.results).toHaveLength(2)
  })

  it('clears stale results the instant a second delete run begins', async () => {
    // deleteRegistration's own onProgress accumulator always starts from [],
    // but that says nothing about what the *previous* run left in `results`
    // until the new run's first progress callback fires. A caller rendering
    // between confirmDelete's call and its first callback must not see a
    // report for events it has not touched yet.
    const d = deps()
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        ev('a', '2025-03-14', 'd100', '2025-06-21'),
        ev('b', '2025-03-14', 'y1', '2026-03-14'),
        ev('c', '2020-01-01', 'y1', '2021-01-01'),
      ],
    })
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))
    await act(async () => {
      await result.current.confirmDelete()
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.results).toHaveLength(2)

    // Deliberately not going through backToList(): that helper clears
    // `results` itself on the way back to the list, which would make this
    // assertion pass regardless of whether confirmDelete resets anything --
    // exactly the kind of fixture-already-satisfies-it test that proves
    // nothing. Moving straight to a second confirm leaves the first run's
    // `results` sitting in state until confirmDelete's own reset (or its
    // absence) decides what happens to them.
    let resolveSecond!: (v: 'deleted') => void
    ;(d.api.deleteEvent as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => (resolveSecond = resolve)),
    )
    act(() => result.current.beginConfirm(calendarDate('2020-01-01')))
    let inFlight!: Promise<void>
    act(() => {
      inFlight = result.current.confirmDelete()
    })
    // Synchronously cleared, before the new run's single event has any outcome.
    expect(result.current.results).toEqual([])

    act(() => resolveSecond('deleted'))
    await act(async () => {
      await inFlight
    })
    expect(result.current.results).toHaveLength(1)
  })

  it('does not let a refresh mid-delete knock the phase out of deleting', async () => {
    // refresh() is never wired to a visible control while a delete runs (Task
    // 10 only calls it from backToList, reachable only once phase is 'done'),
    // but the hook's own contract should not depend on that -- nothing about
    // the exposed API says refresh() may only be called from 'ready'. Without
    // a guard, calling it here would flip phase 'deleting' -> 'loading' ->
    // 'ready' while the delete is still running, and then back to 'done'
    // once it resolves: a visible flicker back to the list mid-delete.
    const d = deps()
    // See the resolver-queue comment in the re-entrancy test above: two
    // concurrent deleteEvent calls need two independently held resolvers.
    const resolvers: ((v: 'deleted') => void)[] = []
    ;(d.api.deleteEvent as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    )
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))

    let finished!: Promise<void>
    act(() => {
      finished = result.current.confirmDelete()
    })
    await waitFor(() => expect(result.current.phase).toBe('deleting'))
    const callsBeforeRefresh = (d.api.listEvents as ReturnType<typeof vi.fn>).mock.calls.length

    act(() => result.current.refresh())
    // A refresh mid-delete must not requery the list or move the phase.
    expect((d.api.listEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBeforeRefresh,
    )
    expect(result.current.phase).toBe('deleting')

    act(() => resolvers.forEach((r) => r('deleted')))
    await act(async () => {
      await finished
    })
    expect(result.current.phase).toBe('done')
  })

  it('keeps confirming on the deleting row when beginConfirm targets another row mid-delete', async () => {
    // Task 9 renders the "Delete…" button whenever a row is in the 'list'
    // state, which every row except the active one is -- including while
    // that active row is 'deleting'. If beginConfirm retargeted `confirming`
    // here, the deleting row would drop back to 'list' and lose its progress
    // display, and because Task 9 matches results by event id, the running
    // delete's outcomes would then render against no row at all: the user
    // starts an un-undoable operation and loses every trace of what it did.
    const d = deps()
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        ev('a', '2025-03-14', 'd100', '2025-06-21'),
        ev('b', '2025-03-14', 'y1', '2026-03-14'),
        ev('c', '2020-01-01', 'y1', '2021-01-01'),
      ],
    })
    // Genuinely mid-run, not already settled -- a resolver queue holds the
    // delete open so the retarget attempt lands while phase is still
    // 'deleting', not after it has already resolved to 'done'.
    const resolvers: ((v: 'deleted') => void)[] = []
    ;(d.api.deleteEvent as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    )
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))

    let finished!: Promise<void>
    act(() => {
      finished = result.current.confirmDelete()
    })
    await waitFor(() => expect(result.current.phase).toBe('deleting'))

    act(() => result.current.beginConfirm(calendarDate('2020-01-01')))
    expect(result.current.confirming).toBe('2025-03-14')

    act(() => resolvers.forEach((r) => r('deleted')))
    await act(async () => {
      await finished
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.results).toHaveLength(2)
  })

  it('leaves confirming set when cancelConfirm is called mid-delete', async () => {
    // Same hazard as above, reached through cancelConfirm instead of a
    // retarget: clearing `confirming` while the delete it names is still
    // running would drop that row back to 'list' with nowhere for its
    // results to land.
    const d = deps()
    const resolvers: ((v: 'deleted') => void)[] = []
    ;(d.api.deleteEvent as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    )
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))

    let finished!: Promise<void>
    act(() => {
      finished = result.current.confirmDelete()
    })
    await waitFor(() => expect(result.current.phase).toBe('deleting'))

    act(() => result.current.cancelConfirm())
    expect(result.current.confirming).toBe('2025-03-14')

    act(() => resolvers.forEach((r) => r('deleted')))
    await act(async () => {
      await finished
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.results).toHaveLength(2)
  })

  it('translates a repeated page token into the pagination-looped copy, and leaves connected true', async () => {
    // The arm that matters here is "leaves connected true": PAGINATION_LOOPED
    // is not an auth failure, and its own copy tells the user to just try
    // again -- which would be a lie if this had disconnected them. Pinning
    // only the copy translation would pass just as well against a mutant
    // that disconnects on every load failure, auth or not.
    const d = deps()
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      nextPageToken: 'same-token',
    })
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.error).toBe(COPY.paginationLooped))
    expect(result.current.connected).toBe(true)
    expect(d.auth.clear).not.toHaveBeenCalled()
  })

  it('disconnects instead of refreshing when the finished run halted', async () => {
    // FIVE events against the hook's default delete concurrency of 3 -- the
    // same recipe deleteRegistration.test.ts uses to force a real
    // DELETE_HALTED stand-in (mapWithLimit's first three workers all claim
    // their indices before any of them fails, so the 401 that sets `halted`
    // can only short-circuit an item still queued behind it). Genuinely
    // exercising deleteRegistration's own halt logic here, rather than
    // fabricating a `results` array by hand, is what proves the hook reacts
    // to the sentinel deleteRegistration actually produces.
    const d = deps()
    const items = Array.from({ length: 5 }, (_, i) =>
      ev(`e${i}`, '2025-03-14', 'd100', `2025-06-${21 + i}`),
    )
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({ items })
    ;(d.api.deleteEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Unauthorized(401, 'authError', ''),
    )
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))
    await act(async () => {
      await result.current.confirmDelete()
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.results.some((r) => r.error === DELETE_HALTED)).toBe(true)

    const listCallsBefore = (d.api.listEvents as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => result.current.backToList())
    expect(result.current.connected).toBe(false)
    expect(d.auth.clear).toHaveBeenCalled()
    // Reconnecting is the user's job now, not a requery with the token we
    // already know is dead.
    expect((d.api.listEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      listCallsBefore,
    )
  })

  it('does not let backToList escape a delete in flight', async () => {
    // Same "the user loses sight of an un-undoable delete" hazard the
    // deletingRef guard already closed for beginConfirm/cancelConfirm,
    // reached through the one entry point that guard round left open.
    const d = deps()
    const resolvers: ((v: 'deleted') => void)[] = []
    ;(d.api.deleteEvent as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    )
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))

    let finished!: Promise<void>
    act(() => {
      finished = result.current.confirmDelete()
    })
    await waitFor(() => expect(result.current.phase).toBe('deleting'))

    act(() => result.current.backToList())
    expect(result.current.confirming).toBe('2025-03-14')
    expect(result.current.phase).toBe('deleting')

    act(() => resolvers.forEach((r) => r('deleted')))
    await act(async () => {
      await finished
    })
    expect(result.current.phase).toBe('done')
  })

  it('routes to reconnect, rather than retargeting, when beginConfirm follows a halted done summary', async () => {
    // The gap round 1's deletingRef guard did not close: by the time phase
    // reaches 'done', deletingRef is false again (the delete is over), so
    // beginConfirm(otherRow) would go straight through -- discarding the
    // halted summary and the only chance to act on COPY.deleteHalted's
    // "go back and reconnect" instruction, without the user ever touching
    // backToList. Task 10's per-row layout makes this reachable: every row
    // except the active one renders in 'list' state with a live Delete…
    // button, including while the active row is showing a halted 'done'.
    const d = deps()
    const items = Array.from({ length: 5 }, (_, i) =>
      ev(`e${i}`, '2025-03-14', 'd100', `2025-06-${21 + i}`),
    )
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [...items, ev('f', '2020-01-01', 'y1', '2021-01-01')],
    })
    ;(d.api.deleteEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Unauthorized(401, 'authError', ''),
    )
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))
    await act(async () => {
      await result.current.confirmDelete()
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.results.some((r) => r.error === DELETE_HALTED)).toBe(true)

    act(() => result.current.beginConfirm(calendarDate('2020-01-01')))
    expect(result.current.confirming).toBeNull()
    expect(result.current.connected).toBe(false)
  })

  it('does not reload on every render when the caller rebuilds api/auth fresh each render', async () => {
    // Task 10 calls useRegistrations({ auth: deps.auth, api: deps.api,
    // retryDeps: deps.retryDeps }) as a fresh object literal inside its
    // render body. main.tsx keeps the underlying auth/api as module-level
    // singletons today, so in production this wrapper churn alone is
    // harmless -- but nothing in this hook's contract depends on that
    // discipline holding, and the historical incident this guards against
    // (884 to 8,463 real Google Calendar requests in one run of an earlier
    // hook in this project) was exactly a caller that did not keep it. This
    // test reconstructs auth/api themselves fresh every render -- the worst
    // case the apiRef/authRef pattern exists to tolerate -- rather than only
    // the wrapper, so a regression back to depending on api/auth directly
    // shows up here rather than staying invisible behind a caller that
    // happens to keep them stable.
    let listEventsCalls = 0
    function freshDeps(): RegistrationsDeps {
      const auth: Auth = {
        connect: vi.fn(async () => 'tok'),
        token: vi.fn(() => 'tok'),
        clear: vi.fn(),
      }
      const api = {
        getEvent: vi.fn(),
        insertEvent: vi.fn(),
        patchEvent: vi.fn(),
        deleteEvent: vi.fn(),
        listEvents: vi.fn(async () => {
          listEventsCalls += 1
          return { items: [] }
        }),
      } as unknown as CalendarApi
      return { auth, api, retryDeps: RETRY }
    }

    const { result, rerender } = renderHook(() => useRegistrations(freshDeps()))
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    act(() => {
      for (let i = 0; i < 20; i += 1) rerender()
    })

    // Loading is driven by [connected, loadNonce] alone. A caller rebuilding
    // api/auth every render must not add a single extra request.
    expect(listEventsCalls).toBe(1)
  })
})
