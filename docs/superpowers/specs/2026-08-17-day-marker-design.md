# Day Marker — Design

**Date:** 2026-08-17
**Status:** Approved, ready for implementation planning

## Overview

A browser-only web app that takes the date a relationship started and writes its
milestone anniversaries — 100일, 200일, …, 1주년, 2주년 — into the user's Google
Calendar.

The user enters a start date, sees exactly which dates will be created and which
already exist, unchecks what they don't want, and clicks once.

## Goals

- Compute Korean-convention milestones from a start date, correctly.
- Write them to the signed-in user's primary Google Calendar as all-day events.
- Show, before writing, precisely what will happen to each milestone.
- Be safe to run twice: re-submitting updates rather than duplicates.

## Non-goals

- No backend, no database, no server-side session. Nothing about the user is
  stored anywhere we control.
- No accounts, no saved anniversaries, no "my anniversaries" list.
- No sharing, no partner invites, no notifications of our own — Google Calendar's
  reminders are the notification system.
- No recurring-event trickery. Each milestone is its own one-off event.

## Constraints

**`calendar.events` is a Google *sensitive* scope.** While the OAuth consent
screen is in Testing, at most 100 named test users can authorize the app, and
they see an "이 앱은 확인되지 않았습니다" interstitial. Public launch requires
sensitive-scope verification, which Google documents as taking up to 10 days. It
does *not* require the CASA security assessment that restricted scopes (Gmail,
Drive) trigger.

The commonly-cited "test-user grants expire after 7 days" gotcha does not affect
us: we hold no refresh token and request a fresh access token every session.

**Access tokens are memory-only and last ~1 hour.** There is no refresh token in
the browser token-client flow. A tab left open overnight must reconnect. For a
one-shot form this is acceptable, and the deterministic-ID design makes the
resulting mid-run expiry fully recoverable.

**Reminder offsets are `0`–`40320` minutes, always *before* event start.** All-day
events start at midnight, so "9am on the day itself" is not expressible. The
reminder presets are chosen to be expressible (see below).

## Architecture

One React SPA. No backend. The only durable state in the system is the user's
Google Calendar — which is why deterministic event IDs are load-bearing: **the
calendar is our database.**

```
src/
  domain/                  pure — no fetch, no Google types, no React
    calendarDate.ts        CalendarDate + addDays / addYears / format
    milestones.ts          computeMilestones(start, years) → Milestone[]
    eventId.ts             eventIdFor(start, key) → base32hex id
    eventPayload.ts        Milestone + options → Google Event resource
  google/                  the only place that knows tokens and HTTP
    auth.ts                GIS token client wrapper
    calendarApi.ts         getEvent / insertEvent / patchEvent, typed errors
    plan.ts                probe existing IDs → PlanItem[]
    apply.ts               execute plan, concurrency-limited, per-item results
  ui/
    App.tsx
    StartDateForm.tsx
    MilestoneList.tsx
    ResultSummary.tsx
    components/ui/         shadcn
  lib/mapWithLimit.ts
```

Two rules keep the boundaries honest: `domain/` never imports from `google/`, and
`ui/` never calls `fetch`. All the logic worth testing — day counting, leap-year
handling, ID derivation, payload shape — lives in `domain/`, reachable without a
network or an OAuth popup.

**Stack:** Vite + React + TypeScript + shadcn/ui (which brings Tailwind and Radix).
Deployed as a static `dist/`.

## Domain

### CalendarDate

`CalendarDate` is a branded `'YYYY-MM-DD'` string, not a `Date`. Arithmetic goes
through UTC-noon `Date` instances internally and returns immediately to a string.

An anniversary has no time and no timezone. Letting a local-midnight `Date` into
the domain is the single most reliable way to ship an off-by-one-day bug across a
DST boundary, so the type system keeps it out.

### Milestones

| Kind | Rule | Label | Example (start = 2026-01-01) |
|---|---|---|---|
| `day` | `start + (N − 1) days` | `${N}일` | 100일 → 2026-04-09 |
| `year` | same month/day, N years later | `${k}주년` | 1주년 → 2027-01-01 |

The day rule is the Korean convention: the start date is day 1, so 100일 is
`start + 99 days`, not `start + 100`.

`years` (1–10, default 3) sets the horizon at `start + years` calendar years.
Day milestones step by 100 from 100 while their date falls on or before the
horizon; year milestones run `1..years`. At the default that yields 100일…1000일
plus 1–3주년 — **13 events**.

A start date of Feb 29 lands its 주년 on Feb 28 in common years.

Each milestone carries a stable `key`: `d100`, `d200`, `y1`, `y2`.

### Deterministic event IDs

```
eventIdFor(start, key) = 'dm' + base32hex(sha256(`daymarker/v1/${start}/${key}`)).slice(0, 30)
```

Google requires client-supplied IDs to use the base32hex alphabet — lowercase
`a`–`v` and digits `0`–`9` — with length 5–1024, unique per calendar. The `dm`
prefix is within that alphabet. A test asserts every generated ID matches
`/^[0-9a-v]{5,1024}$/`, because one stray `w` is a 400 from Google.

