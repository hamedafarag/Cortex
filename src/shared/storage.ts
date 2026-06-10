// Extension settings, persisted in chrome.storage.local.
//
// `local` (not `sync`) on purpose: the API key and (later) the GitHub PAT are
// secrets and must not be synced across machines. Note chrome.storage.local is
// not encrypted at rest — surfaced to the user in the options UI (task #13).

import type { ProviderId } from './types'

export interface Settings {
  /** Preferred AI backend; the registry falls back if it's unavailable. */
  provider: ProviderId
  /** User's own Anthropic API key (provider 'anthropic-api'). */
  anthropicApiKey: string
  /** Model id used for API calls. Confirm against live docs when wiring task #5. */
  model: string
  /** Fine-grained GitHub PAT for posting comments (Phase 2). Empty until then. */
  githubPat: string
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic-api',
  anthropicApiKey: '',
  model: 'claude-opus-4-8',
  githubPat: '',
}

const STORAGE_KEY = 'settings'

/** Read settings, merged over defaults so new fields always have a value. */
export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const partial = stored[STORAGE_KEY] as Partial<Settings> | undefined
  return { ...DEFAULT_SETTINGS, ...partial }
}

/** Merge a patch into the stored settings and return the result. */
export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
  return next
}

/** Subscribe to settings changes. Returns an unsubscribe function. */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return
    const next = changes[STORAGE_KEY].newValue as Partial<Settings> | undefined
    cb({ ...DEFAULT_SETTINGS, ...next })
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
