import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  getSettings,
  setSettings,
  onSettingsChanged,
  type Settings,
} from './storage'
import { chromeStore, emitStorageChange } from '../../test/setup'

const STORAGE_KEY = 'settings'

describe('storage: getSettings', () => {
  it('returns DEFAULT_SETTINGS verbatim when nothing is stored', async () => {
    const result = await getSettings()
    expect(result).toEqual(DEFAULT_SETTINGS)
  })

  it('does not return the DEFAULT_SETTINGS object reference (fresh merge each call)', async () => {
    const result = await getSettings()
    expect(result).not.toBe(DEFAULT_SETTINGS)
    // Mutating the result must not corrupt the shared default.
    result.model = 'mutated'
    expect(DEFAULT_SETTINGS.model).toBe('claude-opus-4-8')
  })

  it('fills missing fields from defaults while stored fields win', async () => {
    chromeStore.set(STORAGE_KEY, { anthropicApiKey: 'sk-stored', model: 'claude-custom' })
    const result = await getSettings()
    expect(result).toEqual({
      provider: 'anthropic-api', // from default (missing in stored)
      anthropicApiKey: 'sk-stored', // stored wins
      model: 'claude-custom', // stored wins
      githubPat: '', // from default (missing in stored)
    })
  })

  it('lets a fully-specified stored object override every default field', async () => {
    const full: Settings = {
      provider: 'claude-code-cli',
      anthropicApiKey: 'sk-abc',
      model: 'claude-sonnet',
      githubPat: 'ghp_xyz',
    }
    chromeStore.set(STORAGE_KEY, full)
    const result = await getSettings()
    expect(result).toEqual(full)
  })

  it('preserves falsy-but-present stored values (empty string overrides a non-empty default)', async () => {
    // model defaults to a non-empty string; an explicit '' must survive the merge.
    chromeStore.set(STORAGE_KEY, { model: '' })
    const result = await getSettings()
    expect(result.model).toBe('')
  })

  it('reads under the exact STORAGE_KEY "settings" and ignores unrelated keys', async () => {
    chromeStore.set('other', { provider: 'claude-code-cli' })
    chromeStore.set(STORAGE_KEY, { provider: 'claude-code-cli' })
    const result = await getSettings()
    expect(result.provider).toBe('claude-code-cli')
    // Confirm get was asked for the settings key specifically.
    const getMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>
    expect(getMock).toHaveBeenCalledWith(STORAGE_KEY)
  })

  it('treats undefined-keyed extra props on the partial as overriding defaults (spread semantics)', async () => {
    // A stored partial that explicitly sets provider to undefined would override the default
    // to undefined under spread semantics. Documenting current behavior.
    chromeStore.set(STORAGE_KEY, { provider: undefined as unknown as Settings['provider'] })
    const result = await getSettings()
    expect(result.provider).toBeUndefined()
  })
})

