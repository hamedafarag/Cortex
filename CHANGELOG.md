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

### Changed
- **Dock collapses to a launcher button** — instead of an always-on bottom bar that floated
  over GitHub's content, the dock now starts as a small Cortex button (bottom-right). Click it
  to expand the **full-width** dock; collapse back to the button when done. Fixes the expanded
  dock hiding the comment box / page content behind it.

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
