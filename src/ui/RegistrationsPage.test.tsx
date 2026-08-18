import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RegistrationsPage } from '@/ui/RegistrationsPage'
import type { Auth } from '@/google/auth'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { calendarDate } from '@/domain/calendarDate'
import { Unauthorized } from '@/google/errors'
import { COPY } from '@/ui/copy'
import type { DayMarkerDeps } from '@/ui/useDayMarker'

function ev(
  id: string,
  startDate: string,
  key: string,
  date: string,
  pair = 'Anna & Ben',
): GoogleEvent {
  return {
    id,
    status: 'confirmed',
    summary: `${pair}: ${key}`,
    start: { date },
    extendedProperties: { private: { dayMarkerVersion: '1', startDate, milestoneKey: key } },
  }
}

function deps(items: GoogleEvent[], token: string | null = 'tok'): DayMarkerDeps {
  const auth: Auth = {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => token),
    clear: vi.fn(),
  }
  const api = {
    getEvent: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(async () => 'deleted' as const),
    listEvents: vi.fn(async () => ({ items })),
  } as unknown as CalendarApi
  return { auth, api }
}

const ready = async () => true
const TODAY = calendarDate('2026-06-01')

// Two genuinely distinct registrations -- different start dates, titles, and
// event counts -- not two events sharing one start date. A fixture with only
// one registration cannot distinguish code that acts on "the registration the
// user clicked" from code that acts on "registrations[0]" or matches a result
// to a row by array position instead of identity; every assertion below that
// targets registration B specifically exists to catch exactly that class of
// bug.
const REG_A = [ev('a1', '2025-03-14', 'd100', '2025-06-21')]
const REG_B = [
  ev('b1', '2024-01-01', 'y1', '2025-01-01', 'Cara & Dan'),
  ev('b2', '2024-01-01', 'y2', '2026-01-01', 'Cara & Dan'),
]
const TWO = [...REG_A, ...REG_B]
const TITLE_A = 'Anna & Ben: d100'
const TITLE_B = 'Cara & Dan: y1'

/** Scopes an assertion to the one registration card carrying `title`. */
async function rowFor(title: string): Promise<HTMLElement> {
  const row = (await screen.findByText(title)).closest('li')
  if (!row) throw new Error(`no <li> ancestor for "${title}"`)
  return row
}

