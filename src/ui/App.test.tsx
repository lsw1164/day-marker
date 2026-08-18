import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '@/ui/App'
import type { DayMarkerDeps } from '@/ui/useDayMarker'
import type { Auth } from '@/google/auth'
import type { CalendarApi } from '@/google/calendarApi'
import type { GoogleEventPayload } from '@/domain/eventPayload'
import { calendarDate } from '@/domain/calendarDate'

function deps(over: Partial<DayMarkerDeps> = {}): DayMarkerDeps {
  const auth: Auth = {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => 'tok'),
    clear: vi.fn(),
  }
  const api: CalendarApi = {
    getEvent: vi.fn(async () => null),
    insertEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    patchEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    listEvents: vi.fn(async () => ({ items: [] })),
    deleteEvent: vi.fn(async () => 'deleted' as const),
  }
  return { auth, api, todayDate: calendarDate('2026-06-01'), probeDelayMs: 0, ...over }
}

const gisReady = async () => true

/** userEvent.type is unreliable on <input type="date">; set the value directly. */
function enterStartDate(value: string) {
  fireEvent.change(screen.getByLabelText(/Start date/), { target: { value } })
}

/**
 * Renders and waits for the GIS readiness promise to resolve. `gisReady` starts
 * as `null` — "not known yet" — and Connect is disabled until it is `true`, so a
 * click issued in the same tick as `render` would silently do nothing. Awaiting
 * the enabled button makes that dependency explicit rather than a race.
 */
async function renderReady(d: DayMarkerDeps = deps()) {
  render(<App deps={d} checkGisReady={gisReady} />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Connect Google account/ })).toBeEnabled(),
  )
}

function summaries(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => (call[0] as GoogleEventPayload).summary)
}

describe('App — idle', () => {
  it('prompts for a date before anything else', async () => {
    await renderReady()
    expect(screen.getByText(/Pick a start date/)).toBeInTheDocument()
  })

  it('lists milestones with no Google connection', async () => {
    await renderReady()
    enterStartDate('2026-01-01')
    expect(await screen.findByText('Day 100')).toBeInTheDocument()
    expect(screen.getByText('13 milestones')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Connect Google account/ })).toBeInTheDocument()
  })
})

describe('App — connected', () => {
  it('shows real badges and the work the button will do', async () => {
    await renderReady()
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    // 13 milestones from 2026-01-01. On 2026-06-01, Day 100 (Apr 10) and
    // Day 200 (Jul 19)... only Day 100 is past, so 12 remain selected.
    expect(await screen.findByRole('button', { name: 'Add 12' })).toBeInTheDocument()
    expect(screen.getAllByText('New').length).toBeGreaterThan(0)
  })

  it('will not submit a plan that no longer matches the inputs', async () => {
    // Editing the Label makes every `needsUpdate` in the plan stale — it was
    // computed against the old title. Submitting inside the debounce window
    // therefore skipped the rename: the item is still exists/needsUpdate:false,
    // so applyOne returns 'skipped' and the event keeps its old summary while
    // the result screen says "Unchanged".
    await renderReady()
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    expect(await screen.findByRole('button', { name: 'Add 12' })).toBeEnabled()

    // fireEvent, not userEvent.type: this must assert in the same tick as the
    // edit, before the debounce can elapse, or the test measures nothing.
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: 'Us' } })
    expect(screen.getByRole('button', { name: 'Add 12' })).toBeDisabled()
    // The badges stay on screen while the re-probe is pending — that part of the
    // preview behaviour is what moving `probing` into the debounce bought.
    expect(screen.getAllByText('New').length).toBeGreaterThan(0)

    // ...and the button comes back once the fresh plan lands.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add 12' })).toBeEnabled())
  })

  it('writes the selected milestones and shows the result', async () => {
    const d = deps()
    await renderReady(d)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add 12' }))
    await waitFor(() => expect(screen.getByText('12 milestones')).toBeInTheDocument())
    expect(d.api.insertEvent).toHaveBeenCalledTimes(12)
    expect(screen.getByText('added to your calendar')).toBeInTheDocument()
  })
})

