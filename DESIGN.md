# Cortex — Design

A Chrome extension that turns you into a faster, AI-assisted PR reviewer **without**
handing the review off to a third-party bot (CodeRabbit, etc.). You stay the reviewer;
the extension is your in-page copilot.

**Phase 1 target:** GitHub only.

---

## 1. Vision

When a reviewer opens a Pull Request on GitHub, the extension injects a **dock panel**
pinned to the bottom of the page. From the dock the reviewer can:

- **Highlight code and ask about it** — select text in the diff, ask a question, get a
  streamed answer in the dock (the "AI Assistant").
- **Insert out-of-the-box comments** — canned review snippets dropped into GitHub's
  comment box.
- **Review the whole PR** — one click (no selection) streams a findings list with
  **severity tags** and optional **specialist lenses**, a **PR summary**, or a fast
  **test-gap** check; ask **threaded follow-ups** in one conversation.
- Your conversation and drafts **persist per PR**; posting is gated by a **confirm step + a 10s
  Undo**; and **obvious secrets are masked** before anything is sent to the model.

The AI backend is **pluggable**: it can talk to the local **Claude Code CLI**
(riding the user's subscription) *or* the **Anthropic API** (user's own key). Both ship
from day one behind one interface.

---

## 2. Goals & non-goals

**Goals**
- Self-hosted reviewer's copilot — the human stays in control, nothing auto-approves or
  auto-comments without intent.
- Two interchangeable AI backends behind one provider interface.
- Streamed responses end-to-end.
- Minimal, defensive coupling to GitHub's DOM.

**Non-goals (for now)**
- Replacing the reviewer with an autonomous bot.
- Supporting GitLab/Bitbucket (the dock + providers are reusable later; only the
  content-script DOM layer is platform-specific).
- Hosting any server of our own. No bundled API keys, no proxy.

---

## 3. Tech stack (decided)

| Area | Choice |
|---|---|
| Language / build | **TypeScript + Vite + `@crxjs/vite-plugin`** (MV3) |
| Dock UI | **Vanilla DOM / Web Components in a shadow root** (no framework) |
| Native host runtime | **Node.js** |
| GitHub auth (Phase 2) | **Fine-grained PAT** |
| Manifest | **Manifest V3** |

---

## 4. Architecture

```
 ┌──────────────────────── GitHub PR page (github.com/*/pull/*) ───────────────────────┐
 │                                                                                      │
 │   content script ──────────────────────────────────────────────────────────────┐    │
 │     • dock panel: plain <div> + shadow root (style-isolated)                    │    │
 │     • selection → {file, lineRange, code, diffHunk}                              │    │
 │     • canned-comment insertion (Phase 1b)                                        │    │
 │                                                                                  │    │
 └──────────────────────────────────┬──────────────────────────┬────────────────────────┘
                                     │ chrome.runtime.connect   │ (long-lived PORT, streams)
                                     ▼                          ▲
 ┌───────────────────────── background service worker ─────────────────────────────────┐
 │   • port router (ASK / ABORT  →  CHUNK / DONE / ERROR)                                │
 │   • provider registry: pick active, fall back if unavailable                         │
 │   • owns ALL secrets and ALL LLM calls                                                │
 │                                                                                      │
 │      ┌──────────────── LlmProvider ────────────────┐                                 │
 │      │  anthropic-api   ─────────────────────────► api.anthropic.com (SSE)           │
 │      │  claude-code-cli ─► chrome.runtime.connectNative ─► native host (Node)        │
 │      └──────────────────────────────────────────────┘            │                  │
 └───────────────────────────────────────────────────────────────────┼──────────────────┘
                                                                      ▼
                                                       Claude Agent SDK / `claude -p`
                                                       (local CLI auth + subscription)
```

**Why the background worker owns every LLM call:**
- The **API key never enters page context** (content scripts share the page's process;
  secrets stay in the worker).
- **Native messaging is only reachable from the extension/background context** — content
  scripts can't call `connectNative` anyway.
- Centralizes history, abort, rate-limiting, and error handling.

Streaming uses a **long-lived `chrome.runtime.connect` port**, not one-shot
`sendMessage`, so chunks render into the dock incrementally.

---

## 5. The provider abstraction (keystone)

Everything routes through one interface; the dock never knows which backend answered.

