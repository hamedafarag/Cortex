import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chromeStore } from '../../test/setup'
import {
  clearThread,
  loadThread,
  saveThread,
  threadKey,
  type PersistedThread,
  type StoredTurn,
  type ThreadState,
} from './persistence'
import type { DraftComment } from './types'

const PREFIX = 'thread:'
const INDEX_KEY = 'thread:index'
const MAX_THREADS = 50

/** A non-empty thread state (so saveThread actually persists rather than clearing). */
function makeState(over: Partial<ThreadState> = {}): ThreadState {
  return {
    turns: [{ role: 'user', content: 'hello' }],
    draft: '',
    review: [],
    ...over,
  }
}

const sampleTurns: StoredTurn[] = [
  { role: 'user', content: 'What does this do?', display: 'Ask · selection' },
  { role: 'assistant', content: 'It iterates the array.' },
]

const sampleReview: DraftComment[] = [
  { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'nit: rename this' },
  {
    path: 'src/b.ts',
    line: 40,
    side: 'RIGHT',
    startLine: 38,
    startSide: 'RIGHT',
    body: 'issue: off by one',
  },
]

function indexFromStore(): string[] {
  return (chromeStore.get(INDEX_KEY) as string[] | undefined) ?? []
}

describe('threadKey', () => {
  it('formats as "thread:<repo>#<prNumber>"', () => {
    expect(threadKey('octocat/hello', 7)).toBe('thread:octocat/hello#7')
  })

  it('uses the bare numeric prNumber (no padding/coercion artifacts)', () => {
    expect(threadKey('o/r', 0)).toBe('thread:o/r#0')
    expect(threadKey('o/r', 12345)).toBe('thread:o/r#12345')
  })

  it('produces distinct keys per repo and per PR', () => {
    const a = threadKey('owner/repo', 1)
    const b = threadKey('owner/repo', 2)
    const c = threadKey('owner/other', 1)
    expect(new Set([a, b, c]).size).toBe(3)
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  it('carries the "thread:" prefix and "#" separator', () => {
    const k = threadKey('a/b', 99)
    expect(k.startsWith(PREFIX)).toBe(true)
    expect(k).toContain('#99')
  })
})

describe('saveThread + loadThread round-trip', () => {
  it('persists turns, draft, and review and reads them back', async () => {
    const state = makeState({ turns: sampleTurns, draft: 'unsent text', review: sampleReview })
    await saveThread('owner/repo', 5, state)

    const got = await loadThread('owner/repo', 5)
    expect(got).not.toBeNull()
    expect(got!.turns).toEqual(sampleTurns)
    expect(got!.draft).toBe('unsent text')
    expect(got!.review).toEqual(sampleReview)
  })

  it('stamps savedAt with the current time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'))
    const now = Date.now()
    try {
      await saveThread('owner/repo', 5, makeState())
    } finally {
      vi.useRealTimers()
    }
    const got = await loadThread('owner/repo', 5)
    expect(got!.savedAt).toBe(now)
  })

  it('writes the record under the exact threadKey', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'hi' }))
    const key = threadKey('owner/repo', 5)
    expect(chromeStore.has(key)).toBe(true)
    const raw = chromeStore.get(key) as PersistedThread
    expect(raw.draft).toBe('hi')
    expect(typeof raw.savedAt).toBe('number')
  })

  it('overwrites a prior save for the same PR (no duplicate index entry)', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'first' }))
    await saveThread('owner/repo', 5, makeState({ draft: 'second' }))

    const got = await loadThread('owner/repo', 5)
    expect(got!.draft).toBe('second')

    const key = threadKey('owner/repo', 5)
    const idx = indexFromStore()
    expect(idx.filter((k) => k === key)).toHaveLength(1)
  })

  it('persists a draft-only thread (whitespace-trimmed draft still meaningful)', async () => {
    await saveThread('owner/repo', 5, { turns: [], draft: '  some draft  ', review: [] })
    const got = await loadThread('owner/repo', 5)
    expect(got).not.toBeNull()
    expect(got!.draft).toBe('  some draft  ')
  })

  it('persists a review-only thread (no turns, blank draft)', async () => {
    await saveThread('owner/repo', 5, { turns: [], draft: '', review: sampleReview })
    const got = await loadThread('owner/repo', 5)
    expect(got).not.toBeNull()
    expect(got!.review).toEqual(sampleReview)
  })
})

