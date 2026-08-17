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
  const [gisReady, setGisReady] = useState(true)

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

  const busy = state.phase === 'applying' || state.phase === 'probing'
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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 pb-28 pt-6">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{COPY.appName}</h1>
          <p className="text-xs text-muted-foreground">{COPY.tagline}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {state.connected ? COPY.connected : COPY.notConnected}
        </span>
      </header>

      {/*
        No role="alert" on either Alert below: shadcn's Alert sets it itself, and
        adding it would also risk two elements matching getByRole('alert') at once.
        This comment belongs here, in children position. A JSX comment placed
        inside one of the parenthesised && expressions below is a syntax error.
      */}
      {!gisReady && (
        <Alert variant="destructive">
          <AlertDescription>{COPY.scriptBlocked}</AlertDescription>
        </Alert>
      )}

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.phase === 'done' ? (
        <ResultSummary
          results={state.results}
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
                <Progress value={(state.results.length / Math.max(rows.length, 1)) * 100} />
              )}
              <MilestoneList heading={heading} rows={rows} onToggle={state.toggle} />
            </>
          )}

          <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 px-4 py-3 backdrop-blur">
            <div className="mx-auto max-w-md">
              {state.connected ? (
                <Button
                  className="w-full"
                  disabled={busy || state.counts.selected === 0}
                  onClick={() => void state.submit()}
                >
                  {state.phase === 'applying' ? COPY.applying : actionLabel(state.counts)}
                </Button>
              ) : (
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={!gisReady}
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
