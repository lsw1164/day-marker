# Day Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-only React app that takes a relationship's start date and writes its milestone anniversaries (Day 100, Day 200, …, 1 Year, 2 Years) into the user's Google Calendar.

**Architecture:** Three layers with one-way dependencies. `domain/` is pure TypeScript — date arithmetic, milestone computation, deterministic event IDs, payload construction — with no network and no Google types. `google/` is the only layer that knows about OAuth tokens and HTTP. `ui/` renders and never calls `fetch`. There is no backend and no database; the user's Google Calendar is the only durable state, which works because event IDs are derived deterministically from (start date, milestone key).

**Tech Stack:** Vite, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Vitest, Testing Library, Google Identity Services (browser token client), Google Calendar API v3.

**Spec:** `docs/superpowers/specs/2026-08-17-day-marker-design.md`

## Global Constraints

These apply to every task. Values are copied verbatim from the spec.

- **OAuth scope is exactly `https://www.googleapis.com/auth/calendar.events`.** Do not add scopes.
- **Event IDs must match `/^[0-9a-v]{5,1024}$/`** — Google's base32hex alphabet is lowercase `a`–`v` and digits `0`–`9`. One stray `w` is a 400.
- **Event IDs depend on the start date and milestone key ONLY** — never on title, label, reminder, `years`, or UI language. This is what makes re-submission an update rather than a duplication. Never weaken it.
- **Milestone keys (`d100`, `y1`) are independent of display labels.** Rewording a label must never change a key.
- **Day counting is the Korean convention: the start date is day 1.** Day 100 is `start + 99 days`.
- **Year milestones are calendar-based**, same month/day N years later — never `start + 365n`. Feb 29 lands on Feb 28 in common years.
- **`end.date` is exclusive** for all-day events: a one-day event ends the following day.
- **Reminder offsets are 0–40320 minutes, always before event start.** Allowed presets only: `none` (`[]`), `900`, `3780`, `9540`.
- **`years` range is 1–10, default 3.** Day milestones step by 100. Default range yields exactly 13 milestones.
- **All user-facing copy is English string literals.** No i18n layer, no message catalog, no locale detection.
- **Never put the access token in `localStorage`** or any persistent storage. Module-level variable only.
- **`VITE_GOOGLE_CLIENT_ID` is public by design** and ships in the bundle. There is no client secret in this flow.
- **Node 20+** and npm. All commands run from the repo root.
- **`src/` may not import Node builtins.** `tsconfig.json` omits `"node"` from `types` on
  purpose; `vite.config.ts` and `vitest.setup.ts` live at the repo root under
  `tsconfig.node.json`. Never widen `tsconfig.json`'s `types` to fix an import error.
- **`vitest` must stay on a major whose `vite` peer range includes the installed `vite`**
  (currently vitest `^4.1.10` with vite `6.4.3`). A mismatch silently nests a second vite
  and the test runner then executes a different major than `vite build`.
- **The test suite runs under `TZ=Asia/Seoul`** and the npm scripts must keep setting it.
  This is not cosmetic. A local-midnight date implementation — the exact regression
  `CalendarDate` exists to prevent — produces *identical* results under `TZ=UTC` and under
  US timezones, so a suite run there cannot catch it. Under a positive UTC offset it is off
  by one day. Korea is UTC+9, so the app's own users sit in the offset class that exposes
  the bug while a default CI run stays blind to it. Verified empirically: `2026-01-01 + 99`
  gives `2026-04-10` correctly but `2026-04-09` from a local-midnight implementation under
  Asia/Seoul, and `2026-04-10` from both under UTC.

## File Structure

```
package.json              deps and scripts
vite.config.ts            vite + react + tailwind plugins, vitest config, @/ alias
vitest.setup.ts           jest-dom matchers; guarantees crypto.subtle
tsconfig.json             app config, @/* path alias — browser-only, no Node types
tsconfig.node.json        config for vite.config.ts and vitest.setup.ts
index.html               entry; loads the GIS script
components.json           shadcn config (generated)
.env.local.example        VITE_GOOGLE_CLIENT_ID placeholder
src/
  main.tsx                React root
  vite-env.d.ts           types import.meta.env; names VITE_GOOGLE_CLIENT_ID
  index.css               tailwind import + shadcn theme tokens
  lib/
    utils.ts              shadcn `cn` helper (generated)
    mapWithLimit.ts       bounded-concurrency map returning settled results
    backoff.ts            withRetry with injectable sleep/jitter
  domain/                 pure — no fetch, no Google types, no React
    calendarDate.ts       CalendarDate branded type + arithmetic
    milestones.ts         Milestone type + computeMilestones
    eventId.ts            base32hex + eventIdFor
    reminders.ts          ReminderPreset, minutes, labels
    eventPayload.ts       GoogleEventPayload + buildEventPayload + titleFor
  google/
    errors.ts             typed API errors + isRetryable
    calendarApi.ts        getEvent / insertEvent / patchEvent over fetch
    auth.ts               GIS token client wrapper
    plan.ts               probe deterministic IDs → PlanItem[]
    apply.ts              execute plan with concurrency + 409 fallback
  ui/
    copy.ts               every user-facing string
    useDayMarker.ts       the phase state machine
    StartDateForm.tsx     date / label / range / reminder inputs
    MilestoneRow.tsx      one row: checkbox, name, date, badge
    MilestoneList.tsx     the list + section header
    ResultSummary.tsx     done and partial-failure views
    App.tsx               composition and the sticky action button
    components/ui/        shadcn primitives (generated)
```

Tests live beside their subjects as `*.test.ts` / `*.test.tsx`. `domain/` never imports from `google/`; `ui/` never calls `fetch`.

**`src/` is browser-only at the type level.** `tsconfig.json`'s `types` array deliberately
omits `"node"`, so importing `node:fs` (or any Node builtin) anywhere under `src/` is a type
error. The two files that legitimately run in Node — `vite.config.ts` and `vitest.setup.ts` —
live at the repo root and are typed by `tsconfig.node.json`. Do not add `"node"` to
`tsconfig.json` to resolve an import error; move the file that needs Node instead.

---

### Task 1: Project scaffolding and test harness

Builds the toolchain by hand rather than via `npm create vite`, which prompts interactively in a non-empty directory. Ends with a passing test run, so every later task has a working `npm test`.

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `index.html`, `.env.local.example`
- Create: `src/main.tsx`, `src/index.css`, `src/vitest.setup.ts`, `src/lib/utils.ts`
- Create: `src/lib/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` (vitest run), `npm run dev`, `npm run build`, `npm run typecheck`. The `@/` alias resolves to `src/`. `cn(...)` from `@/lib/utils`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "day-marker",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --noEmit"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.2",
    "vite": "^6.0.0",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

The `@/*` path alias is required by shadcn/ui.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create `vite.config.ts`**

Two details that will otherwise cost an hour: `defineConfig` must come from
`vitest/config` (Vite's own has no `test` key and TS will reject it), and `__dirname`
does not exist here — `package.json` declares `"type": "module"`, so the config is ESM.

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
```

- [ ] **Step 5: Create `src/vitest.setup.ts`**

jsdom does not provide `crypto.subtle`, which `eventId.ts` requires in Task 4. Install Node's WebCrypto when it is missing.

```ts
import '@testing-library/jest-dom/vitest'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  })
}
```

- [ ] **Step 6: Create `index.html`**

The GIS script is loaded here, not lazily, so `requestAccessToken()` is callable synchronously inside a click handler.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Day Marker</title>
    <script src="https://accounts.google.com/gsi/client" async defer></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Create `src/index.css`**

```css
@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #18181b;
}

body {
  background: var(--background);
  color: var(--foreground);
}
```

- [ ] **Step 8: Create `src/main.tsx`**

A placeholder root; Task 13 replaces the body with `<App />`.

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div>Day Marker</div>
  </StrictMode>,
)
```

- [ ] **Step 9: Create `src/lib/utils.ts`**

Written by hand so it exists before `shadcn init` runs; the generated version is identical.

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 10: Create `.env.local.example`**

```
# Google Cloud Console → Credentials → OAuth 2.0 Client ID → Web application.
# This value is public and ships in the bundle. There is no client secret.
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

- [ ] **Step 11: Add the smoke test at `src/lib/smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { cn } from '@/lib/utils'

describe('test harness', () => {
  it('resolves the @/ alias', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('provides crypto.subtle for deterministic IDs', () => {
    expect(globalThis.crypto.subtle).toBeDefined()
  })
})
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `vitest: command not found` or `Cannot find module 'clsx'`, because nothing is installed yet.

- [ ] **Step 13: Install dependencies**

```bash
npm install
npm install clsx tailwind-merge
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 2 tests in `src/lib/smoke.test.ts`.

- [ ] **Step 15: Initialize shadcn/ui and add the primitives**

`-d` accepts defaults non-interactively. The component list is everything the UI tasks need; adding them now avoids interactive prompts mid-task later.

```bash
npx shadcn@latest init -d
npx shadcn@latest add button input label select checkbox progress badge alert card
```

- [ ] **Step 16: Verify the build and types still pass**

Run: `npm run typecheck && npm run build`
Expected: both succeed. If `shadcn init` overwrote `src/index.css`, keep its version — it contains the theme tokens the primitives need.

- [ ] **Step 17: Update `.gitignore`**

Append to the existing file (which already has `.superpowers/`, `node_modules/`, `dist/`, `.env.local`):

```
*.local
.DS_Store
```

- [ ] **Step 18: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts \
        index.html components.json .env.local.example .gitignore src/
git commit -m "chore: scaffold vite + react + tailwind + shadcn + vitest"
```

---

### Task 2: CalendarDate

A branded `'YYYY-MM-DD'` string with arithmetic that never touches local midnight. This exists to make the DST off-by-one-day bug unrepresentable.

**Files:**
- Create: `src/domain/calendarDate.ts`
- Test: `src/domain/calendarDate.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type CalendarDate` — branded string
  - `calendarDate(v: string): CalendarDate` — throws `RangeError` on invalid
  - `isCalendarDate(v: string): v is CalendarDate`
  - `addDays(d: CalendarDate, n: number): CalendarDate`
  - `addYears(d: CalendarDate, n: number): CalendarDate` — clamps Feb 29 → Feb 28
  - `today(now?: Date): CalendarDate` — local calendar day
  - `formatLong(d: CalendarDate): string` — `'Mar 14, 2025'`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/calendarDate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  addDays,
  addYears,
  calendarDate,
  formatLong,
  isCalendarDate,
  today,
} from '@/domain/calendarDate'

describe('calendarDate', () => {
  it('accepts a well-formed date', () => {
    expect(calendarDate('2026-01-01')).toBe('2026-01-01')
  })

  it.each(['2026-1-1', '20260101', 'not-a-date', '2026-02-30', '2026-13-01'])(
    'rejects %s',
    (bad) => {
      expect(isCalendarDate(bad)).toBe(false)
      expect(() => calendarDate(bad)).toThrow(RangeError)
    },
  )
})

describe('addDays', () => {
  it('adds within a month', () => {
    expect(addDays(calendarDate('2026-01-01'), 5)).toBe('2026-01-06')
  })

  it('crosses a month boundary', () => {
    expect(addDays(calendarDate('2026-01-31'), 1)).toBe('2026-02-01')
  })

  it('crosses a year boundary', () => {
    expect(addDays(calendarDate('2026-12-31'), 1)).toBe('2027-01-01')
  })

  it('handles a leap day', () => {
    expect(addDays(calendarDate('2024-02-28'), 1)).toBe('2024-02-29')
  })

  it('subtracts with a negative offset', () => {
    expect(addDays(calendarDate('2026-01-01'), -1)).toBe('2025-12-31')
  })

  it('survives a spring-forward DST boundary', () => {
    // US DST begins 2026-03-08. A local-midnight Date would slip a day here.
    expect(addDays(calendarDate('2026-03-07'), 1)).toBe('2026-03-08')
    expect(addDays(calendarDate('2026-03-08'), 1)).toBe('2026-03-09')
  })
})

describe('addYears', () => {
  it('keeps the same month and day', () => {
    expect(addYears(calendarDate('2026-01-01'), 1)).toBe('2027-01-01')
  })

  it('clamps Feb 29 to Feb 28 in a common year', () => {
    expect(addYears(calendarDate('2024-02-29'), 1)).toBe('2025-02-28')
  })

  it('keeps Feb 29 when the target year is also a leap year', () => {
    expect(addYears(calendarDate('2024-02-29'), 4)).toBe('2028-02-29')
  })

  it('is not 365-day arithmetic', () => {
    // 2024 is a leap year, so start + 365 days would be 2025-02-28.
    expect(addYears(calendarDate('2024-03-01'), 1)).toBe('2025-03-01')
  })
})

describe('today', () => {
  it('uses the local calendar day, not UTC', () => {
    // 23:30 local on Jan 1 is already Jan 2 in UTC for positive offsets,
    // but the user's "today" is still Jan 1.
    const localLateEvening = new Date(2026, 0, 1, 23, 30)
    expect(today(localLateEvening)).toBe('2026-01-01')
  })
})

describe('formatLong', () => {
  it('renders a human-readable date', () => {
    expect(formatLong(calendarDate('2025-03-14'))).toBe('Mar 14, 2025')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- calendarDate`
Expected: FAIL — `Failed to resolve import "@/domain/calendarDate"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/calendarDate.ts`:

```ts
declare const brand: unique symbol

/** A calendar day with no time and no timezone, as 'YYYY-MM-DD'. */
export type CalendarDate = string & { readonly [brand]: 'CalendarDate' }

const PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * All arithmetic runs at UTC noon. Noon is 12 hours from either midnight, so
 * no DST shift can move the date, and UTC removes local-offset surprises.
 */
function toUtcNoon(d: string): Date {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, day, 12))
}

function format(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0')
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isCalendarDate(v: string): v is CalendarDate {
  if (!PATTERN.test(v)) return false
  const parsed = toUtcNoon(v)
  // Round-tripping rejects impossible days like 2026-02-30, which Date rolls over.
  return !Number.isNaN(parsed.getTime()) && format(parsed) === v
}

export function calendarDate(v: string): CalendarDate {
  if (!isCalendarDate(v)) throw new RangeError(`Not a calendar date: ${v}`)
  return v
}

export function addDays(d: CalendarDate, n: number): CalendarDate {
  const date = toUtcNoon(d)
  date.setUTCDate(date.getUTCDate() + n)
  return format(date) as CalendarDate
}

export function addYears(d: CalendarDate, n: number): CalendarDate {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y + n, m - 1, day, 12))
  // Feb 29 in a common year rolls forward to Mar 1; pull it back to Feb 28.
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0)
  return format(target) as CalendarDate
}

export function today(now: Date = new Date()): CalendarDate {
  const y = String(now.getFullYear()).padStart(4, '0')
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}` as CalendarDate
}

const LONG = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

export function formatLong(d: CalendarDate): string {
  return LONG.format(toUtcNoon(d))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- calendarDate`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/calendarDate.ts src/domain/calendarDate.test.ts
