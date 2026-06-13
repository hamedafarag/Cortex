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
  type DeleteCommentMessage,
  type SubmitReviewMessage,
} from '../shared/messages'
import type { AskRequest, DraftComment, ReviewEvent } from '../shared/types'
import {
  captureSelection,
  reviewTarget,
  type SelectionContext,
  type ReviewTarget,
} from './selection'
import { loadThread, saveThread } from '../shared/persistence'
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
      case 'META':
        dock.showRedactionNotice(msg.redactedSecrets)
        break
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

/** Step 1: validate the target and ask the dock to confirm the public write before firing. */
function postComment(dock: DockPanel, text: string): void {
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
  const lines =
    target.startLine && target.startLine !== target.line
      ? `${target.startLine}-${target.line}`
      : String(target.line)
  dock.confirmPost(`${pr.repo} · ${target.path}:${lines}`, () => void doPost(dock, pr, text, target))
}

/** Step 2: the confirmed write. On success, offers an Undo (delete) via the returned id. */
async function doPost(dock: DockPanel, pr: Pr, text: string, target: ReviewTarget): Promise<void> {
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
    if (result?.ok && result.url) {
      const id = result.commentId
      dock.postDone(result.url, {
        onRefresh: () => location.reload(), // GitHub's SPA won't render an API-posted comment inline
        onUndo: id != null ? () => void undoPost(dock, pr, id, text) : undefined,
      })
    } else {
      dock.postFailed(result?.error ?? 'Post failed.')
    }
  } catch (err) {
    dock.postFailed(err instanceof Error ? err.message : String(err))
  }
}

/** Undo a just-posted comment by deleting it (the post-then-Undo window). Restores the
 *  retracted text to the composer so the reviewer can fix and re-post. */
async function undoPost(dock: DockPanel, pr: Pr, commentId: number, text: string): Promise<void> {
  dock.postUndoing()
  try {
    const result = (await chrome.runtime.sendMessage({
      type: 'GH_DELETE_COMMENT',
      repo: pr.repo,
      commentId,
    } satisfies DeleteCommentMessage)) as GithubResult
    if (result?.ok) dock.postUndone(text)
    else dock.postFailed(result?.error ?? 'Undo failed — the comment may already be gone.')
  } catch (err) {
    dock.postFailed(err instanceof Error ? err.message : String(err))
  }
}

/** Add the composer text to the pending review, anchored to the current selection. Purely
 *  local — nothing is written until the review is submitted. */
function addToReview(dock: DockPanel, text: string): void {
  const pr = parsePr()
  if (!pr) {
    dock.flashTray('Open a pull request first.', false)
    return
  }
  const target = lastSelection ? reviewTarget(lastSelection) : null
  if (!target) {
    dock.flashTray('Select a diff line first.', false)
    return
  }
  dock.addReviewComment({
    path: target.path,
    line: target.line,
    side: target.side,
    startLine: target.startLine,
    startSide: target.startSide,
    body: text,
  } satisfies DraftComment)
}

const VERDICT_LABEL: Record<ReviewEvent, string> = {
  COMMENT: 'Comment',
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request changes',
}

/** Submit the pending review with a verdict. GitHub requires an overall body for COMMENT /
 *  REQUEST_CHANGES. Gated by a confirm, like posting a single comment. */
function submitReview(dock: DockPanel, event: ReviewEvent, body: string): void {
  const pr = parsePr()
  if (!pr) {
    dock.reviewFailed('Open a pull request first.')
    return
  }
  const comments = dock.getReview()
  if (comments.length === 0) {
    dock.reviewFailed('Add at least one comment to the review first.')
    return
  }
  if ((event === 'COMMENT' || event === 'REQUEST_CHANGES') && !body) {
    dock.reviewFailed(`A ${VERDICT_LABEL[event]} review needs an overall summary — add one above.`)
    return
  }
  const n = comments.length
  const summary = `Submit ${n} comment${n === 1 ? '' : 's'} as ${VERDICT_LABEL[event]} on ${pr.repo}?`
  dock.confirmReview(summary, () => void doSubmitReview(dock, pr, event, body, comments))
}

/** The confirmed review submission — the one public write for the batch. */
async function doSubmitReview(
  dock: DockPanel,
  pr: Pr,
  event: ReviewEvent,
  body: string,
  comments: DraftComment[],
): Promise<void> {
  dock.reviewSubmitting()
  try {
    const result = (await chrome.runtime.sendMessage({
      type: 'GH_SUBMIT_REVIEW',
      repo: pr.repo,
      prNumber: pr.prNumber,
      event,
      body,
      comments,
    } satisfies SubmitReviewMessage)) as GithubResult
    if (result?.ok && result.url) {
      dock.reviewSubmitted(result.url, () => location.reload())
    } else {
      dock.reviewFailed(result?.error ?? 'Submit failed.')
    }
  } catch (err) {
    dock.reviewFailed(err instanceof Error ? err.message : String(err))
  }
}