describe('storage: setSettings', () => {
  it('merges a patch over defaults when store is empty, persists, and returns the merge', async () => {
    const result = await setSettings({ anthropicApiKey: 'sk-new' })
    expect(result).toEqual({
      provider: 'anthropic-api',
      anthropicApiKey: 'sk-new',
      model: 'claude-opus-4-8',
      githubPat: '',
    })
    // Persisted under the settings key with the full merged object.
    expect(chromeStore.get(STORAGE_KEY)).toEqual(result)
  })

  it('merges a patch over previously-stored settings (existing fields preserved)', async () => {
    chromeStore.set(STORAGE_KEY, {
      provider: 'claude-code-cli',
      anthropicApiKey: 'sk-old',
      model: 'claude-old',
      githubPat: 'ghp_old',
    } satisfies Settings)

    const result = await setSettings({ model: 'claude-new' })
    expect(result).toEqual({
      provider: 'claude-code-cli', // preserved
      anthropicApiKey: 'sk-old', // preserved
      model: 'claude-new', // patched
      githubPat: 'ghp_old', // preserved
    })
    expect(chromeStore.get(STORAGE_KEY)).toEqual(result)
  })

  it('writes exactly once to chrome.storage.local.set with the merged object under the key', async () => {
    const setMock = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>
    const result = await setSettings({ githubPat: 'ghp_set' })
    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith({ [STORAGE_KEY]: result })
  })

  it('an empty patch persists the defaults (no-op patch still writes the full merge)', async () => {
    const result = await setSettings({})
    expect(result).toEqual(DEFAULT_SETTINGS)
    expect(chromeStore.get(STORAGE_KEY)).toEqual(DEFAULT_SETTINGS)
  })

  it('later setSettings calls accumulate (read-merge-write round trips)', async () => {
    await setSettings({ anthropicApiKey: 'sk-1' })
    await setSettings({ githubPat: 'ghp_2' })
    const result = await setSettings({ model: 'm3' })
    expect(result).toEqual({
      provider: 'anthropic-api',
      anthropicApiKey: 'sk-1',
      model: 'm3',
      githubPat: 'ghp_2',
    })
  })

  it('a patch field overrides a stored value of the same field', async () => {
    chromeStore.set(STORAGE_KEY, { anthropicApiKey: 'sk-old' })
    const result = await setSettings({ anthropicApiKey: 'sk-override' })
    expect(result.anthropicApiKey).toBe('sk-override')
  })

  it('round-trips: getSettings after setSettings reflects the persisted merge', async () => {
    await setSettings({ provider: 'claude-code-cli', githubPat: 'ghp_rt' })
    const read = await getSettings()
    expect(read).toEqual({
      provider: 'claude-code-cli',
      anthropicApiKey: '',
      model: 'claude-opus-4-8',
      githubPat: 'ghp_rt',
    })
  })
})