git commit -m "feat(domain): add CalendarDate with DST-safe arithmetic"
```

---

### Task 3: Milestone computation

The Korean counting convention lives here: the start date is day 1, so Day 100 is `start + 99 days`. Year milestones are calendar-based, never 365-day multiples.

**Files:**
- Create: `src/domain/milestones.ts`
- Test: `src/domain/milestones.test.ts`
- Modify: `package.json` (pin the suite's timezone — see Step 0)

**Step 0 — pin the test timezone.** This amends Task 1's scripts, and it belongs here
because this is the first task whose correctness *is* day arithmetic. Change:

```json
"test": "TZ=Asia/Seoul vitest run",
"test:watch": "TZ=Asia/Seoul vitest"
```

Without this, every date test in Tasks 3, 5, 8, 11 and 12 is blind to the one bug
`CalendarDate` was built to prevent: a local-midnight implementation returns the *same*
answers as the correct one under `TZ=UTC` and under US timezones, and only diverges at a
positive UTC offset. Korea is UTC+9. Pinning turns the existing suite into a real guard
rather than a sanity check — the already-written `addDays('2026-12-31', 1)` assertion, for
instance, starts failing against a local-midnight implementation the moment the pin is in.
All 20 existing tests already pass under it.

**Interfaces:**
- Consumes: `addDays`, `addYears`, `CalendarDate` from `@/domain/calendarDate`
- Produces:
  - `type MilestoneKind = 'day' | 'year'`
  - `interface Milestone { key: string; kind: MilestoneKind; n: number; date: CalendarDate; label: string }`
  - `computeMilestones(start: CalendarDate, years: number): Milestone[]`
  - `DAY_STEP = 100`, `MIN_YEARS = 1`, `MAX_YEARS = 10`, `DEFAULT_YEARS = 3`, `YEAR_OPTIONS: number[]`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/milestones.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones, DEFAULT_YEARS } from '@/domain/milestones'

const START = calendarDate('2026-01-01')

describe('computeMilestones — day milestones', () => {
  it('counts the start date as day 1, so Day 100 is start + 99 days', () => {
    const day100 = computeMilestones(START, DEFAULT_YEARS).find((m) => m.key === 'd100')
    // start + 99, not start + 100 (which would be 2026-04-11).
    expect(day100?.date).toBe('2026-04-10')
  })

  it('places the later day milestones correctly', () => {
    const byKey = new Map(computeMilestones(START, DEFAULT_YEARS).map((m) => [m.key, m.date]))
    expect(byKey.get('d200')).toBe('2026-07-19')
    expect(byKey.get('d300')).toBe('2026-10-27')
    expect(byKey.get('d1000')).toBe('2028-09-26')
  })

  it('steps by 100', () => {
    const days = computeMilestones(START, DEFAULT_YEARS).filter((m) => m.kind === 'day')
    expect(days.map((m) => m.n)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])
  })

  it('labels day milestones as "Day N"', () => {
    const days = computeMilestones(START, DEFAULT_YEARS).filter((m) => m.kind === 'day')
    expect(days[0]?.label).toBe('Day 100')
    expect(days[9]?.label).toBe('Day 1000')
  })
})

describe('computeMilestones — year milestones', () => {
  it('uses the same month and day, not start + 365n', () => {
    const years = computeMilestones(START, DEFAULT_YEARS).filter((m) => m.kind === 'year')
    expect(years.map((m) => m.date)).toEqual(['2027-01-01', '2028-01-01', '2029-01-01'])
  })

  it('pluralizes the label', () => {
    const years = computeMilestones(START, DEFAULT_YEARS).filter((m) => m.kind === 'year')
    expect(years.map((m) => m.label)).toEqual(['1 Year', '2 Years', '3 Years'])
  })

  it('clamps a Feb 29 start to Feb 28 in common years', () => {
    const leap = computeMilestones(calendarDate('2024-02-29'), 1)
    expect(leap.find((m) => m.key === 'y1')?.date).toBe('2025-02-28')
  })
})

describe('computeMilestones — horizon', () => {
  it('yields exactly 13 milestones at the default 3-year range', () => {
    expect(computeMilestones(START, DEFAULT_YEARS)).toHaveLength(13)
  })

  it('yields exactly 4 milestones at a 1-year range', () => {
    const one = computeMilestones(START, 1)
    expect(one.map((m) => m.key)).toEqual(['d100', 'd200', 'd300', 'y1'])
  })

  it('never emits a day milestone past the horizon', () => {
    const horizon = '2029-01-01'
    for (const m of computeMilestones(START, 3)) {
      expect(m.date <= horizon).toBe(true)
    }
  })

  it('lists day milestones before year milestones', () => {
    const kinds = computeMilestones(START, DEFAULT_YEARS).map((m) => m.kind)
    expect(kinds.indexOf('year')).toBe(kinds.lastIndexOf('day') + 1)
  })
})

describe('computeMilestones — keys', () => {
  it('uses label-independent keys', () => {
    const keys = computeMilestones(START, 1).map((m) => m.key)
    expect(keys).toEqual(['d100', 'd200', 'd300', 'y1'])
  })

  it('produces unique keys', () => {
    const keys = computeMilestones(START, 10).map((m) => m.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- milestones`
Expected: FAIL — `Failed to resolve import "@/domain/milestones"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/milestones.ts`:

```ts
import { addDays, addYears, type CalendarDate } from '@/domain/calendarDate'

export type MilestoneKind = 'day' | 'year'

export interface Milestone {
  /** Stable identity, independent of any display string. Feeds the event ID. */
  key: string
  kind: MilestoneKind
  /** The milestone number: 100 for Day 100, 2 for 2 Years. */
  n: number
  date: CalendarDate
  /** Display only. Changing this must never change `key`. */
  label: string
}

export const DAY_STEP = 100
export const MIN_YEARS = 1
export const MAX_YEARS = 10
export const DEFAULT_YEARS = 3
export const YEAR_OPTIONS = [1, 2, 3, 5, 10]

export function computeMilestones(start: CalendarDate, years: number): Milestone[] {
  const horizon = addYears(start, years)
  const milestones: Milestone[] = []

  // Korean convention: the start date is day 1, so Day N falls on start + (N - 1).
  for (let n = DAY_STEP; ; n += DAY_STEP) {
    const date = addDays(start, n - 1)
    if (date > horizon) break
    milestones.push({ key: `d${n}`, kind: 'day', n, date, label: `Day ${n}` })
  }

  for (let k = 1; k <= years; k += 1) {
    milestones.push({
      key: `y${k}`,
      kind: 'year',
      n: k,
      date: addYears(start, k),
      label: k === 1 ? '1 Year' : `${k} Years`,
    })
  }

  return milestones
}
```

`CalendarDate` is `'YYYY-MM-DD'`, so lexicographic `>` is chronological — no parsing needed for the horizon check.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- milestones`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/milestones.ts src/domain/milestones.test.ts
git commit -m "feat(domain): compute day and year milestones"
```

---

### Task 4: Deterministic event IDs

The keystone of the whole design. Same (start date, milestone key) always produces the same Google event ID, so re-submitting updates instead of duplicating — and no server-side storage is needed to know what already exists.

**Files:**
- Create: `src/domain/eventId.ts`
- Test: `src/domain/eventId.test.ts`

**Interfaces:**
- Consumes: `CalendarDate` from `@/domain/calendarDate`
- Produces:
  - `base32hex(bytes: Uint8Array): string`
  - `eventIdFor(start: CalendarDate, key: string): Promise<string>`
  - `ID_PATTERN: RegExp`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/eventId.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { calendarDate } from '@/domain/calendarDate'
import { base32hex, eventIdFor, ID_PATTERN } from '@/domain/eventId'

const START = calendarDate('2026-01-01')

describe('base32hex', () => {
  it('uses only Google-legal characters', () => {
    const bytes = new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 8))
    expect(base32hex(bytes)).toMatch(/^[0-9a-v]+$/)
  })

  it('encodes RFC 4648 base32hex without padding', () => {
    // 'f' -> 0x66 -> base32hex 'co'
    expect(base32hex(new TextEncoder().encode('f'))).toBe('co')
    // 'foobar' is the RFC 4648 test vector 'CPNMUOJ1E8======' lowercased, unpadded.
    expect(base32hex(new TextEncoder().encode('foobar'))).toBe('cpnmuoj1e8')
  })
})

