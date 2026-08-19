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
  const emptyRef = useRef<HTMLParagraphElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const backToListRef = useRef<HTMLButtonElement>(null)
  const connectRef = useRef<HTMLButtonElement>(null)
  const previousConfirming = useRef<CalendarDate | null>(null)
  const previousPhase = useRef(state.phase)
  // Set when an exit needs to land on whatever the list settles into *after*
  // a refetch, not on what is on screen the instant the exit happens -- see
  // the second effect below for why that distinction matters.
  const pendingListFocus = useRef(false)

  useEffect(() => {
    let live = true
    void checkGisReady().then((r) => {
      if (live) setGisReady(r)
    })
    return () => {
      live = false
    }
  }, [checkGisReady])

  function focusRowControl(startDate: CalendarDate | null) {
    if (startDate === null) return
    const index = state.registrations.findIndex((r) => r.startDate === startDate)
    // :scope > li rather than a bare 'li': the open row's own per-event <li>s
    // are also descendants of this <ul>, and a plain querySelectorAll would
    // pick those up too. Correct today only because exactly one row is ever
    // open and its own <li> sorts before its nested items in document order --
    // scoping to direct children removes the dependence on that coincidence.
    const row = listRef.current?.querySelectorAll(':scope > li')[index]
    // Whichever button a row shows first -- Cancel while open, Delete… while
    // closed -- is always the one this needs: RegistrationRow never renders
    // more than one button ahead of it in either state.
    row?.querySelector<HTMLButtonElement>('button')?.focus()
  }

  // The active row unmounts a control every time it changes state --
  // "Delete…" the instant it opens, Cancel/Confirm the instant it closes or
  // finishes -- and the browser's default on losing the focused element is
  // to drop focus to <body>. A keyboard user would be dropped to the top of
  // the document mid-flow, on a destructive action, with nothing telling
  // them what changed. This belongs here, not in RegistrationRow: by the
  // time a row could move focus onto itself, the element focus needs to move
  // *from* is already gone from the DOM, and RegistrationRow has no way to
  // know why it is re-rendering. Three transitions, each keyed off
  // `confirming` and `phase` actually changing (never merely truthy) so none
  // of them re-fire on every progress tick while a delete runs:
  useEffect(() => {
    const { confirming, phase } = state
    const prevConfirming = previousConfirming.current
    const prevPhase = previousPhase.current

    if (confirming !== null && confirming !== prevConfirming) {
      // Entry: opened for the first time, or retargeted onto a different row.
      focusRowControl(confirming)
    } else if (confirming === null && prevConfirming !== null) {
      if (prevPhase === 'done') {
        // Exit via "Back to registrations": what replaces this row (fresh
        // data, possibly with this row gone entirely) is not decided yet --
        // refresh() was just requested and may pass through a 'loading'
        // render first. Defer to the second effect below rather than
        // grabbing a container that a 'loading' render is about to replace.
        pendingListFocus.current = true
      } else {
        // Exit via Cancel: return focus to the row's own trigger, the
        // control that opened this flow and the one the row shows again now
        // that it is back in 'list' state.
        focusRowControl(prevConfirming)
      }
    } else if (confirming !== null && phase === 'done' && prevPhase !== 'done') {
      // Completion: 'done' removes the row's own Cancel/Confirm entirely, so
      // the next actionable control on screen is the page's own Back button.
      backToListRef.current?.focus()
    }

    previousConfirming.current = confirming
    previousPhase.current = phase
  }, [state.confirming, state.phase, state.registrations])

  // Consumes the pending focus set above once whatever it is waiting on has
  // actually settled. Two distinct settlements, not one:
  //
  // - A halted run's "Back to registrations" calls disconnectAfterHalt(),
  //   not refresh() -- `phase` is left exactly where it was and never enters
  //   'loading' at all, and `connected` flips false in the same commit that
  //   cleared `confirming`. That render already swaps in the connect
  //   prompt, so the correct target is the Connect button, focused
  //   explicitly here -- not left to whatever happened to have focus before
  //   the disconnect. (React reuses the same host button node across that
  //   swap when the two buttons land at the same fragment position, which
  //   would otherwise carry focus over by coincidence rather than by design
  //   -- see the regression test for what that coincidence would hide.)
  // - A non-halted "Back to registrations" calls refresh(), which does pass
  //   through 'loading' (and may unmount the very container the first
  //   effect could have grabbed) before fresh data lands, so this holds off
  //   until `phase` leaves 'loading', then falls through list -> empty ->
  //   retry so a keyboard user still lands somewhere actionable even if the
  //   refetch itself comes back empty or fails.
  useEffect(() => {
    if (!state.connected) {
      if (pendingListFocus.current) {
        pendingListFocus.current = false
        connectRef.current?.focus()
      }
      return
    }
    if (pendingListFocus.current && state.phase !== 'loading') {
      pendingListFocus.current = false
      ;(listRef.current ?? emptyRef.current ?? retryRef.current)?.focus()
    }
  }, [state.phase, state.connected])

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

  // Same 5xl as the main screen, so the shared Header lines up with the content
  // on both routes. Past about 1000px a two-up grid of cards starts reading as
  // two unrelated columns instead of one collection.
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-10 pt-5 lg:max-w-5xl lg:gap-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {state.connected && listView === 'list'
            ? COPY.registrationsCount(state.registrations.length)
            : COPY.registrationsTitle}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-muted-foreground">
            {state.connected ? COPY.connected : COPY.notConnected}
          </span>
          {/*
            Beside the chip rather than in the shared Header, for the same reason
            App.tsx keeps its own: `connected` is state inside this page's hook,
            with no subscription to the auth singleton.

            Hidden while a delete runs, alongside the deletingRef guard in the
            hook. Clearing the token mid-run halts the delete and fails every
            event still queued -- the involuntary version of which is what
            COPY.deleteHalted exists to explain. The guard makes a click during
            the window before this re-renders a no-op rather than a lie.
          */}
          {state.connected && state.phase !== 'deleting' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={state.signOut}
            >
              {COPY.signOut}
            </Button>
          )}
        </div>
      </div>

      {showPageError && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {/*
        Borrows App's gisReady === false alert -- the same copy, deliberately
        NOT the same condition. App shows its alert whether or not it is
        connected; this one is additionally gated on !state.connected, because
        here the explanation is only worth showing beside the Connect button it
        explains. Do not "unify" the two by widening this back to App's
        condition without re-checking the one-alert invariant below.

        The gap it closes: this page copied the
        tri-state and the Connect button's `disabled={gisReady !== true}` guard
        but not the explanation, so an ad-blocked user on this deep link got a
        permanently disabled button next to prose naming an action it cannot
        perform, and no alert at all. Gated on !showPageError, not merely on
        !state.connected, so this can never coexist with the page-error Alert
        above -- getByRole('alert') throws on more than one match, and several
        tests depend on there being exactly one.
      */}
      {!state.connected && gisReady === false && !showPageError && (
        <Alert variant="destructive">
          <AlertDescription>{COPY.scriptBlocked}</AlertDescription>
        </Alert>
      )}
      {state.connected && listView === 'blocked' && (
        // Gated on `connected` too, not just `listView === 'blocked'`: an
        // Unauthorized listing failure sets `error` and flips `connected`
        // false in the same path, and the spec treats that as a different
        // row entirely -- reconnect, not retry. Without this gate the retry
        // button would render right next to the connect prompt, and
        // clicking it would do nothing, since the load effect early-returns
        // while disconnected.
        //
        // Adjacent to the Alert above rather than lower on the page: some of
        // its copy (paginationLooped's "Please try again") is an instruction
        // with nothing behind it otherwise -- a full browser reload was the
        // only way to act on it before this. Not shown while a retry is
        // already in flight: listView reads 'loading' then, not 'blocked',
        // since a fresh fetch always takes priority (see the listView
        // derivation above).
        <Button
          ref={retryRef}
          variant="outline"
          className="min-h-11"
          onClick={() => state.refresh()}
        >
          {COPY.listRetry}
        </Button>
      )}

      {!state.connected ? (
        <>
          <p className="text-sm text-muted-foreground">{COPY.registrationsConnectPrompt}</p>
          <Button
            ref={connectRef}
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
        // tabIndex so a keyboard user landing here after "Back to
        // registrations" refreshes into an empty list has somewhere to land
        // other than the document top -- see the pendingListFocus effect.
        <p ref={emptyRef} tabIndex={-1} className="text-sm text-muted-foreground">
          {COPY.registrationsEmpty}
        </p>
      ) : listView === 'list' ? (
        <>
          {/* tabIndex so the pendingListFocus effect above has somewhere to
              land a keyboard user after "Back to registrations" refreshes
              this list, rather than the document top. */}
          {/*
            Two-up at lg, and the row being acted on spans both columns (see
            RegistrationRow) so its full event list gets the width. Grid rather
            than columns: the focus effect above reads `:scope > li`, which a
            multi-column flow would keep intact but reorder unpredictably.
            items-start stops a short card stretching to a tall neighbour.
          */}
          <ul
            ref={listRef}
            tabIndex={-1}
            className="flex flex-col gap-2 lg:grid lg:grid-cols-2 lg:items-start lg:gap-3"
          >
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
            <Button
              ref={backToListRef}
              variant="secondary"
              className="min-h-11"
              onClick={state.backToList}
            >
              {COPY.deleteBack}
            </Button>
          )}
        </>
      ) : null /* 'blocked': the Alert above already explains the failure */}
    </main>
  )
}
