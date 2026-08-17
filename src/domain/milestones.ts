import { addDays, addYears, type CalendarDate } from '@/domain/calendarDate'

export type MilestoneKind = 'day' | 'year'

export interface Milestone {
  /** Stable identity, independent of any display string. Feeds the event ID. */
  key: string
  kind: MilestoneKind
  /** The milestone number: 100 for Day 100, 2 for 2 Years. */
  n: number
  date: CalendarDate
  /** Display only. Changing this must never change `key`. */
  label: string
}

export const DAY_STEP = 100
export const MIN_YEARS = 1
export const MAX_YEARS = 10
export const DEFAULT_YEARS = 3
export const YEAR_OPTIONS = [1, 2, 3, 5, 10]

export function computeMilestones(start: CalendarDate, years: number): Milestone[] {
  const horizon = addYears(start, years)
  const milestones: Milestone[] = []

  // Korean convention: the start date is day 1, so Day N falls on start + (N - 1).
  for (let n = DAY_STEP; ; n += DAY_STEP) {
    const date = addDays(start, n - 1)
    if (date > horizon) break
    milestones.push({ key: `d${n}`, kind: 'day', n, date, label: `Day ${n}` })
  }

  for (let k = 1; k <= years; k += 1) {
    milestones.push({
      key: `y${k}`,
      kind: 'year',
      n: k,
      date: addYears(start, k),
      label: k === 1 ? '1 Year' : `${k} Years`,
    })
  }

  return milestones
}
