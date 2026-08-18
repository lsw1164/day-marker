# Registration Deletion, Discovery, and Theming — Design

**Date:** 2026-08-18
**Status:** Approved, ready for implementation planning
**Builds on:** `docs/superpowers/specs/2026-08-17-day-marker-design.md`

## Overview

Three additions to Day Marker:

1. **Discovery** — list every registration Day Marker has ever written, found by
   querying the calendar rather than by remembering anything.
2. **Deletion** — remove a whole registration, with a confirmation step that shows
   exactly which events disappear.
3. **Theming** — support dark and light, following the operating system by default
   with a manual override.

Routing arrives with (1), because the registrations list is a second screen.

## Goals

- Find registrations with no stored state, including from another device or a year ago.
- Delete a registration as a unit, reporting per-event outcomes honestly.
- Keep the existing write flow exactly as reviewed: same files, same tests, same behaviour.
- Support both themes without restyling anything.

## Non-goals

- No partial deletion. The registration is the unit; individual milestones are not
  separately removable.
- No undo. Google may retain a cancelled event for a while, but the app promises nothing.
- No second registration for the same start date. That remains deferred, and this
  design's identity choice forecloses it deliberately (see below).
- No orphan cleanup on re-submit. Shrinking a range from 10 years to 3 leaves the
  extra events in place; deleting the registration removes them, which is sufficient.
- No i18n. Copy remains English literals in `COPY`.

## The registration key: `startDate`, not a new field

**One start date is one registration.** The registration key is therefore the start
date, which every event already carries at
`extendedProperties.private.startDate` — written from day one by the original spec
precisely to keep this option open.

This matters for two reasons:

- **Event IDs are untouched.** They remain `sha256('daymarker/v1/' + start + '/' + key)`,
  so the existing idempotency guarantee — re-submitting updates rather than
  duplicates — survives intact, and the golden test pinning three IDs still holds.
- **Events already in real calendars stay addressable.** Introducing a distinct
  opaque `registrationId` field would leave every previously written event without
  one, and therefore undiscoverable and undeletable. There is no migration because
  there is no new field.

The trade accepted: two separate registrations for the same start date are
impossible. The original spec already assumed this.

## Constraints

- **No new OAuth scope.** `calendar.events` already covers `events.list` and
  `events.delete` on the primary calendar. The consent screen does not change, and
  the sensitive-scope verification position is unaffected.
- **No new stamped field.** Discovery and deletion use data already present on
  every event.
- **`dayMarkerVersion` is the discovery predicate.** The query filters on
  `dayMarkerVersion=1`. If that value is ever bumped, the query must include every
  live version or older registrations become invisible.

## What Google actually does on delete

Verified against Google's documentation, because the behaviour shapes the design:

- The `events.delete` reference says only that it "deletes an event". It does **not**
  document whether deletion is permanent, whether a deleted event remains retrievable,
  or whether its ID can be reused.
- The Events resource documentation says a `cancelled` event represents deleted
  content, that on an organizer's calendar such events "continue to expose event
  details … so that they can be restored (undeleted)", and — critically — that
  "such cancelled events will eventually disappear, so do not rely on them being
  available indefinitely."

Two consequences:

**`events.delete` and `PATCH status: 'cancelled'` converge on the same state.** An
earlier draft of this design claimed the PATCH route was more deterministic for our
revive path. The documentation does not support that. We use `events.delete`, the
conventional call; faking a delete through PATCH would surprise the next reader for
no gain.

**Delete then re-register has two stories, and both already work.** Soon after a
delete, the probe finds a `cancelled` event, classifies it `deleted`, and revives it
with a PATCH. Long after, once Google has purged it, the probe gets a `404` and we
insert — which either succeeds or hits a `409` on a still-reserved ID and falls back
to PATCH. That fallback is the one behaviour this codebase documents as unverified
(`docs/manual-verification.md` check 4). **This feature promotes that path from an
accident to a routine flow, so check 4 becomes more important, not less.**

## Architecture

`main.tsx` renders a new `Root` owning the router, a shared `Header`, and the routes.
`App` becomes the element for `/` and is otherwise unchanged.

