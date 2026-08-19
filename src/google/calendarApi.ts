import type { GoogleEventPayload } from '@/domain/eventPayload'
import { readError, toError } from '@/google/errors'

export const CALENDARS_URL = 'https://www.googleapis.com/calendar/v3/calendars'

/**
 * Every read and write now targets the secondary calendar this app created,
 * whose ID Google assigns at creation time — there is no constant to hardcode
 * the way `primary` once was. See `google/appCalendar.ts` for how it is found.
 */
export function eventsUrl(calendarId: string): string {
  return `${CALENDARS_URL}/${encodeURIComponent(calendarId)}/events`
}

export interface GoogleEvent {
  id: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] }
  /** All-day events carry `date`; a timed event (e.g. "All day" toggled off
   *  by hand in the Calendar UI) carries `dateTime` instead. Both fields are
   *  optional because a malformed response must degrade rather than crash. */
  start?: { date?: string; dateTime?: string }
  /** Where Day Marker stamps dayMarkerVersion, startDate, and milestoneKey. */
  extendedProperties?: { private?: Record<string, string> }
}

export interface EventListPage {
  items: GoogleEvent[]
  nextPageToken?: string
}

export interface GoogleCalendar {
  id: string
  summary?: string
}

export interface CalendarsApi {
  /** null when the user has deleted the calendar out from under the app. */
  getCalendar(id: string): Promise<GoogleCalendar | null>
  insertCalendar(summary: string): Promise<GoogleCalendar>
}

export interface CalendarApi {
  getEvent(id: string): Promise<GoogleEvent | null>
  insertEvent(payload: GoogleEventPayload): Promise<GoogleEvent>
  patchEvent(id: string, payload: GoogleEventPayload): Promise<GoogleEvent>
  listEvents(query: {
    privateExtendedProperty: string
    pageToken?: string
  }): Promise<EventListPage>
  deleteEvent(id: string): Promise<'deleted' | 'alreadyGone'>
}

function requester(getToken: () => string, fetchImpl: typeof fetch) {
  return async function request(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T
  const { reason, detail } = await readError(response)
  throw toError(response.status, reason, detail)
}

export function createCalendarsApi(
  getToken: () => string,
  fetchImpl: typeof fetch = fetch,
): CalendarsApi {
  const request = requester(getToken, fetchImpl)
  return {
    async getCalendar(id) {
      const response = await request(`${CALENDARS_URL}/${encodeURIComponent(id)}`, 'GET')
      // The pointer outlived the calendar: the user deleted it in Google
      // Calendar. An expected answer, not a failure.
      if (response.status === 404) return null
      return unwrap<GoogleCalendar>(response)
    },
    async insertCalendar(summary) {
      return unwrap<GoogleCalendar>(await request(CALENDARS_URL, 'POST', { summary }))
    },
  }
}

/**
 * `getCalendarId` is a function, not a string: the ID is only known after the
 * user connects, which happens long after this factory runs.
 */
export function createCalendarApi(
  getToken: () => string,
  getCalendarId: () => string,
  fetchImpl: typeof fetch = fetch,
): CalendarApi {
  const request = requester(getToken, fetchImpl)
  const eventsFor = () => eventsUrl(getCalendarId())

  return {
    async getEvent(id) {
      const response = await request(`${eventsFor()}/${id}`, 'GET')
      // A missing event is an expected answer here, not a failure.
      if (response.status === 404) return null
      return unwrap<GoogleEvent>(response)
    },
    async insertEvent(payload) {
      return unwrap<GoogleEvent>(await request(eventsFor(), 'POST', payload))
    },
    async patchEvent(id, payload) {
      return unwrap<GoogleEvent>(await request(`${eventsFor()}/${id}`, 'PATCH', payload))
    },
    async listEvents({ privateExtendedProperty, pageToken }) {
      const url = new URL(eventsFor())
      url.searchParams.set('privateExtendedProperty', privateExtendedProperty)
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      // showDeleted is deliberately left at its default of false: a cancelled
      // event must not appear in a list of what is currently registered.
      //
      // singleEvents is likewise left at its default of false, and that is load
      // bearing rather than incidental. Day Marker never writes a `recurrence`
      // field, so this changes nothing today -- but a user can add a repeat rule
      // to one of our events by hand in the Calendar UI. Left at false we get
      // the recurring master, once, carrying our stamps and our deterministic
      // id, and deleting that id removes the whole series. Set to true we would
      // instead get one instance per occurrence, all carrying the same inherited
      // stamps, so the registrations list would show a milestone many times over
      // and deleting an instance id would cancel a single occurrence rather than
      // the registration. Do not "fix" this by asking for expanded instances.
      const response = await request(url.toString(), 'GET')
      if (response.ok) {
        const body = (await response.json()) as Partial<EventListPage>
        return { items: body.items ?? [], nextPageToken: body.nextPageToken }
      }
      const { reason, detail } = await readError(response)
      throw toError(response.status, reason, detail)
    },
    async deleteEvent(id) {
      const response = await request(`${eventsFor()}/${id}`, 'DELETE')
      if (response.ok) return 'deleted'
      // 404: never existed or fully purged. 410: existed, already deleted. Both
      // mean the end state we wanted already holds.
      if (response.status === 404 || response.status === 410) return 'alreadyGone'
      const { reason, detail } = await readError(response)
      throw toError(response.status, reason, detail)
    },
  }
}
