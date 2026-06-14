# Chrome Web Store — listing & submission guide

Everything needed to publish **Cortex — AI Review Assistant** to the Chrome Web Store.
Build the upload artifact with `npm run package` → `web-store/cortex-<version>.zip`.

> Target: **Chrome Web Store** (installable in Edge too, via "Allow extensions from other stores").
> Default backend is the **Anthropic API key**; the **Claude Code CLI** backend is opt-in
> (requests the `nativeMessaging` permission at runtime only when selected).

---

## Listing fields (copy into the dashboard)

**Item name**

```
Cortex — AI Review Assistant
```

**Summary** (≤132 chars)

```
An in-page AI copilot for GitHub pull requests — ask, summarize, review, and post comments. Your own Anthropic key. No SaaS middleman.
```

**Category:** Developer Tools  **Language:** English

**Detailed description**

```
Cortex adds an AI review copilot directly onto GitHub pull-request pages — no third-party SaaS, no data middleman. You bring your own Anthropic API key (or, opt-in, your local Claude Code CLI), and everything runs between your browser, Anthropic, and GitHub.

What you can do:
• Highlight code in a diff and ask about it — answers stream into a dock, grounded in the real diff and the PR's intent.
• Overview — a deterministic, no-AI change map: files changed, additions/deletions and net per file, with a churn bar and a by-module rollup so you see where the weight is.
• Summarize the PR — TL;DR, key changes, per-file gloss, and a 1–5 review-effort rating.
• Review the whole PR — a findings list with Blocker/Major/Minor/Nit/Praise severity chips, with optional Security / Performance / Error-handling / Readability lenses.
• Test gaps — a fast, no-AI heuristic flagging changed source files with no matching test change.
• Suggest a fix — a committable GitHub suggestion block for the selected lines.
• Turn any answer into a line-anchored review comment, with a confirm step and a 10-second undo.
• Build a batch review and submit it with a Comment / Approve / Request-changes verdict.
• Conventional Comments labels, canned snippets, and per-PR conversation memory.

Privacy by design:
• Your keys/token are stored locally and never synced or sent to us.
• Code is sent only to Anthropic (your key) or your local Claude CLI — only when you take an action.
• A secret-redaction pass masks likely secrets before anything is sent.
• No analytics, no tracking, no third-party servers.

Cortex is GitHub-only and human-in-the-loop: it never posts or reviews on its own.
```

**Privacy policy URL:** _host `PRIVACY.md` somewhere public (e.g. GitHub Pages or the repo's raw URL) and paste the link here._

---

## Single-purpose description (dashboard requires this)

```
Cortex assists code review on GitHub pull-request pages: it answers questions about selected diff code and helps the reviewer draft and post review comments, using the user's own Anthropic API key or local Claude CLI.
```

## Permission justifications (dashboard "Privacy practices" tab)

- **storage** — persist the user's settings, API key, GitHub token, and per-PR conversation/draft locally.
- **host: github.com** — the content script runs on PR pages to render the dock and read the diff selection.
- **host: api.github.com** — read PR metadata/diffs and post/delete review comments, with the user's token.
- **host: api.anthropic.com** — send the user's prompt+code to Anthropic with the user's API key.
- **nativeMessaging (optional)** — only if the user opts into the Claude Code CLI backend; talks to a local host the user installs.
- **Remote code:** none — all code is bundled in the package; nothing is fetched/eval'd at runtime.

## Data-use disclosures (check these on the form)

- Does NOT collect/transmit data to the developer. Keys/token stay on-device.
- User content (selected code/diffs) is sent only to Anthropic (user's key) or the user's local CLI, to fulfill the requested action.
- Not sold; not used for unrelated purposes; not used for creditworthiness/lending.

---

## Assets you still need to provide

- **Icon 128×128** — already in the package (`icons/icon-128.png`).
- **Screenshots** — 1–5, **1280×800** or **640×400** PNG/JPEG. The dock shots in `public/help/*.png`
  are the right content but the wrong size; re-capture/letterbox to 1280×800 before upload.
- **Small promo tile** 440×280 (optional but recommended).

## ⚠️ Native-host note (opt-in CLI users only)

The Chrome Web Store assigns its **own extension ID**, different from the dev ID
`cafladkeojdkaaehgajijjehaclhkdch`. The native-messaging host pins an ID in `allowed_origins`,
so **store users who opt into the CLI backend must install the host with the store ID**:

```
./native-host/install.sh <store-extension-id>
```

(Find the store ID in the dashboard / on the published item's URL.) API-key users are unaffected.

## Submission checklist (you do these — they're outward-facing)

1. `npm run package` → upload `web-store/cortex-<version>.zip`.
2. Paste the listing fields, single-purpose, permission justifications, data disclosures above.
3. Host `PRIVACY.md` and add its URL.
4. Upload 1280×800 screenshots (+ optional promo tile).
5. Submit for review.

> Before enabling/advertising the **CLI-subscription** backend publicly, review Anthropic's terms
> for running the subscription CLI via automation (tracked as a distribution risk in PLAN.md). The
> API-key backend is unaffected.