```
src/
  main.tsx                    → <Root />
  index.html                  + pre-paint theme script, color-scheme
  ui/
    Root.tsx                  BrowserRouter + Header + Routes
    Header.tsx                name, tagline, nav, theme toggle
    useTheme.ts               stored preference over OS, persists
    App.tsx                   route "/" — header row trimmed to the connection chip
    RegistrationsPage.tsx     route "/registrations"
    RegistrationRow.tsx       one registration; expands inline to confirm
    useRegistrations.ts       list + delete state machine
    copy.ts                   + new keys
  google/
    calendarApi.ts            + listEvents (paginated), deleteEvent
    registrations.ts          listRegistrations, groupByStartDate, deleteRegistration
```

`Header` carries identity, navigation, and the theme toggle. The connection chip
stays inside each page, because connecting is page-level and both pages need it.

**Why a separate hook.** `useDayMarker` already owns a five-phase state machine and
is the largest file in the project. Listing and deleting share nothing with computing
milestones except the `CalendarApi` instance, which is the right amount of coupling.

**Why `App` is untouched.** Its 8 reviewed tests assert nothing about the header, so
moving identity into `Header` disturbs none of them. Keeping the reviewed write flow
byte-identical is worth more than tidiness.

### Three consequences of routing

- **Deep links land unauthenticated.** Shareable URLs were the point, so
  `/registrations` will be opened cold. It needs its own connect affordance.
- **Navigating must not look like a disconnect.** `connected` currently lives inside
  `useDayMarker`. A second page with its own hook would render "Not connected" while
  the token is valid. `auth.token()` is the single source of truth; each page seeds
  its state from it. No auth context, no lifted state.
- **The host rewrite is a deployment requirement.** Without it, refreshing on
  `/registrations` returns 404. Vite's dev server and `vite preview` handle this
  automatically, so **this works locally and breaks in production** — the worst
  failure shape. See Deployment.

## Discovery

`listEvents` issues `GET /calendars/primary/events` with
`privateExtendedProperty=dayMarkerVersion%3D1`, following `nextPageToken` until
exhausted. `showDeleted` is left at its default of `false`, so cancelled
events are excluded — with one documented exception. Google's `events.list`
reference states that cancelled *instances* of recurring events are still returned
when `showDeleted` and `singleEvents` are both false, which is exactly our
configuration. `singleEvents` stays false deliberately (see `calendarApi.ts`: at
`true` we would get one row per occurrence and deleting an instance id would cancel
one occurrence instead of the registration), so grouping drops `status: 'cancelled'`
events itself rather than relying on the query to have excluded them.

**Pagination is not optional.** Several years of registrations will exceed one page,
and silently showing the first page would mean a registration that exists but cannot
be found — worse than having no list at all.

`groupByStartDate` is a pure function over the returned events. For each group it
derives:

| Field | Source |
|---|---|
| `startDate` | `extendedProperties.private.startDate` — the registration key |
| `title` | the **earliest-dated** event's `summary`; if absent, the formatted `startDate`. Not first-in-response order: `events.list` sets no `orderBy`, so that would let one registration rename itself between loads |
| `count` | number of events in the group |
| `events` | id, milestone label (from `milestoneKey`), and date, sorted by date then id, so the order is total |

An event's own date comes from `start.date`, or from the first ten characters of
`start.dateTime` when the user has switched it off all-day — the stamps survive that
toggle, so dropping it would leave an event that is invisible to the list and
therefore undeletable. Events with no usable date, no id, or `status: 'cancelled'`
are excluded; an id-less event could otherwise become `DELETE /events/undefined`.

No label field is stamped. Showing the earliest-dated event's summary displays
`Anna & Ben: Day 100` when a label exists and `Day 100` when it does not, which is
enough to recognise a registration and requires no migration. A summary that is
empty or whitespace falls back to the formatted start date: on a screen whose job is
to say what is about to be lost, a blank row identifies nothing.

