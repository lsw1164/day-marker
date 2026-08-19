/**
 * A hint that this browser has connected before. Deliberately **not** a token.
 *
 * The access token stays in a closure and dies with the tab, which is what keeps
 * it out of reach of a one-line `storage.getItem` after an XSS. But the user's
 * *grant* lives on Google's side and survives a refresh, so a fresh token can be
 * had with no prompt and no interaction. This flag is the app's only way to know
 * whether that is worth attempting: without it, every first-time visitor would
 * fire a doomed GIS call on every page load.
 *
 * It is safe to store because it is not a credential and not personal — it says
 * "someone here has used this app", which the presence of the app's own theme
 * preference already reveals. An attacker who reads it learns nothing usable.
 */
export const SESSION_HINT_KEY = 'dayMarker.connected'

export interface SessionHint {
  /** True when a silent re-authorization is worth attempting. */
  present(): boolean
  remember(): void
  forget(): void
}

export function createSessionHint(storage: Storage | null = safeLocalStorage()): SessionHint {
  return {
    present() {
      try {
        return storage?.getItem(SESSION_HINT_KEY) === '1'
      } catch {
        // Private browsing can throw on access, not only on write. A hint we
        // cannot read is a hint we do not have, which costs one click.
        return false
      }
    },
    remember() {
      try {
        storage?.setItem(SESSION_HINT_KEY, '1')
      } catch {
        // Nothing to recover: the next load simply asks for a click.
      }
    },
    forget() {
      try {
        storage?.removeItem(SESSION_HINT_KEY)
      } catch {
        // As above.
      }
    },
  }
}

/**
 * `localStorage` access itself throws in some blocked-storage configurations, so
 * this resolves to null rather than letting a getter reject at module load.
 */
function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
