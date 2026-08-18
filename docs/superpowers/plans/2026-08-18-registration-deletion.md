# Registration Deletion, Discovery, and Theming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user find every registration Day Marker has ever written and delete one as a unit, and support dark and light themes.

**Architecture:** A router shell (`Root`) hosts a shared `Header` and two routes; the existing write flow becomes the element for `/` and is otherwise unchanged. Discovery queries the calendar for `dayMarkerVersion=1` and groups the results by the `startDate` already stamped on every event — no new field, so nothing needs migrating. Deletion mirrors `applyPlan`: bounded concurrency, retry, halt-on-401, per-item outcomes. Theming is a switching policy rather than a restyle: the full dark palette already exists and nothing ever set the class.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind v4, shadcn/base-ui, react-router-dom, lucide-react, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-18-registration-deletion-design.md`

**Prior spec (still binding):** `docs/superpowers/specs/2026-08-17-day-marker-design.md`

## Global Constraints

Every task's requirements implicitly include this section. The first six carry over from the prior plan and remain in force.

- **OAuth scope stays exactly `https://www.googleapis.com/auth/calendar.events`.** It already covers `events.list` and `events.delete` on the primary calendar. Do not add scopes.
- **Event IDs must not change.** They remain `sha256('daymarker/v1/' + start + '/' + key)` truncated to 30 base32hex chars with a `dm` prefix. The golden test pinning three IDs must keep passing; if it fails, stop and report rather than updating it.
- **Never put the access token in `localStorage`** or any persistent storage. A theme preference under `dayMarker.theme` is unrelated and permitted.
- **`src/` may not import Node builtins.** `tsconfig.json` omits `"node"` from `types` on purpose; never widen it. Files needing Node live at the repo root under `tsconfig.node.json`.
- **The test suite runs under `TZ=Asia/Seoul`.** A local-midnight date bug is invisible under `TZ=UTC` and US timezones and only diverges at a positive UTC offset; Korea is UTC+9.
- **All user-facing copy comes from `COPY`** in `src/ui/copy.ts`. No inline string literals in components.
- **NEW: no hardcoded colour utilities in components — theme tokens only.** No `bg-white`, `text-gray-500`, `border-zinc-200`. Only tokens such as `bg-background`, `text-muted-foreground`, `border-input`, `bg-primary`, `text-destructive`. Dark mode depends on this, and it is currently true by discipline rather than by rule.
- **NEW: `alreadyGone` is a success, not a failure.** A `404` or `410` from a delete means the user removed that event by hand. Reporting it as failed would send them hunting a problem that does not exist.
- **NEW: pagination is not optional.** `events.list` returns `nextPageToken`. Showing only the first page would mean a registration that exists but cannot be found — worse than having no list.
- **Node 20+**, npm. TypeScript is strict: `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noUnusedLocals`.

## File Structure

```
index.html                     + pre-paint theme script
package.json                   + react-router-dom
vitest.setup.ts                + matchMedia stub (jsdom lacks it)
src/
  index.css                    + color-scheme on :root and .dark
  main.tsx                     renders <Root> instead of <App>
  ui/
    Root.tsx                   router + Header + Routes
    Header.tsx                 name, tagline, nav, theme toggle
    useTheme.ts                stored choice over OS, live matchMedia
    App.tsx                    route "/" — header row trimmed to the chip
    RegistrationsPage.tsx      route "/registrations"
    RegistrationRow.tsx        one registration; expands inline to confirm
    useRegistrations.ts        list + delete state machine
    copy.ts                    + nav, theme, registrations, delete keys
  google/
    calendarApi.ts             + listEvents (paginated), deleteEvent; GoogleEvent extended
    registrations.ts           groupByStartDate, listRegistrations, deleteRegistration
```

`Header` owns identity, navigation, and the theme toggle. The connection chip stays inside each page, because connecting is page-level and both pages need it. `App` keeps its own `<main>` container and `Header` has its own, so `Root` adds no wrapper and `App`'s layout is untouched.

**Why `App` barely changes.** Its 8 reviewed tests assert nothing about the header, so moving identity into `Header` disturbs none of them. Keeping the reviewed write flow intact is worth more than tidiness.

**Why a separate hook.** `useDayMarker` already owns a five-phase machine and is the largest file in the project. Listing and deleting share nothing with computing milestones except the `CalendarApi` instance.

---

### Task 1: Router shell, shared Header, and the registrations route

Ends with a working two-route app: `/` renders the existing flow unchanged, `/registrations` renders its not-connected state. Listing and deleting arrive later.

**Files:**
- Modify: `package.json` (add `react-router-dom`)
- Create: `src/ui/Root.tsx`
- Create: `src/ui/Header.tsx`
- Create: `src/ui/RegistrationsPage.tsx`
- Modify: `src/ui/copy.ts`
- Modify: `src/ui/App.tsx` (trim the header row)
- Modify: `src/main.tsx`
- Test: `src/ui/Header.test.tsx`
- Test: `src/ui/Root.test.tsx`

**Interfaces:**
- Consumes: `COPY` from `@/ui/copy`; `App` and `type DayMarkerDeps` from `@/ui/App` / `@/ui/useDayMarker`; `cn` from `@/lib/utils`
- Produces:
  - `<Root />` with props `{ deps: DayMarkerDeps; initialEntries?: string[]; checkGisReady?: () => Promise<boolean> }`
  - `<Header />` — no props
  - `<RegistrationsPage />` with props `{ deps: DayMarkerDeps; checkGisReady?: () => Promise<boolean> }`
  - `COPY.navLabel`, `COPY.navNew`, `COPY.navRegistrations`, `COPY.registrationsTitle`, `COPY.registrationsConnectPrompt`

- [ ] **Step 1: Install the router**

```bash
npm install react-router-dom
```

- [ ] **Step 2: Add the copy keys**

In `src/ui/copy.ts`, inside the `COPY` object, immediately after `tagline`:

```ts
  navLabel: 'Sections',
  navNew: 'New',
  navRegistrations: 'Registrations',
  registrationsTitle: 'Registrations',
  registrationsConnectPrompt:
    'Connect your Google account to see what Day Marker has registered.',
```

- [ ] **Step 3: Write the failing Header test**

Create `src/ui/Header.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { Header } from '@/ui/Header'
import { COPY } from '@/ui/copy'

function renderAt(path: string) {
  // NavLink needs a router in context; MemoryRouter also lets us assert which
  // link is current without touching real history.
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header />
    </MemoryRouter>,
  )
}

describe('Header', () => {
  it('shows the app identity', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: COPY.appName })).toBeInTheDocument()
    expect(screen.getByText(COPY.tagline)).toBeInTheDocument()
  })

  it('links to both sections', () => {
    renderAt('/')
    expect(screen.getByRole('link', { name: COPY.navNew })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: COPY.navRegistrations })).toHaveAttribute(
      'href',
      '/registrations',
    )
  })

  it('marks the current section for assistive tech, not by colour alone', () => {
    renderAt('/registrations')
    expect(screen.getByRole('link', { name: COPY.navRegistrations })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: COPY.navNew })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('names the navigation region', () => {
    renderAt('/')
    expect(screen.getByRole('navigation', { name: COPY.navLabel })).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -- Header`
Expected: FAIL — `Failed to resolve import "@/ui/Header"`.

- [ ] **Step 5: Write `src/ui/Header.tsx`**

```tsx
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { COPY } from '@/ui/copy'

const TAB =
  'flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-sm font-medium'

export function Header() {
  return (
    <header className="mx-auto w-full max-w-md px-4 pt-6">
      <h1 className="text-lg font-semibold">{COPY.appName}</h1>
      <p className="text-xs text-muted-foreground">{COPY.tagline}</p>
      {/*
        A segmented control rather than a bottom tab bar: the write flow ends in a
        sticky primary button, so a second bottom bar would consume roughly 120px
        of a small screen and push that button away from the thumb.
      */}
      <nav aria-label={COPY.navLabel} className="mt-3 flex gap-1">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            cn(
              TAB,
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )
          }
        >
          {COPY.navNew}
        </NavLink>
        <NavLink
          to="/registrations"
          className={({ isActive }) =>
            cn(
              TAB,
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )
          }
        >
          {COPY.navRegistrations}
        </NavLink>
      </nav>
    </header>
  )
}
```

`min-h-11` is 44px — the touch-target floor. `NavLink` sets `aria-current="page"` itself, so the current section reaches assistive tech rather than being conveyed by colour alone.

- [ ] **Step 6: Run it to verify it passes**

Run: `npm test -- Header`
Expected: PASS — 4 tests.

- [ ] **Step 7: Write the failing Root test**

Create `src/ui/Root.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Root } from '@/ui/Root'
import type { DayMarkerDeps } from '@/ui/useDayMarker'
import type { Auth } from '@/google/auth'
import type { CalendarApi } from '@/google/calendarApi'
import { calendarDate } from '@/domain/calendarDate'
import { COPY } from '@/ui/copy'

function deps(): DayMarkerDeps {
  const auth: Auth = {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => null),
    clear: vi.fn(),
  }
  // listEvents/deleteEvent arrive in Tasks 3 and 4; the cast keeps this test
  // compiling until then and costs nothing afterwards.
  const api = {
    getEvent: vi.fn(async () => null),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
  } as unknown as CalendarApi
  return { auth, api, todayDate: calendarDate('2026-06-01'), probeDelayMs: 0 }
}

const ready = async () => true

describe('Root', () => {
  it('renders the write flow at /', () => {
    render(<Root deps={deps()} initialEntries={['/']} checkGisReady={ready} />)
    expect(screen.getByText(/Pick a start date/)).toBeInTheDocument()
  })

  it('renders the registrations page at /registrations', () => {
    render(<Root deps={deps()} initialEntries={['/registrations']} checkGisReady={ready} />)
    expect(
      screen.getByRole('heading', { name: COPY.registrationsTitle }),
    ).toBeInTheDocument()
  })

  it('shows the shared header on both routes', () => {
    render(<Root deps={deps()} initialEntries={['/registrations']} checkGisReady={ready} />)
    expect(screen.getByRole('heading', { name: COPY.appName })).toBeInTheDocument()
  })
})
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npm test -- Root`
Expected: FAIL — `Failed to resolve import "@/ui/Root"`.

- [ ] **Step 9: Write `src/ui/RegistrationsPage.tsx` — not-connected state only**

```tsx
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
            className="min-h-11"
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
```

- [ ] **Step 10: Write `src/ui/Root.tsx`**

```tsx
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
```

- [ ] **Step 11: Trim App's header row**

In `src/ui/App.tsx`, replace the entire `<header>…</header>` block with:

```tsx
      {/* Identity and nav moved to the shared Header. The connection chip stays
          here because connecting is page-level. */}
      <div className="flex justify-end">
        <span className="text-xs text-muted-foreground">
          {state.connected ? COPY.connected : COPY.notConnected}
        </span>
      </div>
```

In the same file, change the `<main>` class `pt-6` to `pt-5`, since `Header` now supplies the top padding.

