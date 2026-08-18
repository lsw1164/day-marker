import { afterEach, describe, expect, it, vi } from 'vitest'
import indexHtml from '../../index.html?raw'

const THEME_KEY = 'dayMarker.theme'

/** Installs a controllable matchMedia, mirroring the helper in useTheme.test.ts. */
function fakeMedia(initialDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: initialDark,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

/**
 * Extracts and runs the bare, attribute-less <script> block from index.html —
 * the Google Identity script and the module entrypoint both carry attributes,
 * so this only ever matches the inline pre-paint theme script. Asserting
 * exactly one match means a second bare <script> added later fails this test
 * loudly instead of silently running the wrong block.
 */
function runInlineScript() {
  const matches = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  expect(matches).toHaveLength(1)
  const scriptText = matches[0]?.[1] ?? ''
  new Function(scriptText)()
}

afterEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})

describe('index.html inline theme script', () => {
  it('applies dark when stored is "dark" and the OS is light', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    fakeMedia(false)
    runInlineScript()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('stays light when stored is "light" and the OS is dark', () => {
    localStorage.setItem(THEME_KEY, 'light')
    fakeMedia(true)
    runInlineScript()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('follows a dark OS when nothing is stored', () => {
    fakeMedia(true)
    runInlineScript()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('follows a light OS when nothing is stored', () => {
    fakeMedia(false)
    runInlineScript()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('falls through to the OS for an unrecognised stored value', () => {
    localStorage.setItem(THEME_KEY, 'blue')
    fakeMedia(true)
    runInlineScript()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('follows a dark OS when localStorage.getItem throws, as in private browsing', () => {
    fakeMedia(true)
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    runInlineScript()
    spy.mockRestore()
    // Regression: the script used to wrap the OS check in the same try as the
    // storage read, so a throw skipped matchMedia entirely and painted light —
    // disagreeing with useTheme's own catch, which falls back to 'system'.
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
