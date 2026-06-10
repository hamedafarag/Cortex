// Holds the available providers and resolves which one serves a request:
// the user's preferred backend if it's available, otherwise the first other
// available one (so e.g. a missing native host transparently falls back to the
// API key, and vice-versa).

import type { ProviderId } from '../../shared/types'
import { getSettings } from '../../shared/storage'
import type { LlmProvider } from './types'

/** Thrown by resolve() when no registered provider is currently usable. */
export class NoProviderAvailableError extends Error {
  constructor(public readonly preferredId: ProviderId) {
    super(
      'No AI provider is available. Add your Anthropic API key, or install the ' +
        'Claude Code native host, in the extension options.',
    )
    this.name = 'NoProviderAvailableError'
  }
}

/** Outcome of resolving a provider for a request. */
export interface Resolution {
  provider: LlmProvider
  /** The provider the user asked for in settings. */
  preferredId: ProviderId
  /** True when the preferred provider was unavailable and we fell back. */
  usedFallback: boolean
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, LlmProvider>()

  register(provider: LlmProvider): void {
    this.providers.set(provider.id, provider)
  }

  get(id: ProviderId): LlmProvider | undefined {
    return this.providers.get(id)
  }

  /**
   * Pick a provider to serve the next request. Prefers Settings.provider when
   * available; otherwise falls back to any other available provider. Throws
   * NoProviderAvailableError if none are usable.
   */
  async resolve(): Promise<Resolution> {
    const { provider: preferredId } = await getSettings()

    const preferred = this.providers.get(preferredId)
    if (preferred && (await preferred.isAvailable())) {
      return { provider: preferred, preferredId, usedFallback: false }
    }

    for (const candidate of this.providers.values()) {
      if (candidate.id === preferredId) continue
      if (await candidate.isAvailable()) {
        return { provider: candidate, preferredId, usedFallback: true }
      }
    }

    throw new NoProviderAvailableError(preferredId)
  }
}

/** Shared instance; the background worker registers providers into this (task #9). */
export const registry = new ProviderRegistry()