- [ ] **Step 12: Rewrite `src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAuth } from '@/google/auth'
import { createCalendarApi } from '@/google/calendarApi'
import { Root } from '@/ui/Root'
import './index.css'

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''
const auth = createAuth(clientId)
const api = createCalendarApi(() => auth.token() ?? '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root deps={{ auth, api }} />
  </StrictMode>,
)
```

- [ ] **Step 13: Run everything**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

**The 8 existing `App` tests must still be green and unmodified** — they assert nothing about the header. If one now fails, stop and report which and why rather than editing it; that would mean the trim removed something a test depends on.

- [ ] **Step 14: Commit**

```bash
git add package.json package-lock.json src/ui/Root.tsx src/ui/Root.test.tsx \
        src/ui/Header.tsx src/ui/Header.test.tsx src/ui/RegistrationsPage.tsx \
        src/ui/copy.ts src/ui/App.tsx src/main.tsx
git commit -m "feat(ui): add router shell, shared header, and registrations route"
```

---

### Task 2: Dark and light theming

The full dark palette already exists in `src/index.css` — 105 custom properties across `:root` and `.dark`, plus Tailwind v4's `@custom-variant dark (&:is(.dark *))`. Nothing sets the class, so the palette is built and never activated. This task switches it on.

**Files:**
- Modify: `index.html` (pre-paint script)
- Modify: `src/index.css` (`color-scheme`)
- Modify: `vitest.setup.ts` (matchMedia stub)
- Create: `src/ui/useTheme.ts`
- Modify: `src/ui/Header.tsx` (toggle)
- Modify: `src/ui/copy.ts`
- Test: `src/ui/useTheme.test.ts`
- Test: `src/ui/Header.test.tsx` (extend)

**Interfaces:**
- Consumes: `COPY`; `cn`; `Button` from `@/components/ui/button`; `Monitor`, `Moon`, `Sun` from `lucide-react`
- Produces:
  - `type ThemeChoice = 'system' | 'light' | 'dark'`
  - `THEME_KEY = 'dayMarker.theme'`
  - `nextChoice(choice: ThemeChoice): ThemeChoice`
  - `useTheme(): { choice: ThemeChoice; setChoice: (c: ThemeChoice) => void }`
  - `COPY.themeLabel(choice)`, `COPY.themeAction(next)`

- [ ] **Step 1: Stub `matchMedia` in the test setup**

jsdom does not implement `window.matchMedia`, so `useTheme` would throw in every test that renders a `Header`. Add to `vitest.setup.ts`, after the existing `crypto` block:

```ts
// jsdom does not implement matchMedia. Tests that care about the OS preference
// install their own controllable fake; this default stops every other test from
// throwing, exactly as the crypto.subtle block above does.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}
```

- [ ] **Step 2: Declare `color-scheme`**

In `src/index.css`, add `color-scheme: light;` inside the existing `:root { … }` block, and `color-scheme: dark;` inside the existing `.dark { … }` block.

This is required, not cosmetic. The app deliberately uses native `<input type="date">` and `<select>` because the base-ui equivalents are untestable under jsdom, and native controls are user-agent styled — without `color-scheme` following our class, the date picker and dropdown render as light widgets on a dark page. Declaring it in CSS rather than as a `<meta name="color-scheme">` tag matters: the meta tag follows the OS, so a user who overrides to dark on a light OS would still get light native controls.

- [ ] **Step 3: Add the pre-paint script to `index.html`**

Insert immediately before the closing `</head>`:

```html
    <script>
      // Runs before first paint. Doing this in React would show a flash of the
      // wrong theme on every load. One mechanism (the class), two sources: a
      // stored choice if there is one, the OS otherwise.
      ;(function () {
        try {
          var stored = localStorage.getItem('dayMarker.theme')
          var dark =
            stored === 'dark' ||
            (stored !== 'light' &&
              window.matchMedia('(prefers-color-scheme: dark)').matches)
          if (dark) document.documentElement.classList.add('dark')
        } catch (e) {
          // Private browsing can throw on localStorage. Falling back to light is
          // better than failing to render.
        }
      })()
    </script>
```

- [ ] **Step 4: Add the theme copy**

In `src/ui/copy.ts`, inside `COPY`, after the nav keys from Task 1:

```ts
  themeLabel: (choice: 'system' | 'light' | 'dark') =>
    choice === 'system'
      ? 'Theme: following your system'
      : choice === 'light'
        ? 'Theme: light'
        : 'Theme: dark',
  themeAction: (next: 'system' | 'light' | 'dark') =>
    next === 'system' ? 'Switch to system theme' : `Switch to ${next} theme`,
```

- [ ] **Step 5: Write the failing `useTheme` test**

Create `src/ui/useTheme.test.ts`:

```ts
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextChoice, THEME_KEY, useTheme } from '@/ui/useTheme'

/** Installs a controllable matchMedia and returns a handle to flip the OS. */
function fakeMedia(initialDark: boolean) {
  let matches = initialDark
  const listeners = new Set<() => void>()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      get matches() {
        return matches
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      dispatchEvent: () => false,
    }),
  })
  return {
    flip(toDark: boolean) {
      matches = toDark
      for (const l of [...listeners]) l()
    },
    listenerCount: () => listeners.size,
  }
}

afterEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})

describe('nextChoice', () => {
  it('cycles system → light → dark → system', () => {
    expect(nextChoice('system')).toBe('light')
    expect(nextChoice('light')).toBe('dark')
    expect(nextChoice('dark')).toBe('system')
  })
})

describe('useTheme', () => {
  it('defaults to system and follows a dark OS', () => {
    fakeMedia(true)
    const { result } = renderHook(() => useTheme())
    expect(result.current.choice).toBe('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('follows a light OS', () => {
    fakeMedia(false)
    renderHook(() => useTheme())
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('lets a stored choice beat the OS', () => {
    localStorage.setItem(THEME_KEY, 'light')
    fakeMedia(true)
    const { result } = renderHook(() => useTheme())
    expect(result.current.choice).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('persists an explicit choice', () => {
    fakeMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setChoice('dark'))
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('removes the key rather than storing "system", so fresh and reset browsers match', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    fakeMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setChoice('system'))
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('reacts when the OS flips while following it', () => {
    const media = fakeMedia(false)
    renderHook(() => useTheme())
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    act(() => media.flip(true))
    // A phone entering night mode must not leave the open tab in light.
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('stops following the OS once an explicit choice is made', () => {
    const media = fakeMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setChoice('light'))
    expect(media.listenerCount()).toBe(0)
    act(() => media.flip(true))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('survives localStorage throwing, as in private browsing', () => {
    fakeMedia(false)
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { result } = renderHook(() => useTheme())
    expect(result.current.choice).toBe('system')
    spy.mockRestore()
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- useTheme`
Expected: FAIL — `Failed to resolve import "@/ui/useTheme"`.

- [ ] **Step 7: Write `src/ui/useTheme.ts`**

```ts
import { useCallback, useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

export const THEME_KEY = 'dayMarker.theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function nextChoice(choice: ThemeChoice): ThemeChoice {
  return choice === 'system' ? 'light' : choice === 'light' ? 'dark' : 'system'
}

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'dark' || value === 'light' ? value : 'system'
  } catch {
    // Private browsing can throw. Following the OS is the right fallback.
    return 'system'
  }
}

export function useTheme(): {
  choice: ThemeChoice
  setChoice: (choice: ThemeChoice) => void
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStored)

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY)
    const apply = () => {
      const dark = choice === 'dark' || (choice === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    // Only subscribe while the OS is actually deciding. Once the choice is
    // explicit, an OS flip is none of our business.
    if (choice !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [choice])

  const setChoice = useCallback((next: ThemeChoice) => {
    try {
      // Removed rather than stored as "system", so a fresh browser and a browser
      // reset to system behave identically.
      if (next === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, next)
    } catch {
      // The preference will not persist; the session still honours it.
    }
    setChoiceState(next)
  }, [])

  return { choice, setChoice }
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npm test -- useTheme`
Expected: PASS — 9 tests.

- [ ] **Step 9: Extend the Header test**

Add to the top of `src/ui/Header.test.tsx`, after the existing imports:

```tsx
import userEvent from '@testing-library/user-event'
import { afterEach } from 'vitest'

afterEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})
```

Append inside the `describe('Header', …)` block:

```tsx
  it('labels the theme control with both its state and its action', () => {
    renderAt('/')
    const button = screen.getByRole('button', { name: /Theme: / })
    // An icon-only cycling control is unreadable to a screen reader without
    // saying what pressing it will do — "Sun" alone tells you nothing.
    expect(button).toHaveAccessibleName(/Switch to/)
    expect(button).toHaveAttribute('title')
  })

  it('cycles the theme when pressed', async () => {
    renderAt('/')
    const button = screen.getByRole('button', { name: /Theme: / })
    await userEvent.click(button)
    expect(screen.getByRole('button', { name: /Theme: light/ })).toBeInTheDocument()
    await userEvent.click(button)
    expect(screen.getByRole('button', { name: /Theme: dark/ })).toBeInTheDocument()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
```

- [ ] **Step 10: Add the toggle to `src/ui/Header.tsx`**

Add these imports:

```tsx
import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { nextChoice, useTheme, type ThemeChoice } from '@/ui/useTheme'
```

Add above the `Header` component:

```tsx
const ICON: Record<ThemeChoice, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}
```

Replace the `<h1>`/`<p>` pair with:

```tsx
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{COPY.appName}</h1>
          <p className="text-xs text-muted-foreground">{COPY.tagline}</p>
        </div>
        <ThemeToggle />
      </div>
```

Add below `Header` in the same file:

```tsx
function ThemeToggle() {
  const { choice, setChoice } = useTheme()
  const Icon = ICON[choice]
  const next = nextChoice(choice)
  const name = `${COPY.themeLabel(choice)}. ${COPY.themeAction(next)}`
  return (
    <Button
      variant="ghost"
      size="icon"
      // `size="icon"` is size-8 (32px). `size-11` overrides both axes to reach
      // the 44px touch floor; a square control needs the width too, so
      // `min-h-11` alone would leave it 32px wide.
      className="size-11"
      aria-label={name}
      title={name}
      onClick={() => setChoice(next)}
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}
```

- [ ] **Step 11: Run everything**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add index.html vitest.setup.ts src/index.css src/ui/useTheme.ts \
        src/ui/useTheme.test.ts src/ui/Header.tsx src/ui/Header.test.tsx src/ui/copy.ts
git commit -m "feat(ui): follow the OS theme with a persisted override"
```

---

### Task 3: `listEvents` with pagination, and an extended `GoogleEvent`

**Files:**
- Modify: `src/google/calendarApi.ts`
- Test: `src/google/calendarApi.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `GoogleEvent` gains `start?: { date?: string }` and `extendedProperties?: { private?: Record<string, string> }`
  - `interface EventListPage { items: GoogleEvent[]; nextPageToken?: string }`
  - `listEvents(query: { privateExtendedProperty: string; pageToken?: string }): Promise<EventListPage>` on `CalendarApi`

`GoogleEvent` currently declares only `id`, `status`, `summary`, and `reminders`. Grouping needs the stamped properties and the event's date, so two optional fields are added. Both are optional, so no existing consumer changes — `plan.ts` reads only `status`, `summary`, and `reminders`, and `apply.ts` discards every return value.

