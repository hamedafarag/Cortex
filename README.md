# Cortex — AI Review Assistant

**A local developer-experience tool that turns the Claude subscription (or API key) you
already pay for into an in-PR review assistant — no SaaS middleman, no second subscription,
no per-token surprise bill.**

A browser extension (Manifest V3) that gives you an in-page AI copilot while reviewing
GitHub pull requests — **without** handing the review off to a third-party bot. You stay
the reviewer; the extension is your assistant.

Open a PR and a **dock panel** appears at the bottom of the page. Highlight code in the
diff, ask a question, and get a streamed, markdown-rendered answer. The AI backend is
pluggable: use the **Anthropic API** (your own key) or the **Claude Code CLI** (your
existing Claude subscription, via a local native host) — your code never goes to a
third-party server.

> Status: **Phase 1 + 1b complete** (GitHub only). See [PLAN.md](PLAN.md) for the roadmap,
> [DESIGN.md](DESIGN.md) for the architecture, and [COMPETITORS.md](COMPETITORS.md) for how
> this sits in the market.

---

## Features

- **Ask about highlighted code** — select code in a PR diff, ask, and get a streamed,
  markdown-rendered answer grounded in the **authoritative diff hunk** (fetched from the
  GitHub API, not just the scraped DOM).
- **Two interchangeable backends** behind one interface, with automatic fallback:
  - **Anthropic API** — your own API key, billed to your account.
  - **Claude Code CLI** — your Claude subscription, via a local native-messaging host that
    shells out to the `claude` CLI (no API key needed).
- **Out-of-the-box comments** — insert canned review snippets (Nit, Needs test, …) into
  GitHub's comment box.
- **Post line-anchored review comments** straight to the PR via your own GitHub token.
- **Native, adaptive UI** — the dock inherits GitHub's light/dark theme so it feels
  built-in; sharp Cortex identity, line icons, loading states, and **color-blind-safe**
  status (icon + label, never colour alone).
- **Local & private** — keys/token live only in your browser; code goes only to Anthropic
  (your account) and `api.github.com` (your token). No third-party SaaS.

---

## Prerequisites

- **Node.js** 20+ and npm
- A Chromium-based browser: **Microsoft Edge**, Chrome, Chromium, or Brave
- For the **Claude Code CLI backend** only: the [`claude` CLI](https://docs.claude.com/claude-code)
  installed and signed in (`claude` on your `PATH`)

---

## Build & load the extension

```bash
npm install
npm run build      # outputs a self-contained ./dist
```

Then load it unpacked:

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select the `dist/` folder.

The extension ships with a fixed key, so its ID is always
`cafladkeojdkaaehgajijjehaclhkdch` (required so the native host's `allowed_origins`
keeps matching). After a rebuild, click **↻** on the extension card to reload it.

---

## Configure a backend

Open the extension's **Options** page (`edge://extensions` → details → *Extension
options*) and pick an **AI backend**.

### Option A — Anthropic API

1. Set **AI backend** to *Anthropic API*.
2. Paste your **Anthropic API key** (`sk-ant-…`). It's stored in `chrome.storage.local`
   (this machine only; never synced).
3. Pick a **model**.

### Option B — Claude Code CLI (your subscription)

1. Install the native host (registers it for every Chromium browser found):

   ```bash
   ./native-host/install.sh
   ```

   This bakes your absolute `node` and `claude` paths into a wrapper and writes a host
   manifest to each browser's `NativeMessagingHosts/` directory.
2. **Fully quit and reopen the browser** (native hosts are discovered at startup).
3. In Options, set **AI backend** to *Claude Code CLI*.

> Note: `claude -p` loads the Claude Code agent environment (~10–17k tokens of base
> prompt + tool schemas per call, cached after the first), so answers cost ~1–2¢ of
> subscription usage and take a few seconds. See DESIGN.md §7 for why, and the planned
> direct-OAuth optimization.

