import { formatLong, isCalendarDate, type CalendarDate } from '@/domain/calendarDate'
import type { CalendarApi, GoogleEvent } from '@/google/calendarApi'
import { isRetryable, Unauthorized } from '@/google/errors'
import { DEFAULT_RETRY_DEPS, withRetry, type RetryDeps } from '@/lib/backoff'
import { mapWithLimit } from '@/lib/mapWithLimit'

/**
 * The discovery predicate. If `dayMarkerVersion` is ever bumped, this must match
 * every live version or older registrations become invisible.
 */
export const DISCOVERY_FILTER = 'dayMarkerVersion=1'

/**
 * Thrown when the calendar hands back a page token it has already served. Not a
 * message: `ui/` maps this sentinel to user copy, the same way it maps
 * MISSING_CLIENT_ID, so that user-facing strings stay out of the google layer.
 */
export const PAGINATION_LOOPED = 'pagination_looped'

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
export function labelFor(milestoneKey: string): string {
  const rest = milestoneKey.slice(1)
  // Require digits rather than trusting Number(): Number('') is 0, so a bare
  // 'd' would otherwise render as "Day 0" -- a fabricated label, worse than an
  // honest blank, on a screen that asks the user to confirm a deletion. The
  // digits are never routed through Number for display either, even once
  // validated: Number('99999999999999999999') rounds to
  // 100000000000000000000, a fabricated renumbering for an implausibly long
  // run. Echoing the raw digit string also keeps a padded key like `d007`
  // honest ("Day 007") instead of silently renumbering it to "Day 7".
  if (!/^\d+$/.test(rest)) return milestoneKey
  if (milestoneKey.startsWith('d')) return `Day ${rest}`
  // Test the string, not Number(rest), so a 20-digit key keeps its digits --
  // but match a padded one too, or y01 loses its singular.
  if (milestoneKey.startsWith('y')) return /^0*1$/.test(rest) ? `${rest} Year` : `${rest} Years`
  return milestoneKey
}

/**
 * The per-event accumulator, carrying `summary` only until the title is read
 * from the earliest-dated event -- `RegistrationEvent` itself has no summary
 * field, since nothing downstream needs it.
 */
type Attributed = RegistrationEvent & { summary?: string }

