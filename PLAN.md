# Cortex — Build Plan

Phased, task-level breakdown derived from [DESIGN.md](DESIGN.md).
Check items off as they land. Phases 0–3 (incl. batch review, Phase 3d) have **shipped**;
the active frontier is **Phase 4 — Visual review layer** and the **Later** section
(other platforms & distribution).

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
- [x] **Whole-PR review** — a **Review** button (no selection needed) reuses the summary's
  patch pipeline (`mode: 'review'` → `getPrPatches`) and streams a **findings list** into the
  answer as a thread turn. Each finding leads with a severity and a `path:line`, and rides the
  3a answer→comment bridge (Use as comment → Post to line). *(Whole-single-file review is
  subsumed: the whole-PR review already reads every changed file's full patch.)*
- [x] **AI PR summary** — a **Summarize PR** button (no selection needed) fetches all changed-file
  diffs (budgeted via `assemblePatches`/`getPrPatches`) and streams a structured summary —
  TL;DR · key changes · per-file gloss · **Review effort 1–5** — into the answer area as a thread
  turn (so follow-ups work). The `mode: 'summary'` ask carries `context.prPatches`; both prompt
  builders render it. *Verified: 11 Node + 5 dock assertions + live on a real GitHub PR in Edge.*
- [x] **Severity tags on findings** — each review finding leads with **Blocker / Major / Minor /
  Nit / Praise**; the dock's `decorateSeverities` pass upgrades that leading word into a
  **color-blind-safe chip** (icon **+** label, Primer-tinted) post-render. Runs on already-sanitized
  DOM via DOM APIs (nothing new for DOMPurify), and no-ops on plain answers/summaries.
- [x] **Specialist lenses** — a **lens select** (General / Security / Performance / Error
  handling / Readability) next to **Review** scopes that whole-PR review to one dimension by
  templating the instruction over the ask path (no system-prompt fork → no per-runtime mirror).
- [x] **Test-gap call-out** — a **Test gaps** button runs a deterministic, **no-LLM** path
  heuristic (`testGaps`) in the background over the changed-file list — which changed source
  files have no matching test change (matched by basename) — and renders the report as an instant
  answer turn. An approximation, not coverage (the report says so). *Verified: 33 Node + 28 dock
  assertions (headless Chrome) + screenshot; corrected live on a real PR (root `test.js` / `.test-d.ts`).*
- [x] **In-app features page** — a **?** button in the dock header opens a built-in, extension-served
  **features page** (`src/help/help.html`, a CRXJS build input → `chrome-extension://…`, adaptive
  light/dark) in a new tab via the background (`chrome.tabs.create`). Each feature has a screenshot
  (`public/help/*.png`). *Verified: renders end-to-end with images served from `dist/`.*

### 3c. Persistence & trust
- [x] **Persist per PR** — conversation turns + the unsent composer draft autosave to
  `chrome.storage.local` keyed by `repo#prNumber` (`shared/persistence.ts`, 50-PR LRU cap) and
  restore on mount. `syncToPr()` swaps the thread as the PR changes (fixing a latent SPA-nav bug
  where one PR's conversation carried onto another). *Verified: 12 Node + 16 dock assertions + live
  in Edge (restore across a real reload, per-PR scoping, empty clears storage).*
- [x] **Confirm / undo before posting** — *Post to line* now shows a **confirm bar** with the exact
  target (`repo · path:line`, range-aware) before the write, **and** a **10s Undo** window after a
  successful post (`deleteReviewComment` → `DELETE /pulls/comments/{id}`; `GH_POST_COMMENT` returns the
  `commentId`, `githubFetch` tolerates the 204). Posting is now `confirm → doPost → undoPost`. A
  **Refresh** action reloads to show the API-posted comment inline (GitHub's SPA won't render it
  otherwise); the composer clears on post and is restored on undo. *Verified: 16 + 13 dock UI + 5
  Node API assertions, typecheck + build; live confirm-gate in Edge, public write left to the user.*
- [x] **Secret redaction** — `shared/redact.ts` masks obvious secrets (provider key prefixes,
  private-key blocks, JWTs, `secret = "…"` assignments, and conservative high-entropy tokens) in
  **every code-bearing field** (`selectedCode` / `diffHunk` / `prPatches`) in the background just
  before the provider call, so secrets never hit the network. A `META` port message surfaces a
  color-blind-safe dock notice ("Masked N likely secrets…"). *Verified: 25 Node redaction
  assertions (real key shapes redacted; SHAs/UUIDs/identifiers kept — entropy threshold 4.5 sits in
  the measured gap) + 9 dock-notice assertions + screenshot.*

### 3d. Batch review ✅
- [x] **Batch / pending review + review verdict** (Comment / Approve / Request changes) — *graduated
  from deferred once 3a–3c were solid.* **Add to review** accumulates comments into a local
  `DraftComment[]` (a "Pending review · N" panel, persisted per PR), then **Submit review** sends one
  `POST /pulls/{n}/reviews` (`comments[]` + `event`), gated by a confirm; GitHub requires an overall
  `body` for Comment/Request-changes (validated client-side). Single **Post to line** is kept alongside
  (GitHub-style both). *Verified: 18 + 14 dock + 3 persistence + 7 Node API assertions; live in Edge
  (submitted + cleaned up a real review on a draft PR).*

### Deferred / out of scope (decided, not forgotten)
- ~~Mark-as-viewed / file-progress tracking~~ — **skip:** GitHub ships per-file "Viewed" with
  a progress bar natively; reimplementing it fights GitHub's DOM for low marginal value.
- ~~Autonomous auto-review (bot mode)~~ — **skip:** against Cortex's human-in-the-loop identity.

---

## Phase 4 — Visual review layer (PR at a glance)

Make review more visual and impact-oriented — show the reviewer *where to look* before
they read a line. Sequenced by cost/risk: deterministic data first (free, no hallucination),
LLM-generated diagrams last (heaviest dep, weakest grounding from diff-only context). Adjacent
to [CodeBoarding](https://github.com/CodeBoarding/CodeBoarding) (whole-repo architecture diagrams) —
prefer *consuming* its `.codeboarding/` output over reproducing whole-repo analysis in a content script.

- [x] **4a. Churn / impact panel** — an **Overview** button (no selection) renders a per-file
  **change map**: files changed, additions/deletions and **net** per file, each with a unicode
  **churn bar** scaled to the largest file, plus a status tally (modified/added/deleted/…). A
  **deterministic, no-LLM** path: `assembleOverview` + `formatOverviewReport` (pure, in
  `github/api.ts`) shape the `listPullFiles` diffstat the worker already fetches → zero tokens,
  instant. Mirrors the test-gap pattern (new `GH_PR_OVERVIEW` message → markdown report into the
  answer area, so follow-ups + the answer→comment bridge still work); long PRs cap at the top 20
  files by churn with a tail note. *Verified: 18 Node assertions on the pure shaping (sums, sort,
  net, status tally, bars, empty PR, determinism, cap) + typecheck + build.*
- [x] **4b. Impact-by-module view** — **folded into Overview** (no second button): a multi-module
  PR now leads with a **By module** rollup (changed paths grouped by their first up-to-2 directory
  segments, `(root)` for top-level files), each with file count + churn bar, then the **By file**
  detail. Path-only, **no LLM**, no repo fetch; single-module PRs render unchanged (no rollup).
  Pure `moduleKey` + `assembleOverview` extension in `github/api.ts`. *Verified: 23 Node assertions
  (2-segment grouping, `(root)`, rollup sums, sort, multi- vs single-module rendering, cap) +
  typecheck + build.*
- [ ] **4c. (optional) Changed-component diagram** — LLM-emitted **Mermaid** diagram scoped to the
  components touched by *this PR* (not a whole-repo dep graph), **lazy-loaded** (Mermaid.js is heavy),
  rendered in the shadow root, **labeled approximate** (diff-only grounding can invent edges). If the
  repo already ships `.codeboarding/`, render that instead of generating.

---

## Later — Other platforms & distribution

- [ ] Abstract the content-script DOM layer behind a platform interface
- [ ] GitLab support
- [ ] Bitbucket support
- [ ] Review subscription-via-CLI ToS before any public distribution
- [x] Packaging / Chrome Web Store listing (API-key provider only; CLI provider as opt-in) —
  *engineering done; submission is the user's (outward-facing).* `nativeMessaging` moved to
  **`optional_permissions`**, requested at runtime from the options page only when the user picks
  the CLI backend (default install = Anthropic API key, smallest permission surface); the CLI
  provider + native host degrade cleanly when the permission isn't granted. Added `npm run package`
  (`scripts/package.mjs` → store-ready `web-store/cortex-<version>.zip`, gitignored), synced
  `package.json` to v0.1.0, made `install.sh` accept the **store extension id** (the store assigns
  its own, ≠ the dev id), and wrote **[STORE-LISTING.md](STORE-LISTING.md)** (listing copy,
  permission justifications, data disclosures, native-host caveat, submission checklist) +
  **[PRIVACY.md](PRIVACY.md)**. *Left to the user: dev account, 1280×800 screenshots, hosting the
  privacy policy, and submitting for review. CLI-subscription ToS still to confirm before
  advertising the CLI backend (see risks).*

---

## Cross-cutting / risks to watch
- GitHub diff DOM fragility → prefer GitHub API for ground truth (Phase 2).
- Fixed extension ID required for native messaging to keep working across reloads.
- Confirm live Anthropic model IDs/headers at build time — don't hard-code from memory.
- **CLI-subscription ToS is a distribution blocker, not a checklist item.** If running the
  user's Claude subscription via the native host isn't permitted for distribution, Provider B
  can't ship publicly — resolve this *before* investing in packaging (see Later). Provider A
  (BYO API key) is unaffected.
- **Testing debt:** no test runner — every feature is verified via throwaway esbuild/Node
  harnesses. It's held up, but for a tool that does real public writes, consolidating these into
  a proper runner is the main accruing debt.