---

## Posting review comments (GitHub token)

The dock can post **line-anchored review comments** straight to a PR via the GitHub API,
using **your own token** (your GitHub — no third party). Comments are posted **as you**.
Add the token in **Options → GitHub token**.

> Security: the token is stored in `chrome.storage.local` (this browser only, **not
> encrypted at rest**, never synced) and sent only to `api.github.com`. Scope it as
> narrowly as you can, and revoke it when you don't need it.

### Recommended — a fine-grained token (smallest blast radius)

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens
   → Generate new token** (<https://github.com/settings/personal-access-tokens/new>).
2. **Token name** + a real **expiration** (avoid "No expiration").
3. **Resource owner** → select the **organization** that owns the repos (e.g. `your-org`),
   *not* your personal account. ← most common mistake.
4. **Repository access** → **Only select repositories** → pick the repos you review.
5. **Permissions → Repository permissions → Pull requests → Read and write** — the only
   permission needed (Metadata: Read is added automatically).
6. **Generate token**, copy the `github_pat_…` value, paste it into Options.

**Org gate:** for org repos the organization must *allow* fine-grained tokens, and may
require an **owner to approve** your token (it stays *pending* until approved). If posting
returns **404 Not Found**, that's the cause — ask a GitHub org owner to enable/approve it
under *Org → Settings → Third-party Access → Personal access tokens*.

### Fallback — a classic token

A classic token with the **`repo`** scope also works. For SAML-SSO orgs, click **Configure
SSO → Authorize** on the token. It's easier to get working but far more powerful (it can
read/write **every** repo you can access), so prefer a fine-grained token where you can,
and revoke the classic one when you're done.

---

## Usage

1. Open any GitHub pull request.
2. Highlight code in the diff — the dock's chip shows the captured `file :lines`.
3. Type a question and click **Ask** (or ⌘/Ctrl+Enter). The answer streams in.
4. **Insert** a canned review comment (Nit, Needs test, …) into GitHub's comment box from
   the dock's **Insert:** tray.
5. **Post to line** — type a comment and post it as a line-anchored review comment via the
   GitHub API (needs a token — see above). The dock links to the created comment.

---

## Development

```bash
npm run dev        # Vite + CRXJS hot-reload
npm run typecheck  # tsc --noEmit
```

`npm run dev` hot-reloads the extension on change, **but the loaded extension breaks if
the Vite server stops** (it can't reach `localhost:5173`). For stable testing, prefer
`npm run build` + a manual reload.

---

## Project structure

```
src/
  background/         service worker: port router, provider registry, GitHub ops
    providers/        LlmProvider interface, registry, anthropic.ts, claudeCode.ts
    github/           api.ts — head sha, files/patch (diff grounding), post comment
  content/            injected on PR pages
    dock/             dock-panel.ts (plain <div> + shadow root) + icons.ts
    selection.ts      selection → {file, lineRange, side, code, language}
    comments.ts       canned comments + insert into GitHub's comment box
  options/            options page (backend, key, model, PAT, About)
  shared/             types, message protocols, settings storage
native-host/          reviewer-host.mjs (native messaging) + install.sh
public/icons/         icon.svg + generated PNGs (npm run icons)
scripts/gen-icons.mjs SVG → PNG icon generator
manifest.config.ts    MV3 manifest (CRXJS) with the fixed key + icons
```

---

## Uninstall the native host

Delete the host manifest from each browser you installed it to, e.g. on macOS:

```bash
rm ~/Library/Application\ Support/Microsoft\ Edge/NativeMessagingHosts/com.ycra.reviewer.json
rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.ycra.reviewer.json
```

(Linux: under `~/.config/<browser>/NativeMessagingHosts/`.)

---

## Roadmap

See [PLAN.md](PLAN.md). Next up: out-of-the-box review comments (Phase 1b) and GitHub API
integration for posting line-anchored comments (Phase 2).
