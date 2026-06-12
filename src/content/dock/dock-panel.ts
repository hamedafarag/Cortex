// Cortex dock — a style-isolated UI pinned to the bottom of the PR page.
//
// NOT a custom element: content scripts run in an isolated world where
// `customElements` is null, so we use a plain <div> host with an attached open
// shadow root. The look is "a precision instrument embedded in GitHub": it inherits
// GitHub's Primer theme tokens (adapts to light/dark automatically) and adds a sharp
// Cortex identity. Every status pairs colour with an icon + label (color-blind safe).

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { CannedComment, ConventionalLabel } from '../comments'
import type { ChatMessage } from '../../shared/types'
import { icon } from './icons'

marked.setOptions({ gfm: true, breaks: true })

/** Escape user text (questions are shown verbatim in the conversation thread). */
function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }
  return s.replace(/[&<>"']/g, (c) => map[c])
}

/** Attribute used to find/dedupe the dock host in the page DOM. */
export const DOCK_SELECTOR = '[data-ycra-dock]'

const STYLES = `
  :host {
    /* Inherit GitHub's Primer tokens (new + legacy fallbacks) → native light/dark. */
    --bg: var(--bgColor-default, var(--color-canvas-default, #ffffff));
    --bg-muted: var(--bgColor-muted, var(--color-canvas-subtle, #f6f8fa));
    --bg-inset: var(--bgColor-inset, var(--color-canvas-inset, #f6f8fa));
    --fg: var(--fgColor-default, var(--color-fg-default, #1f2328));
    --fg-muted: var(--fgColor-muted, var(--color-fg-muted, #59636e));
    --border: var(--borderColor-default, var(--color-border-default, #d1d9e0));
    --border-muted: var(--borderColor-muted, var(--color-border-muted, #d8dee4));
    --accent: var(--fgColor-accent, var(--color-accent-fg, #0969da));
    --success: var(--fgColor-success, var(--color-success-fg, #1a7f37));
    --danger: var(--fgColor-danger, var(--color-danger-fg, #d1242f));
    --cortex: #6b5cf6;        /* Cortex brand accent — used sparingly */
    --cortex-on: #ffffff;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

    position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646;
    font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--fg);
  }

  .panel {
    background: var(--bg);
    border-top: 1px solid var(--border);
    box-shadow: 0 -8px 28px rgba(0,0,0,.16);
    overflow: hidden;
    animation: rise .18s cubic-bezier(.2,.7,.3,1);
  }
  /* Signature Cortex edge */
  .panel::before {
    content: ""; display: block; height: 2px;
    background: linear-gradient(90deg, var(--cortex), color-mix(in srgb, var(--cortex) 35%, transparent));
  }
  @keyframes rise { from { transform: translateY(8px); opacity: 0 } to { transform: none; opacity: 1 } }

  /* ── header ───────────────────────────────────────────────────────── */
  .header {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 14px; cursor: pointer; user-select: none;
    background: var(--bg-muted); border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; gap: 8px; }
  .mark { display: grid; place-items: center; color: var(--cortex); }
  .wordmark { font-weight: 700; letter-spacing: .14em; font-size: 12px; text-transform: uppercase; }
  .tagline { color: var(--fg-muted); font-size: 11px; }
  @media (max-width: 720px) { .tagline { display: none } }
  .spacer { flex: 1 }
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    font-family: var(--mono); font-size: 11px; color: var(--fg-muted);
    background: var(--bg-inset); border: 1px solid var(--border-muted);
    border-radius: 6px; padding: 2px 7px; max-width: 380px;
  }
  .chip .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip[hidden] { display: none }
  .chip .icon { color: var(--fg-muted); flex: none }
  .iconbtn {
    display: grid; place-items: center; width: 26px; height: 26px;
    border: 1px solid transparent; border-radius: 6px;
    background: none; color: var(--fg-muted); cursor: pointer; padding: 0;
  }
  .iconbtn:hover { background: var(--bg-inset); color: var(--fg); }
  .iconbtn[hidden] { display: none }
  .newthread {
    font: inherit; font-size: 11px; font-weight: 600; color: var(--fg-muted);
    background: none; border: 1px solid var(--border); border-radius: 6px;
    padding: 3px 9px; cursor: pointer;
  }
  .newthread:hover { background: var(--bg-inset); color: var(--fg); border-color: var(--fg-muted); }
  .newthread[hidden] { display: none }

  /* ── launcher (collapsed state) ───────────────────────────────────── */
  .launcher {
    display: none;
    position: absolute; right: 16px; bottom: 16px;
    width: 48px; height: 48px; padding: 0;
    border-radius: 50%; place-items: center; cursor: pointer;
    background: var(--cortex); color: var(--cortex-on);
    border: 1px solid color-mix(in srgb, var(--cortex) 70%, #000);
    box-shadow: 0 4px 14px rgba(0,0,0,.28);
    animation: rise .18s cubic-bezier(.2,.7,.3,1);
  }
  .launcher:hover { background: color-mix(in srgb, var(--cortex) 88%, #000) }
  :host([collapsed]) .launcher { display: grid }
  :host([collapsed]) .panel { display: none }

  /* ── body ─────────────────────────────────────────────────────────── */
  .body { display: flex; flex-direction: column; }

  .answer {
    padding: 14px; overflow-y: auto; min-height: 68px; max-height: 240px;
    word-break: break-word;
  }
  .answer.placeholder { color: var(--fg-muted) }
  .status-row { display: flex; align-items: center; gap: 8px; }
  .status-row.error { color: var(--danger) }
  .status-row.ok { color: var(--success) }
  .status-row .icon { flex: none }
  .status-row a { color: var(--accent); font-weight: 600; }

  /* rendered markdown */
  .answer > :first-child { margin-top: 0 }
  .answer > :last-child { margin-bottom: 0 }
  .answer p, .answer ul, .answer ol, .answer pre, .answer blockquote { margin: 0 0 8px }
  .answer ul, .answer ol { padding-left: 20px }
  .answer h1, .answer h2, .answer h3, .answer h4 { font-size: 14px; margin: 10px 0 4px }
  .answer pre { background: var(--bg-inset); border: 1px solid var(--border-muted); border-radius: 6px; padding: 10px; overflow-x: auto }
  .answer code { font-family: var(--mono); font-size: 12px }
  .answer :not(pre) > code { background: var(--bg-inset); padding: 1px 5px; border-radius: 5px }
  .answer pre code { background: none; padding: 0 }
  .answer a { color: var(--accent) }
  .answer blockquote { border-left: 3px solid var(--border); padding-left: 10px; color: var(--fg-muted) }

  /* ── conversation turns ───────────────────────────────────────────── */
  .turn-q {
    font-weight: 600; color: var(--fg); white-space: pre-wrap; word-break: break-word;
    padding-top: 10px; margin-top: 10px; border-top: 1px solid var(--border-muted);
  }
  .turn-q:first-child { padding-top: 0; margin-top: 0; border-top: none; }
  .turn-q::before {
    content: "You"; margin-right: 6px;
    font: 600 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .06em; color: var(--cortex);
  }
  .turn-a { margin-top: 6px }

  /* ── answer actions ───────────────────────────────────────────────── */
  .answer-actions { display: flex; gap: 6px; padding: 0 14px 10px; }
  .answer-actions[hidden] { display: none }
  .link-btn {
    display: inline-flex; align-items: center; gap: 5px;
    font: inherit; font-size: 11px; color: var(--fg-muted);
    background: none; border: 1px solid transparent; border-radius: 6px;
    padding: 3px 8px; cursor: pointer;
  }
  .link-btn:hover { background: var(--bg-inset); color: var(--fg) }
  .link-btn .icon { flex: none }

  /* ── tray ─────────────────────────────────────────────────────────── */
  .tray {
    display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
    padding: 8px 14px; border-top: 1px solid var(--border);
  }
  .tray-label { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--fg-muted); font-weight: 600; }
  .tray-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip-btn {
    font-size: 11px; padding: 3px 9px; border: 1px solid var(--border);
    border-radius: 999px; background: var(--bg); color: var(--fg);
    cursor: pointer; font-family: inherit;
  }
  .chip-btn:hover { background: var(--bg-inset); border-color: var(--fg-muted) }
  .tray-status { font-size: 11px; color: var(--success); margin-left: auto; display: inline-flex; align-items: center; gap: 5px }
  .label-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  select.decoration {
    font: inherit; font-size: 11px; color: var(--fg);
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 2px 6px; cursor: pointer;
  }

  /* ── composer ─────────────────────────────────────────────────────── */
  .composer { display: flex; flex-direction: column; gap: 9px; padding: 10px 14px 12px; border-top: 1px solid var(--border); }
  textarea {
    resize: none; min-height: 38px; max-height: 130px;
    padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
    font: inherit; color: var(--fg); background: var(--bg);
  }
  textarea::placeholder { color: var(--fg-muted) }
  textarea:focus { outline: 2px solid color-mix(in srgb, var(--cortex) 55%, transparent); outline-offset: -1px; border-color: var(--cortex) }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
  .post-status { font-size: 11px; margin-right: auto; display: inline-flex; align-items: center; gap: 6px; min-width: 0 }
  .post-status .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .post-status.error { color: var(--danger) }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 13px; border-radius: 8px; font: inherit; font-weight: 600;
    cursor: pointer; border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  .btn:hover { background: var(--bg-inset) }
  .btn:disabled { opacity: .55; cursor: default }
  .btn.ask {
    background: var(--cortex); color: var(--cortex-on);
    border-color: color-mix(in srgb, var(--cortex) 70%, #000);
  }
  .btn.ask:hover { background: color-mix(in srgb, var(--cortex) 88%, #000) }
  .btn .icon { flex: none }

  /* spinner */
  .spinner .icon { animation: spin .7s linear infinite }
  @keyframes spin { to { transform: rotate(360deg) } }
`

function header(): string {
  return `
    <div class="header">
      <div class="brand">
        <span class="mark">${icon('logo', 18)}</span>
        <span class="wordmark">Cortex</span>
        <span class="tagline">AI Review Assistant</span>
      </div>
      <span class="spacer"></span>
      <span class="chip" hidden>${icon('code', 13)}<span class="label"></span></span>
      <button class="newthread" type="button" title="Clear the conversation and start a new thread" aria-label="New thread" hidden>New</button>
      <button class="iconbtn toggle" type="button" title="Collapse / expand" aria-label="Collapse">${icon('chevronDown', 16)}</button>
    </div>`
}

const TEMPLATE = `
  <style>${STYLES}</style>
  <button class="launcher" type="button" aria-label="Open Cortex review assistant" title="Open Cortex">${icon('logo', 22)}</button>
  <div class="panel">
    ${header()}
    <div class="body">
      <div class="answer placeholder">Highlight code in the diff, then ask a question.</div>
      <div class="answer-actions" hidden>
        <button type="button" class="link-btn use-answer" title="Load this answer into the comment box to edit and post">${icon('comment', 13)} Use as comment</button>
        <button type="button" class="link-btn copy-answer" title="Copy the answer to the clipboard">${icon('copy', 13)} Copy</button>
      </div>
      <div class="tray">
        <span class="tray-label">${icon('plus', 13)} Insert</span>
        <span class="tray-chips"></span>
        <span class="tray-status"></span>
      </div>
      <div class="tray labels">
        <span class="tray-label">${icon('tag', 12)} Label</span>
        <select class="decoration" title="Conventional Comments decoration"></select>
        <span class="label-chips"></span>
      </div>
      <div class="composer">
        <textarea placeholder="Ask about the code, or write a comment to post…" rows="1"></textarea>
        <div class="actions">
          <span class="post-status"></span>
          <button type="button" class="btn summarize" title="Summarize the whole PR (no selection needed)">${icon('list', 15)} Summarize PR</button>
          <button type="button" class="btn suggest" title="Generate a committable suggestion for the selected lines">${icon('wand', 15)} Suggest a fix</button>
          <button type="button" class="btn ask">${icon('sparkles', 15)} Ask</button>
          <button type="button" class="btn post" title="Post the text above as a review comment on the selected line">${icon('comment', 15)} Post to line</button>
        </div>
      </div>
    </div>
  </div>
`

export class DockPanel {
  readonly host: HTMLElement
  onSubmit: ((question: string) => void) | null = null
  onSuggest: (() => void) | null = null
  onSummarize: (() => void) | null = null
  onInsertComment: ((body: string) => void) | null = null
  onApplyLabel: ((label: ConventionalLabel, decoration: string) => void) | null = null
  onPost: ((text: string) => void) | null = null

  private readonly root: ShadowRoot
  private readonly answerEl: HTMLDivElement
  private readonly answerActionsEl: HTMLDivElement
  private readonly chipEl: HTMLSpanElement
  private readonly chipLabel: HTMLSpanElement
  private readonly inputEl: HTMLTextAreaElement
  private readonly askBtn: HTMLButtonElement
  private readonly suggestBtn: HTMLButtonElement
  private readonly summarizeBtn: HTMLButtonElement
  private readonly postBtn: HTMLButtonElement
  private readonly postStatusEl: HTMLSpanElement
  private readonly trayChipsEl: HTMLSpanElement
  private readonly trayStatusEl: HTMLSpanElement
  private readonly labelChipsEl: HTMLSpanElement
  private readonly decorationSelect: HTMLSelectElement
  private readonly newThreadBtn: HTMLButtonElement
  private trayTimer: number | undefined
  private streaming = false
  private rawAnswer = ''
  /** Finalized conversation turns (oldest first); `display` overrides the shown question text. */
  private turns: (ChatMessage & { display?: string })[] = []
  private pendingQuestion: string | null = null
  private pendingDisplay = ''
  /** Cached HTML of finalized turns + the in-flight question, so streaming only re-renders the answer. */
  private threadPrefix = ''

  constructor() {
    this.host = document.createElement('div')
    this.host.setAttribute('data-ycra-dock', '')
    this.host.setAttribute('collapsed', '') // start as the launcher button; expand on click
    this.root = this.host.attachShadow({ mode: 'open' })
    this.root.innerHTML = TEMPLATE

    this.answerEl = this.root.querySelector('.answer')!
    this.answerActionsEl = this.root.querySelector('.answer-actions')!
    this.chipEl = this.root.querySelector('.chip')!
    this.chipLabel = this.root.querySelector('.chip .label')!
    this.inputEl = this.root.querySelector('textarea')!
    this.askBtn = this.root.querySelector('.btn.ask')!
    this.suggestBtn = this.root.querySelector('.btn.suggest')!
    this.summarizeBtn = this.root.querySelector('.btn.summarize')!
    this.postBtn = this.root.querySelector('.btn.post')!
    this.postStatusEl = this.root.querySelector('.post-status')!
    this.trayChipsEl = this.root.querySelector('.tray-chips')!
    this.trayStatusEl = this.root.querySelector('.tray-status')!
    this.labelChipsEl = this.root.querySelector('.label-chips')!
    this.decorationSelect = this.root.querySelector('.decoration')!
    this.newThreadBtn = this.root.querySelector('.newthread')!

    this.root.querySelector('.header')!.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      // Chip text stays selectable; the New-thread button has its own handler.
      if (t.closest('.chip') || t.closest('.newthread')) return
      this.toggleCollapsed()
    })
    this.root.querySelector('.launcher')!.addEventListener('click', () => this.toggleCollapsed())
    this.newThreadBtn.addEventListener('click', () => this.newThread())
    this.askBtn.addEventListener('click', () => this.submit())
    this.suggestBtn.addEventListener('click', () => {
      if (!this.streaming) this.onSuggest?.()
    })
    this.summarizeBtn.addEventListener('click', () => {
      if (!this.streaming) this.onSummarize?.()
    })
    this.postBtn.addEventListener('click', () => {
      const text = this.inputEl.value.trim()
      if (text) this.onPost?.(text)
    })
    this.root.querySelector('.use-answer')!.addEventListener('click', () =>
      this.useAnswerAsComment(),
    )
    this.root.querySelector('.copy-answer')!.addEventListener('click', () =>
      this.copyAnswer(),
    )
    this.inputEl.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        this.submit()
      }
    })

    // Keep keystrokes inside the dock — GitHub's global hotkeys (s, /, t, f, …) fire
    // on document keydown because focus is in our shadow root (activeElement is the
    // host <div>, not the textarea), and would steal focus to GitHub's search/filter.
    const stop = (e: Event): void => e.stopPropagation()
    this.host.addEventListener('keydown', stop)
    this.host.addEventListener('keyup', stop)
    this.host.addEventListener('keypress', stop)
  }

  mount(parent: ParentNode = document.body): void {
    parent.appendChild(this.host)
  }

  /** Toggle between the full-width dock and the collapsed launcher button. */
  private toggleCollapsed(): void {
    this.host.toggleAttribute('collapsed')
  }

  private submit(): void {
    const question = this.inputEl.value.trim()
    if (!question || this.streaming) return
    this.onSubmit?.(question)
  }

  setSelection(summary: string | null): void {
    if (!summary) {
      this.chipEl.hidden = true
      return
    }
    this.chipLabel.textContent = summary
    this.chipEl.hidden = false
  }

  renderComments(comments: CannedComment[]): void {
    this.trayChipsEl.replaceChildren()
    for (const comment of comments) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'chip-btn'
      chip.textContent = comment.label
      chip.title = comment.body
      // Don't steal focus from GitHub's comment field on click.
      chip.addEventListener('mousedown', (e) => e.preventDefault())
      chip.addEventListener('click', () => this.onInsertComment?.(comment.body))
      this.trayChipsEl.appendChild(chip)
    }
  }

  renderLabels(labels: ConventionalLabel[], decorations: readonly string[]): void {
    this.decorationSelect.replaceChildren()
    for (const d of decorations) {
      const opt = document.createElement('option')
      opt.value = d
      opt.textContent = d || 'no decoration'
      this.decorationSelect.appendChild(opt)
    }
    this.labelChipsEl.replaceChildren()
    for (const item of labels) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'chip-btn'
      chip.textContent = item.label
      chip.title = `Prepend "${item.value}: "`
      // Don't steal focus from GitHub's comment field on click.
      chip.addEventListener('mousedown', (e) => e.preventDefault())
      chip.addEventListener('click', () => this.onApplyLabel?.(item, this.decorationSelect.value))
      this.labelChipsEl.appendChild(chip)
    }
  }

  flashTray(message: string, ok = true): void {
    this.trayStatusEl.innerHTML = `${icon(ok ? 'check' : 'alert', 12)}<span>${message}</span>`
    this.trayStatusEl.style.color = ok ? 'var(--success)' : 'var(--danger)'
    window.clearTimeout(this.trayTimer)
    this.trayTimer = window.setTimeout(() => this.trayStatusEl.replaceChildren(), 2000)
  }

  private showAnswerActions(visible: boolean): void {
    this.answerActionsEl.hidden = !visible
  }

  /** Load the streamed answer into the composer so the reviewer can edit, then Post. */
  private useAnswerAsComment(): void {
    const text = this.rawAnswer.trim()
    if (!text) return
    this.inputEl.value = text
    this.inputEl.focus()
    this.inputEl.selectionStart = this.inputEl.selectionEnd = text.length
    this.inputEl.scrollIntoView({ block: 'nearest' })
    this.flashTray('Loaded — edit, then Post to line')
  }

  private copyAnswer(): void {
    const text = this.rawAnswer.trim()
    if (!text) return
    void navigator.clipboard?.writeText(text).then(
      () => this.flashTray('Copied'),
      () => this.flashTray('Copy failed', false),
    )
  }

  // ── conversation ───────────────────────────────────────────────────
  /** The finalized conversation, for the next request's `history`. */
  getHistory(): ChatMessage[] {
    return this.turns.map((t) => ({ role: t.role, content: t.content }))
  }

  /** Clear the thread back to the empty placeholder. */
  newThread(): void {
    this.turns = []
    this.pendingQuestion = null
    this.pendingDisplay = ''
    this.threadPrefix = ''
    this.rawAnswer = ''
    this.showAnswerActions(false)
    this.newThreadBtn.hidden = true
    this.answerEl.className = 'answer placeholder'
    this.answerEl.textContent = 'Highlight code in the diff, then ask a question.'
  }

  /** Rendered HTML for the finalized turns — questions verbatim, answers as markdown. */
  private finalizedHtml(): string {
    return this.turns
      .map((t) =>
        t.role === 'user'
          ? `<div class="turn-q">${escapeHtml(t.display ?? t.content)}</div>`
          : `<div class="turn-a">${DOMPurify.sanitize(marked.parse(t.content) as string)}</div>`,
      )
      .join('')
  }

  // ── ask lifecycle ──────────────────────────────────────────────────
  startAnswer(question: string, display?: string): void {
    this.streaming = true
    this.askBtn.disabled = true
    this.suggestBtn.disabled = true
    this.summarizeBtn.disabled = true
    this.host.removeAttribute('collapsed')
    this.rawAnswer = ''
    this.pendingQuestion = question
    this.pendingDisplay = display ?? question
    this.showAnswerActions(false)
    this.threadPrefix =
      this.finalizedHtml() + `<div class="turn-q">${escapeHtml(this.pendingDisplay)}</div>`
    this.answerEl.className = 'answer'
    this.answerEl.innerHTML =
      this.threadPrefix +
      `<div class="status-row spinner">${icon('spinner', 15)}<span>Thinking…</span></div>`
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  appendText(delta: string): void {
    this.rawAnswer += delta
    this.answerEl.innerHTML =
      this.threadPrefix +
      `<div class="turn-a">${DOMPurify.sanitize(marked.parse(this.rawAnswer) as string)}</div>`
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  finishAnswer(): void {
    this.streaming = false
    this.askBtn.disabled = false
    this.suggestBtn.disabled = false
    this.summarizeBtn.disabled = false
    if (this.rawAnswer.trim() && this.pendingQuestion != null) {
      // Commit the exchange; keep rawAnswer so "Use as comment" can act on the latest answer.
      this.turns.push({ role: 'user', content: this.pendingQuestion, display: this.pendingDisplay })
      this.turns.push({ role: 'assistant', content: this.rawAnswer })
      this.pendingQuestion = null
      this.newThreadBtn.hidden = false
      this.answerEl.className = 'answer'
      this.answerEl.innerHTML = this.finalizedHtml()
      this.answerEl.scrollTop = this.answerEl.scrollHeight
      this.showAnswerActions(true)
    } else {
      this.pendingQuestion = null
      this.answerEl.innerHTML =
        this.threadPrefix + `<div class="status-row"><span>(no response)</span></div>`
    }
  }

  showError(message: string): void {
    this.streaming = false
    this.askBtn.disabled = false
    this.suggestBtn.disabled = false
    this.summarizeBtn.disabled = false
    this.host.removeAttribute('collapsed')
    this.showAnswerActions(false)
    this.pendingQuestion = null
    this.answerEl.className = 'answer'
    this.answerEl.innerHTML =
      this.finalizedHtml() +
      `<div class="status-row error">${icon('alert', 16)}<span class="msg"></span></div>`
    this.answerEl.querySelector('.status-row.error .msg')!.textContent = message
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  // ── post lifecycle ─────────────────────────────────────────────────
  postPending(): void {
    this.host.removeAttribute('collapsed')
    this.showAnswerActions(false)
    this.postBtn.disabled = true
    this.postStatusEl.className = 'post-status'
    this.postStatusEl.innerHTML = `<span class="spinner">${icon('spinner', 13)}</span><span class="label">Posting…</span>`
  }

  postDone(url: string): void {
    this.postBtn.disabled = false
    this.postStatusEl.replaceChildren()
    this.host.removeAttribute('collapsed')
    this.showAnswerActions(false)
    this.answerEl.className = 'answer'
    this.answerEl.innerHTML =
      this.finalizedHtml() +
      `<div class="status-row ok">${icon('check', 16)}<span>Comment posted — </span>` +
      `<a target="_blank" rel="noopener noreferrer">view on GitHub ${icon('externalLink', 12)}</a></div>`
    this.answerEl.querySelector('.status-row.ok a')!.setAttribute('href', url)
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  postFailed(message: string): void {
    this.postBtn.disabled = false
    this.postStatusEl.replaceChildren()
    this.showError(message)
  }
}
