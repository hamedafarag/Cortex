// Regression suite for the Cortex dock UI (src/content/dock/dock-panel.ts).
//
// DockPanel mounts a plain <div> host with an OPEN shadow root (content scripts can't use
// custom elements). Every test instantiates a fresh DockPanel and asserts on that shadow DOM.
// The crown-jewel guard: typing into the .composer textarea and clicking Ask must deliver
// that exact text to onSubmit — proving inputEl is still bound to the composer textarea and
// never rebound to (e.g.) the review-summary textarea.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DockPanel, DOCK_SELECTOR } from './dock-panel'
import type { LensOption } from './dock-panel'
import type { ThreadState } from '../../shared/persistence'
import type { DraftComment } from '../../shared/types'

/** Build a fresh panel mounted into document.body, with every on* callback wired to a vi.fn(). */
function makePanel() {
  const panel = new DockPanel()
  const cb = {
    onSubmit: vi.fn(),
    onSuggest: vi.fn(),
    onSummarize: vi.fn(),
    onReview: vi.fn(),
    onTestGaps: vi.fn(),
    onOverview: vi.fn(),
    onInsertComment: vi.fn(),
    onApplyLabel: vi.fn(),
    onPost: vi.fn(),
    onAddToReview: vi.fn(),
    onSubmitReview: vi.fn(),
    onHelp: vi.fn(),
    onThreadChange: vi.fn(),
  }
  Object.assign(panel, cb)
  panel.mount()
  // The open shadow root is reachable from the host element.
  const root = panel.host.shadowRoot as ShadowRoot
  return { panel, cb, root }
}

/** The composer textarea — the one inputEl must stay bound to. */
function composer(root: ShadowRoot): HTMLTextAreaElement {
  return root.querySelector('.composer textarea') as HTMLTextAreaElement
}

function q<T extends Element = HTMLElement>(root: ShadowRoot, sel: string): T {
  return root.querySelector(sel) as T
}

/** Simulate a real user typing into a textarea: set value + fire the input event. */
function typeInto(ta: HTMLTextAreaElement, text: string): void {
  ta.value = text
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('DockPanel — construction & shadow DOM', () => {
  it('creates a host div carrying the dock attribute, matchable by DOCK_SELECTOR', () => {
    const { panel } = makePanel()
    expect(panel.host.tagName).toBe('DIV')
    expect(panel.host.hasAttribute('data-ycra-dock')).toBe(true)
    expect(panel.host.matches(DOCK_SELECTOR)).toBe(true)
    expect(DOCK_SELECTOR).toBe('[data-ycra-dock]')
  })

  it('attaches an OPEN shadow root containing the composer, panel, launcher', () => {
    const { panel, root } = makePanel()
    expect(panel.host.shadowRoot).toBe(root) // open => readable from outside
    expect(root.querySelector('.composer textarea')).not.toBeNull()
    expect(root.querySelector('.panel')).not.toBeNull()
    expect(root.querySelector('.launcher')).not.toBeNull()
  })

  it('starts collapsed (launcher state)', () => {
    const { panel } = makePanel()
    expect(panel.host.hasAttribute('collapsed')).toBe(true)
  })

  it('mounts the host into the given parent (defaults to document.body)', () => {
    const panel = new DockPanel()
    expect(panel.host.isConnected).toBe(false)
    panel.mount()
    expect(panel.host.parentNode).toBe(document.body)
  })
})

describe('DockPanel — submit / Ask (inputEl binding crown jewel)', () => {
  it('REGRESSION: Ask delivers the EXACT composer textarea text to onSubmit', () => {
    const { cb, root } = makePanel()
    const text = 'Why is this nullable here?'
    // Type into the actual composer textarea (NOT review-summary).
    typeInto(composer(root), text)
    // Sanity: the review-summary textarea is a DIFFERENT element — if inputEl were ever
    // rebound to it, the value below would be empty and this guard would catch it.
    expect((q(root, '.review-summary') as HTMLTextAreaElement).value).toBe('')

    q(root, '.btn.ask').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(cb.onSubmit).toHaveBeenCalledTimes(1)
    expect(cb.onSubmit).toHaveBeenCalledWith(text)
  })

  it('REGRESSION: inputEl is the composer textarea, never the review-summary one', () => {
    const { cb, root } = makePanel()
    const composerTa = composer(root)
    const reviewTa = q(root, '.review-summary') as HTMLTextAreaElement
    expect(composerTa).not.toBe(reviewTa)
    // Put DIFFERENT text in each; Ask must read the composer's.
    typeInto(composerTa, 'composer-text')
    reviewTa.value = 'review-summary-text'
    q(root, '.btn.ask').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(cb.onSubmit).toHaveBeenCalledWith('composer-text')
    expect(cb.onSubmit).not.toHaveBeenCalledWith('review-summary-text')
  })

  it('trims surrounding whitespace before submitting', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), '   spaced out   ')
    q(root, '.btn.ask').click()
    expect(cb.onSubmit).toHaveBeenCalledWith('spaced out')
  })

  it('ignores submit on empty input', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), '')
    q(root, '.btn.ask').click()
    expect(cb.onSubmit).not.toHaveBeenCalled()
  })

  it('ignores submit on whitespace-only input', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), '   \n\t  ')
    q(root, '.btn.ask').click()
    expect(cb.onSubmit).not.toHaveBeenCalled()
  })

  it('Cmd/Ctrl+Enter in the composer submits', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), 'keyboard submit')
    composer(root).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
    )
    expect(cb.onSubmit).toHaveBeenCalledWith('keyboard submit')

    cb.onSubmit.mockClear()
    typeInto(composer(root), 'ctrl submit')
    composer(root).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
    )
    expect(cb.onSubmit).toHaveBeenCalledWith('ctrl submit')
  })

  it('plain Enter (no modifier) does NOT submit', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), 'no submit on plain enter')
    composer(root).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    expect(cb.onSubmit).not.toHaveBeenCalled()
  })
})

