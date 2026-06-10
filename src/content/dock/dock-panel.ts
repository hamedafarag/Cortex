// The dock panel — a style-isolated UI pinned to the bottom of the PR page.
//
// NOT a custom element: content scripts run in an isolated world where
// `customElements` is null (a Chromium/Edge limitation), so registering a custom
// element throws. Instead we create a plain <div> host, attach an open shadow
// root (open so the content script and tests can reach in), and build the UI
// directly. Style isolation still comes from the shadow root + `:host` rules.

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
    white-space: pre-wrap; word-break: break-word;
  }
  .answer.empty { color: #8c959f; }
  .answer.error { color: #cf222e; }
  .composer { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid #d0d7de; }
  textarea {
    flex: 1; resize: none; min-height: 36px; max-height: 120px;
    padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px;
    font: inherit; color: inherit;
  }
  button {
    align-self: flex-end; padding: 6px 14px; border: 1px solid rgba(31,35,40,.15);
    border-radius: 6px; background: #1f883d; color: #fff; font: inherit;
    font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
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
      <div class="composer">
        <textarea placeholder="Ask about the selected code…" rows="1"></textarea>
        <button type="button">Ask</button>
      </div>
    </div>
  </div>
`

export class DockPanel {
  /** The host element to append into the page. */
  readonly host: HTMLElement
  /** Called when the user submits a question. */
  onSubmit: ((question: string) => void) | null = null

  private readonly root: ShadowRoot
  private readonly answerEl: HTMLDivElement
  private readonly chipEl: HTMLSpanElement
  private readonly inputEl: HTMLTextAreaElement
  private readonly askBtn: HTMLButtonElement
  private readonly toggleEl: HTMLSpanElement
  private streaming = false

  constructor() {
    this.host = document.createElement('div')
    this.host.setAttribute('data-ycra-dock', '')
    this.root = this.host.attachShadow({ mode: 'open' })
    this.root.innerHTML = TEMPLATE

    this.answerEl = this.root.querySelector('.answer')!
    this.chipEl = this.root.querySelector('.chip')!
    this.inputEl = this.root.querySelector('textarea')!
    this.askBtn = this.root.querySelector('button')!
    this.toggleEl = this.root.querySelector('.toggle')!

    this.root.querySelector('.header')!.addEventListener('click', () => this.toggleCollapsed())
    this.askBtn.addEventListener('click', () => this.submit())
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

  /** Begin a fresh streamed answer. */
  startAnswer(): void {
    this.streaming = true
    this.askBtn.disabled = true
    this.host.removeAttribute('collapsed')
    this.answerEl.classList.remove('empty', 'error')
    this.answerEl.textContent = ''
  }

  appendText(delta: string): void {
    this.answerEl.textContent += delta
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  finishAnswer(): void {
    this.streaming = false
    this.askBtn.disabled = false
    if (!this.answerEl.textContent) {
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
