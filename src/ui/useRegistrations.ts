import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalendarDate } from '@/domain/calendarDate'
import {
  MISSING_CLIENT_ID,
  SIGN_IN_CANCELLED,
  SIGN_IN_IN_PROGRESS,
  type Auth,
  type GisPrompt,
} from '@/google/auth'
import type { AppCalendar } from '@/google/appCalendar'
import type { CalendarApi } from '@/google/calendarApi'
import { Unauthorized } from '@/google/errors'
import {
  DELETE_HALTED,
  deleteRegistration,
  listRegistrations,
  PAGINATION_LOOPED,
  type DeleteResult,
  type Registration,
} from '@/google/registrations'
import type { RetryDeps } from '@/lib/backoff'
import { COPY } from '@/ui/copy'

export type RegistrationsPhase = 'idle' | 'loading' | 'ready' | 'deleting' | 'done'

export interface RegistrationsDeps {
  auth: Auth
  api: CalendarApi
  /** Resolves the ID every `api` call targets. See `google/appCalendar.ts`. */
  calendar: AppCalendar
  retryDeps?: RetryDeps
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === MISSING_CLIENT_ID) return COPY.missingClientId
  // GIS reports a blocked popup as 'popup_failed_to_open', which means nothing to a user.
  if (message === 'popup_failed_to_open') return COPY.popupBlocked
  // listRegistrations throws this sentinel rather than a sentence, so that
  // user-facing strings stay in ui/ and the google layer never imports COPY.
  if (message === PAGINATION_LOOPED) return COPY.paginationLooped
  return message
}

/** True once a finished run's `results` include an unattempted, halted event. */
function isHaltedRun(results: DeleteResult[]): boolean {
  return results.some((r) => r.error === DELETE_HALTED)
}

