import type { AppDataStore } from '@/google/appData'
import type { CalendarsApi } from '@/google/calendarApi'

/** Shown in the user's calendar list, and the handle they delete the app's work by. */
export const APP_CALENDAR_SUMMARY = 'Day Marker'

export interface AppCalendar {
  /**
   * The ID of the app's calendar, creating it on first use. Cached for the
   * session; concurrent callers share one resolution.
   */
  ensure(): Promise<string>
  /** '' until `ensure` has succeeded. Read on every Calendar request. */
  id(): string
  /** Drops the cache, so the next `ensure` re-reads the pointer. */
  forget(): void
}

/**
 * Ties the two halves of the app's identity together: the calendar Google
 * assigned an ID to, and the pointer to that ID in the user's Drive app-data
 * folder.
 *
 * The invariant worth stating plainly: **one calendar per user, ever.** With
 * `calendar.app.created` the app cannot list calendars to check, so nothing
 * downstream can detect a duplicate after the fact — a second calendar would
 * simply mean a second set of milestone reminders for the same date. Every
 * branch here either reuses the recorded calendar or repoints the file it
 * already found.
 */
export function createAppCalendar(store: AppDataStore, calendars: CalendarsApi): AppCalendar {
  let calendarId = ''
  // Holds the in-flight resolution so two callers cannot each create a calendar.
  let pending: Promise<string> | null = null

  async function resolve(): Promise<string> {
    const pointer = await store.read()

    if (pointer?.calendarId) {
      // Verified rather than trusted: if the user deleted the calendar, every
      // later event call would 404 and the app would report the user's own
      // deletion as a pile of failures.
      const existing = await calendars.getCalendar(pointer.calendarId)
      if (existing) return existing.id
    }

    const created = await calendars.insertCalendar(APP_CALENDAR_SUMMARY)
    // `pointer` is passed back whole so an existing file is overwritten. A null
    // here is the only case that creates a file.
    await store.write(pointer, created.id)
    return created.id
  }

  return {
    ensure() {
      if (calendarId) return Promise.resolve(calendarId)
      if (pending) return pending
      pending = resolve().then(
        (id) => {
          calendarId = id
          pending = null
          return id
        },
        (error: unknown) => {
          // Cleared, not cached. A failed resolution is usually a dead token or
          // a dropped connection; caching the rejection would make one blip
          // permanent for the rest of the session.
          pending = null
          throw error
        },
      )
      return pending
    },
    id() {
      return calendarId
    },
    forget() {
      calendarId = ''
      pending = null
    },
  }
}