describe('loadThread for unknown keys', () => {
  it('returns null when nothing was ever saved', async () => {
    expect(await loadThread('owner/repo', 123)).toBeNull()
  })

  it('returns null for a different PR than the one saved', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'x' }))
    expect(await loadThread('owner/repo', 6)).toBeNull()
  })

  it('returns null for a different repo than the one saved', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'x' }))
    expect(await loadThread('owner/other', 5)).toBeNull()
  })
})

describe('empty-state handling', () => {
  it('does not persist a fully empty state (clears instead)', async () => {
    await saveThread('owner/repo', 5, { turns: [], draft: '', review: [] })
    expect(await loadThread('owner/repo', 5)).toBeNull()
    expect(chromeStore.has(threadKey('owner/repo', 5))).toBe(false)
  })

  it('treats a whitespace-only draft (with no turns/review) as empty', async () => {
    await saveThread('owner/repo', 5, { turns: [], draft: '   \n\t  ', review: [] })
    expect(await loadThread('owner/repo', 5)).toBeNull()
  })

  it('clears a previously-saved thread when re-saved as empty', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'something' }))
    expect(await loadThread('owner/repo', 5)).not.toBeNull()

    await saveThread('owner/repo', 5, { turns: [], draft: '', review: [] })
    expect(await loadThread('owner/repo', 5)).toBeNull()

    const key = threadKey('owner/repo', 5)
    expect(indexFromStore()).not.toContain(key)
  })
})

describe('clearThread', () => {
  it('removes a saved thread', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'x' }))
    expect(await loadThread('owner/repo', 5)).not.toBeNull()

    await clearThread('owner/repo', 5)
    expect(await loadThread('owner/repo', 5)).toBeNull()
    expect(chromeStore.has(threadKey('owner/repo', 5))).toBe(false)
  })

  it('drops the key from the LRU index', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'x' }))
    const key = threadKey('owner/repo', 5)
    expect(indexFromStore()).toContain(key)

    await clearThread('owner/repo', 5)
    expect(indexFromStore()).not.toContain(key)
  })

  it('is a no-op (no throw) for an unknown thread', async () => {
    await expect(clearThread('owner/repo', 999)).resolves.toBeUndefined()
    expect(await loadThread('owner/repo', 999)).toBeNull()
  })

  it('only removes the targeted thread, leaving siblings intact', async () => {
    await saveThread('owner/repo', 1, makeState({ draft: 'one' }))
    await saveThread('owner/repo', 2, makeState({ draft: 'two' }))

    await clearThread('owner/repo', 1)

    expect(await loadThread('owner/repo', 1)).toBeNull()
    const survivor = await loadThread('owner/repo', 2)
    expect(survivor!.draft).toBe('two')
    expect(indexFromStore()).toContain(threadKey('owner/repo', 2))
    expect(indexFromStore()).not.toContain(threadKey('owner/repo', 1))
  })

  it('does not rewrite the index when the cleared key is not in it (record-only orphan)', async () => {
    // Seed a sibling so the index is non-empty, then plant an orphan record whose key
    // was never indexed. clearThread should remove the record but leave the index untouched.
    await saveThread('owner/repo', 2, makeState({ draft: 'two' }))
    const orphanKey = threadKey('owner/repo', 1)
    chromeStore.set(orphanKey, { turns: [], draft: 'orphan', review: [], savedAt: 1 })
    expect(indexFromStore()).not.toContain(orphanKey)
    const setSpy = chrome.storage.local.set as ReturnType<typeof vi.fn>
    setSpy.mockClear()

    await clearThread('owner/repo', 1)

    // The orphan record is gone.
    expect(chromeStore.has(orphanKey)).toBe(false)
    // Index untouched (still just the sibling) and NOT re-written, since the key wasn't present.
    expect(indexFromStore()).toEqual([threadKey('owner/repo', 2)])
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('is idempotent: clearing the same thread twice still leaves it gone, no throw', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'x' }))
    await clearThread('owner/repo', 5)
    await expect(clearThread('owner/repo', 5)).resolves.toBeUndefined()
    expect(await loadThread('owner/repo', 5)).toBeNull()
    expect(indexFromStore()).not.toContain(threadKey('owner/repo', 5))
  })
})

