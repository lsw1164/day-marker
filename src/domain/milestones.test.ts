import { describe, expect, it } from 'vitest'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones, DEFAULT_YEARS } from '@/domain/milestones'

const START = calendarDate('2026-01-01')

describe('computeMilestones — day milestones', () => {
  it('counts the start date as day 1, so Day 100 is start + 99 days', () => {
    const day100 = computeMilestones(START, DEFAULT_YEARS).find((m) => m.key === 'd100')
    // start + 99, not start + 100 (which would be 2026-04-11).
    expect(day100?.date).toBe('2026-04-10')
  })

  it('places the later day milestones correctly', () => {
    const byKey = new Map(computeMilestones(START, DEFAULT_YEARS).map((m) => [m.key, m.date]))
    expect(byKey.get('d200')).toBe('2026-07-19')
    expect(byKey.get('d300')).toBe('2026-10-27')
    expect(byKey.get('d1000')).toBe('2028-09-26')
  })

  it('steps by 100', () => {
    const days = computeMilestones(START, DEFAULT_YEARS).filter((m) => m.kind === 'day')
    expect(days.map((m) => m.n)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])
  })

  it('labels day milestones as "Day N"', () => {
    const days = computeMilestones(START, DEFAULT_YEARS).filter((m) => m.kind === 'day')
    expect(days[0]?.label).toBe('Day 100')
    expect(days[9]?.label).toBe('Day 1000')
  })
})

describe('computeMilestones — year milestones', () => {
  it('uses the same month and day, not start + 365n', () => {
    const years = computeMilestones(START, DEFAULT_YEARS).filter((m) => m.kind === 'year')
    expect(years.map((m) => m.date)).toEqual(['2027-01-01', '2028-01-01', '2029-01-01'])
  })

  it('pluralizes the label', () => {
    const years = computeMilestones(START, DEFAULT_YEARS).filter((m) => m.kind === 'year')
    expect(years.map((m) => m.label)).toEqual(['1 Year', '2 Years', '3 Years'])
  })

  it('clamps a Feb 29 start to Feb 28 in common years', () => {
    const leap = computeMilestones(calendarDate('2024-02-29'), 1)
    expect(leap.find((m) => m.key === 'y1')?.date).toBe('2025-02-28')
  })
})

describe('computeMilestones — horizon', () => {
  it('yields exactly 13 milestones at the default 3-year range', () => {
    expect(computeMilestones(START, DEFAULT_YEARS)).toHaveLength(13)
  })

  it('yields exactly 4 milestones at a 1-year range', () => {
    const one = computeMilestones(START, 1)
    expect(one.map((m) => m.key)).toEqual(['d100', 'd200', 'd300', 'y1'])
  })

  it('never emits a day milestone past the horizon', () => {
    const horizon = '2029-01-01'
    for (const m of computeMilestones(START, 3)) {
      expect(m.date <= horizon).toBe(true)
    }
  })

  it('lists day milestones before year milestones', () => {
    const kinds = computeMilestones(START, DEFAULT_YEARS).map((m) => m.kind)
    expect(kinds.indexOf('year')).toBe(kinds.lastIndexOf('day') + 1)
  })
})

describe('computeMilestones — keys', () => {
  it('uses label-independent keys', () => {
    const keys = computeMilestones(START, 1).map((m) => m.key)
    expect(keys).toEqual(['d100', 'd200', 'd300', 'y1'])
  })

  it('produces unique keys', () => {
    const keys = computeMilestones(START, 10).map((m) => m.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
