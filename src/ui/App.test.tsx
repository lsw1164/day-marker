import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '@/ui/App'
import type { DayMarkerDeps } from '@/ui/useDayMarker'
import type { Auth } from '@/google/auth'
import type { CalendarApi } from '@/google/calendarApi'
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
  }
  return { auth, api, todayDate: calendarDate('2026-06-01'), probeDelayMs: 0, ...over }
}

const gisReady = async () => true

/** userEvent.type is unreliable on <input type="date">; set the value directly. */
function enterStartDate(value: string) {
  fireEvent.change(screen.getByLabelText(/Start date/), { target: { value } })
}

describe('App — idle', () => {
  it('prompts for a date before anything else', () => {
    render(<App deps={deps()} checkGisReady={gisReady} />)
    expect(screen.getByText(/Pick a start date/)).toBeInTheDocument()
  })

  it('lists milestones with no Google connection', async () => {
    render(<App deps={deps()} checkGisReady={gisReady} />)
    enterStartDate('2026-01-01')
    expect(await screen.findByText('Day 100')).toBeInTheDocument()
    expect(screen.getByText('13 milestones')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Connect Google account/ })).toBeInTheDocument()
  })
})

describe('App — connected', () => {
  it('shows real badges and the work the button will do', async () => {
    render(<App deps={deps()} checkGisReady={gisReady} />)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    // 13 milestones from 2026-01-01. On 2026-06-01, Day 100 (Apr 10) and
    // Day 200 (Jul 19)... only Day 100 is past, so 12 remain selected.
    expect(await screen.findByRole('button', { name: 'Add 12' })).toBeInTheDocument()
    expect(screen.getAllByText('New').length).toBeGreaterThan(0)
  })

  it('writes the selected milestones and shows the result', async () => {
    const d = deps()
    render(<App deps={d} checkGisReady={gisReady} />)
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
    render(<App deps={d} checkGisReady={gisReady} />)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('popup_closed')
  })

  it('warns when the Google script never loads', async () => {
    render(<App deps={deps()} checkGisReady={async () => false} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/)
    expect(screen.getByRole('button', { name: /Connect Google account/ })).toBeDisabled()
  })
})
