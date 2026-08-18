import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RegistrationRow, type RegistrationRowProps } from '@/ui/RegistrationRow'
import { DELETE_HALTED, type Registration } from '@/google/registrations'
import { calendarDate } from '@/domain/calendarDate'
import { COPY } from '@/ui/copy'

const TODAY = calendarDate('2026-06-01')

const REG: Registration = {
  startDate: calendarDate('2025-03-14'),
  title: 'Anna & Ben: Day 100',
  count: 3,
  events: [
    { id: 'a', date: calendarDate('2025-06-21'), label: 'Day 100' },
    { id: 'b', date: calendarDate('2026-03-14'), label: '1 Year' },
    { id: 'c', date: calendarDate('2027-03-14'), label: '2 Years' },
  ],
}

const noop = () => {}

function renderRow(over: Partial<RegistrationRowProps> = {}) {
  return render(
    <RegistrationRow
      registration={REG}
      todayDate={TODAY}
      state="list"
      results={[]}
      onBeginConfirm={noop}
      onCancel={noop}
      onConfirm={noop}
      {...over}
    />,
  )
}

describe('RegistrationRow — list state', () => {
  it('shows the title and the event count', () => {
    renderRow()
    expect(screen.getByText('Anna & Ben: Day 100')).toBeInTheDocument()
    expect(screen.getByText(COPY.registrationMeta('Mar 14, 2025', 3))).toBeInTheDocument()
  })

  it('does not list the events until asked', () => {
    renderRow()
    expect(screen.queryByText('1 Year')).not.toBeInTheDocument()
  })

  it('opens the confirm on request', async () => {
    const onBeginConfirm = vi.fn()
    renderRow({ onBeginConfirm })
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteOpen }))
    expect(onBeginConfirm).toHaveBeenCalled()
  })
})

describe('RegistrationRow — confirming', () => {
  it('lists every event, not a truncated preview', () => {
    // The point of the confirm step is seeing forgotten past events, so an
    // "and N more" would hide exactly what it exists to show.
    renderRow({ state: 'confirming' })
    expect(screen.getByText('Day 100')).toBeInTheDocument()
    expect(screen.getByText('1 Year')).toBeInTheDocument()
    expect(screen.getByText('2 Years')).toBeInTheDocument()
  })

  it('marks exactly the past events', () => {
    renderRow({ state: 'confirming' })
    // Against TODAY of 2026-06-01: Day 100 (2025-06-21) and 1 Year (2026-03-14)
    // are past; 2 Years (2027-03-14) is not. Asserting the count rather than
    // "at least one" is what catches an off-by-one in the boundary.
    expect(screen.getAllByText(COPY.statusPast)).toHaveLength(2)
  })

  it('warns with the count and says it cannot be undone', () => {
    renderRow({ state: 'confirming' })
    expect(screen.getByRole('alert')).toHaveTextContent(COPY.deleteWarning(3))
  })

  it('puts the count on the confirm button', () => {
    renderRow({ state: 'confirming' })
    expect(screen.getByRole('button', { name: COPY.deleteConfirm(3) })).toBeInTheDocument()
  })

  it('cancels without deleting', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    renderRow({ state: 'confirming', onCancel, onConfirm })
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteCancel }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms when asked', async () => {
    const onConfirm = vi.fn()
    renderRow({ state: 'confirming', onConfirm })
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteConfirm(3) }))
    expect(onConfirm).toHaveBeenCalled()
  })
})

describe('RegistrationRow — deleting and done', () => {
  it('disables both buttons while deleting', () => {
    renderRow({ state: 'deleting' })
    expect(screen.getByRole('button', { name: COPY.deleteCancel })).toBeDisabled()
    expect(screen.getByRole('button', { name: COPY.deleteBusy })).toBeDisabled()
  })

  it('shows progress as results land, before the run is done', () => {
    // Task 8 streams results through onProgress, so a partly-finished delete has
    // to render what has already landed -- it is the user's only feedback during
    // an operation they cannot undo. A component that rendered badges only in
    // the 'done' state would pass every other test in this file.
    renderRow({
      state: 'deleting',
      results: [{ event: REG.events[0]!, outcome: 'deleted' }],
    })
    expect(screen.getByText(COPY.outcomeDeleted)).toBeInTheDocument()
    // Day 100 is past AND finished, so its outcome replaces the past marker;
    // 1 Year is past and still in flight, so it keeps one. Asserting the count
    // pins that substitution rather than merely that both kinds of badge exist.
    expect(screen.getAllByText(COPY.statusPast)).toHaveLength(1)
  })

  it('shows an outcome per event when done', () => {
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'deleted' },
        { event: REG.events[1]!, outcome: 'alreadyGone' },
        { event: REG.events[2]!, outcome: 'failed', error: 'boom' },
      ],
    })
    expect(screen.getByText(COPY.outcomeDeleted)).toBeInTheDocument()
    expect(screen.getByText(COPY.outcomeAlreadyGone)).toBeInTheDocument()
    expect(screen.getByText(COPY.outcomeFailed)).toBeInTheDocument()
    // The reason, not just the badge. A halted run reports every unattempted
    // event as `failed`, so the count alone cannot tell a user whether their
    // registration is half-deleted or untouched.
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })

  it('offers to reconnect when the run halted, rather than showing the raw 401', () => {
    // The first failure is always the real 401, because mapWithLimit claims
    // indices in increasing order -- so selecting on `outcome === 'failed'` would
    // render "Google Calendar API 401 (authError)" and never the actionable copy.
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'failed', error: 'Google Calendar API 401 (authError)' },
        { event: REG.events[1]!, outcome: 'failed', error: DELETE_HALTED },
        { event: REG.events[2]!, outcome: 'failed', error: DELETE_HALTED },
      ],
    })
    expect(screen.getByRole('alert')).toHaveTextContent(COPY.deleteHalted)
  })

  it('says nothing extra when every event succeeded', () => {
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'deleted' },
        { event: REG.events[1]!, outcome: 'alreadyGone' },
      ],
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('summarises already-gone separately from failed', () => {
    // Already gone is a success. Folding it into failures would report a problem
    // that does not exist.
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'deleted' },
        { event: REG.events[1]!, outcome: 'alreadyGone' },
        { event: REG.events[2]!, outcome: 'deleted' },
      ],
    })
    expect(screen.getByText(COPY.deleteSummary(2, 1, 0))).toBeInTheDocument()
  })
})
