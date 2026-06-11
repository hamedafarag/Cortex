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
  name: 'Your Code Review Assistant',
  version: '0.0.0',
  description: 'In-page AI copilot for reviewing GitHub pull requests.',

  permissions: ['storage', 'nativeMessaging'],
  host_permissions: [
    'https://github.com/*',
    'https://api.anthropic.com/*',
    'https://api.github.com/*',
  ],

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
    default_title: 'Your Code Review Assistant',
  },
})