**The ID depends on the start date and the milestone key only** — never on the
title, label, reminder, or `years`. That is the property that makes re-submitting
an update instead of a duplication, and it must not be weakened.

Hashing uses `crypto.subtle.digest('SHA-256', …)`, which is async and
`SecureContext`-only. Localhost and HTTPS both qualify.

### Event payload

```jsonc
{
  "id": "dm…",
  "summary": "우리 100일",          // `${label} ${milestoneLabel}`, label optional
  "description": "Day Marker · 시작일 2026-01-01",
  "start": { "date": "2026-04-09" },
  "end":   { "date": "2026-04-10" },  // exclusive
  "transparency": "transparent",       // an anniversary must not mark you busy
  "reminders": { "useDefault": false, "overrides": [{ "method": "popup", "minutes": 900 }] },
  "extendedProperties": {
    "private": { "dayMarkerVersion": "1", "startDate": "2026-01-01", "milestoneKey": "d100" }
  }
}
```

`end.date` is **exclusive** for all-day events — a one-day event ends the
following day. This has its own test and its own line on the manual checklist.

`label` is an optional free-text field; empty means the title is just `100일`.
Any emoji the user wants goes in the label — we don't inject one.

`extendedProperties.private` costs nothing to write and preserves a real option:
a future version could find previously registered events via
`events.list?privateExtendedProperty=startDate%3D2026-01-01`, discovering an
anniversary set with no stored state at all. We write the properties now and
build no query for them in v1.

### Reminder presets

Offsets must be 0–40320 minutes before midnight of the event day:

| Preset | minutes |
|---|---|
| 알림 없음 | `overrides: []` |
| 1일 전 오전 9시 *(default)* | `900` |
| 3일 전 오전 9시 | `3780` |
| 1주 전 오전 9시 | `9540` |

"당일 오전 9시" is deliberately absent — it would be a negative offset, which the
API rejects.

## Google layer

### Auth (`auth.ts`)

Google Identity Services, loaded from `https://accounts.google.com/gsi/client`.

```ts
google.accounts.oauth2.initTokenClient({
  client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  scope: 'https://www.googleapis.com/auth/calendar.events',
  callback, error_callback,
})
```

- `requestAccessToken()` **must be called synchronously inside a user gesture**,
  or the browser blocks the popup. No awaits before it in the click handler.
- The granted scope is verified with `hasGrantedAllScopes` — a user can uncheck
  the permission and still complete the flow.
- The token lives in a module-level variable with its expiry. Never
  `localStorage`; a token in storage outlives the tab for no benefit.
- Re-requesting with `prompt: ''` re-authorizes silently when consent already
  exists, which makes the mid-run 401 recovery nearly invisible.

`VITE_GOOGLE_CLIENT_ID` is public by design — it ships in the bundle. There is no
client secret in this flow.

### API (`calendarApi.ts`)

Plain `fetch` against `https://www.googleapis.com/calendar/v3/calendars/primary/events`,
with `Authorization: Bearer <token>`. No `gapi.client`, no discovery document, no
API key.

Three calls: `getEvent(id)`, `insertEvent(payload)`, `patchEvent(id, partial)`.
HTTP status maps to typed errors — `Unauthorized`, `RateLimited`, `Conflict`,
`NotFound`, `ApiError` — so callers branch on types rather than numbers.

### Plan (`plan.ts`)

For each milestone, `GET` its deterministic ID and classify:

| Response | Status | Action |
|---|---|---|
| `404` | `new` | `POST` |
| `200`, `status: "confirmed"` | `exists` | `PATCH` if title/reminder differ, else skip |
| `200`, `status: "cancelled"` | `deleted` | `PATCH` back to `confirmed` — revives it |

`past` is **not** a status — it is a separate boolean on each `PlanItem`, true when
the milestone date is before today. It is orthogonal to the three statuses above
(a milestone can be both `past` and `new`) and affects only one thing: the item
starts unchecked.

At the default range that is 13 cheap `GET`s. The preview is therefore not a
prediction — it is the calendar's actual state.

### Apply (`apply.ts`)

Executes the plan through `mapWithLimit(…, 3)`, reporting each item's result as
it lands so the list fills in live.

**`POST` → `409` fallback:** Google reserves the IDs of deleted events, and the
docs do not state when (or whether) a `GET` on a long-deleted event stops
returning it. So a `404` at plan time can still produce a `409` at write time. On
`409`, retry the item as a `PATCH`. If that also fails, mark the item failed with
a plain-language message rather than pretending it succeeded. This path is on the
manual verification checklist.

## UI

A single scrolling page — input on top, live preview below, action button pinned
to the bottom. The input is three fields plus an optional label; a wizard would be
ceremony. The page's content is replaced by a result view after submission, which
is the one thing a wizard would have given us for free.

### State machine

```ts
type Phase =
  | { k: 'idle' }                        // not connected; dates shown, badges empty
  | { k: 'probing' }                     // connected, GETting statuses
  | { k: 'ready';    plan: PlanItem[] }
  | { k: 'applying'; results: ItemResult[] }
  | { k: 'done';     results: ItemResult[] }
```