- [ ] **Step 1: Write the failing tests**

Append to `src/google/calendarApi.test.ts`:

```ts
describe('listEvents', () => {
  it('sends the private-property filter and returns one page', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        items: [{ id: 'dm1', status: 'confirmed', summary: 'Day 100' }],
      }),
    ) as unknown as typeof fetch
    const page = await apiWith(fetchImpl).listEvents({
      privateExtendedProperty: 'dayMarkerVersion=1',
    })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toContain('privateExtendedProperty=dayMarkerVersion%3D1')
    expect((init as RequestInit).method).toBe('GET')
    expect(page.items).toHaveLength(1)
    expect(page.nextPageToken).toBeUndefined()
  })

  it('passes a page token through when given one', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items: [] })) as unknown as typeof fetch
    await apiWith(fetchImpl).listEvents({
      privateExtendedProperty: 'dayMarkerVersion=1',
      pageToken: 'tok-2',
    })
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toContain('pageToken=tok-2')
  })

  it('surfaces nextPageToken so the caller can follow it', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { items: [], nextPageToken: 'tok-2' }),
    ) as unknown as typeof fetch
    const page = await apiWith(fetchImpl).listEvents({
      privateExtendedProperty: 'dayMarkerVersion=1',
    })
    expect(page.nextPageToken).toBe('tok-2')
  })

  it('defaults items to an empty array when the body omits it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch
    const page = await apiWith(fetchImpl).listEvents({
      privateExtendedProperty: 'dayMarkerVersion=1',
    })
    expect(page.items).toEqual([])
  })

  it('does not ask for deleted events', async () => {
    // showDeleted defaults to false, and we rely on that: a cancelled event must
    // not appear in a list whose whole purpose is "what is currently registered".
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items: [] })) as unknown as typeof fetch
    await apiWith(fetchImpl).listEvents({ privateExtendedProperty: 'dayMarkerVersion=1' })
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).not.toContain('showDeleted')
  })

  it('maps a failure through the existing error types', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, googleError(401, 'authError')),
    ) as unknown as typeof fetch
    await expect(
      apiWith(fetchImpl).listEvents({ privateExtendedProperty: 'dayMarkerVersion=1' }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- calendarApi`
Expected: FAIL — `listEvents is not a function`.

- [ ] **Step 3: Extend `GoogleEvent` and add the page type**

In `src/google/calendarApi.ts`, replace the `GoogleEvent` interface with:

```ts
export interface GoogleEvent {
  id: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] }
  /** All-day events carry `date`; both fields are optional because a malformed
   *  response must degrade rather than crash. */
  start?: { date?: string }
  /** Where Day Marker stamps dayMarkerVersion, startDate, and milestoneKey. */
  extendedProperties?: { private?: Record<string, string> }
}

export interface EventListPage {
  items: GoogleEvent[]
  nextPageToken?: string
}
```

- [ ] **Step 4: Add `listEvents` to the interface**

```ts
export interface CalendarApi {
  getEvent(id: string): Promise<GoogleEvent | null>
  insertEvent(payload: GoogleEventPayload): Promise<GoogleEvent>
  patchEvent(id: string, payload: GoogleEventPayload): Promise<GoogleEvent>
  listEvents(query: {
    privateExtendedProperty: string
    pageToken?: string
  }): Promise<EventListPage>
}
```

- [ ] **Step 5: Implement it**

In `createCalendarApi`, widen `request`'s method union to include `'DELETE'` now (Task 4 needs it and changing the type twice is churn):

```ts
  async function request(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ): Promise<Response> {
```

Then add to the returned object:

```ts
    async listEvents({ privateExtendedProperty, pageToken }) {
      const url = new URL(EVENTS_URL)
      url.searchParams.set('privateExtendedProperty', privateExtendedProperty)
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      // showDeleted is deliberately left at its default of false: a cancelled
      // event must not appear in a list of what is currently registered.
      const response = await request(url.toString(), 'GET')
      if (response.ok) {
        const body = (await response.json()) as Partial<EventListPage>
        return { items: body.items ?? [], nextPageToken: body.nextPageToken }
      }
      const { reason, detail } = await readError(response)
      throw toError(response.status, reason, detail)
    },
```

`URL` and `searchParams` do the escaping, which is why the test asserts on the encoded `dayMarkerVersion%3D1` rather than a hand-built string.

- [ ] **Step 6: Run it to verify it passes**

Run: `npm test -- calendarApi`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/google/calendarApi.ts src/google/calendarApi.test.ts
git commit -m "feat(google): list events by private property, paginated"
```

---

### Task 4: `deleteEvent`, with already-gone as a success

**Files:**
- Modify: `src/google/calendarApi.ts`
- Test: `src/google/calendarApi.test.ts` (extend)
- Modify (mock ripple, see below): `src/google/apply.test.ts`,
  `src/google/plan.test.ts`, `src/ui/App.test.tsx`,
  `src/ui/useDayMarker.test.tsx`
- Modify: `src/ui/Root.test.tsx` — its comment says `listEvents`/`deleteEvent`
  "arrive in Tasks 3 and 4"; once this task lands, that is fully stale. Either
  drop the `as unknown as CalendarApi` cast in favour of a real stub, or reword
  the comment. Do not leave it claiming a future that has arrived.

**The mock ripple — expect it, it is not a surprise.** Adding a required method
to `CalendarApi` breaks every test that builds the interface as a plain object
literal without a cast. Task 3 hit exactly this when it added `listEvents`, in
exactly the four files listed above. Adding `deleteEvent` will break the same
four. Add a one-line stub to each:

```ts
deleteEvent: vi.fn(async () => 'deleted' as const),
```

Do this in a **separate commit** from the feature, as Task 3 did, so the
feature diff stays readable. `as const` matters: without it the return widens
to `string` and fails to satisfy `Promise<'deleted' | 'alreadyGone'>`.

**Interfaces:**
- Consumes: the existing error classes
- Produces:
  - `deleteEvent(id: string): Promise<'deleted' | 'alreadyGone'>` on `CalendarApi`

**Do NOT add an `AlreadyGone` error class.** An earlier draft of this task did,
and it was removed: `deleteEvent` intercepts 404 and 410 before `toError` is
ever reached, so nothing could construct it, and the spec's mechanism for this
outcome is the `alreadyGone` string in the return union — which is what Task 7
and the `COPY.outcomeAlreadyGone` label actually consume. It also duplicated the
existing `NotFound` (404) and its doc comment claimed `isRetryable` treated it
specially when in fact `isRetryable` returns false for every class outside its
allowlist. See the ruling in the ledger.

- [ ] **Step 1: Write the failing tests**

Append to `src/google/calendarApi.test.ts`:

```ts
describe('deleteEvent', () => {
  it('DELETEs the event', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const outcome = await apiWith(fetchImpl).deleteEvent('dmabc12')
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(`${EVENTS_URL}/dmabc12`)
    expect((init as RequestInit).method).toBe('DELETE')
    expect(outcome).toBe('deleted')
  })

  it('sends no body or Content-Type', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await apiWith(fetchImpl).deleteEvent('dmabc12')
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect((init as RequestInit).body).toBeUndefined()
    expect(new Headers((init as RequestInit).headers).get('Content-Type')).toBeNull()
  })

  it.each([404, 410])('reports %i as already gone, not a failure', async (status) => {
    // The user deleted this by hand. Nothing is broken, so calling it a failure
    // would send them hunting a problem that does not exist.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(status, googleError(status, 'notFound')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).deleteEvent('dmabc12')).resolves.toBe('alreadyGone')
  })

  it('still throws on a real failure', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, googleError(401, 'authError')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).deleteEvent('dmabc12')).rejects.toBeInstanceOf(Unauthorized)
  })

  it('treats a rate limit as retryable, exactly as writes do', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, googleError(429, 'rateLimitExceeded')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).deleteEvent('dmabc12')).rejects.toBeInstanceOf(RateLimited)
  })
})
```

The existing `@/google/errors` import needs no new members.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- calendarApi`
Expected: FAIL — `deleteEvent is not a function`.

- [ ] **Step 3: No error class is needed**

`src/google/errors.ts` is unchanged by this task. The already-gone outcome
travels in `deleteEvent`'s return union, not as a thrown class.

- [ ] **Step 4: Add `deleteEvent` to the interface and implement it**

Add to `CalendarApi`:

```ts
  deleteEvent(id: string): Promise<'deleted' | 'alreadyGone'>
```

Add to the returned object in `createCalendarApi`:

```ts
    async deleteEvent(id) {
      const response = await request(`${EVENTS_URL}/${id}`, 'DELETE')
      if (response.ok) return 'deleted'
      // 404: never existed or fully purged. 410: existed, already deleted. Both
      // mean the end state we wanted already holds.
      if (response.status === 404 || response.status === 410) return 'alreadyGone'
      const { reason, detail } = await readError(response)
      throw toError(response.status, reason, detail)
    },
```

Note `deleteEvent` returns its own outcome rather than throwing. 404 and 410 are intercepted here, before `toError`, because on a delete they mean the desired end state already holds — the caller asked for the event to be gone and it is. Every other status keeps the existing mapping, so a 401 still halts a run and a 429 is still retried.

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -- calendarApi`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/google/calendarApi.ts src/google/calendarApi.test.ts
git commit -m "feat(google): delete events, treating already-gone as success"
```

---

### Task 5: `groupByStartDate` — the pure part of discovery

**Files:**
- Create: `src/google/registrations.ts`
- Test: `src/google/registrations.test.ts`

**Interfaces:**
- Consumes: `type GoogleEvent` from `@/google/calendarApi`; `type CalendarDate`, `isCalendarDate` from `@/domain/calendarDate`
- Produces:
  - `interface RegistrationEvent { id: string; date: CalendarDate; label: string }`
  - `interface Registration { startDate: CalendarDate; title: string; count: number; events: RegistrationEvent[] }`
  - `DISCOVERY_FILTER = 'dayMarkerVersion=1'`
  - `groupByStartDate(events: GoogleEvent[]): Registration[]`

- [ ] **Step 1: Write the failing test**

