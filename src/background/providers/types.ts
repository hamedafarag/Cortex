// The provider abstraction: every AI backend implements this one interface so the
// background worker and dock never special-case which backend answered.

import type { AskRequest, Chunk, ProviderId } from '../../shared/types'

export interface LlmProvider {
  /** Stable identifier, matches Settings.provider. */
  readonly id: ProviderId

  /**
   * Whether this provider can currently serve a request — e.g. the API key is
   * set, or the native host is installed and reachable. The registry uses this
   * to fall back to the other provider when the preferred one isn't ready.
   */
  isAvailable(): Promise<boolean>

  /**
   * Stream an answer for `req`. Implementations must:
   *  - yield `{ type: 'text', delta }` for each segment,
   *  - end with `{ type: 'done' }` on success or `{ type: 'error', message }` on failure,
   *  - stop promptly when `signal` aborts.
   */
  ask(req: AskRequest, signal: AbortSignal): AsyncIterable<Chunk>
}
