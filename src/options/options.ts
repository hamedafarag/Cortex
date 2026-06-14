// Options page logic — provider toggle, API key, model. Persists to chrome.storage.local
// via the shared settings helpers, saving each field as it changes.

import { getSettings, setSettings, type Settings } from '../shared/storage'
import { icon } from '../content/dock/icons'

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const providerEl = byId<HTMLSelectElement>('provider')
const apiKeyEl = byId<HTMLInputElement>('apiKey')
const modelEl = byId<HTMLSelectElement>('model')
const githubPatEl = byId<HTMLInputElement>('githubPat')
const apiKeyField = byId<HTMLDivElement>('apiKeyField')
const cliHintEl = byId<HTMLDivElement>('cliHint')
const statusEl = byId<HTMLDivElement>('status')

let clearTimer: number | undefined
function flash(message: string): void {
  statusEl.innerHTML = `${icon('check', 13)}<span>${message}</span>`
  window.clearTimeout(clearTimer)
  clearTimer = window.setTimeout(() => statusEl.replaceChildren(), 1500)
}

/** Reflect the chosen backend in the UI: dim the API-key field when it doesn't apply, and show
 *  the native-host / repo link only for the Claude Code CLI backend. */
function syncApiKeyRelevance(): void {
  const isCli = providerEl.value === 'claude-code-cli'
  apiKeyField.classList.toggle('dimmed', providerEl.value !== 'anthropic-api')
  cliHintEl.hidden = !isCli
}

async function save(patch: Partial<Settings>): Promise<void> {
  await setSettings(patch)
  flash('Saved')
}

/** The CLI backend uses native messaging — an opt-in `optional_permissions` entry. Request it
 *  on selection (this change handler is a user gesture); revert to the API backend if denied. */
async function onProviderChange(): Promise<void> {
  const value = providerEl.value as Settings['provider']
  if (value === 'claude-code-cli') {
    const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] })
    if (!granted) {
      providerEl.value = 'anthropic-api'
      syncApiKeyRelevance()
      await save({ provider: 'anthropic-api' })
      flash('CLI backend needs the native-messaging permission')
      return
    }
  }
  syncApiKeyRelevance()
  await save({ provider: value })
}

async function init(): Promise<void> {
  byId<HTMLSpanElement>('version').textContent = `v${chrome.runtime.getManifest().version}`
  const settings = await getSettings()
  providerEl.value = settings.provider
  apiKeyEl.value = settings.anthropicApiKey
  modelEl.value = settings.model
  githubPatEl.value = settings.githubPat
  syncApiKeyRelevance()

  providerEl.addEventListener('change', () => void onProviderChange())
  modelEl.addEventListener('change', () => void save({ model: modelEl.value }))
  // Save secrets on commit (blur/Enter), not per keystroke.
  apiKeyEl.addEventListener('change', () => void save({ anthropicApiKey: apiKeyEl.value.trim() }))
  githubPatEl.addEventListener('change', () => void save({ githubPat: githubPatEl.value.trim() }))
}

void init()
