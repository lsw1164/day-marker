import { describe, expect, it, vi } from 'vitest'
import { withRetry, type RetryDeps } from '@/lib/backoff'

const deps: RetryDeps = {
  attempts: 3,
  baseMs: 100,
  sleep: async () => {},
  random: () => 0.5,
}

const always = () => true

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const sleep = vi.fn(async () => {})
    const result = await withRetry(async () => 'ok', always, { ...deps, sleep })
    expect(result).toBe('ok')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries a retryable failure and then succeeds', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new Error('transient')
        return 'ok'
      },
      always,
      deps,
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('gives up after the configured attempts and rethrows the last error', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw new Error(`fail ${calls}`)
        },
        always,
        deps,
      ),
    ).rejects.toThrow('fail 3')
    expect(calls).toBe(3)
  })

  it('does not retry when shouldRetry says no', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw new Error('permanent')
        },
        () => false,
        deps,
      ),
    ).rejects.toThrow('permanent')
    expect(calls).toBe(1)
  })

  it('backs off exponentially with jitter', async () => {
    const waits: number[] = []
    const sleep = vi.fn(async (ms: number) => {
      waits.push(ms)
    })
    await expect(
      withRetry(async () => { throw new Error('x') }, always, { ...deps, sleep }),
    ).rejects.toThrow()
    // base * 2^n, each scaled by (0.5 + random()/2) = 0.75 with random() = 0.5
    expect(waits).toEqual([75, 150])
  })
})