describe('RegistrationsPage', () => {
  it('prompts to connect when there is no token', () => {
    render(<RegistrationsPage deps={deps([], null)} checkGisReady={ready} todayDate={TODAY} />)
    expect(screen.getByText(COPY.registrationsConnectPrompt)).toBeInTheDocument()
  })

  it('lists both registrations, each attributed to its own title and count', async () => {
    render(<RegistrationsPage deps={deps(TWO)} checkGisReady={ready} todayDate={TODAY} />)
    const rowA = await rowFor(TITLE_A)
    const rowB = await rowFor(TITLE_B)
    expect(within(rowA).getByText(COPY.registrationMeta('Mar 14, 2025', 1))).toBeInTheDocument()
    expect(within(rowB).getByText(COPY.registrationMeta('Jan 1, 2024', 2))).toBeInTheDocument()
    expect(screen.getByText(COPY.registrationsCount(2))).toBeInTheDocument()
  })

  it('shows an empty state when nothing is registered', async () => {
    render(<RegistrationsPage deps={deps([])} checkGisReady={ready} todayDate={TODAY} />)
    expect(await screen.findByText(COPY.registrationsEmpty)).toBeInTheDocument()
  })

  it('shows a loading message before the list resolves, distinct from empty', async () => {
    let resolveList: ((v: { items: GoogleEvent[] }) => void) | undefined
    const d = deps([])
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        }),
    )
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    expect(await screen.findByText(COPY.registrationsLoading)).toBeInTheDocument()
    expect(screen.queryByText(COPY.registrationsEmpty)).not.toBeInTheDocument()
    resolveList?.({ items: [] })
    expect(await screen.findByText(COPY.registrationsEmpty)).toBeInTheDocument()
  })

  it('deletes the second registration by identity, leaving the first untouched', async () => {
    const d = deps(TWO)
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    const rowB = await rowFor(TITLE_B)
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteOpen }))
    // The confirm dialog opened on B must show B's own count (2), not A's (1).
    expect(within(rowB).getByRole('button', { name: COPY.deleteConfirm(2) })).toBeInTheDocument()
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteConfirm(2) }))
    await waitFor(() =>
      expect(within(rowB).getByText(COPY.deleteSummary(2, 0, 0))).toBeInTheDocument(),
    )
    expect(d.api.deleteEvent).toHaveBeenCalledTimes(2)
    expect(d.api.deleteEvent).toHaveBeenCalledWith('b1')
    expect(d.api.deleteEvent).toHaveBeenCalledWith('b2')
    expect(d.api.deleteEvent).not.toHaveBeenCalledWith('a1')
    // A's own control is untouched -- still in 'list' state, not swept into B's.
    const rowA = await rowFor(TITLE_A)
    expect(within(rowA).getByRole('button', { name: COPY.deleteOpen })).toBeInTheDocument()
  })

  it('reports a listing failure without claiming the calendar is empty', async () => {
    const d = deps(TWO)
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('list exploded'))
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('list exploded')
    expect(screen.queryByRole('button', { name: COPY.deleteOpen })).not.toBeInTheDocument()
    // A failed load is not the same fact as an empty calendar -- reporting the
    // latter here would tell the user their calendar is empty when it is not.
    expect(screen.queryByText(COPY.registrationsEmpty)).not.toBeInTheDocument()
  })

  it('offers a retry after a failed load, which re-lists on success', async () => {
    const d = deps(TWO)
    const listEvents = d.api.listEvents as ReturnType<typeof vi.fn>
    listEvents.mockRejectedValueOnce(new Error('list exploded'))
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('list exploded')
    const retry = screen.getByRole('button', { name: COPY.listRetry })
    await userEvent.click(retry)
    expect(listEvents).toHaveBeenCalledTimes(2)
    expect(await screen.findByText(TITLE_A)).toBeInTheDocument()
    expect(await screen.findByText(TITLE_B)).toBeInTheDocument()
  })

  it('shows the connect prompt, not a retry button, when the token expires mid-listing', async () => {
    // The spec treats these as two different rows: an expired token routes to
    // reconnecting, a page of results failing routes to retrying -- and the
    // retry button would do nothing here anyway, since the load effect
    // early-returns while disconnected. (The retry-button arm for a non-auth
    // failure is covered by "offers a retry after a failed load…" above --
    // together the two tests cover both arms of this branch.)
    const d = deps(TWO)
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Unauthorized(401, 'authError', ''))
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    expect(await screen.findByText(COPY.registrationsConnectPrompt)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: COPY.listRetry })).not.toBeInTheDocument()
  })

  it('shows exactly one alert while confirming a delete', async () => {
    // The confirm warning is itself an alert, so a stray page-level alert would
    // make every getByRole('alert') query ambiguous.
    render(<RegistrationsPage deps={deps(TWO)} checkGisReady={ready} todayDate={TODAY} />)
    const rowB = await rowFor(TITLE_B)
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteOpen }))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('moves focus to the Cancel button on entering confirm, not the top of the document', async () => {
    // RegistrationRow's own "Delete…" button unmounts the instant a row opens;
    // without an explicit focus move, the browser drops focus to <body> and a
    // keyboard user is left at the top of the page mid-flow, on a destructive
    // action.
    render(<RegistrationsPage deps={deps(TWO)} checkGisReady={ready} todayDate={TODAY} />)
    const rowB = await rowFor(TITLE_B)
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteOpen }))
    expect(within(rowB).getByRole('button', { name: COPY.deleteCancel })).toHaveFocus()
  })

  it('returns focus to the row’s own Delete… button on Cancel', async () => {
    // Cancelling drops the row back to 'list', which unmounts Cancel/Confirm
    // and remounts Delete… -- without an explicit focus move the browser
    // drops focus to <body>, same as the entry direction.
    render(<RegistrationsPage deps={deps(TWO)} checkGisReady={ready} todayDate={TODAY} />)
    const rowB = await rowFor(TITLE_B)
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteOpen }))
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteCancel }))
    expect(within(rowB).getByRole('button', { name: COPY.deleteOpen })).toHaveFocus()
  })

  it('focuses the Back to registrations button once a delete completes', async () => {
    // 'done' removes the row's own Cancel/Confirm controls entirely; the next
    // actionable control on screen is the page's own Back button.
    render(<RegistrationsPage deps={deps(TWO)} checkGisReady={ready} todayDate={TODAY} />)
    const rowB = await rowFor(TITLE_B)
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteOpen }))
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteConfirm(2) }))
    await waitFor(() =>
      expect(within(rowB).getByText(COPY.deleteSummary(2, 0, 0))).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: COPY.deleteBack })).toHaveFocus()
  })

  it('focuses the refreshed list after Back to registrations, not the document top', async () => {
    const d = deps(TWO)
    const listEvents = d.api.listEvents as ReturnType<typeof vi.fn>
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    const rowB = await rowFor(TITLE_B)
    // From here on, the calendar no longer has B -- it was just deleted.
    listEvents.mockImplementation(async () => ({ items: REG_A }))
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteOpen }))
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteConfirm(2) }))
    await waitFor(() =>
      expect(within(rowB).getByText(COPY.deleteSummary(2, 0, 0))).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteBack }))
    await waitFor(() => expect(screen.queryByText(TITLE_B)).not.toBeInTheDocument())
    expect(screen.getByRole('list')).toHaveFocus()
  })

  it('falls through to the empty-state message if the post-refresh list comes back empty', async () => {
    const d = deps(TWO)
    const listEvents = d.api.listEvents as ReturnType<typeof vi.fn>
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    const rowB = await rowFor(TITLE_B)
    listEvents.mockImplementation(async () => ({ items: [] }))
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteOpen }))
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteConfirm(2) }))
    await waitFor(() =>
      expect(within(rowB).getByText(COPY.deleteSummary(2, 0, 0))).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteBack }))
    expect(await screen.findByText(COPY.registrationsEmpty)).toHaveFocus()
  })

  it('falls through to the retry button if the post-refresh reload itself fails', async () => {
    const d = deps(TWO)
    const listEvents = d.api.listEvents as ReturnType<typeof vi.fn>
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    const rowB = await rowFor(TITLE_B)
    listEvents.mockRejectedValue(new Error('reload exploded'))
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteOpen }))
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteConfirm(2) }))
    await waitFor(() =>
      expect(within(rowB).getByText(COPY.deleteSummary(2, 0, 0))).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteBack }))
    expect(await screen.findByRole('button', { name: COPY.listRetry })).toHaveFocus()
  })

  it('focuses the Connect button after a halted run and Back to registrations', async () => {
    // The halted-run exit calls disconnectAfterHalt(), not refresh() -- phase
    // never re-enters 'loading' here, it just never was in it, and the
    // list/empty/retry fallthrough chain above does not apply on this branch
    // at all.
    const d = deps(TWO)
    ;(d.api.deleteEvent as ReturnType<typeof vi.fn>).mockRejectedValue(new Unauthorized(401, 'authError', ''))
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    const rowB = await rowFor(TITLE_B)
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteOpen }))
    await userEvent.click(within(rowB).getByRole('button', { name: COPY.deleteConfirm(2) }))
    const backButton = await screen.findByRole('button', { name: COPY.deleteBack })
    await waitFor(() => expect(backButton).toHaveFocus())
    // React reuses this exact host button node for the Connect button that
    // replaces it (both sit at the same fragment position), so if this
    // button already has focus, focus would carry over "for free" even
    // without the fix under test -- a click via userEvent would refocus this
    // same node on the way in and recreate that coincidence. Break it
    // deliberately: blur first, then dispatch a raw click that does not
    // itself move focus, so only an explicit focus() call in the fix can
    // make the final assertion pass.
    backButton.blur()
    fireEvent.click(backButton)
    expect(await screen.findByRole('button', { name: COPY.connect })).toHaveFocus()
  })
})