describe('DockPanel — submit is gated by streaming', () => {
  it('does not call onSubmit while streaming, then resumes after finish', () => {
    const { panel, cb, root } = makePanel()
    typeInto(composer(root), 'gated')
    panel.startAnswer('gated') // streaming = true
    q(root, '.btn.ask').click()
    expect(cb.onSubmit).not.toHaveBeenCalled()

    panel.appendText('answer')
    panel.finishAnswer() // streaming = false
    typeInto(composer(root), 'ungated')
    q(root, '.btn.ask').click()
    expect(cb.onSubmit).toHaveBeenCalledTimes(1)
    expect(cb.onSubmit).toHaveBeenCalledWith('ungated')
  })
})

describe('DockPanel — Post & Add-to-review read the COMPOSER value', () => {
  it('Post (.btn.post) sends the trimmed composer value to onPost', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), '  Please rename this  ')
    q(root, '.btn.post').click()
    expect(cb.onPost).toHaveBeenCalledTimes(1)
    expect(cb.onPost).toHaveBeenCalledWith('Please rename this')
  })

  it('Post ignores an empty composer', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), '   ')
    q(root, '.btn.post').click()
    expect(cb.onPost).not.toHaveBeenCalled()
  })

  it('Add-to-review (.btn.addreview) sends the trimmed composer value to onAddToReview', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), '  consider extracting a constant  ')
    q(root, '.btn.addreview').click()
    expect(cb.onAddToReview).toHaveBeenCalledTimes(1)
    expect(cb.onAddToReview).toHaveBeenCalledWith('consider extracting a constant')
  })

  it('Add-to-review ignores an empty composer', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), '')
    q(root, '.btn.addreview').click()
    expect(cb.onAddToReview).not.toHaveBeenCalled()
  })

  it('Post/Add read the COMPOSER, not the review-summary textarea', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), 'composer body')
    ;(q(root, '.review-summary') as HTMLTextAreaElement).value = 'summary body'
    q(root, '.btn.post').click()
    q(root, '.btn.addreview').click()
    expect(cb.onPost).toHaveBeenCalledWith('composer body')
    expect(cb.onAddToReview).toHaveBeenCalledWith('composer body')
  })
})

describe('DockPanel — whole-PR action buttons (callback + streaming gate)', () => {
  const cases: Array<[string, string, keyof ReturnType<typeof makePanel>['cb']]> = [
    ['suggest', '.btn.suggest', 'onSuggest'],
    ['summarize', '.btn.summarize', 'onSummarize'],
    ['testgaps', '.btn.testgaps', 'onTestGaps'],
    ['overview', '.btn.overview', 'onOverview'],
  ]

  for (const [name, sel, cbName] of cases) {
    it(`${name} button invokes ${cbName} when idle`, () => {
      const { cb, root } = makePanel()
      q(root, sel).click()
      expect(cb[cbName]).toHaveBeenCalledTimes(1)
    })

    it(`${name} button is gated while streaming`, () => {
      const { panel, cb, root } = makePanel()
      panel.startAnswer('q')
      q(root, sel).click()
      expect(cb[cbName]).not.toHaveBeenCalled()
    })
  }

  it('review button invokes onReview with the selected lens id, when idle', () => {
    const { panel, cb, root } = makePanel()
    const lenses: LensOption[] = [
      { id: 'general', label: 'General' },
      { id: 'security', label: 'Security' },
    ]
    panel.renderLenses(lenses)
    const lensSelect = q(root, 'select.lens') as HTMLSelectElement
    lensSelect.value = 'security'
    q(root, '.btn.review').click()
    expect(cb.onReview).toHaveBeenCalledTimes(1)
    expect(cb.onReview).toHaveBeenCalledWith('security')
  })

  it('review button is gated while streaming', () => {
    const { panel, cb, root } = makePanel()
    panel.startAnswer('q')
    q(root, '.btn.review').click()
    expect(cb.onReview).not.toHaveBeenCalled()
  })

  it('all start-an-ask controls are disabled during streaming and re-enabled after', () => {
    const { panel, root } = makePanel()
    const controls = ['.btn.ask', '.btn.suggest', '.btn.summarize', '.btn.review', '.btn.testgaps', '.btn.overview', 'select.lens']
    panel.startAnswer('q')
    for (const sel of controls) {
      expect((q(root, sel) as HTMLButtonElement).disabled).toBe(true)
    }
    panel.appendText('a')
    panel.finishAnswer()
    for (const sel of controls) {
      expect((q(root, sel) as HTMLButtonElement).disabled).toBe(false)
    }
  })
})

describe('DockPanel — help / launcher / collapse', () => {
  it('help button fires onHelp without toggling collapse', () => {
    const { panel, cb, root } = makePanel()
    const before = panel.host.hasAttribute('collapsed')
    q(root, '.help').click()
    expect(cb.onHelp).toHaveBeenCalledTimes(1)
    expect(panel.host.hasAttribute('collapsed')).toBe(before)
  })

  it('clicking the launcher toggles the collapsed attribute', () => {
    const { panel, root } = makePanel()
    expect(panel.host.hasAttribute('collapsed')).toBe(true)
    q(root, '.launcher').click()
    expect(panel.host.hasAttribute('collapsed')).toBe(false)
  })

  it('clicking the header (not chip/new/help) toggles collapsed', () => {
    const { panel, root } = makePanel()
    panel.host.removeAttribute('collapsed') // expand first
    q(root, '.header').click()
    expect(panel.host.hasAttribute('collapsed')).toBe(true)
    q(root, '.header').click()
    expect(panel.host.hasAttribute('collapsed')).toBe(false)
  })
})

