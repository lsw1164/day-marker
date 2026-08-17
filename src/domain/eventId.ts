import type { CalendarDate } from '@/domain/calendarDate'

/** RFC 4648 base32hex, lowercased: exactly the alphabet Google accepts for event IDs. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuv'

export const ID_PATTERN = /^[0-9a-v]{5,1024}$/

const PREFIX = 'dm'
const HASH_LENGTH = 30

export function base32hex(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      // charAt, not [i]: noUncheckedIndexedAccess would widen ALPHABET[i] to
      // string | undefined and the += would not typecheck.
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31)
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31)
  return out
}

/**
 * The ID depends on the start date and the milestone key ONLY. Never add a
 * parameter for title, label, reminder, range, or language: doing so would turn
 * an edit into a duplicate set of calendar events.
 */
export async function eventIdFor(start: CalendarDate, key: string): Promise<string> {
  const input = new TextEncoder().encode(`daymarker/v1/${start}/${key}`)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return PREFIX + base32hex(new Uint8Array(digest)).slice(0, HASH_LENGTH)
}