describe('App — errors', () => {
  it('shows the reason when connecting fails', async () => {
    const d = deps()
    ;(d.auth.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('popup_closed'))
    await renderReady(d)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('popup_closed')
  })

  it('warns when the Google script never loads', async () => {
    render(<App deps={deps()} checkGisReady={async () => false} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/)
    expect(screen.getByRole('button', { name: /Connect Google account/ })).toBeDisabled()
    // One wording of the problem, not two: the technical
    // AuthError('Google sign-in script has not loaded') used to arrive first,
    // from a click the optimistic default allowed during the readiness poll.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('reports a blocked script once, in the user-facing wording', async () => {
    // The double-alert path. With an optimistic default the Connect button was
    // live for the whole ten-second readiness poll, so an ad-blocked user's click
    // put AuthError('Google sign-in script has not loaded') on screen verbatim,
    // and the purpose-built copy then joined it as a second role="alert".
    const d = deps()
    ;(d.auth.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Google sign-in script has not loaded'),
    )
    let answer!: (ready: boolean) => void
    render(
      <App
        deps={d}
        checkGisReady={() =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          })
        }
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    expect(d.auth.connect).not.toHaveBeenCalled()

    answer(false)
    const alert = await screen.findByRole('alert')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(alert).toHaveTextContent(/could not load/)
    expect(alert).not.toHaveTextContent('has not loaded')
  })

  it('keeps Connect disabled until the readiness check answers', () => {
    // A never-resolving check stands in for the ten-second poll. Enabling the
    // button here would send the user straight into an internal error message.
    render(<App deps={deps()} checkGisReady={() => new Promise<boolean>(() => {})} />)
    expect(screen.getByRole('button', { name: /Connect Google account/ })).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('never shows two alerts when a retry reconnect fails', async () => {
    // The whole path: write everything, have every item fail, then click
    // "Reconnect and finish…" with a reconnect that fails for a reason the hook
    // does not swallow. Previously App's error Alert and ResultSummary's failure
    // Alert both rendered, leaving two role="alert" elements on screen.
    const d = deps()
    ;(d.api.insertEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('insert exploded'),
    )
    await renderReady(d)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add 12' }))
    const retry = await screen.findByRole('button', { name: /Reconnect and finish/ })

    ;(d.auth.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('popup_closed'))
    await userEvent.click(retry)

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('popup_closed')
  })

  it('does not attempt writes when a retry reconnect fails', async () => {
    const d = deps()
    ;(d.api.insertEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('insert exploded'),
    )
    await renderReady(d)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add 12' }))
    const retry = await screen.findByRole('button', { name: /Reconnect and finish/ })
    const writesBefore = (d.api.insertEvent as ReturnType<typeof vi.fn>).mock.calls.length

    ;(d.auth.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('popup_closed'))
    await userEvent.click(retry)

    // Writing with a dead token would re-fail every item and bury the real cause.
    expect((d.api.insertEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writesBefore)
  })
})

describe('App — successful retry', () => {
  it('retries only the failures and keeps the earlier successes in the report', async () => {
    // The path no test covered: a retry whose reconnect SUCCEEDS. Both existing
    // retry tests fail the reconnect on purpose, which is why `run()`'s
    // unconditional setResults([]) survived — it threw away the first pass, so
    // the report claimed "2 milestones" for a run that wrote twelve.
    const d = deps()
    const insertEvent = d.api.insertEvent as ReturnType<typeof vi.fn>
    const doomed = new Set(['Day 900', 'Day 1000'])
    // Keyed on the payload, not the call count: applyPlan runs three writes at a
    // time, so which call index fails is not something a test should assume.
    let firstPass = true
    insertEvent.mockImplementation(async (payload: GoogleEventPayload) => {
      if (firstPass && doomed.has(payload.summary)) throw new Error('insert exploded')
      return { id: payload.id, status: 'confirmed' as const }
    })

    await renderReady(d)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add 12' }))

    const retry = await screen.findByRole('button', {
      name: 'Reconnect and finish the remaining 2',
    })
    expect(screen.getByText('10 added · 2 failed')).toBeInTheDocument()
    const firstPassWrites = summaries(insertEvent)

    firstPass = false
    await userEvent.click(retry)
    await waitFor(() => expect(screen.getByText('12 milestones')).toBeInTheDocument())

    // (a) the second pass wrote ONLY the two items that had failed.
    expect(summaries(insertEvent).slice(firstPassWrites.length).sort()).toEqual([
      'Day 1000',
      'Day 900',
    ])
    // (b) the ten that already succeeded are still counted, and the run reads as
    // finished rather than as a fresh two-item submission.
    expect(screen.getByText('added to your calendar')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reconnect and finish/ })).not.toBeInTheDocument()
  })
})