Registrations are sorted by `startDate` **descending** as a string comparison, which
is chronological for `YYYY-MM-DD`. "Newest first" is deliberately avoided as wording:
a registration for a future start date sorts above today's, which is correct — it is
the most recently relevant — but "newest" would read as "most recently created", and
creation time is not recorded anywhere.

## Deletion

`deleteEvent(id)` issues `DELETE /calendars/primary/events/{id}`. Status mapping
extends the existing typed-error scheme with one addition:

| Response | Meaning |
|---|---|
| `2xx` / `204` | deleted |
| `404`, `410` | **already gone** — a success, not a failure |
| everything else | the existing `Unauthorized` / `RateLimited` / `ServerError` / `ApiError` mapping |

**`alreadyGone` is a distinct outcome.** If a user removed three events by hand,
Google refuses ours. Reporting that as `failed` would send them hunting a problem
that does not exist — the same reasoning that makes `skipped` distinct from `failed`
on the write path.

`deleteRegistration(api, events, onProgress, retryDeps?, concurrency?)` mirrors
`applyPlan`: `mapWithLimit` at concurrency 3, each delete wrapped in `withRetry`
gated by the existing `isRetryable`, per-item results reported live through
`onProgress`, and a `401` setting a halt flag so the remaining deletes are marked
failed rather than fired at a dead token. Results already collected are preserved,
so a failed run can be retried for only its failures.

Outcomes: `deleted | alreadyGone | failed`.

## Confirmation

Clicking `Delete…` expands the registration row **inline** rather than opening a
dialog. On a phone a modal covers the list being reasoned about, and the decision
here is precisely "what am I about to lose".

The expansion shows **every event, scrollable, never truncated** — milestone label,
date, and a `Past` marker for dates before today — then `Cancel` and `Delete N`.

A ten-year registration is 46 rows and the panel scrolls. Truncating to "and 38
more" would hide exactly the forgotten past events that justify having a confirm
step, so the list is complete by design rather than by omission.

## Mobile-first layout

The existing app is already single-column at `max-w-md` with a sticky bottom action
bar. This design keeps that and adds:

- **Navigation as a segmented control in the header**, full-width, 44 px targets.
  A bottom tab bar was rejected: the write flow ends in a sticky primary button, so
  stacking a tab bar beneath it consumes roughly 120 px of a small screen, pushes the
  action button away from the thumb, and is crowded further by the iOS home
  indicator. The header is the one placement that does not fight the existing design.
- **Registration rows as full-width cards**, stacking naturally.
- **Inline confirm expansion**, for the reason above.
- Touch targets of at least 44 px on every interactive element, including
  `Delete…` and the theme toggle.

## Theming

`index.css` already contains a complete dark palette — 105 custom properties across
`:root` and `.dark`, plus Tailwind v4's `@custom-variant dark (&:is(.dark *))` — all
generated by shadcn's init and never activated, because nothing sets the class. Every
hand-written component already takes its colour from theme tokens: a search across
`src/ui/` for hardcoded utilities such as `bg-white` or `text-gray-500` returns
nothing, and only `bg-background`, `border-input`, and `text-muted-foreground` appear.

So this is a switching-policy change, not a restyling job.

**Policy:** follow the OS by default, with a manual override that persists.

**Mechanism:** an inline script in `index.html`, before first paint, sets `.dark` on
`<html>` from the stored preference if there is one and `prefers-color-scheme`
otherwise. One mechanism — the class — with two sources. It must be inline and
pre-paint; doing it in React would show a flash of the wrong theme on every load.

**`color-scheme: light dark` is required, not cosmetic.** This app deliberately uses
native `<input type="date">` and `<select>` because the base-ui equivalents are not
testable under jsdom. Native controls are user-agent styled, so without declaring
`color-scheme` the date picker and dropdown render as light widgets on a dark page —
the most visible dark-mode bug available, and one no unit test can catch. This is the
price of the earlier native-controls decision, and it is worth paying.

`useTheme` exposes the current choice — `system | light | dark` — and a setter,
persisting to `localStorage` under the key **`dayMarker.theme`**. Absence of that key
means `system`; the key is removed rather than set to `"system"` when the user returns
to following the OS, so a fresh browser and a reset browser behave identically.

