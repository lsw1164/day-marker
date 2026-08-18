import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router-dom'
import { App } from '@/ui/App'
import { Header } from '@/ui/Header'
import { RegistrationsPage } from '@/ui/RegistrationsPage'
import type { DayMarkerDeps } from '@/ui/useDayMarker'

export interface RootProps {
  deps: DayMarkerDeps
  /**
   * Tests pass initialEntries to route without touching real history. Production
   * omits it and gets BrowserRouter, which is what makes the URLs shareable — and
   * what makes the host rewrite a deployment requirement.
   */
  initialEntries?: string[]
  checkGisReady?: () => Promise<boolean>
}

export function Root({ deps, initialEntries, checkGisReady }: RootProps) {
  const Router = initialEntries ? MemoryRouter : BrowserRouter
  const routerProps = initialEntries ? { initialEntries } : {}
  return (
    <Router {...routerProps}>
      <Header />
      <Routes>
        <Route path="/" element={<App deps={deps} checkGisReady={checkGisReady} />} />
        <Route
          path="/registrations"
          element={<RegistrationsPage deps={deps} checkGisReady={checkGisReady} />}
        />
      </Routes>
    </Router>
  )
}