describe('DockPanel — selection chip', () => {
  it('setSelection(summary) shows the chip; setSelection(null) hides it', () => {
    const { panel, root } = makePanel()
    const chip = q(root, '.chip') as HTMLElement
    expect(chip.hidden).toBe(true)
    panel.setSelection('src/app.ts:10-12')
    expect(chip.hidden).toBe(false)
    expect(q(root, '.chip .label').textContent).toBe('src/app.ts:10-12')
    // toggle off
    panel.setSelection(null)
    expect(chip.hidden).toBe(true)
  })
})

describe('DockPanel — answer lifecycle (start/append/finish)', () => {
  it('startAnswer shows the spinning "Thinking…" row, expands, and disables actions', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('What does this do?')
    expect(panel.host.hasAttribute('collapsed')).toBe(false)
    const answer = q(root, '.answer')
    expect(answer.querySelector('.status-row.spinner')).not.toBeNull()
    expect(answer.textContent).toContain('Thinking')
    // The question is echoed as a turn-q above the spinner.
    expect(answer.querySelector('.turn-q')!.textContent).toBe('What does this do?')
  })

  it('startAnswer escapes HTML in the question (no injection into the thread)', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('<img src=x onerror=alert(1)>')
    const turnQ = q(root, '.answer .turn-q')
    expect(turnQ.querySelector('img')).toBeNull()
    expect(turnQ.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('uses the display label (not the raw question) for the turn-q when provided', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('full prompt text the model sees', 'Review · Security')
    expect(q(root, '.answer .turn-q').textContent).toBe('Review · Security')
  })

  it('appendText accumulates deltas and renders markdown', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('q')
    panel.appendText('Hello ')
    panel.appendText('**world**')
    const answerA = q(root, '.answer .turn-a')
    expect(answerA.querySelector('strong')!.textContent).toBe('world')
    expect(answerA.textContent).toContain('Hello')
  })

  it('finishAnswer commits the exchange as a finalized turn and shows answer actions', () => {
    const { panel, cb, root } = makePanel()
    panel.startAnswer('My question')
    panel.appendText('My answer')
    cb.onThreadChange.mockClear()
    panel.finishAnswer()
    // history round-trips the committed turns
    expect(panel.getHistory()).toEqual([
      { role: 'user', content: 'My question' },
      { role: 'assistant', content: 'My answer' },
    ])
    // answer-actions become visible, New-thread button appears
    expect((q(root, '.answer-actions') as HTMLElement).hidden).toBe(false)
    expect((q(root, '.newthread') as HTMLElement).hidden).toBe(false)
    // committed turn persisted immediately
    expect(cb.onThreadChange).toHaveBeenCalledWith(true)
  })

  it('finishAnswer with an empty answer shows "(no response)" and commits nothing', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('My question')
    // no appendText
    panel.finishAnswer()
    expect(q(root, '.answer').textContent).toContain('(no response)')
    expect(panel.getHistory()).toEqual([])
  })

  it('multiple finished turns accumulate in history (oldest first)', () => {
    const { panel } = makePanel()
    panel.startAnswer('Q1')
    panel.appendText('A1')
    panel.finishAnswer()
    panel.startAnswer('Q2')
    panel.appendText('A2')
    panel.finishAnswer()
    expect(panel.getHistory()).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: 'A2' },
    ])
  })
})

describe('DockPanel — showError', () => {
  it('renders the error message in an error status row and clears streaming', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('q')
    panel.showError('Network failed: 503')
    const errRow = q(root, '.answer .status-row.error')
    expect(errRow).not.toBeNull()
    expect(errRow.querySelector('.msg')!.textContent).toBe('Network failed: 503')
    // streaming cleared → Ask works again
    typeInto(composer(root), 'retry')
    q(root, '.btn.ask').click()
    // onSubmit isn't wired here through cb capture, but the disabled flag is cleared:
    expect((q(root, '.btn.ask') as HTMLButtonElement).disabled).toBe(false)
  })

  it('escapes error text via textContent (no HTML injection)', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('q')
    panel.showError('<b>boom</b>')
    const msg = q(root, '.answer .status-row.error .msg')
    expect(msg.querySelector('b')).toBeNull()
    expect(msg.textContent).toBe('<b>boom</b>')
  })

  it('preserves already-finalized turns above the error', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('Q1')
    panel.appendText('A1')
    panel.finishAnswer()
    panel.startAnswer('Q2')
    panel.showError('failed')
    // Finalized Q1/A1 still present
    const turnsQ = q(root, '.answer').querySelectorAll('.turn-q')
    expect([...turnsQ].some((el) => el.textContent === 'Q1')).toBe(true)
    expect(q(root, '.answer .status-row.error')).not.toBeNull()
  })
})

