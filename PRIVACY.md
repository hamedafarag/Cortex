# Privacy Policy — Cortex, AI Review Assistant

_Last updated: 2026-06-14_

Cortex is a browser extension that adds an in-page AI copilot to GitHub pull-request pages.
It has **no backend server operated by us**. We do not collect, receive, store, sell, or share
any of your data. Everything happens between your browser, the services **you** configure, and
your local machine.

## What Cortex stores, and where

These are saved only in your browser's local extension storage (`chrome.storage.local`) on your
device. They are **never** synced across devices and **never** sent to us:

- **Anthropic API key** (if you use the Anthropic API backend).
- **GitHub personal access token** (if you post review comments).
- **Settings** (chosen backend, model).
- **Per-PR conversation history and unsent comment drafts**, so your work survives a reload.

Note: `chrome.storage.local` is not encrypted at rest. This is surfaced to you in the options page.

## What Cortex sends, to whom, and when

Cortex only transmits data **in response to an action you take** (asking a question, requesting a
summary/review/suggestion, or posting a comment):

- **To Anthropic (`api.anthropic.com`)** — when you use the Anthropic API backend: the code you
  selected, the surrounding diff hunk, the PR title/description, and (for whole-PR actions) the
  changed-file diffs, sent with **your** API key to generate a response.
- **To your local machine** — when you opt into the Claude Code CLI backend: the same content is
  sent to a native-messaging host you install, which runs your local `claude` CLI on your own
  subscription. This requires the optional `nativeMessaging` permission, requested only if you
  choose this backend.
- **To GitHub (`api.github.com`)** — to read PR metadata/diffs and, when you confirm, to post or
  delete review comments, using **your** GitHub token.

Before any code leaves the browser, Cortex runs a best-effort **secret-redaction** pass that masks
likely secrets (API keys, tokens, private-key blocks). This is a safety aid, not a guarantee —
review what you send.

The deterministic features (**Overview** change map, **Test gaps**) make **no AI call at all**.

## What Cortex does NOT do

- No analytics, telemetry, tracking, fingerprinting, or advertising.
- No third-party servers or SaaS middleman.
- No selling or sharing of data with anyone.
- No use of your data for any purpose other than fulfilling the action you requested.

## Permissions

- `storage` — save your settings/keys locally (above).
- `nativeMessaging` (**optional**, opt-in) — talk to the local Claude Code host if you choose that backend.
- Host access to `github.com`, `api.github.com`, `api.anthropic.com` — the only endpoints Cortex talks to.

## Contact

Questions: open an issue at the project repository.
