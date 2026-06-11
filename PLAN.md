# Cortex — Build Plan

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

## Phase 1b — Out-of-the-box comments ✅

- [x] Canned-comment library (`content/comments.ts` — 10 review snippets)
- [x] Comments tray UI in the dock (chips; `mousedown` preventDefault so GitHub's field keeps focus)
- [x] Insert snippet into the focused GitHub comment `<textarea>` (execCommand + native-setter fallback; field found by `tagName`/`activeElement`, robust across the content-script world)

---

## Phase 2 — GitHub API integration (PAT)

- [x] PAT entry in options + storage (`chrome.storage.local`) with security guidance
- [x] `background/github/api.ts` — PAT-authed client (`getPullHeadSha`, `listPullFiles`, `createReviewComment`)
- [x] Use API `patch` as **authoritative** grounding context — `getDiffHunk` (cached `listPullFiles` + hunk parser) enriches each ask's `diffHunk` in the background (best-effort)
- [x] Map dock selection → `path` / `line` / `side`; `commit_id` resolved in the background
- [x] Post line-anchored review comment: `POST /repos/{owner}/{repo}/pulls/{n}/comments` (wiring verified via safe 401; real post needs a PAT)

---

## Phase 2.5 — UI & Identity ✅

- [x] Rebrand to **Cortex — AI Review Assistant** (manifest, dock, options, README; v0.1.0); internal ids unchanged
- [x] License-clean inline SVG icon set (`content/dock/icons.ts` — authored, no external assets)
- [x] Redesign the dock — adaptive GitHub Primer theming (native light/dark), synapse logomark, Cortex top edge + indigo Ask, monospace technical accents, icon buttons
- [x] Loading states for every async status (Thinking… / Posting… spinners + status rows)
- [x] Color-blind-safe status — icon + label on every state, never colour alone
- [x] Redesign options into AI backend / GitHub / About cards (adaptive light+dark) with version + privacy summary

---

## Phase 3 — From answer to action

Reframed after a review-tooling landscape survey (CodeRabbit, Greptile, Qodo Merge,
Sourcery, Conventional Comments, Reviewdog, Codecov, …) — full catalog with per-feature
exemplars + effort/impact in [FEATURE-LANDSCAPE.md](FEATURE-LANDSCAPE.md). The finding: the highest-leverage
work is **not net-new infrastructure** but unlocking value already latent in the code — the
GitHub post pipeline, and the under-fed `AskRequest.context` / `history` fields. The
through-line: **make the AI's output land in the PR as real, well-labeled review comments.**
Still reviewer-driven, on demand, never autonomous.

### 3a. Quick wins — harvest what's already wired (low effort, high impact)
- [x] **Answer → comment bridge** — a "Use as comment" action under a finished answer loads
  the streamed text into the composer (editable, focused); the existing "Post to line" then
  does the write (edit-then-post — keeps the human-in-the-loop confirm). Plus a "Copy" action.
  Entirely in `dock-panel.ts` (+ a `copy` icon) — no new wire/background/API code, as predicted.
  *Verified in-browser via a component harness: 13 behavioural assertions + screenshots.*
- [x] **PR intent context injection** — every ask now fetches the PR **title + description**
  (`getPullMeta`, cached per-PR, body truncated) and injects them into `AskRequest.context`,
  enriched best-effort in the background alongside the diff hunk. Both prompt builders render
  them (intent before code) and both system prompts tell the model to judge the change against
  its stated intent. Builder extracted to a dependency-free `shared/prompt.ts` (host mirrors it).
  *Verified: 8 prompt-assembly assertions on the real builder.*
- [x] **Committable `suggestion` blocks** — a **Suggest a fix** button asks the model for ONLY
  a triple-backtick `suggestion` block for the selection; it streams into the answer and rides
  the answer→comment bridge, so it posts via the existing comment path (no new API).
  `createReviewComment` + `GH_POST_COMMENT` gained optional `start_line`/`start_side`, and a
  pure `reviewTarget()` anchors a multi-line selection to the whole range (`startLine`..`line`)
  so the suggestion replaces exactly those lines (single-line selections unchanged). This also
  makes ordinary multi-line comments anchor to the full selection. *Verified: 8 `reviewTarget`
  assertions (Node) + 7 dock-UI assertions (browser) + screenshot.*
- [x] **Conventional Comments picker** — a second dock tray adds Conventional Comments labels
  (praise / nit / suggestion / issue / question / thought / chore) + a decoration select
  (none / non-blocking / blocking / if-minor); clicking a label **prepends** `label: ` or
  `label (decoration): ` to the focused GitHub comment box via `prependComment` (the insert
  path refactored to share field-finding). *Verified: 8 component-harness checks + a real test
  on a live GitHub PR in Edge — prepended `suggestion (non-blocking): …` into GitHub's actual
  comment textarea with focus retained.*
- [x] **Threaded follow-ups** — `AskRequest.history` wired end-to-end. The dock owns the
  conversation: it renders prior Q&A turns, exposes `getHistory()` to feed the next request,
  and has a **New thread** reset. The API provider already mapped history to messages; the CLI
  host now serializes it as a `Conversation so far:` transcript too (it was silently dropping
  follow-up context). *Verified: 6 host assertions (Node) + 18 dock-flow assertions (browser)
  + screenshot.*

### 3b. On-demand review depth
- [ ] **Whole-file / whole-PR review** — feed the full file patch (not one hunk) / all file
  patches and return a findings list; each finding promotable to a comment via 3a.
- [ ] **AI PR summary** — a "Summarize PR" button: stream a TL;DR + key changes from the file
  patches into the answer area. Fold in a per-file one-line gloss and a 1–5 effort badge.
- [ ] **Severity tags on findings** — structured label per finding, rendered icon + label
  (color-blind-safe), for blocker-vs-nit triage.
- [ ] **Specialist lenses** — preset Security / Performance / Error-handling / Readability
  buttons that scope the system prompt for one turn (prompt templating over the ask path).
- [ ] **Test-gap call-out** — a heuristic "which changed source files have no matching test
  changes?" pass over the file list (tests detected by path). An approximation, not coverage.

### 3c. Persistence & trust
- [ ] **Persist per PR** — store conversation turns + draft comments keyed by
  `repo#prNumber` in `chrome.storage.local`; restore on mount.
- [ ] **Confirm / undo before posting** — posting is a real public write (see Safety): add a
  confirm affordance, or a post-then-Undo window (`DELETE /pulls/comments/{id}`).
- [ ] **Secret redaction** — mask obvious secrets (key patterns / high-entropy strings) in the
  selection before it leaves the browser; show a notice in the dock when something was
  redacted. Strengthens the "your key, no third-party SaaS" trust story.

### Deferred / out of scope (decided, not forgotten)
- [ ] **Batch / pending review + review verdict** (Approve / Request changes) — requires
  migrating from standalone comments to the Reviews API (`POST /pulls/{n}/reviews` with a
  `comments[]` array + submit `event`). Real value for high-volume reviewers but the heaviest
  item here — defer until 3a/3b are solid, and gate the verdict behind explicit user action.
- ~~Mark-as-viewed / file-progress tracking~~ — **skip:** GitHub ships per-file "Viewed" with
  a progress bar natively; reimplementing it fights GitHub's DOM for low marginal value.
- ~~Autonomous auto-review (bot mode)~~ — **skip:** against Cortex's human-in-the-loop identity.

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
