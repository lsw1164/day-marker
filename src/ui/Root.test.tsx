import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Root } from '@/ui/Root'
import type { DayMarkerDeps } from '@/ui/useDayMarker'
import type { Auth } from '@/google/auth'
import type { AppCalendar } from '@/google/appCalendar'
import type { CalendarApi } from '@/google/calendarApi'
import { calendarDate } from '@/domain/calendarDate'
import { COPY } from '@/ui/copy'

function stubCalendar(): AppCalendar {
  return { ensure: vi.fn(async () => 'cal-1'), id: vi.fn(() => 'cal-1'), forget: vi.fn() }
}

/**
 * A behavioural fake, not a mock: `token()` answers from the same slot
 * `connect()` fills, exactly as the real auth closure does. A stub that always
 * returned a token would render every disconnected assertion below meaningless,
 * and one that always returned null could not observe a connection surviving a
 * route change at all.
 */
function statefulAuth(): Auth {
  let live: string | null = null
  return {
    connect: vi.fn(async () => {
      live = 'tok'
      return live
    }),
    token: vi.fn(() => live),
    clear: vi.fn(() => {
      live = null
    }),
  }
}

function deps(): DayMarkerDeps {
  const auth: Auth = statefulAuth()
  const api: CalendarApi = {
    getEvent: vi.fn(async () => null),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    listEvents: vi.fn(async () => ({ items: [] })),
    deleteEvent: vi.fn(async () => 'deleted' as const),
  }
  return {
    auth,
    api,
    calendar: stubCalendar(),
    todayDate: calendarDate('2026-06-01'),
    probeDelayMs: 0,
  }
}

const ready = async () => true

describe('Root', () => {
  it('renders the write flow at /', () => {
    render(<Root deps={deps()} initialEntries={['/']} checkGisReady={ready} />)
    expect(screen.getByText(/Pick a start date/)).toBeInTheDocument()
  })

  it('renders the registrations page at /registrations', () => {
    render(<Root deps={deps()} initialEntries={['/registrations']} checkGisReady={ready} />)
    expect(
      screen.getByRole('heading', { name: COPY.registrationsTitle }),
    ).toBeInTheDocument()
  })

  it('shows the shared header on both routes', () => {
    render(<Root deps={deps()} initialEntries={['/registrations']} checkGisReady={ready} />)
    expect(screen.getByRole('heading', { name: COPY.appName })).toBeInTheDocument()
  })

  /**
   * A `<Route element>` unmounts on navigation, so neither page's hook state
   * survives a tab switch. The token does -- it lives in the `auth` singleton,
   * above both hooks -- which is why `connected` has to be derived from it on
   * mount rather than assumed false. Without that, connecting and then changing
   * tabs reports "Not connected" beside a live session, and offers a Connect
   * button that re-opens Google's popup for a grant the user already gave.
   */
  it('keeps a connection made on Registrations after switching to the write flow', async () => {
    render(<Root deps={deps()} initialEntries={['/registrations']} checkGisReady={ready} />)
    await userEvent.click(
      await screen.findByRole('button', { name: COPY.connect }),
    )
    await waitFor(() => expect(screen.getByText(COPY.connected)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('link', { name: COPY.navNew }))

    expect(screen.getByText(/Pick a start date/)).toBeInTheDocument()
    expect(screen.getByText(COPY.connected)).toBeInTheDocument()
  })

  it('keeps a sign-out made in the write flow after switching to Registrations', async () => {
    // The mirror of the two tests above, and the reason `connected` must be
    // derived from the token rather than merely seeded once: a sign-out that did
    // not actually clear the token would look right on the page that performed
    // it and wrong on the next one.
    render(<Root deps={deps()} initialEntries={['/']} checkGisReady={ready} />)
    await userEvent.click(await screen.findByRole('button', { name: COPY.connect }))
    await waitFor(() => expect(screen.getByText(COPY.connected)).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: COPY.signOut }))

    await userEvent.click(screen.getByRole('link', { name: COPY.navRegistrations }))

    expect(screen.getByText(COPY.notConnected)).toBeInTheDocument()
    expect(screen.getByText(COPY.registrationsConnectPrompt)).toBeInTheDocument()
  })

  it('keeps a connection made in the write flow after switching to Registrations', async () => {
    render(<Root deps={deps()} initialEntries={['/']} checkGisReady={ready} />)
    await userEvent.click(
      await screen.findByRole('button', { name: COPY.connect }),
    )
    await waitFor(() => expect(screen.getByText(COPY.connected)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('link', { name: COPY.navRegistrations }))

    expect(screen.getByText(COPY.connected)).toBeInTheDocument()
  })
})
