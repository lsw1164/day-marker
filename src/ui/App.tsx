import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 pb-28 pt-5">
      {/* Identity and nav moved to the shared Header. The connection chip stays
          here because connecting is page-level. */}
      <div className="flex justify-end">
        <span className="text-xs text-muted-foreground">
          {state.connected ? COPY.connected : COPY.notConnected}
        </span>
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
        <ResultSummary
          results={state.results}
          error={state.error}
          onRetry={() => void state.retryFailed()}
          onReset={state.reset}
        />
      ) : (
        <>
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
              <MilestoneList heading={heading} rows={rows} onToggle={state.toggle} />
            </>
          )}

          <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 px-4 py-3 backdrop-blur">
            <div className="mx-auto max-w-md">
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
                  disabled={gisReady !== true}
                  onClick={() => void state.connect()}
                >
                  {COPY.connect}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  )
}
