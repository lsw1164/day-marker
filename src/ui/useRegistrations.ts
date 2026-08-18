import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalendarDate } from '@/domain/calendarDate'
import {
  MISSING_CLIENT_ID,
  SIGN_IN_CANCELLED,
  SIGN_IN_IN_PROGRESS,
  type Auth,
} from '@/google/auth'
import type { CalendarApi } from '@/google/calendarApi'
import {
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

export function useRegistrations({ auth, api, retryDeps }: RegistrationsDeps) {
  // Read through refs for the same reason useDayMarker does: a caller building a
  // fresh deps object each render would otherwise retrigger the load effect on
  // every render, looping real Google requests against the user's quota.
  const apiRef = useRef(api)
  const authRef = useRef(auth)
  apiRef.current = api
  authRef.current = auth

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
      }
    })()
    // api and auth are intentionally absent -- see the apiRef/authRef note above.
  }, [connected, loadNonce])

  const connect = useCallback(async (): Promise<boolean> => {
    try {
      // Evaluated before any await so the popup survives the user gesture, and
      // awaited inside the try so a handler is always attached.
      const promise = authRef.current.connect('')
      await promise
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

  const beginConfirm = useCallback((startDate: CalendarDate) => {
    // A delete in flight owns the screen. Retargeting `confirming` would drop
    // the running row back to its list state, and since results are matched
    // by event id, its outcomes would then render against no row at all --
    // the user would lose every trace of a deletion they cannot undo.
    if (deletingRef.current) return
    setConfirming(startDate)
  }, [])

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
    setConfirming(null)
    setResults([])
    // The list in hand is stale — the events just deleted are gone — so re-read
    // rather than reusing a grouping that no longer describes the calendar.
    refresh()
  }, [refresh])

  return {
    phase,
    connected,
    registrations,
    confirming,
    results,
    error,
    connect,
    refresh,
    beginConfirm,
    cancelConfirm,
    confirmDelete,
    backToList,
  }
}
