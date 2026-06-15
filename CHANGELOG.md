# Changelog

All notable changes to **Cortex — AI Review Assistant**. Versions track the extension's
manifest version; format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased] — Phase 3 (from answer to action)

### Added
- **Answer → comment bridge** — a finished AI answer now offers **Use as comment** (loads the
  answer into the composer to edit, then post via *Post to line*) and **Copy**, closing the
  retype gap between the answer and the comment box. Edit-then-post keeps the human in the
  loop before any public write. (Phase 3a)
- **PR-intent grounding** — asks now include the PR **title + description** (fetched from the
  GitHub API, cached per-PR, body truncated), so the model can judge whether a change does
  what it claims, not just whether it's locally correct. The per-turn prompt builder moved to
  a dependency-free `shared/prompt.ts` (mirrored by the native host), and both system prompts
  were updated to use the stated intent. (Phase 3a)
- **Committable suggestions** — a **Suggest a fix** button asks the model for a single
  GitHub `suggestion` block for the selection; it rides the answer→comment bridge and posts as
  a one-click-appliable suggestion. Review-comment posting now supports **multi-line anchors**
  (`start_line`/`start_side`), so a suggestion replaces exactly the selected lines and ordinary
  comments attach to the whole selection. (Phase 3a)
- **Conventional Comments picker** — a **Label** tray composes a `label (decoration): ` prefix
  (praise / nit / suggestion / issue / question / thought / chore × none / non-blocking /
  blocking / if-minor) and prepends it to the focused comment box, so review notes read
  clearly as blocking, optional, or FYI. (Phase 3a)
- **Threaded follow-ups** — the dock now keeps a conversation: ask a follow-up and the model
  receives the prior turns (`AskRequest.history`, wired through both the API provider and the
  CLI host). The answer area shows the thread (questions + answers); a **New thread** button
  resets it. (Phase 3a)
- **AI PR summary** — a **Summarize PR** button (no selection needed) fetches all changed-file
  diffs (budgeted) and streams a structured summary — TL;DR, key changes, a per-file gloss, and
  a **1–5 review-effort** rating — into the dock as a thread turn, so you can ask follow-ups.
  (Phase 3b)
- **Whole-PR review** — a **Review** button (no selection needed) reuses the summary's patch
  pipeline (`mode: 'review'`) and streams a **findings list** into the dock as a thread turn.
  Each finding rides the answer→comment bridge, so it's promotable to a real review comment.
  (Phase 3b)
- **Severity tags** — each review finding leads with **Blocker / Major / Minor / Nit / Praise**,
  rendered as a **color-blind-safe chip** (icon **+** label, Primer-tinted) so you can triage
  blocker-vs-nit at a glance. The decoration no-ops on plain answers and summaries. (Phase 3b)
- **Specialist review lenses** — a **lens** select beside *Review* (Security · Performance ·
  Error handling · Readability, plus General) scopes a whole-PR review to one dimension for that
  one turn. (Phase 3b)
- **Test-gap check** — a **Test gaps** button runs a deterministic, **no-LLM** path heuristic
  over the changed-file list and reports which changed source files have **no matching test
  change** (matched by file name). An approximation, not coverage — and it says so. (Phase 3b)
- **In-app features page** — a **?** button in the dock header opens a built-in **features
  page** (in a new tab) showcasing every capability with screenshots. It's a real
  extension-served page (`src/help/help.html` → `chrome-extension://…`, adaptive light/dark),
  opened via the background (`chrome.tabs.create`) — no internet, no third party. (Phase 3b)
- **Persistent threads per PR** — your conversation **and** the unsent composer draft now
  autosave to `chrome.storage.local` keyed by `repo#prNumber` and **restore when you return to a
  PR** (after a reload or in-page navigation). A 50-PR LRU cap keeps storage bounded. Also fixes a
  bug where navigating between PRs carried one PR's conversation onto another. (Phase 3c)
- **Confirm + Undo before posting** — *Post to line* now asks you to **confirm the exact target**
  (`repo · path:line`) before the public write, and offers a **10-second Undo** afterwards that
  deletes the comment. Belt-and-suspenders for the one irreversible action in the tool. A
  **Refresh** action shows the comment inline (GitHub's SPA won't render an API-posted comment on
  its own); the composer clears on a successful post and is restored if you Undo. (Phase 3c)
- **Secret redaction** — obvious secrets (API-key prefixes, private-key blocks, JWTs,
  `secret = "…"` assignments, and high-entropy tokens) are **masked before the request leaves the
  browser**, across the selection, the diff hunk, and whole-PR patches. The dock shows a notice
  when something was masked. Reinforces "your key, no third-party SaaS." (Phase 3c)
- **Batch review + verdict** — beyond single comments, you can now **Add to review** to build up a
  **pending review** (a panel of line comments, persisted per PR) and **Submit** it as one review
  with a **Comment / Approve / Request changes** verdict (GitHub Reviews API), gated by a confirm.
  Single **Post to line** stays for one-off comments.
- **PR overview / change map** — an **Overview** button (no selection needed) renders a
  **deterministic, no-LLM** "PR at a glance": files changed, additions/deletions and net per file,
  with a churn bar so you can see where the weight is before reading a line. Multi-module PRs lead
  with a **By module** rollup (changed paths grouped by directory) before the per-file detail, so
  scope reads top-down. Built entirely on the file list Cortex already fetches (zero tokens), and
  rides the same answer path as the test-gap check. (Phase 4a/4b)
