// The dock panel — a style-isolated UI pinned to the bottom of the PR page.
//
// NOT a custom element: content scripts run in an isolated world where
// `customElements` is null (a Chromium/Edge limitation), so registering a custom
// element throws. Instead we create a plain <div> host, attach an open shadow
// root (open so the content script and tests can reach in), and build the UI
// directly. Style isolation still comes from the shadow root + `:host` rules.

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { CannedComment } from '../comments'

marked.setOptions({ gfm: true, breaks: true })

/** Attribute used to find/dedupe the dock host in the page DOM. */
export const DOCK_SELECTOR = '[data-ycra-dock]'

const STYLES = `
  :host {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #1f2328;
  }
  .panel {
    margin: 0 auto; max-width: 980px;
    background: #fff; border: 1px solid #d0d7de; border-bottom: none;
    border-radius: 8px 8px 0 0; box-shadow: 0 -2px 16px rgba(0,0,0,.12);
    display: flex; flex-direction: column; overflow: hidden;
  }
  .header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; cursor: pointer; user-select: none;
    background: #f6f8fa; border-bottom: 1px solid #d0d7de;
  }
  .title { font-weight: 600; }
  .chip {
    font-size: 11px; color: #57606a; background: #eaeef2;
    border-radius: 999px; padding: 2px 8px; max-width: 360px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .spacer { flex: 1; }
  .toggle { color: #57606a; font-size: 12px; }
  .body { display: flex; flex-direction: column; max-height: 320px; }
  :host([collapsed]) .body { display: none; }
  .answer {
    padding: 12px; overflow-y: auto; min-height: 64px; max-height: 220px;
    word-break: break-word;
  }
  .answer.empty, .answer.error { white-space: pre-wrap; }
  .answer.empty { color: #8c959f; }
  .answer.error { color: #cf222e; }
  .answer > :first-child { margin-top: 0; }
  .answer > :last-child { margin-bottom: 0; }
  .answer p, .answer ul, .answer ol, .answer pre, .answer blockquote { margin: 0 0 8px; }
  .answer ul, .answer ol { padding-left: 20px; }
  .answer h1, .answer h2, .answer h3, .answer h4 { font-size: 14px; margin: 10px 0 4px; }
  .answer pre {
    background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px;
    padding: 10px; overflow-x: auto;
  }
  .answer code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
  }
  .answer :not(pre) > code { background: #eaeef2; padding: 1px 4px; border-radius: 4px; }
  .answer pre code { background: none; padding: 0; }
  .answer a { color: #0969da; }
  .answer blockquote { border-left: 3px solid #d0d7de; padding-left: 10px; color: #57606a; }
  .tray {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 6px 12px; border-top: 1px solid #d0d7de;
  }
  .tray-label { font-size: 11px; color: #57606a; font-weight: 600; }
  .tray-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip-btn {
    font-size: 11px; padding: 2px 8px; border: 1px solid #d0d7de;
    border-radius: 999px; background: #f6f8fa; color: #1f2328; cursor: pointer;
    font-family: inherit;
  }
  .chip-btn:hover { background: #eaeef2; }
  .tray-status { font-size: 11px; color: #1a7f37; margin-left: auto; }
  .composer { display: flex; flex-direction: column; gap: 8px; padding: 8px 12px; border-top: 1px solid #d0d7de; }
  textarea {
    resize: none; min-height: 36px; max-height: 120px;
    padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px;
    font: inherit; color: inherit;
  }
  .composer-actions { display: flex; align-items: center; gap: 8px; }
  .post-status { font-size: 11px; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .post-status a { color: #1a7f37; font-weight: 600; text-decoration: none; }
  .post-status.error { color: #cf222e; }
  .composer button {
    padding: 6px 14px; border: 1px solid rgba(31,35,40,.15); border-radius: 6px;
    font: inherit; font-weight: 600; cursor: pointer;
  }
  .composer button:disabled { opacity: .55; cursor: default; }
  .composer .ask { background: #1f883d; color: #fff; }
  .composer .post { background: #f6f8fa; color: #1f2328; }
`

const TEMPLATE = `
  <style>${STYLES}</style>
  <div class="panel">
    <div class="header">
      <span class="title">Code Review Assistant</span>
      <span class="chip" hidden></span>
      <span class="spacer"></span>
      <span class="toggle">▾</span>
    </div>
    <div class="body">
      <div class="answer empty">Highlight code in the diff, then ask a question.</div>
      <div class="tray">
        <span class="tray-label">Insert:</span>
        <span class="tray-chips"></span>
        <span class="tray-status"></span>
      </div>
      <div class="composer">
        <textarea placeholder="Ask about the code, or type a comment to post…" rows="1"></textarea>
        <div class="composer-actions">
          <span class="post-status"></span>
          <button type="button" class="ask">Ask</button>
          <button type="button" class="post" title="Post the text above as a review comment on the selected line">Post to line</button>
        </div>
      </div>
    </div>
  </div>
`

export class DockPanel {
  /** The host element to append into the page. */
  readonly host: HTMLElement
  /** Called when the user submits a question. */
  onSubmit: ((question: string) => void) | null = null
  /** Called when the user clicks a canned-comment chip. */
  onInsertComment: ((body: string) => void) | null = null
  /** Called when the user clicks "Post to line" with the composer text. */
  onPost: ((text: string) => void) | null = null

