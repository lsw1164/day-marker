export type ReminderPreset = 'none' | 'day1' | 'day3' | 'week1'

/**
 * Google counts reminder offsets BACKWARDS from the start of the event, and
 * requires 0..40320. An all-day event starts at midnight, so a same-day 9am
 * reminder would be a negative offset and is not expressible — which is why
 * there is no such preset.
 *   1 day before at 9am  = 15h                       = 900
 *   3 days before at 9am = 3 * 1440 - 540            = 3780
 *   1 week before at 9am = 7 * 1440 - 540            = 9540
 */
export const REMINDER_MINUTES: Record<ReminderPreset, number | null> = {
  none: null,
  day1: 900,
  day3: 3780,
  week1: 9540,
}

export const REMINDER_LABELS: Record<ReminderPreset, string> = {
  none: 'No reminder',
  day1: '1 day before, 9:00 AM',
  day3: '3 days before, 9:00 AM',
  week1: '1 week before, 9:00 AM',
}

export const REMINDER_ORDER: ReminderPreset[] = ['none', 'day1', 'day3', 'week1']

export const DEFAULT_REMINDER: ReminderPreset = 'day1'
