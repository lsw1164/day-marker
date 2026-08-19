import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionStatus } from '@/ui/ConnectionStatus'
import { COPY } from '@/ui/copy'

describe('ConnectionStatus', () => {
  it('names the state in words, not only in colour', () => {
    const { rerender } = render(
      <ConnectionStatus connected={false} canSignOut onSignOut={() => {}} />,
    )
    expect(screen.getByText(COPY.notConnected)).toBeInTheDocument()
    rerender(<ConnectionStatus connected canSignOut onSignOut={() => {}} />)
    expect(screen.getByText(COPY.connected)).toBeInTheDocument()
  })

  it('names the account rather than only the state', () => {
    // "Connected" cannot answer the question a user with a personal and a work
    // account actually has: connected as whom?
    render(<ConnectionStatus connected email="anna@example.com" canSignOut onSignOut={() => {}} />)
    expect(screen.getByText('anna@example.com')).toBeInTheDocument()
    expect(screen.queryByText(COPY.connected)).not.toBeInTheDocument()
  })

  it('falls back to the bare state when the address is unknown', () => {
    // The user declined the optional scope, or the lookup failed. Still
    // connected, and still able to sign out.
    render(<ConnectionStatus connected canSignOut onSignOut={() => {}} />)
    expect(screen.getByText(COPY.connected)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: COPY.signOut })).toBeInTheDocument()
  })

  it('shows no address while disconnected, even if one is passed', () => {
    // The address outliving the session would say the app is still acting for
    // someone it no longer has a token for.
    render(
      <ConnectionStatus connected={false} email="anna@example.com" canSignOut onSignOut={() => {}} />,
    )
    expect(screen.getByText(COPY.notConnected)).toBeInTheDocument()
    expect(screen.queryByText('anna@example.com')).not.toBeInTheDocument()
  })

  it('offers no sign-out while disconnected', () => {
    // There is no token to clear, so the control would name an action with
    // nothing behind it.
    render(<ConnectionStatus connected={false} canSignOut onSignOut={() => {}} />)
    expect(screen.queryByRole('button', { name: COPY.signOut })).not.toBeInTheDocument()
  })

  it('withdraws the sign-out while a run is in flight', () => {
    // The arm both pages depend on: App passes phase !== 'applying' and
    // RegistrationsPage passes phase !== 'deleting', because clearing the token
    // mid-run fails every item still queued. Hidden rather than disabled -- a
    // disabled control still advertises an action that is wrong at that moment.
    render(<ConnectionStatus connected canSignOut={false} onSignOut={() => {}} />)
    expect(screen.getByText(COPY.connected)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: COPY.signOut })).not.toBeInTheDocument()
  })

  it('signs out when pressed', async () => {
    const onSignOut = vi.fn()
    render(<ConnectionStatus connected canSignOut onSignOut={onSignOut} />)
    await userEvent.click(screen.getByRole('button', { name: COPY.signOut }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })
})
