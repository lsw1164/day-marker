import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isCalendarDate, today as todayFn, type CalendarDate } from '@/domain/calendarDate'
import type { EventOptions } from '@/domain/eventPayload'
import { computeMilestones, DEFAULT_YEARS } from '@/domain/milestones'
import { DEFAULT_REMINDER, type ReminderPreset } from '@/domain/reminders'
import { applyPlan, type ItemResult } from '@/google/apply'
import {
  MISSING_CLIENT_ID,
  SIGN_IN_CANCELLED,
  SIGN_IN_IN_PROGRESS,
  type Auth,
  type GisPrompt,
} from '@/google/auth'
import type { AppCalendar } from '@/google/appCalendar'
import type { CalendarApi } from '@/google/calendarApi'
import { buildPlan, type PlanItem } from '@/google/plan'
import type { RetryDeps } from '@/lib/backoff'
import { COPY, countPlan } from '@/ui/copy'

export type Phase = 'idle' | 'probing' | 'ready' | 'applying' | 'done'

export interface DayMarkerDeps {
  auth: Auth
  api: CalendarApi
  /** Resolves the ID every `api` call targets. See `google/appCalendar.ts`. */
  calendar: AppCalendar
  todayDate?: CalendarDate
  probeDelayMs?: number
  retryDeps?: RetryDeps
}

