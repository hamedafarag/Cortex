import { defineManifest } from '@crxjs/vite-plugin'

// Fixed `key` → stable extension ID across reloads, required so the native-messaging
// host's `allowed_origins` keeps matching in dev.
//   Extension ID: cafladkeojdkaaehgajijjehaclhkdch
// Derived from key.pem (gitignored). The native host manifest's allowed_origins must be
//   chrome-extension://cafladkeojdkaaehgajijjehaclhkdch/
const KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0AkarlWZyZSRG6WFAKILaQ448UBgqJAya8bANktwqHLv2cnY9LF61/xKGPoiG5tTK8MP6xFmFOQucdJ8NSN3Lk/s7CcAszaNoCtSAPIdyRSfUy/z0kn3JvMr8yXqLmFyF2rfpDkBrfkiM3atnO7AWEmiiUUg1qEBRNrRlXWzwMe8HSIWfbWwoGqsRTFcblSjDa5seJlMTSg1DkrJiajhnw29GtLjwDuFa0ypsw3PjQdW9kdXa894VbzVZofpZ5EAYUJez0XGqtOUzxKpYaNiq1iV9EXgym4L1scrSMQ6I3KJRQyjlg9FNUeRPUK0tNZzuq6elGvN7FMa5R9RVIOJTQIDAQAB'

export default defineManifest({
  manifest_version: 3,
  key: KEY,
  name: 'Cortex — AI Review Assistant',
  version: '0.1.1',
  description:
    'In-page AI copilot for reviewing GitHub pull requests — on your own Claude ' +
    'subscription or API key. No SaaS middleman.',

  // `nativeMessaging` is opt-in (the Claude Code CLI backend): requested at runtime from the
  // options page only if the user chooses that backend, so the default install — Anthropic API
  // key only — carries the smallest permission surface.
  permissions: ['storage'],
  optional_permissions: ['nativeMessaging'],
  host_permissions: [
    'https://github.com/*',
    'https://api.anthropic.com/*',
    'https://api.github.com/*',
  ],

  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  content_scripts: [
    {
      // Match all of github.com; the content script detects PR pages itself
      // (GitHub is an SPA, so URL gating happens in JS, not the manifest).
      matches: ['https://github.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],

  options_page: 'src/options/options.html',

  action: {
    default_title: 'Cortex — AI Review Assistant',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
    },
  },
})
