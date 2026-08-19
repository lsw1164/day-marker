import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatLong } from '@/domain/calendarDate'
import type { ItemResult } from '@/google/apply'
import { COPY, outcomeLabel } from '@/ui/copy'
import { calendarMonthUrl } from '@/ui/links'

const PREVIEW_ROWS = 4

export interface ResultSummaryProps {
  results: ItemResult[]
  /**
   * A live error from the hook — in practice a failed reconnect during a retry.
   * It is rendered here rather than by `App` because `App`'s own error Alert plus
   * this component's failure Alert would put two `role="alert"` elements on screen
   * simultaneously. This screen owns its own reporting.
   */
  error?: string | null
  onRetry: () => void
  onReset: () => void
}

export function ResultSummary({ results, error, onRetry, onReset }: ResultSummaryProps) {
  const failed = results.filter((r) => r.outcome === 'failed')
  const succeeded = results.filter((r) => r.outcome !== 'failed')
  const first = succeeded[0]?.item.milestone.date
  // Nothing was written: every milestone was already correct on the calendar.
  const allUnchanged =
    succeeded.length > 0 && succeeded.every((r) => r.outcome === 'skipped')
  const shown = results.slice(0, PREVIEW_ROWS)
  const hidden = results.length - shown.length

  return (
    <section className="space-y-4">
      {failed.length > 0 || error ? (
        // Exactly one Alert on this screen, ever. `error` takes precedence over a
        // stored item error because it is the newer and more actionable cause —
        // a reconnect that just failed explains the situation better than a 401
        // recorded during the previous attempt.
        <Alert variant="destructive">
          <AlertDescription>
            {failed.length > 0 && (
              <>
                <strong>{COPY.partialHeadline(succeeded.length, failed.length)}</strong>
                <br />
              </>
            )}
            {error ?? failed[0]?.error}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-1 py-4 text-center">
          <div className="text-2xl">{COPY.celebration}</div>
          <div className="text-2xl font-bold">{COPY.doneHeadline(succeeded.length)}</div>
          <div className="text-muted-foreground">
            {allUnchanged ? COPY.unchangedSubhead : COPY.doneSubhead}
          </div>
        </div>
      )}

      <ul className="text-sm">
        {shown.map((result) => (
          <li key={result.item.eventId} className="flex items-center gap-3 border-b py-2">
            <span className="w-20 shrink-0 font-medium">{result.item.milestone.label}</span>
            <span className="flex-1 tabular-nums text-muted-foreground">
              {formatLong(result.item.milestone.date)}
            </span>
            <Badge variant={result.outcome === 'failed' ? 'destructive' : 'secondary'}>
              {outcomeLabel(result.outcome)}
            </Badge>
          </li>
        ))}
        {hidden > 0 && <li className="py-2 text-muted-foreground">{COPY.andMore(hidden)}</li>}
      </ul>

      <div className="flex gap-2">
        {failed.length > 0 ? (
          <Button className="flex-1 min-h-11" variant="destructive" onClick={onRetry}>
            {COPY.retryFailed(failed.length)}
          </Button>
        ) : (
          <>
            <Button variant="secondary" className="min-h-11" onClick={onReset}>
              {COPY.startOver}
            </Button>
            {first && (
              // shadcn's Button is @base-ui/react-backed: it has no `asChild`.
              // base-ui composes via a `render` element instead.
              <Button
                className="flex-1 min-h-11"
                render={<a href={calendarMonthUrl(first)} target="_blank" rel="noreferrer" />}
              >
                {COPY.viewInCalendar}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  )
}
