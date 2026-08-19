/**
 * Google refuses OAuth inside an embedded webview — the request comes back as
 * `disallowed_useragent`, and the user is shown Google's own "this browser or
 * app may not be secure" page rather than a consent screen. It is a block on
 * the user agent, not on the popup, so no change to how this app asks for a
 * token can get around it: switching GIS's popup for a redirect flow fails the
 * same way. The only fix is to leave the webview.
 *
 * That makes these two functions the whole feature. Everything else — the
 * notice, the button — is presentation over the answers they give.
 */

/**
 * Which webview we are inside, or `null` for a real browser. The named ones
 * exist because two of them (`kakaotalk`, `line`) publish a way out and because
 * naming the host app makes the notice's instructions concrete: a user can
 * follow "KakaoTalk's ⋯ menu" in a way they cannot follow "your browser's menu".
 * `other` covers the rest, where we know sign-in is blocked but not by whom.
 */
export type InAppBrowser = 'kakaotalk' | 'naver' | 'line' | 'instagram' | 'facebook' | 'other'

export function detectInAppBrowser(userAgent: string): InAppBrowser | null {
  if (!userAgent) return null
  // Ordered by how much the answer buys us, not by likelihood: KakaoTalk's
  // Android build also carries the `wv` marker the last check reads, so a
  // generic test placed first would report 'other' for a browser we can name
  // and hand a working escape link to.
  if (/KAKAOTALK/i.test(userAgent)) return 'kakaotalk'
  if (/NAVER\(inapp/i.test(userAgent)) return 'naver'
  if (/\bLine\/\d/.test(userAgent)) return 'line'
  if (/Instagram/i.test(userAgent)) return 'instagram'
  if (/FBAN|FBAV|FB_IAB/i.test(userAgent)) return 'facebook'
  /**
   * The marker Android puts in the UA of every embedded WebView, and the reason
   * this catches apps we have never heard of. Crucially it is absent from
   * Chrome Custom Tabs, which is real Chrome and where sign-in works — so this
   * does not hide the Connect button from users who could have used it.
   *
   * iOS has no equivalent. `WKWebView` is indistinguishable from Safari by user
   * agent alone, which is why the named checks above carry the iOS cases and
   * why an unnamed iOS webview reaches Connect and fails at Google. There is no
   * signal here to do better with.
   */
  if (/;\s*wv\)/.test(userAgent)) return 'other'
  return null
}

/**
 * A link that leaves the webview, or `null` when the platform offers none.
 *
 * `null` is a real answer, not a failure: on iOS outside KakaoTalk and LINE
 * there is nothing to link to, and returning a URL that silently does nothing
 * would be worse than returning none — the user would tap it, see no change,
 * and have no reason to look for the menu that actually works.
 */
export function escapeUrl(kind: InAppBrowser, href: string, userAgent: string): string | null {
  // KakaoTalk's own scheme, handled by the app on both platforms it ships on.
  // This is the one case where iOS has a one-tap way out.
  if (kind === 'kakaotalk') {
    return `kakaotalk://web/openExternal?url=${encodeURIComponent(href)}`
  }
  // LINE reads this off the URL it is already showing and hands it to the
  // system browser. Also platform-independent.
  if (kind === 'line') {
    return `${href}${href.includes('?') ? '&' : '?'}openExternalBrowser=1`
  }
  // Everything else: Android can be told to hand the URL to Chrome by name.
  if (/Android/i.test(userAgent)) {
    return `intent://${href.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`
  }
  return null
}