describe('eventIdFor', () => {
  it('is deterministic', async () => {
    const a = await eventIdFor(START, 'd100')
    const b = await eventIdFor(START, 'd100')
    expect(a).toBe(b)
  })

  it('matches Google’s required charset and length', async () => {
    for (const key of ['d100', 'd1000', 'y1', 'y10']) {
      const id = await eventIdFor(START, key)
      expect(id).toMatch(ID_PATTERN)
      expect(id.length).toBeGreaterThanOrEqual(5)
      expect(id.length).toBeLessThanOrEqual(1024)
    }
  })

  it('differs per milestone key', async () => {
    const ids = await Promise.all(
      ['d100', 'd200', 'y1', 'y2'].map((k) => eventIdFor(START, k)),
    )
    expect(new Set(ids).size).toBe(4)
  })

  it('differs per start date', async () => {
    const a = await eventIdFor(START, 'd100')
    const b = await eventIdFor(calendarDate('2026-01-02'), 'd100')
    expect(a).not.toBe(b)
  })

  it('does not depend on anything but start date and key', async () => {
    // There is no third parameter by construction. This test documents the
    // constraint so a future signature change has to break it deliberately.
    // NOTE: arity alone is weak evidence — `(a, b) => Date.now()` also has
    // length 2. The golden test below is what actually pins the digest input.
    expect(eventIdFor.length).toBe(2)
  })

  // The golden test. Determinism tests only prove stability WITHIN one run;
  // nothing above would notice if the hash input format changed. Bumping
  // 'daymarker/v1/' to v2, swapping the start/key order, changing the
  // separator, or altering PREFIX/HASH_LENGTH would keep every other test
  // green while silently reassigning the ID of every milestone already in
  // every user's calendar — orphaning the old events and duplicating the set.
  //
  // These values were computed independently from the spec, not read back out
  // of the implementation. If one of them ever fails, do NOT update it to make
  // the suite pass: that failure means the ID derivation changed, and changing
  // it is a migration, not a refactor.
  it('pins the exact ID derivation', async () => {
    expect(await eventIdFor(START, 'd100')).toBe('dmusufolgh698n4mircpsr487stm1q6n')
    expect(await eventIdFor(START, 'y1')).toBe('dm5gk8fe9g3mbped70mkc928ssaksirg')
    expect(await eventIdFor(calendarDate('2025-03-14'), 'd100')).toBe(
      'dm8143fosu8qgh660f7f9c41r9k5882i',
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- eventId`
Expected: FAIL — `Failed to resolve import "@/domain/eventId"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/eventId.ts`:

```ts
import type { CalendarDate } from '@/domain/calendarDate'

/** RFC 4648 base32hex, lowercased: exactly the alphabet Google accepts for event IDs. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuv'

export const ID_PATTERN = /^[0-9a-v]{5,1024}$/

const PREFIX = 'dm'
const HASH_LENGTH = 30

export function base32hex(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      // charAt, not [i]: noUncheckedIndexedAccess would widen ALPHABET[i] to
      // string | undefined and the += would not typecheck.
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31)
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31)
  return out
}

/**
 * The ID depends on the start date and the milestone key ONLY. Never add a
 * parameter for title, label, reminder, range, or language: doing so would turn
 * an edit into a duplicate set of calendar events.
 */
export async function eventIdFor(start: CalendarDate, key: string): Promise<string> {
  const input = new TextEncoder().encode(`daymarker/v1/${start}/${key}`)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return PREFIX + base32hex(new Uint8Array(digest)).slice(0, HASH_LENGTH)
}
```

**Why the accumulator is overflow-safe** — the obvious explanation is wrong, so read this
before "simplifying" it. `value` is never masked after an extraction, so stale already-emitted
bits keep accumulating: over a 32-byte digest it reaches 31 bits, not the ~12 you might expect.
It is nonetheless correct, because JavaScript's `<<` truncates from the *high* end, while the
live unconsumed remainder (`bits ≤ 4`, tracked separately) always sits in the *lowest* bit
positions. After any `<< 8` those live bits land at position ≤ 11, far below the 32-bit
ceiling; only stale bits that have already been emitted get discarded. Masking `value` after
each extraction would also be correct, but is not required.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- eventId`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/eventId.ts src/domain/eventId.test.ts
git commit -m "feat(domain): derive deterministic base32hex event IDs"
```

---

### Task 5: Reminder presets and event payload

Turns a milestone into the exact JSON body Google receives. Two details carry real risk: `end.date` is exclusive, and reminder minutes count backwards from midnight.

**Files:**
- Create: `src/domain/reminders.ts`
- Create: `src/domain/eventPayload.ts`
- Test: `src/domain/eventPayload.test.ts`

**Interfaces:**
- Consumes: `addDays`, `CalendarDate`; `Milestone` from `@/domain/milestones`
- Produces:
  - `type ReminderPreset = 'none' | 'day1' | 'day3' | 'week1'`
  - `REMINDER_MINUTES: Record<ReminderPreset, number | null>`
  - `REMINDER_ORDER: ReminderPreset[]`, `DEFAULT_REMINDER: ReminderPreset`
  - `interface EventOptions { start: CalendarDate; label: string; reminder: ReminderPreset }`
  - `interface GoogleEventPayload` — the request body shape
  - `titleFor(milestone: Milestone, label: string): string`
  - `buildEventPayload(id: string, milestone: Milestone, options: EventOptions): GoogleEventPayload`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/eventPayload.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones } from '@/domain/milestones'
import { buildEventPayload, titleFor, type EventOptions } from '@/domain/eventPayload'
import { REMINDER_MINUTES } from '@/domain/reminders'

const START = calendarDate('2026-01-01')
const [DAY_100] = computeMilestones(START, 1)
const YEAR_1 = computeMilestones(START, 1).find((m) => m.key === 'y1')!

const options: EventOptions = { start: START, label: '', reminder: 'day1' }

describe('titleFor', () => {
  it('uses the bare milestone label when there is no label', () => {
    expect(titleFor(DAY_100!, '')).toBe('Day 100')
    expect(titleFor(YEAR_1, '   ')).toBe('1 Year')
  })

  it('prefixes the label when present', () => {
    expect(titleFor(DAY_100!, 'Anna & Ben')).toBe('Anna & Ben: Day 100')
  })

  it('trims surrounding whitespace from the label', () => {
    expect(titleFor(DAY_100!, '  Us  ')).toBe('Us: Day 100')
  })
})

describe('buildEventPayload', () => {
  it('makes an all-day event whose end date is exclusive', () => {
    const p = buildEventPayload('dmabc12', DAY_100!, options)
    expect(p.start).toEqual({ date: '2026-04-10' })
    expect(p.end).toEqual({ date: '2026-04-11' })
  })

  it('carries the supplied id', () => {
    expect(buildEventPayload('dmabc12', DAY_100!, options).id).toBe('dmabc12')
  })

  it('does not mark the user as busy', () => {
    expect(buildEventPayload('dmabc12', DAY_100!, options).transparency).toBe('transparent')
  })

  it('sets status to confirmed so a PATCH can revive a deleted event', () => {
    expect(buildEventPayload('dmabc12', DAY_100!, options).status).toBe('confirmed')
  })

  it('records the start date in the description', () => {
    expect(buildEventPayload('dmabc12', DAY_100!, options).description).toBe(
      'Day Marker · Started 2026-01-01',
    )
  })

  it('stamps private extended properties for future discovery', () => {
    const p = buildEventPayload('dmabc12', DAY_100!, options)
    expect(p.extendedProperties.private).toEqual({
      dayMarkerVersion: '1',
      startDate: '2026-01-01',
      milestoneKey: 'd100',
    })
  })
})

describe('buildEventPayload — reminders', () => {
  it.each([
    ['day1', 900],
    ['day3', 3780],
    ['week1', 9540],
  ] as const)('maps %s to %i minutes before midnight', (preset, minutes) => {
    const p = buildEventPayload('dmabc12', DAY_100!, { ...options, reminder: preset })
    expect(p.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: 'popup', minutes }],
    })
  })

  it('emits no overrides when the preset is none', () => {
    const p = buildEventPayload('dmabc12', DAY_100!, { ...options, reminder: 'none' })
    expect(p.reminders).toEqual({ useDefault: false, overrides: [] })
  })

  it('keeps every offset inside Google’s 0..40320 range', () => {
    for (const minutes of Object.values(REMINDER_MINUTES)) {
      if (minutes === null) continue
      expect(minutes).toBeGreaterThanOrEqual(0)
      expect(minutes).toBeLessThanOrEqual(40320)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- eventPayload`
Expected: FAIL — `Failed to resolve import "@/domain/eventPayload"`.

- [ ] **Step 3: Write `src/domain/reminders.ts`**

```ts
export type ReminderPreset = 'none' | 'day1' | 'day3' | 'week1'

/**
 * Google counts reminder offsets BACKWARDS from the start of the event, and
 * requires 0..40320. An all-day event starts at midnight, so a same-day 9am
 * reminder would be a negative offset and is not expressible — which is why
 * there is no such preset.
 *   1 day before at 9am  = 15h                       = 900
 *   3 days before at 9am = 3 * 1440 - 540            = 3780
 *   1 week before at 9am = 7 * 1440 - 540            = 9540
 */
export const REMINDER_MINUTES: Record<ReminderPreset, number | null> = {
  none: null,
  day1: 900,
  day3: 3780,
  week1: 9540,
}

// The user-facing labels for these presets live in `ui/copy.ts`, not here.
// `domain/` owns the arithmetic; every English string the user reads belongs in
// one place, and four of them hiding in the domain layer defeats that.

export const REMINDER_ORDER: ReminderPreset[] = ['none', 'day1', 'day3', 'week1']

export const DEFAULT_REMINDER: ReminderPreset = 'day1'
```

- [ ] **Step 4: Write `src/domain/eventPayload.ts`**

```ts
import { addDays, type CalendarDate } from '@/domain/calendarDate'
import type { Milestone } from '@/domain/milestones'
import { REMINDER_MINUTES, type ReminderPreset } from '@/domain/reminders'

export interface EventOptions {
  start: CalendarDate
  label: string
  reminder: ReminderPreset
}

export interface ReminderOverride {
  method: 'popup'
  minutes: number
}

export interface GoogleEventPayload {
  id: string
  summary: string
  description: string
  start: { date: CalendarDate }
  end: { date: CalendarDate }
  transparency: 'transparent'
  status: 'confirmed'
  reminders: { useDefault: false; overrides: ReminderOverride[] }
  extendedProperties: {
    private: { dayMarkerVersion: '1'; startDate: CalendarDate; milestoneKey: string }
  }
}

export function titleFor(milestone: Milestone, label: string): string {
  const trimmed = label.trim()
  return trimmed ? `${trimmed}: ${milestone.label}` : milestone.label
}

export function buildEventPayload(
  id: string,
  milestone: Milestone,
  options: EventOptions,
): GoogleEventPayload {
  const minutes = REMINDER_MINUTES[options.reminder]
  return {
    id,
    summary: titleFor(milestone, options.label),
    description: `Day Marker · Started ${options.start}`,
    start: { date: milestone.date },
    // Exclusive: a one-day all-day event ends the following day.
    end: { date: addDays(milestone.date, 1) },
    // An anniversary should not make the user look busy.
    transparency: 'transparent',
    // Explicit so a PATCH over a cancelled event revives it.
    status: 'confirmed',
    reminders: {
      useDefault: false,
      overrides: minutes === null ? [] : [{ method: 'popup', minutes }],
    },
    extendedProperties: {
      private: {
        dayMarkerVersion: '1',
        startDate: options.start,
        milestoneKey: milestone.key,
      },
    },
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- eventPayload`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/domain/reminders.ts src/domain/eventPayload.ts src/domain/eventPayload.test.ts
git commit -m "feat(domain): build all-day event payloads with reminder presets"
```

---

### Task 6: Concurrency and retry helpers

Two small generic utilities the Google layer depends on. Both take their timing dependencies as parameters so the tests never sleep.

**Files:**
- Create: `src/lib/mapWithLimit.ts`
- Create: `src/lib/backoff.ts`
- Test: `src/lib/mapWithLimit.test.ts`
- Test: `src/lib/backoff.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]>`
  - `interface RetryDeps { attempts: number; baseMs: number; sleep: (ms: number) => Promise<void>; random: () => number }`
  - `DEFAULT_RETRY_DEPS: RetryDeps`
  - `withRetry<T>(fn: () => Promise<T>, shouldRetry: (error: unknown) => boolean, deps?: RetryDeps): Promise<T>`

- [ ] **Step 1: Write the failing test for `mapWithLimit`**

Create `src/lib/mapWithLimit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mapWithLimit } from '@/lib/mapWithLimit'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('mapWithLimit', () => {
  it('preserves input order regardless of completion order', async () => {
    const results = await mapWithLimit([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 10, 20])
  })

  it('passes the index to the callback', async () => {
    const results = await mapWithLimit(['a', 'b'], 2, async (item, i) => `${item}${i}`)
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual(['a0', 'b1'])
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let peak = 0
    await mapWithLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1))
      active -= 1
    })
    expect(peak).toBe(3)
  })

  it('reports a rejection without sinking its neighbours', async () => {
    const results = await mapWithLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(results[1]?.status).toBe('rejected')
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 })
  })

  it('starts a queued item as soon as a slot frees', async () => {
    const first = deferred<number>()
    const started: number[] = []
    const run = mapWithLimit([0, 1], 1, async (i) => {
      started.push(i)
      return i === 0 ? first.promise : i
    })
    await Promise.resolve()
    expect(started).toEqual([0])
    first.resolve(0)
    await run
    expect(started).toEqual([0, 1])
  })

  it('handles an empty list', async () => {
    expect(await mapWithLimit([], 3, async () => 1)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- mapWithLimit`
Expected: FAIL — `Failed to resolve import "@/lib/mapWithLimit"`.

- [ ] **Step 3: Write `src/lib/mapWithLimit.ts`**

```ts
/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving input order
 * and never rejecting: each slot reports its own settled outcome.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index] as T, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const workers = Math.min(Math.max(limit, 1), items.length)
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- mapWithLimit`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `withRetry`**

Create `src/lib/backoff.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { withRetry, type RetryDeps } from '@/lib/backoff'

const deps: RetryDeps = {
  attempts: 3,
  baseMs: 100,
  sleep: async () => {},
  random: () => 0.5,
}

const always = () => true

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const sleep = vi.fn(async () => {})
    const result = await withRetry(async () => 'ok', always, { ...deps, sleep })
    expect(result).toBe('ok')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries a retryable failure and then succeeds', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new Error('transient')
        return 'ok'
      },
      always,
      deps,
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('gives up after the configured attempts and rethrows the last error', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw new Error(`fail ${calls}`)
        },
        always,
        deps,
      ),
    ).rejects.toThrow('fail 3')
    expect(calls).toBe(3)
  })

  it('does not retry when shouldRetry says no', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw new Error('permanent')
        },
        () => false,
        deps,
      ),
    ).rejects.toThrow('permanent')
    expect(calls).toBe(1)
  })

  it('backs off exponentially with jitter', async () => {
    const waits: number[] = []
    const sleep = vi.fn(async (ms: number) => {
      waits.push(ms)
    })
    await expect(
      withRetry(async () => { throw new Error('x') }, always, { ...deps, sleep }),
    ).rejects.toThrow()
    // base * 2^n, each scaled by (0.5 + random()/2) = 0.75 with random() = 0.5
    expect(waits).toEqual([75, 150])
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- backoff`
Expected: FAIL — `Failed to resolve import "@/lib/backoff"`.

- [ ] **Step 7: Write `src/lib/backoff.ts`**

```ts
export interface RetryDeps {
  attempts: number
  baseMs: number
  sleep: (ms: number) => Promise<void>
  random: () => number
}

export const DEFAULT_RETRY_DEPS: RetryDeps = {
  attempts: 3,
  baseMs: 400,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
}

/**
 * Retries `fn` while `shouldRetry` accepts the error, backing off exponentially
 * with jitter. Sleeps only between attempts, never after the final one.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  deps: RetryDeps = DEFAULT_RETRY_DEPS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < deps.attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const isLast = attempt === deps.attempts - 1
      if (isLast || !shouldRetry(error)) throw error
      const jitter = 0.5 + deps.random() / 2
      await deps.sleep(Math.round(deps.baseMs * 2 ** attempt * jitter))
    }
  }
  throw lastError
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- backoff`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/mapWithLimit.ts src/lib/mapWithLimit.test.ts src/lib/backoff.ts src/lib/backoff.test.ts
git commit -m "feat(lib): add bounded-concurrency map and jittered retry"
```

---

### Task 7: Typed errors and the Calendar API client

The only module that speaks HTTP. Status codes are translated into types once, here, so no caller ever branches on a number.

**Files:**
- Create: `src/google/errors.ts`
- Create: `src/google/calendarApi.ts`
- Test: `src/google/calendarApi.test.ts`

**Interfaces:**
- Consumes: `GoogleEventPayload` from `@/domain/eventPayload`
- Produces:
  - Error classes `ApiError`, `Unauthorized`, `RateLimited`, `Conflict`, `NotFound`, `ServerError`
  - `isRetryable(error: unknown): boolean`
  - `interface GoogleEvent { id: string; status: 'confirmed' | 'tentative' | 'cancelled'; summary?: string; reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] } }`
  - `interface CalendarApi { getEvent(id): Promise<GoogleEvent | null>; insertEvent(payload): Promise<GoogleEvent>; patchEvent(id, payload): Promise<GoogleEvent> }`
  - `createCalendarApi(getToken: () => string, fetchImpl?: typeof fetch): CalendarApi`
  - `EVENTS_URL: string`

- [ ] **Step 1: Write the failing tests**

Create `src/google/calendarApi.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createCalendarApi, EVENTS_URL } from '@/google/calendarApi'
import { Conflict, NotFound, RateLimited, ServerError, Unauthorized, isRetryable } from '@/google/errors'
import type { GoogleEventPayload } from '@/domain/eventPayload'
import { calendarDate } from '@/domain/calendarDate'

const payload = {
  id: 'dmabc12',
  summary: 'Day 100',
  description: 'Day Marker · Started 2026-01-01',
  start: { date: calendarDate('2026-04-10') },
  end: { date: calendarDate('2026-04-11') },
  transparency: 'transparent',
  status: 'confirmed',
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 900 }] },
  extendedProperties: {
    private: { dayMarkerVersion: '1', startDate: calendarDate('2026-01-01'), milestoneKey: 'd100' },
  },
} satisfies GoogleEventPayload

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function googleError(code: number, reason: string): unknown {
  return { error: { code, message: reason, errors: [{ domain: 'global', reason }] } }
}

function apiWith(fetchImpl: typeof fetch) {
  return createCalendarApi(() => 'token-123', fetchImpl)
}

describe('getEvent', () => {
  it('sends a bearer token to the primary calendar', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'confirmed', summary: 'Day 100' }),
    ) as unknown as typeof fetch
    await apiWith(fetchImpl).getEvent('dmabc12')
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(`${EVENTS_URL}/dmabc12`)
    expect((init as RequestInit).method).toBe('GET')
    expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe('Bearer token-123')
  })

  it('returns the event when it exists', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'confirmed', summary: 'Day 100' }),
    ) as unknown as typeof fetch
    const event = await apiWith(fetchImpl).getEvent('dmabc12')
    expect(event).toMatchObject({ id: 'dmabc12', status: 'confirmed' })
  })

  it('returns a cancelled event rather than treating it as missing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'cancelled' }),
    ) as unknown as typeof fetch
    expect(await apiWith(fetchImpl).getEvent('dmabc12')).toMatchObject({ status: 'cancelled' })
  })

  it('returns null on 404 instead of throwing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, googleError(404, 'notFound')),
    ) as unknown as typeof fetch
    expect(await apiWith(fetchImpl).getEvent('dmabc12')).toBeNull()
  })
})

describe('error mapping', () => {
  it.each([
    [401, 'authError', Unauthorized],
    [403, 'insufficientPermissions', Unauthorized],
    [403, 'rateLimitExceeded', RateLimited],
    [429, 'rateLimitExceeded', RateLimited],
    [409, 'duplicate', Conflict],
    [500, 'backendError', ServerError],
    [503, 'backendError', ServerError],
  ] as const)('maps %i/%s to the right type', async (status, reason, Expected) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(status, googleError(status, reason)),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).insertEvent(payload)).rejects.toBeInstanceOf(Expected)
  })

  it('surfaces a 404 from insertEvent as NotFound', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, googleError(404, 'notFound')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).patchEvent('dmabc12', payload)).rejects.toBeInstanceOf(NotFound)
  })

  it('keeps the status and Google’s reason on the error', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, googleError(409, 'duplicate')),
    ) as unknown as typeof fetch
    await expect(apiWith(fetchImpl).insertEvent(payload)).rejects.toMatchObject({
      status: 409,
      reason: 'duplicate',
    })
  })
})

describe('isRetryable', () => {
  it('accepts rate limits and server errors', () => {
    expect(isRetryable(new RateLimited(429, 'rateLimitExceeded', ''))).toBe(true)
    expect(isRetryable(new ServerError(503, 'backendError', ''))).toBe(true)
  })

  it('rejects auth, conflict and not-found', () => {
    expect(isRetryable(new Unauthorized(401, 'authError', ''))).toBe(false)
    expect(isRetryable(new Conflict(409, 'duplicate', ''))).toBe(false)
    expect(isRetryable(new NotFound(404, 'notFound', ''))).toBe(false)
  })

  it('accepts a bare network failure', () => {
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true)
  })
})

describe('insertEvent and patchEvent', () => {
  it('POSTs the payload to the collection', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'confirmed' }),
    ) as unknown as typeof fetch
    await apiWith(fetchImpl).insertEvent(payload)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(EVENTS_URL)
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ id: 'dmabc12' })
  })

  it('PATCHes the payload to the item', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'dmabc12', status: 'confirmed' }),
    ) as unknown as typeof fetch
    await apiWith(fetchImpl).patchEvent('dmabc12', payload)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(`${EVENTS_URL}/dmabc12`)
    expect((init as RequestInit).method).toBe('PATCH')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- calendarApi`
Expected: FAIL — `Failed to resolve import "@/google/calendarApi"`.

- [ ] **Step 3: Write `src/google/errors.ts`**

```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`Google Calendar API ${status} (${reason})${detail ? `: ${detail}` : ''}`)
    this.name = new.target.name
  }
}

/** Token missing, expired, revoked, or lacking the required scope. */
export class Unauthorized extends ApiError {}
/** Quota or per-user rate limit. Retryable. */
export class RateLimited extends ApiError {}
/** The event ID already exists on this calendar, including reserved deleted IDs. */
export class Conflict extends ApiError {}
export class NotFound extends ApiError {}
/** 5xx. Retryable. */
export class ServerError extends ApiError {}

export function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimited || error instanceof ServerError) return true
  // fetch rejects with TypeError when the network itself failed.
  return error instanceof TypeError
}
```

- [ ] **Step 4: Write `src/google/calendarApi.ts`**

```ts
import type { GoogleEventPayload } from '@/domain/eventPayload'
import { ApiError, Conflict, NotFound, RateLimited, ServerError, Unauthorized } from '@/google/errors'

export const EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export interface GoogleEvent {
  id: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] }
}

export interface CalendarApi {
  getEvent(id: string): Promise<GoogleEvent | null>
  insertEvent(payload: GoogleEventPayload): Promise<GoogleEvent>
  patchEvent(id: string, payload: GoogleEventPayload): Promise<GoogleEvent>
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string }[] }
}

async function readError(response: Response): Promise<{ reason: string; detail: string }> {
  try {
    const body = (await response.json()) as GoogleErrorBody
    return {
      reason: body.error?.errors?.[0]?.reason ?? 'unknown',
      detail: body.error?.message ?? '',
    }
  } catch {
    return { reason: 'unknown', detail: '' }
  }
}

function toError(status: number, reason: string, detail: string): ApiError {
  if (status === 401) return new Unauthorized(status, reason, detail)
  if (status === 403) {
    // 403 is overloaded: quota problems are retryable, permission problems are not.
    return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
      ? new RateLimited(status, reason, detail)
      : new Unauthorized(status, reason, detail)
  }
  if (status === 404) return new NotFound(status, reason, detail)
  if (status === 409) return new Conflict(status, reason, detail)
  if (status === 429) return new RateLimited(status, reason, detail)
  if (status >= 500) return new ServerError(status, reason, detail)
  return new ApiError(status, reason, detail)
}

