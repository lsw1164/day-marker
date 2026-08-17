import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatLong } from '@/domain/calendarDate'
import type { ItemResult } from '@/google/apply'
import { COPY, outcomeLabel } from '@/ui/copy'
import { calendarDayUrl } from '@/ui/links'

const PREVIEW_ROWS = 4

export interface ResultSummaryProps {
  results: ItemResult[]
  onRetry: () => void
  onReset: () => void
}

export function ResultSummary({ results, onRetry, onReset }: ResultSummaryProps) {
  const failed = results.filter((r) => r.outcome === 'failed')
  const succeeded = results.filter((r) => r.outcome !== 'failed')
  const first = succeeded[0]?.item.milestone.date
  const shown = results.slice(0, PREVIEW_ROWS)
  const hidden = results.length - shown.length

  return (
    <section className="space-y-4">
      {failed.length > 0 ? (
        <Alert variant="destructive">
          <AlertDescription>
            <strong>{COPY.partialHeadline(succeeded.length, failed.length)}</strong>
            <br />
            {failed[0]?.error}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-1 py-4 text-center">
          <div className="text-2xl">🎉</div>
          <div className="text-2xl font-bold">{COPY.doneHeadline(succeeded.length)}</div>
          <div className="text-muted-foreground">{COPY.doneSubhead}</div>
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
          <Button className="flex-1" variant="destructive" onClick={onRetry}>
            {COPY.retryFailed(failed.length)}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onReset}>
              {COPY.startOver}
            </Button>
            {first && (
              // shadcn's Button is @base-ui/react-backed: it has no `asChild`.
              // base-ui composes via a `render` element instead.
              <Button
                className="flex-1"
                render={<a href={calendarDayUrl(first)} target="_blank" rel="noreferrer" />}
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
