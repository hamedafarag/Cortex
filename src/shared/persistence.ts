// Per-PR conversation persistence in chrome.storage.local, keyed by "repo#prNumber".
// Lets the dock restore the conversation thread + the unsent draft comment when the reviewer
// comes back to a PR (or after a reload / SPA navigation). Content scripts can use
// chrome.storage directly, so this runs in the content world alongside the dock.
//
// Stored under `thread:<repo>#<pr>`. A small LRU index (`thread:index`) caps how many PRs we
// keep so storage can't grow without bound; the oldest threads are evicted past MAX_THREADS.

import type { ChatMessage, DraftComment } from './types'

/** One finalized turn, with the dock's display label for user turns (e.g. "Review · Security"). */
export type StoredTurn = ChatMessage & { display?: string }

/** The persistable dock state for one PR. */
export interface ThreadState {
  /** Finalized conversation turns, oldest first. */
  turns: StoredTurn[]
  /** Unsent composer text. */
  draft: string
  /** Pending comments accumulated into a draft review (submitted as one via the Reviews API). */
  review: DraftComment[]
}

/** A stored thread plus the time it was last written (for LRU eviction). */
export interface PersistedThread extends ThreadState {
  savedAt: number
}

const PREFIX = 'thread:'
const INDEX_KEY = 'thread:index'
const MAX_THREADS = 50

/** Storage key for a PR's thread. */
export function threadKey(repo: string, prNumber: number): string {
  return `${PREFIX}${repo}#${prNumber}`
}

/** True if there's nothing worth persisting (no turns, blank draft, no pending review). */
function isEmpty(state: ThreadState): boolean {
  return (
    state.turns.length === 0 && state.draft.trim().length === 0 && state.review.length === 0
  )
}

/** Restore a PR's saved thread, or null if none. */
export async function loadThread(
  repo: string,
  prNumber: number,
): Promise<PersistedThread | null> {
  const key = threadKey(repo, prNumber)
  const got = await chrome.storage.local.get(key)
  return (got[key] as PersistedThread | undefined) ?? null
}

/** Save a PR's thread (or clear it if empty). Updates the LRU index and evicts the oldest
 *  threads past MAX_THREADS. Stamps `savedAt` with the current time. */
export async function saveThread(
  repo: string,
  prNumber: number,
  state: ThreadState,
): Promise<void> {
  if (isEmpty(state)) {
    await clearThread(repo, prNumber)
    return
  }
  const key = threadKey(repo, prNumber)
  const record: PersistedThread = {
    turns: state.turns,
    draft: state.draft,
    review: state.review,
    savedAt: Date.now(),
  }
  await chrome.storage.local.set({ [key]: record })

  // Move this key to the front of the LRU index; evict the tail.
  const idx = ((await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] as string[] | undefined) ?? []
  const next = [key, ...idx.filter((k) => k !== key)]
  const evicted = next.slice(MAX_THREADS)
  await chrome.storage.local.set({ [INDEX_KEY]: next.slice(0, MAX_THREADS) })
  if (evicted.length) await chrome.storage.local.remove(evicted)
}

/** Remove a PR's thread and drop it from the index. */
export async function clearThread(repo: string, prNumber: number): Promise<void> {
  const key = threadKey(repo, prNumber)
  await chrome.storage.local.remove(key)
  const idx = ((await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] as string[] | undefined) ?? []
  if (idx.includes(key)) {
    await chrome.storage.local.set({ [INDEX_KEY]: idx.filter((k) => k !== key) })
  }
}
