import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ResultSummary } from '@/ui/ResultSummary'
import type { ItemResult } from '@/google/apply'
import type { PlanItem } from '@/google/plan'
import { computeMilestones } from '@/domain/milestones'
import { calendarDate } from '@/domain/calendarDate'

const MILESTONES = computeMilestones(calendarDate('2026-01-01'), 1)

function result(i: number, outcome: ItemResult['outcome']): ItemResult {
  const item: PlanItem = {
    milestone: MILESTONES[i]!,
    eventId: `dm${i}`,
    status: 'new',
    past: false,
    selected: true,
    needsUpdate: false,
  }
  return { item, outcome, ...(outcome === 'failed' ? { error: 'boom' } : {}) }
}

describe('ResultSummary — success', () => {
  const results = [result(0, 'added'), result(1, 'updated')]

  it('reports the count', () => {
    render(<ResultSummary results={results} onRetry={() => {}} onReset={() => {}} />)
    expect(screen.getByText('2 milestones')).toBeInTheDocument()
    expect(screen.getByText('added to your calendar')).toBeInTheDocument()
  })

  it('links to the first milestone in Google Calendar', () => {
    render(<ResultSummary results={results} onRetry={() => {}} onReset={() => {}} />)
    expect(screen.getByRole('link', { name: /View in Calendar/ })).toHaveAttribute(
      'href',
      'https://calendar.google.com/calendar/r/day/2026/4/10',
    )
  })

  it('does not offer a retry when nothing failed', () => {
    render(<ResultSummary results={results} onRetry={() => {}} onReset={() => {}} />)
    expect(screen.queryByRole('button', { name: /Reconnect/ })).not.toBeInTheDocument()
  })

  it('starts over on request', async () => {
    const onReset = vi.fn()
    render(<ResultSummary results={results} onRetry={() => {}} onReset={onReset} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(onReset).toHaveBeenCalled()
  })
})

describe('ResultSummary — partial failure', () => {
  const results = [result(0, 'added'), result(1, 'failed'), result(2, 'failed')]

  it('reports both counts', () => {
    render(<ResultSummary results={results} onRetry={() => {}} onReset={() => {}} />)
    expect(screen.getByText('1 added · 2 failed')).toBeInTheDocument()
  })

  it('offers a retry scoped to the failures only', async () => {
    const onRetry = vi.fn()
    render(<ResultSummary results={results} onRetry={onRetry} onReset={() => {}} />)
    const button = screen.getByRole('button', { name: 'Reconnect and finish the remaining 2' })
    await userEvent.click(button)
    expect(onRetry).toHaveBeenCalled()
  })
})
