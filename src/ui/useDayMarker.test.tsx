import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDayMarker, type DayMarkerDeps } from '@/ui/useDayMarker'
import { COPY } from '@/ui/copy'
import { MISSING_CLIENT_ID, type Auth } from '@/google/auth'
import type { AppCalendar } from '@/google/appCalendar'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { Unauthorized } from '@/google/errors'
import { calendarDate } from '@/domain/calendarDate'
import type { RetryDeps } from '@/lib/backoff'

const TODAY = calendarDate('2026-06-01')
const RETRY: RetryDeps = { attempts: 1, baseMs: 1, sleep: async () => {}, random: () => 0.5 }

/**
 * `token: () => null` is the honest default: it means "cold load, nothing
 * granted yet", which is the precondition of every disconnected assertion
 * below. A stub that always answered with a token would make those assertions
 * unfalsifiable now that the hook derives `connected` from it -- so a test that
 * wants a live session states so, and says which one.
 */
function stubAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => null),
    clear: vi.fn(),
    ...overrides,
  }
}

/** A session that outlived the component that opened it -- see Root.test.tsx. */
function liveAuth(): Auth {
  return stubAuth({ token: vi.fn(() => 'tok') })
}

/**
 * A behavioural fake: `token()` answers from the slot `connect()` fills and
 * `clear()` empties, as the real closure in `google/auth.ts` does. Signing out
 * cannot be observed against a stub whose `token()` is a constant -- the whole
 * point of it is that the token stops being there.
 */
function sessionAuth(): Auth {
  let live: string | null = null
  return {
    connect: vi.fn(async () => {
      live = 'tok'
      return live
    }),
    token: vi.fn(() => live),
    clear: vi.fn(() => {
      live = null
    }),
  }
}

function stubApi(getEvent: (id: string) => GoogleEvent | null = () => null): CalendarApi {
  return {
    getEvent: vi.fn(async (id: string) => getEvent(id)),
    insertEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    patchEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    listEvents: vi.fn(async () => ({ items: [] })),
    deleteEvent: vi.fn(async () => 'deleted' as const),
  }
}

function stubCalendar(overrides: Partial<AppCalendar> = {}): AppCalendar {
  return {
    ensure: vi.fn(async () => 'cal-1'),
    id: vi.fn(() => 'cal-1'),
    forget: vi.fn(),
    ...overrides,
  }
}

function deps(overrides: Partial<DayMarkerDeps> = {}): DayMarkerDeps {
  return {
    auth: stubAuth(),
    api: stubApi(),
    calendar: stubCalendar(),
    todayDate: TODAY,
    probeDelayMs: 0,
    retryDeps: RETRY,
    ...overrides,
  }
}

describe('useDayMarker — the signed-in address', () => {
  it('surfaces the address after connecting', async () => {
    const d = deps({
      account: {
        ensure: vi.fn(async () => 'anna@example.com'),
        email: vi.fn(() => 'anna@example.com'),
        forget: vi.fn(),
      },
    })
    const { result } = renderHook(() => useDayMarker(d))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.email).toBe('anna@example.com'))
  })

  it('shows the address on a fresh mount, as a tab switch produces', async () => {
    // The bug this guards: a <Route element> unmounts on navigation, so a fresh
    // hook is what the other tab renders. Seeded from '' the address vanished on
    // every tab change and never returned, because ensure() only runs from
    // connect() and the user is already connected by then. `connected` survives
    // the same trip by deriving from the token; this has to derive from the
    // resolver for the same reason.
    const account = {
      ensure: vi.fn(async () => 'anna@example.com'),
      email: vi.fn(() => 'anna@example.com'),
      forget: vi.fn(),
    }
    const { result } = renderHook(() => useDayMarker(deps({ account })))
    expect(result.current.email).toBe('anna@example.com')
    // Read from the cache, not re-fetched: the address is already known.
    expect(account.ensure).not.toHaveBeenCalled()
  })

  it('connects anyway when the address cannot be read', async () => {
    // The arm the optional-scope design rests on. `userinfo.email` is requested
    // but not verified, so a user who declines that one box gets a 403 here --
    // and must still get a working app, not a failed connection with an error
    // alert about a display detail.
    const forget = vi.fn()
    const d = deps({
      account: {
        ensure: vi.fn(async () => {
          throw new Error('403 insufficient scope')
        }),
        email: vi.fn(() => ''),
        forget,
      },
    })
    const { result } = renderHook(() => useDayMarker(d))
    await act(async () => {
      await expect(result.current.connect()).resolves.toBe(true)
    })
    expect(result.current.connected).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.email).toBe('')
  })

  it('drops the address on sign-out, with the token that identified it', async () => {
    const forget = vi.fn()
    const d = deps({
      account: {
        ensure: vi.fn(async () => 'anna@example.com'),
        email: vi.fn(() => 'anna@example.com'),
        forget,
      },
    })
    const { result } = renderHook(() => useDayMarker(d))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.email).toBe('anna@example.com'))

    act(() => result.current.signOut())

    expect(result.current.email).toBe('')
    expect(forget).toHaveBeenCalled()
  })
})

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