```ts
type ProviderId = 'anthropic-api' | 'claude-code-cli'

interface AskRequest {
  question: string
  context: {
    repo: string                 // "owner/name"
    prNumber: number
    file?: string
    lineRange?: [number, number]
    prTitle?: string             // PR title — judge the change vs. its stated intent
    prBody?: string              // PR description (truncated)
    selectedCode?: string
    diffHunk?: string            // surrounding diff, for grounding
    language?: string
  }
  history?: { role: 'user' | 'assistant'; content: string }[]
}

type Chunk =
  | { type: 'text'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

interface LlmProvider {
  id: ProviderId
  isAvailable(): Promise<boolean>                       // key present? host reachable?
  ask(req: AskRequest, signal: AbortSignal): AsyncIterable<Chunk>
}
```

A **registry** in the background worker holds both providers, picks the active one from
settings, and **falls back** when the preferred is unavailable (e.g. CLI host not
installed → use the API key). Both backends stream, so the interface is `AsyncIterable`
end-to-end — no special-casing in the UI.

---

## 6. Provider A — Anthropic API

- Each user pastes **their own** key in the options page → stored in
  `chrome.storage.local` (**not** `sync` — never sync secrets across machines).
- The worker calls the Messages API with `stream: true` and the
  `anthropic-dangerous-direct-browser-access: true` header (required for an extension
  origin).
- Default model `claude-opus-4-8`; expose a Sonnet option for cost.
- Exact current model IDs / required headers to be confirmed against the live API docs at
  build time — not hard-coded from memory.

---

## 7. Provider B — Claude Code CLI via Native Messaging

Rides the user's local CLI auth/subscription. Three pieces + an install step.

1. **Host manifest** (JSON) placed in the browser's `NativeMessagingHosts/` directory:
   - `"type": "stdio"`, `"path"` → host script,
   - `"allowed_origins": ["chrome-extension://<EXT_ID>/"]`.
2. **Host script** (`reviewer-host.mjs`, Node):
   - Reads Chrome's framing on **stdin**: 4-byte little-endian length prefix + UTF-8 JSON.
   - Runs the model, writes the same framing to **stdout** (never logs to stdout).
   - **Implemented (v1):** shells `claude -p --output-format stream-json
     --include-partial-messages --verbose` in **lean mode** — `--setting-sources ""`,
     `--strict-mcp-config`, disabled file/bash tools, neutral cwd — so it skips the
     user's plugins/MCP/hooks/CLAUDE.md and rides the **subscription** (OAuth). Parses
     `stream_event → content_block_delta → text_delta` for streaming, `result` for
     done/error. Even lean, `claude -p` carries ~10–17k tokens of base prompt + tool
     schemas per call (≈1–2¢, cached after the first) — it's an agent, not a bare LLM
     endpoint. `CLAUDE_CODE_SIMPLE` strips this but forces API-key auth (no subscription).
   - **Future optimization:** read the subscription OAuth token and call the Messages API
     directly (`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`) — lean/fast/
     cheap, at the cost of token refresh handling and a larger ToS gray area.