describe('storage: onSettingsChanged', () => {
  it('fires with merged-over-defaults settings on a local "settings" change', () => {
    const cb = vi.fn()
    onSettingsChanged(cb)

    emitStorageChange(
      { [STORAGE_KEY]: { oldValue: undefined, newValue: { anthropicApiKey: 'sk-evt' } } },
      'local',
    )

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({
      provider: 'anthropic-api',
      anthropicApiKey: 'sk-evt', // from event newValue
      model: 'claude-opus-4-8', // backfilled default
      githubPat: '', // backfilled default
    })
  })

  it('passes a full stored object straight through (every field overridden)', () => {
    const cb = vi.fn()
    onSettingsChanged(cb)
    const newValue: Settings = {
      provider: 'claude-code-cli',
      anthropicApiKey: 'sk-full',
      model: 'claude-x',
      githubPat: 'ghp_full',
    }
    emitStorageChange({ [STORAGE_KEY]: { oldValue: undefined, newValue } }, 'local')
    expect(cb).toHaveBeenCalledWith(newValue)
  })

  it('uses defaults when the change has no newValue (e.g. a removal)', () => {
    const cb = vi.fn()
    onSettingsChanged(cb)
    emitStorageChange({ [STORAGE_KEY]: { oldValue: { model: 'm' }, newValue: undefined } }, 'local')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(DEFAULT_SETTINGS)
  })

  it('ignores changes from a non-local area', () => {
    const cb = vi.fn()
    onSettingsChanged(cb)
    emitStorageChange(
      { [STORAGE_KEY]: { oldValue: undefined, newValue: { model: 'm' } } },
      'sync',
    )
    expect(cb).not.toHaveBeenCalled()
  })

  it('ignores local changes that do not touch the "settings" key', () => {
    const cb = vi.fn()
    onSettingsChanged(cb)
    emitStorageChange(
      { someOtherKey: { oldValue: undefined, newValue: { x: 1 } } },
      'local',
    )
    expect(cb).not.toHaveBeenCalled()
  })

  it('fires when the settings key is one of several changed keys in a local event', () => {
    const cb = vi.fn()
    onSettingsChanged(cb)
    emitStorageChange(
      {
        unrelated: { oldValue: 1, newValue: 2 },
        [STORAGE_KEY]: { oldValue: undefined, newValue: { provider: 'claude-code-cli' } },
      },
      'local',
    )
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].provider).toBe('claude-code-cli')
  })

  it('registers the listener via chrome.storage.onChanged.addListener', () => {
    const addMock = chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    const before = addMock.mock.calls.length
    onSettingsChanged(vi.fn())
    expect(addMock.mock.calls.length).toBe(before + 1)
  })

  it('the returned unsubscribe removes the listener so it no longer fires', () => {
    const cb = vi.fn()
    const unsubscribe = onSettingsChanged(cb)

    // Sanity: fires while subscribed.
    emitStorageChange(
      { [STORAGE_KEY]: { oldValue: undefined, newValue: { model: 'm1' } } },
      'local',
    )
    expect(cb).toHaveBeenCalledTimes(1)

    unsubscribe()

    emitStorageChange(
      { [STORAGE_KEY]: { oldValue: undefined, newValue: { model: 'm2' } } },
      'local',
    )
    // Still only the one call from before unsubscribing.
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe calls chrome.storage.onChanged.removeListener with the same listener', () => {
    const addMock = chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    const removeMock = chrome.storage.onChanged
      .removeListener as unknown as ReturnType<typeof vi.fn>

    const unsubscribe = onSettingsChanged(vi.fn())
    const registered = addMock.mock.calls.at(-1)?.[0]

    unsubscribe()
    expect(removeMock).toHaveBeenCalledWith(registered)
  })

  it('supports multiple independent subscribers; unsubscribing one leaves the other live', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = onSettingsChanged(a)
    onSettingsChanged(b)

    unsubA()

    emitStorageChange(
      { [STORAGE_KEY]: { oldValue: undefined, newValue: { model: 'shared' } } },
      'local',
    )
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('fires for a real setSettings write (set emits a local change event)', async () => {
    const cb = vi.fn()
    onSettingsChanged(cb)
    await setSettings({ provider: 'claude-code-cli' })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toEqual({
      provider: 'claude-code-cli',
      anthropicApiKey: '',
      model: 'claude-opus-4-8',
      githubPat: '',
    })
  })

  it('the change-event newValue from a real setSettings carries the FULL merged object', async () => {
    // The listener relies on newValue being (effectively) complete; setSettings always
    // persists the whole merged Settings, so subscribers never see a partial object in practice.
    let captured: unknown
    chrome.storage.onChanged.addListener(
      (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === 'local' && changes[STORAGE_KEY]) captured = changes[STORAGE_KEY].newValue
      },
    )
    await setSettings({ githubPat: 'ghp_full_obj' })
    expect(captured).toEqual({
      provider: 'anthropic-api',
      anthropicApiKey: '',
      model: 'claude-opus-4-8',
      githubPat: 'ghp_full_obj',
    })
  })
})

// Gaps the original suite missed: error/rejection propagation and store isolation.
describe('storage: error paths and isolation', () => {
  it('getSettings rejects (does not swallow) when chrome.storage.local.get rejects', async () => {
    const getMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>
    getMock.mockRejectedValueOnce(new Error('get failed'))
    await expect(getSettings()).rejects.toThrow('get failed')
  })

  it('setSettings rejects (does not swallow) when chrome.storage.local.set rejects', async () => {
    const setMock = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>
    setMock.mockRejectedValueOnce(new Error('set failed'))
    await expect(setSettings({ model: 'x' })).rejects.toThrow('set failed')
  })

  it('setSettings does not write when the underlying get rejects (no partial persistence)', async () => {
    const getMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>
    const setMock = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>
    getMock.mockRejectedValueOnce(new Error('get failed'))
    await expect(setSettings({ model: 'x' })).rejects.toThrow('get failed')
    // The merge needs the read first; a failed read must short-circuit the write.
    expect(setMock).not.toHaveBeenCalled()
  })

  it('setSettings leaves unrelated stored keys untouched (read-merge-write is scoped to "settings")', async () => {
    chromeStore.set('unrelated', { a: 1 })
    await setSettings({ model: 'scoped' })
    expect(chromeStore.get('unrelated')).toEqual({ a: 1 })
    expect((chromeStore.get(STORAGE_KEY) as Settings).model).toBe('scoped')
  })
})
