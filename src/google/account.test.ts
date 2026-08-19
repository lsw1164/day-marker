import { describe, expect, it, vi } from 'vitest'
import { createAccount, USERINFO_URL } from '@/google/account'
import { Unauthorized } from '@/google/errors'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function googleError(code: number, reason: string): unknown {
  return { error: { code, message: 'nope', errors: [{ reason }] } }
}

describe('createAccount', () => {
  it('asks the userinfo endpoint, bearing the current token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { email: 'a@example.com' }))
    const account = createAccount(() => 'tok-1', fetchImpl as unknown as typeof fetch)

    await expect(account.ensure()).resolves.toBe('a@example.com')
    expect(fetchImpl).toHaveBeenCalledWith(USERINFO_URL, {
      headers: { Authorization: 'Bearer tok-1' },
    })
  })

  it('reads the token per call, not once at construction', async () => {
    // The token is refreshed behind this module's back, so capturing it at
    // construction would send a dead one after the first hour.
    let token = 'first'
    // Params annotated so `mock.calls[1][1]` typechecks: a zero-argument
    // implementation infers an empty tuple, and indexing it is an error.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { email: 'a@example.com' }),
    )
    const account = createAccount(() => token, fetchImpl as unknown as typeof fetch)

    await account.ensure()
    account.forget()
    token = 'second'
    await account.ensure()

    expect(fetchImpl.mock.calls[1]?.[1]).toEqual({
      headers: { Authorization: 'Bearer second' },
    })
  })

  it('caches for the session', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { email: 'a@example.com' }))
    const account = createAccount(() => 'tok', fetchImpl as unknown as typeof fetch)

    await account.ensure()
    await account.ensure()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(account.email()).toBe('a@example.com')
  })

  it('shares one resolution between concurrent callers', async () => {
    // Both pages can call this on the same connect; two requests for one
    // immutable fact is waste, not a correctness problem, but it is free to fix.
    const fetchImpl = vi.fn(async () => jsonResponse(200, { email: 'a@example.com' }))
    const account = createAccount(() => 'tok', fetchImpl as unknown as typeof fetch)

    const [a, b] = await Promise.all([account.ensure(), account.ensure()])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect([a, b]).toEqual(['a@example.com', 'a@example.com'])
  })

  it('is empty until it succeeds', () => {
    const account = createAccount(() => 'tok', vi.fn() as unknown as typeof fetch)
    expect(account.email()).toBe('')
  })

  it('forgets, so the next connect can be a different account', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { email: 'first@example.com' }))
      .mockResolvedValueOnce(jsonResponse(200, { email: 'second@example.com' }))
    const account = createAccount(() => 'tok', fetchImpl as unknown as typeof fetch)

    await account.ensure()
    account.forget()
    expect(account.email()).toBe('')

    await expect(account.ensure()).resolves.toBe('second@example.com')
  })

  it('maps a failure onto the shared error types', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, googleError(401, 'authError')))
    const account = createAccount(() => 'dead', fetchImpl as unknown as typeof fetch)

    await expect(account.ensure()).rejects.toBeInstanceOf(Unauthorized)
  })

  it('treats a 200 with no email as a failure', async () => {
    // The realistic shape when the scope was not granted: the endpoint answers
    // successfully and simply omits the field. Resolving '' here would cache the
    // absence and stop the app ever asking again.
    const fetchImpl = vi.fn(async () => jsonResponse(200, { sub: '123' }))
    const account = createAccount(() => 'tok', fetchImpl as unknown as typeof fetch)

    await expect(account.ensure()).rejects.toThrow()
    expect(account.email()).toBe('')
  })

  it('does not cache a rejection', async () => {
    // A dropped connection should not make one blip permanent for the session.
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse(200, { email: 'a@example.com' }))
    const account = createAccount(() => 'tok', fetchImpl as unknown as typeof fetch)

    await expect(account.ensure()).rejects.toBeInstanceOf(TypeError)
    await expect(account.ensure()).resolves.toBe('a@example.com')
  })
})