3. **Installer** (`install.sh`; Windows registry is noted but not yet scripted) — registers the host per-OS:
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/`
   - Windows: registry key.
   - **This manual step is the install-friction cost of this provider.**

**Gotchas that will bite if unplanned:**
- **Fixed extension ID** — an unpacked extension's ID changes on reload, breaking the
  host manifest's `allowed_origins`. Pin it by adding a `"key"` (public key) to
  `manifest.json` so the ID is stable in dev.
- **1 MB per-message cap** (host → extension) → chunk streamed responses.
- **Host hardening** — the host must do *only* the LLM call and validate the message
  shape. Never let a message drive arbitrary shell commands; it runs with the user's full
  privileges.

### Native-host message protocol (background ↔ host)
```
→ host: { type: 'ask', id, request: AskRequest }
→ host: { type: 'abort', id }
→ ext:  { type: 'chunk', id, delta }
→ ext:  { type: 'done',  id }
→ ext:  { type: 'error', id, message }
```

---

## 8. GitHub integration — selection → context

The fiddliest, most fragile surface. Strategy: **DOM for capture, GitHub API for ground
truth.**

- On the *Files changed* tab (`/pull/N/files`): capture `window.getSelection()`, walk up
  to the diff row → file container to read the **path** and **line numbers** from row
  attributes. This is *what the user pointed at* — cheap, always available.
- For *authoritative* file/diff content, fetch
  `GET /repos/{owner}/{repo}/pulls/{n}/files` (returns each file's `patch`). This shrinks
  dependence on scraping GitHub's markup — their diff DOM changes between UI versions and
  is the **#1 maintenance risk**.
- Render the dock in a **shadow DOM** so GitHub's CSS can't leak in (and vice-versa).

---

## 9. Out-of-the-box comments

- **Phase 1b (quick):** inject canned snippets into the focused comment `<textarea>`
  (markdown).
- **Phase 2 (robust):** `POST /repos/{owner}/{repo}/pulls/{n}/comments` with
  `commit_id` / `path` / `line` / `side` to anchor a real review comment. Auth via
  **fine-grained PAT** entered in options.
- **Phase 3a:** the dock can compose **Conventional Comments** prefixes
  (`label (decoration): `) into the box, promote an AI answer into a comment (**Use as
  comment**), and emit a committable `suggestion` block (**Suggest a fix**). Posting gained
  optional `start_line` / `start_side`, so a multi-line selection (or suggestion) anchors to
  the whole range.

---

## 10. Dock panel UI

- A plain `<div>` host with an **attached shadow root** (content scripts can't register
  custom elements — `customElements` is null), mounted by the content script; CSS inlined
  into the shadow root for full isolation.
- **Collapsed by default** to a small Cortex **launcher button** (bottom-right); clicking it
  expands a **full-width** panel pinned to the bottom of the viewport, and the header collapses
  it back to the button — so the dock never blocks page content unless the reviewer opens it.
- Sections: an answer area that renders the streamed-markdown **conversation thread**
  (threaded follow-ups via `history` + a **New thread** reset) with answer→comment actions
  (**Use as comment** / Copy); an **Insert** tray (canned snippets) and a **Label** tray
  (Conventional Comments); a **Whole PR** toolbar (no selection needed) with **Summarize** /
  **Review** (+ a specialist-**lens** select) / **Test gaps**; and a composer with **Suggest a
  fix** / **Ask** / **Post to line**. The header carries a **New thread** reset and a **?**
  button that opens the built-in **features page** in a new tab.
- The **features page** (`src/help/help.html`) is an extension-served page (a CRXJS build input,
  like the options page) opened via the background's `chrome.tabs.create` — a screenshot tour of
  every capability, adaptive light/dark, fully offline.
- No framework — vanilla DOM + Web Components, per decision.

### Port protocol (content ↔ background)
```
content → bg: { type: 'ASK',   id, request: AskRequest }
content → bg: { type: 'ABORT', id }
bg → content: { type: 'CHUNK', id, delta }
bg → content: { type: 'DONE',  id }
bg → content: { type: 'ERROR', id, message }
```

---

## 11. Security & permissions

- **Secrets:** API key + PAT in `chrome.storage.local` (not `sync`). Only the background
  worker reads them. `chrome.storage.local` is **not encrypted at rest** — acceptable for
  a dev tool, but say so in the UI.
- **Data egress:** highlighted code is sent to Anthropic (the user's own key or
  subscription). Make this explicit in the UI — it matters for proprietary code.
- **Permissions (minimal):**
  - `host_permissions`: `https://github.com/*`, `https://api.anthropic.com/*`,
    later `https://api.github.com/*`
  - `nativeMessaging`
- **MV3 CSP:** no remote code — everything bundled.
- **Native host:** does only the LLM call; validates/whitelists the message shape.

---

## 12. Project structure (Vite + CRXJS + TS)

