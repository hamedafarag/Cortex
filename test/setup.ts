// Global test setup: a faithful in-memory stub of the slice of the `chrome.*` API the
// extension actually uses (storage.local promises + onChanged, runtime ports/messaging,
// tabs.create). Re-created fresh before every test so state never leaks between tests.
//
// Tests can `import { chromeStore, emitStorageChange, makeChrome } from '../../test/setup'`
// (adjust the relative depth) to inspect the backing store or drive change events. Anything
// not modelled here can be overridden per-test with `vi.spyOn`/reassignment.

import { beforeEach, vi } from 'vitest'

type AnyObj = Record<string, unknown>

/** Backing store for chrome.storage.local — inspectable from tests, cleared each test. */
export const chromeStore = new Map<string, unknown>()
const changeListeners = new Set<(changes: AnyObj, area: string) => void>()

function getImpl(keys?: string | string[] | AnyObj | null): Promise<AnyObj> {
  const out: AnyObj = {}
  if (keys == null) {
    for (const [k, v] of chromeStore) out[k] = v
  } else if (typeof keys === 'string') {
    if (chromeStore.has(keys)) out[keys] = chromeStore.get(keys)
  } else if (Array.isArray(keys)) {
    for (const k of keys) if (chromeStore.has(k)) out[k] = chromeStore.get(k)
  } else {
    for (const k of Object.keys(keys)) out[k] = chromeStore.has(k) ? chromeStore.get(k) : keys[k]
  }
  return Promise.resolve(out)
}

function setImpl(items: AnyObj): Promise<void> {
  const changes: AnyObj = {}
  for (const k of Object.keys(items)) {
    changes[k] = { oldValue: chromeStore.get(k), newValue: items[k] }
    chromeStore.set(k, items[k])
  }
  emitStorageChange(changes, 'local')
  return Promise.resolve()
}

function removeImpl(keys: string | string[]): Promise<void> {
  const arr = Array.isArray(keys) ? keys : [keys]
  const changes: AnyObj = {}
  for (const k of arr) {
    changes[k] = { oldValue: chromeStore.get(k), newValue: undefined }
    chromeStore.delete(k)
  }
  emitStorageChange(changes, 'local')
  return Promise.resolve()
}

/** Fire a storage.onChanged event to all registered listeners (for onSettingsChanged tests). */
export function emitStorageChange(changes: AnyObj, area = 'local'): void {
  for (const l of changeListeners) l(changes, area)
}

/** Build a fresh chrome stub. Exposed so tests can construct an isolated one if needed. */
export function makeChrome() {
  return {
    storage: {
      local: {
        get: vi.fn(getImpl),
        set: vi.fn(setImpl),
        remove: vi.fn(removeImpl),
        clear: vi.fn(() => {
          chromeStore.clear()
          return Promise.resolve()
        }),
      },
      onChanged: {
        addListener: vi.fn((l: (changes: AnyObj, area: string) => void) => changeListeners.add(l)),
        removeListener: vi.fn((l: (changes: AnyObj, area: string) => void) =>
          changeListeners.delete(l),
        ),
      },
    },
    runtime: {
      lastError: undefined as { message: string } | undefined,
      id: 'test-ext-id',
      connect: vi.fn(),
      connectNative: vi.fn(),
      sendMessage: vi.fn(),
      onConnect: { addListener: vi.fn(), removeListener: vi.fn() },
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onMessageExternal: { addListener: vi.fn(), removeListener: vi.fn() },
      getURL: vi.fn((p: string) => `chrome-extension://test-ext-id/${p}`),
    },
    tabs: { create: vi.fn(() => Promise.resolve({ id: 1 })) },
  }
}

beforeEach(() => {
  chromeStore.clear()
  changeListeners.clear()
  ;(globalThis as { chrome?: unknown }).chrome = makeChrome()
})
