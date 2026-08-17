import { describe, expect, it } from 'vitest'
import { mapWithLimit } from '@/lib/mapWithLimit'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('mapWithLimit', () => {
  it('preserves input order regardless of completion order', async () => {
    const results = await mapWithLimit([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 10, 20])
  })

  it('passes the index to the callback', async () => {
    const results = await mapWithLimit(['a', 'b'], 2, async (item, i) => `${item}${i}`)
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual(['a0', 'b1'])
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let peak = 0
    await mapWithLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1))
      active -= 1
    })
    expect(peak).toBe(3)
  })

  it('reports a rejection without sinking its neighbours', async () => {
    const results = await mapWithLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(results[1]?.status).toBe('rejected')
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 })
  })

  it('starts a queued item as soon as a slot frees', async () => {
    const first = deferred<number>()
    const started: number[] = []
    const run = mapWithLimit([0, 1], 1, async (i) => {
      started.push(i)
      return i === 0 ? first.promise : i
    })
    await Promise.resolve()
    expect(started).toEqual([0])
    first.resolve(0)
    await run
    expect(started).toEqual([0, 1])
  })

  it('handles an empty list', async () => {
    expect(await mapWithLimit([], 3, async () => 1)).toEqual([])
  })
})