Create `src/google/registrations.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { groupByStartDate } from '@/google/registrations'
import type { GoogleEvent } from '@/google/calendarApi'

function ev(
  id: string,
  startDate: string | undefined,
  milestoneKey: string,
  date: string,
  summary?: string,
): GoogleEvent {
  return {
    id,
    status: 'confirmed',
    ...(summary === undefined ? {} : { summary }),
    start: { date },
    extendedProperties: {
      private: {
        dayMarkerVersion: '1',
        ...(startDate === undefined ? {} : { startDate }),
        milestoneKey,
      },
    },
  }
}

describe('groupByStartDate', () => {
  it('groups events sharing a start date into one registration', () => {
    const out = groupByStartDate([
      ev('a', '2025-03-14', 'd100', '2025-06-21', 'Anna & Ben: Day 100'),
      ev('b', '2025-03-14', 'y1', '2026-03-14', 'Anna & Ben: 1 Year'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.startDate).toBe('2025-03-14')
    expect(out[0]?.count).toBe(2)
  })

  it('separates different start dates', () => {
    const out = groupByStartDate([
      ev('a', '2025-03-14', 'd100', '2025-06-21'),
      ev('b', '2026-01-01', 'd100', '2026-04-10'),
    ])
    expect(out.map((r) => r.startDate)).toEqual(['2026-01-01', '2025-03-14'])
  })

  it('sorts by start date descending, so a future registration sorts first', () => {
    // Deliberately not "newest": creation time is recorded nowhere, and a future
    // start date is the most relevant, not the most recently made.
    const out = groupByStartDate([
      ev('a', '2025-03-14', 'd100', '2025-06-21'),
      ev('b', '2027-05-05', 'd100', '2027-08-12'),
      ev('c', '2026-01-01', 'd100', '2026-04-10'),
    ])
    expect(out.map((r) => r.startDate)).toEqual(['2027-05-05', '2026-01-01', '2025-03-14'])
  })

  it('titles a registration from its earliest event, not whatever the API returned first', () => {
    const out = groupByStartDate([
      ev('b', '2025-03-14', 'y1', '2026-03-14', 'Anna & Ben: 1 Year'),
      ev('a', '2025-03-14', 'd100', '2025-06-21', 'Anna & Ben: Day 100'),
    ])
    // Google's events.list sets no orderBy, so input order is arbitrary. Titling
    // from the earliest event keeps the same registration from renaming itself
    // between loads. A single-event fixture here would prove nothing.
    expect(out[0]?.title).toBe('Anna & Ben: Day 100')
  })

  it('falls back to the formatted start date when no summary exists', () => {
    const out = groupByStartDate([ev('a', '2025-03-14', 'd100', '2025-06-21')])
    expect(out[0]?.title).toBe('Mar 14, 2025')
  })

  it('sorts events within a registration by date', () => {
    const out = groupByStartDate([
      ev('b', '2025-03-14', 'y1', '2026-03-14'),
      ev('a', '2025-03-14', 'd100', '2025-06-21'),
    ])
    expect(out[0]?.events.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('labels each event from its milestone key', () => {
    const out = groupByStartDate([
      ev('a', '2025-03-14', 'd100', '2025-06-21'),
      ev('b', '2025-03-14', 'd1000', '2028-01-01'),
      ev('c', '2025-03-14', 'y1', '2026-03-14'),
      ev('d', '2025-03-14', 'y2', '2027-03-14'),
    ])
    expect(out[0]?.events.map((e) => e.label)).toEqual([
      'Day 100',
      '1 Year',
      '2 Years',
      'Day 1000',
    ])
  })

  it('ignores events with no stamped start date', () => {
    // Someone else's event that happens to carry dayMarkerVersion, or a corrupted
    // one. It cannot be attributed to a registration, so it is not invented into one.
    const out = groupByStartDate([
      ev('a', undefined, 'd100', '2025-06-21'),
      ev('b', '2025-03-14', 'd100', '2025-06-21'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.count).toBe(1)
  })

  it('ignores events with an unparseable start date', () => {
    const out = groupByStartDate([ev('a', 'not-a-date', 'd100', '2025-06-21')])
    expect(out).toEqual([])
  })

  it('ignores events with no date of their own', () => {
    const bad: GoogleEvent = {
      id: 'a',
      status: 'confirmed',
      extendedProperties: { private: { dayMarkerVersion: '1', startDate: '2025-03-14' } },
    }
    expect(groupByStartDate([bad])).toEqual([])
  })

  it('returns nothing for an empty list', () => {
    expect(groupByStartDate([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- registrations`
Expected: FAIL — `Failed to resolve import "@/google/registrations"`.

- [ ] **Step 3: Write the implementation**

Create `src/google/registrations.ts`:

```ts
import { formatLong, isCalendarDate, type CalendarDate } from '@/domain/calendarDate'
import type { GoogleEvent } from '@/google/calendarApi'

/**
 * The discovery predicate. If `dayMarkerVersion` is ever bumped, this must match
 * every live version or older registrations become invisible.
 */
export const DISCOVERY_FILTER = 'dayMarkerVersion=1'

export interface RegistrationEvent {
  id: string
  date: CalendarDate
  label: string
}

export interface Registration {
  /** The registration key: the start date, stamped on every one of its events. */
  startDate: CalendarDate
  title: string
  count: number
  events: RegistrationEvent[]
}

/** `d100` → `Day 100`, `y1` → `1 Year`, `y2` → `2 Years`. */
function labelFor(milestoneKey: string): string {
  const n = Number(milestoneKey.slice(1))
  if (!Number.isFinite(n)) return milestoneKey
  if (milestoneKey.startsWith('d')) return `Day ${n}`
  if (milestoneKey.startsWith('y')) return n === 1 ? '1 Year' : `${n} Years`
  return milestoneKey
}

export function groupByStartDate(events: GoogleEvent[]): Registration[] {
  const groups = new Map<CalendarDate, RegistrationEvent[]>()
  const titles = new Map<CalendarDate, string | undefined>()

  for (const event of events) {
    const props = event.extendedProperties?.private
    const start = props?.startDate
    const date = event.start?.date
    // An event we cannot attribute to a registration is skipped rather than
    // invented into one: no start date, no date of its own, or either unparseable.
    if (!start || !isCalendarDate(start)) continue
    if (!date || !isCalendarDate(date)) continue

    const list = groups.get(start) ?? []
    list.push({ id: event.id, date, label: labelFor(props?.milestoneKey ?? '') })
    groups.set(start, list)
    if (!titles.has(start)) titles.set(start, event.summary)
  }

  return [...groups.entries()]
    .map(([startDate, list]) => {
      const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      return {
        startDate,
        // The first event's summary shows the user's label if they set one, with
        // no extra field stamped and nothing to migrate for existing events.
        title: titles.get(startDate) ?? formatLong(startDate),
        count: sorted.length,
        events: sorted,
      }
    })
    // Descending string comparison, which is chronological for YYYY-MM-DD.
    .sort((a, b) => (a.startDate > b.startDate ? -1 : a.startDate < b.startDate ? 1 : 0))
}
```

Note the title comes from the **first event in input order**, not the first after sorting — the events all share a label, so any of them serves, and taking it during the single pass avoids a second traversal.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- registrations`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/google/registrations.ts src/google/registrations.test.ts
git commit -m "feat(google): group calendar events into registrations"
```

---

### Task 6: `listRegistrations` — follow every page

**Files:**
- Modify: `src/google/registrations.ts`
- Test: `src/google/registrations.test.ts` (extend)

**Interfaces:**
- Consumes: `CalendarApi.listEvents`, `DISCOVERY_FILTER`, `groupByStartDate`
- Produces: `listRegistrations(api: CalendarApi): Promise<Registration[]>`

- [ ] **Step 1: Write the failing tests**

Append to `src/google/registrations.test.ts`:

```ts
import { vi } from 'vitest'
import { listRegistrations, DISCOVERY_FILTER } from '@/google/registrations'
import type { CalendarApi, EventListPage } from '@/google/calendarApi'

function apiReturning(pages: EventListPage[]): CalendarApi {
  let call = 0
  return {
    getEvent: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
    listEvents: vi.fn(async () => pages[call++] ?? { items: [] }),
  } as unknown as CalendarApi
}

describe('listRegistrations', () => {
  it('queries with the discovery filter', async () => {
    const api = apiReturning([{ items: [] }])
    await listRegistrations(api)
    expect(api.listEvents).toHaveBeenCalledWith({
      privateExtendedProperty: DISCOVERY_FILTER,
      pageToken: undefined,
    })
  })

  it('follows nextPageToken and merges every page', async () => {
    // The whole point: a registration that exists on page two must be findable.
    // Showing only page one would be worse than having no list at all.
    const api = apiReturning([
      { items: [ev('a', '2025-03-14', 'd100', '2025-06-21')], nextPageToken: 'p2' },
      { items: [ev('b', '2026-01-01', 'd100', '2026-04-10')] },
    ])
    const out = await listRegistrations(api)
    expect(api.listEvents).toHaveBeenCalledTimes(2)
    expect((api.listEvents as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toEqual({
      privateExtendedProperty: DISCOVERY_FILTER,
      pageToken: 'p2',
    })
    expect(out.map((r) => r.startDate)).toEqual(['2026-01-01', '2025-03-14'])
  })

  it('stops after one page when there is no token', async () => {
    const api = apiReturning([{ items: [] }])
    await listRegistrations(api)
    expect(api.listEvents).toHaveBeenCalledTimes(1)
  })

  it('merges pages that belong to the same registration', async () => {
    const api = apiReturning([
      { items: [ev('a', '2025-03-14', 'd100', '2025-06-21')], nextPageToken: 'p2' },
      { items: [ev('b', '2025-03-14', 'y1', '2026-03-14')] },
    ])
    const out = await listRegistrations(api)
    expect(out).toHaveLength(1)
    expect(out[0]?.count).toBe(2)
  })

  it('propagates a failure rather than returning a partial list', async () => {
    // A partial list presented as complete is a lie about the user's calendar.
    const api = {
      getEvent: vi.fn(),
      insertEvent: vi.fn(),
      patchEvent: vi.fn(),
      deleteEvent: vi.fn(),
      listEvents: vi.fn(async () => {
        throw new Unauthorized(401, 'authError', '')
      }),
    } as unknown as CalendarApi
    await expect(listRegistrations(api)).rejects.toBeInstanceOf(Unauthorized)
  })
})
```

Add `import { Unauthorized } from '@/google/errors'` to the file's imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- registrations`
Expected: FAIL — `TypeError: listRegistrations is not a function`. The cause is the missing export, but it surfaces at call time rather than at module resolution, because Vite resolves the module fine and only the binding is absent.

- [ ] **Step 3: Implement it**

Add to `src/google/registrations.ts`:

```ts
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'

/**
 * Fetches every page before grouping. A partial list is not an acceptable
 * degradation here: it would show a registration count that is quietly wrong and
 * hide registrations the user is looking for.
 */
export async function listRegistrations(api: CalendarApi): Promise<Registration[]> {
  const all: GoogleEvent[] = []
  let pageToken: string | undefined
  do {
    const page = await api.listEvents({
      privateExtendedProperty: DISCOVERY_FILTER,
      pageToken,
    })
    all.push(...page.items)
    pageToken = page.nextPageToken
  } while (pageToken)
  return groupByStartDate(all)
}
```

Update the existing type-only import of `GoogleEvent` to the combined form above.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- registrations`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/google/registrations.ts src/google/registrations.test.ts
git commit -m "feat(google): discover registrations across every page"
```

---

### Task 7: `deleteRegistration`

Mirrors `applyPlan` deliberately: same concurrency helper, same retry, same halt-on-401, same per-item reporting. A reader who knows one knows the other.

**Files:**
- Modify: `src/google/registrations.ts`
- Test: `src/google/deleteRegistration.test.ts`

