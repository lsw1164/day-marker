# Day Marker

Enter the date something started; Day Marker writes its milestone anniversaries —
Day 100, Day 200, …, 1 Year, 2 Years — into your Google Calendar.

No backend, no database, no accounts. The page talks to Google directly from your
browser. The only thing it remembers lives in your own Google account, not on any
server of ours.

## How it works

Day Marker writes to a calendar it creates for you, named **Day Marker**, rather
than to your primary calendar. Hide it with one checkbox in Google Calendar's
sidebar, or delete every milestone it ever wrote by deleting that one calendar —
Day Marker notices it is gone and starts fresh next time.

Each event's ID is derived deterministically from `(start date, milestone)`, so the
calendar itself is the only state the app needs. Before writing, it reads the ID of
every milestone and tells you what will actually happen: `New`, `Already added`, or
`Deleted`. Re-submitting the same start date therefore updates instead of
duplicating, and an event you deleted in Google Calendar gets restored rather than
re-created.

Day counting follows the Korean convention: the start date is day 1, so Day 100 is
99 days after it, not 100. Year milestones use the same month and day N years later,
not 365-day multiples.

Day Marker follows your system's light or dark setting. The header's theme button
cycles system → light → dark; an explicit choice is remembered in `localStorage`
under `dayMarker.theme`, and removing it returns to following the system.

The **Registrations** tab lists everything Day Marker has written, found by
querying your calendar rather than by storing anything: every event carries its
registration's start date, so the list is grouped from the calendar itself. That
is why a registration made on another device, or a year ago, still appears.
Deleting removes the whole registration — past events included.

## Setup

Requires **Node 20+** and npm — `package.json` declares it under `engines`, and an
older Node is the most common first-run failure. Run every command from the repo
root.

1. In the [Google Cloud Console](https://console.cloud.google.com): enable the
   **Google Calendar API** *and* the **Google Drive API**, configure an
   **External** OAuth consent screen with these two scopes —

   - `https://www.googleapis.com/auth/calendar.app.created`
   - `https://www.googleapis.com/auth/drive.appdata`

   — and create a **Web application** OAuth client ID with `http://localhost:5173`
   as an authorized JavaScript origin. Leave **Authorized redirect URIs** empty —
   the token client does not use one.
2. `cp .env.local.example .env.local` and paste the client ID in as
   `VITE_GOOGLE_CLIENT_ID`.
3. `npm install && npm run dev`, then open <http://localhost:5173>.

`VITE_GOOGLE_CLIENT_ID` is public by design and ships in the bundle. There is no
client secret in this flow.

Both scopes are on Google's **non-sensitive** list, which is deliberate and is the
reason the app can be published without OAuth verification: no review, no 100-user
cap, no "Google hasn't verified this app" screen. `calendar.app.created` grants
access only to calendars this app itself created — never to your primary calendar
or anyone else's — and `drive.appdata` reaches only its own hidden folder.

Widening either one (to `calendar.events`, `calendar`, or `drive.file`) moves the
project onto the sensitive list and back behind verification, so treat the pair in
`src/google/auth.ts` as load-bearing. `src/google/auth.test.ts` pins both strings
for that reason.

If you used a build of Day Marker from before 2026-08-19, its events are on your
primary calendar and the new scope cannot see them — they will not appear under
Registrations, and you will need to remove them by hand.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on <http://localhost:5173> |
| `npm test` | Full unit suite |
| `npm run test:watch` | Watch mode |
| `npm run typecheck` | Types only |
| `npm run build` | Production build to `dist/` |
| `npm run deploy` | Build, then deploy to Cloudflare Workers |

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
prints the current bundle sizes as it goes. Cloudflare Workers is the configured
target (see below); it will host equally well anywhere else (Vercel, Netlify,
GitHub Pages). Three required steps, whatever the host:

1. Set `VITE_GOOGLE_CLIENT_ID` in the host's build environment.
2. Add the deployed origin to **Authorized JavaScript origins** on the OAuth client.
3. Configure the host's URL rewrite and confirm it serves over a secure context —
   see the two notes below.

### Clean URLs need a host rewrite

The app uses real routes (`/`, `/registrations`), so the host must serve
`index.html` for unknown paths. Vite's dev server and `vite preview` do this
automatically — which means **a missing rewrite works locally and 404s in
production**. Configure it:

| Host | What to add |
|---|---|
| Vercel | `vercel.json` → `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }` |
| Netlify | `public/_redirects` → `/*  /index.html  200` |
| Cloudflare Workers | `wrangler.jsonc` → `assets.not_found_handling: "single-page-application"` |
| Cloudflare Pages | `public/_redirects` → `/*  /index.html  200` |
| GitHub Pages | No rewrite support: copy `dist/index.html` to `dist/404.html` after building |

### Cloudflare Workers

`wrangler.jsonc` deploys `dist/` as an assets-only Worker — no `main`, because
there is no server code to run. `not_found_handling` is what makes
`/registrations` survive a hard refresh; Pages used to guess this from the
presence of `index.html`, but Workers requires it to be stated.

`public/_redirects` stays in the repo for the other hosts. Workers honours it
too, and it is harmless here: a request matching a real asset is served before
the redirect rules are consulted, so the catch-all only ever fires for routes.

Deploys run from the GitHub repo via Cloudflare's build integration. Set
`VITE_GOOGLE_CLIENT_ID` as a **build**-time variable in the Workers project —
`.env` is gitignored, so the build has no other source for it, and a build
without it produces a bundle whose sign-in silently fails. It is a Vite
`VITE_`-prefixed variable, so it is inlined into the bundle and public by
design; it is not a runtime secret.

To deploy by hand instead: `npx wrangler login && npm run deploy`.

`compatibility_date` is pinned to a date the installed `workerd` supports, so
`npx wrangler dev` serves the built `dist/` exactly as production does. Bumping
it past the local `workerd` build makes `wrangler dev` refuse to start.

### The app needs a secure context

`crypto.subtle` is `SecureContext`-only, so serve over HTTPS (or `localhost`).
On plain HTTP, event-ID generation fails — the app dies at the first milestone
with "Cannot read properties of undefined (reading 'digest')".

## Design docs

- Design: `docs/superpowers/specs/2026-08-17-day-marker-design.md`
- Plan: `docs/superpowers/plans/2026-08-17-day-marker.md`
- Registration deletion design: `docs/superpowers/specs/2026-08-18-registration-deletion-design.md`
- Registration deletion plan: `docs/superpowers/plans/2026-08-18-registration-deletion.md`
- Manual checks: `docs/manual-verification.md`
