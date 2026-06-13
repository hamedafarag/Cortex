// Content script — entry point. Runs on github.com; activates on PR pages.
// Mounts the dock, tracks the last diff selection, and bridges asks + comment
// posts to the background worker.

import {
  PORT_NAME,
  type BackgroundToContent,
  type ContentToBackground,
  type GithubRequest,
  type GithubResult,
  type TestGapsMessage,
  type TestGapsResult,
  type OpenHelpMessage,
} from '../shared/messages'
import type { AskRequest } from '../shared/types'
import { captureSelection, reviewTarget, type SelectionContext } from './selection'
import {
  CANNED_COMMENTS,
  CC_LABELS,
  CC_DECORATIONS,
  conventionalPrefix,
  insertComment,
  prependComment,
  trackCommentFields,
} from './comments'
import { DOCK_SELECTOR, DockPanel } from './dock/dock-panel'

// Presence marker: load signal + double-injection guard (visible to page context).
if (!document.documentElement.dataset.ycraLoaded) {
  document.documentElement.dataset.ycraLoaded = '0.0.0'
}

let currentDock: DockPanel | null = null
// The last real diff selection — remembered so Ask/Post still work after the user
// clicks into the dock (which moves the browser selection off the diff).
let lastSelection: SelectionContext | null = null

/** Parse "owner/repo" + PR number from a /pull/ URL, or null if not a PR page. */
function parsePr(): { repo: string; prNumber: number } | null {
  const m = location.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  return m ? { repo: m[1], prNumber: Number(m[2]) } : null
}

function selectionLabel(s: SelectionContext): string {
  return s.file
    ? `${s.file}${s.lineRange ? ` :${s.lineRange[0]}-${s.lineRange[1]}` : ''}`
    : `${s.selectedCode.length} chars selected`
}

/** Send one ask over a fresh port and stream the reply into the dock. */
function ask(request: AskRequest, dock: DockPanel, display?: string): void {
  const id = crypto.randomUUID()
  const port = chrome.runtime.connect({ name: PORT_NAME })
  let settled = false

  dock.startAnswer(request.question, display)

  port.onMessage.addListener((msg: BackgroundToContent) => {
    if (msg.id !== id) return
    switch (msg.type) {
      case 'CHUNK':
        dock.appendText(msg.delta)
        break
      case 'DONE':
        settled = true
        dock.finishAnswer()
        port.disconnect()
        break
      case 'ERROR':
        settled = true
        dock.showError(msg.message)
        port.disconnect()
        break
    }
  })

  port.onDisconnect.addListener(() => {
    if (!settled) dock.showError('Connection to the extension was lost. Try again.')
  })

  const message: ContentToBackground = { type: 'ASK', id, request }
  port.postMessage(message)
}

function onSubmit(dock: DockPanel, question: string): void {
  const pr = parsePr()
  if (!pr) {
    dock.showError('Open a pull request to ask about its code.')
    return
  }
  if (!lastSelection) {
    dock.showError('Select some code in the diff first, then ask.')
    return
  }
  const s = lastSelection
  ask(
    {
      question,
      context: {
        repo: pr.repo,
        prNumber: pr.prNumber,
        file: s.file,
        lineRange: s.lineRange,
        selectedCode: s.selectedCode,
        language: s.language,
      },
      history: dock.getHistory(),
    },
    dock,
  )
}

/** Instruction that turns an ask into a one-click-appliable GitHub suggestion. */
const SUGGEST_INSTRUCTION =
  'Suggest a fix for the selected code. Reply with ONLY a single GitHub suggestion block — ' +
  'a fenced code block tagged `suggestion` containing the exact replacement for the selected ' +
  'lines and nothing else (no prose before or after). If no change is needed, say so in one line.'

/** Ask the model for a committable suggestion for the current selection. Reuses the ask
 *  stream + the answer→comment bridge: the result lands in the answer, ready to post. */
function onSuggest(dock: DockPanel): void {
  const pr = parsePr()
  if (!pr) {
    dock.showError('Open a pull request to suggest a fix.')
    return
  }
  if (!lastSelection) {
    dock.showError('Select the code to replace in the diff first.')
    return
  }
  const s = lastSelection
  ask(
    {
      question: SUGGEST_INSTRUCTION,
      context: {
        repo: pr.repo,
        prNumber: pr.prNumber,
        file: s.file,
        lineRange: s.lineRange,
        selectedCode: s.selectedCode,
        language: s.language,
      },
      history: dock.getHistory(),
    },
    dock,
    'Suggest a fix',
  )
}

