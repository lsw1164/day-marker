import { addDays, type CalendarDate } from '@/domain/calendarDate'
import type { Milestone } from '@/domain/milestones'
import { REMINDER_MINUTES, type ReminderPreset } from '@/domain/reminders'

export interface EventOptions {
  start: CalendarDate
  label: string
  reminder: ReminderPreset
}

export interface ReminderOverride {
  method: 'popup'
  minutes: number
}

export interface GoogleEventPayload {
  id: string
  summary: string
  description: string
  start: { date: CalendarDate }
  end: { date: CalendarDate }
  transparency: 'transparent'
  status: 'confirmed'
  reminders: { useDefault: false; overrides: ReminderOverride[] }
  extendedProperties: {
    private: { dayMarkerVersion: '1'; startDate: CalendarDate; milestoneKey: string }
  }
}

export function titleFor(milestone: Milestone, label: string): string {
  const trimmed = label.trim()
  return trimmed ? `${trimmed}: ${milestone.label}` : milestone.label
}

export function buildEventPayload(
  id: string,
  milestone: Milestone,
  options: EventOptions,
): GoogleEventPayload {
  const minutes = REMINDER_MINUTES[options.reminder]
  return {
    id,
    summary: titleFor(milestone, options.label),
    description: `Day Marker · Started ${options.start}`,
    start: { date: milestone.date },
    // Exclusive: a one-day all-day event ends the following day.
    end: { date: addDays(milestone.date, 1) },
    // An anniversary should not make the user look busy.
    transparency: 'transparent',
    // Explicit so a PATCH over a cancelled event revives it.
    status: 'confirmed',
    reminders: {
      useDefault: false,
      overrides: minutes === null ? [] : [{ method: 'popup', minutes }],
    },
    extendedProperties: {
      private: {
        dayMarkerVersion: '1',
        startDate: options.start,
        milestoneKey: milestone.key,
      },
    },
  }
}