describe('DockPanel — severity chips on review findings', () => {
  const SEVERITIES = ['Blocker', 'Major', 'Minor', 'Nit', 'Praise']

  for (const sev of SEVERITIES) {
    it(`turns a leading **${sev}** on a finding into a .sev chip`, () => {
      const { panel, root } = makePanel()
      panel.startAnswer('review')
      panel.appendText(`**${sev}:** something to fix here\n`)
      panel.finishAnswer()
      const chip = q(root, '.answer .sev')
      expect(chip).not.toBeNull()
      // chip label is the capitalised severity word
      expect(chip.textContent).toContain(sev)
      // original <strong> got replaced by the chip
      expect(q(root, '.answer .turn-a').querySelector('strong')).toBeNull()
    })
  }

  it('survives a list of findings (each bullet gets its own chip)', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('review')
    panel.appendText('- **Blocker:** null deref\n- **Nit:** spacing\n')
    panel.finishAnswer()
    const chips = q(root, '.answer').querySelectorAll('.sev')
    expect(chips.length).toBe(2)
    expect(chips[0].textContent).toContain('Blocker')
    expect(chips[1].textContent).toContain('Nit')
  })

  it('does NOT chip a non-severity leading bold word', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('review')
    panel.appendText('**Note:** this is just emphasis\n')
    panel.finishAnswer()
    expect(q(root, '.answer .sev')).toBeNull()
    expect(q(root, '.answer .turn-a').querySelector('strong')!.textContent).toBe('Note:')
  })

  it('does NOT chip a severity word when another element precedes it (not the first ELEMENT child)', () => {
    // decorateSeverities only chips a <strong> that is parent.firstElementChild. A leading
    // link makes the <strong> the SECOND element child, so it stays plain bold.
    const { panel, root } = makePanel()
    panel.startAnswer('review')
    panel.appendText('[see](https://x) **Blocker** detail\n')
    panel.finishAnswer()
    expect(q(root, '.answer .sev')).toBeNull()
    expect(q(root, '.answer .turn-a').querySelector('strong')!.textContent).toBe('Blocker')
  })

  it('chips a leading severity even with leading text in the same node (firstElementChild rule)', () => {
    // Note: marked renders "Plain **Blocker**" as <p>Plain <strong>Blocker</strong></p>;
    // the <strong> is still the FIRST element child, so it IS chipped. This documents the
    // actual (firstElementChild-based) behavior, not a first-text-node rule.
    const { panel, root } = makePanel()
    panel.startAnswer('review')
    panel.appendText('Plain text then **Blocker** word\n')
    panel.finishAnswer()
    expect(q(root, '.answer .sev')).not.toBeNull()
  })
})

describe('DockPanel — getThread / restoreThread round-trip', () => {
  it('getThread captures finalized turns, the composer draft, and the draft review', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('Q', 'Q display')
    panel.appendText('A')
    panel.finishAnswer()
    typeInto(composer(root), 'unsent draft')
    const review: DraftComment = { path: 'a.ts', line: 5, side: 'RIGHT', body: 'fix' }
    panel.addReviewComment(review)

    const thread = panel.getThread()
    expect(thread.turns).toEqual([
      { role: 'user', content: 'Q', display: 'Q display' },
      { role: 'assistant', content: 'A', display: undefined },
    ])
    // addReviewComment clears the composer; draft reflects post-add state
    expect(thread.draft).toBe('')
    expect(thread.review).toEqual([review])
  })

  it('getThread reflects the live composer draft', () => {
    const { panel, root } = makePanel()
    typeInto(composer(root), 'in progress')
    expect(panel.getThread().draft).toBe('in progress')
  })

  it('restoreThread renders turns, draft, and the review panel; does not fire onThreadChange', () => {
    const { panel, cb, root } = makePanel()
    const state: ThreadState = {
      turns: [
        { role: 'user', content: 'prev question', display: 'prev question' },
        { role: 'assistant', content: 'prev **answer**' },
      ],
      draft: 'restored draft',
      review: [{ path: 'b.ts', line: 9, side: 'RIGHT', body: 'pending note' }],
    }
    cb.onThreadChange.mockClear()
    panel.restoreThread(state)

    // turns rendered
    expect(q(root, '.answer .turn-q').textContent).toBe('prev question')
    expect(q(root, '.answer .turn-a strong')!.textContent).toBe('answer')
    // draft restored into composer
    expect(composer(root).value).toBe('restored draft')
    // review panel shown with the pending comment
    expect((q(root, '.review-panel') as HTMLElement).hidden).toBe(false)
    expect(q(root, '.review-count').textContent).toBe('1')
    // load does NOT trigger a save
    expect(cb.onThreadChange).not.toHaveBeenCalled()
    // history restored
    expect(panel.getHistory()).toEqual([
      { role: 'user', content: 'prev question' },
      { role: 'assistant', content: 'prev **answer**' },
    ])
  })

  it('getThread() -> restoreThread() on a fresh panel preserves turns + draft + review', () => {
    const { panel: a, root: rootA } = makePanel()
    a.startAnswer('Question one', 'Q1 label')
    a.appendText('Answer one')
    a.finishAnswer()
    typeInto(composer(rootA), 'leftover draft')
    a.addReviewComment({ path: 'x.ts', line: 3, side: 'LEFT', body: 'note' })
    // addReviewComment cleared the draft; re-type so we round-trip a non-empty draft.
    typeInto(composer(rootA), 'leftover draft')
    const snapshot = a.getThread()

    const b = new DockPanel()
    b.mount()
    b.restoreThread(snapshot)
    expect(b.getThread()).toEqual(snapshot)
    expect(b.getHistory()).toEqual([
      { role: 'user', content: 'Question one' },
      { role: 'assistant', content: 'Answer one' },
    ])
  })

  it('restoreThread with empty turns leaves the placeholder and hides New-thread', () => {
    const { panel, root } = makePanel()
    panel.restoreThread({ turns: [], draft: 'just a draft', review: [] })
    expect(composer(root).value).toBe('just a draft')
    expect((q(root, '.newthread') as HTMLElement).hidden).toBe(true)
    expect(q(root, '.answer').classList.contains('placeholder')).toBe(true)
  })
})