```
YourCodeReviewAssistant/          # repo dir (product name: Cortex)
├─ README.md · DESIGN.md · PLAN.md · COMPETITORS.md · FEATURE-LANDSCAPE.md · CHANGELOG.md · CLAUDE.md
├─ package.json · tsconfig.json · vite.config.ts
├─ manifest.config.ts          # CRXJS MV3 manifest (fixed "key", icons)
├─ scripts/gen-icons.mjs        # SVG → PNG icon generator (npm run icons)
├─ public/icons/                # icon.svg + icon-{16,32,48,128}.png
├─ src/
│  ├─ background/
│  │  ├─ index.ts              # service worker: port router + GitHub message handler
│  │  ├─ providers/
│  │  │  ├─ types.ts           # LlmProvider
│  │  │  ├─ registry.ts        # active provider + fallback
│  │  │  ├─ anthropic.ts       # Provider A
│  │  │  └─ claudeCode.ts      # Provider B (native-host client)
│  │  └─ github/
│  │     └─ api.ts             # head sha, files/patch (diff grounding), post comment
│  ├─ content/
│  │  ├─ index.ts              # injected on PR pages; tracks selection; ask/post
│  │  ├─ dock/
│  │  │  ├─ dock-panel.ts      # the dock (plain <div> + shadow root; styles inline)
│  │  │  └─ icons.ts           # inline SVG line icons
│  │  ├─ selection.ts          # selection → file/line/side/code
│  │  └─ comments.ts           # canned comments + GitHub-box insertion
│  ├─ options/
│  │  ├─ options.html
│  │  └─ options.ts            # backend, key, model, PAT, About
│  └─ shared/
│     ├─ types.ts              # AskContext/AskRequest/Chunk/ProviderId
│     ├─ messages.ts           # port + native + GitHub protocol types
│     ├─ prompt.ts             # buildUserContent (shared by the API provider; host mirrors)
│     └─ storage.ts            # settings get/set
└─ native-host/                # NOT bundled by Vite — installed separately
   ├─ reviewer-host.mjs        # Node native-messaging host (lean claude -p)
   └─ install.sh               # registers the host (Edge/Chrome/Chromium/Brave)
```

---

## 13. Roadmap

| Phase | Scope |
|---|---|
| **1** | Dock panel + highlight-and-ask, **both** providers, options page (provider toggle + key + model). Read-only w.r.t. GitHub. |
| **1b** | Canned comments via DOM insert. |
| **2** | GitHub API (PAT): authoritative diff fetch + posting real line-anchored comments. |
| **3** | **From answer to action** — make AI output land as real, well-labeled review comments: answer→comment bridge, PR-intent grounding, committable suggestions, Conventional Comments labels, threaded follow-ups, whole-file/PR review. See `PLAN.md`. |
| **Later** | GitLab/Bitbucket — only the content-script DOM layer is new; dock + providers reusable. |

---

## 14. Open questions / risks

- **GitHub DOM fragility** — mitigated by using the GitHub API for ground-truth content;
  DOM only for selection capture. Verified signals on the new `/changes` view:
  file path via `aria-label="Diff for: <path>"`, line via `data-line-number`.
- **No custom elements in content scripts** — `customElements` is `null` in a content
  script's isolated world, so the dock is a plain `<div>` + attached shadow root, not a
  registered custom element.
- **`user-select: none` on the `/changes` view** — GitHub sets it on many diff cells, so
  highlighting code there can yield an empty selection. The highlight UX may need to
  account for GitHub's custom selection model on that view.
- **Native-host install friction** + the fixed-extension-ID requirement in dev.
- **Subscription-via-CLI ToS** — fine for personal use; a gray area for wider
  distribution. Revisit before publishing.
- **Streaming plumbing** — ports, chunking, and the 1 MB native-message cap.
- **Model IDs/headers** — confirm against live Anthropic docs at build time.

---

## 15. UI & identity (Phase 2.5)

**Name:** Cortex — AI Review Assistant. Internal identifiers (the native-host name
`com.ycra.reviewer`, `data-ycra-*` attributes, the fixed signing key / extension ID) are
deliberately left unchanged so renaming doesn't break the installed host.

**Design language — "a precision instrument embedded in GitHub":**
- **Adaptive / native theming.** The dock's shadow-DOM styles consume GitHub's own Primer
  CSS custom properties (`--bgColor-default`, `--fgColor-default`, `--fgColor-accent`,
  `--borderColor-default`, … with legacy `--color-*` fallbacks). Custom properties pierce
  the shadow boundary, so the dock matches GitHub's light/dark theme automatically — no JS
  theme detection. The options page (its own `chrome-extension://` page, no Primer tokens)
  adapts via `prefers-color-scheme`.
- **Sharp identity over the native base:** a synapse **logomark**, a Cortex-indigo
  (`#6b5cf6`) top edge on the panel + indigo **Ask** action (the "AI" moments), monospace
  for technical accents (the `file :line` chip, status), uppercase tracked wordmark.
- **Icons** are authored inline SVG line-icons (`content/dock/icons.ts`) — no external
  requests, no third-party assets/attribution; consistent with the no-SaaS ethos and with
  not bundling licensed icon packs (e.g. Flaticon).
- **Loading states** for every async path: `Thinking…` (ask) and `Posting…` (post)
  spinners, plus status rows.
- **Color-blind safe:** every status pairs colour with an icon **and** a text label
  (check / alert-triangle / spinner) — never colour alone.
