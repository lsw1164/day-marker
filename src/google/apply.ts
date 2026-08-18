import { buildEventPayload, type EventOptions } from '@/domain/eventPayload'
import type { CalendarApi } from '@/google/calendarApi'
import { Conflict, Unauthorized, isRetryable } from '@/google/errors'
import type { PlanItem } from '@/google/plan'
import { DEFAULT_RETRY_DEPS, withRetry, type RetryDeps } from '@/lib/backoff'
import { mapWithLimit } from '@/lib/mapWithLimit'

export type ItemOutcome = 'added' | 'updated' | 'restored' | 'skipped' | 'failed'

export interface ItemResult {
  item: PlanItem
  outcome: ItemOutcome
  error?: string
}

export const APPLY_CONCURRENCY = 3

export const HALTED_MESSAGE = 'Stopped after the Google connection expired'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function applyOne(
  api: CalendarApi,
  item: PlanItem,
  options: EventOptions,
): Promise<ItemOutcome> {
  const payload = buildEventPayload(item.eventId, item.milestone, options)

  if (item.status === 'deleted') {
    // A PATCH with status 'confirmed' revives a cancelled event.
    await api.patchEvent(item.eventId, payload)
    return 'restored'
  }

  if (item.status === 'exists') {
    if (!item.needsUpdate) return 'skipped'
    await api.patchEvent(item.eventId, payload)
    return 'updated'
  }

  if (item.status !== 'new') {
    // Exhaustiveness check: `item.status` is `never` here today. A fourth
    // PlanStatus would fail this assignment at compile time rather than silently
    // inheriting the insert below, which is almost certainly the wrong write.
    const unhandled: never = item.status
    throw new Error(`Unhandled plan status: ${String(unhandled)}`)
  }

  try {
    await api.insertEvent(payload)
    return 'added'
  } catch (error) {
    // Google reserves the IDs of deleted events, so a 404 at probe time can
    // still be a 409 here. Treat it as the update it actually is.
    if (error instanceof Conflict) {
      await api.patchEvent(item.eventId, payload)
      return 'updated'
    }
    throw error
  }
}

export async function applyPlan(
  api: CalendarApi,
  items: PlanItem[],
  options: EventOptions,
  onProgress: (result: ItemResult) => void,
  retryDeps: RetryDeps = DEFAULT_RETRY_DEPS,
  concurrency: number = APPLY_CONCURRENCY,
): Promise<ItemResult[]> {
  let halted = false

  const settled = await mapWithLimit(items, concurrency, async (item) => {
    if (halted) {
      const result: ItemResult = { item, outcome: 'failed', error: HALTED_MESSAGE }
      onProgress(result)
      return result
    }
    let result: ItemResult
    try {
      const outcome = await withRetry(() => applyOne(api, item, options), isRetryable, retryDeps)
      result = { item, outcome }
    } catch (error) {
      // Losing the token invalidates every remaining write, so stop scheduling.
      if (error instanceof Unauthorized) halted = true
      result = { item, outcome: 'failed', error: describe(error) }
    }
    onProgress(result)
    return result
  })

  // onProgress runs exactly once per item, after its outcome is fully
  // decided, in every branch -- halted, success, and failure alike. A
  // callback that throws can therefore only reject that item's slot; it can
  // no longer run *during* outcome construction and have the catch above
  // swallow its exception and relabel a completed write as 'failed'. An
  // unconditional `as PromiseFulfilledResult<ItemResult>` on the settled
  // array would push `undefined` into React state and crash the result
  // screen, so surface the rejection instead, exactly as `buildPlan` does for
  // a failed probe.
  return settled.map((r) => {
    if (r.status === 'rejected') throw r.reason
    return r.value
  })
}
