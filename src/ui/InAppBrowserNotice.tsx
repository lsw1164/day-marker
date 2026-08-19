import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { COPY } from '@/ui/copy'
import { escapeUrl, type InAppBrowser } from '@/ui/inAppBrowser'

export interface InAppBrowserNoticeProps {
  kind: InAppBrowser
  /** Injected rather than read off navigator, so tests can name a real webview. */
  userAgent: string
  /** The address to escape to. Defaults to wherever the user already is. */
  href?: string
}

/**
 * What stands where the Connect button would be when the app is running inside
 * an in-app browser. It replaces that button rather than warning beside it:
 * Google refuses OAuth in an embedded webview, so a Connect here leads only to
 * Google's own "this browser or app may not be secure" page — a dead end that
 * looks like the app's fault.
 *
 * Three ways out, in descending order of how likely they are to exist. The link
 * is one tap but only some webviews offer a scheme; the clipboard always works
 * but needs the user to switch apps themselves; the sentence at the bottom
 * covers the case where the scheme is silently ignored, which is invisible from
 * in here and so cannot be detected and reported.
 */
export function InAppBrowserNotice({
  kind,
  userAgent,
  href = typeof window === 'undefined' ? '' : window.location.href,
}: InAppBrowserNoticeProps) {
  const [copied, setCopied] = useState(false)
  const escape = escapeUrl(kind, href, userAgent)
  const name = COPY.inAppNames[kind]

  async function copy() {
    try {
      await navigator.clipboard.writeText(href)
      setCopied(true)
    } catch {
      // Denied permission, or an insecure context. Leaving the label alone is
      // the honest response: claiming a copy that did not happen would send the
      // user to paste nothing. The sentence below still tells them what to do.
    }
  }

  return (
    <Alert>
      <AlertTitle>{COPY.inAppTitle}</AlertTitle>
      <AlertDescription className="mt-1 flex flex-col gap-3">
        <span>{COPY.inAppBody(name)}</span>
        <span className="flex flex-wrap items-center gap-2">
          {escape && (
            // An anchor, not a click handler: a plain href needs no script, and
            // a custom scheme handed to the OS this way is the one form every
            // one of these webviews honours.
            <a className={cn(buttonVariants(), 'min-h-11')} href={escape}>
              {COPY.inAppOpen}
            </a>
          )}
          <Button variant="outline" className="min-h-11" onClick={() => void copy()}>
            {copied ? COPY.inAppCopied : COPY.inAppCopy}
          </Button>
        </span>
        <span>{COPY.inAppManual(name)}</span>
      </AlertDescription>
    </Alert>
  )
}
