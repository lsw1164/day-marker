import { readError, toError } from '@/google/errors'

export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
/** Drive splits metadata and bytes across two hosts; content goes to /upload. */
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'

export const APPDATA_FILE_NAME = 'day-marker.json'

export interface Pointer {
  /**
   * The Drive file holding the pointer. Carried back into `write` so a rewrite
   * reuses the file instead of leaving an orphan beside a fresh one.
   */
  fileId: string
  /** null when the file exists but holds nothing usable — see `read`. */
  calendarId: string | null
}

export interface AppDataStore {
  read(): Promise<Pointer | null>
  write(existing: Pointer | null, calendarId: string): Promise<Pointer>
}

interface DriveFile {
  id?: string
  name?: string
}

/**
 * The app's own hidden folder in the user's Drive, holding one small JSON file:
 * the ID of the calendar this app created for them.
 *
 * It exists because `calendar.app.created` is not an accepted scope on
 * `calendarList.list` — there is no way to ask Google "which calendar did I make
 * for this user?". Storing the answer in the user's account rather than in the
 * browser is what keeps a registration findable from a second device, and what
 * keeps the promise that the app has no backend and no database.
 */
export function createAppDataStore(
  getToken: () => string,
  fetchImpl: typeof fetch = fetch,
): AppDataStore {
  async function request(
    url: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
  ): Promise<Response> {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const { reason, detail } = await readError(response)
      throw toError(response.status, reason, detail)
    }
    return response
  }

  return {
    async read() {
      const listed = (await (
        await request(
          `${DRIVE_FILES_URL}?spaces=appDataFolder&fields=files(id,name)&pageSize=100`,
          'GET',
        )
      ).json()) as { files?: DriveFile[] }

      const file = listed.files?.find((f) => f.name === APPDATA_FILE_NAME)
      if (!file?.id) return null

      const body = await (await request(`${DRIVE_FILES_URL}/${file.id}?alt=media`, 'GET')).text()
      // A body that will not parse, or parses to something without a calendar ID,
      // is an interrupted first run rather than a missing pointer. Report the
      // file so the caller overwrites it; claiming "nothing here" would have the
      // next write create a second file in the same folder.
      let calendarId: string | null = null
      try {
        const parsed: unknown = JSON.parse(body)
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof (parsed as { calendarId?: unknown }).calendarId === 'string'
        ) {
          calendarId = (parsed as { calendarId: string }).calendarId
        }
      } catch {
        calendarId = null
      }
      return { fileId: file.id, calendarId }
    },

    async write(existing, calendarId) {
      let fileId = existing?.fileId
      if (!fileId) {
        // Metadata first, bytes second. A single multipart upload would save one
        // round trip at the cost of hand-rolling a MIME boundary; the extra
        // request happens once per user, and `read` already handles the window
        // between the two calls.
        const created = (await (
          await request(`${DRIVE_FILES_URL}?fields=id`, 'POST', {
            name: APPDATA_FILE_NAME,
            parents: ['appDataFolder'],
          })
        ).json()) as DriveFile
        if (!created.id) throw new Error('Drive created the app-data file without an ID')
        fileId = created.id
      }

      await request(`${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media`, 'PATCH', { calendarId })
      return { fileId, calendarId }
    },
  }
}
