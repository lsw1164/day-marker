import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConnectionStatus } from '@/ui/ConnectionStatus'
import { Progress } from '@/components/ui/progress'
import { whenGisReady } from '@/google/auth'
import { actionLabel, COPY } from '@/ui/copy'
import { MilestoneList } from '@/ui/MilestoneList'
import { ResultSummary } from '@/ui/ResultSummary'
import { buildRows } from '@/ui/rows'
import { StartDateForm } from '@/ui/StartDateForm'
import { useDayMarker, type DayMarkerDeps } from '@/ui/useDayMarker'
import { today as todayFn } from '@/domain/calendarDate'

export interface AppProps {
  deps: DayMarkerDeps
  /** Injectable because window.google never exists under jsdom. */
  checkGisReady?: () => Promise<boolean>
}

export function App({ deps, checkGisReady = whenGisReady }: AppProps) {
  const state = useDayMarker(deps)
  /**
   * Tri-state, not a boolean. `whenGisReady` polls for up to ten seconds, and a
   * boolean has to pick a lie for that window: `true` enables Connect while the
   * script is still absent, so an ad-blocked user gets AuthError('Google sign-in
   * script has not loaded') verbatim in the alert and then, ten seconds later, a
   * second alert with the real copy. `null` means "not known yet": no alert, and
   * Connect stays disabled until the answer arrives.
   */
  const [gisReady, setGisReady] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    void checkGisReady().then((ready) => {
      if (live) setGisReady(ready)
    })
    return () => {
      live = false
    }
  }, [checkGisReady])

  const todayDate = deps.todayDate ?? todayFn()
  const rows = buildRows({
    phase: state.phase,
    milestones: state.milestones,
    plan: state.plan,
    results: state.results,
    todayDate,
  })

  // `reprobePending` covers the debounce window before `probing` begins. The plan
  // on screen is deliberately still visible there, but it no longer matches the
  // inputs, so submitting it would write the wrong thing — or skip a rename.
  const busy =
    state.phase === 'applying' || state.phase === 'probing' || state.reprobePending
  // A narrower slice of `busy`: the two phases where the list on screen no longer
  // describes the inputs. `applying` is excluded because its rows are the live
  // result of the run, not a stale answer waiting to be replaced.
  const checkingCalendar = state.phase === 'probing' || state.reprobePending
  const heading =
    state.phase === 'applying'
      ? // During a write the list shows only the selected subset, so a total
        // milestone count here would contradict the rows underneath it.
        COPY.progress(state.results.length, rows.length)
      : state.phase === 'probing'
        ? COPY.probing
        : state.phase === 'ready'
          ? `${COPY.milestoneCount(state.plan.length)} · ${COPY.selectedCount(state.counts.selected)}`
          : COPY.milestoneCount(state.milestones.length)

  // pb-28 reserves room for the action bar, which is fixed to the viewport
  // bottom on small screens; at lg the bar becomes static inside the left
  // column, so that reservation drops away.
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-4 pb-28 pt-5 lg:max-w-5xl lg:gap-6 lg:pb-10">
      {/* Identity and nav live in the shared Header; this stays page-level --
          see ConnectionStatus for why it cannot move up there. */}
      <div className="flex justify-end">
        <ConnectionStatus
          connected={state.connected}
          // Hidden -- not disabled -- during a write: clearing the token mid-run
          // fails every event still queued, so the user would read a report full
          // of errors they did not cause. A disabled button would still advertise
          // an action that is wrong at that moment.
          canSignOut={state.phase !== 'applying'}
          onSignOut={state.signOut}
        />
      </div>

      {/*
        No role="alert" on either Alert below: shadcn's Alert sets it itself, and
        adding it would also risk two elements matching getByRole('alert') at once.
        This comment belongs here, in children position. A JSX comment placed
        inside one of the parenthesised && expressions below is a syntax error.
      */}
      {gisReady === false && (
        <Alert variant="destructive">
          <AlertDescription>{COPY.scriptBlocked}</AlertDescription>
        </Alert>
      )}

      {/*
        Gated on phase: in `done`, ResultSummary renders its own Alert, and an
        ungated one here would put two role="alert" elements on screen at once —
        reachable by clicking "Reconnect and finish the remaining N" and then
        cancelling the popup. The error is passed down instead, so that screen
        reports it in its single Alert.
      */}
      {state.phase !== 'done' && state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.phase === 'done' ? (
        // Capped rather than filling the whole container: the report is one column
        // of prose and outcomes, and stretching it to 1100px would put the retry
        // button a screen-width away from the failure it retries.
        <div className="w-full lg:max-w-2xl">
          <ResultSummary
            results={state.results}
            error={state.error}
            onRetry={() => void state.retryFailed()}
            onReset={state.reset}
          />
        </div>
      ) : (
        /*
          Two columns at lg: the controls on the left, and the milestones they
          produce on the right. This screen is a cause and its consequence -- one
          date becomes 13 to 46 dated events -- so the extra width goes on seeing
          the consequence change as you change the cause, rather than on a wider
          form. items-start keeps the left column its own height so it can stick.
        */
        <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start lg:gap-10">
          {/*
            The cause. Sticky at lg so the controls and the button that commits
            them stay put while a 46-row consequence scrolls past on the right;
            top-10 matches the header's lg padding so it parks under it.
          */}
          <div className="flex flex-col gap-5 lg:sticky lg:top-10">
            <StartDateForm
              startDate={state.startDate}
              label={state.label}
              years={state.years}
              reminder={state.reminder}
              onStartDate={state.setStartDate}
              onLabel={state.setLabel}
              onYears={state.setYears}
              onReminder={state.setReminder}
              disabled={state.phase === 'applying'}
            />

            {/*
              Fixed to the viewport on small screens, where a thumb-reachable bar
              is the right idiom; static under the form at lg, where that idiom
              stops making sense -- on a desktop the button belongs next to the
              controls it commits, not pinned a screen-height below them.
            */}
            <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 px-4 py-3 backdrop-blur lg:static lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
              <div className="mx-auto max-w-md lg:max-w-none">
                {state.connected ? (
                  <Button
                    className="w-full min-h-11"
                    disabled={busy || state.counts.selected === 0}
                    onClick={() => void state.submit()}
                  >
                    {state.phase === 'applying' ? COPY.applying : actionLabel(state.counts)}
                  </Button>
                ) : (
                  <Button
                    className="w-full min-h-11"
                    variant="outline"
                    // Only an affirmative `true` enables it: while readiness is
                    // still unknown a click would reach GIS before the script has
                    // loaded and surface an internal message.
                    disabled={gisReady !== true || state.connecting}
                    onClick={() => void state.connect()}
                  >
                    {/*
                      The label names whichever wait is actually happening. Both
                      windows are silent otherwise: readiness polls for up to ten
                      seconds, and after the popup closes connect() still awaits
                      ensure() to find or create the app's calendar.
                    */}
                    {state.connecting
                      ? COPY.connecting
                      : gisReady === null
                        ? COPY.loadingGoogle
                        : COPY.connect}
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* The consequence. */}
          <div className="flex flex-col gap-5">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{COPY.pickADate}</p>
            ) : (
              <>
                {state.phase === 'applying' && (
                  // aria-label: the numeric context lives in the list heading, so
                  // without this a screen reader announces an unlabelled progressbar.
                  <Progress
                    aria-label={COPY.applying}
                    value={(state.results.length / Math.max(rows.length, 1)) * 100}
                  />
                )}
                <MilestoneList
                  heading={heading}
                  rows={rows}
                  onToggle={state.toggle}
                  busy={checkingCalendar}
                />
              </>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