Form inputs are always editable, independent of phase. Editing them recomputes
milestones immediately and, when connected, re-probes after a 400 ms debounce.
Editing while in `done` returns to `ready`.

### Screen states

**① idle** — Milestones are computed and listed on first paint, with `—` where the
status badge will go, and a `Google 계정 연결` button. The app answers "when is our
100일?" before asking for anything. This ordering also improves the odds of
getting through the unverified-app interstitial: a user who already understands
the app is far likelier to click through it.

**② ready** — Badges fill in: 신규 / 등록됨 / 삭제됨 / 지난. The button states the
actual work — `8개 등록 · 3개 업데이트` — so the outcome is known before the click.
Past milestones are listed but unchecked.

**③ applying** — Per-item status, not one opaque spinner: 등록 / 업데이트 / 되살림 /
전송 중 / 대기, with a progress bar.

**④ done** — A count, the per-item outcomes, and a `캘린더에서 보기` link that opens
Google Calendar at the first created milestone's date.

**⑤ partial failure** — Successes and failures listed separately, with a recovery
button that retries **only the failed items**. Retrying is safe because the IDs
are deterministic; even re-running the whole set could not duplicate anything.

## Error handling

| Situation | Behavior |
|---|---|
| Popup blocked | `requestAccessToken()` runs synchronously in the click handler; if it still fails, show instructions to allow popups. |
| User denies scope | `hasGrantedAllScopes` is false → explain the permission is required and offer to retry. |
| `401` mid-run | Stop scheduling new writes, keep completed results, offer `다시 연결하고 N개 이어서 등록`. |
| `403 rateLimitExceeded` / `429` | Exponential backoff with jitter, 3 attempts, then mark the item failed. |
| `409` on insert | Fall back to `PATCH` (see Apply). |
| `5xx` | Same backoff path as `429`. |
| Offline / network error | Item fails with a retry affordance; completed results are preserved in state. |
| Start date in the future | Allowed — planning ahead is legitimate. All milestones are future, none are auto-unchecked. |
| Start date empty or unparseable | No milestones computed; the list area shows a prompt to pick a date and the action button is disabled. Not an error state. |
| GIS script fails to load | The form still computes and displays dates; the connect button is disabled with an explanation. |

Two failures are handled automatically and invisibly: `429`/`5xx` backoff, and the
`409` → `PATCH` fallback. Every other failure stops and surfaces to the user with
an action attached.

## Testing

**Vitest + Testing Library + jsdom.** No live Google calls in the suite — the OAuth
flow is interactive and cannot run headless.

`domain/` — table-driven, and the bulk of the value:

- Korean counting boundary: start 2026-01-01 → 100일 = 2026-04-09 (not 04-10).
- 주년 is calendar-based: 1주년 = 2027-01-01, not `start + 365`.
- Leap year: start 2024-02-29 → 1주년 = 2025-02-28.
- Horizon: `years = 3` yields exactly 13 milestones; `years = 1` yields 4.
- `end.date` is `start.date + 1`.
- ID determinism (same input → same output), charset regex, and stability against
  changes to label / reminder / years.
- Reminder preset → minutes mapping.

`google/` — `fetch` mocked:

- Plan classification for 404 / 200-confirmed / 200-cancelled.
- `401` → `Unauthorized`; `429` → retried then succeeds; `429` ×4 → failed.
- `409` on insert → falls back to `PATCH`.
- `mapWithLimit`: order preserved, concurrency respected, one rejection doesn't
  sink the batch.

`ui/` — Testing Library:

- Badge rendering per plan status.
- Past milestones render unchecked; future ones checked.
- Button label reflects the checked counts.
- Partial-failure view retries only failed items.

**Manual checklist** (things a mock cannot prove):

1. An all-day event occupies exactly one day in Google Calendar — no bleed into
   the next day.
2. The reminder fires the day before at 09:00, as Google's UI describes it.
3. Re-submitting the same start date creates no duplicates.
4. Deleting an event in Google Calendar and re-submitting revives it — and if
   Google instead returns 409-after-404, the fallback handles it.
5. `transparency: transparent` leaves the user's availability free.

## Setup

1. Google Cloud project → enable the Google Calendar API.
2. OAuth consent screen: External, scope `calendar.events`, app name and support
   email filled in; add test users while in Testing.
3. Credentials → OAuth 2.0 Client ID → **Web application**. Authorized JavaScript
   origins: `http://localhost:5173` and the deployed origin. No redirect URI and
   no client secret are needed for the token-client flow.
4. `VITE_GOOGLE_CLIENT_ID` in `.env.local` (and in the host's env for deploys).
5. Add `.superpowers/` and `.env.local` to `.gitignore`.

## Deferred

Recorded so they aren't rediscovered as bugs:

- Discovering previously registered sets via `privateExtendedProperty` — the data
  is written from day one, the query is not built.
- Choosing a non-primary or dedicated calendar (would need the broader `calendar`
  scope).
- Custom milestone intervals beyond the 100-day step.
- Multiple simultaneous anniversaries. Today, one start date is one anniversary,
  which is what makes the ID scheme unambiguous.
