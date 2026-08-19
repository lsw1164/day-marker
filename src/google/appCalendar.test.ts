import { describe, expect, it, vi } from 'vitest'
import type { AppDataStore, Pointer } from '@/google/appData'
import { APP_CALENDAR_SUMMARY, createAppCalendar } from '@/google/appCalendar'
import type { CalendarsApi, GoogleCalendar } from '@/google/calendarApi'

function stubStore(initial: Pointer | null) {
  let pointer = initial
  return {
    read: vi.fn(async () => pointer),
    write: vi.fn(async (existing: Pointer | null, calendarId: string) => {
      pointer = { fileId: existing?.fileId ?? 'file-new', calendarId }
      return pointer
    }),
    current: () => pointer,
  }
}

function stubCalendars(existing: GoogleCalendar | null) {
  let created = 0
  return {
    getCalendar: vi.fn(async () => existing),
    insertCalendar: vi.fn(async (summary: string) => {
      created += 1
      return { id: `cal-${created}`, summary }
    }),
    createdCount: () => created,
  }
}

function build(store: ReturnType<typeof stubStore>, calendars: ReturnType<typeof stubCalendars>) {
  return createAppCalendar(store as unknown as AppDataStore, calendars as unknown as CalendarsApi)
}

describe('ensure', () => {
  it('creates the calendar and records its ID on first use', async () => {
    const store = stubStore(null)
    const calendars = stubCalendars(null)

    expect(await build(store, calendars).ensure()).toBe('cal-1')
    expect(calendars.insertCalendar).toHaveBeenCalledWith(APP_CALENDAR_SUMMARY)
    expect(store.write).toHaveBeenCalledWith(null, 'cal-1')
  })

  it('reuses the recorded calendar on a later visit', async () => {
    const store = stubStore({ fileId: 'file-1', calendarId: 'cal-old' })
    const calendars = stubCalendars({ id: 'cal-old' })

    expect(await build(store, calendars).ensure()).toBe('cal-old')
    expect(calendars.insertCalendar).not.toHaveBeenCalled()
    expect(store.write).not.toHaveBeenCalled()
  })

  /**
   * The user deleted "Day Marker" in Google Calendar — the whole point of moving
   * to a secondary calendar. The pointer now names a calendar that is gone, and
   * every event write would 404 against it. Recreate, and repoint the *existing*
   * file: writing a second file would leave two pointers in one folder.
   */
  it('recreates the calendar and repoints the same file when it was deleted', async () => {
    const store = stubStore({ fileId: 'file-1', calendarId: 'cal-old' })
    const calendars = stubCalendars(null)

    expect(await build(store, calendars).ensure()).toBe('cal-1')
    expect(store.write).toHaveBeenCalledWith({ fileId: 'file-1', calendarId: 'cal-old' }, 'cal-1')
    expect(store.current()).toEqual({ fileId: 'file-1', calendarId: 'cal-1' })
  })

  it('reuses a pointer file whose body was never written', async () => {
    const store = stubStore({ fileId: 'file-1', calendarId: null })
    const calendars = stubCalendars(null)

    await build(store, calendars).ensure()
    expect(store.write).toHaveBeenCalledWith({ fileId: 'file-1', calendarId: null }, 'cal-1')
  })

  it('resolves once per session', async () => {
    const store = stubStore(null)
    const calendars = stubCalendars(null)
    const calendar = build(store, calendars)

    await calendar.ensure()
    await calendar.ensure()

    expect(store.read).toHaveBeenCalledTimes(1)
    expect(calendars.createdCount()).toBe(1)
  })

  /**
   * Two callers racing — a connect and a re-probe, say — must not each create a
   * calendar. Duplicate calendars are the one outcome this whole design exists
   * to prevent: the user would get two sets of milestone notifications.
   */
  it('shares one resolution between concurrent callers', async () => {
    const store = stubStore(null)
    const calendars = stubCalendars(null)
    const calendar = build(store, calendars)

    const [a, b] = await Promise.all([calendar.ensure(), calendar.ensure()])

    expect(a).toBe(b)
    expect(calendars.createdCount()).toBe(1)
  })

  it('allows a retry after a failure instead of caching the rejection', async () => {
    const store = stubStore(null)
    store.read.mockRejectedValueOnce(new Error('network'))
    const calendars = stubCalendars(null)
    const calendar = build(store, calendars)

    await expect(calendar.ensure()).rejects.toThrow('network')
    expect(await calendar.ensure()).toBe('cal-1')
  })
})

describe('id', () => {
  it('is empty until the calendar has been resolved', async () => {
    const store = stubStore(null)
    const calendars = stubCalendars(null)
    const calendar = build(store, calendars)

    expect(calendar.id()).toBe('')
    await calendar.ensure()
    expect(calendar.id()).toBe('cal-1')
  })

  it('is empty again after forget', async () => {
    const store = stubStore(null)
    const calendars = stubCalendars(null)
    const calendar = build(store, calendars)

    await calendar.ensure()
    calendar.forget()
    expect(calendar.id()).toBe('')
  })
})