**Interfaces:**
- Consumes: `mapWithLimit` from `@/lib/mapWithLimit`; `withRetry`, `DEFAULT_RETRY_DEPS`, `type RetryDeps` from `@/lib/backoff`; `isRetryable`, `Unauthorized` from `@/google/errors`; `CalendarApi.deleteEvent`
- Produces:
  - `type DeleteOutcome = 'deleted' | 'alreadyGone' | 'failed'`
  - `interface DeleteResult { event: RegistrationEvent; outcome: DeleteOutcome; error?: string }`
  - `DELETE_CONCURRENCY = 3`, `DELETE_HALTED`
  - `deleteRegistration(api, events, onProgress, retryDeps?, concurrency?): Promise<DeleteResult[]>`

- [ ] **Step 1: Write the failing test**

Create `src/google/deleteRegistration.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  deleteRegistration,
  DELETE_HALTED,
  type RegistrationEvent,
} from '@/google/registrations'
import type { CalendarApi } from '@/google/calendarApi'
import { RateLimited, Unauthorized } from '@/google/errors'
import { calendarDate } from '@/domain/calendarDate'
import type { RetryDeps } from '@/lib/backoff'

const RETRY: RetryDeps = { attempts: 3, baseMs: 1, sleep: async () => {}, random: () => 0.5 }

function evs(n: number): RegistrationEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `dm${i}`,
    date: calendarDate('2026-01-01'),
    label: `Day ${(i + 1) * 100}`,
  }))
}

function apiWith(deleteEvent: CalendarApi['deleteEvent']): CalendarApi {
  return {
    getEvent: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    listEvents: vi.fn(),
    deleteEvent,
  } as unknown as CalendarApi
}

describe('deleteRegistration', () => {
  it('reports every event as deleted on a clean run', async () => {
    const api = apiWith(vi.fn(async () => 'deleted' as const))
    const out = await deleteRegistration(api, evs(3), () => {}, RETRY)
    expect(out.map((r) => r.outcome)).toEqual(['deleted', 'deleted', 'deleted'])
  })

  it('passes alreadyGone straight through as a success', async () => {
    const api = apiWith(vi.fn(async () => 'alreadyGone' as const))
    const out = await deleteRegistration(api, evs(2), () => {}, RETRY)
    expect(out.map((r) => r.outcome)).toEqual(['alreadyGone', 'alreadyGone'])
    expect(out.every((r) => r.error === undefined)).toBe(true)
  })

  it('retries a rate limit and then succeeds', async () => {
    let calls = 0
    const api = apiWith(
      vi.fn(async () => {
        calls += 1
        if (calls < 3) throw new RateLimited(429, 'rateLimitExceeded', '')
        return 'deleted' as const
      }),
    )
    const out = await deleteRegistration(api, evs(1), () => {}, RETRY)
    expect(out[0]?.outcome).toBe('deleted')
    expect(calls).toBe(3)
  })

  it('fails an item once the attempts run out', async () => {
    const api = apiWith(
      vi.fn(async () => {
        throw new RateLimited(429, 'rateLimitExceeded', '')
      }),
    )
    const out = await deleteRegistration(api, evs(1), () => {}, RETRY)
    expect(out[0]?.outcome).toBe('failed')
    expect(out[0]?.error).toContain('429')
  })

  it('halts after a 401 and stops sending doomed requests', async () => {
    // FIVE events against a concurrency of 3. The halt can only short-circuit
    // items still QUEUED, so a 3-item version asserts something impossible.
    const deleteEvent = vi.fn(async () => {
      throw new Unauthorized(401, 'authError', '')
    })
    const out = await deleteRegistration(apiWith(deleteEvent), evs(5), () => {}, RETRY)
    expect(out).toHaveLength(5)
    expect(out.every((r) => r.outcome === 'failed')).toBe(true)
    // Three, not two: the two never attempted PLUS the one that 401'd. At
    // concurrency 3 a run of 3 or fewer events has nothing queued behind the
    // failure, so stamping only the skipped items would leave a genuine halt
    // with no DELETE_HALTED anywhere and the UI's reconnect path would never
    // fire. See the ledger's F39.
    expect(out.filter((r) => r.error === DELETE_HALTED)).toHaveLength(3)
    expect(deleteEvent).toHaveBeenCalledTimes(3)
  })

  it('preserves what already succeeded when the token dies mid-run', async () => {
    let calls = 0
    const deleteEvent = vi.fn(async () => {
      calls += 1
      if (calls > 1) throw new Unauthorized(401, 'authError', '')
      return 'deleted' as const
    })
    const out = await deleteRegistration(apiWith(deleteEvent), evs(3), () => {}, RETRY, 1)
    expect(out[0]?.outcome).toBe('deleted')
    expect(out.slice(1).every((r) => r.outcome === 'failed')).toBe(true)
  })

  it('reports each item once, as it lands, and returns them in input order', async () => {
    const seen: string[] = []
    const api = apiWith(vi.fn(async () => 'deleted' as const))
    const out = await deleteRegistration(api, evs(3), (r) => seen.push(r.event.id), RETRY)
    expect(seen).toHaveLength(3)
    expect(out.map((r) => r.event.id)).toEqual(['dm0', 'dm1', 'dm2'])
  })

  it('does nothing when given no events', async () => {
    const deleteEvent = vi.fn()
    const out = await deleteRegistration(apiWith(deleteEvent), [], () => {}, RETRY)
    expect(out).toEqual([])
    expect(deleteEvent).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- deleteRegistration`
Expected: FAIL — `deleteRegistration is not exported`.

- [ ] **Step 3: Implement it**

Add to `src/google/registrations.ts`:

```ts
import { isRetryable, Unauthorized } from '@/google/errors'
import { DEFAULT_RETRY_DEPS, withRetry, type RetryDeps } from '@/lib/backoff'
import { mapWithLimit } from '@/lib/mapWithLimit'

export type DeleteOutcome = 'deleted' | 'alreadyGone' | 'failed'

export interface DeleteResult {
  event: RegistrationEvent
  outcome: DeleteOutcome
  error?: string
}

export const DELETE_CONCURRENCY = 3

/**
 * Stamped on every event a halted run never attempted. A sentinel rather than a
 * sentence: `ui/` maps it to copy that offers to reconnect, which is the action
 * the user needs and which the google layer must not word.
 */
export const DELETE_HALTED = 'delete_halted'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Deliberately the same shape as applyPlan: mapWithLimit at concurrency 3, each
 * call wrapped in withRetry gated by isRetryable, per-item results reported live,
 * and a 401 halting the remainder rather than firing doomed requests at a dead
 * token. Results already collected survive, so a failed run can be retried for
 * only its failures.
 */
export async function deleteRegistration(
  api: CalendarApi,
  events: RegistrationEvent[],
  onProgress: (result: DeleteResult) => void,
  retryDeps: RetryDeps = DEFAULT_RETRY_DEPS,
  concurrency: number = DELETE_CONCURRENCY,
): Promise<DeleteResult[]> {
  let halted = false

  const settled = await mapWithLimit(events, concurrency, async (event) => {
    if (halted) {
      const result: DeleteResult = {
        event,
        outcome: 'failed',
        error: DELETE_HALTED,
      }
      onProgress(result)
      return result
    }
    try {
      const outcome = await withRetry(() => api.deleteEvent(event.id), isRetryable, retryDeps)
      const result: DeleteResult = { event, outcome }
      onProgress(result)
      return result
    } catch (error) {
      // Losing the token invalidates every remaining delete, so stop scheduling
      // -- and stamp the trigger with the sentinel too, not just the items
      // queued behind it, or a run of 3 or fewer events (nothing queued at
      // concurrency 3) would report a halt that ui/ cannot detect.
      if (error instanceof Unauthorized) halted = true
      const result: DeleteResult = {
        event,
        outcome: 'failed',
        error: describeError(error),
      }
      onProgress(result)
      return result
    }
  })

  const failure = settled.find((r) => r.status === 'rejected')
  if (failure && failure.status === 'rejected') throw failure.reason
  return settled.map((r) => (r as PromiseFulfilledResult<DeleteResult>).value)
}
```

The rejection scan mirrors the map-with-throw form `apply.ts` and `plan.ts` both already use: the per-item callback should never reject, but a throwing `onProgress` would, and casting a rejected slot would put `undefined` into React state.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- deleteRegistration`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/google/registrations.ts src/google/deleteRegistration.test.ts
git commit -m "feat(google): delete a registration with retry and halt-on-401"
```

---

### Task 8: `useRegistrations`

**Files:**
- Create: `src/ui/useRegistrations.ts`
- Modify: `src/ui/copy.ts`
- Test: `src/ui/useRegistrations.test.ts`

**Interfaces:**
- Consumes: `type Auth`; `type CalendarApi`; `listRegistrations`, `deleteRegistration`, `type Registration`, `type DeleteResult` from `@/google/registrations`; `type RetryDeps`; `MISSING_CLIENT_ID`, `SIGN_IN_CANCELLED`, `SIGN_IN_IN_PROGRESS` from `@/google/auth`; `PAGINATION_LOOPED` from `@/google/registrations`; `COPY`
- Produces:
  - `type RegistrationsPhase = 'idle' | 'loading' | 'ready' | 'deleting' | 'done'`
  - `interface RegistrationsDeps { auth: Auth; api: CalendarApi; retryDeps?: RetryDeps }`
  - `useRegistrations(deps)` returning `{ phase, connected, registrations, confirming, results, error, connect, refresh, beginConfirm, cancelConfirm, confirmDelete, backToList }`
  - `COPY.registrationsEmpty`, `COPY.registrationsLoading`, `COPY.deleteSummary(deleted, alreadyGone, failed)`, `COPY.paginationLooped`

- [ ] **Step 1: Add the copy**

In `src/ui/copy.ts`, inside `COPY`:

```ts
  registrationsLoading: 'Looking through your calendar…',
  registrationsEmpty: 'Nothing registered yet. Add an anniversary to see it here.',
  registrationsCount: (n: number) =>
    n === 1 ? '1 registration' : `${n} registrations`,
  registrationMeta: (start: string, n: number) =>
    `Started ${start} · ${n === 1 ? '1 event' : `${n} events`}`,
  deleteOpen: 'Delete…',
  deleteWarning: (n: number) =>
    `Removes ${n === 1 ? '1 event' : `${n} events`} from your calendar. Day Marker cannot undo this.`,
  deleteCancel: 'Cancel',
  deleteConfirm: (n: number) => `Delete ${n}`,
  deleteBusy: 'Deleting…',
  deleteBack: 'Back to registrations',
  outcomeDeleted: 'Deleted',
  outcomeAlreadyGone: 'Already gone',
  outcomeFailed: 'Failed',
  // Google handed back a page token it had already served. Rare, and not the
  // user's doing, so say what to do rather than what went wrong.
  paginationLooped: 'Your calendar list did not load correctly. Please try again.',
  // Shown when a delete run stopped early because the token died. Says what to do,
  // and deliberately does not claim the remaining events are still there -- a
  // failed DELETE deletes nothing, but a lost response is indistinguishable from
  // one that landed, so the copy must not promise either way.
  deleteHalted:
    'Your Google connection expired before every event was deleted. Go back and reconnect to finish the rest.',
  deleteSummary: (deleted: number, alreadyGone: number, failed: number) =>
    [
      `${deleted} deleted`,
      alreadyGone > 0 ? `${alreadyGone} already gone` : null,
      failed > 0 ? `${failed} failed` : null,
    ]
      .filter(Boolean)
      .join(' · '),
```

