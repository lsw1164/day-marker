import '@testing-library/jest-dom/vitest'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  })
}

// jsdom does not implement matchMedia. Tests that care about the OS preference
// install their own controllable fake; this default stops every other test from
// throwing, exactly as the crypto.subtle block above does.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}
