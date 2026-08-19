import { readError, toError } from '@/google/errors'

/** OpenID Connect's userinfo endpoint. Returns `email` for the `userinfo.email` scope. */
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

export interface Account {
  /**
   * The signed-in address, fetched once and cached for the session. Concurrent
   * callers share one resolution, as `AppCalendar.ensure` does.
   */
  ensure(): Promise<string>
  /** '' until `ensure` has succeeded. */
  email(): string
  /** Drops the cache. The next connect may be a different account. */
  forget(): void
}

/**
 * Who the app is acting for. Worth knowing for two reasons, neither cosmetic:
 *
 * "Connected" alone does not say *which* Google account, and this app writes to
 * a calendar the user has to find later. Someone signed into a personal and a
 * work account cannot tell from that word which one holds their milestones.
 *
 * And it removes a guess. The calendar deep link previously hard-coded `/u/0/`,
 * the first signed-in account, which is wrong for exactly the user above — they
 * would land on the wrong calendar and not find the event. With the address
 * known, the link can name the account instead of assuming an index.
 */
export function createAccount(token: () => string, fetchImpl: typeof fetch = fetch): Account {
  let address = ''
  let pending: Promise<string> | null = null

  async function resolve(): Promise<string> {
    const response = await fetchImpl(USERINFO_URL, {
      headers: { Authorization: `Bearer ${token()}` },
    })
    if (!response.ok) {
      const { reason, detail } = await readError(response)
      throw toError(response.status, reason, detail)
    }
    const body = (await response.json()) as { email?: unknown }
    // Absent rather than malformed is the realistic case: the endpoint answers
    // 200 with no `email` when the scope was not granted. Treated as a failure
    // so a caller cannot cache '' and stop asking.
    if (typeof body.email !== 'string' || body.email === '') {
      throw toError(response.status, 'missingEmail', 'The userinfo response carried no email.')
    }
    return body.email
  }

  return {
    ensure() {
      if (address) return Promise.resolve(address)
      if (pending) return pending
      pending = resolve().then(
        (value) => {
          address = value
          pending = null
          return value
        },
        (error: unknown) => {
          // Cleared, not cached: a dead token or a dropped connection should not
          // become permanent for the session.
          pending = null
          throw error
        },
      )
      return pending
    },
    email() {
      return address
    },
    forget() {
      address = ''
      pending = null
    },
  }
}
