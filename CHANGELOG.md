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
