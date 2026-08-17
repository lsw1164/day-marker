import { describe, expect, it, vi } from 'vitest'
import {
  AuthError,
  CALENDAR_SCOPE,
  createAuth,
  MISSING_CLIENT_ID,
  type GoogleIdentity,
} from '@/google/auth'

interface Harness {
  gis: GoogleIdentity
  fire: (response: unknown) => void
  fireError: (error: unknown) => void
  requestAccessToken: ReturnType<typeof vi.fn>
  grantedScopes: string[]
}

function harness(): Harness {
  let callback: (r: unknown) => void = () => {}
  let errorCallback: (e: unknown) => void = () => {}
  const requestAccessToken = vi.fn()
  const state: Harness = {
    requestAccessToken,
    grantedScopes: [CALENDAR_SCOPE],
    fire: (response) => callback(response),
    fireError: (error) => errorCallback(error),
    gis: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            callback: (r: unknown) => void
            error_callback?: (e: unknown) => void
          }) => {
            callback = config.callback
            errorCallback = config.error_callback ?? (() => {})
            return { requestAccessToken }
          },
          hasGrantedAllScopes: (_r: unknown, ...scopes: string[]) =>
            scopes.every((s) => state.grantedScopes.includes(s)),
          revoke: vi.fn(),
        },
      },
    } as unknown as GoogleIdentity,
  }
  return state
}

describe('createAuth.connect', () => {
  it('requests a token synchronously so the popup is not blocked', () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    void auth.connect()
    // No await before this assertion: the call must already have happened.
    expect(h.requestAccessToken).toHaveBeenCalledTimes(1)
  })

  it('resolves with the access token', async () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    expect(await pending).toBe('tok')
  })

  it('rejects when the calendar scope was not granted', async () => {
    const h = harness()
    h.grantedScopes = []
    const auth = createAuth('client-1', () => h.gis)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: '' })
    await expect(pending).rejects.toBeInstanceOf(AuthError)
  })

  it('rejects when Google reports an error', async () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const pending = auth.connect()
    h.fireError({ type: 'popup_closed' })
    await expect(pending).rejects.toBeInstanceOf(AuthError)
  })

  it('rejects when the GIS script has not loaded', async () => {
    const auth = createAuth('client-1', () => undefined)
    await expect(auth.connect()).rejects.toBeInstanceOf(AuthError)
  })

  it('rejects with the sentinel when the client ID is empty', async () => {
    // A first run without .env.local. Without this, Google returns an opaque
    // error and the developer has no idea the client ID is the problem.
    const h = harness()
    const auth = createAuth('', () => h.gis)
    await expect(auth.connect()).rejects.toThrow(MISSING_CLIENT_ID)
    expect(h.requestAccessToken).not.toHaveBeenCalled()
  })

  it('passes the prompt through to Google', () => {
    const h = harness()
    createAuth('client-1', () => h.gis).connect('select_account')
    expect(h.requestAccessToken).toHaveBeenCalledWith({ prompt: 'select_account' })
  })
})

describe('createAuth.token', () => {
  it('is null before connecting', () => {
    expect(createAuth('client-1', () => harness().gis).token()).toBeNull()
  })

  it('returns the token while it is valid', async () => {
    const h = harness()
    let clock = 1_000_000
    const auth = createAuth('client-1', () => h.gis, () => clock)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    await pending
    clock += 60_000
    expect(auth.token()).toBe('tok')
  })

  it('returns null once the token has expired', async () => {
    const h = harness()
    let clock = 1_000_000
    const auth = createAuth('client-1', () => h.gis, () => clock)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    await pending
    clock += 3_600_000
    expect(auth.token()).toBeNull()
  })

  it('clear() forgets the token', async () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    await pending
    auth.clear()
    expect(auth.token()).toBeNull()
  })
})
