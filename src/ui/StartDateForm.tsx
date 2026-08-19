import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MAX_YEARS, MIN_YEARS, YEAR_OPTIONS } from '@/domain/milestones'
import { REMINDER_ORDER, type ReminderPreset } from '@/domain/reminders'
import { COPY } from '@/ui/copy'

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm disabled:opacity-50'

export interface StartDateFormProps {
  startDate: string
  label: string
  years: number
  reminder: ReminderPreset
  onStartDate: (value: string) => void
  onLabel: (value: string) => void
  onYears: (value: number) => void
  onReminder: (value: ReminderPreset) => void
  disabled: boolean
}

export function StartDateForm({
  startDate,
  label,
  years,
  reminder,
  onStartDate,
  onLabel,
  onYears,
  onReminder,
  disabled,
}: StartDateFormProps) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="start-date">{COPY.startDate}</Label>
        {/* A native date input already emits YYYY-MM-DD, which is CalendarDate. */}
        <Input
          id="start-date"
          type="date"
          value={startDate}
          disabled={disabled}
          onChange={(e) => onStartDate(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="label">{COPY.labelField}</Label>
        <Input
          id="label"
          type="text"
          value={label}
          placeholder={COPY.labelPlaceholder}
          disabled={disabled}
          onChange={(e) => onLabel(e.target.value)}
        />
      </div>

      {/*
        Two-up across the full-width mobile form, stacked in the desktop rail.
        Side by side at lg the pair would each get about 146px, and the longest
        reminder option ("3 days before, 9:00 AM") needs nearer 180px, so the
        native select crops its own labels. The rail has vertical room to spare,
        so the layout gives way rather than the copy.
      */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
        <div className="space-y-1.5">
          <Label htmlFor="years">{COPY.range}</Label>
          <select
            id="years"
            className={SELECT_CLASS}
            value={String(years)}
            disabled={disabled}
            onChange={(e) => onYears(Number(e.target.value))}
          >
            {YEAR_OPTIONS.filter((n) => n >= MIN_YEARS && n <= MAX_YEARS).map((n) => (
              <option key={n} value={n}>
                {COPY.yearsOption(n)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reminder">{COPY.reminder}</Label>
          <select
            id="reminder"
            className={SELECT_CLASS}
            value={reminder}
            disabled={disabled}
            onChange={(e) => onReminder(e.target.value as ReminderPreset)}
          >
            {REMINDER_ORDER.map((preset) => (
              <option key={preset} value={preset}>
                {COPY.reminderLabels[preset]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}