describe('per-repo / per-PR isolation', () => {
  it('keeps distinct PRs in the same repo independent', async () => {
    await saveThread('owner/repo', 1, makeState({ draft: 'pr-one' }))
    await saveThread('owner/repo', 2, makeState({ draft: 'pr-two' }))

    expect((await loadThread('owner/repo', 1))!.draft).toBe('pr-one')
    expect((await loadThread('owner/repo', 2))!.draft).toBe('pr-two')
  })

  it('keeps the same PR number in different repos independent', async () => {
    await saveThread('owner/a', 7, makeState({ draft: 'repo-a' }))
    await saveThread('owner/b', 7, makeState({ draft: 'repo-b' }))

    expect((await loadThread('owner/a', 7))!.draft).toBe('repo-a')
    expect((await loadThread('owner/b', 7))!.draft).toBe('repo-b')
  })

  it('clearing one repo/PR does not affect another with the same PR number', async () => {
    await saveThread('owner/a', 7, makeState({ draft: 'repo-a' }))
    await saveThread('owner/b', 7, makeState({ draft: 'repo-b' }))

    await clearThread('owner/a', 7)

    expect(await loadThread('owner/a', 7)).toBeNull()
    expect((await loadThread('owner/b', 7))!.draft).toBe('repo-b')
  })
})

describe('LRU index management', () => {
  it('moves the most-recently-saved thread to the front of the index', async () => {
    await saveThread('owner/repo', 1, makeState({ draft: 'a' }))
    await saveThread('owner/repo', 2, makeState({ draft: 'b' }))
    await saveThread('owner/repo', 3, makeState({ draft: 'c' }))

    expect(indexFromStore()).toEqual([
      threadKey('owner/repo', 3),
      threadKey('owner/repo', 2),
      threadKey('owner/repo', 1),
    ])
  })

  it('re-saving an existing thread promotes it to the front without duplicating', async () => {
    await saveThread('owner/repo', 1, makeState({ draft: 'a' }))
    await saveThread('owner/repo', 2, makeState({ draft: 'b' }))
    await saveThread('owner/repo', 1, makeState({ draft: 'a2' }))

    expect(indexFromStore()).toEqual([
      threadKey('owner/repo', 1),
      threadKey('owner/repo', 2),
    ])
  })

  it('does not store the index under a real thread key (index key is excluded from threads)', async () => {
    await saveThread('owner/repo', 1, makeState())
    // The index lives under INDEX_KEY; loadThread of any PR must not collide with it.
    expect(INDEX_KEY).toBe(`${PREFIX}index`)
    expect(chromeStore.has(INDEX_KEY)).toBe(true)
  })

  it('caps the index at MAX_THREADS and evicts the oldest threads', async () => {
    // Save MAX_THREADS + 5 distinct PRs.
    const total = MAX_THREADS + 5
    for (let i = 1; i <= total; i++) {
      await saveThread('owner/repo', i, makeState({ draft: `d${i}` }))
    }

    const idx = indexFromStore()
    expect(idx).toHaveLength(MAX_THREADS)

    // The newest (last saved) must still be present and loadable.
    expect(idx[0]).toBe(threadKey('owner/repo', total))
    expect(await loadThread('owner/repo', total)).not.toBeNull()

    // The 5 oldest (PRs 1..5) should be evicted from the index AND removed from storage.
    for (let i = 1; i <= 5; i++) {
      const key = threadKey('owner/repo', i)
      expect(idx).not.toContain(key)
      expect(chromeStore.has(key)).toBe(false)
      expect(await loadThread('owner/repo', i)).toBeNull()
    }

    // PR 6 (the oldest survivor) should remain.
    expect(await loadThread('owner/repo', 6)).not.toBeNull()
  })

  it('exactly MAX_THREADS saves evicts nothing', async () => {
    for (let i = 1; i <= MAX_THREADS; i++) {
      await saveThread('owner/repo', i, makeState({ draft: `d${i}` }))
    }
    expect(indexFromStore()).toHaveLength(MAX_THREADS)
    // Every one of them is still loadable.
    for (let i = 1; i <= MAX_THREADS; i++) {
      expect(await loadThread('owner/repo', i)).not.toBeNull()
    }
  })

  it('promotes a thread from the MIDDLE of the index without duplicating or reordering siblings', async () => {
    // Build 1,2,3,4 -> index front is newest: [4,3,2,1]
    for (let i = 1; i <= 4; i++) await saveThread('owner/repo', i, makeState({ draft: `d${i}` }))
    expect(indexFromStore()).toEqual([4, 3, 2, 1].map((n) => threadKey('owner/repo', n)))

    // Re-save PR 2 (in the middle). It must jump to front; the rest keep their relative order.
    await saveThread('owner/repo', 2, makeState({ draft: 'd2-again' }))
    expect(indexFromStore()).toEqual([2, 4, 3, 1].map((n) => threadKey('owner/repo', n)))

    // No duplicate of PR 2.
    const k2 = threadKey('owner/repo', 2)
    expect(indexFromStore().filter((k) => k === k2)).toHaveLength(1)
    // And the content was actually updated.
    expect((await loadThread('owner/repo', 2))!.draft).toBe('d2-again')
  })

  it('re-saving an existing thread at full capacity evicts nothing and loses no thread', async () => {
    for (let i = 1; i <= MAX_THREADS; i++) {
      await saveThread('owner/repo', i, makeState({ draft: `d${i}` }))
    }
    // PR 1 is at the index tail; re-saving it must NOT push anything off the end,
    // because dedup keeps the index length at MAX_THREADS.
    await saveThread('owner/repo', 1, makeState({ draft: 'd1-again' }))

    const idx = indexFromStore()
    expect(idx).toHaveLength(MAX_THREADS)
    expect(idx[0]).toBe(threadKey('owner/repo', 1))
    // Every original thread is still loadable — nothing was wrongly evicted.
    for (let i = 1; i <= MAX_THREADS; i++) {
      expect(await loadThread('owner/repo', i)).not.toBeNull()
    }
  })

  it('evicts ALL of the oldest overflow past MAX_THREADS in one save, not just one', async () => {
    // Pre-seed exactly MAX_THREADS threads (PRs 1..MAX).
    for (let i = 1; i <= MAX_THREADS; i++) {
      await saveThread('owner/repo', i, makeState({ draft: `d${i}` }))
    }
    // A single new save pushes the index to MAX+1 pre-trim; exactly one tail entry (PR 1) evicts.
    await saveThread('owner/repo', 999, makeState({ draft: 'newest' }))
    const idx = indexFromStore()
    expect(idx).toHaveLength(MAX_THREADS)
    expect(idx[0]).toBe(threadKey('owner/repo', 999))
    // The single oldest (PR 1) is gone from index AND storage.
    expect(idx).not.toContain(threadKey('owner/repo', 1))
    expect(chromeStore.has(threadKey('owner/repo', 1))).toBe(false)
    expect(await loadThread('owner/repo', 1)).toBeNull()
    // PR 2 (next-oldest) survives.
    expect(await loadThread('owner/repo', 2)).not.toBeNull()
  })
})

