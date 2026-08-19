import { cn } from '@/lib/utils'
import { MilestoneRow } from '@/ui/MilestoneRow'
import type { Row } from '@/ui/rows'

export interface MilestoneListProps {
  heading: string
  rows: Row[]
  onToggle: (key: string) => void
  /**
   * The rows on screen no longer describe the inputs -- the calendar is being
   * re-checked and every badge currently reads COPY.statusUnknown. Announced on
   * the list itself rather than a wrapper so assistive tech hears it about the
   * thing that is actually stale, and dimmed so a sighted user sees the same.
   */
  busy?: boolean
}

export function MilestoneList({ heading, rows, onToggle, busy = false }: MilestoneListProps) {
  return (
    <section className={cn('space-y-2 transition-opacity', busy && 'opacity-60')}>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h2>
      <ul aria-busy={busy} className="text-sm">
        {rows.map((row) => (
          <MilestoneRow key={row.key} row={row} onToggle={onToggle} />
        ))}
      </ul>
    </section>
  )
}