/**
 * Translates the two machine-readable sentinels the auth layer can produce into
 * copy a person can act on. Everything else passes through unchanged —
 * 'popup_closed', for instance, means the user dismissed the window on purpose,
 * which needs no translation.
 *
 * This mapping lives here, not in `google/auth.ts`, so that user-facing strings
 * stay in `ui/` and the google layer never imports from the ui layer.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === MISSING_CLIENT_ID) return COPY.missingClientId
  // GIS reports a blocked popup as 'popup_failed_to_open', which means nothing to a user.
  if (message === 'popup_failed_to_open') return COPY.popupBlocked
  return message
}

export function useDayMarker({
  auth,
  api,
  calendar,
  todayDate = todayFn(),
  probeDelayMs = 400,
  retryDeps,
}: DayMarkerDeps) {
  const [startDate, setStartDate] = useState('')
  const [label, setLabel] = useState('')
  const [years, setYears] = useState(DEFAULT_YEARS)
  const [reminder, setReminder] = useState<ReminderPreset>(DEFAULT_REMINDER)

  const [connected, setConnected] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [plan, setPlan] = useState<PlanItem[]>([])
  const [results, setResults] = useState<ItemResult[]>([])
  const [error, setError] = useState<string | null>(null)

  /**
   * `api` and `auth` are singletons in practice, so they are read through refs
   * rather than listed as effect dependencies.
   *
   * This is not stylistic. A caller that builds a fresh deps object on each
   * render — trivially easy to do by inlining `useDayMarker({ auth, api })` —
   * would otherwise retrigger the probe effect every render. The consequence is
   * not a slow render: it is a loop issuing real Google Calendar requests as fast
   * as React can re-render, burning the user's API quota against their own
   * calendar. Keep these out of the dependency arrays.
   */
  const apiRef = useRef(api)
  const authRef = useRef(auth)
  const calendarRef = useRef(calendar)
  apiRef.current = api
  authRef.current = auth
  calendarRef.current = calendar

  const start = isCalendarDate(startDate) ? startDate : null

  const milestones = useMemo(
    () => (start ? computeMilestones(start, years) : []),
    [start, years],
  )

  const options: EventOptions | null = useMemo(
    () => (start ? { start, label, reminder } : null),
    [start, label, reminder],
  )

  /**
   * True from the moment the inputs change until the probe they triggered
   * settles: the plan in hand no longer describes the current inputs.
   *
   * This is the half of `probing` that had to stay synchronous. `probing` also
   * blanks every status badge, which is why it now waits for the debounce — but
   * "the preview is stale" must be known immediately, because the action button
   * reads `needsUpdate` off that stale plan. Without this flag, editing the
   * Label and submitting inside the 400 ms window skips the rename: the item is
   * still `exists`/`needsUpdate: false` from the previous title, so `applyOne`
   * returns 'skipped' and the event silently keeps its old summary.
   *
   * It is only ever set by an effect run that schedules a probe, and cleared by
   * that probe's own ticket. Any state where it is stuck true is a state where
   * the plan does not match the inputs, so a disabled button is the honest
   * answer there too.
   */
  const [reprobePending, setReprobePending] = useState(false)

  // Guards against a slow probe overwriting a newer one.
  const probeToken = useRef(0)
  // Bumped to force a re-probe when the inputs have not changed but the calendar
  // has — i.e. after we ourselves wrote to it. See `reset`.
  const [probeNonce, setProbeNonce] = useState(0)

  useEffect(() => {
    if (!connected || !options || milestones.length === 0) return
    const ticket = probeToken.current + 1
    probeToken.current = ticket
    // Synchronous, where setPhase('probing') used to be: this is the instant the
    // plan on screen stops matching the inputs.
    setReprobePending(true)
    const timer = setTimeout(() => {
      // Inside the timeout, not before it. `probing` renders like `idle` — every
      // status badge becomes '—' and the action button goes dead — so setting it
      // synchronously blanked the entire preview on every keystroke in the Label
      // field and only restored it 400 ms after the user stopped typing. Keeping
      // it here leaves the previous plan on screen while a re-probe is pending.
      setPhase('probing')
      void (async () => {
        try {
          const next = await buildPlan(apiRef.current, milestones, options, todayDate)
          if (probeToken.current !== ticket) return
          setPlan(next)
          setResults([])
          setError(null)
          // Cleared inside the ticket guard on both settle paths, so a probe that
          // has already been superseded cannot report a newer one as settled.
          setReprobePending(false)
          setPhase('ready')
        } catch (e) {
          if (probeToken.current !== ticket) return
          setError(describe(e))
          setReprobePending(false)
          setPhase('idle')
          setConnected(false)
          authRef.current.clear()
          // Dropped with the token, not kept across it: the next connect may be
          // a different Google account, and that account has a different
          // calendar — or none yet.
          calendarRef.current.forget()
        }
      })()
    }, probeDelayMs)
    return () => clearTimeout(timer)
    // api and auth are intentionally absent — see the apiRef/authRef note above.
  }, [connected, options, milestones, todayDate, probeDelayMs, probeNonce])

  /**
   * Returns whether a usable token was obtained. Callers need that answer:
   * `retryFailed` must not write with a dead token, and it cannot read the
   * `connected` state to find out — that value is captured in this callback's
   * closure and would be stale.
   */
  const connect = useCallback(
    async (prompt: GisPrompt = ''): Promise<boolean> => {
      try {
        // Called before any await so the popup survives the user gesture. It stays
        // inside the try and is always awaited, so a handler is attached — clear()
        // rejects a pending call rather than dropping it, and a fire-and-forget
        // call here would surface as an unhandled rejection.
        const promise = authRef.current.connect(prompt)
        await promise
        // Before `connected` flips, because that flag is what releases the
        // probe effect — and a probe without a calendar ID would request
        // `/calendars//events`. Cached after the first success, so a reconnect
        // costs nothing.
        await calendarRef.current.ensure()
        setError(null)
        setConnected(true)
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : ''
        // A double-click: the popup the user already opened is still open, so
        // there is nothing to tell them and nothing to change.
        if (message === SIGN_IN_IN_PROGRESS) return false
        // clear() abandoned this call. The path that called clear() is already
        // reporting its own error; overwriting it with this one would replace the
        // real cause with a symptom.
        if (message === SIGN_IN_CANCELLED) return false
        setError(describe(e))
        setConnected(false)
        return false
      }
    },
    [],
  )

  const toggle = useCallback((key: string) => {
    setPlan((current) =>
      current.map((item) =>
        item.milestone.key === key ? { ...item, selected: !item.selected } : item,
      ),
    )
  }, [])

  /**
   * `previous` carries the results of an earlier pass that this run must not
   * discard — a retry writes only the failed items, but the report still has to
   * account for the ones that already succeeded. It seeds the progress
   * accumulator as well as the final state, so the rows and the "N of M"
   * heading stay correct while the retry is in flight instead of collapsing to
   * "0 of 12" and reverting added rows to "Queued".
   */
  const run = useCallback(
    async (items: PlanItem[], previous: ItemResult[] = []) => {
      if (!options || items.length === 0) return
      setPhase('applying')
      setResults(previous)
      const collected: ItemResult[] = [...previous]
      try {
        const finished = await applyPlan(
          apiRef.current,
          items,
          options,
          (result) => {
            collected.push(result)
            setResults([...collected])
          },
          retryDeps,
        )
        setResults([...previous, ...finished])
      } catch (e) {
        // applyPlan reports per-item failures in its return value, so the only
        // way it rejects is the progress callback above throwing. Unreachable
        // today — `collected.push` and `setResults` do not throw — but the path
        // exists, and uncaught it would surface as an unhandled rejection and
        // strand the UI in 'applying' with a spinner that never finishes.
        // `collected` is the most complete record available, so report that.
        setError(describe(e))
        setResults([...collected])
      }
      setPhase('done')
    },
    [options, retryDeps],
  )

  const submit = useCallback(
    () => run(plan.filter((item) => item.selected)),
    [plan, run],
  )

  const retryFailed = useCallback(async () => {
    const failed = results.filter((r) => r.outcome === 'failed')
    if (failed.length === 0) return
    // Everything that did not fail is already in the user's calendar. Hand it to
    // `run` so the retry adds to that record rather than replacing it.
    const kept = results.filter((r) => r.outcome !== 'failed')
    // Stop if the reconnect failed. `connect` has already reported why, and
    // writing with a dead token would re-fail every item — replacing that
    // explanation with a fresh pile of 401s and telling the user nothing.
    if (!(await connect(''))) return
    await run(
      failed.map((r) => r.item),
      kept,
    )
  }, [results, connect, run])

  const reset = useCallback(() => {
    setResults([])
    setPhase(connected ? 'probing' : 'idle')
    // Force a fresh probe. We have just written to the calendar, so the plan in
    // hand is stale: it still reports `new` for events that now exist. Returning
    // to it would break the design's central claim — that the preview is the
    // calendar's real state, not a prediction.
    setProbeNonce((n) => n + 1)
  }, [connected])

  const counts = useMemo(() => countPlan(plan), [plan])
  const failedCount = results.filter((r) => r.outcome === 'failed').length

  return {
    phase,
    reprobePending,
    startDate,
    label,
    years,
    reminder,
    milestones,
    plan,
    results,
    connected,
    error,
    counts,
    failedCount,
    setStartDate,
    setLabel,
    setYears,
    setReminder,
    toggle,
    connect,
    submit,
    retryFailed,
    reset,
  }
}