- [ ] **Step 2: Write the failing test**

Create `src/ui/useRegistrations.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useRegistrations, type RegistrationsDeps } from '@/ui/useRegistrations'
import { calendarDate } from '@/domain/calendarDate'
import type { Auth } from '@/google/auth'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { Unauthorized } from '@/google/errors'
import type { RetryDeps } from '@/lib/backoff'

const RETRY: RetryDeps = { attempts: 1, baseMs: 1, sleep: async () => {}, random: () => 0.5 }

function ev(id: string, startDate: string, key: string, date: string): GoogleEvent {
  return {
    id,
    status: 'confirmed',
    summary: `Anna & Ben: ${key}`,
    start: { date },
    extendedProperties: { private: { dayMarkerVersion: '1', startDate, milestoneKey: key } },
  }
}

function deps(over: Partial<RegistrationsDeps> = {}): RegistrationsDeps {
  const auth: Auth = {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => 'tok'),
    clear: vi.fn(),
  }
  const api = {
    getEvent: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(async () => 'deleted' as const),
    listEvents: vi.fn(async () => ({
      items: [ev('a', '2025-03-14', 'd100', '2025-06-21'), ev('b', '2025-03-14', 'y1', '2026-03-14')],
    })),
  } as unknown as CalendarApi
  return { auth, api, retryDeps: RETRY, ...over }
}

describe('useRegistrations', () => {
  it('loads on mount when a token already exists', async () => {
    const { result } = renderHook(() => useRegistrations(deps()))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.registrations).toHaveLength(1)
    expect(result.current.registrations[0]?.count).toBe(2)
  })

  it('stays idle with no token and does not query', async () => {
    const d = deps()
    ;(d.auth.token as ReturnType<typeof vi.fn>).mockReturnValue(null)
    const { result } = renderHook(() => useRegistrations(d))
    expect(result.current.phase).toBe('idle')
    expect(result.current.connected).toBe(false)
    expect(d.api.listEvents).not.toHaveBeenCalled()
  })

  it('loads after connecting', async () => {
    const d = deps()
    ;(d.auth.token as ReturnType<typeof vi.fn>).mockReturnValue(null)
    const { result } = renderHook(() => useRegistrations(d))
    ;(d.auth.token as ReturnType<typeof vi.fn>).mockReturnValue('tok')
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(d.api.listEvents).toHaveBeenCalled()
  })

  it('reports a listing failure without showing a partial list', async () => {
    const d = deps()
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Unauthorized(401, 'authError', ''),
    )
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.registrations).toEqual([])
  })

  it('opens and cancels a confirm without deleting', async () => {
    const d = deps()
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))
    expect(result.current.confirming).toBe('2025-03-14')
    act(() => result.current.cancelConfirm())
    expect(result.current.confirming).toBeNull()
    expect(d.api.deleteEvent).not.toHaveBeenCalled()
  })

  it('deletes only the confirmed registration and lands in done', async () => {
    const d = deps()
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))
    await act(async () => {
      await result.current.confirmDelete()
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.results).toHaveLength(2)
    expect(d.api.deleteEvent).toHaveBeenCalledTimes(2)
  })

  it('refreshes the list when returning from done', async () => {
    // The list in hand is stale: the events just deleted are gone from the
    // calendar, so showing the old grouping would misreport what is registered.
    const d = deps()
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.beginConfirm(calendarDate('2025-03-14')))
    await act(async () => {
      await result.current.confirmDelete()
    })
    const before = (d.api.listEvents as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => result.current.backToList())
    await waitFor(() =>
      expect((d.api.listEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1),
    )
  })

  it('does nothing when confirmDelete is called with nothing confirmed', async () => {
    const d = deps()
    const { result } = renderHook(() => useRegistrations(d))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await act(async () => {
      await result.current.confirmDelete()
    })
    expect(d.api.deleteEvent).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('ready')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- useRegistrations`
Expected: FAIL — `Failed to resolve import "@/ui/useRegistrations"`.

- [ ] **Step 4: Write `src/ui/useRegistrations.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalendarDate } from '@/domain/calendarDate'
import {
  MISSING_CLIENT_ID,
  SIGN_IN_CANCELLED,
  SIGN_IN_IN_PROGRESS,
  type Auth,
} from '@/google/auth'
import type { CalendarApi } from '@/google/calendarApi'
import {
  deleteRegistration,
  listRegistrations,
  PAGINATION_LOOPED,
  type DeleteResult,
  type Registration,
} from '@/google/registrations'
import type { RetryDeps } from '@/lib/backoff'
import { COPY } from '@/ui/copy'

export type RegistrationsPhase = 'idle' | 'loading' | 'ready' | 'deleting' | 'done'

export interface RegistrationsDeps {
  auth: Auth
  api: CalendarApi
  retryDeps?: RetryDeps
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === MISSING_CLIENT_ID) return COPY.missingClientId
  if (message === 'popup_failed_to_open') return COPY.popupBlocked
  // listRegistrations throws this sentinel rather than a sentence, so that
  // user-facing strings stay in ui/ and the google layer never imports COPY.
  if (message === PAGINATION_LOOPED) return COPY.paginationLooped
  return message
}

export function useRegistrations({ auth, api, retryDeps }: RegistrationsDeps) {
  // Read through refs for the same reason useDayMarker does: a caller building a
  // fresh deps object each render would otherwise retrigger the load effect on
  // every render, looping real Google requests against the user's quota.
  const apiRef = useRef(api)
  const authRef = useRef(auth)
  apiRef.current = api
  authRef.current = auth

  // The token is the single source of truth, so arriving from the other route
  // with a live token does not read as "not connected".
  const [connected, setConnected] = useState(() => auth.token() !== null)
  const [phase, setPhase] = useState<RegistrationsPhase>('idle')
  const [registrations, setRegistrations] = useState<Registration[]>([])
  const [confirming, setConfirming] = useState<CalendarDate | null>(null)
  const [results, setResults] = useState<DeleteResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadNonce, setLoadNonce] = useState(0)

  // Guards against a slow load overwriting a newer one.
  const loadToken = useRef(0)

  useEffect(() => {
    if (!connected) return
    const ticket = loadToken.current + 1
    loadToken.current = ticket
    setPhase('loading')
    void (async () => {
      try {
        const next = await listRegistrations(apiRef.current)
        if (loadToken.current !== ticket) return
        setRegistrations(next)
        setError(null)
        setPhase('ready')
      } catch (e) {
        if (loadToken.current !== ticket) return
        // No partial list: showing some registrations as if they were all of them
        // would misreport the user's calendar.
        setRegistrations([])
        setError(describeError(e))
        setPhase('idle')
      }
    })()
  }, [connected, loadNonce])

  const connect = useCallback(async (): Promise<boolean> => {
    try {
      // Evaluated before any await so the popup survives the user gesture, and
      // awaited inside the try so a handler is always attached.
      const promise = authRef.current.connect('')
      await promise
      setError(null)
      setConnected(true)
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : ''
      // Their popup is still open; nothing to say and nothing to change.
      if (message === SIGN_IN_IN_PROGRESS) return false
      // clear() abandoned this call; that path reports its own error.
      if (message === SIGN_IN_CANCELLED) return false
      setError(describeError(e))
      setConnected(false)
      return false
    }
  }, [])

  const refresh = useCallback(() => setLoadNonce((n) => n + 1), [])

  const beginConfirm = useCallback((startDate: CalendarDate) => {
    setConfirming(startDate)
  }, [])

  const cancelConfirm = useCallback(() => setConfirming(null), [])

  const confirmDelete = useCallback(async () => {
    const target = registrations.find((r) => r.startDate === confirming)
    if (!target) return
    setPhase('deleting')
    setResults([])
    const collected: DeleteResult[] = []
    const finished = await deleteRegistration(
      apiRef.current,
      target.events,
      (result) => {
        collected.push(result)
        setResults([...collected])
      },
      retryDeps,
    )
    setResults(finished)
    setPhase('done')
  }, [registrations, confirming, retryDeps])

  const backToList = useCallback(() => {
    setConfirming(null)
    setResults([])
    // The list in hand is stale — the events just deleted are gone — so re-read
    // rather than reusing a grouping that no longer describes the calendar.
    refresh()
  }, [refresh])

  return {
    phase,
    connected,
    registrations,
    confirming,
    results,
    error,
    connect,
    refresh,
    beginConfirm,
    cancelConfirm,
    confirmDelete,
    backToList,
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -- useRegistrations`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/ui/useRegistrations.ts src/ui/useRegistrations.test.ts src/ui/copy.ts
git commit -m "feat(ui): add the registrations list and delete state machine"
```

---

### Task 9: `RegistrationRow` — the card and its inline confirm

**Files:**
- Create: `src/ui/RegistrationRow.tsx`
- Test: `src/ui/RegistrationRow.test.tsx`

**Interfaces:**
- Consumes: `type Registration`, `type DeleteResult` from `@/google/registrations`; `formatLong` from `@/domain/calendarDate`; `COPY`; `Alert`, `AlertDescription`; `Button`; `Badge`; `cn`
- Produces: `<RegistrationRow />` with props `{ registration: Registration; todayDate: CalendarDate; state: 'list' | 'confirming' | 'deleting' | 'done'; results: DeleteResult[]; onBeginConfirm: () => void; onCancel: () => void; onConfirm: () => void }`

- [ ] **Step 1: Write the failing test**

Create `src/ui/RegistrationRow.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RegistrationRow, type RegistrationRowProps } from '@/ui/RegistrationRow'
import { DELETE_HALTED, type Registration } from '@/google/registrations'
import { calendarDate } from '@/domain/calendarDate'
import { COPY } from '@/ui/copy'

const TODAY = calendarDate('2026-06-01')

const REG: Registration = {
  startDate: calendarDate('2025-03-14'),
  title: 'Anna & Ben: Day 100',
  count: 3,
  events: [
    { id: 'a', date: calendarDate('2025-06-21'), label: 'Day 100' },
    { id: 'b', date: calendarDate('2026-03-14'), label: '1 Year' },
    { id: 'c', date: calendarDate('2027-03-14'), label: '2 Years' },
  ],
}

const noop = () => {}

function renderRow(over: Partial<RegistrationRowProps> = {}) {
  return render(
    <RegistrationRow
      registration={REG}
      todayDate={TODAY}
      state="list"
      results={[]}
      onBeginConfirm={noop}
      onCancel={noop}
      onConfirm={noop}
      {...over}
    />,
  )
}

describe('RegistrationRow — list state', () => {
  it('shows the title and the event count', () => {
    renderRow()
    expect(screen.getByText('Anna & Ben: Day 100')).toBeInTheDocument()
    expect(screen.getByText(COPY.registrationMeta('Mar 14, 2025', 3))).toBeInTheDocument()
  })

  it('does not list the events until asked', () => {
    renderRow()
    expect(screen.queryByText('1 Year')).not.toBeInTheDocument()
  })

  it('opens the confirm on request', async () => {
    const onBeginConfirm = vi.fn()
    renderRow({ onBeginConfirm })
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteOpen }))
    expect(onBeginConfirm).toHaveBeenCalled()
  })
})

