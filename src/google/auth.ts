export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

/**
 * Sentinel for "VITE_GOOGLE_CLIENT_ID was never set". The human-readable copy
 * lives in `ui/copy.ts`; this layer only signals the condition, which keeps the
 * rule that `google/` never imports from `ui/`.
 */
export const MISSING_CLIENT_ID = 'missing_client_id'

/** '' re-authorizes silently when consent already exists. */
export type GisPrompt = '' | 'consent' | 'select_account'

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  scope?: string
  error?: string
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: GisPrompt }): void
}

export interface GoogleIdentity {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string
        scope: string
        callback: (response: TokenResponse) => void
        error_callback?: (error: unknown) => void
      }): TokenClient
      hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean
      revoke(token: string, done?: () => void): void
    }
  }
}

export interface Auth {
  /** MUST be called synchronously inside a user gesture or the popup is blocked. */
  connect(prompt?: GisPrompt): Promise<string>
  token(): string | null
  clear(): void
  revoke(): void
}

declare global {
  interface Window {
    google?: GoogleIdentity
  }
}

function defaultGis(): GoogleIdentity | undefined {
  return typeof window === 'undefined' ? undefined : window.google
}

/** Polls for the async-deferred GIS script. Resolves false on timeout. */
export async function whenGisReady(
  timeoutMs = 10_000,
  getGis: () => GoogleIdentity | undefined = defaultGis,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (getGis()) return true
    if (Date.now() >= deadline) return false
    await sleep(100)
  }
}

export function createAuth(
  clientId: string,
  getGis: () => GoogleIdentity | undefined = defaultGis,
  now: () => number = Date.now,
): Auth {
  // Held in a closure only — never localStorage, where it would outlive the tab.
  let accessToken: string | null = null
  let expiresAt = 0
  let client: TokenClient | null = null
  let settle: { resolve: (t: string) => void; reject: (e: unknown) => void } | null = null

  function ensureClient(gis: GoogleIdentity): TokenClient {
    if (client) return client
    client = gis.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: CALENDAR_SCOPE,
      callback: (response) => {
        const pending = settle
        settle = null
        if (!pending) return
        if (!response.access_token) {
          pending.reject(new AuthError(response.error ?? 'Google returned no access token'))
          return
        }
        if (!gis.accounts.oauth2.hasGrantedAllScopes(response, CALENDAR_SCOPE)) {
          pending.reject(new AuthError('Calendar permission was not granted'))
          return
        }
        accessToken = response.access_token
        expiresAt = now() + (response.expires_in ?? 3600) * 1000
        pending.resolve(accessToken)
      },
      error_callback: (error) => {
        const pending = settle
        settle = null
        pending?.reject(
          new AuthError(
            typeof error === 'object' && error !== null && 'type' in error
              ? String((error as { type: unknown }).type)
              : 'Google sign-in failed',
          ),
        )
      },
    })
    return client
  }

  return {
    connect(prompt: GisPrompt = '') {
      // Checked before the script check: a missing client ID is a setup mistake
      // the developer must fix, and reporting "script has not loaded" for it
      // would send them hunting the wrong problem.
      if (!clientId) {
        return Promise.reject(new AuthError(MISSING_CLIENT_ID))
      }
      const gis = getGis()
      if (!gis) {
        return Promise.reject(new AuthError('Google sign-in script has not loaded'))
      }
      const tokenClient = ensureClient(gis)
      const pending = new Promise<string>((resolve, reject) => {
        settle = { resolve, reject }
      })
      // Synchronous: any await before this point would break the popup.
      tokenClient.requestAccessToken({ prompt })
      return pending
    },
    token() {
      if (!accessToken || now() >= expiresAt) return null
      return accessToken
    },
    clear() {
      accessToken = null
      expiresAt = 0
    },
    revoke() {
      const gis = getGis()
      if (gis && accessToken) gis.accounts.oauth2.revoke(accessToken)
      accessToken = null
      expiresAt = 0
    },
  }
}
