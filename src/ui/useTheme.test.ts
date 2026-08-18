import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextChoice, THEME_KEY, useTheme } from '@/ui/useTheme'

/** Installs a controllable matchMedia and returns a handle to flip the OS. */
function fakeMedia(initialDark: boolean) {
  let matches = initialDark
  const listeners = new Set<() => void>()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      get matches() {
        return matches
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      dispatchEvent: () => false,
    }),
  })
  return {
    flip(toDark: boolean) {
      matches = toDark
      for (const l of [...listeners]) l()
    },
    listenerCount: () => listeners.size,
  }
}

afterEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})

describe('nextChoice', () => {
  it('cycles system → light → dark → system', () => {
    expect(nextChoice('system')).toBe('light')
    expect(nextChoice('light')).toBe('dark')
    expect(nextChoice('dark')).toBe('system')
  })
})

describe('useTheme', () => {
  it('defaults to system and follows a dark OS', () => {
    fakeMedia(true)
    const { result } = renderHook(() => useTheme())
    expect(result.current.choice).toBe('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('follows a light OS', () => {
    fakeMedia(false)
    renderHook(() => useTheme())
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('lets a stored choice beat the OS', () => {
    localStorage.setItem(THEME_KEY, 'light')
    fakeMedia(true)
    const { result } = renderHook(() => useTheme())
    expect(result.current.choice).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('persists an explicit choice', () => {
    fakeMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setChoice('dark'))
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('removes the key rather than storing "system", so fresh and reset browsers match', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    fakeMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setChoice('system'))
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('reacts when the OS flips while following it', () => {
    const media = fakeMedia(false)
    renderHook(() => useTheme())
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    act(() => media.flip(true))
    // A phone entering night mode must not leave the open tab in light.
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('stops following the OS once an explicit choice is made', () => {
    const media = fakeMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setChoice('light'))
    expect(media.listenerCount()).toBe(0)
    act(() => media.flip(true))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('survives localStorage throwing, as in private browsing', () => {
    fakeMedia(false)
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { result } = renderHook(() => useTheme())
    expect(result.current.choice).toBe('system')
    spy.mockRestore()
  })
})