describe('RegistrationRow — confirming', () => {
  it('lists every event, not a truncated preview', () => {
    // The point of the confirm step is seeing forgotten past events, so an
    // "and N more" would hide exactly what it exists to show.
    renderRow({ state: 'confirming' })
    expect(screen.getByText('Day 100')).toBeInTheDocument()
    expect(screen.getByText('1 Year')).toBeInTheDocument()
    expect(screen.getByText('2 Years')).toBeInTheDocument()
  })

  it('marks exactly the past events', () => {
    renderRow({ state: 'confirming' })
    // Against TODAY of 2026-06-01: Day 100 (2025-06-21) and 1 Year (2026-03-14)
    // are past; 2 Years (2027-03-14) is not. Asserting the count rather than
    // "at least one" is what catches an off-by-one in the boundary.
    expect(screen.getAllByText(COPY.statusPast)).toHaveLength(2)
  })

  it('warns with the count and says it cannot be undone', () => {
    renderRow({ state: 'confirming' })
    expect(screen.getByRole('alert')).toHaveTextContent(COPY.deleteWarning(3))
  })

  it('puts the count on the confirm button', () => {
    renderRow({ state: 'confirming' })
    expect(screen.getByRole('button', { name: COPY.deleteConfirm(3) })).toBeInTheDocument()
  })

  it('cancels without deleting', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    renderRow({ state: 'confirming', onCancel, onConfirm })
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteCancel }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms when asked', async () => {
    const onConfirm = vi.fn()
    renderRow({ state: 'confirming', onConfirm })
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteConfirm(3) }))
    expect(onConfirm).toHaveBeenCalled()
  })
})

describe('RegistrationRow — deleting and done', () => {
  it('disables both buttons while deleting', () => {
    renderRow({ state: 'deleting' })
    expect(screen.getByRole('button', { name: COPY.deleteCancel })).toBeDisabled()
    expect(screen.getByRole('button', { name: COPY.deleteBusy })).toBeDisabled()
  })

  it('shows progress as results land, before the run is done', () => {
    // Task 8 streams results through onProgress, so a partly-finished delete has
    // to render what has already landed -- it is the user's only feedback during
    // an operation they cannot undo. A component that rendered badges only in
    // the 'done' state would pass every other test in this file.
    renderRow({
      state: 'deleting',
      results: [{ event: REG.events[0]!, outcome: 'deleted' }],
    })
    expect(screen.getByText(COPY.outcomeDeleted)).toBeInTheDocument()
    // Day 100 is past AND finished, so its outcome replaces the past marker;
    // 1 Year is past and still in flight, so it keeps one. Asserting the count
    // pins that substitution rather than merely that both kinds of badge exist.
    expect(screen.getAllByText(COPY.statusPast)).toHaveLength(1)
  })

  it('shows an outcome per event when done', () => {
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'deleted' },
        { event: REG.events[1]!, outcome: 'alreadyGone' },
        { event: REG.events[2]!, outcome: 'failed', error: 'boom' },
      ],
    })
    expect(screen.getByText(COPY.outcomeDeleted)).toBeInTheDocument()
    expect(screen.getByText(COPY.outcomeAlreadyGone)).toBeInTheDocument()
    expect(screen.getByText(COPY.outcomeFailed)).toBeInTheDocument()
    // The reason, not just the badge. A halted run reports every unattempted
    // event as `failed`, so the count alone cannot tell a user whether their
    // registration is half-deleted or untouched.
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })

  it('offers to reconnect when the run halted, rather than showing the raw 401', () => {
    // The first failure is always the real 401, because mapWithLimit claims
    // indices in increasing order -- so selecting on `outcome === 'failed'` would
    // render "Google Calendar API 401 (authError)" and never the actionable copy.
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'failed', error: 'Google Calendar API 401 (authError)' },
        { event: REG.events[1]!, outcome: 'failed', error: DELETE_HALTED },
        { event: REG.events[2]!, outcome: 'failed', error: DELETE_HALTED },
      ],
    })
    expect(screen.getByRole('alert')).toHaveTextContent(COPY.deleteHalted)
  })

  it('says nothing extra when every event succeeded', () => {
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'deleted' },
        { event: REG.events[1]!, outcome: 'alreadyGone' },
      ],
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('summarises already-gone separately from failed', () => {
    // Already gone is a success. Folding it into failures would report a problem
    // that does not exist.
    renderRow({
      state: 'done',
      results: [
        { event: REG.events[0]!, outcome: 'deleted' },
        { event: REG.events[1]!, outcome: 'alreadyGone' },
        { event: REG.events[2]!, outcome: 'deleted' },
      ],
    })
    expect(screen.getByText(COPY.deleteSummary(2, 1, 0))).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- RegistrationRow`
Expected: FAIL — `Failed to resolve import "@/ui/RegistrationRow"`.

- [ ] **Step 3: Write `src/ui/RegistrationRow.tsx`**

```tsx
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatLong, type CalendarDate } from '@/domain/calendarDate'
import {
  DELETE_HALTED,
  type DeleteResult,
  type Registration,
} from '@/google/registrations'
import { cn } from '@/lib/utils'
import { COPY } from '@/ui/copy'

const OUTCOME_LABEL = {
  deleted: COPY.outcomeDeleted,
  alreadyGone: COPY.outcomeAlreadyGone,
  failed: COPY.outcomeFailed,
} as const

export interface RegistrationRowProps {
  registration: Registration
  todayDate: CalendarDate
  state: 'list' | 'confirming' | 'deleting' | 'done'
  results: DeleteResult[]
  onBeginConfirm: () => void
  onCancel: () => void
  onConfirm: () => void
}

export function RegistrationRow({
  registration,
  todayDate,
  state,
  results,
  onBeginConfirm,
  onCancel,
  onConfirm,
}: RegistrationRowProps) {
  const open = state !== 'list'
  const byId = new Map(results.map((r) => [r.event.id, r]))
  const deleted = results.filter((r) => r.outcome === 'deleted').length
  const alreadyGone = results.filter((r) => r.outcome === 'alreadyGone').length
  const failed = results.filter((r) => r.outcome === 'failed').length
  // A halted run stamps DELETE_HALTED on every event it never attempted. Prefer
  // that over the first failure's error, because the first failure is ALWAYS the
  // real 401: mapWithLimit's workers claim indices in increasing order, so the
  // item that set the halt flag always sorts before the items it short-circuited.
  // Reading `find(outcome === 'failed')?.error` would therefore render
  // "Google Calendar API 401 (authError)" and never the reconnect message.
  const reason = results.some((r) => r.error === DELETE_HALTED)
    ? COPY.deleteHalted
    : results.find((r) => r.outcome === 'failed')?.error

  return (
    <li
      className={cn(
        'rounded-xl border p-3',
        open ? 'border-destructive/40' : 'border-border',
      )}
    >
      <p className="font-medium">{registration.title}</p>
      <p className="text-xs text-muted-foreground">
        {COPY.registrationMeta(formatLong(registration.startDate), registration.count)}
      </p>

      {state === 'list' && (
        <Button
          variant="ghost"
          className="mt-2 min-h-11 px-0 text-destructive"
          onClick={onBeginConfirm}
        >
          {COPY.deleteOpen}
        </Button>
      )}

      {open && (
        <>
          {state === 'confirming' && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{COPY.deleteWarning(registration.count)}</AlertDescription>
            </Alert>
          )}

          {/*
            Every event, scrollable, never truncated. This step exists so a user
            sees the past events they had forgotten; an "and N more" would hide
            precisely those.
          */}
          <ul className="mt-3 max-h-56 overflow-y-auto border-t pt-2 text-sm">
            {registration.events.map((event) => {
              const result = byId.get(event.id)
              const past = event.date < todayDate
              return (
                <li key={event.id} className="flex items-baseline gap-2 py-1">
                  <span className="w-20 shrink-0 font-medium">{event.label}</span>
                  <span className="flex-1 tabular-nums text-muted-foreground">
                    {formatLong(event.date)}
                  </span>
                  {result ? (
                    <Badge variant={result.outcome === 'failed' ? 'destructive' : 'secondary'}>
                      {OUTCOME_LABEL[result.outcome]}
                    </Badge>
                  ) : (
                    past && <Badge variant="secondary">{COPY.statusPast}</Badge>
                  )}
                </li>
              )
            })}
          </ul>

          {state === 'done' ? (
            <>
              <p className="mt-3 text-sm font-medium">
                {COPY.deleteSummary(deleted, alreadyGone, failed)}
              </p>
              {/*
                One Alert carrying the first failure's reason, matching
                ResultSummary's `error ?? failed[0]?.error`. Without it a run
                halted by an expired token shows `Failed` badges and a bare count,
                with nothing saying the events were never attempted or that
                reconnecting is what fixes it — deleteRegistration stamps those
                items with the DELETE_HALTED sentinel precisely so ui/ can
                recognise the case and supply the wording.
                Cannot collide with the confirming Alert above: that one is gated
                on `state === 'confirming'`, which this branch excludes.
              */}
              {reason && (
                <Alert variant="destructive" className="mt-3">
                  <AlertDescription>{reason}</AlertDescription>
                </Alert>
              )}
            </>
          ) : (
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                className="min-h-11 flex-1"
                disabled={state === 'deleting'}
                onClick={onCancel}
              >
                {COPY.deleteCancel}
              </Button>
              <Button
                variant="destructive"
                className="min-h-11 flex-1"
                disabled={state === 'deleting'}
                onClick={onConfirm}
              >
                {state === 'deleting' ? COPY.deleteBusy : COPY.deleteConfirm(registration.count)}
              </Button>
            </div>
          )}
        </>
      )}
    </li>
  )
}
```

`min-h-11` is the 44px touch floor on every interactive element, including `Delete…`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- RegistrationRow`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/RegistrationRow.tsx src/ui/RegistrationRow.test.tsx
git commit -m "feat(ui): add the registration card with an inline confirm"
```

---

### Task 10: Wire `RegistrationsPage`

**Files:**
- Modify: `src/ui/RegistrationsPage.tsx`
- Test: `src/ui/RegistrationsPage.test.tsx`

**Interfaces:**
- Consumes: `useRegistrations`, `RegistrationRow`, `COPY`, `Alert`, `Button`, `today`
- Produces: no new exports; `RegistrationsPageProps` gains `todayDate?: CalendarDate`

- [ ] **Step 1: Write the failing test**

Create `src/ui/RegistrationsPage.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RegistrationsPage } from '@/ui/RegistrationsPage'
import type { Auth } from '@/google/auth'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { calendarDate } from '@/domain/calendarDate'
import { COPY } from '@/ui/copy'
import type { DayMarkerDeps } from '@/ui/useDayMarker'