export function groupByStartDate(events: GoogleEvent[]): Registration[] {
  const groups = new Map<CalendarDate, Attributed[]>()

  for (const event of events) {
    // Google returns cancelled instances of recurring events even with
    // showDeleted false, when singleEvents is also false -- which is our
    // config, deliberately (see calendarApi.ts). A hand-added repeat rule on
    // one of our events would otherwise inflate count and add a phantom
    // confirm row.
    if (event.status === 'cancelled') continue
    // Without an id there is nothing to attribute or, later, to delete: a
    // missing id would resolve a delete to DELETE /events/undefined.
    if (!event.id) continue

    const props = event.extendedProperties?.private
    const start = props?.startDate
    // A timed event has dateTime and no date -- toggling "All day" off in the
    // Calendar UI does that, and our stamps survive it. Slice the calendar date
    // out rather than parsing: the first 10 characters are the date as the
    // user sees it in their own timezone, and no Date round-trip means no
    // offset to get wrong.
    const own = event.start?.date ?? event.start?.dateTime?.slice(0, 10)
    // An event we cannot attribute to a registration is skipped rather than
    // invented into one: no start date, no date of its own, or either unparseable.
    if (!start || !isCalendarDate(start)) continue
    if (!own || !isCalendarDate(own)) continue

    const list = groups.get(start) ?? []
    list.push({
      id: event.id,
      date: own,
      label: labelFor(props?.milestoneKey ?? ''),
      summary: event.summary,
    })
    groups.set(start, list)
  }

  return [...groups.entries()]
    .map(([startDate, list]) => {
      const sorted = [...list].sort((a, b) => {
        if (a.date < b.date) return -1
        if (a.date > b.date) return 1
        // Equal dates: tie-break on id so the order is total. Array#sort is
        // stable, so without this two same-dated events would keep whatever
        // order the API happened to return them in -- the exact
        // nondeterminism the earliest-event titling below was added to close.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      const earliest = sorted[0]?.summary
      return {
        startDate,
        // Google's events.list sets no orderBy, so input order is arbitrary.
        // Titling from the earliest-dated event keeps a registration from
        // renaming itself between loads depending on API response order. A
        // blank or whitespace-only summary (a user can retitle an event to
        // nothing) falls back to the formatted start date rather than
        // leaving the confirm-before-delete row with no identifying text.
        title: earliest && earliest.trim() ? earliest : formatLong(startDate),
        count: sorted.length,
        // Rebuilt rather than passed through: `sorted` is `Attributed`, so
        // handing it back would put a `summary` key on every event that
        // `RegistrationEvent` does not declare. Harmless to read, but it makes
        // the runtime shape disagree with the exported type, and a later
        // deep-equality assertion on `events` would fail on the extra key.
        events: sorted.map((e) => ({ id: e.id, date: e.date, label: e.label })),
      }
    })
    // Descending string comparison, which is chronological for YYYY-MM-DD.
    .sort((a, b) => (a.startDate > b.startDate ? -1 : a.startDate < b.startDate ? 1 : 0))
}

/**
 * Fetches every page before grouping. A partial list is not an acceptable
 * degradation here: it would show a registration count that is quietly wrong and
 * hide registrations the user is looking for.
 */
export async function listRegistrations(api: CalendarApi): Promise<Registration[]> {
  // Keyed by id rather than appended to an array: Google's page tokens are
  // not snapshot-isolated, so a calendar mutated mid-pagination can hand the
  // same event back on two different pages, which would otherwise double
  // that registration's count and show two identical confirm rows.
  const byId = new Map<string, GoogleEvent>()
  // Production carries no page-count cap: a cap that truncates would
  // manufacture the exact silent-lie failure this function exists to
  // prevent, and a cap that throws would fail a real user with an
  // implausible-but-possible registration count in exchange for defending
  // against Google violating its own documented pagination contract. Cycle
  // detection is different: a legitimate run never repeats a token, so this
  // guard cannot fire on one, and it turns a token that does repeat into an
  // immediate, labelled failure instead of a loop that never terminates.
  const seen = new Set<string>()
  let pageToken: string | undefined
  do {
    const page = await api.listEvents({
      privateExtendedProperty: DISCOVERY_FILTER,
      pageToken,
    })
    for (const item of page.items) byId.set(item.id, item)
    pageToken = page.nextPageToken
    if (pageToken) {
      if (seen.has(pageToken)) {
        throw new Error(PAGINATION_LOOPED)
      }
      seen.add(pageToken)
    }
  } while (pageToken)
  return groupByStartDate([...byId.values()])
}

export type DeleteOutcome = 'deleted' | 'alreadyGone' | 'failed'

export interface DeleteResult {
  event: RegistrationEvent
  outcome: DeleteOutcome
  error?: string
}

export const DELETE_CONCURRENCY = 3

/**
 * Not user copy directly assembled here for display -- ui/ owns that -- but,
 * like apply.ts's HALTED_MESSAGE, this is the literal error text carried on a
 * DeleteResult so a screen listing failures can tell "never attempted because
 * the token died" apart from "attempted and got a real 401", without the
 * google layer importing from ui/.
 */
export const DELETE_HALTED_MESSAGE = 'Stopped after the Google connection expired'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Deliberately the same shape as applyPlan: mapWithLimit at concurrency 3, each
 * call wrapped in withRetry gated by isRetryable, per-item results reported live,
 * and a 401 halting the remainder rather than firing doomed requests at a dead
 * token. Operates only on the exact `events` array the caller passes in -- the
 * same array the confirm screen showed -- never re-querying or re-deriving it,
 * so every input event appears exactly once in the result, in input order,
 * whatever its outcome.
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
        error: DELETE_HALTED_MESSAGE,
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
      // Losing the token invalidates every remaining delete, so stop scheduling.
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

  // The per-item callback is *nearly* total, but not quite: `onProgress` runs
  // outside the try in the halted branch and again inside the catch, so a
  // throwing progress callback rejects the slot. An unconditional
  // `as PromiseFulfilledResult<DeleteResult>` would then push `undefined` into
  // React state and crash whatever screen renders these results. Surface the
  // rejection instead, exactly as applyPlan does.
  return settled.map((r) => {
    if (r.status === 'rejected') throw r.reason
    return r.value
  })
}
