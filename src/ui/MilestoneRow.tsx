import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Row } from '@/ui/rows'

export interface MilestoneRowProps {
  row: Row
  onToggle: (key: string) => void
}

export function MilestoneRow({ row, onToggle }: MilestoneRowProps) {
  return (
    <li className={cn('flex items-center gap-3 border-b py-2 last:border-b-0', row.muted && 'opacity-50')}>
      <input
        type="checkbox"
        id={`row-${row.key}`}
        className="size-4 shrink-0"
        checked={row.checked}
        disabled={!row.selectable}
        onChange={() => onToggle(row.key)}
      />
      <label htmlFor={`row-${row.key}`} className="w-20 shrink-0 font-medium">
        {row.name}
      </label>
      <span className="flex-1 tabular-nums text-muted-foreground">{row.date}</span>
      <Badge variant={row.failed ? 'destructive' : 'secondary'}>{row.badge}</Badge>
    </li>
  )
}