describe('storage interaction (driving chrome.storage stub)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reads via chrome.storage.local.get on load', async () => {
    await loadThread('owner/repo', 5)
    expect(chrome.storage.local.get).toHaveBeenCalledWith(threadKey('owner/repo', 5))
  })

  it('writes via chrome.storage.local.set on save', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'x' }))
    const key = threadKey('owner/repo', 5)
    const setMock = chrome.storage.local.set as ReturnType<typeof vi.fn>
    // First set writes the record under the thread key.
    const wroteRecord = setMock.mock.calls.some(
      (c) => Object.prototype.hasOwnProperty.call(c[0], key),
    )
    expect(wroteRecord).toBe(true)
  })

  it('removes via chrome.storage.local.remove on clear', async () => {
    await saveThread('owner/repo', 5, makeState({ draft: 'x' }))
    ;(chrome.storage.local.remove as ReturnType<typeof vi.fn>).mockClear()
    await clearThread('owner/repo', 5)
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(threadKey('owner/repo', 5))
  })

  it('the persisted record carries exactly the ThreadState fields plus savedAt', async () => {
    await saveThread('owner/repo', 5, makeState({ turns: sampleTurns, draft: 'd', review: sampleReview }))
    const raw = chromeStore.get(threadKey('owner/repo', 5)) as PersistedThread
    expect(Object.keys(raw).sort()).toEqual(['draft', 'review', 'savedAt', 'turns'])
  })
})
