import { describe, expect, it } from 'vitest'
import { createSessionHint, SESSION_HINT_KEY } from '@/google/session'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

function throwingStorage(): Storage {
  return {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
    removeItem: () => {
      throw new Error('denied')
    },
  } as unknown as Storage
}

describe('createSessionHint', () => {
  it('is absent before anything is remembered', () => {
    expect(createSessionHint(memoryStorage()).present()).toBe(false)
  })

  it('round-trips', () => {
    const hint = createSessionHint(memoryStorage())
    hint.remember()
    expect(hint.present()).toBe(true)
    hint.forget()
    expect(hint.present()).toBe(false)
  })

  it('stores a flag, never a credential', () => {
    // The property that makes this safe to persist at all. If this ever holds a
    // token, the reason the token lives in a closure has been thrown away.
    const storage = memoryStorage()
    createSessionHint(storage).remember()
    expect(storage.getItem(SESSION_HINT_KEY)).toBe('1')
  })

  it('reads absent when storage throws, rather than propagating', () => {
    // Blocked storage throws on access, not only on write. A hint we cannot read
    // is a hint we do not have, which costs one click -- not a crash on load.
    const hint = createSessionHint(throwingStorage())
    expect(hint.present()).toBe(false)
    expect(() => hint.remember()).not.toThrow()
    expect(() => hint.forget()).not.toThrow()
  })

  it('works with no storage at all', () => {
    const hint = createSessionHint(null)
    expect(hint.present()).toBe(false)
    expect(() => hint.remember()).not.toThrow()
  })
})
