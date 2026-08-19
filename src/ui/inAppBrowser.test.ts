import { describe, expect, it } from 'vitest'
import { detectInAppBrowser, escapeUrl } from '@/ui/inAppBrowser'

const HREF = 'https://day-marker.example.com/registrations?a=1'

// Real user-agent strings, trimmed only where the tail carries nothing we read.
const UA = {
  kakaoAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S911N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36 KAKAOTALK 10.4.3',
  kakaoIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.0',
  naverAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S911N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 NAVER(inapp; search; 1000; 12.9.2)',
  naverIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.9.2; 12)',
  lineIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/14.5.0',
  instagramIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0.0 (iPhone14,5; iOS 17_5_1; en_US)',
  facebookAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S911N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.35.108;]',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.43 Mobile Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  chromeDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
} as const

describe('detectInAppBrowser', () => {
  it('names KakaoTalk on Android', () => {
    expect(detectInAppBrowser(UA.kakaoAndroid)).toBe('kakaotalk')
  })

  it('names KakaoTalk on iOS, which carries no WebView marker', () => {
    expect(detectInAppBrowser(UA.kakaoIos)).toBe('kakaotalk')
  })

  it('names Naver', () => {
    expect(detectInAppBrowser(UA.naverIos)).toBe('naver')
  })

  it('names LINE', () => {
    expect(detectInAppBrowser(UA.lineIos)).toBe('line')
  })

  it('names Instagram', () => {
    expect(detectInAppBrowser(UA.instagramIos)).toBe('instagram')
  })

  it('names Facebook', () => {
    expect(detectInAppBrowser(UA.facebookAndroid)).toBe('facebook')
  })

  it('reports an unnamed Android WebView as an in-app browser anyway', () => {
    // `wv` is the marker Android puts in every embedded WebView, and Google
    // blocks all of them. Naming the host app is a nicety; knowing sign-in
    // cannot work here is the part the user needs.
    expect(detectInAppBrowser(UA.androidWebView)).toBe('other')
  })

  it('clears real Chrome on Android', () => {
    // The same check that catches WebViews must not catch Chrome Custom Tabs,
    // which carry no `wv` and where Google sign-in works normally. A false
    // positive here hides the Connect button from a user who could have used it.
    expect(detectInAppBrowser(UA.chromeAndroid)).toBeNull()
  })

  it('clears Safari and Chrome on iOS', () => {
    expect(detectInAppBrowser(UA.safariIos)).toBeNull()
    expect(detectInAppBrowser(UA.chromeIos)).toBeNull()
  })

  it('clears desktop Chrome', () => {
    expect(detectInAppBrowser(UA.chromeDesktop)).toBeNull()
  })

  it('clears an empty user agent rather than guessing', () => {
    expect(detectInAppBrowser('')).toBeNull()
  })
})

describe('escapeUrl', () => {
  it("hands KakaoTalk its own scheme, which works on both of the platforms it runs on", () => {
    expect(escapeUrl('kakaotalk', HREF, UA.kakaoIos)).toBe(
      `kakaotalk://web/openExternal?url=${encodeURIComponent(HREF)}`,
    )
    expect(escapeUrl('kakaotalk', HREF, UA.kakaoAndroid)).toBe(
      `kakaotalk://web/openExternal?url=${encodeURIComponent(HREF)}`,
    )
  })

  it('appends the parameter LINE documents for leaving its browser', () => {
    expect(escapeUrl('line', 'https://day-marker.example.com/', UA.lineIos)).toBe(
      'https://day-marker.example.com/?openExternalBrowser=1',
    )
  })

  it('joins LINE’s parameter to a query string that already exists', () => {
    expect(escapeUrl('line', HREF, UA.lineIos)).toBe(`${HREF}&openExternalBrowser=1`)
  })

  it('sends the other Android apps to Chrome through an intent URL', () => {
    expect(escapeUrl('naver', HREF, UA.naverAndroid)).toBe(
      'intent://day-marker.example.com/registrations?a=1#Intent;scheme=https;package=com.android.chrome;end',
    )
  })

  it('offers no escape from an iOS webview that is not KakaoTalk or LINE', () => {
    // iOS has no equivalent of the intent URL and Instagram publishes no scheme
    // of its own, so there is nothing to link to. The notice must fall back to
    // telling the user where the menu is; returning a URL that does nothing
    // would be worse than returning none.
    expect(escapeUrl('instagram', HREF, UA.instagramIos)).toBeNull()
    expect(escapeUrl('naver', HREF, UA.naverIos)).toBeNull()
  })

  it('escapes an unnamed Android WebView too, since the intent URL needs no host app', () => {
    expect(escapeUrl('other', HREF, UA.androidWebView)).toContain('intent://')
  })
})