export function useRegistrations({ auth, api, calendar, retryDeps }: RegistrationsDeps) {
  // Read through refs for the same reason useDayMarker does: a caller building a
  // fresh deps object each render would otherwise retrigger the load effect on
  // every render, looping real Google requests against the user's quota.
  const apiRef = useRef(api)
  const authRef = useRef(auth)
  const calendarRef = useRef(calendar)
  apiRef.current = api
  authRef.current = auth
  calendarRef.current = calendar

  // The token is the single source of truth, so arriving from the other route
  // with a live token does not read as "not connected".
  const [connected, setConnected] = useState(() => auth.token() !== null)
  const [phase, setPhase] = useState<RegistrationsPhase>('idle')
  const [registrations, setRegistrations] = useState<Registration[]>([])
  const [confirming, setConfirming] = useState<CalendarDate | null>(null)
  const [results, setResults] = useState<DeleteResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadNonce, setLoadNonce] = useState(0)

  // Guards against a slow load overwriting a newer one.
  const loadToken = useRef(0)

  /**
   * The prompt the next `connect()` sends. '' re-authorizes silently, which is
   * right everywhere except straight after a sign-out: the grant outlives the
   * token, so '' would hand back the account the user just left. A ref, not
   * state, because nothing renders differently for it.
   */
  const nextPrompt = useRef<GisPrompt>('')

  /**
   * True from the moment confirmDelete's synchronous prologue runs until its
   * async work settles, in a finally block. This exists as a plain ref, not a
   * read of the `phase` state, because two synchronous confirmDelete() calls
   * in the same tick (e.g. a double-click before React flushes the first
   * call's setPhase('deleting')) would both close over the same pre-update
   * `phase` value and both see 'ready' -- state cannot arbitrate between two
   * calls that happen before it has re-rendered. Only a ref mutated before any
   * await can. It doubles as the guard the load effect checks before
   * requerying, so a refresh() that fires while a delete is in flight cannot
   * flip the phase away from 'deleting' out from under it.
   */
  const deletingRef = useRef(false)

  useEffect(() => {
    if (!connected) return
    // A delete owns the phase machine while it runs. Letting a load effect
    // (triggered by refresh(), which nothing here restricts to the 'ready'
    // phase) run concurrently would flip phase 'deleting' -> 'loading' ->
    // 'ready' mid-delete, then back to 'done' once the delete itself settles
    // -- a visible bounce back to the list while events are still being
    // removed. Simplest safe answer: while a delete is in flight, a refresh
    // request is dropped rather than queued. The one real caller of
    // backToList always re-requests once the delete has actually reached
    // 'done', so nothing is permanently lost by dropping one mid-flight.
    if (deletingRef.current) return
    const ticket = loadToken.current + 1
    loadToken.current = ticket
    setPhase('loading')
    void (async () => {
      try {
        // Resolved here as well as in `connect`, because `connected` can be
        // seeded from a token this hook never asked for — the user connected on
        // `/` and navigated. Cached after the first call, so the common case
        // costs nothing.
        await calendarRef.current.ensure()
        const next = await listRegistrations(apiRef.current)
        if (loadToken.current !== ticket) return
        setRegistrations(next)
        setError(null)
        setPhase('ready')
      } catch (e) {
        if (loadToken.current !== ticket) return
        // No partial list: showing some registrations as if they were all of them
        // would misreport the user's calendar.
        setRegistrations([])
        setError(describeError(e))
        setPhase('idle')
        // Only an auth failure invalidates the session. A 500, or
        // PAGINATION_LOOPED, is worth retrying with the token we have -- and
        // PAGINATION_LOOPED's own copy says "please try again", which would
        // be a lie if this had just signed the user out. This deliberately
        // diverges from useDayMarker, which disconnects on any probe
        // failure: that hook has no non-auth failure mode whose copy
        // contradicts being disconnected, and this one does.
        if (e instanceof Unauthorized) {
          setConnected(false)
          authRef.current.clear()
          calendarRef.current.forget()
        }
      }
    })()
    // api and auth are intentionally absent -- see the apiRef/authRef note above.
  }, [connected, loadNonce])

  const connect = useCallback(async (): Promise<boolean> => {
    try {
      // Evaluated before any await so the popup survives the user gesture, and
      // awaited inside the try so a handler is always attached.
      const promise = authRef.current.connect(nextPrompt.current)
      await promise
      // Before `connected` flips, which is what releases the load effect.
      await calendarRef.current.ensure()
      // Spent only once the connection it was meant for landed: a closed popup
      // means the user never saw the chooser they asked for.
      nextPrompt.current = ''
      setError(null)
      setConnected(true)
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : ''
      // Their popup is still open; nothing to say and nothing to change.
      if (message === SIGN_IN_IN_PROGRESS) return false
      // clear() abandoned this call; that path reports its own error.
      if (message === SIGN_IN_CANCELLED) return false
      setError(describeError(e))
      setConnected(false)
      return false
    }
  }, [])

  const refresh = useCallback(() => setLoadNonce((n) => n + 1), [])

  /**
   * The three effects that end a session, in one place: forget the token, forget
   * the calendar ID it resolved, and stop reporting as connected. Shared by the
   * involuntary path (a dead token) and the deliberate one (signing out), which
   * differ only in what else they clear.
   *
   * `calendar.forget()` is not housekeeping: the cached ID belongs to the
   * account that just left, and reusing it for the next one would write their
   * milestones into a calendar they cannot see.
   */
  const forgetSession = useCallback(() => {
    setConnected(false)
    authRef.current.clear()
    calendarRef.current.forget()
  }, [])

  /**
   * The token died mid-run. Drops straight to the connect prompt so the user
   * can reconnect and finish the remainder, which is what COPY.deleteHalted
   * tells them to do -- and clears `confirming`/`results` on the way out,
   * though RegistrationsPage's `!connected` branch would hide them regardless
   * the instant `connected` flips.
   */
  const disconnectAfterHalt = useCallback(() => {
    setConfirming(null)
    setResults([])
    forgetSession()
  }, [forgetSession])

  /**
   * The deliberate counterpart of the path above: the same session teardown,
   * asked for rather than forced by a dead token. It additionally drops the
   * list, which `disconnectAfterHalt` leaves in place — that path is offering a
   * reconnect to finish the very run the list describes, and this one is
   * handing the app to a different account.
   */
  const signOut = useCallback(() => {
    // A delete owns the screen while it runs, and this is the most destructive
    // way to interrupt it: clearing the token fails every event still queued,
    // so a deletion the user cannot undo would report as errors they did not
    // cause. Same guard beginConfirm, cancelConfirm and backToList use.
    if (deletingRef.current) return
    // Retires any load still in flight. Its request went out while the session
    // was live, so its reply is well-formed and would land as a list read with
    // the departed account's token.
    loadToken.current += 1
    nextPrompt.current = 'select_account'
    setRegistrations([])
    setConfirming(null)
    setResults([])
    setPhase('idle')
    setError(null)
    forgetSession()
  }, [forgetSession])

  const beginConfirm = useCallback(
    (startDate: CalendarDate) => {
      // A delete in flight owns the screen. Retargeting `confirming` would drop
      // the running row back to its list state while its own delete is still
      // running -- the user would lose every trace of a deletion they cannot
      // undo.
      if (deletingRef.current) return
      // The same loss reached a different way: deletingRef is false again by
      // 'done', but if that finished run halted, its summary is the only
      // thing offering the reconnect COPY.deleteHalted promises. Task 10
      // renders every other row's Delete… button live even while the active
      // row shows a halted 'done', so retargeting here must not be allowed to
      // quietly discard it -- route to the same reconnect flow backToList
      // uses instead of switching rows.
      if (phase === 'done' && isHaltedRun(results)) {
        disconnectAfterHalt()
        return
      }
      // A non-halted 'done' still needs clearing before retargeting, on two
      // counts. Task 9's 'done' branch computes deleted/alreadyGone/failed
      // with `results.filter(...)` over the whole array -- not keyed by
      // event id at all -- so leaving `results` in place would render the
      // abandoned run's counts under the newly active row today, not merely
      // in some hypothetical future aggregate. And leaving `phase` at 'done'
      // would make Task 10's row-state mapper (`state.phase === 'deleting' ?
      // 'deleting' : state.phase === 'done' ? 'done' : 'confirming'') render
      // the newly active row as 'done' too -- no Cancel or Confirm buttons,
      // a dead end escapable only via backToList, which would then discard
      // this very retarget. 'ready' is the value that mapper treats as
      // "neither deleting nor done", which is what is actually true here:
      // the list in hand is still the one already loaded, just now aimed at
      // a different row.
      setResults([])
      setPhase('ready')
      setConfirming(startDate)
    },
    [phase, results, disconnectAfterHalt],
  )

  const cancelConfirm = useCallback(() => {
    if (deletingRef.current) return
    setConfirming(null)
  }, [])

  const confirmDelete = useCallback(async () => {
    const target = registrations.find((r) => r.startDate === confirming)
    if (!target) return
    // See the deletingRef comment above: this must be checked and set before
    // any await, or two calls issued in the same tick both pass.
    if (deletingRef.current) return
    deletingRef.current = true
    setPhase('deleting')
    // Cleared synchronously, before the new run's first onProgress callback,
    // so a render in between cannot show a stale report for events this run
    // has not touched yet.
    setResults([])
    const collected: DeleteResult[] = []
    try {
      const finished = await deleteRegistration(
        apiRef.current,
        target.events,
        (result) => {
          collected.push(result)
          setResults([...collected])
        },
        retryDeps,
      )
      setResults(finished)
    } catch (e) {
      // deleteRegistration reports per-event failures in its return value, so
      // the only way it rejects is the progress callback above throwing.
      // Unreachable today -- collected.push and setResults do not throw -- but
      // mirrors applyPlan/run's handling of the same theoretical path rather
      // than leaving the UI stuck in 'deleting' forever if it ever is.
      setError(describeError(e))
      setResults(collected)
    } finally {
      deletingRef.current = false
      setPhase('done')
    }
  }, [registrations, confirming, retryDeps])

  const backToList = useCallback(() => {
    // Same hazard beginConfirm/cancelConfirm are already guarded against:
    // clearing `confirming` while its delete is still running would drop the
    // active row back to 'list' and orphan its in-progress results. Not
    // reachable through Task 10's planned UI today -- its only caller renders
    // solely once phase is 'done' -- but the hook's own contract should not
    // depend on that staying true.
    if (deletingRef.current) return
    if (isHaltedRun(results)) {
      // The token died mid-run. Refreshing would just requery with a token
      // already known dead and 401 immediately; drop to the connect prompt
      // instead so the user can reconnect and finish the remainder, which is
      // what COPY.deleteHalted tells them to do.
      disconnectAfterHalt()
      return
    }
    setConfirming(null)
    setResults([])
    // The list in hand is stale — the events just deleted are gone — so re-read
    // rather than reusing a grouping that no longer describes the calendar.
    refresh()
  }, [results, refresh, disconnectAfterHalt])

  return {
    phase,
    connected,
    registrations,
    confirming,
    results,
    error,
    connect,
    signOut,
    refresh,
    beginConfirm,
    cancelConfirm,
    confirmDelete,
    backToList,
  }
}
