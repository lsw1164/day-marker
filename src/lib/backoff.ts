export interface RetryDeps {
  attempts: number
  baseMs: number
  sleep: (ms: number) => Promise<void>
  random: () => number
}

export const DEFAULT_RETRY_DEPS: RetryDeps = {
  attempts: 3,
  baseMs: 400,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
}

/**
 * Retries `fn` while `shouldRetry` accepts the error, backing off exponentially
 * with jitter. Sleeps only between attempts, never after the final one.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  deps: RetryDeps = DEFAULT_RETRY_DEPS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < deps.attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const isLast = attempt === deps.attempts - 1
      if (isLast || !shouldRetry(error)) throw error
      const jitter = 0.5 + deps.random() / 2
      await deps.sleep(Math.round(deps.baseMs * 2 ** attempt * jitter))
    }
  }
  throw lastError
}
