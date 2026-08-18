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
//
// Written against `globalThis` rather than `window` (they are the same object
// in this jsdom test environment) because this file type-checks under
// tsconfig.node.json, which has no DOM lib and so has no `window` declared.
//
// A plain `!globalThis.matchMedia` guard would never fire: Vitest's jsdom
// environment mirrors every window property onto globalThis as an accessor,
// including ones jsdom leaves unimplemented, so `matchMedia` is already
// present as a getter that returns undefined. Checking the resolved type
// instead of presence is what lets us actually replace it.
const globalMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia
if (typeof globalMatchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
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