/** Instruction for the whole-PR summary (the background attaches all file diffs). */
const SUMMARY_INSTRUCTION =
  'Summarize this pull request for a reviewer about to review it, grounded only in the ' +
  'provided diffs and PR description. Structure the answer as:\n\n' +
  '**TL;DR** — 1–2 sentences: what it does and why.\n\n' +
  '**Key changes** — a short bullet list of the substantive changes (skip pure formatting/noise).\n\n' +
  '**By file** — a one-line gloss for the most important changed files (skip trivial ones).\n\n' +
  '**Review effort: N/5** — a 1–5 rating (1 = rubber-stamp, 5 = needs deep, careful review) with a one-line reason.\n\n' +
  'Be concise and concrete.'

/** Summarize the whole PR — no selection needed; the background fetches all file patches. */
function onSummarize(dock: DockPanel): void {
  const pr = parsePr()
  if (!pr) {
    dock.showError('Open a pull request to summarize it.')
    return
  }
  ask(
    {
      question: SUMMARY_INSTRUCTION,
      context: { repo: pr.repo, prNumber: pr.prNumber },
      history: dock.getHistory(),
      mode: 'summary',
    },
    dock,
    'Summarize PR',
  )
}

/** Base whole-PR review instruction. The severity word leads each finding so the dock can
 *  render it as a color-blind-safe chip (icon + label). */
const REVIEW_INSTRUCTION =
  'Review this entire pull request as an experienced reviewer, grounded ONLY in the provided ' +
  'diffs and PR description. Report concrete, actionable findings.\n\n' +
  'Output a markdown bullet list — one finding per top-level bullet — each formatted EXACTLY as:\n\n' +
  '- **<Severity>** · `path:line` — **Short title.** One or two sentences: the problem and the concrete fix.\n\n' +
  'Rules:\n' +
  '- <Severity> is exactly one of: Blocker, Major, Minor, Nit, Praise.\n' +
  '- Use the new-file path and a real changed line number from the diff.\n' +
  '- Order findings most severe first; keep it a single flat list.\n' +
  '- Report only what the diff supports — do not speculate about code you cannot see.\n' +
  '- Prefer a few high-signal findings over many trivial ones; at most one Praise.\n' +
  '- If the PR looks clean, reply with a single line saying so instead of inventing findings.'

/** Specialist review lenses — each scopes the whole-PR review to one dimension. */
export interface Lens {
  id: string
  label: string
  /** Extra instruction appended for a focused review; empty for the general lens. */
  clause: string
}

export const REVIEW_LENSES: Lens[] = [
  { id: 'general', label: 'General', clause: '' },
  {
    id: 'security',
    label: 'Security',
    clause:
      'injection, broken authn/authz, secret leakage, unsafe deserialization, SSRF, path ' +
      'traversal, missing input validation, and unsafe defaults',
  },
  {
    id: 'performance',
    label: 'Performance',
    clause:
      'N+1 queries, needless allocations or copies, blocking I/O on hot paths, accidental ' +
      'quadratic work, and missing caching or pagination',
  },
  {
    id: 'errors',
    label: 'Error handling',
    clause:
      'unhandled exceptions or rejections, swallowed errors, missing null/undefined guards, ' +
      'partial-failure states, and unreleased resources',
  },
  {
    id: 'readability',
    label: 'Readability',
    clause:
      'naming, dead code, duplication, overly complex control flow, misleading or missing ' +
      'comments, and unclear public APIs',
  },
]

/** Review the whole PR — optionally through a specialist lens. Reuses the summary's patch
 *  pipeline (mode: 'review'); findings stream in as a thread turn and ride the 3a bridge. */
function onReview(dock: DockPanel, lensId: string): void {
  const pr = parsePr()
  if (!pr) {
    dock.showError('Open a pull request to review it.')
    return
  }
  const lens = REVIEW_LENSES.find((l) => l.id === lensId) ?? REVIEW_LENSES[0]
  const question = lens.clause
    ? `${REVIEW_INSTRUCTION}\n\nScope this review specifically to ${lens.label.toLowerCase()}: ` +
      `${lens.clause}. Skip findings outside this lens.`
    : REVIEW_INSTRUCTION
  ask(
    {
      question,
      context: { repo: pr.repo, prNumber: pr.prNumber },
      history: dock.getHistory(),
      mode: 'review',
    },
    dock,
    lens.clause ? `Review · ${lens.label}` : 'Review PR',
  )
}

