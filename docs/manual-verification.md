# Manual verification

The unit suite mocks `fetch`, so checks 1–5 can only be confirmed against a real
Google Calendar. Run them after any change to `src/domain/eventPayload.ts`,
`src/google/apply.ts`, or `src/google/plan.ts`.

Checks 6–10 cover things a mocked, jsdom-based suite cannot see at all: a
pre-paint script, native browser chrome, a real deployed host, and a real
Google popup. Run the full ten before any deploy.

**This checklist has not yet been run.** Append an entry to the log at the bottom
every time it is: record the date, who ran it, and the result of each check. On a
failure, "fail" is not enough — capture the specifics called out under each check
below, because that detail is what turns a red X into something fixable.

## 1. An all-day event occupies exactly one day

`end.date` is exclusive, so a one-day event ends the following day. A bug here
shows up as a two-day bar in the calendar's all-day row instead of a single-day
chip.

- Enter a start date, connect, submit.
- Open Google Calendar and find a milestone.
- **Expect:** a single-day chip in the all-day row, not a bar spanning two days.
- **If it spans two days:** open the event's own detail view and record which
  milestone it was and the exact `start`/`end` dates shown there. `end.date`
  should be exactly one day after `start.date`; anything else pinpoints how far
  off `buildEventPayload` in `src/domain/eventPayload.ts` is.

## 2. The reminder fires the day before at 09:00

With the default reminder, `1 day before, 9:00 AM`, the payload sends
`minutes: 900` — 15 hours counted backwards from the all-day event's midnight
start.

- Open a created event in Google Calendar and view its notification.
- **Expect:** Google's UI describes it as "1 day before at 9:00am".
- **If it shows something else:** record the offset Google's UI actually shows
  and which reminder preset was selected when the event was created. A wrong
  number on one preset but not the others points at that preset's constant in
  `src/domain/reminders.ts`; a wrong number on all of them points at the
  all-day-midnight assumption itself.

## 3. Re-submitting the same start date creates no duplicates

The whole no-database design rests on this: an event's ID is deterministic from
`(start date, milestone)`, so re-submitting is a lookup-then-update, never a
blind insert.

- Submit a start date, then submit the exact same date again without changing
  anything.
- **Expect:** the second pass shows every milestone as `Already added`, the
  action button reads `Everything is already up to date`, and the calendar still
  has exactly one event per milestone.
- **If a duplicate appears:** open both events and compare their IDs (visible in
  each event's URL). Two different IDs for the same `(start, milestone)` pair
  means `eventIdFor` in `src/domain/eventId.ts` is not actually deterministic —
  record both IDs and the start date used; this is a foundational bug, not a
  one-off glitch.

## 4. Deleting an event and re-submitting revives it

This is the riskiest path. Google reserves the IDs of deleted events, but a
`GET` on a deleted event's ID can answer either "cancelled" (200) or "not found"
(404) depending on how long ago it was deleted — and the app has to handle both
without creating a duplicate.

- Delete one created milestone in Google Calendar.
- Re-run the same start date, and check that milestone's badge **before**
  submitting:
  - **Badge shows `Deleted`** — the probe's `GET` saw the cancelled event.
    Submitting should report **Restored**, and the event should reappear.
    This is the expected, common case.
  - **Badge shows `New`** — the probe's `GET` returned 404; the ID is still
    reserved but Google is no longer serving the cancelled event back. The
    insert this triggers will hit a `409 Conflict`, and the code falls back to
    a `PATCH`. **Expect:** it still reports **Updated**, and the event still
    reappears. This is the documented fallback working as intended, not a
    failure — but record it as "badge was New, outcome was Updated" so this
    path isn't mistaken for case 3 (a duplicate) or for a real failure below.
- **If either case instead reports `Failed`:** the fallback `PATCH` itself
  failed after the `409`. Record: which badge you saw beforehand (`Deleted` or
  `New`), the exact error text shown next to `Failed`, and roughly how long it
  had been since the event was deleted. This is the documented-unknown from the
  design — the answer decides whether the app needs an ID-versioning escape
  hatch (minting a fresh ID instead of reusing one Google will never fully let
  go of).

## 5. `transparency: transparent` leaves availability free

- Ask a colleague to check your free/busy for a milestone's date, or open the
  event's own detail view in Google Calendar and check its availability
  setting.
- **Expect:** the event shows as "Free" and does not appear as a conflict if
  someone tries to schedule a meeting with you that day.
- **If it shows "Busy":** record the event's ID, its milestone, and whether it
  was created fresh or restored/updated from an existing one — `apply.ts` sends
  the full payload from `buildEventPayload` on every write (insert or patch), so
  `transparency` should be set identically both ways; a difference between the
  two paths would narrow down where it's being lost.

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

## Log

No runs recorded yet. Append one line per run in this format, keeping failed
runs even after they're fixed — the history of what broke and when is as useful
as the current state:

```
YYYY-MM-DD — <name> — 1: <pass|fail> — 2: <pass|fail> — 3: <pass|fail> —
4: <pass|fail, and which badge/outcome you saw> — 5: <pass|fail> —
6: <pass|fail> — 7: <pass|fail, and which control/theme if it failed> —
8: <pass|fail, and which host if it failed> —
9: <pass|fail, and which screen if it failed> —
10: <pass|fail, and which route it took, or the exact error if Failed> —
notes: <anything from a "record" bullet above, or "none">
```
