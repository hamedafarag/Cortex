# Your Code Review Assistant

A browser extension (Manifest V3) that gives you an in-page AI copilot while reviewing
GitHub pull requests — **without** handing the review off to a third-party bot. You stay
the reviewer; the extension is your assistant.

Open a PR and a **dock panel** appears at the bottom of the page. Highlight code in the
diff, ask a question, and get a streamed, markdown-rendered answer. The AI backend is
pluggable: use the **Anthropic API** (your own key) or the **Claude Code CLI** (your
existing Claude subscription, via a local native host).

> Status: **Phase 1 complete** (GitHub only). See [PLAN.md](PLAN.md) for the roadmap and
> [DESIGN.md](DESIGN.md) for the architecture.

---

## Features

- **Ask about highlighted code** — select code in a PR diff, ask, get a streamed answer
  grounded in the file/lines/diff context.
- **Two interchangeable backends** behind one interface, with automatic fallback:
  - **Anthropic API** — your own API key, billed to your account.
  - **Claude Code CLI** — your Claude subscription, through a local native-messaging host
    that shells out to the `claude` CLI (no API key needed).
- **Markdown rendering** of answers (code blocks, lists, etc.), sanitized.
- **Style-isolated dock** (shadow DOM) that doesn't fight GitHub's own keyboard shortcuts.

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

## Usage

1. Open any GitHub pull request.
2. Highlight code in the diff — the dock's chip shows the captured `file :lines`.
3. Type a question and click **Ask** (or ⌘/Ctrl+Enter). The answer streams in.

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
  background/         service worker: port router + provider registry
    providers/        LlmProvider interface, registry, anthropic.ts, claudeCode.ts
  content/            injected on PR pages
    dock/             the dock panel (plain <div> + shadow root)
    selection.ts      selection → {file, lineRange, code, language}
  options/            options page (backend, key, model)
  shared/             types, message protocols, settings storage
native-host/          reviewer-host.mjs (native messaging) + install.sh
manifest.config.ts    MV3 manifest (CRXJS) with the fixed key
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