describe('DockPanel — newThread', () => {
  it('clears turns, draft-independent answer area, and notifies onThreadChange(true)', () => {
    const { panel, cb, root } = makePanel()
    panel.startAnswer('Q')
    panel.appendText('A')
    panel.finishAnswer()
    cb.onThreadChange.mockClear()
    panel.newThread()
    expect(panel.getHistory()).toEqual([])
    expect(q(root, '.answer').classList.contains('placeholder')).toBe(true)
    expect(q(root, '.answer').textContent).toContain('Highlight code in the diff')
    expect((q(root, '.newthread') as HTMLElement).hidden).toBe(true)
    expect(cb.onThreadChange).toHaveBeenCalledWith(true)
  })

  it('the header New button triggers newThread', () => {
    const { panel, cb, root } = makePanel()
    panel.startAnswer('Q')
    panel.appendText('A')
    panel.finishAnswer()
    // New button is now visible
    cb.onThreadChange.mockClear()
    q(root, '.newthread').click()
    expect(panel.getHistory()).toEqual([])
    expect(cb.onThreadChange).toHaveBeenCalledWith(true)
  })
})

describe('DockPanel — draft autosave', () => {
  it('typing into the composer fires onThreadChange(false) (debounced/draft save)', () => {
    const { cb, root } = makePanel()
    typeInto(composer(root), 'a')
    expect(cb.onThreadChange).toHaveBeenCalledWith(false)
  })
})