/** Deterministic test-gap check — no LLM. Asks the background to run the path heuristic over
 *  the changed-file list, then renders the report as an instant answer turn (so follow-ups and
 *  the answer→comment bridge still work). */
async function onTestGaps(dock: DockPanel): Promise<void> {
  const pr = parsePr()
  if (!pr) {
    dock.showError('Open a pull request to check it for test gaps.')
    return
  }
  dock.startAnswer('Test-gap check')
  const message: TestGapsMessage = {
    type: 'GH_TEST_GAPS',
    repo: pr.repo,
    prNumber: pr.prNumber,
  }
  try {
    const result = (await chrome.runtime.sendMessage(message)) as TestGapsResult
    if (result?.ok && result.report) {
      dock.appendText(result.report)
      dock.finishAnswer()
    } else {
      dock.showError(result?.error ?? 'Could not read the PR file list.')
    }
  } catch (err) {
    dock.showError(err instanceof Error ? err.message : String(err))
  }
}

async function postComment(dock: DockPanel, text: string): Promise<void> {
  const pr = parsePr()
  if (!pr) {
    dock.postFailed('Open a pull request first.')
    return
  }
  const target = lastSelection ? reviewTarget(lastSelection) : null
  if (!target) {
    dock.postFailed('Select a diff line first.')
    return
  }

  dock.postPending()
  const message: GithubRequest = {
    type: 'GH_POST_COMMENT',
    repo: pr.repo,
    prNumber: pr.prNumber,
    body: text,
    path: target.path,
    line: target.line,
    side: target.side,
    startLine: target.startLine,
    startSide: target.startSide,
  }
  try {
    const result = (await chrome.runtime.sendMessage(message)) as GithubResult
    if (result?.ok && result.url) dock.postDone(result.url)
    else dock.postFailed(result?.error ?? 'Post failed.')
  } catch (err) {
    dock.postFailed(err instanceof Error ? err.message : String(err))
  }
}

function mount(): void {
  if (!parsePr()) return
  if (document.querySelector(DOCK_SELECTOR)) return // already mounted

  const dock = new DockPanel()
  currentDock = dock
  dock.onSubmit = (question) => onSubmit(dock, question)
  dock.onSuggest = () => onSuggest(dock)
  dock.onSummarize = () => onSummarize(dock)
  dock.onReview = (lensId) => onReview(dock, lensId)
  dock.onTestGaps = () => void onTestGaps(dock)
  dock.onHelp = () => void chrome.runtime.sendMessage({ type: 'OPEN_HELP' } satisfies OpenHelpMessage)
  dock.renderLenses(REVIEW_LENSES)
  dock.onInsertComment = (body) => {
    const inserted = insertComment(body)
    dock.flashTray(inserted ? 'Inserted' : 'Focus a GitHub comment box first', inserted)
  }
  dock.onApplyLabel = (label, decoration) => {
    const applied = prependComment(conventionalPrefix(label.value, decoration))
    dock.flashTray(applied ? 'Label added' : 'Focus a GitHub comment box first', applied)
  }
  dock.onPost = (text) => void postComment(dock, text)
  dock.renderComments(CANNED_COMMENTS)
  dock.renderLabels(CC_LABELS, CC_DECORATIONS)
  dock.mount()
  if (lastSelection) dock.setSelection(selectionLabel(lastSelection))
}

function unmountIfNotPr(): void {
  if (!parsePr()) {
    document.querySelector(DOCK_SELECTOR)?.remove()
    currentDock = null
  }
}

// Track the last diff selection once, document-wide, and reflect it in the chip.
// Ignore non-diff selections (e.g. when the user is typing in the dock) so the
// remembered diff anchor survives.
document.addEventListener('selectionchange', () => {
  const sel = captureSelection()
  if (!sel) return
  lastSelection = sel
  currentDock?.setSelection(selectionLabel(sel))
})

// Remember which GitHub comment box was last focused (for canned-comment insert).
trackCommentFields()

// Mount now and on GitHub's client-side navigations (SPA — no full reload).
mount()
for (const evt of ['turbo:render', 'pjax:end', 'popstate']) {
  window.addEventListener(evt, () => {
    unmountIfNotPr()
    mount()
  })
}