/**
 * A token alone is no longer enough to talk to Google: every request needs the
 * ID of the calendar this app created, which lives in the user's Drive app-data
 * folder and is fetched once per session. Connecting therefore means "signed in
 * *and* pointed at a calendar" — the two cannot come apart without every write
 * landing on `/calendars//events`.
 */
describe('useDayMarker — the app calendar', () => {
  it('is resolved as part of connecting', async () => {
    const calendar = stubCalendar()
    const { result } = renderHook(() => useDayMarker(deps({ calendar })))

    await act(async () => {
      await result.current.connect()
    })

    expect(calendar.ensure).toHaveBeenCalledTimes(1)
    expect(result.current.connected).toBe(true)
  })

  it('leaves the app disconnected, and unprobed, when it cannot be resolved', async () => {
    const calendar = stubCalendar({
      ensure: vi.fn(async () => {
        throw new Error('Drive is unreachable')
      }),
    })
    const api = stubApi()
    const { result } = renderHook(() => useDayMarker(deps({ calendar, api })))
    act(() => result.current.setStartDate('2026-01-01'))

    await act(async () => {
      expect(await result.current.connect()).toBe(false)
    })

    expect(result.current.connected).toBe(false)
    expect(result.current.error).toBe('Drive is unreachable')
    // The probe is gated on `connected` for exactly this reason: without an ID
    // every probe would query a URL with an empty calendar segment.
    expect(api.getEvent).not.toHaveBeenCalled()
  })

  it('reads a live token as already connected', async () => {
    // The route change that loses this hook's state cannot lose the token: it
    // lives in the auth singleton, one level up. Assuming `false` here is what
    // put "Not connected" beside a live session after a tab switch.
    const { result } = renderHook(() => useDayMarker(deps({ auth: liveAuth() })))

    expect(result.current.connected).toBe(true)
  })

  it('resolves the calendar before probing with a token it never requested', async () => {
    // Mirrors main.tsx, where `api` reads the ID lazily: an unresolved ID is not
    // an inert empty string, it is a request to `/calendars//events`. Arriving
    // with a seeded token means `connect()` -- the only other place `ensure()`
    // runs -- was never called on this hook.
    let id = ''
    const calendar = stubCalendar({
      ensure: vi.fn(async () => {
        id = 'cal-1'
        return id
      }),
      id: vi.fn(() => id),
    })
    const api = stubApi()
    ;(api.getEvent as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (calendar.id() === '') throw new Error('probed with no calendar')
      return null
    })
    const { result } = renderHook(() =>
      useDayMarker(deps({ auth: liveAuth(), api, calendar })),
    )

    act(() => result.current.setStartDate('2026-01-01'))

    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.error).toBeNull()
    expect(result.current.plan).toHaveLength(13)
  })

  it('is forgotten when a failed probe drops the connection', async () => {
    const calendar = stubCalendar()
    const api = stubApi()
    ;(api.getEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Unauthorized(401, 'authError', ''),
    )
    const { result } = renderHook(() => useDayMarker(deps({ calendar, api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })

    await waitFor(() => expect(result.current.connected).toBe(false))
    // Cleared alongside the token. A reconnect may be a different Google
    // account, and reusing the previous account's calendar ID would write this
    // user's milestones into a calendar they cannot see.
    expect(calendar.forget).toHaveBeenCalled()
  })
})