  private readonly root: ShadowRoot
  private readonly answerEl: HTMLDivElement
  private readonly chipEl: HTMLSpanElement
  private readonly inputEl: HTMLTextAreaElement
  private readonly askBtn: HTMLButtonElement
  private readonly postBtn: HTMLButtonElement
  private readonly postStatusEl: HTMLSpanElement
  private readonly toggleEl: HTMLSpanElement
  private readonly trayChipsEl: HTMLSpanElement
  private readonly trayStatusEl: HTMLSpanElement
  private trayTimer: number | undefined
  private streaming = false
  /** Raw markdown accumulated across stream chunks; re-rendered on each delta. */
  private rawAnswer = ''

  constructor() {
    this.host = document.createElement('div')
    this.host.setAttribute('data-ycra-dock', '')
    this.root = this.host.attachShadow({ mode: 'open' })
    this.root.innerHTML = TEMPLATE

    this.answerEl = this.root.querySelector('.answer')!
    this.chipEl = this.root.querySelector('.chip')!
    this.inputEl = this.root.querySelector('textarea')!
    this.askBtn = this.root.querySelector('.composer .ask')!
    this.postBtn = this.root.querySelector('.composer .post')!
    this.postStatusEl = this.root.querySelector('.post-status')!
    this.toggleEl = this.root.querySelector('.toggle')!
    this.trayChipsEl = this.root.querySelector('.tray-chips')!
    this.trayStatusEl = this.root.querySelector('.tray-status')!

    this.root.querySelector('.header')!.addEventListener('click', () => this.toggleCollapsed())
    this.askBtn.addEventListener('click', () => this.submit())
    this.postBtn.addEventListener('click', () => {
      const text = this.inputEl.value.trim()
      if (text) this.onPost?.(text)
    })
    this.inputEl.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        this.submit()
      }
    })

    // Keep keystrokes inside the dock. GitHub's global hotkeys (s, /, t, f, c, …)
    // listen on document and would steal focus to its search/filter inputs: because
    // focus is inside our shadow root, document.activeElement is the host <div>, not
    // the textarea, so GitHub doesn't realize the user is typing. Stopping these
    // events at the host boundary keeps them from reaching GitHub's handlers.
    const stopKeys = (e: Event): void => {
      e.stopPropagation()
    }
    this.host.addEventListener('keydown', stopKeys)
    this.host.addEventListener('keyup', stopKeys)
    this.host.addEventListener('keypress', stopKeys)
  }

  /** Append the dock into the page (defaults to <body>). */
  mount(parent: ParentNode = document.body): void {
    parent.appendChild(this.host)
  }

  private toggleCollapsed(): void {
    this.host.toggleAttribute('collapsed')
    this.toggleEl.textContent = this.host.hasAttribute('collapsed') ? '▴' : '▾'
  }

  private submit(): void {
    const question = this.inputEl.value.trim()
    if (!question || this.streaming) return
    this.onSubmit?.(question)
  }

  /** Show a summary of what's currently selected (or clear it). */
  setSelection(summary: string | null): void {
    if (!summary) {
      this.chipEl.hidden = true
      return
    }
    this.chipEl.textContent = summary
    this.chipEl.hidden = false
  }

  /** Populate the canned-comment tray with one chip per comment. */
  renderComments(comments: CannedComment[]): void {
    this.trayChipsEl.replaceChildren()
    for (const comment of comments) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'chip-btn'
      chip.textContent = comment.label
      chip.title = comment.body
      // Don't steal focus from GitHub's comment field: preventing the mousedown
      // default keeps the textarea focused so the insert lands at its caret.
      chip.addEventListener('mousedown', (e) => e.preventDefault())
      chip.addEventListener('click', () => this.onInsertComment?.(comment.body))
      this.trayChipsEl.appendChild(chip)
    }
  }

  /** Briefly show a status message in the tray (e.g. inserted / no field). */
  flashTray(message: string): void {
    this.trayStatusEl.textContent = message
    window.clearTimeout(this.trayTimer)
    this.trayTimer = window.setTimeout(() => {
      this.trayStatusEl.textContent = ''
    }, 1800)
  }

  /** Posting lifecycle feedback next to the "Post to line" button. */
  postPending(): void {
    this.postBtn.disabled = true
    this.postStatusEl.classList.remove('error')
    this.postStatusEl.textContent = 'Posting…'
  }

  postDone(url: string): void {
    this.postBtn.disabled = false
    this.postStatusEl.classList.remove('error')
    this.postStatusEl.replaceChildren()
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = '✓ Comment posted'
    this.postStatusEl.appendChild(link)
  }

  postFailed(message: string): void {
    this.postBtn.disabled = false
    this.postStatusEl.classList.add('error')
    this.postStatusEl.textContent = `✗ ${message}`
  }

  /** Begin a fresh streamed answer. */
  startAnswer(): void {
    this.streaming = true
    this.askBtn.disabled = true
    this.host.removeAttribute('collapsed')
    this.answerEl.classList.remove('empty', 'error')
    this.rawAnswer = ''
    this.answerEl.replaceChildren()
  }

  appendText(delta: string): void {
    this.rawAnswer += delta
    // Re-render the accumulated markdown each chunk; sanitize since model output
    // is written via innerHTML. Cheap for short answers.
    this.answerEl.innerHTML = DOMPurify.sanitize(marked.parse(this.rawAnswer) as string)
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  finishAnswer(): void {
    this.streaming = false
    this.askBtn.disabled = false
    if (!this.rawAnswer.trim()) {
      this.answerEl.classList.add('empty')
      this.answerEl.textContent = '(no response)'
    }
  }

  showError(message: string): void {
    this.streaming = false
    this.askBtn.disabled = false
    this.answerEl.classList.remove('empty')
    this.answerEl.classList.add('error')
    this.answerEl.textContent = message
  }
}