describe('DockPanel — pending review (batch) panel', () => {
  it('addReviewComment appends to review, clears the composer, shows the panel, persists', () => {
    const { panel, cb, root } = makePanel()
    typeInto(composer(root), 'this becomes a review comment')
    cb.onThreadChange.mockClear()
    panel.addReviewComment({ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'extract a constant' })
    expect(panel.getReview()).toEqual([
      { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'extract a constant' },
    ])
    expect(composer(root).value).toBe('') // moved into the pending review
    expect((q(root, '.review-panel') as HTMLElement).hidden).toBe(false)
    expect(q(root, '.review-count').textContent).toBe('1')
    expect(cb.onThreadChange).toHaveBeenCalledWith(true)
  })

  it('renders a multi-line anchor as path:start-end and single as path:line', () => {
    const { panel, root } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 10, startLine: 8, side: 'RIGHT', body: 'multi' })
    panel.addReviewComment({ path: 'b.ts', line: 20, side: 'RIGHT', body: 'single' })
    const wheres = [...q(root, '.review-list').querySelectorAll('.rc-where')].map((e) => e.textContent)
    expect(wheres).toEqual(['a.ts:8-10', 'b.ts:20'])
  })

  it('removeReviewComment by index removes that one and re-renders', () => {
    const { panel } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    panel.addReviewComment({ path: 'b.ts', line: 2, side: 'RIGHT', body: 'two' })
    panel.removeReviewComment(0)
    expect(panel.getReview()).toEqual([{ path: 'b.ts', line: 2, side: 'RIGHT', body: 'two' }])
  })

  it('removeReviewComment ignores out-of-range indices', () => {
    const { panel } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    panel.removeReviewComment(5)
    panel.removeReviewComment(-1)
    expect(panel.getReview().length).toBe(1)
  })

  it('clicking the rc-remove button removes the comment at its index', () => {
    const { panel, root } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    panel.addReviewComment({ path: 'b.ts', line: 2, side: 'RIGHT', body: 'two' })
    const removeBtns = q(root, '.review-list').querySelectorAll('.rc-remove')
    ;(removeBtns[0] as HTMLElement).click()
    expect(panel.getReview()).toEqual([{ path: 'b.ts', line: 2, side: 'RIGHT', body: 'two' }])
  })

  it('clearReview empties the list and hides the panel', () => {
    const { panel, root } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    panel.clearReview()
    expect(panel.getReview()).toEqual([])
    expect((q(root, '.review-panel') as HTMLElement).hidden).toBe(true)
  })

  it('clearReview is a no-op (no persist) when the review is already empty', () => {
    const { panel, cb } = makePanel()
    cb.onThreadChange.mockClear()
    panel.clearReview()
    expect(cb.onThreadChange).not.toHaveBeenCalled()
  })

  it('the Discard button clears the review', () => {
    const { panel, root } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    q(root, '.review-discard').click()
    expect(panel.getReview()).toEqual([])
  })

  it('getReview returns a defensive copy (mutating the result does not affect state)', () => {
    const { panel } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    const copy = panel.getReview()
    copy[0].body = 'mutated'
    copy.push({ path: 'z.ts', line: 9, side: 'RIGHT', body: 'added' })
    expect(panel.getReview()).toEqual([{ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' }])
  })

  it('Submit review button forwards the verdict + trimmed summary to onSubmitReview', () => {
    const { panel, cb, root } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    ;(q(root, 'select.verdict') as HTMLSelectElement).value = 'APPROVE'
    ;(q(root, '.review-summary') as HTMLTextAreaElement).value = '  ship it  '
    q(root, '.review-submit-btn').click()
    expect(cb.onSubmitReview).toHaveBeenCalledWith('APPROVE', 'ship it')
  })
})

describe('DockPanel — renderComments / renderLabels / renderLenses', () => {
  it('renderComments builds a chip button per canned comment, click -> onInsertComment(body)', () => {
    const { panel, cb, root } = makePanel()
    panel.renderComments([
      { label: 'Nit', body: 'Nit: ' },
      { label: 'LGTM', body: 'LGTM 👍' },
    ])
    const chips = q(root, '.tray-chips').querySelectorAll('.chip-btn')
    expect(chips.length).toBe(2)
    expect(chips[0].textContent).toBe('Nit')
    ;(chips[1] as HTMLElement).click()
    expect(cb.onInsertComment).toHaveBeenCalledWith('LGTM 👍')
  })

  it('renderLabels populates the decoration select + label chips; click -> onApplyLabel', () => {
    const { panel, cb, root } = makePanel()
    panel.renderLabels(
      [
        { label: 'Praise', value: 'praise' },
        { label: 'Issue', value: 'issue' },
      ],
      ['', 'blocking'],
    )
    const decoSelect = q(root, '.decoration') as HTMLSelectElement
    const opts = [...decoSelect.querySelectorAll('option')]
    expect(opts.map((o) => o.value)).toEqual(['', 'blocking'])
    expect(opts[0].textContent).toBe('no decoration') // '' rendered as "no decoration"
    decoSelect.value = 'blocking'
    const chips = q(root, '.label-chips').querySelectorAll('.chip-btn')
    expect(chips.length).toBe(2)
    ;(chips[1] as HTMLElement).click()
    expect(cb.onApplyLabel).toHaveBeenCalledWith({ label: 'Issue', value: 'issue' }, 'blocking')
  })

  it('renderLenses labels the general lens "General" and others "<label> lens"', () => {
    const { panel, root } = makePanel()
    panel.renderLenses([
      { id: 'general', label: 'General' },
      { id: 'security', label: 'Security' },
    ])
    const opts = [...(q(root, 'select.lens') as HTMLSelectElement).querySelectorAll('option')]
    expect(opts.map((o) => o.value)).toEqual(['general', 'security'])
    expect(opts.map((o) => o.textContent)).toEqual(['General', 'Security lens'])
  })

  it('re-rendering comments replaces the previous chips (no duplicate accumulation)', () => {
    const { panel, root } = makePanel()
    panel.renderComments([{ label: 'A', body: 'a' }])
    panel.renderComments([{ label: 'B', body: 'b' }])
    const chips = q(root, '.tray-chips').querySelectorAll('.chip-btn')
    expect(chips.length).toBe(1)
    expect(chips[0].textContent).toBe('B')
  })
})

describe('DockPanel — redaction notice', () => {
  it('shows a masked-secrets notice with the count when count > 0', () => {
    const { panel, root } = makePanel()
    panel.showRedactionNotice(3)
    const notice = q(root, '.redaction-notice') as HTMLElement
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toContain('Masked')
    expect(notice.textContent).toContain('3')
    expect(notice.textContent).toContain('secrets') // plural
  })

  it('uses the singular "secret" for a count of 1', () => {
    const { panel, root } = makePanel()
    panel.showRedactionNotice(1)
    const notice = q(root, '.redaction-notice') as HTMLElement
    expect(notice.textContent).toContain('1')
    expect(notice.textContent).toMatch(/secret\b/)
    expect(notice.textContent).not.toContain('secrets')
  })

  it('does nothing for a count of 0', () => {
    const { panel, root } = makePanel()
    panel.showRedactionNotice(0)
    expect((q(root, '.redaction-notice') as HTMLElement).hidden).toBe(true)
  })

  it('startAnswer clears a previously-shown redaction notice', () => {
    const { panel, root } = makePanel()
    panel.showRedactionNotice(2)
    panel.startAnswer('q')
    expect((q(root, '.redaction-notice') as HTMLElement).hidden).toBe(true)
  })
})

describe('DockPanel — flashTray', () => {
  it('shows a status message then clears it after the timeout', () => {
    vi.useFakeTimers()
    try {
      const { panel, root } = makePanel()
      panel.flashTray('Added to review (1)')
      const status = q(root, '.tray-status')
      expect(status.textContent).toContain('Added to review (1)')
      vi.advanceTimersByTime(2000)
      expect(status.textContent).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DockPanel — post lifecycle', () => {
  it('postDone renders a "Comment posted" row with a working view link and Undo/Refresh', () => {
    vi.useFakeTimers()
    try {
      const onUndo = vi.fn()
      const onRefresh = vi.fn()
      const { panel, root } = makePanel()
      panel.postDone('https://github.com/o/r/pull/1#discussion_r1', { onUndo, onRefresh })
      const row = q(root, '.answer .status-row.ok')
      expect(row).not.toBeNull()
      expect(row.textContent).toContain('Comment posted')
      expect(row.querySelector('a')!.getAttribute('href')).toBe(
        'https://github.com/o/r/pull/1#discussion_r1',
      )
      // Undo button wired
      ;(row.querySelector('.undo') as HTMLElement).click()
      expect(onUndo).toHaveBeenCalledTimes(1)
      // Refresh button wired
      ;(row.querySelector('.refresh') as HTMLElement).click()
      expect(onRefresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('postDone clears the composer draft and persists when there was text', () => {
    const { panel, cb, root } = makePanel()
    typeInto(composer(root), 'posted text')
    cb.onThreadChange.mockClear()
    panel.postDone('https://x', {})
    expect(composer(root).value).toBe('')
    expect(cb.onThreadChange).toHaveBeenCalledWith(true)
  })

  it('postDone removes the Undo button after the 10s window', () => {
    vi.useFakeTimers()
    try {
      const { panel, root } = makePanel()
      panel.postDone('https://x', { onUndo: vi.fn() })
      expect(q(root, '.answer .status-row.ok .undo')).not.toBeNull()
      vi.advanceTimersByTime(10_000)
      expect(q(root, '.answer .status-row.ok .undo')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('postDone omits Undo/Refresh buttons when no callbacks are given', () => {
    const { panel, root } = makePanel()
    panel.postDone('https://x', {})
    const row = q(root, '.answer .status-row.ok')
    expect(row.querySelector('.undo')).toBeNull()
    expect(row.querySelector('.refresh')).toBeNull()
  })

  it('postFailed shows the error via showError and re-enables Post', () => {
    const { panel, root } = makePanel()
    panel.postPending()
    expect((q(root, '.btn.post') as HTMLButtonElement).disabled).toBe(true)
    panel.postFailed('403 Forbidden')
    expect((q(root, '.btn.post') as HTMLButtonElement).disabled).toBe(false)
    expect(q(root, '.answer .status-row.error .msg').textContent).toBe('403 Forbidden')
  })

  it('postUndone restores the draft into the composer when given one', () => {
    const { panel, root } = makePanel()
    panel.postDone('https://x', { onUndo: vi.fn() })
    panel.postUndoing()
    panel.postUndone('the retracted text')
    expect(composer(root).value).toBe('the retracted text')
    expect(q(root, '.answer .status-row')!.textContent).toContain('retracted')
  })
})

describe('DockPanel — confirmPost gate', () => {
  it('shows the target, runs onConfirm on Confirm, and disables Post until resolved', () => {
    const { panel, root } = makePanel()
    const onConfirm = vi.fn()
    panel.confirmPost('src/a.ts:12', onConfirm)
    const status = q(root, '.post-status')
    expect(status.textContent).toContain('src/a.ts:12')
    expect((q(root, '.btn.post') as HTMLButtonElement).disabled).toBe(true)
    ;(status.querySelector('.mini.go') as HTMLElement).click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // confirm closes the prompt + re-enables Post
    expect((q(root, '.btn.post') as HTMLButtonElement).disabled).toBe(false)
    expect(q(root, '.post-status').textContent).toBe('')
  })

  it('Cancel backs out without calling onConfirm and re-enables Post', () => {
    const { panel, root } = makePanel()
    const onConfirm = vi.fn()
    panel.confirmPost('src/a.ts:12', onConfirm)
    const cancel = [...q(root, '.post-status').querySelectorAll('.mini')].find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLElement
    cancel.click()
    expect(onConfirm).not.toHaveBeenCalled()
    expect((q(root, '.btn.post') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('DockPanel — review submission lifecycle', () => {
  it('reviewSubmitted clears the pending review + summary and shows a success row', () => {
    const { panel, cb, root } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    ;(q(root, '.review-summary') as HTMLTextAreaElement).value = 'summary'
    cb.onThreadChange.mockClear()
    const onRefresh = vi.fn()
    panel.reviewSubmitted('https://github.com/o/r/pull/1#pullrequestreview-1', onRefresh)
    expect(panel.getReview()).toEqual([])
    expect((q(root, '.review-summary') as HTMLTextAreaElement).value).toBe('')
    const row = q(root, '.answer .status-row.ok')
    expect(row.textContent).toContain('Review submitted')
    expect(row.querySelector('a')!.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/1#pullrequestreview-1',
    )
    ;(row.querySelector('.refresh') as HTMLElement).click()
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(cb.onThreadChange).toHaveBeenCalledWith(true)
  })

  it('reviewFailed keeps the pending comments and shows the error message', () => {
    const { panel, root } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    panel.reviewSubmitting()
    panel.reviewFailed('422 Unprocessable')
    expect(panel.getReview().length).toBe(1) // kept for retry
    expect(q(root, '.review-status.error .msg').textContent).toBe('422 Unprocessable')
    expect((q(root, '.review-submit-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('confirmReview runs onConfirm on Confirm and is cancellable', () => {
    const { panel, root } = makePanel()
    const onConfirm = vi.fn()
    panel.confirmReview('Submit 2 comments · Approve', onConfirm)
    const status = q(root, '.review-status')
    expect(status.textContent).toContain('Submit 2 comments')
    expect((q(root, '.review-submit-btn') as HTMLButtonElement).disabled).toBe(true)
    ;(status.querySelector('.mini.go') as HTMLElement).click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect((q(root, '.review-submit-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('confirmReview Cancel backs out without calling onConfirm and re-enables Submit', () => {
    const { panel, root } = makePanel()
    const onConfirm = vi.fn()
    panel.confirmReview('Submit 1 comment · Comment', onConfirm)
    const cancel = [...q(root, '.review-status').querySelectorAll('.mini')].find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLElement
    cancel.click()
    expect(onConfirm).not.toHaveBeenCalled()
    expect((q(root, '.review-submit-btn') as HTMLButtonElement).disabled).toBe(false)
    // status row cleared back to neutral
    expect(q(root, '.review-status').textContent).toBe('')
  })

  it('reviewSubmitting shows a spinner + "Submitting…" and disables the Submit button', () => {
    const { panel, root } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    panel.reviewSubmitting()
    const status = q(root, '.review-status')
    expect(status.querySelector('.spinner')).not.toBeNull()
    expect(status.textContent).toContain('Submitting')
    expect((q(root, '.review-submit-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  it('reviewSubmitted with no onRefresh omits the Refresh button but keeps the view link', () => {
    const { panel, root } = makePanel()
    panel.addReviewComment({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    panel.reviewSubmitted('https://github.com/o/r/pull/1#pullrequestreview-9')
    const row = q(root, '.answer .status-row.ok')
    expect(row.querySelector('.refresh')).toBeNull()
    expect(row.querySelector('a')!.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/1#pullrequestreview-9',
    )
  })
})

// ── Coverage gaps the original suite missed: the two answer-action buttons
// ("Use as comment", "Copy") and the in-flight spinner states. These are wired
// UI controls with real logic (load rawAnswer into the composer, clipboard,
// flashTray, persist) and were entirely untested.
describe('DockPanel — answer actions (Use as comment / Copy)', () => {
  // jsdom doesn't implement Element.scrollIntoView; useAnswerAsComment calls it.
  // Stub it so the click handler runs to completion (real browsers have it).
  beforeEach(() => {
    if (!('scrollIntoView' in HTMLElement.prototype)) {
      ;(HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    }
  })

  it('Use as comment loads the RAW (markdown) answer into the composer, focuses it, and persists a draft', () => {
    const { panel, cb, root } = makePanel()
    panel.startAnswer('q')
    panel.appendText('Consider extracting **this** into a helper.')
    panel.finishAnswer()
    cb.onThreadChange.mockClear()
    // Composer starts empty after a finished answer.
    expect(composer(root).value).toBe('')
    q(root, '.use-answer').click()
    // The composer receives the raw markdown (not the rendered HTML / stripped text).
    expect(composer(root).value).toBe('Consider extracting **this** into a helper.')
    // Loading a draft is a (debounced) draft change, not an immediate commit.
    expect(cb.onThreadChange).toHaveBeenCalledWith(false)
  })

  it('Use as comment preserves multi-line answers verbatim', () => {
    const { panel, root } = makePanel()
    panel.startAnswer('q')
    panel.appendText('line one\nline two\nline three')
    panel.finishAnswer()
    q(root, '.use-answer').click()
    expect(composer(root).value).toBe('line one\nline two\nline three')
  })

  it('Use as comment is a no-op when there is no answer (composer stays untouched)', () => {
    const { panel, cb, root } = makePanel()
    typeInto(composer(root), 'pre-existing draft')
    cb.onThreadChange.mockClear()
    // No answer has streamed → rawAnswer is empty → nothing loaded, draft preserved.
    q(root, '.use-answer').click()
    expect(composer(root).value).toBe('pre-existing draft')
    expect(cb.onThreadChange).not.toHaveBeenCalled()
  })

  it('Use as comment operates on the RESTORED answer after restoreThread', () => {
    const { panel, root } = makePanel()
    panel.restoreThread({
      turns: [
        { role: 'user', content: 'old q', display: 'old q' },
        { role: 'assistant', content: 'restored raw answer' },
      ],
      draft: '',
      review: [],
    })
    q(root, '.use-answer').click()
    expect(composer(root).value).toBe('restored raw answer')
  })

  it('Copy writes the raw answer to the clipboard and flashes "Copied"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const original = (navigator as { clipboard?: unknown }).clipboard
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const { panel, root } = makePanel()
      panel.startAnswer('q')
      panel.appendText('copy me **raw**')
      panel.finishAnswer()
      q(root, '.copy-answer').click()
      expect(writeText).toHaveBeenCalledWith('copy me **raw**')
      // Let the resolved promise's .then run, then assert the success flash.
      await Promise.resolve()
      await Promise.resolve()
      expect(q(root, '.tray-status').textContent).toContain('Copied')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true })
    }
  })

  it('Copy flashes "Copy failed" when the clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    const original = (navigator as { clipboard?: unknown }).clipboard
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const { panel, root } = makePanel()
      panel.startAnswer('q')
      panel.appendText('copy me')
      panel.finishAnswer()
      q(root, '.copy-answer').click()
      await Promise.resolve()
      await Promise.resolve()
      expect(q(root, '.tray-status').textContent).toContain('Copy failed')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true })
    }
  })

  it('Copy is a no-op when there is no answer (clipboard never touched)', () => {
    const writeText = vi.fn()
    const original = (navigator as { clipboard?: unknown }).clipboard
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const { root } = makePanel()
      q(root, '.copy-answer').click()
      expect(writeText).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true })
    }
  })
})

describe('DockPanel — in-flight spinner states', () => {
  it('postPending shows a spinner + "Posting…" and disables Post', () => {
    const { panel, root } = makePanel()
    panel.postPending()
    const ps = q(root, '.post-status')
    expect(ps.querySelector('.spinner')).not.toBeNull()
    expect(ps.textContent).toContain('Posting')
    expect((q(root, '.btn.post') as HTMLButtonElement).disabled).toBe(true)
  })

  it('postUndoing replaces the posted row with a "Retracting…" spinner (cancels the undo timer)', () => {
    vi.useFakeTimers()
    try {
      const { panel, root } = makePanel()
      const onUndo = vi.fn()
      panel.postDone('https://x', { onUndo })
      panel.postUndoing()
      const row = q(root, '.answer .status-row.ok')
      expect(row.querySelector('.spinner')).not.toBeNull()
      expect(row.textContent).toContain('Retracting')
      // The 10s window timer was cleared, so advancing time must NOT throw / re-touch a gone button.
      vi.advanceTimersByTime(10_000)
      expect(row.querySelector('.undo')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('postUndone without a restore string clears the .ok row to a neutral retracted message and leaves the draft empty', () => {
    const { panel, root } = makePanel()
    panel.postDone('https://x', { onUndo: vi.fn() })
    panel.postUndoing()
    panel.postUndone() // no restoreDraft
    const row = q(root, '.answer .status-row')
    expect(row.classList.contains('ok')).toBe(false)
    expect(row.textContent).toContain('retracted')
    expect(composer(root).value).toBe('')
  })
})

describe('DockPanel — setSelection edge cases', () => {
  it('setSelection updates the chip label when called repeatedly', () => {
    const { panel, root } = makePanel()
    panel.setSelection('a.ts:1')
    expect(q(root, '.chip .label').textContent).toBe('a.ts:1')
    panel.setSelection('b.ts:2-5')
    expect(q(root, '.chip .label').textContent).toBe('b.ts:2-5')
    expect((q(root, '.chip') as HTMLElement).hidden).toBe(false)
  })

  it('setSelection("") hides the chip (empty string is falsy)', () => {
    const { panel, root } = makePanel()
    panel.setSelection('a.ts:1')
    panel.setSelection('')
    expect((q(root, '.chip') as HTMLElement).hidden).toBe(true)
  })
})
