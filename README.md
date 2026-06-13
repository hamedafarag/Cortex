# Cortex — AI Review Assistant

**A local developer-experience tool that turns the Claude subscription (or API key) you
already pay for into an in-PR review assistant — no SaaS middleman, no second subscription,
no per-token surprise bill.**

A browser extension (Manifest V3) that gives you an in-page AI copilot while reviewing
GitHub pull requests — **without** handing the review off to a third-party bot. You stay
the reviewer; the extension is your assistant.

Open a PR and a small **Cortex button** appears at the bottom-right — click it to open the
dock (a full-width panel; collapse it back from the header so it never blocks the page).
Highlight code in the diff, ask a question, and get a streamed, markdown-rendered answer. The AI backend is
pluggable: use the **Anthropic API** (your own key) or the **Claude Code CLI** (your
existing Claude subscription, via a local native host) — your code never goes to a
third-party server.

> Status: **Phases 0 · 1 · 1b · 2 · 2.5 complete; Phase 3 in progress** (GitHub only). See [PLAN.md](PLAN.md) for
> the roadmap, [CHANGELOG.md](CHANGELOG.md) for the history, [DESIGN.md](DESIGN.md) for the
> architecture, and [COMPETITORS.md](COMPETITORS.md) for how this sits in the market.

---

## Features

- **Ask about highlighted code** — select code in a PR diff, ask, and get a streamed,
  markdown-rendered answer grounded in the **authoritative diff hunk** and the PR's
  **title + description** (fetched from the GitHub API, not just the scraped DOM) — so the
  model judges the change against its stated intent.
- **Turn an answer into a comment** — a finished answer offers **Use as comment** (drops it
  into the composer to edit, then post) and **Copy** — no retyping.
- **Suggest a fix** — get a committable GitHub `suggestion` block for the selected lines that
  the author can apply in one click; multi-line selections anchor to the whole range.
- **Threaded follow-ups** — keep asking about the same code in one conversation; each
  follow-up carries the prior turns. **New thread** clears it.
- **Summarize the PR** — one click streams a TL;DR + key changes + per-file gloss + a 1–5
  review-effort rating, grounded in the actual diffs (no selection needed).
- **Review the whole PR** — one click streams a **findings list** grounded in every changed
  file's diff (no selection needed). Each finding is tagged **Blocker / Major / Minor / Nit /
  Praise** as a **color-blind-safe chip** (icon + label) for instant triage, and rides the
  answer→comment bridge so you can post it. A **lens** selector focuses the review on
  **Security / Performance / Error handling / Readability**.
- **Test-gap check** — one click flags which changed source files have **no matching test
  change** (a fast, no-AI file-name heuristic — an approximation, not coverage).
- **Two interchangeable backends** behind one interface, with automatic fallback:
  - **Anthropic API** — your own API key, billed to your account.
  - **Claude Code CLI** — your Claude subscription, via a local native-messaging host that
    shells out to the `claude` CLI (no API key needed).
- **Out-of-the-box comments** — insert canned review snippets (Nit, Needs test, …) into
  GitHub's comment box.
- **Conventional Comments labels** — prepend a semantic `label (decoration): ` prefix
  (suggestion, issue, nit, … · blocking / non-blocking / if-minor) so authors instantly see
  what's blocking vs. optional.
- **Post line-anchored review comments** (single- or multi-line) straight to the PR via your
  own GitHub token — gated by a **confirm step** (shows the exact `repo · path:line`) and a
  **10-second Undo** afterwards, so a misfire is one click to retract.
- **Native, adaptive UI** — the dock inherits GitHub's light/dark theme so it feels
  built-in; sharp Cortex identity, line icons, loading states, and **color-blind-safe**
  status (icon + label, never colour alone).
- **Local & private** — keys/token live only in your browser; code goes only to Anthropic
  (your account) and `api.github.com` (your token). No third-party SaaS. **Obvious secrets**
  (API keys, private keys, JWTs, high-entropy tokens) are **masked before anything is sent**,
  with a dock notice when they are.
- **Built-in features page** — a **?** button in the dock header opens an in-app
  features tour (with screenshots) in a new tab — served by the extension itself, no internet
  needed.
- **Persists per PR** — your conversation and the comment you're drafting are remembered for
  each PR and restored when you come back (after a reload or navigating away), stored only in
  your browser.

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

1. Open any GitHub pull request — a **Cortex button** sits at the bottom-right; click it to
   open the dock (the header chevron collapses it back). The **Whole PR** toolbar needs no
   selection: **Summarize** for an overview, **Review** (with an optional lens) for a tagged
   findings list, or **Test gaps** for the no-AI test-coverage heuristic.
2. Highlight code in the diff — the dock's chip shows the captured `file :lines`.
3. Type a question and click **Ask** (or ⌘/Ctrl+Enter) — or click **Suggest a fix** for a
   committable `suggestion` block on the selected lines. The answer streams in; ask follow-ups
   in the same thread, or start fresh with the **New** button in the dock header.
4. From a finished answer, click **Use as comment** to drop it into the composer (edit it
   first), or **Copy** it.
5. **Insert** a canned snippet from the **Insert** tray, or click a **Label** (suggestion,
   issue, nit, …) — optionally with a decoration — to prepend a Conventional Comments prefix
   to your comment.
6. **Post to line** — type a comment and post it as a line-anchored review comment via the
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
  shared/             types, message protocols, settings storage, prompt builder
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

See [PLAN.md](PLAN.md) and [CHANGELOG.md](CHANGELOG.md). Now in **Phase 3 — from answer to
action**: making AI output land as real, well-labeled review comments. **Done (Phase 3a):**
answer→comment bridge, PR-intent grounding, committable `suggestion` blocks, Conventional
Comments labels, threaded follow-ups. **Done (Phase 3b):** PR summary, whole-PR review with
severity-tagged findings, specialist lenses, and a test-gap check. **Next:** Phase 3c —
persistence per PR, confirm/undo before posting, and secret redaction.

---

## License

[MIT](LICENSE) © Hamed Farag.
