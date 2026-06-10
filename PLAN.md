# Your Code Review Assistant — Build Plan

Phased, task-level breakdown derived from [DESIGN.md](DESIGN.md).
Check items off as they land. The session todo list tracks the **active** phases
(Phase 0 + Phase 1); later phases live here only until we start them.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Scaffolding & tooling

- [ ] Init project: `npm`, TypeScript, Vite, `@crxjs/vite-plugin`
- [ ] Create folder structure (`src/background`, `src/content`, `src/options`, `src/shared`, `native-host/`)
- [ ] `tsconfig.json` + `vite.config.ts` configured for MV3
- [ ] `manifest.config.ts` (MV3) with a **fixed `"key"`** so the extension ID is stable in dev
- [ ] Minimal permissions: `host_permissions` (`github.com`, `api.anthropic.com`), `nativeMessaging`
- [ ] Placeholder icons in `public/icons/`
- [ ] **Gate:** load-unpacked succeeds — empty extension appears in `chrome://extensions`

---

## Phase 1 — Dock panel + highlight-and-ask (both providers)

### 1a. Shared contracts
- [ ] `shared/messages.ts` — port protocol (`ASK`/`ABORT` → `CHUNK`/`DONE`/`ERROR`) + native-host protocol types
- [ ] `shared/storage.ts` — settings get/set over `chrome.storage.local`
- [ ] `background/providers/types.ts` — `LlmProvider`, `AskRequest`, `Chunk`

### 1b. Provider layer
- [ ] `providers/registry.ts` — pick active provider from settings + **fallback** when unavailable
- [ ] `providers/anthropic.ts` — Provider A: streaming Messages API, `anthropic-dangerous-direct-browser-access`, abort
- [ ] `providers/claudeCode.ts` — Provider B: native-host client (connect, send, stream, abort)

### 1c. Native host (Claude Code CLI)
- [ ] `native-host/reviewer-host.js` — Node host: 4-byte LE length framing on stdin/stdout
- [ ] Host runs the model via **Claude Agent SDK** (fallback: `claude -p --output-format stream-json`)
- [ ] Stream chunks back respecting the **1 MB per-message cap**; handle `abort`
- [ ] Validate/whitelist message shape (host runs with user privileges — no arbitrary commands)
- [ ] `native-host/manifest.template.json` with `allowed_origins` pinned to the fixed extension ID
- [ ] `install.sh` / `install.ps1` — register host per-OS (macOS / Linux / Windows registry)

### 1d. Background worker
- [ ] `background/index.ts` — service-worker port router: route `ASK`/`ABORT`, relay `CHUNK`/`DONE`/`ERROR`
- [ ] Wire registry + per-request `AbortController`

### 1e. Content script + dock
- [ ] `content/index.ts` — inject on `github.com/*/pull/*`, mount a shadow-root host node
- [ ] `content/dock/dock-panel.ts` — `<dock-panel>` Web Component: collapsible, answer area, input
- [ ] `content/dock/dock.css` — styles inlined into the shadow root (isolation)
- [ ] Streamed markdown rendering into the answer area
- [ ] `content/selection.ts` — `window.getSelection()` → `{file, lineRange, code, diffHunk}` from diff DOM

### 1f. Options page
- [ ] `options/options.html` + `options.ts` — provider toggle, API-key entry, model select
- [ ] Persist settings via `shared/storage.ts`
- [ ] Data-egress notice (highlighted code is sent to Anthropic) + "not encrypted at rest" note

### 1g. End-to-end
- [ ] **Gate:** manual test on a real PR — highlight → ask → streamed answer, via **both** providers

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
