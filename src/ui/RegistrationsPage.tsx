import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { today as todayFn, type CalendarDate } from '@/domain/calendarDate'
import { whenGisReady } from '@/google/auth'
import { COPY } from '@/ui/copy'
import { RegistrationRow } from '@/ui/RegistrationRow'
import type { DayMarkerDeps } from '@/ui/useDayMarker'
import { useRegistrations } from '@/ui/useRegistrations'

export interface RegistrationsPageProps {
  deps: DayMarkerDeps
  /** Injectable because window.google never exists under jsdom. */
  checkGisReady?: () => Promise<boolean>
  todayDate?: CalendarDate
}

type ListView = 'loading' | 'empty' | 'list' | 'blocked'

export function RegistrationsPage({
  deps,
  checkGisReady = whenGisReady,
  todayDate = todayFn(),
}: RegistrationsPageProps) {
  // Passed straight through rather than rebuilt into a fresh `{ auth, api,
  // retryDeps }` literal here: useRegistrations reads auth/api through refs
  // specifically so a caller's unstable object cannot matter, but there is no
  // reason to lean on that tolerance when `deps` itself is already the stable
  // reference to pass. `DayMarkerDeps` is a superset of what the hook reads,
  // which is fine to hand through unchanged -- excess fields are simply
  // ignored by its destructuring.
  const state = useRegistrations(deps)
  const [gisReady, setGisReady] = useState<boolean | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const previousConfirming = useRef<CalendarDate | null>(null)

  useEffect(() => {
    let live = true
    void checkGisReady().then((r) => {
      if (live) setGisReady(r)
    })
    return () => {
      live = false
    }
  }, [checkGisReady])

  // The row that owns `confirming` unmounts its own "Delete…" button the
  // instant it opens (RegistrationRow swaps it for Cancel/Confirm), and the
  // browser's default on losing the focused element is to drop focus to
  // <body> -- a keyboard user would land at the top of the document mid-flow,
  // on a destructive action, with nothing telling them what changed. Moving
  // focus to the newly-mounted Cancel button belongs here, not in
  // RegistrationRow: by the time a row can move focus onto itself, the
  // element focus needs to move *from* is already gone from the DOM, and
  // RegistrationRow has no way to know whether it is opening for the first
  // time or merely re-rendering mid-delete. Keyed on `confirming` actually
  // changing (not merely truthy) so this fires once per open/retarget, never
  // on every progress update while a delete runs.
  useEffect(() => {
    const confirming = state.confirming
    if (confirming !== null && confirming !== previousConfirming.current) {
      const index = state.registrations.findIndex((r) => r.startDate === confirming)
      const row = listRef.current?.querySelectorAll('li')[index]
      row?.querySelector<HTMLButtonElement>('button')?.focus()
    }
    previousConfirming.current = confirming
  }, [state.confirming, state.registrations])

  // Gated so this can never coexist with a RegistrationRow's own confirm or
  // summary Alert -- getByRole('alert') throws on more than one match. In
  // this hook's actual state machine `error` only ever transitions non-null
  // from a load (the initial/refresh effect, or connect()), and neither can
  // run while a row is active: confirming is always cleared before a refresh
  // is requested, and connect() is only reachable while disconnected, before
  // any row exists. This condition documents that invariant and enforces it
  // defensively rather than assuming it holds forever.
  const showPageError = state.error !== null && state.confirming === null

  // Order matters: a fetch in flight always shows "loading", even if stale
  // data or a stale error is still sitting in state from before the refetch
  // was requested (e.g. immediately after backToList, before the effect
  // that clears `registrations` on failure or replaces it on success has
  // run). Once resolved, a non-empty list always renders regardless of
  // phase -- `deleting`/`done` never happen without a target found in
  // `registrations`, so no phase check is needed there. What is left is the
  // pair this exists to keep apart: a real, successful empty list (phase
  // 'ready', nothing found) is not the same fact as a failed load
  // (registrations cleared to `[]` with `error` set) -- reporting the second
  // as the first would tell the user their calendar is empty when the truth
  // is "unknown, try again."
  const listView: ListView =
    state.phase === 'loading'
      ? 'loading'
      : state.registrations.length > 0
        ? 'list'
        : state.error !== null
          ? 'blocked'
          : state.phase === 'ready'
            ? 'empty'
            : 'loading'

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-10 pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {state.connected && listView === 'list'
            ? COPY.registrationsCount(state.registrations.length)
            : COPY.registrationsTitle}
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {state.connected ? COPY.connected : COPY.notConnected}
        </span>
      </div>

      {showPageError && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {listView === 'blocked' && (
        // Adjacent to the Alert above rather than lower on the page: some of
        // its copy (paginationLooped's "Please try again") is an instruction
        // with nothing behind it otherwise -- a full browser reload was the
        // only way to act on it before this. Not shown while a retry is
        // already in flight: listView reads 'loading' then, not 'blocked',
        // since a fresh fetch always takes priority (see the listView
        // derivation above).
        <Button variant="outline" className="min-h-11" onClick={() => state.refresh()}>
          {COPY.listRetry}
        </Button>
      )}

      {!state.connected ? (
        <>
          <p className="text-sm text-muted-foreground">{COPY.registrationsConnectPrompt}</p>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={gisReady !== true}
            onClick={() => void state.connect()}
          >
            {COPY.connect}
          </Button>
        </>
      ) : listView === 'loading' ? (
        <p className="text-sm text-muted-foreground">{COPY.registrationsLoading}</p>
      ) : listView === 'empty' ? (
        <p className="text-sm text-muted-foreground">{COPY.registrationsEmpty}</p>
      ) : listView === 'list' ? (
        <>
          <ul ref={listRef} className="flex flex-col gap-2">
            {state.registrations.map((registration) => {
              const active = state.confirming === registration.startDate
              return (
                <RegistrationRow
                  key={registration.startDate}
                  registration={registration}
                  todayDate={todayDate}
                  state={
                    !active
                      ? 'list'
                      : state.phase === 'deleting'
                        ? 'deleting'
                        : state.phase === 'done'
                          ? 'done'
                          : 'confirming'
                  }
                  results={active ? state.results : []}
                  onBeginConfirm={() => state.beginConfirm(registration.startDate)}
                  onCancel={state.cancelConfirm}
                  onConfirm={() => void state.confirmDelete()}
                />
              )
            })}
          </ul>
          {state.phase === 'done' && (
            <Button variant="secondary" className="min-h-11" onClick={state.backToList}>
              {COPY.deleteBack}
            </Button>
          )}
        </>
      ) : null /* 'blocked': the Alert above already explains the failure */}
    </main>
  )
}
