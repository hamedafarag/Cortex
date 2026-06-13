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
import type { ChatMessage, DraftComment } from '../../shared/types'
import type { ThreadState } from '../../shared/persistence'
import { icon, type IconName } from './icons'

/** A review lens option rendered into the lens select. */
export interface LensOption {
  id: string
  label: string
}

/** Severity → chip icon + colour. Label is always shown too (color-blind safe). */
const SEVERITY_CHIPS: Record<string, { icon: IconName; color: string }> = {
  blocker: { icon: 'alert', color: 'var(--danger)' },
  major: { icon: 'alert', color: 'var(--attention)' },
  minor: { icon: 'info', color: 'var(--accent)' },
  nit: { icon: 'dot', color: 'var(--fg-muted)' },
  praise: { icon: 'sparkles', color: 'var(--success)' },
}

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
    --attention: var(--fgColor-attention, var(--color-attention-fg, #9a6700));
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

  /* severity chips (whole-PR review findings) — colour + icon + label = color-blind safe */
  .answer .sev {
    display: inline-flex; align-items: center; gap: 4px; vertical-align: baseline;
    font-family: var(--mono); font-size: 10px; font-weight: 700;
    letter-spacing: .04em; text-transform: uppercase;
    padding: 1px 7px 1px 6px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    background: color-mix(in srgb, currentColor 12%, transparent);
  }
  .answer .sev .icon { flex: none }
  /* findings list: tighter, with the chip aligned to the title */
  .answer li:has(.sev) { margin-bottom: 5px }

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
  .redaction-notice {
    display: flex; align-items: center; gap: 7px; margin: 10px 14px 0;
    padding: 7px 11px; font-size: 12px; border-radius: 8px;
    color: var(--attention);
    background: color-mix(in srgb, var(--attention) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--attention) 35%, transparent);
  }
  .redaction-notice[hidden] { display: none }
  .redaction-notice .icon { flex: none }
  .redaction-notice b { color: var(--fg) }
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

  /* ── whole-PR actions toolbar ─────────────────────────────────────── */
  .pr-actions {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 14px; border-top: 1px solid var(--border);
  }
  .pr-label { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--fg-muted); font-weight: 600; }
  .pr-actions .group { display: inline-flex; align-items: center; gap: 0; }
  .pr-actions .group select.lens {
    font: inherit; font-size: 11px; color: var(--fg);
    background: var(--bg); border: 1px solid var(--border); border-right: none;
    border-radius: 7px 0 0 7px; padding: 4px 6px; cursor: pointer; max-width: 130px;
  }
  .pr-actions .group .btn.sm { border-radius: 0 7px 7px 0 }
  .btn.sm {
    padding: 4px 10px; font-size: 12px; font-weight: 600; border-radius: 7px;
    gap: 5px; color: var(--fg);
  }
  .btn.sm:disabled { opacity: .55; cursor: default }

  /* ── pending-review panel ─────────────────────────────────────────── */
  .review-panel { border-top: 1px solid var(--border); padding: 9px 14px; }
  .review-panel[hidden] { display: none }
  .review-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .review-title { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-muted); font-weight: 600; }
  .review-title b { color: var(--cortex); }
  .review-spacer { flex: 1 }
  .review-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 168px; overflow-y: auto; }
  .review-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--muted-bg); }
  .review-list .rc-where { font-family: var(--mono); font-size: 11px; color: var(--fg-muted); flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .review-list .rc-body { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .review-list .rc-remove { flex: none; display: inline-flex; padding: 2px; border: none; background: none; color: var(--fg-muted); cursor: pointer; border-radius: 5px; }
  .review-list .rc-remove:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }

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
  .post-status.confirm { color: var(--attention) }
  .post-status .label .where { font-family: var(--mono); color: var(--fg); font-weight: 600 }
  .post-status .mini {
    font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; flex: none;
    border: 1px solid var(--border); border-radius: 6px; padding: 2px 9px;
    background: var(--bg); color: var(--fg);
  }
  .post-status .mini.go { background: var(--cortex); border-color: var(--cortex); color: #fff }
  .post-status .mini:hover { border-color: var(--cortex) }
  /* Undo / Refresh buttons on the "comment posted" row */
  .status-row .undo, .status-row .refresh {
    font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    display: inline-flex; align-items: center; gap: 4px; margin: 0 2px 0 6px;
    border: 1px solid color-mix(in srgb, var(--cortex) 45%, var(--border)); border-radius: 6px;
    padding: 1px 9px; background: var(--bg); color: var(--cortex);
  }
  .status-row .undo:hover, .status-row .refresh:hover { background: color-mix(in srgb, var(--cortex) 10%, transparent) }
  .status-row .hint { font-size: 11px; color: var(--fg-muted); margin-left: 4px }
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
      <button class="iconbtn help" type="button" title="What can Cortex do? — open the features page" aria-label="Features &amp; help">${icon('help', 16)}</button>
      <button class="iconbtn toggle" type="button" title="Collapse / expand" aria-label="Collapse">${icon('chevronDown', 16)}</button>
    </div>`
}

const TEMPLATE = `
  <style>${STYLES}</style>
  <button class="launcher" type="button" aria-label="Open Cortex review assistant" title="Open Cortex">${icon('logo', 22)}</button>
  <div class="panel">
    ${header()}
    <div class="body">
      <div class="redaction-notice" hidden></div>
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
      <div class="pr-actions">
        <span class="pr-label">${icon('list', 13)} Whole PR</span>
        <button type="button" class="btn sm summarize" title="Summarize the whole PR (no selection needed)">${icon('list', 14)} Summarize</button>
        <span class="group">
          <select class="lens" title="Review lens — scope the review to one dimension"></select>
          <button type="button" class="btn sm review" title="Review the whole PR and list findings (no selection needed)">${icon('search', 14)} Review</button>
        </span>
        <button type="button" class="btn sm testgaps" title="Heuristic check: which changed source files have no matching test change?">${icon('beaker', 14)} Test gaps</button>
      </div>
      <div class="review-panel" hidden>
        <div class="review-head">
          <span class="review-title">${icon('list', 13)} Pending review · <b class="review-count">0</b></span>
          <span class="review-spacer"></span>
          <button type="button" class="link-btn review-discard" title="Discard all pending comments (nothing has been posted)">Discard</button>
        </div>
        <ul class="review-list"></ul>
      </div>
      <div class="composer">
        <textarea placeholder="Ask about the code, or write a comment to post…" rows="1"></textarea>
        <div class="actions">
          <span class="post-status"></span>
          <button type="button" class="btn suggest" title="Generate a committable suggestion for the selected lines">${icon('wand', 15)} Suggest a fix</button>
          <button type="button" class="btn ask">${icon('sparkles', 15)} Ask</button>
          <button type="button" class="btn addreview" title="Add the text above to a pending review — submit them together with a verdict">${icon('listPlus', 15)} Add to review</button>
          <button type="button" class="btn post" title="Post the text above as a single review comment on the selected line">${icon('comment', 15)} Post to line</button>
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
  onReview: ((lensId: string) => void) | null = null
  onTestGaps: (() => void) | null = null
  onInsertComment: ((body: string) => void) | null = null
  onApplyLabel: ((label: ConventionalLabel, decoration: string) => void) | null = null
  onPost: ((text: string) => void) | null = null
  onAddToReview: ((text: string) => void) | null = null
  onHelp: (() => void) | null = null
  /** Fired when the persistable thread changes. `immediate` = a committed change (finish/new
   *  thread) that should be saved now; `false` = draft typing that can be debounced. */
  onThreadChange: ((immediate: boolean) => void) | null = null

  private readonly root: ShadowRoot
  private readonly answerEl: HTMLDivElement
  private readonly redactionEl: HTMLDivElement
  private readonly answerActionsEl: HTMLDivElement
  private readonly chipEl: HTMLSpanElement
  private readonly chipLabel: HTMLSpanElement
  private readonly inputEl: HTMLTextAreaElement
  private readonly askBtn: HTMLButtonElement
  private readonly suggestBtn: HTMLButtonElement
  private readonly summarizeBtn: HTMLButtonElement
  private readonly reviewBtn: HTMLButtonElement
  private readonly testGapsBtn: HTMLButtonElement
  private readonly lensSelect: HTMLSelectElement
  private readonly postBtn: HTMLButtonElement
  private readonly addReviewBtn: HTMLButtonElement
  private readonly reviewPanelEl: HTMLDivElement
  private readonly reviewListEl: HTMLUListElement
  private readonly reviewCountEl: HTMLElement
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
  /** Pending comments accumulated into a draft review (local until submitted). */
  private review: DraftComment[] = []
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
    this.redactionEl = this.root.querySelector('.redaction-notice')!
    this.chipEl = this.root.querySelector('.chip')!
    this.chipLabel = this.root.querySelector('.chip .label')!
    this.inputEl = this.root.querySelector('textarea')!
    this.askBtn = this.root.querySelector('.btn.ask')!
    this.suggestBtn = this.root.querySelector('.btn.suggest')!
    this.summarizeBtn = this.root.querySelector('.btn.summarize')!
    this.reviewBtn = this.root.querySelector('.btn.review')!
    this.testGapsBtn = this.root.querySelector('.btn.testgaps')!
    this.lensSelect = this.root.querySelector('select.lens')!
    this.postBtn = this.root.querySelector('.btn.post')!
    this.addReviewBtn = this.root.querySelector('.btn.addreview')!
    this.reviewPanelEl = this.root.querySelector('.review-panel')!
    this.reviewListEl = this.root.querySelector('.review-list')!
    this.reviewCountEl = this.root.querySelector('.review-count')!
    this.postStatusEl = this.root.querySelector('.post-status')!
    this.trayChipsEl = this.root.querySelector('.tray-chips')!
    this.trayStatusEl = this.root.querySelector('.tray-status')!
    this.labelChipsEl = this.root.querySelector('.label-chips')!
    this.decorationSelect = this.root.querySelector('.decoration')!
    this.newThreadBtn = this.root.querySelector('.newthread')!

    this.root.querySelector('.header')!.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      // Chip text stays selectable; the New-thread and Help buttons have their own handlers.
      if (t.closest('.chip') || t.closest('.newthread') || t.closest('.help')) return
      this.toggleCollapsed()
    })
    this.root.querySelector('.help')!.addEventListener('click', () => this.onHelp?.())
    this.root.querySelector('.launcher')!.addEventListener('click', () => this.toggleCollapsed())
    this.newThreadBtn.addEventListener('click', () => this.newThread())
    this.askBtn.addEventListener('click', () => this.submit())
    this.suggestBtn.addEventListener('click', () => {
      if (!this.streaming) this.onSuggest?.()
    })
    this.summarizeBtn.addEventListener('click', () => {
      if (!this.streaming) this.onSummarize?.()
    })
    this.reviewBtn.addEventListener('click', () => {
      if (!this.streaming) this.onReview?.(this.lensSelect.value)
    })
    this.testGapsBtn.addEventListener('click', () => {
      if (!this.streaming) this.onTestGaps?.()
    })
    this.postBtn.addEventListener('click', () => {
      const text = this.inputEl.value.trim()
      if (text) this.onPost?.(text)
    })
    this.addReviewBtn.addEventListener('click', () => {
      const text = this.inputEl.value.trim()
      if (text) this.onAddToReview?.(text)
    })
    this.root.querySelector('.review-discard')!.addEventListener('click', () => this.clearReview())
    this.reviewListEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.rc-remove') as HTMLElement | null
      if (btn) this.removeReviewComment(Number(btn.dataset.i))
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
    // Draft autosave — debounced by the persistence handler.
    this.inputEl.addEventListener('input', () => this.onThreadChange?.(false))

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

  /** Tell the reviewer that secrets were masked before the request left the browser. Shown for
   *  the current turn; cleared when the next ask starts. */
  showRedactionNotice(count: number): void {
    if (count <= 0) return
    this.redactionEl.hidden = false
    this.redactionEl.innerHTML =
      `${icon('shield', 14)}<span>Masked <b>${count}</b> likely secret${count === 1 ? '' : 's'} ` +
      `before sending to the model.</span>`
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

  /** Populate the review-lens select (General + specialist lenses). */
  renderLenses(lenses: LensOption[]): void {
    this.lensSelect.replaceChildren()
    for (const lens of lenses) {
      const opt = document.createElement('option')
      opt.value = lens.id
      opt.textContent = lens.id === 'general' ? 'General' : `${lens.label} lens`
      this.lensSelect.appendChild(opt)
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

  /** Disable/enable every "start an ask" control while one is in flight. */
  private setActionsDisabled(disabled: boolean): void {
    this.askBtn.disabled = disabled
    this.suggestBtn.disabled = disabled
    this.summarizeBtn.disabled = disabled
    this.reviewBtn.disabled = disabled
    this.testGapsBtn.disabled = disabled
    this.lensSelect.disabled = disabled
  }

  /** Load the streamed answer into the composer so the reviewer can edit, then Post. */
  private useAnswerAsComment(): void {
    const text = this.rawAnswer.trim()
    if (!text) return
    this.inputEl.value = text
    this.inputEl.focus()
    this.inputEl.selectionStart = this.inputEl.selectionEnd = text.length
    this.inputEl.scrollIntoView({ block: 'nearest' })
    this.onThreadChange?.(false) // persist the loaded draft
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

  /** The persistable state — finalized turns + the current composer draft + the draft review. */
  getThread(): ThreadState {
    return {
      turns: this.turns.map((t) => ({ role: t.role, content: t.content, display: t.display })),
      draft: this.inputEl.value,
      review: this.review.map((c) => ({ ...c })),
    }
  }

  /** Restore a saved thread (turns + draft + draft review) on mount. Renders the conversation
   *  and the review panel. Does not fire onThreadChange (it's a load) and does not expand the dock. */
  restoreThread(state: ThreadState): void {
    this.review = (state.review ?? []).map((c) => ({ ...c }))
    this.renderReviewPanel()
    this.turns = state.turns.map((t) => ({ role: t.role, content: t.content, display: t.display }))
    this.inputEl.value = state.draft ?? ''
    if (this.turns.length === 0) return
    this.newThreadBtn.hidden = false
    this.answerEl.className = 'answer'
    this.setAnswerHtml(this.finalizedHtml())
    const lastAnswer = [...this.turns].reverse().find((t) => t.role === 'assistant')
    if (lastAnswer) {
      this.rawAnswer = lastAnswer.content // so Use-as-comment / Copy act on the restored answer
      this.showAnswerActions(true)
    }
  }

  // ── pending review (batch) ─────────────────────────────────────────
  /** Add a comment to the draft review (local until submitted) and clear the composer. */
  addReviewComment(comment: DraftComment): void {
    this.review.push(comment)
    this.inputEl.value = '' // moved into the pending review
    this.renderReviewPanel()
    this.onThreadChange?.(true)
    this.flashTray(`Added to review (${this.review.length})`)
  }

  /** Remove one pending comment by index. */
  removeReviewComment(index: number): void {
    if (index < 0 || index >= this.review.length) return
    this.review.splice(index, 1)
    this.renderReviewPanel()
    this.onThreadChange?.(true)
  }

  /** Discard the whole draft review (nothing was posted). */
  clearReview(): void {
    if (this.review.length === 0) return
    this.review = []
    this.renderReviewPanel()
    this.onThreadChange?.(true)
  }

  /** The pending comments, for submitting the review. */
  getReview(): DraftComment[] {
    return this.review.map((c) => ({ ...c }))
  }

  private renderReviewPanel(): void {
    const n = this.review.length
    this.reviewPanelEl.hidden = n === 0
    this.reviewCountEl.textContent = String(n)
    this.reviewListEl.replaceChildren()
    this.review.forEach((c, i) => {
      const li = document.createElement('li')
      const anchor =
        c.startLine && c.startLine !== c.line ? `${c.path}:${c.startLine}-${c.line}` : `${c.path}:${c.line}`
      const where = document.createElement('span')
      where.className = 'rc-where'
      where.textContent = anchor
      where.title = anchor
      const body = document.createElement('span')
      body.className = 'rc-body'
      body.textContent = c.body
      body.title = c.body
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'rc-remove'
      remove.dataset.i = String(i)
      remove.title = 'Remove from review'
      remove.innerHTML = icon('x', 12)
      li.append(where, body, remove)
      this.reviewListEl.appendChild(li)
    })
  }

  /** Clear the thread back to the empty placeholder. */
  newThread(): void {
    this.turns = []
    this.redactionEl.hidden = true
    this.pendingQuestion = null
    this.pendingDisplay = ''
    this.threadPrefix = ''
    this.rawAnswer = ''
    this.showAnswerActions(false)
    this.newThreadBtn.hidden = true
    this.answerEl.className = 'answer placeholder'
    this.answerEl.textContent = 'Highlight code in the diff, then ask a question.'
    this.onThreadChange?.(true)
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

  /** Write the answer area and upgrade any review-finding severity words to chips. The single
   *  funnel for all renders, so severity chips survive re-renders (streaming, post, error). */
  private setAnswerHtml(html: string): void {
    this.answerEl.innerHTML = html
    this.decorateSeverities()
  }

  /** Replace a leading **Blocker/Major/Minor/Nit/Praise** on a finding bullet with an
   *  icon + label chip. No-ops on anything that isn't a recognised severity, so plain
   *  answers and summaries are untouched. Runs on already-sanitized DOM (chips are built via
   *  DOM APIs from our own static icons), so it adds nothing for DOMPurify to vet. */
  private decorateSeverities(): void {
    const strongs = this.answerEl.querySelectorAll<HTMLElement>('.turn-a strong')
    strongs.forEach((el) => {
      const parent = el.parentElement
      if (!parent || el !== parent.firstElementChild) return
      if (parent.tagName !== 'LI' && parent.tagName !== 'P') return
      const word = (el.textContent ?? '').trim().toLowerCase().replace(/[.:]+$/, '')
      const meta = SEVERITY_CHIPS[word]
      if (!meta) return
      const chip = document.createElement('span')
      chip.className = 'sev'
      chip.style.color = meta.color
      chip.innerHTML = icon(meta.icon, 11)
      const label = document.createElement('span')
      label.textContent = word.charAt(0).toUpperCase() + word.slice(1)
      chip.appendChild(label)
      el.replaceWith(chip)
    })
  }

  // ── ask lifecycle ──────────────────────────────────────────────────
  startAnswer(question: string, display?: string): void {
    this.streaming = true
    this.setActionsDisabled(true)
    this.redactionEl.hidden = true // cleared per turn; META re-shows it if needed
    this.host.removeAttribute('collapsed')
    this.rawAnswer = ''
    this.pendingQuestion = question
    this.pendingDisplay = display ?? question
    this.showAnswerActions(false)
    this.threadPrefix =
      this.finalizedHtml() + `<div class="turn-q">${escapeHtml(this.pendingDisplay)}</div>`
    this.answerEl.className = 'answer'
    this.setAnswerHtml(
      this.threadPrefix +
        `<div class="status-row spinner">${icon('spinner', 15)}<span>Thinking…</span></div>`,
    )
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  appendText(delta: string): void {
    this.rawAnswer += delta
    this.setAnswerHtml(
      this.threadPrefix +
        `<div class="turn-a">${DOMPurify.sanitize(marked.parse(this.rawAnswer) as string)}</div>`,
    )
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  finishAnswer(): void {
    this.streaming = false
    this.setActionsDisabled(false)
    if (this.rawAnswer.trim() && this.pendingQuestion != null) {
      // Commit the exchange; keep rawAnswer so "Use as comment" can act on the latest answer.
      this.turns.push({ role: 'user', content: this.pendingQuestion, display: this.pendingDisplay })
      this.turns.push({ role: 'assistant', content: this.rawAnswer })
      this.pendingQuestion = null
      this.newThreadBtn.hidden = false
      this.answerEl.className = 'answer'
      this.setAnswerHtml(this.finalizedHtml())
      this.answerEl.scrollTop = this.answerEl.scrollHeight
      this.showAnswerActions(true)
      this.onThreadChange?.(true) // persist the committed turn
    } else {
      this.pendingQuestion = null
      this.setAnswerHtml(
        this.threadPrefix + `<div class="status-row"><span>(no response)</span></div>`,
      )
    }
  }

  showError(message: string): void {
    this.streaming = false
    this.setActionsDisabled(false)
    this.host.removeAttribute('collapsed')
    this.showAnswerActions(false)
    this.pendingQuestion = null
    this.answerEl.className = 'answer'
    this.setAnswerHtml(
      this.finalizedHtml() +
        `<div class="status-row error">${icon('alert', 16)}<span class="msg"></span></div>`,
    )
    this.answerEl.querySelector('.status-row.error .msg')!.textContent = message
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  // ── post lifecycle ─────────────────────────────────────────────────
  private undoTimer: ReturnType<typeof setTimeout> | undefined

  /** Confirm the public write before it fires. Shows the exact target; Confirm runs
   *  `onConfirm`, Cancel backs out. Posting is the one irreversible-ish action, so we gate it. */
  confirmPost(where: string, onConfirm: () => void): void {
    this.host.removeAttribute('collapsed')
    this.showAnswerActions(false)
    this.postBtn.disabled = true
    this.postStatusEl.className = 'post-status confirm'
    this.postStatusEl.innerHTML = icon('comment', 13)
    const label = document.createElement('span')
    label.className = 'label'
    const target = document.createElement('span')
    target.className = 'where'
    target.textContent = where
    label.append('Post to ', target, '?')
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'mini go'
    go.textContent = 'Confirm'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'mini'
    cancel.textContent = 'Cancel'
    this.postStatusEl.append(label, go, cancel)
    const close = (): void => {
      this.postStatusEl.replaceChildren()
      this.postStatusEl.className = 'post-status'
      this.postBtn.disabled = false
    }
    go.addEventListener('click', () => {
      close()
      onConfirm()
    })
    cancel.addEventListener('click', close)
  }

  postPending(): void {
    this.host.removeAttribute('collapsed')
    this.showAnswerActions(false)
    this.postBtn.disabled = true
    this.postStatusEl.className = 'post-status'
    this.postStatusEl.innerHTML = `<span class="spinner">${icon('spinner', 13)}</span><span class="label">Posting…</span>`
  }

  /** Posted OK. GitHub's SPA won't render an API-posted comment inline, so we offer a
   *  **Refresh** (reload to show it) and, for a short window, an **Undo** (delete it). The
   *  composer is cleared since the comment was sent. */
  postDone(url: string, actions: { onUndo?: () => void; onRefresh?: () => void } = {}): void {
    this.postBtn.disabled = false
    this.postStatusEl.replaceChildren()
    this.host.removeAttribute('collapsed')
    this.showAnswerActions(false)
    // The comment was sent — clear the draft so it doesn't linger (and isn't restored on reload).
    if (this.inputEl.value) {
      this.inputEl.value = ''
      this.onThreadChange?.(true)
    }
    this.answerEl.className = 'answer'
    this.setAnswerHtml(
      this.finalizedHtml() +
        `<div class="status-row ok">${icon('check', 16)}<span>Comment posted</span>` +
        `<button type="button" class="undo">${icon('undo', 12)}Undo</button>` +
        `<button type="button" class="refresh" title="Reload the page to show the comment in the diff">${icon('refresh', 12)}Refresh to show it</button>` +
        `<a target="_blank" rel="noopener noreferrer">view on GitHub ${icon('externalLink', 12)}</a></div>`,
    )
    const row = this.answerEl.querySelector('.status-row.ok')!
    row.querySelector('a')!.setAttribute('href', url)
    const undoBtn = row.querySelector('.undo') as HTMLButtonElement
    const refreshBtn = row.querySelector('.refresh') as HTMLButtonElement
    if (actions.onRefresh) refreshBtn.addEventListener('click', actions.onRefresh)
    else refreshBtn.remove()
    if (actions.onUndo) {
      undoBtn.addEventListener('click', () => {
        clearTimeout(this.undoTimer)
        actions.onUndo!()
      })
      this.undoTimer = setTimeout(() => undoBtn.remove(), 10_000) // close the undo window
    } else {
      undoBtn.remove()
    }
    this.answerEl.scrollTop = this.answerEl.scrollHeight
  }

  /** Deleting the just-posted comment (the Undo is in flight). */
  postUndoing(): void {
    clearTimeout(this.undoTimer)
    const row = this.answerEl.querySelector('.status-row.ok')
    if (row) row.innerHTML = `<span class="spinner">${icon('spinner', 14)}</span><span>Retracting…</span>`
  }

  /** The comment was deleted. Optionally restore the retracted text to the composer so the
   *  reviewer can fix and re-post. */
  postUndone(restoreDraft?: string): void {
    const row = this.answerEl.querySelector('.status-row')
    if (row) {
      row.className = 'status-row'
      row.innerHTML = `${icon('undo', 15)}<span>Comment retracted.</span>`
    }
    if (restoreDraft) {
      this.inputEl.value = restoreDraft
      this.onThreadChange?.(true)
    }
  }

  postFailed(message: string): void {
    clearTimeout(this.undoTimer)
    this.postBtn.disabled = false
    this.postStatusEl.replaceChildren()
    this.showError(message)
  }
}
