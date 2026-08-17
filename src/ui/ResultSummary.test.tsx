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

  it('prefers the live error over a stored item error', () => {
    render(
      <ResultSummary
        results={results}
        error="Sign-in was cancelled"
        onRetry={() => {}}
        onReset={() => {}}
      />,
    )
    // The newer cause explains the situation; 'boom' was recorded last attempt.
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in was cancelled')
    expect(screen.getByRole('alert')).not.toHaveTextContent('boom')
  })

  it('shows an error alert even when nothing failed', () => {
    render(
      <ResultSummary
        results={[result(0, 'added')]}
        error="Sign-in was cancelled"
        onRetry={() => {}}
        onReset={() => {}}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in was cancelled')
    // The celebration block must not appear alongside an error.
    expect(screen.queryByText('added to your calendar')).not.toBeInTheDocument()
  })
})

describe('ResultSummary — nothing needed writing', () => {
  it('does not claim events were added when every item was unchanged', () => {
    // `succeeded` includes 'skipped', so this used to read
    // "🎉 2 milestones / added to your calendar" for a submission that wrote
    // nothing at all.
    render(
      <ResultSummary
        results={[result(0, 'skipped'), result(1, 'skipped')]}
        onRetry={() => {}}
        onReset={() => {}}
      />,
    )
    expect(screen.getByText('2 milestones')).toBeInTheDocument()
    expect(screen.getByText('already on your calendar')).toBeInTheDocument()
    expect(screen.queryByText('added to your calendar')).not.toBeInTheDocument()
  })

  it('still reports "added" when at least one item was written', () => {
    render(
      <ResultSummary
        results={[result(0, 'skipped'), result(1, 'added')]}
        onRetry={() => {}}
        onReset={() => {}}
      />,
    )
    expect(screen.getByText('added to your calendar')).toBeInTheDocument()
    expect(screen.queryByText('already on your calendar')).not.toBeInTheDocument()
  })
})
