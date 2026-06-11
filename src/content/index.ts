// Content script — entry point. Runs on github.com; activates on PR pages.
// Mounts the dock, captures selections, and bridges asks to the background worker.

import {
  PORT_NAME,
  type BackgroundToContent,
  type ContentToBackground,
} from '../shared/messages'
import type { AskRequest } from '../shared/types'
import { captureSelection } from './selection'
import { CANNED_COMMENTS, insertComment, trackCommentFields } from './comments'
import { DOCK_SELECTOR, DockPanel } from './dock/dock-panel'

// Presence marker: load signal + double-injection guard (visible to page context).
if (!document.documentElement.dataset.ycraLoaded) {
  document.documentElement.dataset.ycraLoaded = '0.0.0'
}

/** Parse "owner/repo" + PR number from a /pull/ URL, or null if not a PR page. */
function parsePr(): { repo: string; prNumber: number } | null {
  const m = location.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  return m ? { repo: m[1], prNumber: Number(m[2]) } : null
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
  const selection = captureSelection()
  if (!selection) {
    dock.showError('Select some code in the diff first, then ask.')
    return
  }
  ask(
    {
      question,
      context: {
        repo: pr.repo,
        prNumber: pr.prNumber,
        file: selection.file,
        lineRange: selection.lineRange,
        selectedCode: selection.selectedCode,
        language: selection.language,
      },
    },
    dock,
  )
}

function mount(): void {
  if (!parsePr()) return
  if (document.querySelector(DOCK_SELECTOR)) return // already mounted
  const dock = new DockPanel()
  dock.onSubmit = (question) => onSubmit(dock, question)
  dock.onInsertComment = (body) => {
    const inserted = insertComment(body)
    dock.flashTray(inserted ? 'Inserted ✓' : 'Focus a GitHub comment box first')
  }
  dock.renderComments(CANNED_COMMENTS)
  dock.mount()

  // Reflect the current selection in the dock's chip.
  document.addEventListener('selectionchange', () => {
    const sel = captureSelection()
    if (!sel) {
      dock.setSelection(null)
      return
    }
    const where = sel.file
      ? `${sel.file}${sel.lineRange ? ` :${sel.lineRange[0]}-${sel.lineRange[1]}` : ''}`
      : `${sel.selectedCode.length} chars selected`
    dock.setSelection(where)
  })
}

function unmountIfNotPr(): void {
  if (!parsePr()) document.querySelector(DOCK_SELECTOR)?.remove()
}

// Remember which GitHub comment box was last focused (once, document-wide).
trackCommentFields()

// Mount now and on GitHub's client-side navigations (SPA — no full reload).
mount()
for (const evt of ['turbo:render', 'pjax:end', 'popstate']) {
  window.addEventListener(evt, () => {
    unmountIfNotPr()
    mount()
  })
}