export function createCalendarApi(
  getToken: () => string,
  fetchImpl: typeof fetch = fetch,
): CalendarApi {
  async function request(
    url: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
  ): Promise<Response> {
    return fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function unwrap(response: Response): Promise<GoogleEvent> {
    if (response.ok) return (await response.json()) as GoogleEvent
    const { reason, detail } = await readError(response)
    throw toError(response.status, reason, detail)
  }

  return {
    async getEvent(id) {
      const response = await request(`${EVENTS_URL}/${id}`, 'GET')
      // A missing event is an expected answer here, not a failure.
      if (response.status === 404) return null
      return unwrap(response)
    },
    async insertEvent(payload) {
      return unwrap(await request(EVENTS_URL, 'POST', payload))
    },
    async patchEvent(id, payload) {
      return unwrap(await request(`${EVENTS_URL}/${id}`, 'PATCH', payload))
    },
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- calendarApi`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/google/errors.ts src/google/calendarApi.ts src/google/calendarApi.test.ts
git commit -m "feat(google): add typed Calendar API client over fetch"
```

---

### Task 8: Plan — probe the calendar before writing

Turns milestones into a truthful preview by `GET`ting each deterministic ID. This is what lets the UI say "already added" instead of guessing.

**Files:**
- Create: `src/google/plan.ts`
- Test: `src/google/plan.test.ts`

**Interfaces:**
- Consumes: `CalendarApi`, `GoogleEvent` from `@/google/calendarApi`; `eventIdFor`; `Milestone`; `EventOptions`; `titleFor`; `REMINDER_MINUTES`; `mapWithLimit`; `CalendarDate`
- Produces:
  - `type PlanStatus = 'new' | 'exists' | 'deleted'`
  - `interface PlanItem { milestone: Milestone; eventId: string; status: PlanStatus; past: boolean; selected: boolean; needsUpdate: boolean }`
  - `PROBE_CONCURRENCY = 3`
  - `buildPlan(api: CalendarApi, milestones: Milestone[], options: EventOptions, todayDate: CalendarDate): Promise<PlanItem[]>`
  - `existingMinutes(event: GoogleEvent): number | null`

- [ ] **Step 1: Write the failing tests**

Create `src/google/plan.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { buildPlan } from '@/google/plan'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { Unauthorized } from '@/google/errors'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones } from '@/domain/milestones'
import type { EventOptions } from '@/domain/eventPayload'

const START = calendarDate('2026-01-01')
const TODAY = calendarDate('2026-06-01')
const OPTIONS: EventOptions = { start: START, label: '', reminder: 'day1' }

function apiReturning(byId: (id: string) => GoogleEvent | null): CalendarApi {
  return {
    getEvent: vi.fn(async (id: string) => byId(id)),
    insertEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    patchEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
  }
}

describe('buildPlan — classification', () => {
  it('marks a missing event as new', async () => {
    const plan = await buildPlan(apiReturning(() => null), computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan.every((i) => i.status === 'new')).toBe(true)
  })

  it('marks a confirmed event as exists', async () => {
    const api = apiReturning((id) => ({
      id,
      status: 'confirmed',
      summary: 'Day 100',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 900 }] },
    }))
    const plan = await buildPlan(api, computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan[0]?.status).toBe('exists')
  })

  it('marks a cancelled event as deleted', async () => {
    const api = apiReturning((id) => ({ id, status: 'cancelled' }))
    const plan = await buildPlan(api, computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan.every((i) => i.status === 'deleted')).toBe(true)
  })
})

describe('buildPlan — needsUpdate', () => {
  const matching = (id: string): GoogleEvent => ({
    id,
    status: 'confirmed',
    summary: 'Day 100',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 900 }] },
  })

  it('is false when title and reminder already match', async () => {
    const plan = await buildPlan(apiReturning(matching), computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan.find((i) => i.milestone.key === 'd100')?.needsUpdate).toBe(false)
  })

  it('is true when the label changed the title', async () => {
    const plan = await buildPlan(
      apiReturning(matching),
      computeMilestones(START, 1),
      { ...OPTIONS, label: 'Us' },
      TODAY,
    )
    expect(plan.find((i) => i.milestone.key === 'd100')?.needsUpdate).toBe(true)
  })

  it('is true when the reminder preset changed', async () => {
    const plan = await buildPlan(
      apiReturning(matching),
      computeMilestones(START, 1),
      { ...OPTIONS, reminder: 'week1' },
      TODAY,
    )
    expect(plan.find((i) => i.milestone.key === 'd100')?.needsUpdate).toBe(true)
  })

  it('is true when the existing event has no reminder override but one is wanted', async () => {
    const api = apiReturning((id) => ({ id, status: 'confirmed', summary: 'Day 100' }))
    const plan = await buildPlan(api, computeMilestones(START, 1), OPTIONS, TODAY)
    expect(plan.find((i) => i.milestone.key === 'd100')?.needsUpdate).toBe(true)
  })
})

describe('buildPlan — past and selection', () => {
  it('flags milestones before today as past', async () => {
    const plan = await buildPlan(apiReturning(() => null), computeMilestones(START, 1), OPTIONS, TODAY)
    // Day 100 is 2026-04-10 (past); Day 200 is 2026-07-19 (future).
    expect(plan.find((i) => i.milestone.key === 'd100')?.past).toBe(true)
    expect(plan.find((i) => i.milestone.key === 'd200')?.past).toBe(false)
  })

  it('does not treat today itself as past', async () => {
    const onToday = calendarDate('2026-04-10')
    const plan = await buildPlan(apiReturning(() => null), computeMilestones(START, 1), OPTIONS, onToday)
    expect(plan.find((i) => i.milestone.key === 'd100')?.past).toBe(false)
  })

  it('preselects everything except past milestones', async () => {
    const plan = await buildPlan(apiReturning(() => null), computeMilestones(START, 1), OPTIONS, TODAY)
    for (const item of plan) expect(item.selected).toBe(!item.past)
  })

  it('marks nothing as past for a start date in the future', async () => {
    // Planning ahead is legitimate: every milestone is future, so nothing is unchecked.
    const future = calendarDate('2027-01-01')
    const plan = await buildPlan(
      apiReturning(() => null),
      computeMilestones(future, 3),
      { ...OPTIONS, start: future },
      TODAY,
    )
    expect(plan).toHaveLength(13)
    expect(plan.some((i) => i.past)).toBe(false)
    expect(plan.every((i) => i.selected)).toBe(true)
  })
})

describe('buildPlan — mechanics', () => {
  it('probes one distinct event ID per milestone', async () => {
    const api = apiReturning(() => null)
    const milestones = computeMilestones(START, 3)
    const plan = await buildPlan(api, milestones, OPTIONS, TODAY)
    expect(api.getEvent).toHaveBeenCalledTimes(13)
    expect(new Set(plan.map((i) => i.eventId)).size).toBe(13)
  })

  it('keeps milestone order', async () => {
    const milestones = computeMilestones(START, 3)
    const plan = await buildPlan(apiReturning(() => null), milestones, OPTIONS, TODAY)
    expect(plan.map((i) => i.milestone.key)).toEqual(milestones.map((m) => m.key))
  })

  it('propagates an auth failure rather than reporting a bogus plan', async () => {
    const api: CalendarApi = {
      getEvent: vi.fn(async () => {
        throw new Unauthorized(401, 'authError', '')
      }),
      insertEvent: vi.fn(),
      patchEvent: vi.fn(),
    } as unknown as CalendarApi
    await expect(
      buildPlan(api, computeMilestones(START, 1), OPTIONS, TODAY),
    ).rejects.toBeInstanceOf(Unauthorized)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- plan`
Expected: FAIL — `Failed to resolve import "@/google/plan"`.

- [ ] **Step 3: Write `src/google/plan.ts`**

```ts
import type { CalendarDate } from '@/domain/calendarDate'
import { eventIdFor } from '@/domain/eventId'
import { titleFor, type EventOptions } from '@/domain/eventPayload'
import type { Milestone } from '@/domain/milestones'
import { REMINDER_MINUTES } from '@/domain/reminders'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { mapWithLimit } from '@/lib/mapWithLimit'

export type PlanStatus = 'new' | 'exists' | 'deleted'

export interface PlanItem {
  milestone: Milestone
  eventId: string
  status: PlanStatus
  /** The milestone date is before today. Orthogonal to status; only affects selection. */
  past: boolean
  selected: boolean
  /** Only meaningful for status 'exists': the title or reminder drifted. */
  needsUpdate: boolean
}

export const PROBE_CONCURRENCY = 3

export function existingMinutes(event: GoogleEvent): number | null {
  const overrides = event.reminders?.overrides
  if (!overrides || overrides.length === 0) return null
  return overrides[0]?.minutes ?? null
}

export async function buildPlan(
  api: CalendarApi,
  milestones: Milestone[],
  options: EventOptions,
  todayDate: CalendarDate,
): Promise<PlanItem[]> {
  const wantedMinutes = REMINDER_MINUTES[options.reminder]

  const settled = await mapWithLimit(milestones, PROBE_CONCURRENCY, async (milestone) => {
    const eventId = await eventIdFor(options.start, milestone.key)
    const existing = await api.getEvent(eventId)
    const past = milestone.date < todayDate

    if (existing === null) {
      return { milestone, eventId, status: 'new', past, selected: !past, needsUpdate: false }
    }
    if (existing.status === 'cancelled') {
      return { milestone, eventId, status: 'deleted', past, selected: !past, needsUpdate: false }
    }
    const needsUpdate =
      existing.summary !== titleFor(milestone, options.label) ||
      existingMinutes(existing) !== wantedMinutes
    return { milestone, eventId, status: 'exists', past, selected: !past, needsUpdate }
  })

  // A probe failure means we cannot describe the calendar honestly, so surface it.
  const failure = settled.find((r) => r.status === 'rejected')
  if (failure && failure.status === 'rejected') throw failure.reason

  return settled.map((r) => (r as PromiseFulfilledResult<PlanItem>).value)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- plan`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/google/plan.ts src/google/plan.test.ts
git commit -m "feat(google): probe deterministic IDs to build a truthful plan"
```

---

### Task 9: Apply — execute the plan

Writes the selected items, three at a time, reporting each as it lands. Handles the `409`-after-`404` case and halts cleanly when the token dies mid-run.

**Files:**
- Create: `src/google/apply.ts`
- Test: `src/google/apply.test.ts`

**Interfaces:**
- Consumes: `CalendarApi`, `Conflict`, `Unauthorized`, `isRetryable`, `PlanItem`, `buildEventPayload`, `EventOptions`, `mapWithLimit`, `withRetry`, `RetryDeps`
- Produces:
  - `type ItemOutcome = 'added' | 'updated' | 'restored' | 'skipped' | 'failed'`
  - `interface ItemResult { item: PlanItem; outcome: ItemOutcome; error?: string }`
  - `APPLY_CONCURRENCY = 3`
  - `HALTED_MESSAGE: string`
  - `applyPlan(api: CalendarApi, items: PlanItem[], options: EventOptions, onProgress: (r: ItemResult) => void, retryDeps?: RetryDeps, concurrency?: number): Promise<ItemResult[]>` — the trailing `concurrency` exists so tests can force serial execution and assert ordering

- [ ] **Step 1: Write the failing tests**

Create `src/google/apply.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { applyPlan, HALTED_MESSAGE, type ItemResult } from '@/google/apply'
import type { CalendarApi } from '@/google/calendarApi'
import { Conflict, RateLimited, Unauthorized } from '@/google/errors'
import type { PlanItem, PlanStatus } from '@/google/plan'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones } from '@/domain/milestones'
import type { EventOptions } from '@/domain/eventPayload'
import type { RetryDeps } from '@/lib/backoff'

const START = calendarDate('2026-01-01')
const OPTIONS: EventOptions = { start: START, label: '', reminder: 'day1' }

const RETRY: RetryDeps = { attempts: 3, baseMs: 1, sleep: async () => {}, random: () => 0.5 }

// Thirteen milestones, so a test can use more items than APPLY_CONCURRENCY (3).
// The halt can only short-circuit items still QUEUED, so a 3-item test would
// leave nothing queued and could never observe it.
const MILESTONES = computeMilestones(START, 3)

function item(index: number, status: PlanStatus, needsUpdate = false): PlanItem {
  return {
    milestone: MILESTONES[index]!,
    eventId: `dmtest${index}`,
    status,
    past: false,
    selected: true,
    needsUpdate,
  }
}

function stubApi(overrides: Partial<CalendarApi> = {}): CalendarApi {
  return {
    getEvent: vi.fn(async () => null),
    insertEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    patchEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    ...overrides,
  }
}

describe('applyPlan — outcomes', () => {
  it('inserts a new item and reports "added"', async () => {
    const api = stubApi()
    const [result] = await applyPlan(api, [item(0, 'new')], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('added')
    expect(api.insertEvent).toHaveBeenCalledTimes(1)
  })

  it('patches a deleted item and reports "restored"', async () => {
    const api = stubApi()
    const [result] = await applyPlan(api, [item(0, 'deleted')], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('restored')
    expect(api.patchEvent).toHaveBeenCalledTimes(1)
  })

  it('patches a drifted existing item and reports "updated"', async () => {
    const api = stubApi()
    const [result] = await applyPlan(api, [item(0, 'exists', true)], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('updated')
    expect(api.patchEvent).toHaveBeenCalledTimes(1)
  })

  it('skips an unchanged existing item without any write', async () => {
    const api = stubApi()
    const [result] = await applyPlan(api, [item(0, 'exists', false)], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('skipped')
    expect(api.patchEvent).not.toHaveBeenCalled()
    expect(api.insertEvent).not.toHaveBeenCalled()
  })

  it('sends the payload built from the milestone and options', async () => {
    const insertEvent = vi.fn(async () => ({ id: 'x', status: 'confirmed' as const }))
    await applyPlan(stubApi({ insertEvent }), [item(0, 'new')], { ...OPTIONS, label: 'Us' }, () => {}, RETRY)
    expect(insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dmtest0', summary: 'Us: Day 100' }),
    )
  })
})

describe('applyPlan — 409 fallback', () => {
  it('falls back to PATCH when a "new" insert hits a reserved ID', async () => {
    const insertEvent = vi.fn(async () => {
      throw new Conflict(409, 'duplicate', '')
    })
    const patchEvent = vi.fn(async () => ({ id: 'x', status: 'confirmed' as const }))
    const [result] = await applyPlan(
      stubApi({ insertEvent, patchEvent }),
      [item(0, 'new')],
      OPTIONS,
      () => {},
      RETRY,
    )
    expect(result?.outcome).toBe('updated')
    expect(patchEvent).toHaveBeenCalledTimes(1)
  })

  it('fails the item honestly when the fallback PATCH also fails', async () => {
    const insertEvent = vi.fn(async () => {
      throw new Conflict(409, 'duplicate', '')
    })
    const patchEvent = vi.fn(async () => {
      throw new Conflict(409, 'duplicate', 'cannot reuse id')
    })
    const [result] = await applyPlan(
      stubApi({ insertEvent, patchEvent }),
      [item(0, 'new')],
      OPTIONS,
      () => {},
      RETRY,
    )
    expect(result?.outcome).toBe('failed')
    expect(result?.error).toContain('409')
  })
})

describe('applyPlan — retry', () => {
  it('retries a rate limit and then succeeds', async () => {
    let calls = 0
    const insertEvent = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new RateLimited(429, 'rateLimitExceeded', '')
      return { id: 'x', status: 'confirmed' as const }
    })
    const [result] = await applyPlan(stubApi({ insertEvent }), [item(0, 'new')], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('added')
    expect(calls).toBe(3)
  })

  it('fails the item after the attempts run out', async () => {
    const insertEvent = vi.fn(async () => {
      throw new RateLimited(429, 'rateLimitExceeded', '')
    })
    const [result] = await applyPlan(stubApi({ insertEvent }), [item(0, 'new')], OPTIONS, () => {}, RETRY)
    expect(result?.outcome).toBe('failed')
    expect(insertEvent).toHaveBeenCalledTimes(3)
  })
})

describe('applyPlan — halting on auth loss', () => {
  it('stops writing after a 401 and marks the rest failed', async () => {
    const insertEvent = vi.fn(async () => {
      throw new Unauthorized(401, 'authError', '')
    })
    // FIVE items against APPLY_CONCURRENCY of 3. The halt can only short-circuit
    // items still QUEUED: the first three are already in flight when the 401
    // lands, so they fail with the real error, and items 4 and 5 are the ones the
    // halt actually protects. A 3-item version of this test asserts something
    // structurally impossible — nothing is ever queued, so HALTED_MESSAGE can
    // never appear.
    const items = [item(0, 'new'), item(1, 'new'), item(2, 'new'), item(3, 'new'), item(4, 'new')]
    const results = await applyPlan(stubApi({ insertEvent }), items, OPTIONS, () => {}, RETRY)
    expect(results).toHaveLength(5)
    expect(results.every((r) => r.outcome === 'failed')).toBe(true)
    expect(results.filter((r) => r.error === HALTED_MESSAGE)).toHaveLength(2)
    // The point of halting: two doomed requests were never sent.
    expect(insertEvent).toHaveBeenCalledTimes(3)
  })

  it('keeps results that already succeeded', async () => {
    let calls = 0
    const insertEvent = vi.fn(async () => {
      calls += 1
      if (calls > 1) throw new Unauthorized(401, 'authError', '')
      return { id: 'x', status: 'confirmed' as const }
    })
    const items = [item(0, 'new'), item(1, 'new'), item(2, 'new')]
    // Concurrency 1 keeps the ordering deterministic for this assertion.
    const results = await applyPlan(stubApi({ insertEvent }), items, OPTIONS, () => {}, RETRY, 1)
    expect(results[0]?.outcome).toBe('added')
    expect(results.slice(1).every((r) => r.outcome === 'failed')).toBe(true)
  })
})

describe('applyPlan — progress', () => {
  it('reports every item exactly once, as it lands', async () => {
    const seen: ItemResult[] = []
    const items = [item(0, 'new'), item(1, 'new'), item(2, 'new')]
    const results = await applyPlan(stubApi(), items, OPTIONS, (r) => seen.push(r), RETRY)
    expect(seen).toHaveLength(3)
    expect(seen.map((r) => r.item.eventId).sort()).toEqual(results.map((r) => r.item.eventId).sort())
  })

  it('returns results in input order', async () => {
    const items = [item(0, 'new'), item(1, 'new'), item(2, 'new')]
    const results = await applyPlan(stubApi(), items, OPTIONS, () => {}, RETRY)
    expect(results.map((r) => r.item.eventId)).toEqual(['dmtest0', 'dmtest1', 'dmtest2'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- apply`
Expected: FAIL — `Failed to resolve import "@/google/apply"`.

- [ ] **Step 3: Write `src/google/apply.ts`**

```ts
import { buildEventPayload, type EventOptions } from '@/domain/eventPayload'
import type { CalendarApi } from '@/google/calendarApi'
import { Conflict, Unauthorized, isRetryable } from '@/google/errors'
import type { PlanItem } from '@/google/plan'
import { DEFAULT_RETRY_DEPS, withRetry, type RetryDeps } from '@/lib/backoff'
import { mapWithLimit } from '@/lib/mapWithLimit'

export type ItemOutcome = 'added' | 'updated' | 'restored' | 'skipped' | 'failed'

export interface ItemResult {
  item: PlanItem
  outcome: ItemOutcome
  error?: string
}

export const APPLY_CONCURRENCY = 3

export const HALTED_MESSAGE = 'Stopped after the Google connection expired'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function applyOne(
  api: CalendarApi,
  item: PlanItem,
  options: EventOptions,
): Promise<ItemOutcome> {
  const payload = buildEventPayload(item.eventId, item.milestone, options)

  if (item.status === 'deleted') {
    // A PATCH with status 'confirmed' revives a cancelled event.
    await api.patchEvent(item.eventId, payload)
    return 'restored'
  }

  if (item.status === 'exists') {
    if (!item.needsUpdate) return 'skipped'
    await api.patchEvent(item.eventId, payload)
    return 'updated'
  }

  try {
    await api.insertEvent(payload)
    return 'added'
  } catch (error) {
    // Google reserves the IDs of deleted events, so a 404 at probe time can
    // still be a 409 here. Treat it as the update it actually is.
    if (error instanceof Conflict) {
      await api.patchEvent(item.eventId, payload)
      return 'updated'
    }
    throw error
  }
}

export async function applyPlan(
  api: CalendarApi,
  items: PlanItem[],
  options: EventOptions,
  onProgress: (result: ItemResult) => void,
  retryDeps: RetryDeps = DEFAULT_RETRY_DEPS,
  concurrency: number = APPLY_CONCURRENCY,
): Promise<ItemResult[]> {
  let halted = false

  const settled = await mapWithLimit(items, concurrency, async (item) => {
    if (halted) {
      const result: ItemResult = { item, outcome: 'failed', error: HALTED_MESSAGE }
      onProgress(result)
      return result
    }
    try {
      const outcome = await withRetry(() => applyOne(api, item, options), isRetryable, retryDeps)
      const result: ItemResult = { item, outcome }
      onProgress(result)
      return result
    } catch (error) {
      // Losing the token invalidates every remaining write, so stop scheduling.
      if (error instanceof Unauthorized) halted = true
      const result: ItemResult = { item, outcome: 'failed', error: describe(error) }
      onProgress(result)
      return result
    }
  })

  return settled.map((r) => (r as PromiseFulfilledResult<ItemResult>).value)
}
```

`applyOne` is wrapped so it never rejects out of the worker, which is why every settled entry is fulfilled.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- apply`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/google/apply.ts src/google/apply.test.ts
git commit -m "feat(google): apply plans with 409 fallback and auth halting"
```

---

### Task 10: Google Identity Services wrapper

Wraps the browser token client. The one hard rule: `requestAccessToken()` runs synchronously inside the click handler, or the popup is blocked.

**Files:**
- Create: `src/google/auth.ts`
- Test: `src/google/auth.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'`
  - `MISSING_CLIENT_ID = 'missing_client_id'` — sentinel `AuthError` message for an unset
    `VITE_GOOGLE_CLIENT_ID`; `useDayMarker` maps it to `COPY.missingClientId` so the copy
    stays in `ui/` and `google/` never imports from `ui/`
  - `class AuthError extends Error`
  - `interface Auth { connect(prompt?: GisPrompt): Promise<string>; token(): string | null; clear(): void }`
  - `SIGN_IN_IN_PROGRESS = 'sign_in_in_progress'` — sentinel rejecting a second `connect()`
    while one is still pending, so the first caller's promise is never stranded
  - `SIGN_IN_CANCELLED = 'sign_in_cancelled'` — sentinel `clear()` rejects a pending call with,
    rather than dropping it and stranding the caller. `useDayMarker` swallows both sentinels.
  - `type GisPrompt = '' | 'consent' | 'select_account'`
  - `createAuth(clientId: string, getGis?: () => GoogleIdentity | undefined, now?: () => number): Auth`
  - `whenGisReady(timeoutMs?: number, getGis?, sleep?): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `src/google/auth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  AuthError,
  CALENDAR_SCOPE,
  createAuth,
  MISSING_CLIENT_ID,
  SIGN_IN_CANCELLED,
  SIGN_IN_IN_PROGRESS,
  whenGisReady,
  type GoogleIdentity,
} from '@/google/auth'

interface Harness {
  gis: GoogleIdentity
  fire: (response: unknown) => void
  fireError: (error: unknown) => void
  requestAccessToken: ReturnType<typeof vi.fn>
  grantedScopes: string[]
}

function harness(): Harness {
  let callback: (r: unknown) => void = () => {}
  let errorCallback: (e: unknown) => void = () => {}
  const requestAccessToken = vi.fn()
  const state: Harness = {
    requestAccessToken,
    grantedScopes: [CALENDAR_SCOPE],
    fire: (response) => callback(response),
    fireError: (error) => errorCallback(error),
    gis: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            callback: (r: unknown) => void
            error_callback?: (e: unknown) => void
          }) => {
            callback = config.callback
            errorCallback = config.error_callback ?? (() => {})
            return { requestAccessToken }
          },
          hasGrantedAllScopes: (_r: unknown, ...scopes: string[]) =>
            scopes.every((s) => state.grantedScopes.includes(s)),
        },
      },
    } as unknown as GoogleIdentity,
  }
  return state
}

describe('createAuth.connect', () => {
  it('requests a token synchronously so the popup is not blocked', () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    void auth.connect()
    // No await before this assertion: the call must already have happened.
    expect(h.requestAccessToken).toHaveBeenCalledTimes(1)
  })

  it('resolves with the access token', async () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    expect(await pending).toBe('tok')
  })

  it('rejects when the calendar scope was not granted', async () => {
    const h = harness()
    h.grantedScopes = []
    const auth = createAuth('client-1', () => h.gis)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: '' })
    await expect(pending).rejects.toBeInstanceOf(AuthError)
  })

  it('rejects when Google reports an error', async () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const pending = auth.connect()
    h.fireError({ type: 'popup_closed' })
    await expect(pending).rejects.toBeInstanceOf(AuthError)
  })

  it('rejects when the GIS script has not loaded', async () => {
    const auth = createAuth('client-1', () => undefined)
    await expect(auth.connect()).rejects.toBeInstanceOf(AuthError)
  })

  it('rejects with the sentinel when the client ID is empty', async () => {
    // A first run without .env.local. Without this, Google returns an opaque
    // error and the developer has no idea the client ID is the problem.
    const h = harness()
    const auth = createAuth('', () => h.gis)
    await expect(auth.connect()).rejects.toThrow(MISSING_CLIENT_ID)
    expect(h.requestAccessToken).not.toHaveBeenCalled()
  })

  it('refuses a second call while one is still pending, and opens no second popup', async () => {
    // A double-click on the connect button. Without the guard the second call
    // would overwrite the only reference to the first call's resolver, and the
    // first promise would hang forever — never resolving, never rejecting.
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const first = auth.connect()
    await expect(auth.connect()).rejects.toThrow(SIGN_IN_IN_PROGRESS)
    expect(h.requestAccessToken).toHaveBeenCalledTimes(1)
    // The first call is still live and still settles normally.
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    expect(await first).toBe('tok')
  })

  it('accepts a new call once the previous one has settled', async () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const first = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    await first
    const second = auth.connect()
    h.fire({ access_token: 'tok2', expires_in: 3600, scope: CALENDAR_SCOPE })
    expect(await second).toBe('tok2')
    expect(h.requestAccessToken).toHaveBeenCalledTimes(2)
  })

  it('clear() releases a pending slot that never got a callback', async () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const abandoned = auth.connect() // never fired — simulates GIS going silent
    auth.clear()
    // Rejected, not dropped: dropping would strand this promise forever, which
    // is the same defect the re-entrancy guard exists to prevent.
    await expect(abandoned).rejects.toThrow(SIGN_IN_CANCELLED)
    // And not bricked: a later attempt proceeds instead of rejecting forever.
    const retry = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    expect(await retry).toBe('tok')
  })

  it('clear() rejects a genuinely in-flight call rather than stranding it', async () => {
    // The narrower hazard: clear() racing a live popup, not a silent one. A late
    // GIS callback then finds an empty slot and returns without settling, so the
    // caller would hang if clear() had merely nulled the slot.
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const inFlight = auth.connect()
    auth.clear()
    await expect(inFlight).rejects.toThrow(SIGN_IN_CANCELLED)
    // A callback arriving after the clear is ignored and must not throw.
    expect(() =>
      h.fire({ access_token: 'late', expires_in: 3600, scope: CALENDAR_SCOPE }),
    ).not.toThrow()
    expect(auth.token()).toBeNull()
  })

  it('passes the prompt through to Google', () => {
    const h = harness()
    createAuth('client-1', () => h.gis).connect('select_account')
    expect(h.requestAccessToken).toHaveBeenCalledWith({ prompt: 'select_account' })
  })
})

