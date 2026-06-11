// Content script — entry point. Runs on github.com; activates on PR pages.
// Mounts the dock, tracks the last diff selection, and bridges asks + comment
// posts to the background worker.

import {
  PORT_NAME,
  type BackgroundToContent,
  type ContentToBackground,
  type GithubRequest,
  type GithubResult,
} from '../shared/messages'
import type { AskRequest } from '../shared/types'
import { captureSelection, type SelectionContext } from './selection'
import { CANNED_COMMENTS, insertComment, trackCommentFields } from './comments'
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
function ask(request: AskRequest, dock: DockPanel): void {
  const id = crypto.randomUUID()
  const port = chrome.runtime.connect({ name: PORT_NAME })
  let settled = false

  dock.startAnswer()

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
    },
    dock,
  )
}

async function postComment(dock: DockPanel, text: string): Promise<void> {
  const pr = parsePr()
  if (!pr) {
    dock.postFailed('Open a pull request first.')
    return
  }
  const s = lastSelection
  if (!s?.anchor || !s.file) {
    dock.postFailed('Select a diff line first.')
    return
  }

  dock.postPending()
  const message: GithubRequest = {
    type: 'GH_POST_COMMENT',
    repo: pr.repo,
    prNumber: pr.prNumber,
    body: text,
    path: s.file,
    line: s.anchor.line,
    side: s.anchor.side,
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
  dock.onInsertComment = (body) => {
    const inserted = insertComment(body)
    dock.flashTray(inserted ? 'Inserted ✓' : 'Focus a GitHub comment box first')
  }
  dock.onPost = (text) => void postComment(dock, text)
  dock.renderComments(CANNED_COMMENTS)
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