function ev(id: string, startDate: string, key: string, date: string): GoogleEvent {
  return {
    id,
    status: 'confirmed',
    summary: `Anna & Ben: ${key}`,
    start: { date },
    extendedProperties: { private: { dayMarkerVersion: '1', startDate, milestoneKey: key } },
  }
}

function deps(items: GoogleEvent[], token: string | null = 'tok'): DayMarkerDeps {
  const auth: Auth = {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => token),
    clear: vi.fn(),
  }
  const api = {
    getEvent: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(async () => 'deleted' as const),
    listEvents: vi.fn(async () => ({ items })),
  } as unknown as CalendarApi
  return { auth, api }
}

const ready = async () => true
const TODAY = calendarDate('2026-06-01')

const TWO = [ev('a', '2025-03-14', 'd100', '2025-06-21'), ev('b', '2025-03-14', 'y1', '2026-03-14')]

describe('RegistrationsPage', () => {
  it('prompts to connect when there is no token', () => {
    render(
      <RegistrationsPage deps={deps([], null)} checkGisReady={ready} todayDate={TODAY} />,
    )
    expect(screen.getByText(COPY.registrationsConnectPrompt)).toBeInTheDocument()
  })

  it('lists registrations once connected', async () => {
    render(<RegistrationsPage deps={deps(TWO)} checkGisReady={ready} todayDate={TODAY} />)
    expect(await screen.findByText('Anna & Ben: d100')).toBeInTheDocument()
    expect(screen.getByText(COPY.registrationsCount(1))).toBeInTheDocument()
  })

  it('shows an empty state when nothing is registered', async () => {
    render(<RegistrationsPage deps={deps([])} checkGisReady={ready} todayDate={TODAY} />)
    expect(await screen.findByText(COPY.registrationsEmpty)).toBeInTheDocument()
  })

  it('deletes a registration end to end', async () => {
    const d = deps(TWO)
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    await userEvent.click(await screen.findByRole('button', { name: COPY.deleteOpen }))
    await userEvent.click(screen.getByRole('button', { name: COPY.deleteConfirm(2) }))
    await waitFor(() => expect(screen.getByText(COPY.deleteSummary(2, 0, 0))).toBeInTheDocument())
    expect(d.api.deleteEvent).toHaveBeenCalledTimes(2)
  })

  it('reports a listing failure and shows no list', async () => {
    const d = deps(TWO)
    ;(d.api.listEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('list exploded'))
    render(<RegistrationsPage deps={d} checkGisReady={ready} todayDate={TODAY} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('list exploded')
    expect(screen.queryByRole('button', { name: COPY.deleteOpen })).not.toBeInTheDocument()
  })

  it('shows exactly one alert while confirming a delete', async () => {
    // The confirm warning is itself an alert, so a stray page-level alert would
    // make every getByRole('alert') query ambiguous.
    render(<RegistrationsPage deps={deps(TWO)} checkGisReady={ready} todayDate={TODAY} />)
    await userEvent.click(await screen.findByRole('button', { name: COPY.deleteOpen }))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- RegistrationsPage`
Expected: FAIL — the page renders only the connect state, so the listing assertions fail.

- [ ] **Step 3: Rewrite `src/ui/RegistrationsPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { today as todayFn, type CalendarDate } from '@/domain/calendarDate'
import { whenGisReady } from '@/google/auth'
import { COPY } from '@/ui/copy'
import { RegistrationRow } from '@/ui/RegistrationRow'
import type { DayMarkerDeps } from '@/ui/useDayMarker'
import { useRegistrations } from '@/ui/useRegistrations'

export interface RegistrationsPageProps {
  deps: DayMarkerDeps
  /** Injectable because window.google never exists under jsdom. */
  checkGisReady?: () => Promise<boolean>
  todayDate?: CalendarDate
}

export function RegistrationsPage({
  deps,
  checkGisReady = whenGisReady,
  todayDate = todayFn(),
}: RegistrationsPageProps) {
  const state = useRegistrations({ auth: deps.auth, api: deps.api, retryDeps: deps.retryDeps })
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

  // Gated so it cannot coexist with a RegistrationRow's own confirm Alert; two
  // role="alert" elements would make every such query ambiguous.
  const showPageError = state.error !== null && state.confirming === null

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-10 pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {state.connected && state.phase === 'ready'
            ? COPY.registrationsCount(state.registrations.length)
            : COPY.registrationsTitle}
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {state.connected ? COPY.connected : COPY.notConnected}
        </span>
      </div>

      {showPageError && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {!state.connected ? (
        <>
          <p className="text-sm text-muted-foreground">{COPY.registrationsConnectPrompt}</p>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={gisReady !== true}
            onClick={() => void state.connect()}
          >
            {COPY.connect}
          </Button>
        </>
      ) : state.phase === 'loading' ? (
        <p className="text-sm text-muted-foreground">{COPY.registrationsLoading}</p>
      ) : state.registrations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{COPY.registrationsEmpty}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {state.registrations.map((registration) => {
              const active = state.confirming === registration.startDate
              return (
                <RegistrationRow
                  key={registration.startDate}
                  registration={registration}
                  todayDate={todayDate}
                  state={
                    !active
                      ? 'list'
                      : state.phase === 'deleting'
                        ? 'deleting'
                        : state.phase === 'done'
                          ? 'done'
                          : 'confirming'
                  }
                  results={active ? state.results : []}
                  onBeginConfirm={() => state.beginConfirm(registration.startDate)}
                  onCancel={state.cancelConfirm}
                  onConfirm={() => void state.confirmDelete()}
                />
              )
            })}
          </ul>
          {state.phase === 'done' && (
            <Button variant="secondary" className="min-h-11" onClick={state.backToList}>
              {COPY.deleteBack}
            </Button>
          )}
        </>
      )}
    </main>
  )
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- RegistrationsPage`
Expected: PASS — 6 tests.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/ui/RegistrationsPage.tsx src/ui/RegistrationsPage.test.tsx
git commit -m "feat(ui): list and delete registrations"
```

---

### Task 11: Docs — the deployment requirement and five manual checks

**Files:**
- Create: `public/_redirects`
- Modify: `README.md`
- Modify: `docs/manual-verification.md`

**Interfaces:**
- Consumes: the whole feature
- Produces: documentation only, plus one deploy-config file

- [ ] **Step 1: Ship the rewrite rule, and document the rest**

Clean paths mean a hard refresh on `/registrations` 404s on any host that does
not rewrite unknown paths to `index.html`. Documenting that per-host is not
enough on its own: the failure appears only in production, because Vite's dev
server rewrites automatically. So ship the rule for the hosts that read a file,
and document the ones that do not.

Create `public/_redirects` (Vite copies `public/` to the build output verbatim):

```
/*  /index.html  200
```

Two lines, inert on every host that does not read the file, and correct on
Netlify and Cloudflare Pages. Then add the table below, which covers the hosts
`_redirects` cannot serve.

Under **Deploying**, add:

```markdown
### Clean URLs need a host rewrite

The app uses real routes (`/`, `/registrations`), so the host must serve
`index.html` for unknown paths. Vite's dev server and `vite preview` do this
automatically — which means **a missing rewrite works locally and 404s in
production**. Configure it:

| Host | What to add |
|---|---|
| Vercel | `vercel.json` → `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }` |
| Netlify | `public/_redirects` → `/*  /index.html  200` |
| Cloudflare Pages | `public/_redirects` → `/*  /index.html  200` |
| GitHub Pages | No rewrite support: copy `dist/index.html` to `dist/404.html` after building |

### The app needs a secure context

`crypto.subtle` is `SecureContext`-only, so serve over HTTPS (or localhost).
On plain HTTP, event-ID generation fails.
```

- [ ] **Step 2: Document the theme in `README.md`**

Under **How it works**, add:

```markdown
Day Marker follows your system's light or dark setting. The header's theme button
cycles system → light → dark; an explicit choice is remembered in `localStorage`
under `dayMarker.theme`, and removing it returns to following the system.
```

- [ ] **Step 3: Document registrations in `README.md`**

Under **How it works**, add:

```markdown
The **Registrations** tab lists everything Day Marker has written, found by
querying your calendar rather than by storing anything: every event carries its
registration's start date, so the list is grouped from the calendar itself. That
is why a registration made on another device, or a year ago, still appears.
Deleting removes the whole registration — past events included.
```

- [ ] **Step 4: Add five manual checks**

Append to `docs/manual-verification.md`, continuing the existing numbering:

```markdown
## 6. No flash of the wrong theme

The theme class is applied by an inline script in `index.html`, before first
paint. A React-time application would flash the wrong colours on every load, and
no unit test can see this because the script lives outside vitest.

- Set your OS to dark. Hard-refresh the app.
- **Expect:** it is dark from the first painted frame. Record any white flash,
  however brief.

## 7. Native controls respect the theme

The app deliberately uses a native `<input type="date">` and `<select>` because
the base-ui equivalents are untestable under jsdom. Native controls are
user-agent styled, so they only follow the theme if `color-scheme` is applied.

- With a dark theme active, open the start-date picker, then the Range dropdown.
- **Expect:** both render dark. A light picker on a dark page means
  `color-scheme` is not reaching them — record which control and which theme.

## 8. Deep links survive a refresh

- With the app **deployed** (not the dev server), navigate to Registrations, then
  hard-refresh the page.
- **Expect:** the page loads. A 404 means the host rewrite from the README's
  Deploying section is missing — record the host and what you configured.

## 9. The sign-in popup is not blocked

Google Identity Services only opens its popup if `requestAccessToken` is reached
inside the user's gesture, before any `await`. Both hooks do this correctly, but
**no unit test can see a regression**: every test stubs auth, so inserting an
`await` before the call leaves the whole suite green. This was verified by mutation
during the Task 8 review — the mutant passed all 296 tests.

- From a cold load, click **Connect** on the main screen. Then repeat from the
  Registrations tab.
- **Expect:** Google's account chooser opens both times. A silent no-op, or a
  browser "popup blocked" indicator, means an `await` crept in ahead of the token
  request — record which screen.

## 10. Delete, then re-register

This is the deliberate version of check 4, and it decides whether the app needs
an ID-versioning escape hatch.

- Register a start date, then delete that registration from the Registrations tab.
- Immediately re-register the same start date.
- **Expect:** the events return. Record which route it took — the milestones
  showing as `Deleted` and reporting `Restored`, or showing as `New` and
  reporting `Updated` via the 409 fallback. Both are correct.
- **If it reports `Failed`:** record the exact error. That is the documented
  unknown — Google purged the events and refused to reuse their IDs — and it is
  the evidence needed to decide on ID versioning.
```

- [ ] **Step 5: Run everything one last time**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add public/_redirects README.md docs/manual-verification.md
git commit -m "docs: document routing, theming, and registrations"
```

---

## Deferred (from the spec — do not build)

- Multiple registrations for one start date. Foreclosed by the identity choice;
  it would need a distinct stamped ID and a migration for existing events.
- Undo. Google may retain a cancelled event, but exposing a restore would rely on
  a lifetime its documentation explicitly disclaims.
- Orphan cleanup when a range shrinks. Deleting the registration handles it.
- Editing a registration's label or range from the list. Re-submitting from the
  form already does this.
