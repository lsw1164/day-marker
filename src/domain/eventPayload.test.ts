import { describe, expect, it } from 'vitest'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones } from '@/domain/milestones'
import { buildEventPayload, titleFor, type EventOptions } from '@/domain/eventPayload'
import { REMINDER_MINUTES } from '@/domain/reminders'

const START = calendarDate('2026-01-01')
const [DAY_100] = computeMilestones(START, 1)
const YEAR_1 = computeMilestones(START, 1).find((m) => m.key === 'y1')!

const options: EventOptions = { start: START, label: '', reminder: 'day1' }

describe('titleFor', () => {
  it('uses the bare milestone label when there is no label', () => {
    expect(titleFor(DAY_100!, '')).toBe('Day 100')
    expect(titleFor(YEAR_1, '   ')).toBe('1 Year')
  })

  it('prefixes the label when present', () => {
    expect(titleFor(DAY_100!, 'Anna & Ben')).toBe('Anna & Ben: Day 100')
  })

  it('trims surrounding whitespace from the label', () => {
    expect(titleFor(DAY_100!, '  Us  ')).toBe('Us: Day 100')
  })
})

describe('buildEventPayload', () => {
  it('makes an all-day event whose end date is exclusive', () => {
    const p = buildEventPayload('dmabc12', DAY_100!, options)
    expect(p.start).toEqual({ date: '2026-04-10' })
    expect(p.end).toEqual({ date: '2026-04-11' })
  })

  it('carries the supplied id', () => {
    expect(buildEventPayload('dmabc12', DAY_100!, options).id).toBe('dmabc12')
  })

  it('does not mark the user as busy', () => {
    expect(buildEventPayload('dmabc12', DAY_100!, options).transparency).toBe('transparent')
  })

  it('sets status to confirmed so a PATCH can revive a deleted event', () => {
    expect(buildEventPayload('dmabc12', DAY_100!, options).status).toBe('confirmed')
  })

  it('records the start date in the description', () => {
    expect(buildEventPayload('dmabc12', DAY_100!, options).description).toBe(
      'Day Marker · Started 2026-01-01',
    )
  })

  it('stamps private extended properties for future discovery', () => {
    const p = buildEventPayload('dmabc12', DAY_100!, options)
    expect(p.extendedProperties.private).toEqual({
      dayMarkerVersion: '1',
      startDate: '2026-01-01',
      milestoneKey: 'd100',
    })
  })
})

describe('buildEventPayload — reminders', () => {
  it.each([
    ['day1', 900],
    ['day3', 3780],
    ['week1', 9540],
  ] as const)('maps %s to %i minutes before midnight', (preset, minutes) => {
    const p = buildEventPayload('dmabc12', DAY_100!, { ...options, reminder: preset })
    expect(p.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: 'popup', minutes }],
    })
  })

  it('emits no overrides when the preset is none', () => {
    const p = buildEventPayload('dmabc12', DAY_100!, { ...options, reminder: 'none' })
    expect(p.reminders).toEqual({ useDefault: false, overrides: [] })
  })

  it('keeps every offset inside Google\'s 0..40320 range', () => {
    for (const minutes of Object.values(REMINDER_MINUTES)) {
      if (minutes === null) continue
      expect(minutes).toBeGreaterThanOrEqual(0)
      expect(minutes).toBeLessThanOrEqual(40320)
    }
  })
})
