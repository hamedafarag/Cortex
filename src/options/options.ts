// Options page logic — provider toggle, API key, model. Persists to chrome.storage.local
// via the shared settings helpers, saving each field as it changes.

import { getSettings, setSettings, type Settings } from '../shared/storage'

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const providerEl = byId<HTMLSelectElement>('provider')
const apiKeyEl = byId<HTMLInputElement>('apiKey')
const modelEl = byId<HTMLSelectElement>('model')
const apiKeyField = byId<HTMLDivElement>('apiKeyField')
const statusEl = byId<HTMLDivElement>('status')

let clearTimer: number | undefined
function flash(message: string): void {
  statusEl.textContent = message
  window.clearTimeout(clearTimer)
  clearTimer = window.setTimeout(() => (statusEl.textContent = ''), 1500)
}

/** Dim the API-key field when it doesn't apply to the chosen backend. */
function syncApiKeyRelevance(): void {
  apiKeyField.classList.toggle('dimmed', providerEl.value !== 'anthropic-api')
}

async function save(patch: Partial<Settings>): Promise<void> {
  await setSettings(patch)
  flash('Saved')
}

async function init(): Promise<void> {
  const settings = await getSettings()
  providerEl.value = settings.provider
  apiKeyEl.value = settings.anthropicApiKey
  modelEl.value = settings.model
  syncApiKeyRelevance()

  providerEl.addEventListener('change', () => {
    syncApiKeyRelevance()
    void save({ provider: providerEl.value as Settings['provider'] })
  })
  modelEl.addEventListener('change', () => void save({ model: modelEl.value }))
  // Save the key on commit (blur/Enter), not per keystroke.
  apiKeyEl.addEventListener('change', () => void save({ anthropicApiKey: apiKeyEl.value.trim() }))
}

void init()
