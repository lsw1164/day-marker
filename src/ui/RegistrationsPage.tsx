import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { whenGisReady } from '@/google/auth'
import { COPY } from '@/ui/copy'
import type { DayMarkerDeps } from '@/ui/useDayMarker'

export interface RegistrationsPageProps {
  deps: DayMarkerDeps
  /** Injectable because window.google never exists under jsdom. */
  checkGisReady?: () => Promise<boolean>
}

export function RegistrationsPage({
  deps,
  checkGisReady = whenGisReady,
}: RegistrationsPageProps) {
  // The token is the single source of truth for connectedness, so arriving here
  // from the other route with a live token does not read as "not connected".
  const [connected, setConnected] = useState(() => deps.auth.token() !== null)
  const [gisReady, setGisReady] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    void checkGisReady().then((r) => {
      if (live) setGisReady(r)
    })
    return () => {
      live = false
    }
  }, [checkGisReady])

  async function connect() {
    // Evaluated before any await so the popup survives the user gesture.
    const promise = deps.auth.connect('')
    try {
      await promise
      setConnected(true)
    } catch {
      setConnected(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-10 pt-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {COPY.registrationsTitle}
      </h2>
      {!connected && (
        <>
          <p className="text-sm text-muted-foreground">
            {COPY.registrationsConnectPrompt}
          </p>
          <Button
            variant="outline"
            disabled={gisReady !== true}
            onClick={() => void connect()}
          >
            {COPY.connect}
          </Button>
        </>
      )}
    </main>
  )
}
