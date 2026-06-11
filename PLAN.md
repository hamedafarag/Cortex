# Your Code Review Assistant — Build Plan

Phased, task-level breakdown derived from [DESIGN.md](DESIGN.md).
Check items off as they land. The session todo list tracks the **active** phases
(Phase 0 + Phase 1); later phases live here only until we start them.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Scaffolding & tooling ✅

- [x] Init project: `npm`, TypeScript, Vite, `@crxjs/vite-plugin`
- [x] Create folder structure (`src/background`, `src/content`, `src/options`, `src/shared`, `native-host/`)
- [x] `tsconfig.json` + `vite.config.ts` configured for MV3
- [x] `manifest.config.ts` (MV3) with a **fixed `"key"`** so the extension ID is stable in dev
- [x] Minimal permissions: `host_permissions` (`github.com`, `api.anthropic.com`), `nativeMessaging`
- [x] Placeholder icons in `public/icons/`
- [x] **Gate:** load-unpacked succeeds — extension appears in `chrome://extensions`

---

## Phase 1 — Dock panel + highlight-and-ask (both providers) ✅

### 1a. Shared contracts
- [x] `shared/messages.ts` — port protocol (`ASK`/`ABORT` → `CHUNK`/`DONE`/`ERROR`) + native-host protocol types
- [x] `shared/storage.ts` — settings get/set over `chrome.storage.local`
- [x] `shared/types.ts` + `background/providers/types.ts` — `LlmProvider`, `AskRequest`, `Chunk`

### 1b. Provider layer
- [x] `providers/registry.ts` — pick active provider from settings + **fallback** when unavailable
- [x] `providers/anthropic.ts` — Provider A: streaming Messages API, `anthropic-dangerous-direct-browser-access`, abort
- [x] `providers/claudeCode.ts` — Provider B: native-host client (connect, send, stream, abort)

### 1c. Native host (Claude Code CLI)
- [x] `native-host/reviewer-host.mjs` — Node host: 4-byte LE length framing on stdin/stdout
- [x] Host runs the model via **lean `claude -p --output-format stream-json`** (subscription; Agent SDK / direct-OAuth noted as future)
- [x] Stream chunks back (deltas are small, well under the 1 MB cap); handle `abort`
- [x] Validate message shape (host runs with user privileges — no arbitrary commands)
- [x] Host manifest written by `install.sh` with `allowed_origins` pinned to the fixed extension ID
- [x] `install.sh` — register host on macOS / Linux for Edge/Chrome/Chromium/Brave *(Windows: noted, not yet scripted)*

### 1d. Background worker
- [x] `background/index.ts` — service-worker port router: route `ASK`/`ABORT`, relay `CHUNK`/`DONE`/`ERROR`
- [x] Wire registry + per-request `AbortController`

### 1e. Content script + dock
- [x] `content/index.ts` — inject on `github.com/*/pull/*`, mount a shadow-root host node
- [x] `content/dock/dock-panel.ts` — dock as a plain `<div>` + shadow root *(not a custom element — `customElements` is null in content scripts)*: collapsible, answer area, input
- [x] Styles inlined into the shadow root (isolation); keystrokes kept from GitHub's hotkeys
- [x] Streamed **markdown rendering** into the answer area (marked + DOMPurify)
- [x] `content/selection.ts` — `window.getSelection()` → `{file, lineRange, code, language}` (both `/files` + `/changes` views; `diffHunk` via GitHub API in Phase 2)

### 1f. Options page
- [x] `options/options.html` + `options.ts` — provider toggle, API-key entry, model select
- [x] Persist settings via `shared/storage.ts`
- [x] Data-egress notice (highlighted code is sent to Anthropic) + "not encrypted at rest" note

### 1g. End-to-end
- [x] **Gate:** verified on a real PR — highlight → ask → streamed answer (provider B / subscription in Edge; provider A request shape verified offline)

---

## Phase 1b — Out-of-the-box comments

- [ ] Canned-comment library (data file)
- [ ] Comments tray UI in the dock
- [ ] `content/comments.ts` — insert selected snippet into the focused GitHub comment `<textarea>`

---

## Phase 2 — GitHub API integration (PAT)

- [ ] PAT entry in options + storage (`chrome.storage.local`)
- [ ] `background/github/api.ts` — client for `GET /repos/{owner}/{repo}/pulls/{n}/files`
- [ ] Use API `patch` as **authoritative** grounding context (reduce DOM dependence)
- [ ] Map dock selection → `commit_id` / `path` / `line` / `side`
- [ ] Post line-anchored review comment: `POST /repos/{owner}/{repo}/pulls/{n}/comments`

---

## Phase 3 — Advanced review

- [ ] Whole-file / whole-PR review summary
- [ ] Per-selection threaded follow-ups (conversation `history`)
- [ ] Severity tags on findings
- [ ] Persist conversation per PR

---

## Later — Other platforms & distribution

- [ ] Abstract the content-script DOM layer behind a platform interface
- [ ] GitLab support
- [ ] Bitbucket support
- [ ] Review subscription-via-CLI ToS before any public distribution
- [ ] Packaging / Chrome Web Store listing (API-key provider only; CLI provider as opt-in)

---

## Cross-cutting / risks to watch
- GitHub diff DOM fragility → prefer GitHub API for ground truth (Phase 2).
- Fixed extension ID required for native messaging to keep working across reloads.
- Confirm live Anthropic model IDs/headers at build time — don't hard-code from memory.
