import { describe, expect, it } from 'vitest'
import { calendarDate } from '@/domain/calendarDate'
import { base32hex, eventIdFor, ID_PATTERN } from '@/domain/eventId'

const START = calendarDate('2026-01-01')

describe('base32hex', () => {
  it('uses only Google-legal characters', () => {
    const bytes = new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 8))
    expect(base32hex(bytes)).toMatch(/^[0-9a-v]+$/)
  })

  it('encodes RFC 4648 base32hex without padding', () => {
    // 'f' -> 0x66 -> base32hex 'co'
    expect(base32hex(new TextEncoder().encode('f'))).toBe('co')
    // 'foobar' is the RFC 4648 test vector 'CPNMUOJ1E8======' lowercased, unpadded.
    expect(base32hex(new TextEncoder().encode('foobar'))).toBe('cpnmuoj1e8')
  })
})

describe('eventIdFor', () => {
  it('is deterministic', async () => {
    const a = await eventIdFor(START, 'd100')
    const b = await eventIdFor(START, 'd100')
    expect(a).toBe(b)
  })

  it("matches Google's required charset and length", async () => {
    for (const key of ['d100', 'd1000', 'y1', 'y10']) {
      const id = await eventIdFor(START, key)
      expect(id).toMatch(ID_PATTERN)
      expect(id.length).toBeGreaterThanOrEqual(5)
      expect(id.length).toBeLessThanOrEqual(1024)
    }
  })

  it('differs per milestone key', async () => {
    const ids = await Promise.all(
      ['d100', 'd200', 'y1', 'y2'].map((k) => eventIdFor(START, k)),
    )
    expect(new Set(ids).size).toBe(4)
  })

  it('differs per start date', async () => {
    const a = await eventIdFor(START, 'd100')
    const b = await eventIdFor(calendarDate('2026-01-02'), 'd100')
    expect(a).not.toBe(b)
  })

  it('does not depend on anything but start date and key', async () => {
    // There is no third parameter by construction. This test documents the
    // constraint so a future signature change has to break it deliberately.
    // NOTE: arity alone is weak evidence — `(a, b) => Date.now()` also has
    // length 2. The golden test below is what actually pins the digest input.
    expect(eventIdFor.length).toBe(2)
  })

  // The golden test. Determinism tests only prove stability WITHIN one run;
  // nothing above would notice if the hash input format changed. Bumping
  // 'daymarker/v1/' to v2, swapping the start/key order, changing the
  // separator, or altering PREFIX/HASH_LENGTH would keep every other test
  // green while silently reassigning the ID of every milestone already in
  // every user's calendar — orphaning the old events and duplicating the set.
  //
  // These values were computed independently from the spec, not read back out
  // of the implementation. If one of them ever fails, do NOT update it to make
  // the suite pass: that failure means the ID derivation changed, and changing
  // it is a migration, not a refactor.
  it('pins the exact ID derivation', async () => {
    expect(await eventIdFor(START, 'd100')).toBe('dmusufolgh698n4mircpsr487stm1q6n')
    expect(await eventIdFor(START, 'y1')).toBe('dm5gk8fe9g3mbped70mkc928ssaksirg')
    expect(await eventIdFor(calendarDate('2025-03-14'), 'd100')).toBe(
      'dm8143fosu8qgh660f7f9c41r9k5882i',
    )
  })
})
