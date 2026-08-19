/**
 * Writes only to calendars this app itself created — it grants no access to the
 * user's primary calendar or to any calendar the app did not make. That is what
 * keeps it off Google's *sensitive* list, and therefore what lets the app be
 * published without sensitive-scope verification and without the 100-user cap.
 */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'

/**
 * A hidden per-app folder in the user's Drive. It holds exactly one thing: the
 * ID of the calendar above.
 *
 * This is not a convenience. `calendar.app.created` is not an accepted scope on
 * `calendarList.list`, so there is no API call that answers "which calendar did
 * I make for this user?" — the ID Google assigns at creation is the first fact
 * about this app that cannot be derived from the user's input. Keeping it in the
 * user's own account rather than in localStorage is what preserves the two
 * properties the app is built on: no backend, and a registration that stays
 * findable from another device or a year later.
 *
 * Also non-sensitive, per Google's Drive scope table.
 */
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'

/** Requested and verified as a unit; a partial grant is not a usable app. */
export const SCOPES = [CALENDAR_SCOPE, DRIVE_APPDATA_SCOPE] as const

/**
 * The signed-in address. Non-sensitive, and deliberately NOT part of `SCOPES`.
 *
 * The app is entirely usable without it: it only names which account is
 * connected and lets the calendar deep link address that account instead of
 * assuming the first one. Putting it in the verified set would mean a user who
 * unticks this one box on Google's consent screen gets "Calendar permission was
 * not granted" and no app at all -- a hard failure over a display detail.
 *
 * So it is requested, not required. `createAccount().ensure()` is allowed to
 * fail, and every caller treats that as "no address to show" rather than as a
 * failed connection.
 */
export const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email'

/** What the popup asks for: the required set plus the optional address. */
export const REQUESTED_SCOPES = [...SCOPES, EMAIL_SCOPE] as const

/**
 * Sentinel for "VITE_GOOGLE_CLIENT_ID was never set". The human-readable copy
 * lives in `ui/copy.ts`; this layer only signals the condition, which keeps the
 * rule that `google/` never imports from `ui/`.
 */
export const MISSING_CLIENT_ID = 'missing_client_id'

/**
 * Sentinel for "a sign-in popup is already open". Only one GIS call can be
 * outstanding, because a single `settle` slot holds its resolver — so a second
 * concurrent `connect()` is rejected rather than allowed to overwrite the slot
 * and strand the first caller's promise forever. `useDayMarker` swallows this
 * one: the popup the user already opened is still there, so there is nothing to
 * tell them.
 */
export const SIGN_IN_IN_PROGRESS = 'sign_in_in_progress'

/**
 * Sentinel for "a pending sign-in was abandoned by `clear()`". `clear()` must
 * REJECT a live pending call rather than silently drop it: dropping would remove
 * the only reference to that call's resolver and strand it forever — the exact
 * bug the `connect()` re-entrancy guard exists to prevent, reached through a
 * different door. Rejecting is always safe; an awaiting caller gets an error
 * instead of a hang. `useDayMarker` swallows this one, since `clear()` is only
 * called on a path that is already reporting its own error.
 */
export const SIGN_IN_CANCELLED = 'sign_in_cancelled'

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
    }
  }
}

export interface Auth {
  /**
   * MUST be called synchronously inside a user gesture or the popup is blocked.
   * Rejects with `SIGN_IN_IN_PROGRESS` if a previous call has not settled yet —
   * only one popup may be outstanding.
   */
  connect(prompt?: GisPrompt): Promise<string>
  /** The live token, or null once expired. Never persisted. */
  token(): string | null
  /** Forgets the token and releases any stuck pending call. */
  clear(): void
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
      // Asks for the optional address too; only SCOPES is verified below.
      scope: REQUESTED_SCOPES.join(' '),
      callback: (response) => {
        const pending = settle
        settle = null
        if (!pending) return
        if (!response.access_token) {
          pending.reject(new AuthError(response.error ?? 'Google returned no access token'))
          return
        }
        if (!gis.accounts.oauth2.hasGrantedAllScopes(response, ...SCOPES)) {
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
      // One popup at a time. `settle` holds the only reference to the pending
      // resolver, so letting a second call overwrite it would abandon the first
      // promise — it would never resolve and never reject, silently stranding
      // whatever was awaiting it. GIS fires error_callback when a popup closes,
      // so this clears itself; clear() is the escape hatch if it ever does not.
      if (settle) {
        return Promise.reject(new AuthError(SIGN_IN_IN_PROGRESS))
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
      // Releases a pending slot so a connect() that never got a callback cannot
      // brick every later attempt — but REJECTS it rather than dropping it.
      // Dropping would remove the only reference to a live call's resolver and
      // strand it forever, which is the very bug the re-entrancy guard above
      // prevents. Rejecting turns a hang into an error, which is always safe.
      const pending = settle
      settle = null
      pending?.reject(new AuthError(SIGN_IN_CANCELLED))
    },
  }
}
