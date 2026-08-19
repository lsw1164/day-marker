import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatLong, type CalendarDate } from '@/domain/calendarDate'
import {
  DELETE_HALTED,
  type DeleteResult,
  type Registration,
} from '@/google/registrations'
import { cn } from '@/lib/utils'
import { COPY } from '@/ui/copy'

const OUTCOME_LABEL = {
  deleted: COPY.outcomeDeleted,
  alreadyGone: COPY.outcomeAlreadyGone,
  failed: COPY.outcomeFailed,
} as const

export interface RegistrationRowProps {
  registration: Registration
  todayDate: CalendarDate
  state: 'list' | 'confirming' | 'deleting' | 'done'
  results: DeleteResult[]
  onBeginConfirm: () => void
  onCancel: () => void
  onConfirm: () => void
}

export function RegistrationRow({
  registration,
  todayDate,
  state,
  results,
  onBeginConfirm,
  onCancel,
  onConfirm,
}: RegistrationRowProps) {
  const open = state !== 'list'
  const byId = new Map(results.map((r) => [r.event.id, r]))
  const deleted = results.filter((r) => r.outcome === 'deleted').length
  const alreadyGone = results.filter((r) => r.outcome === 'alreadyGone').length
  const failed = results.filter((r) => r.outcome === 'failed').length
  // A halted run stamps DELETE_HALTED on every event it touches, including the
  // one that triggered the halt (see deleteRegistration, post-ed5521c) -- so
  // every failed result in a halted run carries the sentinel. Preferring it
  // over the first failure's raw error is what lets `done` say "reconnect"
  // instead of echoing a bare API string; an ordinary, non-halted failure
  // (no sentinel present) still surfaces its own error message unchanged.
  const reason = results.some((r) => r.error === DELETE_HALTED)
    ? COPY.deleteHalted
    : results.find((r) => r.outcome === 'failed')?.error

  return (
    <li
      className={cn(
        'rounded-xl border p-3',
        open ? 'border-destructive/40' : 'border-border',
        // Spans both columns of the page's lg grid while open: this is the state
        // that lists every event, and a confirm screen that asks the user to
        // check what they are about to lose should not be the narrower half of
        // the layout. Inert on small screens, where the list is one column.
        open && 'lg:col-span-2',
      )}
    >
      <p className="font-medium">{registration.title}</p>
      <p className="text-xs text-muted-foreground">
        {COPY.registrationMeta(formatLong(registration.startDate), registration.count)}
      </p>

      {state === 'list' && (
        <Button
          variant="ghost"
          className="mt-2 min-h-11 px-0 text-destructive"
          onClick={onBeginConfirm}
        >
          {COPY.deleteOpen}
        </Button>
      )}

      {open && (
        <>
          {state === 'confirming' && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{COPY.deleteWarning(registration.count)}</AlertDescription>
            </Alert>
          )}

          {/*
            Every event, scrollable, never truncated. This step exists so a user
            sees the past events they had forgotten; an "and N more" would hide
            precisely those.
          */}
          {/*
            tabIndex so a keyboard-only user can scroll this list into view
            without a mouse -- there are no interactive children to trap
            focus behind, so this cannot create a focus trap.
          */}
          {/*
            Capped and taller at lg. The card spans both grid columns so a long
            open row does not leave a void beside a short neighbour -- but this
            list scrolls, so the width buys nothing except distance between each
            date and its badge. The gain goes on height instead: more of what is
            about to be deleted visible at once, which is the whole point here.
          */}
          <ul
            tabIndex={0}
            className="mt-3 max-h-56 overflow-y-auto border-t pt-2 text-sm lg:max-h-80 lg:max-w-2xl"
          >
            {registration.events.map((event) => {
              const result = byId.get(event.id)
              const past = event.date < todayDate
              return (
                <li key={event.id} className="flex items-baseline gap-2 py-1">
                  <span className="w-20 shrink-0 font-medium">{event.label}</span>
                  <span className="flex-1 tabular-nums text-muted-foreground">
                    {formatLong(event.date)}
                  </span>
                  {result ? (
                    <Badge variant={result.outcome === 'failed' ? 'destructive' : 'secondary'}>
                      {OUTCOME_LABEL[result.outcome]}
                    </Badge>
                  ) : (
                    past && <Badge variant="secondary">{COPY.statusPast}</Badge>
                  )}
                </li>
              )
            })}
          </ul>

          {state === 'done' ? (
            <>
              <p className="mt-3 text-sm font-medium">
                {COPY.deleteSummary(deleted, alreadyGone, failed)}
              </p>
              {/*
                One Alert carrying the first failure's reason, matching
                ResultSummary's `error ?? failed[0]?.error`. Without it a run
                halted by an expired token shows `Failed` badges and a bare count,
                with nothing saying the events were never attempted or that
                reconnecting is what fixes it — deleteRegistration stamps those
                items with the DELETE_HALTED sentinel precisely so ui/ can
                recognise the case and supply the wording.
                Cannot collide with the confirming Alert above: that one is gated
                on `state === 'confirming'`, which this branch excludes.
              */}
              {reason && (
                <Alert variant="destructive" className="mt-3">
                  <AlertDescription>{reason}</AlertDescription>
                </Alert>
              )}
            </>
          ) : (
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                className="min-h-11 flex-1"
                disabled={state === 'deleting'}
                onClick={onCancel}
              >
                {COPY.deleteCancel}
              </Button>
              <Button
                variant="destructive"
                className="min-h-11 flex-1"
                disabled={state === 'deleting'}
                onClick={onConfirm}
              >
                {state === 'deleting' ? COPY.deleteBusy : COPY.deleteConfirm(registration.count)}
              </Button>
            </div>
          )}
        </>
      )}
    </li>
  )
}
