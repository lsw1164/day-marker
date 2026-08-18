import { render, screen, within } from '@testing-library/react'
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

/** Scopes an assertion to the one event row carrying `label`, not the whole card. */
function rowFor(label: string): HTMLElement {
  const row = screen.getByText(label).closest('li')
  if (!row) throw new Error(`no <li> ancestor for "${label}"`)
  return row
}

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

  it('renders all 46 events of a ten-year registration, not just a four-row preview', () => {
    // The fixture above has only 3 events, so `registration.events.slice(0, 4)`
    // -- ResultSummary's own truncation pattern, sitting in the same directory
    // -- would pass the test above just as well as showing everything. A
    // ten-year registration is 46 rows, and the spec is emphatic that none of
    // them may be hidden behind an "and N more".
    const manyEvents = Array.from({ length: 46 }, (_, i) => ({
      id: `e${i}`,
      date: calendarDate('2025-06-21'),
      label: `Event ${i}`,
    }))
    const bigReg: Registration = { ...REG, count: manyEvents.length, events: manyEvents }
    renderRow({ registration: bigReg, state: 'confirming' })
    expect(screen.getAllByText(/^Event \d+$/)).toHaveLength(46)
    expect(screen.getByText('Event 45')).toBeInTheDocument()
  })

  it('marks exactly the past events, with today excluded from the count', () => {
    // Against TODAY of 2026-06-01: Day 100 (2025-06-21) and 1 Year (2026-03-14)
    // are past; 2 Years (2027-03-14) is not, and neither is an event landing
    // exactly on TODAY -- a milestone due today has not passed, and its date
    // is already on screen, so it needs no marker. The original three-event
    // fixture alone cannot catch `<=` replacing `<` at the boundary, since
    // none of its dates land on TODAY; adding a same-day event and asserting
    // both that it carries no marker AND that the total count stays at 2
    // (not 3) is what actually pins the boundary.
    const regWithToday: Registration = {
      ...REG,
      events: [...REG.events, { id: 'd', date: TODAY, label: 'Today' }],
    }
    renderRow({ registration: regWithToday, state: 'confirming' })
    expect(within(rowFor('Today')).queryByText(COPY.statusPast)).not.toBeInTheDocument()
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

  it('attributes each outcome to its own event, whatever order results arrive in', () => {
    // useRegistrations.confirmDelete accumulates results in COMPLETION order
    // (onProgress does `collected.push(result)` under mapWithLimit at
    // concurrency 3), not input order, so out-of-order is the normal case in
    // production. Every other fixture in this file puts `results` in the same
    // relative order as `registration.events`, as an index-aligned prefix --
    // which would let a match-by-position regression (e.g. keying by
    // `registration.events.indexOf(event)` instead of `event.id`) pass every
    // other test. Scoping each assertion to its own row, via `rowFor`, is
    // what actually pins attribution: a plain `getByText` would pass whether
    // the badge landed on the right row or the wrong one.
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[2]!, outcome: 'deleted' },
        { event: REG.events[0]!, outcome: 'failed', error: 'boom' },
      ],
    })
    expect(within(rowFor('2 Years')).getByText(COPY.outcomeDeleted)).toBeInTheDocument()
    expect(within(rowFor('Day 100')).getByText(COPY.outcomeFailed)).toBeInTheDocument()
    // '1 Year' never got a result: it keeps its past marker, not any outcome.
    expect(within(rowFor('1 Year')).getByText(COPY.statusPast)).toBeInTheDocument()
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

  it('offers to reconnect when the run halted, rather than showing a raw error', () => {
    // Since ed5521c, deleteRegistration stamps DELETE_HALTED on the item that
    // triggers the halt too, not only the ones queued behind it -- so every
    // failed result in a halted run carries the sentinel, and a raw 401
    // string never actually reaches this component. The sentinel is still
    // preferred deliberately: it is the one signal that says "reconnecting is
    // what fixes this," which no arbitrary error string can promise. The
    // raw-error path (an ordinary, non-halted failure) is already covered by
    // the 'boom' assertion in the test above.
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'failed', error: DELETE_HALTED },
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

  it('reports a non-zero failed count when a delete actually failed', () => {
    // Every other 'done' fixture in this file uses deleteSummary(2, 1, 0) --
    // zero failed -- so a component that hardcoded `const failed = 0`, or
    // dropped the failed-count clause from COPY.deleteSummary, would pass
    // every one of them while silently reporting a failed delete as clean.
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'deleted' },
        { event: REG.events[1]!, outcome: 'failed', error: 'boom' },
        { event: REG.events[2]!, outcome: 'failed', error: 'boom' },
      ],
    })
    expect(screen.getByText(COPY.deleteSummary(1, 0, 2))).toBeInTheDocument()
  })

  it('attributes each outcome by event id, even when two events share a label', () => {
    // Every fixture elsewhere in this file gives each event a unique label, so
    // keying the attribution map on the label instead of the id would survive
    // them all. labelFor returns '' for an event missing its milestoneKey
    // stamp, so two such events in one registration is a real way to collide
    // -- forced here directly, since what matters is the map's key, not how a
    // duplicate label comes about.
    const dupLabel: Registration = {
      ...REG,
      count: 2,
      events: [
        { id: 'x', date: calendarDate('2025-06-21'), label: 'Day 100' },
        { id: 'y', date: calendarDate('2026-03-14'), label: 'Day 100' },
      ],
    }
    renderRow({
      registration: dupLabel,
      state: 'done',
      results: [
        { event: dupLabel.events[0]!, outcome: 'deleted' },
        { event: dupLabel.events[1]!, outcome: 'failed', error: 'boom' },
      ],
    })
    const rows = screen.getAllByText('Day 100').map((el) => {
      const li = el.closest('li')
      if (!li) throw new Error('no <li> ancestor for "Day 100"')
      return li
    })
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText(COPY.outcomeDeleted)).toBeInTheDocument()
    expect(within(rows[1]!).getByText(COPY.outcomeFailed)).toBeInTheDocument()
  })
})