**`system` must stay live.** While the choice is `system`, the hook subscribes to
`matchMedia('(prefers-color-scheme: dark)')` and updates the class when the OS flips —
otherwise a phone entering night mode leaves the open tab in the wrong theme until
reload. The subscription is dropped when an explicit `light`/`dark` choice is made,
since the OS no longer decides.

The original spec forbids `localStorage` for the **access token**; a theme preference
is unrelated and fine.

### New global constraint

**No hardcoded colour utilities in components — theme tokens only.** This is
currently true by discipline rather than by rule, and dark mode now depends on it.
It belongs in the plan's Global Constraints and should be enforced at review.

## Error handling

| Situation | Behaviour |
|---|---|
| `/registrations` opened without a token | Connect affordance, no list attempted |
| Token expires mid-listing | Error reported; the list is not shown partially |
| Token expires mid-delete | Halt; completed deletes preserved; offer to reconnect and finish the remainder |
| `404` / `410` on a delete | `alreadyGone` — reported as success |
| `429` / `5xx` on a delete | Existing backoff, 3 attempts, then that item fails |
| A page of results fails to load | Whole listing fails with a retry affordance; never a partial list presented as complete |
| No registrations found | Empty state explaining that nothing has been registered yet |
| Deep-link refresh 404s in production | Not an app error — a missing host rewrite. See Deployment |

## Testing

**Unit:**

- `groupByStartDate` — multiple registrations, single-event groups, events missing
  `startDate` (ignored), events the user switched from all-day to timed (kept, dated
  from `start.dateTime`), cancelled events (dropped), ordering newest first, and
  title derivation with a label, without one, and with a blank one. Fixtures must not
  arrive already in the expected order, or a sort assertion proves nothing.
- Pagination — mocked `fetch` returning two pages, asserting both are merged and the
  token is followed; and that a single page with no token does not loop.
- `deleteEvent` — `404` and `410` both map to `alreadyGone`; other statuses keep the
  existing mapping.
- `deleteRegistration` — a mixed run producing `deleted`/`alreadyGone`/`failed`; a
  `401` halting the remainder while preserving earlier results; retry covering only
  failures.
- `useRegistrations` — phase transitions, and that cancelling a confirm returns to
  the list without deleting.
- `useTheme` — a stored preference wins over the OS; a change persists; clearing it
  returns to following the OS.
- `RegistrationRow` — the confirm lists every event, marks past ones, and the delete
  button carries the count.

**Not unit-testable — added to `docs/manual-verification.md`:**

6. The pre-paint theme script (it lives in `index.html`, outside vitest): load in
   dark mode and confirm there is no flash of light on first paint.
7. Native controls in dark mode: open the date picker and the range dropdown with a
   dark theme active and confirm both render dark, proving `color-scheme` is applied.
8. Deep-link refresh: with the app deployed, hard-refresh `/registrations` and
   confirm the host serves it rather than 404ing.
9. Delete then re-register: delete a registration, immediately re-register the same
   start date, and confirm the events return. This is the deliberate version of
   check 4 and records which of the two documented paths occurred.

## Deployment

Clean paths require the host to serve `index.html` for unknown routes. The README's
Deploying section gains per-host instructions:

- **Vercel** — a rewrite of `/(.*)` to `/index.html`.
- **Netlify** — the equivalent `_redirects` or `netlify.toml` rule with status 200.
- **Cloudflare Pages** — a `_redirects` entry, or the SPA setting.
- **GitHub Pages** — no rewrite support; copy `dist/index.html` to `dist/404.html`
  as a build step.

Vite's dev server and `vite preview` fall back automatically, which is exactly why
this must be documented and manually checked: it works locally and fails in
production.

## Deferred

- Multiple registrations for one start date. Foreclosed by the identity choice above;
  it would require a distinct stamped ID and a migration for existing events.
- Undo. Google may retain a cancelled event, but exposing a restore would mean
  relying on a lifetime the documentation explicitly disclaims.
- Orphan cleanup when a range shrinks. Deleting the registration handles it.
- Editing a registration's label or range from the registrations list. Re-submitting
  from the form already does this.