/**
 * Signing out is the deliberate counterpart of the token-death path: same three
 * effects on the session (forget the token, forget the calendar, drop
 * `connected`), reached on purpose rather than by a 401.
 */
describe('useDayMarker — signing out', () => {
  it('drops the connection and the plan, and keeps the inputs', async () => {
    const auth = sessionAuth()
    const calendar = stubCalendar()
    const { result } = renderHook(() => useDayMarker(deps({ auth, calendar })))
    await act(async () => {
      await result.current.connect()
    })
    act(() => result.current.setStartDate('2026-01-01'))
    act(() => result.current.setLabel('Us'))
    await waitFor(() => expect(result.current.phase).toBe('ready'))

    act(() => result.current.signOut())

    expect(result.current.connected).toBe(false)
    expect(auth.token()).toBeNull()
    // The next connect may be a different account, whose calendar is not this
    // one -- the same reason the failed-probe path forgets it.
    expect(calendar.forget).toHaveBeenCalled()
    expect(result.current.plan).toEqual([])
    expect(result.current.phase).toBe('idle')
    expect(result.current.error).toBeNull()
    // Signing out is not a reason to retype the date, so the inputs survive --
    // and the milestone list they compute stays on screen, exactly as it does
    // before anyone has connected at all.
    expect(result.current.startDate).toBe('2026-01-01')
    expect(result.current.label).toBe('Us')
    expect(result.current.milestones).toHaveLength(13)
  })

  it('cannot be undone by a probe that was already in flight', async () => {
    const auth = sessionAuth()
    let arrive = () => {}
    const latch = new Promise<void>((resolve) => {
      arrive = () => resolve()
    })
    const api = stubApi()
    ;(api.getEvent as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await latch
      return null
    })
    const { result } = renderHook(() => useDayMarker(deps({ auth, api })))
    await act(async () => {
      await result.current.connect()
    })
    act(() => result.current.setStartDate('2026-01-01'))
    await waitFor(() => expect(result.current.phase).toBe('probing'))

    act(() => result.current.signOut())
    await act(async () => {
      arrive()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // A plan is a statement about a calendar this session can no longer read.
    // Without invalidating the in-flight ticket, the reply to a request made
    // while connected lands after the sign-out and puts the preview back --
    // 'ready', with badges, beside a Connect button.
    expect(result.current.phase).toBe('idle')
    expect(result.current.plan).toEqual([])
    expect(result.current.connected).toBe(false)
  })

  it('asks for the account chooser on the next connect', async () => {
    const auth = sessionAuth()
    const { result } = renderHook(() => useDayMarker(deps({ auth })))
    await act(async () => {
      await result.current.connect()
    })
    expect(auth.connect).toHaveBeenLastCalledWith('')

    act(() => result.current.signOut())
    await act(async () => {
      await result.current.connect()
    })

    // The grant survives a sign-out, so prompt '' would silently hand back the
    // same account -- a chooser is the only thing that can reach a second one.
    // Asserted on the argument given to `auth`, because a popup Google owns is
    // not observable from a hook test; check 9 in docs/manual-verification.md
    // is where the popup itself is proven.
    expect(auth.connect).toHaveBeenLastCalledWith('select_account')
  })

  it('returns to a silent re-authorization once the chooser has been shown', async () => {
    const auth = sessionAuth()
    const { result } = renderHook(() => useDayMarker(deps({ auth })))
    act(() => result.current.signOut())
    await act(async () => {
      await result.current.connect()
    })
    expect(auth.connect).toHaveBeenLastCalledWith('select_account')

    await act(async () => {
      await result.current.connect()
    })

    // One chooser per sign-out. Leaving it latched would put an account picker
    // in front of every later reconnect, including the one a dead token forces.
    expect(auth.connect).toHaveBeenLastCalledWith('')
  })

  it('keeps the chooser pending when the connect it was meant for fails', async () => {
    const auth = sessionAuth()
    ;(auth.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('popup_closed'),
    )
    const { result } = renderHook(() => useDayMarker(deps({ auth })))

    act(() => result.current.signOut())
    await act(async () => {
      expect(await result.current.connect()).toBe(false)
    })
    await act(async () => {
      await result.current.connect()
    })

    // The user asked for a chooser and a closed popup means they never saw one.
    expect(auth.connect).toHaveBeenLastCalledWith('select_account')
  })
})