/** Create the dock and wire its (PR-agnostic) callbacks. Per-PR state — the persisted
 *  thread — is bound separately in `syncToPr`. */
function buildDock(): DockPanel {
  const dock = new DockPanel()
  dock.onSubmit = (question) => onSubmit(dock, question)
  dock.onSuggest = () => onSuggest(dock)
  dock.onSummarize = () => onSummarize(dock)
  dock.onReview = (lensId) => onReview(dock, lensId)
  dock.onTestGaps = () => void onTestGaps(dock)
  dock.onHelp = () => void chrome.runtime.sendMessage({ type: 'OPEN_HELP' } satisfies OpenHelpMessage)
  dock.onInsertComment = (body) => {
    const inserted = insertComment(body)
    dock.flashTray(inserted ? 'Inserted' : 'Focus a GitHub comment box first', inserted)
  }
  dock.onApplyLabel = (label, decoration) => {
    const applied = prependComment(conventionalPrefix(label.value, decoration))
    dock.flashTray(applied ? 'Label added' : 'Focus a GitHub comment box first', applied)
  }
  dock.onPost = (text) => postComment(dock, text)
  dock.onAddToReview = (text) => addToReview(dock, text)
  dock.onSubmitReview = (event, body) => submitReview(dock, event, body)
  dock.renderComments(CANNED_COMMENTS)
  dock.renderLabels(CC_LABELS, CC_DECORATIONS)
  dock.renderLenses(REVIEW_LENSES)
  return dock
}

// ── Per-PR thread persistence ──────────────────────────────────────────
type Pr = { repo: string; prNumber: number }
let currentPr: Pr | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
let pendingSave: (() => void) | null = null

const samePr = (a: Pr, b: Pr): boolean => a.repo === b.repo && a.prNumber === b.prNumber

/** Run any debounced save now (before a navigation swaps the thread, or on page hide). */
function flushSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = undefined
  const run = pendingSave
  pendingSave = null
  run?.()
}

/** Persist the dock's thread for `pr`. Committed changes (`immediate`) save now; draft typing
 *  is debounced so we don't write storage on every keystroke. */
function persistThread(dock: DockPanel, pr: Pr, immediate: boolean): void {
  if (saveTimer) clearTimeout(saveTimer)
  const run = (): void => {
    saveTimer = undefined
    pendingSave = null
    void saveThread(pr.repo, pr.prNumber, dock.getThread()).catch(() => {})
  }
  pendingSave = run
  if (immediate) run()
  else saveTimer = setTimeout(run, 500)
}

/** Mount/tear down the dock and swap the persisted thread as the URL changes — including SPA
 *  navigation between PRs (where the same dock instance is reused). */
function syncToPr(): void {
  const pr = parsePr()
  if (!pr) {
    flushSave()
    document.querySelector(DOCK_SELECTOR)?.remove()
    currentDock = null
    currentPr = null
    return
  }
  if (currentDock && currentPr && samePr(currentPr, pr)) return // same PR — nothing to swap

  flushSave() // persist the outgoing PR before we rebind

  const freshBuild = !currentDock
  if (!currentDock) {
    currentDock = buildDock()
    currentDock.mount()
    if (lastSelection) currentDock.setSelection(selectionLabel(lastSelection))
  }
  const dock = currentDock
  currentPr = pr
  dock.onThreadChange = (immediate) => persistThread(dock, pr, immediate)
  void loadThread(pr.repo, pr.prNumber)
    .then((saved) => {
      if (!currentPr || !samePr(currentPr, pr)) return // navigated again before this resolved
      if (saved) dock.restoreThread(saved)
      else if (!freshBuild) dock.newThread() // clear a previous PR's thread (fresh dock is empty)
    })
    .catch(() => {
      if (currentPr && samePr(currentPr, pr) && !freshBuild) dock.newThread()
    })
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

// Mount now and on GitHub's client-side navigations (SPA — no full reload). syncToPr swaps
// the persisted thread when the PR changes.
syncToPr()
for (const evt of ['turbo:render', 'pjax:end', 'popstate']) {
  window.addEventListener(evt, () => syncToPr())
}
// Flush a debounced draft save before the page goes away (full navigation / close).
window.addEventListener('pagehide', () => flushSave())
