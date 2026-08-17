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
99 days after it, not 100. Year milestones use the same month and day N years later,
not 365-day multiples.

## Setup

Requires **Node 20+** and npm — `package.json` declares it under `engines`, and an
older Node is the most common first-run failure. Run every command from the repo
root.

1. In the [Google Cloud Console](https://console.cloud.google.com): enable the
   **Google Calendar API**, configure an **External** OAuth consent screen with the
   scope `https://www.googleapis.com/auth/calendar.events`, add your own account
   under **Test users**, and create a **Web application** OAuth client ID with
   `http://localhost:5173` as an authorized JavaScript origin. Leave **Authorized
   redirect URIs** empty — the token client does not use one.
2. `cp .env.local.example .env.local` and paste the client ID in as
   `VITE_GOOGLE_CLIENT_ID`.
3. `npm install && npm run dev`, then open <http://localhost:5173>.

`VITE_GOOGLE_CLIENT_ID` is public by design and ships in the bundle. There is no
client secret in this flow.

`calendar.events` is a Google *sensitive* scope. While the OAuth consent screen is
in Testing, only accounts listed as test users can sign in (up to 100), and they
will see Google's "Google hasn't verified this app" warning when they connect —
click through it (**Advanced → Go to …**). Taking the app public requires
sensitive-scope verification, which Google documents as taking up to 10 days, but
unlike restricted scopes (Gmail, Drive), it does not require Google's CASA security
assessment.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on <http://localhost:5173> |
| `npm test` | Full unit suite |
| `npm run test:watch` | Watch mode |
| `npm run typecheck` | Types only |
| `npm run build` | Production build to `dist/` |

`npm test` and `npm run test:watch` pin `TZ=Asia/Seoul` deliberately. A
local-midnight date bug produces the same (wrong) result under `TZ=UTC` and under
US timezones, and only diverges at a positive UTC offset — Korea's UTC+9 is enough
to expose it.

## Layout

- `src/domain/` — pure logic: date arithmetic, milestones, event IDs, payloads. No
  network, no Google types, no React.
- `src/google/` — the only layer that knows about tokens and HTTP: auth, the
  Calendar API client, planning (probing existing IDs), and applying (writing with
  retries).
- `src/ui/` — React components and the phase state machine. Never calls `fetch`.
- `src/components/ui/` — shadcn/ui primitives used by `src/ui/`.
- `src/lib/` — small standalone helpers (`mapWithLimit`, retry/backoff) used by
  `src/google/`.

## Deploying

`npm run build` produces a static `dist/` — plain files, no server runtime — and
prints the current bundle sizes as it goes. Host it anywhere (Vercel, Netlify,
Cloudflare Pages, GitHub Pages). Three required steps:

1. Set `VITE_GOOGLE_CLIENT_ID` in the host's build environment.
2. Add the deployed origin to **Authorized JavaScript origins** on the OAuth client.
3. Serve it from a **secure context** (HTTPS, or `localhost`). Event IDs are derived
   with `crypto.subtle`, which browsers expose only in a secure context, so on a
   plain-HTTP origin the app dies at the first milestone with "Cannot read
   properties of undefined (reading 'digest')".

## Design docs

- Design: `docs/superpowers/specs/2026-08-17-day-marker-design.md`
- Plan: `docs/superpowers/plans/2026-08-17-day-marker.md`
- Manual checks: `docs/manual-verification.md`
