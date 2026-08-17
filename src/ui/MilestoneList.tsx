import { MilestoneRow } from '@/ui/MilestoneRow'
import type { Row } from '@/ui/rows'

export interface MilestoneListProps {
  heading: string
  rows: Row[]
  onToggle: (key: string) => void
}

export function MilestoneList({ heading, rows, onToggle }: MilestoneListProps) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h2>
      <ul className="text-sm">
        {rows.map((row) => (
          <MilestoneRow key={row.key} row={row} onToggle={onToggle} />
        ))}
      </ul>
    </section>
  )
}
