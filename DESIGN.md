# Your Code Review Assistant — Design

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
- More features later (whole-file/PR review, severity tags, threaded follow-ups).

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
 │     • <dock-panel> Web Component in a shadow root (style-isolated)               │    │
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
2. **Host script** (`reviewer-host.js`, Node):
   - Reads Chrome's framing on **stdin**: 4-byte little-endian length prefix + UTF-8 JSON.
   - Runs the model, writes the same framing to **stdout**.
   - Prefers the **Claude Agent SDK** (structured streaming, can hold a session for
     follow-ups, uses local CLI auth). Falls back to shelling
     `claude -p --output-format stream-json` if the SDK doesn't fit.
3. **Installer** (`install.sh` / `install.ps1`) — registers the host per-OS:
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

---

## 10. Dock panel UI

- A `<dock-panel>` **custom element** mounted by the content script into a host node with
  an attached **shadow root**; CSS inlined into the shadow root for full isolation.
- Pinned to the bottom of the viewport, collapsible.
- Sections: a conversation/answer area (renders streamed markdown) and an input;
  a canned-comments tray (Phase 1b).
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
YourCodeReviewAssistant/
├─ DESIGN.md
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ manifest.config.ts          # CRXJS manifest (MV3, with fixed "key")
├─ public/icons/
├─ src/
│  ├─ background/
│  │  ├─ index.ts              # service worker: port router
│  │  ├─ providers/
│  │  │  ├─ types.ts           # LlmProvider, AskRequest, Chunk
│  │  │  ├─ registry.ts        # active provider + fallback
│  │  │  ├─ anthropic.ts       # Provider A
│  │  │  └─ claudeCode.ts      # Provider B (native-host client)
│  │  └─ github/
│  │     └─ api.ts             # PR files/patch fetch (Phase 2)
│  ├─ content/
│  │  ├─ index.ts              # injected on PR pages
│  │  ├─ dock/
│  │  │  ├─ dock-panel.ts      # <dock-panel> custom element
│  │  │  └─ dock.css           # styles inlined into shadow root
│  │  ├─ selection.ts          # selection → file/line/code
│  │  └─ comments.ts           # canned-comment insertion (Phase 1b)
│  ├─ options/
│  │  ├─ options.html
│  │  └─ options.ts            # provider toggle, key, PAT, model
│  └─ shared/
│     ├─ messages.ts           # port + native protocol types
│     └─ storage.ts            # settings get/set
└─ native-host/                # NOT bundled by Vite — shipped separately
   ├─ reviewer-host.js         # Node host
   ├─ manifest.template.json
   ├─ install.sh
   └─ install.ps1
```

---

## 13. Roadmap

| Phase | Scope |
|---|---|
| **1** | Dock panel + highlight-and-ask, **both** providers, options page (provider toggle + key + model). Read-only w.r.t. GitHub. |
| **1b** | Canned comments via DOM insert. |
| **2** | GitHub API (PAT): authoritative diff fetch + posting real line-anchored comments. |
| **3** | "Review whole file/PR" summaries, per-selection threaded follow-ups, severity tags. |
| **Later** | GitLab/Bitbucket — only the content-script DOM layer is new; dock + providers reusable. |

---

## 14. Open questions / risks

- **GitHub DOM fragility** — mitigated by using the GitHub API for ground-truth content;
  DOM only for selection capture.
- **Native-host install friction** + the fixed-extension-ID requirement in dev.
- **Subscription-via-CLI ToS** — fine for personal use; a gray area for wider
  distribution. Revisit before publishing.
- **Streaming plumbing** — ports, chunking, and the 1 MB native-message cap.
- **Model IDs/headers** — confirm against live Anthropic docs at build time.