describe('whenGisReady', () => {
  // This is the real default for App's readiness check, but every App test
  // injects a stub, so without these tests it ships completely unexercised.

  it('returns true immediately when the script is already there', async () => {
    const sleep = vi.fn(async () => {})
    const ready = await whenGisReady(1000, () => ({}) as GoogleIdentity, sleep)
    expect(ready).toBe(true)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('polls until the script appears', async () => {
    let polls = 0
    const getGis = () => (++polls >= 3 ? ({} as GoogleIdentity) : undefined)
    const sleep = vi.fn(async () => {})
    expect(await whenGisReady(10_000, getGis, sleep)).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('returns false once the deadline passes', async () => {
    // timeoutMs of 0 means the deadline is already reached on the first check.
    const sleep = vi.fn(async () => {})
    expect(await whenGisReady(0, () => undefined, sleep)).toBe(false)
    expect(sleep).not.toHaveBeenCalled()
  })

})

describe('createAuth.token', () => {
  it('is null before connecting', () => {
    expect(createAuth('client-1', () => harness().gis).token()).toBeNull()
  })

  it('returns the token while it is valid', async () => {
    const h = harness()
    let clock = 1_000_000
    const auth = createAuth('client-1', () => h.gis, () => clock)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    await pending
    clock += 60_000
    expect(auth.token()).toBe('tok')
  })

  it('returns null once the token has expired', async () => {
    const h = harness()
    let clock = 1_000_000
    const auth = createAuth('client-1', () => h.gis, () => clock)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    await pending
    clock += 3_600_000
    expect(auth.token()).toBeNull()
  })

  it('clear() forgets the token', async () => {
    const h = harness()
    const auth = createAuth('client-1', () => h.gis)
    const pending = auth.connect()
    h.fire({ access_token: 'tok', expires_in: 3600, scope: CALENDAR_SCOPE })
    await pending
    auth.clear()
    expect(auth.token()).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- auth`
Expected: FAIL — `Failed to resolve import "@/google/auth"`.

- [ ] **Step 3: Write `src/google/auth.ts`**

```ts
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

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
      scope: CALENDAR_SCOPE,
      callback: (response) => {
        const pending = settle
        settle = null
        if (!pending) return
        if (!response.access_token) {
          pending.reject(new AuthError(response.error ?? 'Google returned no access token'))
          return
        }
        if (!gis.accounts.oauth2.hasGrantedAllScopes(response, CALENDAR_SCOPE)) {
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- auth`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/google/auth.ts src/google/auth.test.ts
git commit -m "feat(google): wrap the GIS browser token client"
```

---

### Task 11: Copy and the phase state machine

Every user-facing string in one file, and the hook that owns the whole flow. The components in Tasks 12–13 stay presentational.

**Files:**
- Create: `src/ui/copy.ts`
- Create: `src/ui/useDayMarker.ts`
- Test: `src/ui/copy.test.ts`
- Test: `src/ui/useDayMarker.test.tsx`

**Interfaces:**
- Consumes: `Auth`; `CalendarApi`; `buildPlan`, `PlanItem`; `applyPlan`, `ItemResult`, `ItemOutcome`; `computeMilestones`, `DEFAULT_YEARS`; `isCalendarDate`, `CalendarDate`, `today`; `DEFAULT_REMINDER`, `ReminderPreset`; `RetryDeps`
- Produces:
  - `COPY` — all strings
  - `interface PlanCounts { add: number; update: number; restore: number; selected: number }`
  - `countPlan(items: PlanItem[]): PlanCounts`
  - `actionLabel(counts: PlanCounts): string`
  - `outcomeLabel(outcome: ItemOutcome): string`
  - `statusLabel(item: PlanItem): string` — returns `COPY.statusPast` for past items, otherwise the status label
  - `type Phase = 'idle' | 'probing' | 'ready' | 'applying' | 'done'`
  - `interface DayMarkerDeps { auth: Auth; api: CalendarApi; todayDate?: CalendarDate; probeDelayMs?: number; retryDeps?: RetryDeps }`
  - `useDayMarker(deps: DayMarkerDeps)` returning `{ phase, startDate, label, years, reminder, milestones, plan, results, connected, error, counts, failedCount, setStartDate, setLabel, setYears, setReminder, toggle, connect, submit, retryFailed, reset }`

- [ ] **Step 1: Write the failing test for `copy.ts`**

Create `src/ui/copy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { actionLabel, countPlan, COPY, outcomeLabel } from '@/ui/copy'
import { REMINDER_ORDER } from '@/domain/reminders'
import type { PlanItem, PlanStatus } from '@/google/plan'
import { computeMilestones } from '@/domain/milestones'
import { calendarDate } from '@/domain/calendarDate'

const MILESTONES = computeMilestones(calendarDate('2026-01-01'), 10)

function item(i: number, status: PlanStatus, selected = true, needsUpdate = false): PlanItem {
  return { milestone: MILESTONES[i]!, eventId: `dm${i}`, status, past: false, selected, needsUpdate }
}

describe('countPlan', () => {
  it('counts only selected items', () => {
    const counts = countPlan([item(0, 'new'), item(1, 'new', false)])
    expect(counts).toEqual({ add: 1, update: 0, restore: 0, selected: 1 })
  })

  it('separates adds, updates and restores', () => {
    const counts = countPlan([
      item(0, 'new'),
      item(1, 'exists', true, true),
      item(2, 'deleted'),
      item(3, 'exists', true, false),
    ])
    expect(counts).toEqual({ add: 1, update: 1, restore: 1, selected: 4 })
  })
})

describe('actionLabel', () => {
  it('lists only the non-zero parts', () => {
    expect(actionLabel({ add: 8, update: 3, restore: 0, selected: 11 })).toBe('Add 8 · Update 3')
  })

  it('includes restores', () => {
    expect(actionLabel({ add: 1, update: 0, restore: 2, selected: 3 })).toBe('Add 1 · Restore 2')
  })

  it('falls back when there is no work', () => {
    expect(actionLabel({ add: 0, update: 0, restore: 0, selected: 0 })).toBe(COPY.nothingToDo)
  })

  it('says so when everything selected is already up to date', () => {
    expect(actionLabel({ add: 0, update: 0, restore: 0, selected: 4 })).toBe(COPY.alreadyUpToDate)
  })
})

describe('COPY.reminderLabels', () => {
  it('names every preset in REMINDER_ORDER', () => {
    // These four strings previously lived in domain/reminders.ts with no test
    // anywhere. A preset added without its label would render as blank text.
    for (const preset of REMINDER_ORDER) {
      expect(COPY.reminderLabels[preset]).toBeTruthy()
    }
    expect(Object.keys(COPY.reminderLabels).sort()).toEqual([...REMINDER_ORDER].sort())
  })
})

describe('outcomeLabel', () => {
  it.each([
    ['added', 'Added'],
    ['updated', 'Updated'],
    ['restored', 'Restored'],
    ['skipped', 'Unchanged'],
    ['failed', 'Failed'],
  ] as const)('labels %s', (outcome, expected) => {
    expect(outcomeLabel(outcome)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- copy`
Expected: FAIL — `Failed to resolve import "@/ui/copy"`.

- [ ] **Step 3: Write `src/ui/copy.ts`**

```ts
import type { ReminderPreset } from '@/domain/reminders'
import type { ItemOutcome } from '@/google/apply'
import type { PlanItem, PlanStatus } from '@/google/plan'

export const COPY = {
  appName: 'Day Marker',
  tagline: 'Put your milestones on the calendar.',

  notConnected: 'Not connected',
  connected: 'Connected',
  connect: 'Connect Google account',

  startDate: 'Start date',
  labelField: 'Label — optional',
  labelPlaceholder: 'Anna & Ben',
  range: 'Range',
  reminder: 'Reminder',
  yearsOption: (n: number) => (n === 1 ? '1 year' : `${n} years`),
  // Every string the user reads lives here, including these — `domain/reminders.ts`
  // owns the minute arithmetic, not the wording.
  reminderLabels: {
    none: 'No reminder',
    day1: '1 day before, 9:00 AM',
    day3: '3 days before, 9:00 AM',
    week1: '1 week before, 9:00 AM',
  } satisfies Record<ReminderPreset, string>,

  pickADate: 'Pick a start date to see your milestones.',
  milestoneCount: (n: number) => (n === 1 ? '1 milestone' : `${n} milestones`),
  selectedCount: (n: number) => `${n} selected`,
  probing: 'Checking your calendar…',

  statusNew: 'New',
  statusExists: 'Already added',
  statusDeleted: 'Deleted',
  statusPast: 'Past',
  statusUnknown: '—',

  nothingToDo: 'Nothing to add',
  alreadyUpToDate: 'Everything is already up to date',
  applying: 'Working…',
  progress: (done: number, total: number) => `${done} of ${total}`,
  queued: 'Queued',

  doneHeadline: (n: number) => (n === 1 ? '1 milestone' : `${n} milestones`),
  doneSubhead: 'added to your calendar',
  andMore: (n: number) => `and ${n} more…`,
  viewInCalendar: 'View in Calendar ↗',
  startOver: 'Start over',

  partialHeadline: (ok: number, failed: number) => `${ok} added · ${failed} failed`,
  retryFailed: (n: number) => `Reconnect and finish the remaining ${n}`,

  scriptBlocked:
    'Google sign-in could not load. Check your network or any blocker, then reload.',
  popupBlocked: 'Your browser blocked the Google window. Allow popups for this site and try again.',
  missingClientId:
    'VITE_GOOGLE_CLIENT_ID is not set. Copy .env.local.example to .env.local and add your client ID.',
} as const

export interface PlanCounts {
  add: number
  update: number
  restore: number
  selected: number
}

export function countPlan(items: PlanItem[]): PlanCounts {
  const counts: PlanCounts = { add: 0, update: 0, restore: 0, selected: 0 }
  for (const item of items) {
    if (!item.selected) continue
    counts.selected += 1
    if (item.status === 'new') counts.add += 1
    else if (item.status === 'deleted') counts.restore += 1
    else if (item.needsUpdate) counts.update += 1
  }
  return counts
}

export function actionLabel(counts: PlanCounts): string {
  const parts: string[] = []
  if (counts.add > 0) parts.push(`Add ${counts.add}`)
  if (counts.update > 0) parts.push(`Update ${counts.update}`)
  if (counts.restore > 0) parts.push(`Restore ${counts.restore}`)
  if (parts.length > 0) return parts.join(' · ')
  return counts.selected > 0 ? COPY.alreadyUpToDate : COPY.nothingToDo
}

const OUTCOME_LABELS: Record<ItemOutcome, string> = {
  added: 'Added',
  updated: 'Updated',
  restored: 'Restored',
  skipped: 'Unchanged',
  failed: 'Failed',
}

export function outcomeLabel(outcome: ItemOutcome): string {
  return OUTCOME_LABELS[outcome]
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  new: COPY.statusNew,
  exists: COPY.statusExists,
  deleted: COPY.statusDeleted,
}

export function statusLabel(item: PlanItem): string {
  return item.past ? COPY.statusPast : STATUS_LABELS[item.status]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- copy`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the hook**

Create `src/ui/useDayMarker.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDayMarker, type DayMarkerDeps } from '@/ui/useDayMarker'
import { COPY } from '@/ui/copy'
import { MISSING_CLIENT_ID, type Auth } from '@/google/auth'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { Unauthorized } from '@/google/errors'
import { calendarDate } from '@/domain/calendarDate'
import type { RetryDeps } from '@/lib/backoff'

const TODAY = calendarDate('2026-06-01')
const RETRY: RetryDeps = { attempts: 1, baseMs: 1, sleep: async () => {}, random: () => 0.5 }

function stubAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => 'tok'),
    clear: vi.fn(),
    ...overrides,
  }
}

function stubApi(getEvent: (id: string) => GoogleEvent | null = () => null): CalendarApi {
  return {
    getEvent: vi.fn(async (id: string) => getEvent(id)),
    insertEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    patchEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
  }
}

function deps(overrides: Partial<DayMarkerDeps> = {}): DayMarkerDeps {
  return {
    auth: stubAuth(),
    api: stubApi(),
    todayDate: TODAY,
    probeDelayMs: 0,
    retryDeps: RETRY,
    ...overrides,
  }
}

describe('useDayMarker — local computation', () => {
  it('starts idle with no milestones', () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    expect(result.current.phase).toBe('idle')
    expect(result.current.milestones).toEqual([])
  })

  it('computes milestones without connecting', () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01-01'))
    expect(result.current.milestones).toHaveLength(13)
    expect(result.current.connected).toBe(false)
  })

  it('clears milestones for an incomplete date', () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01'))
    expect(result.current.milestones).toEqual([])
  })

  it('recomputes when the range changes', () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01-01'))
    act(() => result.current.setYears(1))
    expect(result.current.milestones).toHaveLength(4)
  })
})

describe('useDayMarker — connecting and probing', () => {
  it('probes after connecting and reaches ready', async () => {
    const api = stubApi()
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(api.getEvent).toHaveBeenCalledTimes(13)
    expect(result.current.plan).toHaveLength(13)
  })

  it('preselects future milestones and leaves past ones off', async () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    const day100 = result.current.plan.find((i) => i.milestone.key === 'd100')
    expect(day100?.past).toBe(true)
    expect(day100?.selected).toBe(false)
  })

  it('surfaces a connect failure as an error and stays idle', async () => {
    const auth = stubAuth({
      connect: vi.fn(async () => {
        throw new Error('popup_closed')
      }),
    })
    const { result } = renderHook(() => useDayMarker(deps({ auth })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.error).toContain('popup_closed')
    expect(result.current.phase).toBe('idle')
  })

  it('translates a blocked popup into an actionable message', async () => {
    const auth = stubAuth({
      connect: vi.fn(async () => {
        throw new Error('popup_failed_to_open')
      }),
    })
    const { result } = renderHook(() => useDayMarker(deps({ auth })))
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.error).toBe(COPY.popupBlocked)
  })

  it('translates a missing client ID into setup instructions', async () => {
    const auth = stubAuth({
      connect: vi.fn(async () => {
        throw new Error(MISSING_CLIENT_ID)
      }),
    })
    const { result } = renderHook(() => useDayMarker(deps({ auth })))
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.error).toBe(COPY.missingClientId)
  })

  it('re-probes when the reminder changes', async () => {
    const api = stubApi()
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    act(() => result.current.setReminder('week1'))
    await waitFor(() => expect(api.getEvent).toHaveBeenCalledTimes(26))
  })
})

describe('useDayMarker — selection and counts', () => {
  it('toggles an item and updates the counts', async () => {
    const { result } = renderHook(() => useDayMarker(deps()))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    const before = result.current.counts.add
    act(() => result.current.toggle('d300'))
    expect(result.current.counts.add).toBe(before - 1)
  })
})

describe('useDayMarker — submitting', () => {
  it('writes only the selected items and finishes done', async () => {
    const api = stubApi()
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    const selected = result.current.counts.selected
    await act(async () => {
      await result.current.submit()
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.results).toHaveLength(selected)
    expect(api.insertEvent).toHaveBeenCalledTimes(selected)
  })

  it('reports failures and exposes a failed count', async () => {
    const api = stubApi()
    ;(api.insertEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Unauthorized(401, 'authError', ''),
    )
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await act(async () => {
      await result.current.submit()
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.failedCount).toBeGreaterThan(0)
  })

  it('reset() re-probes rather than returning to a stale plan', async () => {
    const api = stubApi()
    const { result } = renderHook(() => useDayMarker(deps({ api })))
    act(() => result.current.setStartDate('2026-01-01'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await act(async () => {
      await result.current.submit()
    })
    const probesBeforeReset = (api.getEvent as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => result.current.reset())
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.results).toEqual([])
    // The plan in hand was stale after the write — every milestone must be
    // re-read, not reused.
    expect((api.getEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      probesBeforeReset + 13,
    )
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- useDayMarker`
Expected: FAIL — `Failed to resolve import "@/ui/useDayMarker"`.

- [ ] **Step 7: Write `src/ui/useDayMarker.ts`**

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isCalendarDate, today as todayFn, type CalendarDate } from '@/domain/calendarDate'
import type { EventOptions } from '@/domain/eventPayload'
import { computeMilestones, DEFAULT_YEARS } from '@/domain/milestones'
import { DEFAULT_REMINDER, type ReminderPreset } from '@/domain/reminders'
import { applyPlan, type ItemResult } from '@/google/apply'
import {
  MISSING_CLIENT_ID,
  SIGN_IN_CANCELLED,
  SIGN_IN_IN_PROGRESS,
  type Auth,
  type GisPrompt,
} from '@/google/auth'
import type { CalendarApi } from '@/google/calendarApi'
import { buildPlan, type PlanItem } from '@/google/plan'
import type { RetryDeps } from '@/lib/backoff'
import { COPY, countPlan } from '@/ui/copy'

export type Phase = 'idle' | 'probing' | 'ready' | 'applying' | 'done'

export interface DayMarkerDeps {
  auth: Auth
  api: CalendarApi
  todayDate?: CalendarDate
  probeDelayMs?: number
  retryDeps?: RetryDeps
}

/**
 * Translates the two machine-readable sentinels the auth layer can produce into
 * copy a person can act on. Everything else passes through unchanged —
 * 'popup_closed', for instance, means the user dismissed the window on purpose,
 * which needs no translation.
 *
 * This mapping lives here, not in `google/auth.ts`, so that user-facing strings
 * stay in `ui/` and the google layer never imports from the ui layer.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === MISSING_CLIENT_ID) return COPY.missingClientId
  // GIS reports a blocked popup as 'popup_failed_to_open', which means nothing to a user.
  if (message === 'popup_failed_to_open') return COPY.popupBlocked
  return message
}

export function useDayMarker({
  auth,
  api,
  todayDate = todayFn(),
  probeDelayMs = 400,
  retryDeps,
}: DayMarkerDeps) {
  const [startDate, setStartDate] = useState('')
  const [label, setLabel] = useState('')
  const [years, setYears] = useState(DEFAULT_YEARS)
  const [reminder, setReminder] = useState<ReminderPreset>(DEFAULT_REMINDER)

  const [connected, setConnected] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [plan, setPlan] = useState<PlanItem[]>([])
  const [results, setResults] = useState<ItemResult[]>([])
  const [error, setError] = useState<string | null>(null)

  /**
   * `api` and `auth` are singletons in practice, so they are read through refs
   * rather than listed as effect dependencies.
   *
   * This is not stylistic. A caller that builds a fresh deps object on each
   * render — trivially easy to do by inlining `useDayMarker({ auth, api })` —
   * would otherwise retrigger the probe effect every render. The consequence is
   * not a slow render: it is a loop issuing real Google Calendar requests as fast
   * as React can re-render, burning the user's API quota against their own
   * calendar. Keep these out of the dependency arrays.
   */
  const apiRef = useRef(api)
  const authRef = useRef(auth)
  apiRef.current = api
  authRef.current = auth

  const start = isCalendarDate(startDate) ? startDate : null

  const milestones = useMemo(
    () => (start ? computeMilestones(start, years) : []),
    [start, years],
  )

  const options: EventOptions | null = useMemo(
    () => (start ? { start, label, reminder } : null),
    [start, label, reminder],
  )

  // Guards against a slow probe overwriting a newer one.
  const probeToken = useRef(0)
  // Bumped to force a re-probe when the inputs have not changed but the calendar
  // has — i.e. after we ourselves wrote to it. See `reset`.
  const [probeNonce, setProbeNonce] = useState(0)

  useEffect(() => {
    if (!connected || !options || milestones.length === 0) return
    const ticket = probeToken.current + 1
    probeToken.current = ticket
    setPhase('probing')
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await buildPlan(apiRef.current, milestones, options, todayDate)
          if (probeToken.current !== ticket) return
          setPlan(next)
          setResults([])
          setError(null)
          setPhase('ready')
        } catch (e) {
          if (probeToken.current !== ticket) return
          setError(describe(e))
          setPhase('idle')
          setConnected(false)
          authRef.current.clear()
        }
      })()
    }, probeDelayMs)
    return () => clearTimeout(timer)
    // api and auth are intentionally absent — see the apiRef/authRef note above.
  }, [connected, options, milestones, todayDate, probeDelayMs, probeNonce])

  const connect = useCallback(
    async (prompt: GisPrompt = '') => {
      try {
        // Called before any await so the popup survives the user gesture. It stays
        // inside the try and is always awaited, so a handler is attached — clear()
        // rejects a pending call rather than dropping it, and a fire-and-forget
        // call here would surface as an unhandled rejection.
        const promise = authRef.current.connect(prompt)
        await promise
        setError(null)
        setConnected(true)
      } catch (e) {
        const message = e instanceof Error ? e.message : ''
        // A double-click: the popup the user already opened is still open, so
        // there is nothing to tell them and nothing to change.
        if (message === SIGN_IN_IN_PROGRESS) return
        // clear() abandoned this call. The path that called clear() is already
        // reporting its own error; overwriting it with this one would replace the
        // real cause with a symptom.
        if (message === SIGN_IN_CANCELLED) return
        setError(describe(e))
        setConnected(false)
      }
    },
    [],
  )

  const toggle = useCallback((key: string) => {
    setPlan((current) =>
      current.map((item) =>
        item.milestone.key === key ? { ...item, selected: !item.selected } : item,
      ),
    )
  }, [])

  const run = useCallback(
    async (items: PlanItem[]) => {
      if (!options || items.length === 0) return
      setPhase('applying')
      setResults([])
      const collected: ItemResult[] = []
      const finished = await applyPlan(
        apiRef.current,
        items,
        options,
        (result) => {
          collected.push(result)
          setResults([...collected])
        },
        retryDeps,
      )
      setResults(finished)
      setPhase('done')
    },
    [options, retryDeps],
  )

  const submit = useCallback(
    () => run(plan.filter((item) => item.selected)),
    [plan, run],
  )

  const retryFailed = useCallback(async () => {
    const failed = results.filter((r) => r.outcome === 'failed').map((r) => r.item)
    if (failed.length === 0) return
    await connect('')
    await run(failed)
  }, [results, connect, run])

  const reset = useCallback(() => {
    setResults([])
    setPhase(connected ? 'probing' : 'idle')
    // Force a fresh probe. We have just written to the calendar, so the plan in
    // hand is stale: it still reports `new` for events that now exist. Returning
    // to it would break the design's central claim — that the preview is the
    // calendar's real state, not a prediction.
    setProbeNonce((n) => n + 1)
  }, [connected])

  const counts = useMemo(() => countPlan(plan), [plan])
  const failedCount = results.filter((r) => r.outcome === 'failed').length

  return {
    phase,
    startDate,
    label,
    years,
    reminder,
    milestones,
    plan,
    results,
    connected,
    error,
    counts,
    failedCount,
    setStartDate,
    setLabel,
    setYears,
    setReminder,
    toggle,
    connect,
    submit,
    retryFailed,
    reset,
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- useDayMarker`
Expected: PASS — all tests green.

- [ ] **Step 9: Commit**

```bash
git add src/ui/copy.ts src/ui/copy.test.ts src/ui/useDayMarker.ts src/ui/useDayMarker.test.tsx
git commit -m "feat(ui): add copy catalogue and the phase state machine"
```

---

### Task 12: Row projection, form, and milestone list

The presentational half. `buildRows` collapses five phases into one row shape so the list component has no branching in it.

Use **native `<select>` and `<input type="checkbox">`**, not the generated shadcn versions. `shadcn@latest` now emits `@base-ui/react`-backed components, and its `Select` is a composed `Popup`/`Positioner`/`ItemIndicator` assembly that needs pointer-event shims jsdom lacks. A native `<select>` is testable and sufficient here. Likewise `<input type="date">` already gives a real date picker that emits `YYYY-MM-DD` — exactly `CalendarDate`'s format, with no date-picker dependency.

**The generated `checkbox.tsx` and `select.tsx` therefore go unused.** That is expected, not an oversight.

**Files:**
- Create: `src/ui/rows.ts`
- Create: `src/ui/StartDateForm.tsx`
- Create: `src/ui/MilestoneRow.tsx`
- Create: `src/ui/MilestoneList.tsx`
- Test: `src/ui/rows.test.ts`
- Test: `src/ui/MilestoneList.test.tsx`
- Test: `src/ui/StartDateForm.test.tsx`

**Interfaces:**
- Consumes: `Phase`; `Milestone`; `PlanItem`; `ItemResult`; `CalendarDate`, `formatLong`; `COPY` (including `COPY.reminderLabels`), `statusLabel`, `outcomeLabel`; `YEAR_OPTIONS`, `MIN_YEARS`, `MAX_YEARS`; `REMINDER_ORDER`, `ReminderPreset`
- Produces:
  - `interface Row { key: string; name: string; date: string; badge: string; checked: boolean; selectable: boolean; muted: boolean; failed: boolean }`
  - `buildRows(input: BuildRowsInput): Row[]`
  - `<StartDateForm />` with props `{ startDate, label, years, reminder, onStartDate, onLabel, onYears, onReminder, disabled }`
  - `<MilestoneRow />` with props `{ row, onToggle }`
  - `<MilestoneList />` with props `{ rows, heading, onToggle }`

- [ ] **Step 1: Write the failing test for `buildRows`**

Create `src/ui/rows.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildRows } from '@/ui/rows'
import { calendarDate } from '@/domain/calendarDate'
import { computeMilestones } from '@/domain/milestones'
import type { PlanItem } from '@/google/plan'
import type { ItemResult } from '@/google/apply'
import { COPY } from '@/ui/copy'

const START = calendarDate('2026-01-01')
const TODAY = calendarDate('2026-06-01')
const MILESTONES = computeMilestones(START, 1)

function planItem(i: number, over: Partial<PlanItem> = {}): PlanItem {
  return {
    milestone: MILESTONES[i]!,
    eventId: `dm${i}`,
    status: 'new',
    past: false,
    selected: true,
    needsUpdate: false,
    ...over,
  }
}

describe('buildRows — idle', () => {
  it('renders every milestone with an unknown badge', () => {
    const rows = buildRows({
      phase: 'idle',
      milestones: MILESTONES,
      plan: [],
      results: [],
      todayDate: TODAY,
    })
    expect(rows).toHaveLength(4)
    expect(rows[1]?.badge).toBe(COPY.statusUnknown)
    expect(rows[1]?.name).toBe('Day 200')
    expect(rows[1]?.date).toBe('Jul 19, 2026')
    expect(rows[0]?.date).toBe('Apr 10, 2026')
  })

  it('marks past milestones even before connecting', () => {
    const rows = buildRows({
      phase: 'idle',
      milestones: MILESTONES,
      plan: [],
      results: [],
      todayDate: TODAY,
    })
    expect(rows[0]).toMatchObject({ badge: COPY.statusPast, checked: false, muted: true })
  })

  it('is not selectable before connecting', () => {
    const rows = buildRows({
      phase: 'idle',
      milestones: MILESTONES,
      plan: [],
      results: [],
      todayDate: TODAY,
    })
    expect(rows.every((r) => r.selectable === false)).toBe(true)
  })
})

describe('buildRows — ready', () => {
  it('shows the real status badge and selection', () => {
    const plan = [
      planItem(0, { status: 'exists', past: true, selected: false }),
      planItem(1, { status: 'deleted' }),
      planItem(2, { status: 'new' }),
    ]
    const rows = buildRows({ phase: 'ready', milestones: MILESTONES, plan, results: [], todayDate: TODAY })
    expect(rows.map((r) => r.badge)).toEqual([COPY.statusPast, COPY.statusDeleted, COPY.statusNew])
    expect(rows.map((r) => r.checked)).toEqual([false, true, true])
    expect(rows.every((r) => r.selectable)).toBe(true)
  })
})

describe('buildRows — applying and done', () => {
  const plan = [planItem(0), planItem(1), planItem(2, { selected: false })]

  it('shows only the selected items', () => {
    const rows = buildRows({ phase: 'applying', milestones: MILESTONES, plan, results: [], todayDate: TODAY })
    expect(rows).toHaveLength(2)
  })

  it('marks items without a result yet as queued', () => {
    const rows = buildRows({ phase: 'applying', milestones: MILESTONES, plan, results: [], todayDate: TODAY })
    expect(rows.every((r) => r.badge === COPY.queued)).toBe(true)
  })

  it('shows each landed outcome', () => {
    const results: ItemResult[] = [{ item: plan[0]!, outcome: 'added' }]
    const rows = buildRows({ phase: 'applying', milestones: MILESTONES, plan, results, todayDate: TODAY })
    expect(rows[0]?.badge).toBe('Added')
    expect(rows[1]?.badge).toBe(COPY.queued)
  })

  it('flags failures', () => {
    const results: ItemResult[] = [{ item: plan[0]!, outcome: 'failed', error: '401' }]
    const rows = buildRows({ phase: 'done', milestones: MILESTONES, plan, results, todayDate: TODAY })
    expect(rows[0]).toMatchObject({ badge: 'Failed', failed: true })
  })

  it('is not selectable while applying', () => {
    const rows = buildRows({ phase: 'applying', milestones: MILESTONES, plan, results: [], todayDate: TODAY })
    expect(rows.every((r) => r.selectable === false)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- rows`
Expected: FAIL — `Failed to resolve import "@/ui/rows"`.

- [ ] **Step 3: Write `src/ui/rows.ts`**

```ts
import { formatLong, type CalendarDate } from '@/domain/calendarDate'
import type { Milestone } from '@/domain/milestones'
import type { ItemResult } from '@/google/apply'
import type { PlanItem } from '@/google/plan'
import { COPY, outcomeLabel, statusLabel } from '@/ui/copy'
import type { Phase } from '@/ui/useDayMarker'

export interface Row {
  key: string
  name: string
  date: string
  badge: string
  checked: boolean
  selectable: boolean
  muted: boolean
  failed: boolean
}

export interface BuildRowsInput {
  phase: Phase
  milestones: Milestone[]
  plan: PlanItem[]
  results: ItemResult[]
  todayDate: CalendarDate
}

export function buildRows({
  phase,
  milestones,
  plan,
  results,
  todayDate,
}: BuildRowsInput): Row[] {
  if (phase === 'applying' || phase === 'done') {
    const byId = new Map(results.map((r) => [r.item.eventId, r]))
    return plan
      .filter((item) => item.selected)
      .map((item) => {
        const result = byId.get(item.eventId)
        return {
          key: item.milestone.key,
          name: item.milestone.label,
          date: formatLong(item.milestone.date),
          badge: result ? outcomeLabel(result.outcome) : COPY.queued,
          checked: true,
          selectable: false,
          muted: !result,
          failed: result?.outcome === 'failed',
        }
      })
  }

  if (phase === 'ready' && plan.length > 0) {
    return plan.map((item) => ({
      key: item.milestone.key,
      name: item.milestone.label,
      date: formatLong(item.milestone.date),
      badge: statusLabel(item),
      checked: item.selected,
      selectable: true,
      muted: item.past,
      failed: false,
    }))
  }

  // idle and probing: dates are known, calendar status is not.
  return milestones.map((milestone) => {
    const past = milestone.date < todayDate
    return {
      key: milestone.key,
      name: milestone.label,
      date: formatLong(milestone.date),
      badge: past ? COPY.statusPast : COPY.statusUnknown,
      checked: !past,
      selectable: false,
      muted: past,
      failed: false,
    }
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- rows`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for the components**

Create `src/ui/MilestoneList.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MilestoneList } from '@/ui/MilestoneList'
import type { Row } from '@/ui/rows'

function row(over: Partial<Row> = {}): Row {
  return {
    key: 'd100',
    name: 'Day 100',
    date: 'Apr 9, 2026',
    badge: 'New',
    checked: true,
    selectable: true,
    muted: false,
    failed: false,
    ...over,
  }
}

describe('MilestoneList', () => {
  it('renders the heading and every row', () => {
    render(
      <MilestoneList
        heading="13 milestones · 11 selected"
        rows={[row(), row({ key: 'y1', name: '1 Year' })]}
        onToggle={() => {}}
      />,
    )
    expect(screen.getByText('13 milestones · 11 selected')).toBeInTheDocument()
    expect(screen.getByText('Day 100')).toBeInTheDocument()
    expect(screen.getByText('1 Year')).toBeInTheDocument()
  })

  it('reflects checked state', () => {
    render(
      <MilestoneList
        heading="h"
        rows={[row({ checked: true }), row({ key: 'd200', checked: false })]}
        onToggle={() => {}}
      />,
    )
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()
  })

  it('disables checkboxes when the row is not selectable', () => {
    render(<MilestoneList heading="h" rows={[row({ selectable: false })]} onToggle={() => {}} />)
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })

  it('calls onToggle with the row key', async () => {
    const onToggle = vi.fn()
    render(<MilestoneList heading="h" rows={[row()]} onToggle={onToggle} />)
    await userEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenCalledWith('d100')
  })

  it('labels each checkbox with its milestone for screen readers', () => {
    render(<MilestoneList heading="h" rows={[row()]} onToggle={() => {}} />)
    expect(screen.getByRole('checkbox', { name: /Day 100/ })).toBeInTheDocument()
  })
})
```

Create `src/ui/StartDateForm.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StartDateForm } from '@/ui/StartDateForm'

const base = {
  startDate: '2026-01-01',
  label: '',
  years: 3,
  reminder: 'day1' as const,
  onStartDate: () => {},
  onLabel: () => {},
  onYears: () => {},
  onReminder: () => {},
  disabled: false,
}

describe('StartDateForm', () => {
  it('renders the current values', () => {
    render(<StartDateForm {...base} />)
    expect(screen.getByLabelText(/Start date/)).toHaveValue('2026-01-01')
    expect(screen.getByLabelText(/Range/)).toHaveValue('3')
    expect(screen.getByLabelText(/Reminder/)).toHaveValue('day1')
  })

  it('emits the raw date string', () => {
    const onStartDate = vi.fn()
    render(<StartDateForm {...base} startDate="" onStartDate={onStartDate} />)
    // userEvent.type is unreliable on <input type="date">; set the value directly.
    fireEvent.change(screen.getByLabelText(/Start date/), { target: { value: '2026-03-14' } })
    expect(onStartDate).toHaveBeenCalledWith('2026-03-14')
  })

  it('emits the range as a number', async () => {
    const onYears = vi.fn()
    render(<StartDateForm {...base} onYears={onYears} />)
    await userEvent.selectOptions(screen.getByLabelText(/Range/), '5')
    expect(onYears).toHaveBeenCalledWith(5)
  })

  it('emits the reminder preset', async () => {
    const onReminder = vi.fn()
    render(<StartDateForm {...base} onReminder={onReminder} />)
    await userEvent.selectOptions(screen.getByLabelText(/Reminder/), 'week1')
    expect(onReminder).toHaveBeenCalledWith('week1')
  })

  it('offers exactly the four allowed reminder presets', () => {
    render(<StartDateForm {...base} />)
    const options = screen.getByLabelText(/Reminder/).querySelectorAll('option')
    expect(Array.from(options).map((o) => o.value)).toEqual(['none', 'day1', 'day3', 'week1'])
  })

  it('disables every control when disabled', () => {
    render(<StartDateForm {...base} disabled />)
    expect(screen.getByLabelText(/Start date/)).toBeDisabled()
    expect(screen.getByLabelText(/Range/)).toBeDisabled()
  })
})
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm test -- MilestoneList StartDateForm`
Expected: FAIL — both modules unresolved.

- [ ] **Step 7: Write `src/ui/StartDateForm.tsx`**

```tsx
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MAX_YEARS, MIN_YEARS, YEAR_OPTIONS } from '@/domain/milestones'
import { REMINDER_ORDER, type ReminderPreset } from '@/domain/reminders'
import { COPY } from '@/ui/copy'

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm disabled:opacity-50'

export interface StartDateFormProps {
  startDate: string
  label: string
  years: number
  reminder: ReminderPreset
  onStartDate: (value: string) => void
  onLabel: (value: string) => void
  onYears: (value: number) => void
  onReminder: (value: ReminderPreset) => void
  disabled: boolean
}

export function StartDateForm({
  startDate,
  label,
  years,
  reminder,
  onStartDate,
  onLabel,
  onYears,
  onReminder,
  disabled,
}: StartDateFormProps) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="start-date">{COPY.startDate}</Label>
        {/* A native date input already emits YYYY-MM-DD, which is CalendarDate. */}
        <Input
          id="start-date"
          type="date"
          value={startDate}
          disabled={disabled}
          onChange={(e) => onStartDate(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="label">{COPY.labelField}</Label>
        <Input
          id="label"
          type="text"
          value={label}
          placeholder={COPY.labelPlaceholder}
          disabled={disabled}
          onChange={(e) => onLabel(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="years">{COPY.range}</Label>
          <select
            id="years"
            className={SELECT_CLASS}
            value={String(years)}
            disabled={disabled}
            onChange={(e) => onYears(Number(e.target.value))}
          >
            {YEAR_OPTIONS.filter((n) => n >= MIN_YEARS && n <= MAX_YEARS).map((n) => (
              <option key={n} value={n}>
                {COPY.yearsOption(n)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reminder">{COPY.reminder}</Label>
          <select
            id="reminder"
            className={SELECT_CLASS}
            value={reminder}
            disabled={disabled}
            onChange={(e) => onReminder(e.target.value as ReminderPreset)}
          >
            {REMINDER_ORDER.map((preset) => (
              <option key={preset} value={preset}>
                {COPY.reminderLabels[preset]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Write `src/ui/MilestoneRow.tsx`**

```tsx
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Row } from '@/ui/rows'

export interface MilestoneRowProps {
  row: Row
  onToggle: (key: string) => void
}

export function MilestoneRow({ row, onToggle }: MilestoneRowProps) {
  return (
    <li className={cn('flex items-center gap-3 border-b py-2 last:border-b-0', row.muted && 'opacity-50')}>
      <input
        type="checkbox"
        id={`row-${row.key}`}
        className="size-4 shrink-0"
        checked={row.checked}
        disabled={!row.selectable}
        onChange={() => onToggle(row.key)}
      />
      <label htmlFor={`row-${row.key}`} className="w-20 shrink-0 font-medium">
        {row.name}
      </label>
      <span className="flex-1 tabular-nums text-muted-foreground">{row.date}</span>
      <Badge variant={row.failed ? 'destructive' : 'secondary'}>{row.badge}</Badge>
    </li>
  )
}
```

- [ ] **Step 9: Write `src/ui/MilestoneList.tsx`**

```tsx
import { MilestoneRow } from '@/ui/MilestoneRow'
import type { Row } from '@/ui/rows'

export interface MilestoneListProps {
  heading: string
  rows: Row[]
  onToggle: (key: string) => void
}

export function MilestoneList({ heading, rows, onToggle }: MilestoneListProps) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h2>
      <ul className="text-sm">
        {rows.map((row) => (
          <MilestoneRow key={row.key} row={row} onToggle={onToggle} />
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm test -- rows MilestoneList StartDateForm`
Expected: PASS — all tests green.

- [ ] **Step 11: Commit**

```bash
git add src/ui/rows.ts src/ui/rows.test.ts src/ui/StartDateForm.tsx src/ui/StartDateForm.test.tsx \
        src/ui/MilestoneRow.tsx src/ui/MilestoneList.tsx src/ui/MilestoneList.test.tsx
git commit -m "feat(ui): add row projection, start-date form and milestone list"
```

---

### Task 13: Result summary and app composition

Wires everything into the single scrolling page with the sticky action button.

**Files:**
- Create: `src/ui/links.ts`
- Create: `src/ui/ResultSummary.tsx`
- Create: `src/ui/App.tsx`
- Create: `src/vite-env.d.ts`
- Modify: `src/main.tsx`

**Step 0 — type `import.meta.env`.** This belongs to Task 1's scaffolding and was omitted
there; it surfaces here because `main.tsx` is the first file in the codebase to read
`import.meta.env`. Without it, `npm run typecheck` and `npm run build` both fail with
`TS2339: Property 'env' does not exist on type 'ImportMeta'`.

Create `src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Public by design — this ships in the bundle and is not a secret. Optional
   * because a checkout without `.env.local` genuinely has no value here, which is
   * the case `createAuth`'s MISSING_CLIENT_ID sentinel exists to report.
   */
  readonly VITE_GOOGLE_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

The triple-slash reference is what makes this work despite `tsconfig.json`'s `types`
array excluding everything but `vitest/globals` and jest-dom: an explicit
`/// <reference types="…" />` is independent of that array. Declaring
`VITE_GOOGLE_CLIENT_ID` as optional rather than `string` is deliberate — it keeps
`main.tsx`'s `?? ''` meaningful instead of dead code.
- Test: `src/ui/links.test.ts`
- Test: `src/ui/ResultSummary.test.tsx`
- Test: `src/ui/App.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 10–12
- Produces:
  - `calendarDayUrl(date: CalendarDate): string`
  - `<ResultSummary />` with props `{ results, onRetry, onReset }`
  - `<App />` with props `{ deps: DayMarkerDeps; checkGisReady?: () => Promise<boolean> }`

**Note on `checkGisReady`:** it must be injectable. `window.google` never exists in
jsdom, so the real `whenGisReady()` would poll for its full 10-second timeout in every
test, leak a pending timer, and then render the "sign-in could not load" alert —
breaking unrelated assertions. Tests pass `async () => true`.

- [ ] **Step 1: Write the failing tests**

Create `src/ui/links.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { calendarDayUrl } from '@/ui/links'
import { calendarDate } from '@/domain/calendarDate'

describe('calendarDayUrl', () => {
  it('points Google Calendar at the day view', () => {
    expect(calendarDayUrl(calendarDate('2026-04-10'))).toBe(
      'https://calendar.google.com/calendar/r/day/2026/4/10',
    )
  })

  it('strips leading zeros, which the day view requires', () => {
    expect(calendarDayUrl(calendarDate('2026-01-05'))).toBe(
      'https://calendar.google.com/calendar/r/day/2026/1/5',
    )
  })
})
```

Create `src/ui/ResultSummary.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ResultSummary } from '@/ui/ResultSummary'
import type { ItemResult } from '@/google/apply'
import type { PlanItem } from '@/google/plan'
import { computeMilestones } from '@/domain/milestones'
import { calendarDate } from '@/domain/calendarDate'

const MILESTONES = computeMilestones(calendarDate('2026-01-01'), 1)

function result(i: number, outcome: ItemResult['outcome']): ItemResult {
  const item: PlanItem = {
    milestone: MILESTONES[i]!,
    eventId: `dm${i}`,
    status: 'new',
    past: false,
    selected: true,
    needsUpdate: false,
  }
  return { item, outcome, ...(outcome === 'failed' ? { error: 'boom' } : {}) }
}

describe('ResultSummary — success', () => {
  const results = [result(0, 'added'), result(1, 'updated')]

  it('reports the count', () => {
    render(<ResultSummary results={results} onRetry={() => {}} onReset={() => {}} />)
    expect(screen.getByText('2 milestones')).toBeInTheDocument()
    expect(screen.getByText('added to your calendar')).toBeInTheDocument()
  })

  it('links to the first milestone in Google Calendar', () => {
    render(<ResultSummary results={results} onRetry={() => {}} onReset={() => {}} />)
    expect(screen.getByRole('link', { name: /View in Calendar/ })).toHaveAttribute(
      'href',
      'https://calendar.google.com/calendar/r/day/2026/4/10',
    )
  })

  it('does not offer a retry when nothing failed', () => {
    render(<ResultSummary results={results} onRetry={() => {}} onReset={() => {}} />)
    expect(screen.queryByRole('button', { name: /Reconnect/ })).not.toBeInTheDocument()
  })

  it('starts over on request', async () => {
    const onReset = vi.fn()
    render(<ResultSummary results={results} onRetry={() => {}} onReset={onReset} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(onReset).toHaveBeenCalled()
  })
})

describe('ResultSummary — partial failure', () => {
  const results = [result(0, 'added'), result(1, 'failed'), result(2, 'failed')]

  it('reports both counts', () => {
    render(<ResultSummary results={results} onRetry={() => {}} onReset={() => {}} />)
    expect(screen.getByText('1 added · 2 failed')).toBeInTheDocument()
  })

  it('offers a retry scoped to the failures only', async () => {
    const onRetry = vi.fn()
    render(<ResultSummary results={results} onRetry={onRetry} onReset={() => {}} />)
    const button = screen.getByRole('button', { name: 'Reconnect and finish the remaining 2' })
    await userEvent.click(button)
    expect(onRetry).toHaveBeenCalled()
  })
})
```

Create `src/ui/App.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '@/ui/App'
import type { DayMarkerDeps } from '@/ui/useDayMarker'
import type { Auth } from '@/google/auth'
import type { CalendarApi } from '@/google/calendarApi'
import { calendarDate } from '@/domain/calendarDate'

function deps(over: Partial<DayMarkerDeps> = {}): DayMarkerDeps {
  const auth: Auth = {
    connect: vi.fn(async () => 'tok'),
    token: vi.fn(() => 'tok'),
    clear: vi.fn(),
  }
  const api: CalendarApi = {
    getEvent: vi.fn(async () => null),
    insertEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
    patchEvent: vi.fn(async () => ({ id: 'x', status: 'confirmed' as const })),
  }
  return { auth, api, todayDate: calendarDate('2026-06-01'), probeDelayMs: 0, ...over }
}

const gisReady = async () => true

/** userEvent.type is unreliable on <input type="date">; set the value directly. */
function enterStartDate(value: string) {
  fireEvent.change(screen.getByLabelText(/Start date/), { target: { value } })
}

describe('App — idle', () => {
  it('prompts for a date before anything else', () => {
    render(<App deps={deps()} checkGisReady={gisReady} />)
    expect(screen.getByText(/Pick a start date/)).toBeInTheDocument()
  })

  it('lists milestones with no Google connection', async () => {
    render(<App deps={deps()} checkGisReady={gisReady} />)
    enterStartDate('2026-01-01')
    expect(await screen.findByText('Day 100')).toBeInTheDocument()
    expect(screen.getByText('13 milestones')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Connect Google account/ })).toBeInTheDocument()
  })
})

describe('App — connected', () => {
  it('shows real badges and the work the button will do', async () => {
    render(<App deps={deps()} checkGisReady={gisReady} />)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    // 13 milestones from 2026-01-01. On 2026-06-01, Day 100 (Apr 10) and
    // Day 200 (Jul 19)... only Day 100 is past, so 12 remain selected.
    expect(await screen.findByRole('button', { name: 'Add 12' })).toBeInTheDocument()
    expect(screen.getAllByText('New').length).toBeGreaterThan(0)
  })

  it('writes the selected milestones and shows the result', async () => {
    const d = deps()
    render(<App deps={d} checkGisReady={gisReady} />)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add 12' }))
    await waitFor(() => expect(screen.getByText('12 milestones')).toBeInTheDocument())
    expect(d.api.insertEvent).toHaveBeenCalledTimes(12)
    expect(screen.getByText('added to your calendar')).toBeInTheDocument()
  })
})

describe('App — errors', () => {
  it('shows the reason when connecting fails', async () => {
    const d = deps()
    ;(d.auth.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('popup_closed'))
    render(<App deps={d} checkGisReady={gisReady} />)
    enterStartDate('2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: /Connect Google account/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('popup_closed')
  })

  it('warns when the Google script never loads', async () => {
    render(<App deps={deps()} checkGisReady={async () => false} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/)
    expect(screen.getByRole('button', { name: /Connect Google account/ })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- links ResultSummary App`
Expected: FAIL — all three modules unresolved.

- [ ] **Step 3: Write `src/ui/links.ts`**

```ts
import type { CalendarDate } from '@/domain/calendarDate'

/** Google Calendar's day view wants unpadded numbers: /r/day/2026/4/10. */
export function calendarDayUrl(date: CalendarDate): string {
  const [y, m, d] = date.split('-').map(Number)
  return `https://calendar.google.com/calendar/r/day/${y}/${m}/${d}`
}
```

- [ ] **Step 4: Write `src/ui/ResultSummary.tsx`**

```tsx
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatLong } from '@/domain/calendarDate'
import type { ItemResult } from '@/google/apply'
import { COPY, outcomeLabel } from '@/ui/copy'
import { calendarDayUrl } from '@/ui/links'

const PREVIEW_ROWS = 4

export interface ResultSummaryProps {
  results: ItemResult[]
  onRetry: () => void
  onReset: () => void
}

export function ResultSummary({ results, onRetry, onReset }: ResultSummaryProps) {
  const failed = results.filter((r) => r.outcome === 'failed')
  const succeeded = results.filter((r) => r.outcome !== 'failed')
  const first = succeeded[0]?.item.milestone.date
  const shown = results.slice(0, PREVIEW_ROWS)
  const hidden = results.length - shown.length

  return (
    <section className="space-y-4">
      {failed.length > 0 ? (
        <Alert variant="destructive">
          <AlertDescription>
            <strong>{COPY.partialHeadline(succeeded.length, failed.length)}</strong>
            <br />
            {failed[0]?.error}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-1 py-4 text-center">
          <div className="text-2xl">🎉</div>
          <div className="text-2xl font-bold">{COPY.doneHeadline(succeeded.length)}</div>
          <div className="text-muted-foreground">{COPY.doneSubhead}</div>
        </div>
      )}

      <ul className="text-sm">
        {shown.map((result) => (
          <li key={result.item.eventId} className="flex items-center gap-3 border-b py-2">
            <span className="w-20 shrink-0 font-medium">{result.item.milestone.label}</span>
            <span className="flex-1 tabular-nums text-muted-foreground">
              {formatLong(result.item.milestone.date)}
            </span>
            <Badge variant={result.outcome === 'failed' ? 'destructive' : 'secondary'}>
              {outcomeLabel(result.outcome)}
            </Badge>
          </li>
        ))}
        {hidden > 0 && <li className="py-2 text-muted-foreground">{COPY.andMore(hidden)}</li>}
      </ul>

      <div className="flex gap-2">
        {failed.length > 0 ? (
          <Button className="flex-1" variant="destructive" onClick={onRetry}>
            {COPY.retryFailed(failed.length)}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onReset}>
              {COPY.startOver}
            </Button>
            {first && (
              // shadcn's Button is @base-ui/react-backed: it has no `asChild`.
              // base-ui composes via a `render` element instead.
              <Button
                className="flex-1"
                render={<a href={calendarDayUrl(first)} target="_blank" rel="noreferrer" />}
              >
                {COPY.viewInCalendar}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  )
}
```

- [ ] **Step 5: Write `src/ui/App.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { whenGisReady } from '@/google/auth'
import { actionLabel, COPY } from '@/ui/copy'
import { MilestoneList } from '@/ui/MilestoneList'
import { ResultSummary } from '@/ui/ResultSummary'
import { buildRows } from '@/ui/rows'
import { StartDateForm } from '@/ui/StartDateForm'
import { useDayMarker, type DayMarkerDeps } from '@/ui/useDayMarker'
import { today as todayFn } from '@/domain/calendarDate'

export interface AppProps {
  deps: DayMarkerDeps
  /** Injectable because window.google never exists under jsdom. */
  checkGisReady?: () => Promise<boolean>
}

export function App({ deps, checkGisReady = whenGisReady }: AppProps) {
  const state = useDayMarker(deps)
  const [gisReady, setGisReady] = useState(true)

  useEffect(() => {
    let live = true
    void checkGisReady().then((ready) => {
      if (live) setGisReady(ready)
    })
    return () => {
      live = false
    }
  }, [checkGisReady])

  const todayDate = deps.todayDate ?? todayFn()
  const rows = buildRows({
    phase: state.phase,
    milestones: state.milestones,
    plan: state.plan,
    results: state.results,
    todayDate,
  })

  const busy = state.phase === 'applying' || state.phase === 'probing'
  const heading =
    state.phase === 'applying'
      ? // During a write the list shows only the selected subset, so a total
        // milestone count here would contradict the rows underneath it.
        COPY.progress(state.results.length, rows.length)
      : state.phase === 'probing'
        ? COPY.probing
        : state.phase === 'ready'
          ? `${COPY.milestoneCount(state.plan.length)} · ${COPY.selectedCount(state.counts.selected)}`
          : COPY.milestoneCount(state.milestones.length)

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 pb-28 pt-6">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{COPY.appName}</h1>
          <p className="text-xs text-muted-foreground">{COPY.tagline}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {state.connected ? COPY.connected : COPY.notConnected}
        </span>
      </header>

      {/*
        No role="alert" on either Alert below: shadcn's Alert sets it itself, and
        adding it would also risk two elements matching getByRole('alert') at once.
        This comment belongs here, in children position. A JSX comment placed
        inside one of the parenthesised && expressions below is a syntax error.
      */}
      {!gisReady && (
        <Alert variant="destructive">
          <AlertDescription>{COPY.scriptBlocked}</AlertDescription>
        </Alert>
      )}

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.phase === 'done' ? (
        <ResultSummary
          results={state.results}
          onRetry={() => void state.retryFailed()}
          onReset={state.reset}
        />
      ) : (
        <>
          <StartDateForm
            startDate={state.startDate}
            label={state.label}
            years={state.years}
            reminder={state.reminder}
            onStartDate={state.setStartDate}
            onLabel={state.setLabel}
            onYears={state.setYears}
            onReminder={state.setReminder}
            disabled={state.phase === 'applying'}
          />

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{COPY.pickADate}</p>
          ) : (
            <>
              {state.phase === 'applying' && (
                <Progress value={(state.results.length / Math.max(rows.length, 1)) * 100} />
              )}
              <MilestoneList heading={heading} rows={rows} onToggle={state.toggle} />
            </>
          )}

          <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 px-4 py-3 backdrop-blur">
            <div className="mx-auto max-w-md">
              {state.connected ? (
                <Button
                  className="w-full"
                  disabled={busy || state.counts.selected === 0}
                  onClick={() => void state.submit()}
                >
                  {state.phase === 'applying' ? COPY.applying : actionLabel(state.counts)}
                </Button>
              ) : (
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={!gisReady}
                  onClick={() => void state.connect()}
                >
                  {COPY.connect}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  )
}
```

- [ ] **Step 6: Rewrite `src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAuth } from '@/google/auth'
import { createCalendarApi } from '@/google/calendarApi'
import { App } from '@/ui/App'
import './index.css'

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''
const auth = createAuth(clientId)
const api = createCalendarApi(() => auth.token() ?? '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App deps={{ auth, api }} />
  </StrictMode>,
)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- links ResultSummary App`
Expected: PASS — all tests green.

- [ ] **Step 8: Run the whole suite and the type check**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/ui/links.ts src/ui/links.test.ts src/ui/ResultSummary.tsx src/ui/ResultSummary.test.tsx \
        src/ui/App.tsx src/ui/App.test.tsx src/main.tsx
git commit -m "feat(ui): compose the single-page flow with result summary"
```

---

### Task 14: Google Cloud setup, README, and manual verification

The suite mocks `fetch`, so five behaviours remain unproven until a real calendar is involved. This task gets a real client ID wired up and walks that list.

**Files:**
- Create: `README.md`
- Create: `docs/manual-verification.md`
- Create: `.env.local` (untracked)

**Interfaces:**
- Consumes: the whole app
- Produces: a running, verified app and the checklist record

- [ ] **Step 1: Create the Google Cloud OAuth client**

Done in the browser at <https://console.cloud.google.com>, in this order:

1. Create a project (or select one).
2. **APIs & Services → Library →** enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen:** User type **External**. Fill in app name, user support email, developer contact. Add scope `https://www.googleapis.com/auth/calendar.events`. Leave publishing status as **Testing** and add your own Google account under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorized JavaScript origins** add `http://localhost:5173`. Leave **Authorized redirect URIs** empty — the token client does not use one.
5. Copy the client ID.

- [ ] **Step 2: Create `.env.local`**

```bash
cp .env.local.example .env.local
```

Then replace the placeholder with the real client ID. `.env.local` is already gitignored; do not commit it.

- [ ] **Step 3: Write `README.md`**

```markdown
# Day Marker

Enter the date something started; Day Marker writes its milestone anniversaries —
Day 100, Day 200, …, 1 Year, 2 Years — into your Google Calendar.

No backend, no database, no accounts. The page talks to Google directly from your
browser, and nothing about you is stored anywhere else.

## How it works

Each event's ID is derived deterministically from `(start date, milestone)`, so the
calendar itself is the only state the app needs. Before writing, it reads the ID of
every milestone and tells you what will actually happen: `New`, `Already added`, or
`Deleted`. Re-submitting the same start date therefore updates instead of
duplicating, and an event you deleted in Google Calendar gets restored rather than
re-created.

Day counting follows the Korean convention: the start date is day 1, so Day 100 is
99 days after it. Year milestones use the same month and day, not 365-day multiples.

## Setup

1. Google Cloud Console: enable the **Google Calendar API**, configure an **External**
   OAuth consent screen with the scope
   `https://www.googleapis.com/auth/calendar.events`, and create a **Web application**
   OAuth client ID with `http://localhost:5173` as an authorized JavaScript origin.
2. `cp .env.local.example .env.local` and paste the client ID.
3. `npm install && npm run dev`

`VITE_GOOGLE_CLIENT_ID` is public and ships in the bundle. There is no client secret.

While the consent screen is in Testing, only accounts listed as test users can sign
in (up to 100), and they will see Google's "hasn't verified this app" screen.
`calendar.events` is a *sensitive* scope, so going public requires sensitive-scope
verification — Google documents up to 10 days — but not the security assessment that
restricted scopes require.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on <http://localhost:5173> |
| `npm test` | Full unit suite |
| `npm run test:watch` | Watch mode |
| `npm run typecheck` | Types only |
| `npm run build` | Production build to `dist/` |

## Layout

- `src/domain/` — pure logic: date arithmetic, milestones, event IDs, payloads. No network.
- `src/google/` — the only layer that knows about tokens and HTTP.
- `src/ui/` — React components and the phase state machine. Never calls `fetch`.

## Deploying

`npm run build` produces a static `dist/`. Host it anywhere (Vercel, Netlify,
Cloudflare Pages, GitHub Pages). Two required steps:

1. Set `VITE_GOOGLE_CLIENT_ID` in the host's build environment.
2. Add the deployed origin to **Authorized JavaScript origins** on the OAuth client.

## Design docs

- Design: `docs/superpowers/specs/2026-08-17-day-marker-design.md`
- Plan: `docs/superpowers/plans/2026-08-17-day-marker.md`
- Manual checks: `docs/manual-verification.md`
```

- [ ] **Step 4: Write `docs/manual-verification.md`**

```markdown
# Manual verification

The unit suite mocks `fetch`, so these five behaviours can only be confirmed
against a real Google Calendar. Run through them after any change to
`src/domain/eventPayload.ts`, `src/google/apply.ts`, or `src/google/plan.ts`.

Record the date and result each time.

## 1. An all-day event occupies exactly one day

`end.date` is exclusive, so a one-day event ends the following day. A bug here shows
up as a two-day bar in the calendar's all-day row.

- Enter a start date, connect, submit.
- Open Google Calendar and find a milestone.
- **Expect:** a single-day chip in the all-day row, not a bar spanning two days.

## 2. The reminder fires the day before at 09:00

With `1 day before, 9:00 AM` selected, the payload sends `minutes: 900`.

- Open a created event in Google Calendar and view its notification.
- **Expect:** Google's UI describes it as "1 day before at 9:00am".

## 3. Re-submitting creates no duplicates

- Submit a start date, then submit the exact same date again.
- **Expect:** the second pass shows every milestone as `Already added`, the button
  reads `Everything is already up to date`, and the calendar still has one event per
  milestone.

## 4. Deleting an event and re-submitting restores it

Google reserves the IDs of deleted events, so this is the riskiest path.

- Delete one created milestone in Google Calendar.
- Re-run the same start date.
- **Expect:** that milestone shows `Deleted`, submitting reports `Restored`, and the
  event reappears.
- **If instead it reports `Failed`:** the `GET` returned 404 while the ID stayed
  reserved, so the insert hit 409 and the fallback `PATCH` also failed. Note which
  error appeared — this is the documented-unknown from the design, and it decides
  whether the app needs an ID-versioning escape hatch.

## 5. `transparency: transparent` leaves availability free

- Ask a colleague to check your free/busy, or open the event's own detail view.
- **Expect:** the event does not mark you busy.
```

- [ ] **Step 5: Run the dev server and walk the happy path**

Run: `npm run dev`, then open <http://localhost:5173>.

1. The page lists milestones from a start date **before** connecting, with `—` badges.
2. `Connect Google account` opens Google's popup. Click through the unverified-app
   warning (**Advanced → Go to …**) since the consent screen is in Testing.
3. After connecting, badges become real and the button states the work.
4. Submit; watch per-item progress; land on the result screen.
5. `View in Calendar ↗` opens Google Calendar on the first milestone's day.

- [ ] **Step 6: Walk `docs/manual-verification.md`**

Complete all five checks. If any fails, stop and fix it before committing — a failure
here means a real bug the mocked suite cannot see.

- [ ] **Step 7: Run the full suite one more time**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/manual-verification.md
git commit -m "docs: add README and manual verification checklist"
```

---

## Deferred (from the spec — do not build)

- Discovering previously registered sets via `privateExtendedProperty`. The data
  **is** written from Task 5; the query is not built.
- A second UI language.
- A non-primary or dedicated calendar (needs the broader `calendar` scope).
- Custom milestone intervals beyond the 100-day step.
- Multiple simultaneous anniversaries.
