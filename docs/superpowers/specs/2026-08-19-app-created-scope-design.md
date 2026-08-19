# Non-Sensitive Scopes and the App-Created Calendar — Design

**Date:** 2026-08-19
**Status:** Implemented
**Amends:** `docs/superpowers/specs/2026-08-17-day-marker-design.md`,
`docs/superpowers/specs/2026-08-18-registration-deletion-design.md`

## Why

Day Marker was built against `https://www.googleapis.com/auth/calendar.events`,
writing to the user's `primary` calendar. That scope is on Google's **sensitive**
list, and the consequences were not a formality:

- Unverified, the project is capped at **100 users for the lifetime of the Cloud
  project**. The cap cannot be reset — not by a new OAuth client, not by a new
  deployment.
- Every user sees the "Google hasn't verified this app" interstitial.
- Lifting either requires sensitive-scope verification: a verified domain, a
  published privacy policy, a demo video, and a review measured in weeks.

So the app could not simply be launched. Two non-sensitive scopes replace the one
sensitive scope, and the app ships without review.

A second motive pointed the same way. On `primary`, a user who wants Day Marker's
events gone has to delete them one at a time — a dozen per registration, some
years in the future. In its own calendar they are one line in Google Calendar's
own settings.

## The scopes

| Scope | Google's classification | What it buys |
|---|---|---|
| `…/auth/calendar.app.created` | Non-sensitive | Create secondary calendars; full event access **on calendars this app created** |
| `…/auth/drive.appdata` | Non-sensitive | A hidden per-app folder in the user's Drive |

Neither grants any access to the primary calendar, to other calendars, or to any
Drive file the app did not write. That is precisely why they are non-sensitive,
and why the 100-user cap and the warning screen do not apply.

## The problem that shaped the design

`calendar.app.created` cannot enumerate. Verified against Google's method
reference, scope by scope:

| Method | `calendar.app.created` accepted |
|---|---|
| `calendars.insert` / `get` / `delete` | yes |
| `events.list` / `insert` / `patch` / `delete` | yes |
| `calendarList.get` (given an ID) | yes |
| **`calendarList.list`** | **no** — needs `calendar`, `calendar.readonly`, or `calendar.calendarlist*`, all broader |

Everything works *once the calendar ID is known*, and there is no call that
answers "which calendar did I make for this user?". The ID Google assigns at
creation is the first fact about this app that cannot be derived from the user's
input — `primary` was a constant, and event IDs are a hash of the start date.

**The app must therefore remember one string per user.** With no backend there
are two places to put it: the browser, or the user's own Google account.

`localStorage` was rejected. It is per-browser, and iOS Safari evicts
script-writable storage for sites not visited in seven days — which is exactly
this app's usage pattern. A forgotten ID means the app creates a *second* "Day
Marker" calendar, and because deterministic event IDs are scoped per calendar,
nothing collides: re-registering the same start date would produce a second
complete set of reminders. Silent duplicate notifications are the one failure
this codebase has consistently designed against.

The Drive app-data folder has none of that. It is per-account, so it survives a
new device and a cleared browser; it is invisible in the Drive UI; it is
non-sensitive; and it keeps the README's promise intact — the state lives in the
user's account, not on a server we run.

## The invariant

**One calendar per user, ever.**

Nothing downstream can detect a violation: with `calendar.app.created` the app
cannot list calendars to check. So every branch in `appCalendar.ts` either reuses
the recorded calendar or repoints the file it already found, and the resolution
is shared between concurrent callers rather than raced.

## Architecture

```
google/
  auth.ts          SCOPES = [calendar.app.created, drive.appdata], granted as a unit
  appData.ts       the Drive app-data pointer: read() / write()
  appCalendar.ts   resolve + cache the calendar ID; the invariant lives here
  calendarApi.ts   eventsUrl(calendarId); createCalendarsApi for get/insert
  errors.ts        readError/toError moved here — Drive returns the same envelope
```

Resolution, once per session:

1. Read the pointer from the app-data folder.
2. If it names a calendar, `calendars.get` it. Found → done.
3. Otherwise `calendars.insert({ summary: 'Day Marker' })` and write the ID back
   into the *same* Drive file, creating one only if none existed.

Step 2 is not paranoia. It is the recovery path for the affordance this whole
change buys the user: they delete "Day Marker" in Google Calendar, and without
the check every subsequent event call would 404 and the app would report the
user's own deletion as a pile of failures.

`createCalendarApi` takes `getCalendarId: () => string` rather than a string,
because the ID is unknown when the api is constructed — it arrives from Drive
after the user connects.

## Where it is resolved

Both hooks resolve before they report `connected`, because `connected` is what
releases their probe/load effects, and an unresolved ID would send every request
to `/calendars//events`.

`useRegistrations` also resolves inside its load effect. That hook seeds
`connected` from `auth.token() !== null`, so the user can arrive at
`/registrations` from `/` without ever calling this hook's `connect`.

Both drop the cached ID when they clear the token. A reconnect may be a different
Google account, and that account's milestones must not land in the previous
account's calendar.

## Partial grants

GIS renders one checkbox per scope, so a user can grant the calendar and refuse
the Drive folder. `hasGrantedAllScopes` is checked against both, and a partial
grant is rejected as loudly as no grant at all — otherwise the app would connect,
fail to read its pointer, and create a calendar on every visit.

## Trade-offs accepted

- **Events already on `primary` are unreachable.** The new scope cannot see them.
  Anyone who used the earlier build keeps those events and must delete them by
  hand; the app will not find them in its registrations list.
- **The consent screen gains a Drive line.** "View and manage its own
  configuration data in your Google Drive" reads oddly for a calendar app. It is
  the price of cross-device state without a backend.
- **The Drive API must be enabled** on the Cloud project alongside Calendar.
- **A user can delete the app's Drive data** from Drive's storage settings. That
  drops the pointer, and the next visit creates a fresh calendar — the one
  remaining route to a duplicate. It is user-initiated, and it is the same
  recovery path as a deleted calendar.
- **Milestones no longer sit on the primary calendar.** They are one toggle away
  in Google Calendar's sidebar, which is the point, but it does mean they are not
  in the same list as everything else by default.

## Not changed

Event IDs, the milestone arithmetic, the plan/apply flow, the registration key
(`startDate`), and the discovery predicate (`dayMarkerVersion=1`) are all
untouched. Discovery in fact gets cheaper: the query now scans one small calendar
instead of the user's entire primary calendar.
