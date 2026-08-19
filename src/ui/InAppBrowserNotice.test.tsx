import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { InAppBrowserNotice } from '@/ui/InAppBrowserNotice'
import { COPY } from '@/ui/copy'

const HREF = 'https://day-marker.example.com/'

const KAKAO_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.0'
const INSTAGRAM_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0.0 (iPhone14,5; iOS 17_5_1; en_US)'

describe('InAppBrowserNotice', () => {
  it('names the app it is inside rather than blaming "your browser"', () => {
    // The user did not choose this browser and may not know they are in one.
    // Naming it is what makes the instructions below followable.
    render(<InAppBrowserNotice kind="kakaotalk" userAgent={KAKAO_IOS} href={HREF} />)
    expect(screen.getByText(COPY.inAppBody('KakaoTalk'))).toBeInTheDocument()
  })

  it('offers the escape as a link, so the tap needs no script', () => {
    render(<InAppBrowserNotice kind="kakaotalk" userAgent={KAKAO_IOS} href={HREF} />)
    expect(screen.getByRole('link', { name: COPY.inAppOpen })).toHaveAttribute(
      'href',
      `kakaotalk://web/openExternal?url=${encodeURIComponent(HREF)}`,
    )
  })

  it('offers no escape link where the platform has none', () => {
    // iOS outside KakaoTalk and LINE. A link that silently does nothing would
    // be worse than no link: the user would tap it and stop looking.
    render(<InAppBrowserNotice kind="instagram" userAgent={INSTAGRAM_IOS} href={HREF} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('explains the manual route in every case, since the scheme can no-op silently', () => {
    const { rerender } = render(
      <InAppBrowserNotice kind="kakaotalk" userAgent={KAKAO_IOS} href={HREF} />,
    )
    expect(screen.getByText(COPY.inAppManual('KakaoTalk'))).toBeInTheDocument()
    rerender(<InAppBrowserNotice kind="instagram" userAgent={INSTAGRAM_IOS} href={HREF} />)
    expect(screen.getByText(COPY.inAppManual('Instagram'))).toBeInTheDocument()
  })

  it('puts the address on the clipboard, which is the one route that always works', async () => {
    const user = userEvent.setup()
    render(<InAppBrowserNotice kind="instagram" userAgent={INSTAGRAM_IOS} href={HREF} />)
    await user.click(screen.getByRole('button', { name: COPY.inAppCopy }))
    expect(await navigator.clipboard.readText()).toBe(HREF)
    // Confirmed on the control itself: a copy leaves no visible trace, so
    // without this the user cannot tell whether the tap registered.
    expect(screen.getByRole('button', { name: COPY.inAppCopied })).toBeInTheDocument()
  })
})
