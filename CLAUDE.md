# CLAUDE.md

Guidance for AI assistants (Claude Code) working in this repo.

## What this is

**Cortex — AI Review Assistant**: a Manifest V3 browser extension (TypeScript + Vite +
`@crxjs/vite-plugin`) that adds an in-page AI copilot to GitHub PR pages — highlight diff
code → ask / insert canned comments / post line-anchored review comments. Backends:
**Anthropic API** (BYO key) or the local **Claude Code CLI** (the user's subscription, via
a native-messaging host). No third-party SaaS. GitHub-only.

## Commands

- `npm run build` — production build → self-contained `dist/` (load unpacked). **Use this
  for testing.**
- `npm run dev` — Vite + CRXJS HMR. Faster, BUT the loaded extension **breaks if the dev
  server stops** — prefer `build` for testing.
- `npm run typecheck` — `tsc --noEmit`. Run after changes.
- `npm run icons` — regenerate PNG icons from `public/icons/icon.svg`.
- `npm test` — **Vitest** (`jsdom` env, globals on). Co-located `*.test.ts`; shared in-memory
  `chrome.*` stub + helpers in `test/setup.ts` (reset before each test). `test:watch`,
  `test:cov`. ~656 tests across all 14 modules — run after changes. Test files are excluded
  from the `tsc` build. Still verify DOM cross-world / GitHub-DOM behaviour **in-browser** —
  jsdom can't model the isolated-world quirks.

## Architecture (where things live)

- `src/background/` — MV3 service worker. `index.ts` = long-lived **port router** (streams
  `ASK → CHUNK/DONE/ERROR`) + a one-shot **GitHub message handler**. Owns ALL secrets and
  network.
  - `providers/` — `LlmProvider` interface + `registry.ts` (pick from settings, fall back).
    `anthropic.ts` (SDK streaming), `claudeCode.ts` (`connectNative` client).
  - `github/api.ts` — PAT-authed REST: head sha, PR title/body, files/patch (diff grounding), budgeted whole-PR patches (summary/review), a pure path-based **test-gap** heuristic, post comment (single- or multi-line), delete comment (the Undo window), submit review (batch comments + verdict via the Reviews API).
- `src/content/` — injected on github.com. `index.ts` mounts the dock, **tracks the last
  diff selection**, bridges ask/post. `dock/dock-panel.ts` = the UI, `dock/icons.ts` =
  inline SVGs. `selection.ts` = DOM → `{file, line, side, code}` + `reviewTarget` (post anchor,
  multi-line aware). `comments.ts` = canned comments + Conventional Comments labels,
  insert/prepend into GitHub's textarea.
- `src/options/` — options page (backend, key, model, PAT, About).
- `src/help/help.html` — the **features page** opened by the dock's `?` button. An extra CRXJS
  build input (declared in `vite.config.ts`'s `rollupOptions.input`) → emitted to
  `dist/src/help/help.html`; opened via the background's `chrome.tabs.create`. Screenshots live in
  `public/help/*.png` (copied to `dist/help/`). Static HTML/CSS, no module script (MV3 CSP).
- `src/shared/` — `types.ts`, `messages.ts` (wire protocols), `storage.ts` (settings),
  `prompt.ts` (`buildUserContent`; the native host mirrors it), `persistence.ts` (per-PR
  conversation/draft store, keyed by `repo#prNumber`), `redact.ts` (mask secrets before send).
- `native-host/reviewer-host.mjs` — Node host; shells lean `claude -p`. `install.sh`
  registers it.
- `manifest.config.ts` — CRXJS MV3 manifest (fixed `key` → stable ext id `cafladk…`).

Full architecture in `DESIGN.md`; roadmap/status in `PLAN.md`; market in `COMPETITORS.md`;
review-feature catalog (gap vs planned, effort/impact) in `FEATURE-LANDSCAPE.md`.

## Conventions

- TypeScript strict. Match the surrounding style; comments only where they earn their place.
- The **background worker** is the only place with secrets (API key, PAT) and network —
  content scripts message it.
- **Adaptive theming**: the dock inherits GitHub Primer CSS vars (`--bgColor-*`,
  `--fgColor-*`, `--borderColor-*`, `--fgColor-accent`, …) so it's native light/dark. The
  options page uses `prefers-color-scheme`.
- **Color-blind-safe** status: always icon **+** label, never colour alone.
- Commit messages: imperative, end with the `Co-Authored-By: Claude …` line. Commit/push
  only when asked.

## Gotchas (hard-won — don't rediscover)

- **No custom elements in content scripts** — `customElements` is `null` in the isolated
  world. The dock is a plain `<div>` + attached shadow root.
- **Cross-world quirks**: use `tagName`/`activeElement`, NOT `instanceof`, on DOM from event
  targets. Shadow-DOM inputs leak keystrokes to GitHub's hotkeys → `stopPropagation` on the
  host. A selection set programmatically from another world reaches the content script a
  tick later (the dock remembers the last diff selection to survive this).
- **GitHub `/changes` diff view** (replaces `/files`): file path in
  `aria-label="Diff for: <path>"`; line numbers in `data-line-number` (+ `data-diff-side`);
  big PRs are **virtualized**; hunk-header / gutter cells are `user-select: none`.
- **`claude -p` is heavy** even lean (`--setting-sources "" --strict-mcp-config`, disabled
  file/bash tools, neutral cwd): ~10–17k tokens of base prompt/call. `CLAUDE_CODE_SIMPLE`
  strips it but forces API-key auth (no subscription). stream-json text =
  `stream_event → content_block_delta → text_delta`; ignore `thinking_delta`; `result` =
  done/`is_error`.
- **Native host PATH**: the browser launches it with a minimal PATH, so `install.sh` bakes
  absolute node + claude paths into a wrapper `reviewer-host.sh` (gitignored).
- **Don't rename internal ids** (`com.ycra.reviewer`, `data-ycra-*`, the fixed key / ext
  id) — it breaks the installed native host. "Cortex" is the user-facing name only.
- **CRXJS + `public/`**: Vite copies `public/icons/*` to `dist/icons/*` (drops the
  `public/` prefix) — manifest icon paths must be `icons/...`, not `public/icons/...`.

## Safety

- Posting a review comment is a real public write. **Never post to a repo you don't own or
  without explicit user say-so.** Test reads against public repos; leave success-path
  posting to the user on their own repo.
- Keys / PAT are the user's; never log or exfiltrate them. They live in
  `chrome.storage.local` (not encrypted at rest).
