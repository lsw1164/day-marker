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
import type { CalendarApi } from '@/google/calendarApi'
import { buildPlan, type PlanItem } from '@/google/plan'
import type { RetryDeps } from '@/lib/backoff'
import { COPY, countPlan } from '@/ui/copy'

export type Phase = 'idle' | 'probing' | 'ready' | 'applying' | 'done'

export interface DayMarkerDeps {
  auth: Auth
  api: CalendarApi
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
  apiRef.current = api
  authRef.current = auth

  const start = isCalendarDate(startDate) ? startDate : null

  const milestones = useMemo(
    () => (start ? computeMilestones(start, years) : []),
    [start, years],
  )

  const options: EventOptions | null = useMemo(
    () => (start ? { start, label, reminder } : null),
    [start, label, reminder],
  )

  // Guards against a slow probe overwriting a newer one.
  const probeToken = useRef(0)
  // Bumped to force a re-probe when the inputs have not changed but the calendar
  // has — i.e. after we ourselves wrote to it. See `reset`.
  const [probeNonce, setProbeNonce] = useState(0)

  useEffect(() => {
    if (!connected || !options || milestones.length === 0) return
    const ticket = probeToken.current + 1
    probeToken.current = ticket
    setPhase('probing')
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await buildPlan(apiRef.current, milestones, options, todayDate)
          if (probeToken.current !== ticket) return
          setPlan(next)
          setResults([])
          setError(null)
          setPhase('ready')
        } catch (e) {
          if (probeToken.current !== ticket) return
          setError(describe(e))
          setPhase('idle')
          setConnected(false)
          authRef.current.clear()
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

  const run = useCallback(
    async (items: PlanItem[]) => {
      if (!options || items.length === 0) return
      setPhase('applying')
      setResults([])
      const collected: ItemResult[] = []
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
      setResults(finished)
      setPhase('done')
    },
    [options, retryDeps],
  )

  const submit = useCallback(
    () => run(plan.filter((item) => item.selected)),
    [plan, run],
  )

  const retryFailed = useCallback(async () => {
    const failed = results.filter((r) => r.outcome === 'failed').map((r) => r.item)
    if (failed.length === 0) return
    // Stop if the reconnect failed. `connect` has already reported why, and
    // writing with a dead token would re-fail every item — replacing that
    // explanation with a fresh pile of 401s and telling the user nothing.
    if (!(await connect(''))) return
    await run(failed)
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
