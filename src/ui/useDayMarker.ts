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
import type { Account } from '@/google/account'
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
  /**
   * Who the app is acting for. Optional because the address is optional: the
   * `userinfo.email` scope is requested but not required, so a caller with no
   * account resolver -- or a user who declined that one box -- gets an app that
   * works and simply does not name the signed-in address.
   */
  account?: Account
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
  account,
  todayDate = todayFn(),
  probeDelayMs = 400,
  retryDeps,
}: DayMarkerDeps) {
  const [startDate, setStartDate] = useState('')
  const [label, setLabel] = useState('')
  const [years, setYears] = useState(DEFAULT_YEARS)
  const [reminder, setReminder] = useState<ReminderPreset>(DEFAULT_REMINDER)

  /**
   * Derived from the token, not assumed false. A `<Route element>` unmounts on
   * navigation, so this hook's state does not survive a tab switch — but the
   * token does, because it lives in the `auth` singleton above both pages. This
   * is the same rule `useRegistrations` states: the token is the single source
   * of truth, so arriving from the other route with a live session must not read
   * as "Not connected" — beside a Connect button that re-opens Google's popup
   * for a grant the user already gave.
   */
  const [connected, setConnected] = useState(() => auth.token() !== null)
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
  const accountRef = useRef(account)
  apiRef.current = api
  authRef.current = auth
  calendarRef.current = calendar
  accountRef.current = account

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

  /**
   * The prompt an argument-less `connect()` should use. '' re-authorizes
   * silently, which is right for a first connect and for a dead token — but
   * wrong immediately after a sign-out: the grant outlives the token, so ''
   * would hand back the very account the user just left, with no way to reach a
   * second one. A ref, not state, because nothing renders differently for it.
   */
  const nextPrompt = useRef<GisPrompt>('')

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
          // Resolved here as well as in `connect`, because `connected` can be
          // seeded from a token this hook never asked for — the user connected
          // on /registrations and navigated. Without it the very first probe of
          // that session queries `/calendars//events`. Cached after the first
          // call, so every later probe costs nothing.
          await calendarRef.current.ensure()
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
          accountRef.current?.forget()
          setEmail('')
        }
      })()
    }, probeDelayMs)
    return () => clearTimeout(timer)
    // api and auth are intentionally absent — see the apiRef/authRef note above.
  }, [connected, options, milestones, todayDate, probeDelayMs, probeNonce])

  const [connecting, setConnecting] = useState(false)
  /**
   * Seeded from the resolver, not from '' — the same rule `connected` follows one
   * screen up. A `<Route element>` unmounts on navigation, so this hook's state
   * does not survive a tab switch, but the `account` singleton above both pages
   * still holds the address it already fetched. Starting empty made the address
   * vanish on every tab change and then not come back, since `ensure()` is only
   * called from `connect()` and the user is already connected.
   *
   * '' still means unknown: no scope, no resolver, or the lookup failed.
   */
  const [email, setEmail] = useState(() => account?.email() ?? '')

  /**
   * Returns whether a usable token was obtained. Callers need that answer:
   * `retryFailed` must not write with a dead token, and it cannot read the
   * `connected` state to find out — that value is captured in this callback's
   * closure and would be stale.
   */
  const connect = useCallback(
    async (prompt?: GisPrompt): Promise<boolean> => {
      // An explicit argument always wins; `undefined` means "whatever the last
      // sign-out left pending", which is how the chooser reaches the button in
      // App.tsx without that button knowing anything about sign-out.
      const chosen = prompt ?? nextPrompt.current
      // Set before the first await, so a caller that renders off this flag shows
      // the busy state in the same commit as the click rather than a frame later.
      // Reading nextPrompt above is synchronous, and nothing is awaited between
      // here and requestAccessToken, so the popup still opens inside the gesture.
      setConnecting(true)
      try {
        // Called before any await so the popup survives the user gesture. It stays
        // inside the try and is always awaited, so a handler is attached — clear()
        // rejects a pending call rather than dropping it, and a fire-and-forget
        // call here would surface as an unhandled rejection.
        const promise = authRef.current.connect(chosen)
        await promise
        // Before `connected` flips, because that flag is what releases the
        // probe effect — and a probe without a calendar ID would request
        // `/calendars//events`. Cached after the first success, so a reconnect
        // costs nothing.
        await calendarRef.current.ensure()
        // Spent, and only once the connection it was meant for actually landed:
        // a closed popup means the user never saw the chooser they asked for.
        nextPrompt.current = ''
        setError(null)
        setConnected(true)
        // Deliberately not awaited, and its failure deliberately swallowed. The
        // address is optional -- awaiting it would add a round trip to the wait
        // the user is already sitting through, and a 403 from a declined
        // `userinfo.email` box must not turn a working connection into an error.
        void accountRef.current?.ensure().then(setEmail, () => {})
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
      } finally {
        // finally, not per-branch: two of the catch arms return early on
        // sentinels, and a flag left set on either would strand the button in
        // "Connecting…" with no way back.
        setConnecting(false)
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

  /**
   * The deliberate counterpart of the failed-probe path above: the same three
   * effects on the session — forget the token, forget the calendar, drop
   * `connected` — reached on purpose instead of by a 401.
   *
   * The inputs are deliberately left alone. Signing out says nothing about the
   * date the user typed, and clearing it would make "sign out" cost them the
   * form. The plan does go, because it is a statement about a calendar this
   * session can no longer read.
   */
  const signOut = useCallback(() => {
    // Retires any probe still in flight. Its request went out while the session
    // was live, so its reply is well-formed and would set `plan`/'ready' on
    // arrival — putting the preview back up beside a Connect button.
    probeToken.current += 1
    nextPrompt.current = 'select_account'
    setConnected(false)
    setPlan([])
    setResults([])
    setError(null)
    setPhase('idle')
    setReprobePending(false)
    authRef.current.clear()
    calendarRef.current.forget()
    // The next connect may be a different account, so the address must not
    // outlive the token that identified it.
    accountRef.current?.forget()
    setEmail('')
  }, [])

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
    connecting,
    email,
    error,
    counts,
    failedCount,
    setStartDate,
    setLabel,
    setYears,
    setReminder,
    toggle,
    connect,
    signOut,
    submit,
    retryFailed,
    reset,
  }
}
