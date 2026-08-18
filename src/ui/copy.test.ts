import { describe, expect, it } from 'vitest'
import { actionLabel, countPlan, COPY, outcomeLabel } from '@/ui/copy'
import { REMINDER_ORDER } from '@/domain/reminders'
import type { PlanItem, PlanStatus } from '@/google/plan'
import { computeMilestones } from '@/domain/milestones'
import { calendarDate } from '@/domain/calendarDate'

const MILESTONES = computeMilestones(calendarDate('2026-01-01'), 10)

function item(i: number, status: PlanStatus, selected = true, needsUpdate = false): PlanItem {
  return { milestone: MILESTONES[i]!, eventId: `dm${i}`, status, past: false, selected, needsUpdate }
}

describe('countPlan', () => {
  it('counts only selected items', () => {
    const counts = countPlan([item(0, 'new'), item(1, 'new', false)])
    expect(counts).toEqual({ add: 1, update: 0, restore: 0, selected: 1 })
  })

  it('separates adds, updates and restores', () => {
    const counts = countPlan([
      item(0, 'new'),
      item(1, 'exists', true, true),
      item(2, 'deleted'),
      item(3, 'exists', true, false),
    ])
    expect(counts).toEqual({ add: 1, update: 1, restore: 1, selected: 4 })
  })
})

describe('actionLabel', () => {
  it('lists only the non-zero parts', () => {
    expect(actionLabel({ add: 8, update: 3, restore: 0, selected: 11 })).toBe('Add 8 · Update 3')
  })

  it('includes restores', () => {
    expect(actionLabel({ add: 1, update: 0, restore: 2, selected: 3 })).toBe('Add 1 · Restore 2')
  })

  it('falls back when there is no work', () => {
    expect(actionLabel({ add: 0, update: 0, restore: 0, selected: 0 })).toBe(COPY.nothingToDo)
  })

  it('says so when everything selected is already up to date', () => {
    expect(actionLabel({ add: 0, update: 0, restore: 0, selected: 4 })).toBe(COPY.alreadyUpToDate)
  })
})

describe('COPY.reminderLabels', () => {
  it('names every preset in REMINDER_ORDER', () => {
    // These four strings previously lived in domain/reminders.ts with no test
    // anywhere. A preset added without its label would render as blank text.
    for (const preset of REMINDER_ORDER) {
      expect(COPY.reminderLabels[preset]).toBeTruthy()
    }
    expect(Object.keys(COPY.reminderLabels).sort()).toEqual([...REMINDER_ORDER].sort())
  })
})

describe('COPY.deleteSummary', () => {
  // Literal strings, not a call to COPY.deleteSummary itself: a caller that
  // builds its "expected" text by calling the very function under test can
  // never catch a mutation inside that function -- both sides move together.
  it('reports only what happened, one clause per non-zero outcome', () => {
    expect(COPY.deleteSummary(2, 0, 0)).toBe('2 deleted')
  })

  it('joins every non-zero outcome, including a failure', () => {
    expect(COPY.deleteSummary(1, 1, 1)).toBe('1 deleted · 1 already gone · 1 failed')
  })

  it('omits a zero failed count rather than reporting "0 failed"', () => {
    expect(COPY.deleteSummary(2, 1, 0)).toBe('2 deleted · 1 already gone')
  })
})

describe('outcomeLabel', () => {
  it.each([
    ['added', 'Added'],
    ['updated', 'Updated'],
    ['restored', 'Restored'],
    ['skipped', 'Unchanged'],
    ['failed', 'Failed'],
  ] as const)('labels %s', (outcome, expected) => {
    expect(outcomeLabel(outcome)).toBe(expected)
  })
})
