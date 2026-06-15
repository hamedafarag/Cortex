import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ProviderRegistry,
  NoProviderAvailableError,
  registry as sharedRegistry,
  type Resolution,
} from './registry'
import type { LlmProvider } from './types'
import type { AskRequest, Chunk, ProviderId } from '../../shared/types'
import { setSettings } from '../../shared/storage'

const STORAGE_KEY = 'settings'

// A controllable stub implementing LlmProvider. `available` can be a boolean
// (resolved each call) or a function for dynamic / per-call answers. `ask` is a
// no-op async iterable since the registry never invokes it.
function makeProvider(
  id: ProviderId,
  available: boolean | (() => boolean | Promise<boolean>) = true,
): LlmProvider & { isAvailable: ReturnType<typeof vi.fn> } {
  const isAvailable = vi.fn(async () => {
    return typeof available === 'function' ? await available() : available
  })
  const ask = vi.fn(async function* (_req: AskRequest, _signal: AbortSignal): AsyncIterable<Chunk> {
    yield { type: 'done' }
  })
  return { id, isAvailable, ask }
}

/** Persist the preferred provider that getSettings() (and thus resolve()) will read. */
async function setPreferred(provider: ProviderId): Promise<void> {
  await setSettings({ provider })
}

describe('ProviderRegistry: register / get', () => {
  let reg: ProviderRegistry
  beforeEach(() => {
    reg = new ProviderRegistry()
  })

  it('get() returns undefined for an unregistered id', () => {
    expect(reg.get('anthropic-api')).toBeUndefined()
  })

  it('register() makes a provider retrievable by its id', () => {
    const p = makeProvider('anthropic-api')
    reg.register(p)
    expect(reg.get('anthropic-api')).toBe(p)
  })

  it('keys strictly by provider.id, not by registration order', () => {
    const api = makeProvider('anthropic-api')
    const cli = makeProvider('claude-code-cli')
    reg.register(api)
    reg.register(cli)
    expect(reg.get('anthropic-api')).toBe(api)
    expect(reg.get('claude-code-cli')).toBe(cli)
  })

  it('re-registering the same id overwrites the prior provider (last-write-wins)', () => {
    const first = makeProvider('anthropic-api')
    const second = makeProvider('anthropic-api')
    reg.register(first)
    reg.register(second)
    expect(reg.get('anthropic-api')).toBe(second)
    expect(reg.get('anthropic-api')).not.toBe(first)
  })

  it('register() does not call isAvailable or ask (registration is inert)', () => {
    const p = makeProvider('anthropic-api')
    reg.register(p)
    expect(p.isAvailable).not.toHaveBeenCalled()
    expect(p.ask as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })
})

describe('ProviderRegistry: resolve() — preferred is available', () => {
  let reg: ProviderRegistry
  beforeEach(() => {
    reg = new ProviderRegistry()
  })

  it('returns the preferred provider with usedFallback=false when it is available', async () => {
    const api = makeProvider('anthropic-api', true)
    const cli = makeProvider('claude-code-cli', true)
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    const res: Resolution = await reg.resolve()
    expect(res.provider).toBe(api)
    expect(res.preferredId).toBe('anthropic-api')
    expect(res.usedFallback).toBe(false)
  })

  it('honors the preferred even when the preferred is the second-registered provider', async () => {
    const api = makeProvider('anthropic-api', true)
    const cli = makeProvider('claude-code-cli', true)
    reg.register(api)
    reg.register(cli)
    await setPreferred('claude-code-cli')

    const res = await reg.resolve()
    expect(res.provider).toBe(cli)
    expect(res.preferredId).toBe('claude-code-cli')
    expect(res.usedFallback).toBe(false)
  })

  it('uses the DEFAULT settings provider (anthropic-api) when nothing is stored', async () => {
    const api = makeProvider('anthropic-api', true)
    reg.register(api)
    // No setSettings call → getSettings falls back to DEFAULT_SETTINGS.provider.

    const res = await reg.resolve()
    expect(res.preferredId).toBe('anthropic-api')
    expect(res.provider).toBe(api)
    expect(res.usedFallback).toBe(false)
  })

  it('does not consult other providers when the preferred is available (no needless availability probe)', async () => {
    const api = makeProvider('anthropic-api', true)
    const cli = makeProvider('claude-code-cli', true)
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    await reg.resolve()
    expect(api.isAvailable).toHaveBeenCalledTimes(1)
    // The fallback loop is never entered, so the other provider is never probed.
    expect(cli.isAvailable).not.toHaveBeenCalled()
  })
})

describe('ProviderRegistry: resolve() — fallback', () => {
  let reg: ProviderRegistry
  beforeEach(() => {
    reg = new ProviderRegistry()
  })

  it('falls back to the other available provider when the preferred is unavailable', async () => {
    const api = makeProvider('anthropic-api', false) // preferred, not ready
    const cli = makeProvider('claude-code-cli', true) // the only usable one
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    const res = await reg.resolve()
    expect(res.provider).toBe(cli)
    expect(res.preferredId).toBe('anthropic-api') // echoes what the user asked for
    expect(res.usedFallback).toBe(true)
  })

  it('falls back when the preferred id is registered but absent (preferred lookup misses)', async () => {
    // Only the CLI provider is registered, but the user prefers the API.
    const cli = makeProvider('claude-code-cli', true)
    reg.register(cli)
    await setPreferred('anthropic-api')

    const res = await reg.resolve()
    expect(res.provider).toBe(cli)
    expect(res.preferredId).toBe('anthropic-api')
    expect(res.usedFallback).toBe(true)
  })

  it('still probes the preferred provider before falling back', async () => {
    const api = makeProvider('anthropic-api', false)
    const cli = makeProvider('claude-code-cli', true)
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    await reg.resolve()
    // Preferred is checked first (and found unavailable), then the fallback.
    expect(api.isAvailable).toHaveBeenCalledTimes(1)
    expect(cli.isAvailable).toHaveBeenCalledTimes(1)
  })

  it('the fallback loop skips the preferred id even though it would re-check it', async () => {
    // api is preferred and unavailable; it is skipped by id in the loop (continue),
    // so its isAvailable is only invoked once (in the preferred check), not twice.
    const api = makeProvider('anthropic-api', false)
    const cli = makeProvider('claude-code-cli', true)
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    await reg.resolve()
    expect(api.isAvailable).toHaveBeenCalledTimes(1)
  })

  it('returns the FIRST-registered available fallback when several are available', async () => {
    // Three providers via re-registering ids is impossible (only 2 ids exist), so we
    // model insertion order with the two real ids: cli registered before api.
    const cli = makeProvider('claude-code-cli', true)
    const api = makeProvider('anthropic-api', true)
    reg.register(cli) // inserted first
    reg.register(api) // inserted second
    // Prefer a third, non-registered id is not possible; instead make the preferred
    // unavailable so the loop runs over insertion order.
    await setPreferred('anthropic-api')
    api.isAvailable.mockResolvedValue(false)

    const res = await reg.resolve()
    // The loop walks Map insertion order; cli was inserted first and is available.
    expect(res.provider).toBe(cli)
    expect(res.usedFallback).toBe(true)
  })

  it('a falsy preferred that is itself the only available provider still loses to nothing — falls through to error', async () => {
    // Preferred unavailable, and the only other provider is also unavailable → no resolution.
    const api = makeProvider('anthropic-api', false)
    const cli = makeProvider('claude-code-cli', false)
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    await expect(reg.resolve()).rejects.toBeInstanceOf(NoProviderAvailableError)
  })
})

describe('ProviderRegistry: resolve() — NoProviderAvailableError', () => {
  let reg: ProviderRegistry
  beforeEach(() => {
    reg = new ProviderRegistry()
  })

  it('throws when no providers are registered at all', async () => {
    await setPreferred('claude-code-cli')
    await expect(reg.resolve()).rejects.toBeInstanceOf(NoProviderAvailableError)
  })

  it('throws when every registered provider reports unavailable', async () => {
    reg.register(makeProvider('anthropic-api', false))
    reg.register(makeProvider('claude-code-cli', false))
    await setPreferred('anthropic-api')
    await expect(reg.resolve()).rejects.toBeInstanceOf(NoProviderAvailableError)
  })

  it('the thrown error carries the preferredId the user asked for', async () => {
    reg.register(makeProvider('anthropic-api', false))
    reg.register(makeProvider('claude-code-cli', false))
    await setPreferred('claude-code-cli')

    await expect(reg.resolve()).rejects.toMatchObject({
      name: 'NoProviderAvailableError',
      preferredId: 'claude-code-cli',
    })
  })

  it('the error is an Error subclass with a user-facing remediation message', async () => {
    await setPreferred('anthropic-api')
    let caught: unknown
    try {
      await reg.resolve()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(NoProviderAvailableError)
    expect(caught).toBeInstanceOf(Error)
    const err = caught as NoProviderAvailableError
    expect(err.message).toMatch(/No AI provider is available/i)
    expect(err.message).toMatch(/Anthropic API key/i)
    expect(err.message).toMatch(/native host/i)
    expect(err.preferredId).toBe('anthropic-api')
  })

  it('probes both providers before giving up (full sweep on the way to the error)', async () => {
    const api = makeProvider('anthropic-api', false)
    const cli = makeProvider('claude-code-cli', false)
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    await expect(reg.resolve()).rejects.toThrow()
    expect(api.isAvailable).toHaveBeenCalledTimes(1) // preferred check
    expect(cli.isAvailable).toHaveBeenCalledTimes(1) // fallback loop check
  })
})

describe('ProviderRegistry: resolve() — async availability semantics', () => {
  let reg: ProviderRegistry
  beforeEach(() => {
    reg = new ProviderRegistry()
  })

  it('awaits the preferred provider isAvailable() promise (async true => used directly)', async () => {
    const api = makeProvider('anthropic-api', async () => {
      // Simulate a real async probe.
      await Promise.resolve()
      return true
    })
    reg.register(api)
    await setPreferred('anthropic-api')

    const res = await reg.resolve()
    expect(res.provider).toBe(api)
    expect(res.usedFallback).toBe(false)
  })

  it('awaits the fallback provider isAvailable() promise (async true => fallback used)', async () => {
    const api = makeProvider('anthropic-api', async () => false)
    const cli = makeProvider('claude-code-cli', async () => {
      await Promise.resolve()
      return true
    })
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    const res = await reg.resolve()
    expect(res.provider).toBe(cli)
    expect(res.usedFallback).toBe(true)
  })

  it('re-evaluates availability on each resolve() call (no caching of a prior answer)', async () => {
    let ready = false
    const api = makeProvider('anthropic-api', () => ready)
    reg.register(api)
    await setPreferred('anthropic-api')

    // First resolve: unavailable, no fallback registered → throws.
    await expect(reg.resolve()).rejects.toBeInstanceOf(NoProviderAvailableError)

    // Flip availability and resolve again: now it resolves to the same provider.
    ready = true
    const res = await reg.resolve()
    expect(res.provider).toBe(api)
    expect(res.usedFallback).toBe(false)
    expect(api.isAvailable).toHaveBeenCalledTimes(2)
  })

  it('reads the CURRENT stored preferred provider each call (settings change between calls)', async () => {
    const api = makeProvider('anthropic-api', true)
    const cli = makeProvider('claude-code-cli', true)
    reg.register(api)
    reg.register(cli)

    await setPreferred('anthropic-api')
    expect((await reg.resolve()).provider).toBe(api)

    await setPreferred('claude-code-cli')
    expect((await reg.resolve()).provider).toBe(cli)
  })
})

describe('ProviderRegistry: resolve() — additional await / ordering guards', () => {
  let reg: ProviderRegistry
  beforeEach(() => {
    reg = new ProviderRegistry()
  })

  it('awaits an async-false fallback probe and does NOT mistake the pending promise for truthy', async () => {
    // Guards against `if (candidate.isAvailable())` (missing await) in the loop:
    // an un-awaited promise is always truthy, which would wrongly resolve to `cli`.
    const api = makeProvider('anthropic-api', async () => false) // preferred, unavailable
    const cli = makeProvider('claude-code-cli', async () => false) // fallback, unavailable
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    await expect(reg.resolve()).rejects.toBeInstanceOf(NoProviderAvailableError)
    expect(cli.isAvailable).toHaveBeenCalledTimes(1)
  })

  it('preferred (available) wins over an earlier-inserted, also-available, non-preferred provider', async () => {
    // cli is inserted FIRST and is available; if resolve() walked insertion order instead of
    // honoring the preferred lookup, it would wrongly return cli. The preferred must win.
    const cli = makeProvider('claude-code-cli', true)
    const api = makeProvider('anthropic-api', true)
    reg.register(cli) // first in insertion order
    reg.register(api) // second
    await setPreferred('anthropic-api')

    const res = await reg.resolve()
    expect(res.provider).toBe(api)
    expect(res.usedFallback).toBe(false)
    // The fallback loop is never entered, so the earlier-inserted provider is never probed.
    expect(cli.isAvailable).not.toHaveBeenCalled()
  })

  it('stops at the FIRST available fallback and does not over-probe once a winner is found', async () => {
    // Preferred is registered+unavailable; the very next provider in the loop is available,
    // so resolve() must short-circuit there. With only two ids this proves the loop returns
    // eagerly rather than draining every entry.
    const api = makeProvider('anthropic-api', false)
    const cli = makeProvider('claude-code-cli', true)
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    const res = await reg.resolve()
    expect(res.provider).toBe(cli)
    expect(cli.isAvailable).toHaveBeenCalledTimes(1)
  })

  it('returns a clean Resolution shape (provider, preferredId, usedFallback) with no leaked keys', async () => {
    const api = makeProvider('anthropic-api', true)
    reg.register(api)
    await setPreferred('anthropic-api')

    const res = await reg.resolve()
    expect(Object.keys(res).sort()).toEqual(['preferredId', 'provider', 'usedFallback'])
  })

  it('a throwing fallback probe propagates (rejection is not swallowed into NoProviderAvailableError)', async () => {
    // Preferred unavailable; the fallback probe throws. The raw error must surface, not be
    // masked by a "no provider available" error.
    const api = makeProvider('anthropic-api', false)
    const cli = makeProvider('claude-code-cli', () => {
      throw new Error('fallback probe failed')
    })
    reg.register(api)
    reg.register(cli)
    await setPreferred('anthropic-api')

    await expect(reg.resolve()).rejects.toThrow('fallback probe failed')
  })
})

describe('ProviderRegistry: resolve() — propagation of getSettings failure', () => {
  it('propagates a rejection from getSettings (storage read error)', async () => {
    const reg = new ProviderRegistry()
    reg.register(makeProvider('anthropic-api', true))

    const getMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>
    getMock.mockRejectedValueOnce(new Error('storage exploded'))

    await expect(reg.resolve()).rejects.toThrow('storage exploded')
  })

  it('propagates a rejection from a provider isAvailable() probe', async () => {
    const reg = new ProviderRegistry()
    const api = makeProvider('anthropic-api', () => {
      throw new Error('probe failed')
    })
    reg.register(api)
    await setPreferred('anthropic-api')

    await expect(reg.resolve()).rejects.toThrow('probe failed')
  })
})

describe('shared registry singleton', () => {
  beforeEach(() => {
    // The shared instance persists across tests within a file; clear its providers via the
    // private map so each test starts clean. (No public unregister API exists.)
    const map = (sharedRegistry as unknown as { providers: Map<ProviderId, LlmProvider> }).providers
    map.clear()
  })

  it('is a ProviderRegistry instance', () => {
    expect(sharedRegistry).toBeInstanceOf(ProviderRegistry)
  })

  it('supports the same register/get/resolve contract', async () => {
    const api = makeProvider('anthropic-api', true)
    sharedRegistry.register(api)
    await setSettings({ provider: 'anthropic-api' })

    expect(sharedRegistry.get('anthropic-api')).toBe(api)
    const res = await sharedRegistry.resolve()
    expect(res.provider).toBe(api)
    expect(res.usedFallback).toBe(false)
  })
})