- **Regression test suite** — the project's first automated tests: **Vitest + jsdom** with an
  in-memory `chrome.*` stub (`test/setup.ts`). **656 tests across all 14 modules** — redaction,
  prompt building, persistence, settings, diff-selection parsing, the dock wiring (including a
  guard that the composer stays bound to the Ask textarea), canned comments, the GitHub API +
  test-gap heuristic, the provider registry, both providers, and the background routers. Run
  with `npm test` (`test:watch`, `test:cov`).

### Changed
- **CLI backend is now opt-in** — `nativeMessaging` moved from a required permission to
  `optional_permissions`. The default install (Anthropic API key) carries the smallest permission
  surface; choosing the Claude Code CLI backend in options requests the permission at runtime, and
  the CLI provider degrades cleanly if it isn't granted. Prep for a Chrome Web Store listing.
- **Packaging** — `npm run package` builds and zips a store-ready `web-store/cortex-<version>.zip`;
  `install.sh` now accepts the store-assigned extension id (`./install.sh <id>`) for opt-in CLI
  users, since the Web Store assigns its own id. Added STORE-LISTING.md + PRIVACY.md; version → 0.1.0.
- **Dock collapses to a launcher button** — instead of an always-on bottom bar that floated
  over GitHub's content, the dock now starts as a small Cortex button (bottom-right). Click it
  to expand the **full-width** dock; collapse back to the button when done. Fixes the expanded
  dock hiding the comment box / page content behind it.

### Fixed
- **Composer was bound to the wrong textarea** — `DockPanel` selected its input with a bare
  `querySelector('textarea')`, which matched the batch-review **summary** box (added above the
  composer in the DOM) instead of the Ask composer. Every `submit()` read an empty string and
  silently bailed, breaking **Ask, Post to line, Add to review, Cmd/Ctrl+Enter, "Use as
  comment", and per-PR draft save/restore** at once. Now scoped to `.composer textarea`, with a
  regression test that fails if it ever drifts again.
- **Empty `data-line-number` resolved to line 0** — on added/deleted diff rows the absent side
  carries an empty `data-line-number`; `Number('')` is `0`, so a selection touching such a row
  anchored a review at `start_line: 0` (rejected/mis-anchored by the Reviews API). Now rejects
  non-positive / non-integer line numbers.
- **Secret redaction missed quoted JSON/YAML keys** — `"api-key": "…"` (the canonical config
  secret shape) slipped through unmasked while the unquoted form was caught. The assignment
  matcher now allows an optional closing quote after the keyword.
- **Redaction count was not idempotent** — re-redacting already-masked text re-counted the
  `[REDACTED]` placeholder, inflating the "masked N secrets" figure shown to the reviewer. A
  no-op pass now reports 0.

## [0.1.0] — 2026-06-11

First feature-complete build — Phases 0 · 1 · 1b · 2 · 2.5.

### Added — foundation & the dock (Phases 0–1)
- MV3 scaffold (TypeScript + Vite + CRXJS) with a fixed `key` → stable extension id.
- In-page **dock** on GitHub PR pages: highlight diff code → ask → streamed,
  markdown-rendered (sanitized) answer.
- Two backends behind one `LlmProvider` interface with automatic fallback:
  **Anthropic API** (BYO key, streaming via `@anthropic-ai/sdk`) and **Claude Code CLI**
  (the user's subscription, via a Node native-messaging host shelling lean `claude -p`),
  plus `install.sh`.
- Selection → `{file, lineRange, side, code, language}` mapping for the classic `/files`
  and the new `/changes` diff views.
- Options page (backend, key, model); settings persisted in `chrome.storage.local`.

### Added — out-of-the-box comments (Phase 1b)
- Canned review-comment tray (Nit, Needs test, Naming, …) that inserts into GitHub's
  comment box.

### Added — GitHub API integration (Phase 2)
- GitHub PAT in options; PAT-authed REST client (head sha, files/patch, comments).
- **Post line-anchored review comments** straight to a PR from the dock.
- **Authoritative diff-hunk grounding** — asks include the real `@@` hunk fetched from the
  GitHub API (cached per PR), not just the scraped DOM.

### Added — UI & identity (Phase 2.5)
- Rebranded to **Cortex — AI Review Assistant** (v0.1.0); synapse logomark + extension
  icons generated from `public/icons/icon.svg` (`npm run icons`).
- Dock redesign: inherits GitHub Primer tokens (native light/dark), Cortex accent + top
  edge, authored inline SVG line-icons, loading spinners (Thinking… / Posting…), and
  **color-blind-safe** status (icon + label).
- Options restructured into **AI backend / GitHub / About** cards (adaptive light/dark).

### Fixed (surfaced during in-browser testing)
- Dock keystrokes triggering GitHub's global hotkeys → `stopPropagation` at the shadow host.
- Canned-comment insert losing focus / not landing → `mousedown` preventDefault;
  `tagName`/`activeElement` field detection (not cross-world `instanceof`); native-setter
  fallback for React-controlled fields.
- Ask/Post losing the diff selection when typing in the dock → remember the last diff
  selection.
- GitHub API errors made actionable — 401/403/404 explain auth / write permission / repo
  access + org-approval.

### Notes
- Internal identifiers (`com.ycra.reviewer`, `data-ycra-*`, the fixed key) intentionally
  left unchanged across the rebrand to avoid breaking the installed native host.
- GitHub-only. Next: Phase 3 (whole-PR review, threaded follow-ups, severity tags) — see
  `PLAN.md`.
