import { describe, expect, it, vi } from 'vitest'
import {
  APPDATA_FILE_NAME,
  createAppDataStore,
  DRIVE_FILES_URL,
  DRIVE_UPLOAD_URL,
} from '@/google/appData'
import { Unauthorized } from '@/google/errors'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type Call = { url: string; init: RequestInit }

/**
 * Routes by URL rather than by call order. The store issues two requests per
 * operation, and an order-indexed stub would still pass if they were swapped.
 */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return handler(String(url), (init ?? {}) as RequestInit)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function storeWith(handler: (url: string, init: RequestInit) => Response) {
  const { fetchImpl, calls } = stubFetch(handler)
  return { store: createAppDataStore(() => 'token-123', fetchImpl), calls }
}

describe('read', () => {
  it('looks only inside the hidden app-data folder', async () => {
    const { store, calls } = storeWith(() => jsonResponse(200, { files: [] }))
    await store.read()
    expect(calls[0]!.url).toContain('spaces=appDataFolder')
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer token-123')
  })

  it('returns null when the folder holds no pointer file', async () => {
    const { store } = storeWith(() => jsonResponse(200, { files: [] }))
    expect(await store.read()).toBeNull()
  })

  it('returns the calendar ID from the pointer file', async () => {
    const { store } = storeWith((url) =>
      url.includes('alt=media')
        ? jsonResponse(200, { calendarId: 'cal-abc@group.calendar.google.com' })
        : jsonResponse(200, { files: [{ id: 'file-1', name: APPDATA_FILE_NAME }] }),
    )
    expect(await store.read()).toEqual({
      fileId: 'file-1',
      calendarId: 'cal-abc@group.calendar.google.com',
    })
  })

  /**
   * A first run that created the file and then failed before writing its body
   * leaves an empty file behind. Reporting that as "no pointer at all" would
   * make the next write create a *second* file, and the run after that would
   * have two to choose from. Returning the fileId with a null calendarId lets
   * the caller reuse the file it already has.
   */
  it('returns the file ID with no calendar ID when the body is unusable', async () => {
    const { store } = storeWith((url) =>
      url.includes('alt=media')
        ? new Response('', { status: 200 })
        : jsonResponse(200, { files: [{ id: 'file-1', name: APPDATA_FILE_NAME }] }),
    )
    expect(await store.read()).toEqual({ fileId: 'file-1', calendarId: null })
  })

  it('ignores files in the folder that are not the pointer', async () => {
    const { store } = storeWith(() =>
      jsonResponse(200, { files: [{ id: 'file-9', name: 'something-else.json' }] }),
    )
    expect(await store.read()).toBeNull()
  })

  it('surfaces an expired token as Unauthorized', async () => {
    const { store } = storeWith(() =>
      jsonResponse(401, { error: { code: 401, message: 'x', errors: [{ reason: 'authError' }] } }),
    )
    await expect(store.read()).rejects.toBeInstanceOf(Unauthorized)
  })
})

describe('write', () => {
  it('creates the pointer inside the app-data folder on first write', async () => {
    const { store, calls } = storeWith((url) =>
      url.startsWith(DRIVE_UPLOAD_URL)
        ? jsonResponse(200, { id: 'file-1' })
        : jsonResponse(200, { id: 'file-1' }),
    )
    const written = await store.write(null, 'cal-abc')

    const create = calls[0]!
    expect(create.url).toBe(`${DRIVE_FILES_URL}?fields=id`)
    expect(create.init.method).toBe('POST')
    expect(JSON.parse(String(create.init.body))).toEqual({
      name: APPDATA_FILE_NAME,
      parents: ['appDataFolder'],
    })

    const upload = calls[1]!
    expect(upload.url).toBe(`${DRIVE_UPLOAD_URL}/file-1?uploadType=media`)
    expect(upload.init.method).toBe('PATCH')
    expect(JSON.parse(String(upload.init.body))).toEqual({ calendarId: 'cal-abc' })

    expect(written).toEqual({ fileId: 'file-1', calendarId: 'cal-abc' })
  })

  it('overwrites the existing pointer rather than creating a second one', async () => {
    const { store, calls } = storeWith(() => jsonResponse(200, { id: 'file-1' }))
    const written = await store.write({ fileId: 'file-1', calendarId: null }, 'cal-new')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${DRIVE_UPLOAD_URL}/file-1?uploadType=media`)
    expect(written).toEqual({ fileId: 'file-1', calendarId: 'cal-new' })
  })
})
