import { render, screen } from '@testing-library/react'
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

function deps(): DayMarkerDeps {
  const auth: Auth = {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => null),
    clear: vi.fn(),
  }
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
})
