// Best-effort integration tests for the content-script entry point (src/content/index.ts).
//
// The module is a singleton driven entirely by side effects: importing it mounts the real
// DockPanel on a PR page and wires its callbacks to ask()/post()/guard logic. We drive it the
// way the user does — through the dock's real shadow-DOM controls — and assert on observable
// behaviour: the streamed answer text, error rows, GitHub message payloads, and the guard
// messages shown when there's no PR or no selection.
//
// Network/SDK never runs: chrome.runtime.connect returns a fake port we drive by hand, and
// chrome.runtime.sendMessage is a vi.fn() returning canned GithubResult/TestGapsResult shapes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PORT_NAME } from '../shared/messages'
import { DOCK_SELECTOR } from './dock/dock-panel'
import type { BackgroundToContent } from '../shared/messages'

// ── fake long-lived port (chrome.runtime.connect) ─────────────────────────────
interface FakePort {
  name: string
  postMessage: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  /** Push a background→content message to every registered onMessage listener. */
  emit: (msg: BackgroundToContent) => void
  /** Fire the onDisconnect listeners (simulates a lost connection). */
  drop: () => void
  disconnected: boolean
}

function makeFakePort(name: string): FakePort {
  const msgListeners = new Set<(m: BackgroundToContent) => void>()
  const discListeners = new Set<() => void>()
  const port: FakePort = {
    name,
    disconnected: false,
    postMessage: vi.fn(),
    disconnect: vi.fn(() => {
      port.disconnected = true
    }),
    emit: (msg) => msgListeners.forEach((l) => l(msg)),
    drop: () => discListeners.forEach((l) => l()),
  }
  // The shape the content script actually consumes.
  Object.assign(port, {
    onMessage: { addListener: (l: (m: BackgroundToContent) => void) => msgListeners.add(l) },
    onDisconnect: { addListener: (l: () => void) => discListeners.add(l) },
  })
  return port
}

/** All ports handed out by chrome.runtime.connect during a test. */
let ports: FakePort[] = []

function lastPort(): FakePort {
  expect(ports.length).toBeGreaterThan(0)
  return ports[ports.length - 1]
}

// ── DOM access into the mounted dock's shadow root ────────────────────────────
function dockRoot(): ShadowRoot {
  const host = document.querySelector(DOCK_SELECTOR) as HTMLElement | null
  expect(host).not.toBeNull()
  const root = host!.shadowRoot
  expect(root).not.toBeNull()
  return root!
}

function q<T extends Element>(sel: string): T {
  const el = dockRoot().querySelector(sel) as T | null
  expect(el, `selector ${sel}`).not.toBeNull()
  return el!
}

function answerText(): string {
  return q('.answer').textContent ?? ''
}

function answerHtml(): string {
  return (q('.answer') as HTMLElement).innerHTML
}

/** Type into the composer and click "Ask" — drives onSubmit → ask(). */
function ask(question: string): void {
  const input = q<HTMLTextAreaElement>('.composer textarea')
  input.value = question
  q<HTMLButtonElement>('.btn.ask').click()
}

// ── URL + module bootstrap ────────────────────────────────────────────────────
const PR_URL = 'https://github.com/octo/repo/pull/42'
const NON_PR_URL = 'https://github.com/octo/repo'

function setUrl(href: string): void {
  // jsdom keeps location and history in sync; replaceState updates location.pathname.
  const path = new URL(href).pathname
  window.history.replaceState({}, '', path)
}

/** Re-import the entry module fresh so its top-level syncToPr() mounts a new dock for the
 *  current URL. Returns nothing — the dock lives in document.body. */
async function bootContentScript(): Promise<void> {
  vi.resetModules()
  await import('./index')
}

beforeEach(() => {
  ports = []
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-ycra-loaded')
  delete (document.documentElement.dataset as Record<string, string>).ycraLoaded

  // chrome.runtime.connect → a fresh fake port, recorded for assertions.
  ;(globalThis as any).chrome.runtime.connect = vi.fn((info: { name: string }) => {
    const p = makeFakePort(info.name)
    ports.push(p)
    return p as unknown
  })
  // Default sendMessage: resolve to a benign ok result; individual tests override.
  ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() => Promise.resolve({ ok: true }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ASK streaming over the port', () => {
  it('opens a port named PORT_NAME and posts an ASK with the typed question + PR context', async () => {
    setUrl(PR_URL)
    await bootContentScript()

    // Without a selection, onSubmit short-circuits with a guard — give it a selection first.
    // We simulate the remembered diff selection via a selectionchange the module listens to.
    seedSelection({ file: 'src/a.ts', lineRange: [10, 12], selectedCode: 'const x = 1', anchor: { line: 12, side: 'RIGHT' } })

    ask('Why is this here?')

    const port = lastPort()
    expect(port.name).toBe(PORT_NAME)
    expect(port.postMessage).toHaveBeenCalledTimes(1)
    const sent = port.postMessage.mock.calls[0][0]
    expect(sent.type).toBe('ASK')
    expect(typeof sent.id).toBe('string')
    expect(sent.request.question).toBe('Why is this here?')
    expect(sent.request.context).toMatchObject({
      repo: 'octo/repo',
      prNumber: 42,
      file: 'src/a.ts',
      lineRange: [10, 12],
    })
    // selectedCode is the captured selection text (spans the selected rows).
    expect(sent.request.context.selectedCode).toContain('const x = 1')
    expect(sent.request.context.language).toBe('typescript')
  })

  it('CHUNK appends streamed text into the answer; multiple chunks accumulate', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('Explain')

    const port = lastPort()
    const id = port.postMessage.mock.calls[0][0].id

    port.emit({ type: 'CHUNK', id, delta: 'Hello ' })
    port.emit({ type: 'CHUNK', id, delta: 'world' })

    expect(answerText()).toContain('Hello world')
  })

  it('DONE finishes the answer (commits the turn, port disconnected, actions revealed)', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('Explain')

    const port = lastPort()
    const id = port.postMessage.mock.calls[0][0].id
    port.emit({ type: 'CHUNK', id, delta: 'Final answer.' })
    port.emit({ type: 'DONE', id })

    expect(port.disconnect).toHaveBeenCalledTimes(1)
    // The committed answer is still shown, and the "Use as comment" actions appear.
    expect(answerText()).toContain('Final answer.')
    expect((q('.answer-actions') as HTMLElement).hidden).toBe(false)
    // The question is committed as a finalized turn (the "You" question div).
    expect(q('.turn-q').textContent).toContain('Explain')
  })

  it('ERROR renders the error row and disconnects the port', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('Explain')

    const port = lastPort()
    const id = port.postMessage.mock.calls[0][0].id
    port.emit({ type: 'ERROR', id, message: 'rate limited' })

    expect(port.disconnect).toHaveBeenCalledTimes(1)
    expect(q('.status-row.error .msg').textContent).toBe('rate limited')
  })

  it('META shows the redaction notice before the first chunk', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('Explain')

    const port = lastPort()
    const id = port.postMessage.mock.calls[0][0].id
    port.emit({ type: 'META', id, redactedSecrets: 2 })

    const notice = q<HTMLElement>('.redaction-notice')
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toContain('2')
  })

  it('ignores messages whose id does not match the in-flight ask', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('Explain')

    const port = lastPort()
    port.emit({ type: 'CHUNK', id: 'some-other-id', delta: 'leak' })

    expect(answerText()).not.toContain('leak')
    // Still in the "Thinking…" state since nothing for our id arrived.
    expect(answerText()).toContain('Thinking')
  })

  it('a second ask opens a fresh port and threads history from the committed turn', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })

    ask('First question')
    const p1 = lastPort()
    const id1 = p1.postMessage.mock.calls[0][0].id
    p1.emit({ type: 'CHUNK', id: id1, delta: 'First answer.' })
    p1.emit({ type: 'DONE', id: id1 })

    // The selection is consumed by the DOM range; re-seed and ask again.
    seedSelection({ file: 'src/a.ts', lineRange: [2, 2], selectedCode: 'z', anchor: { line: 2, side: 'RIGHT' } })
    ask('Follow up')

    expect(ports).toHaveLength(2)
    const sent2 = lastPort().postMessage.mock.calls[0][0]
    expect(sent2.id).not.toBe(id1) // a fresh correlation id per ask
    // The first exchange is threaded as history (user + assistant turns, oldest first).
    expect(sent2.request.history).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer.' },
    ])
  })
})

describe('lost connection', () => {
  it('onDisconnect before a DONE/ERROR shows a "connection lost" error', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('Explain')

    lastPort().drop()

    expect(q('.status-row.error .msg').textContent).toMatch(/connection.*lost/i)
  })

  it('onDisconnect AFTER a DONE does NOT overwrite the answer with an error', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('Explain')

    const port = lastPort()
    const id = port.postMessage.mock.calls[0][0].id
    port.emit({ type: 'CHUNK', id, delta: 'all good' })
    port.emit({ type: 'DONE', id })
    port.drop() // settled — should be a no-op

    expect(dockRoot().querySelector('.status-row.error')).toBeNull()
    expect(answerText()).toContain('all good')
  })

  it('onDisconnect AFTER an ERROR does NOT replace the original error message', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('Explain')

    const port = lastPort()
    const id = port.postMessage.mock.calls[0][0].id
    port.emit({ type: 'ERROR', id, message: 'boom' })
    port.drop() // settled — must not swap the message to "connection lost"

    expect(q('.status-row.error .msg').textContent).toBe('boom')
  })
})

describe('guards: no PR page', () => {
  it('Ask on a non-PR page shows the "open a pull request" guard and opens no port', async () => {
    setUrl(NON_PR_URL)
    await bootContentScript()
    // On a non-PR page the dock is NOT mounted (syncToPr removes it), so there is no UI to
    // drive. Assert the dock is absent — the guard for ask is unreachable because the surface
    // is gone. This documents the real mount behaviour.
    expect(document.querySelector(DOCK_SELECTOR)).toBeNull()
    expect((globalThis as any).chrome.runtime.connect).not.toHaveBeenCalled()
  })

  it('navigating PR → non-PR tears down the dock; back to a PR remounts it', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    expect(document.querySelector(DOCK_SELECTOR)).not.toBeNull()

    setUrl(NON_PR_URL)
    window.dispatchEvent(new Event('popstate'))
    expect(document.querySelector(DOCK_SELECTOR)).toBeNull()

    setUrl(PR_URL)
    window.dispatchEvent(new Event('popstate'))
    expect(document.querySelector(DOCK_SELECTOR)).not.toBeNull()
  })
})

describe('guards: no selection', () => {
  it('Ask with no remembered diff selection shows the "select some code" guard, opens no port', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    // No seedSelection → lastSelection is null.
    ask('Why?')

    expect(q('.status-row.error .msg').textContent).toBe('Select some code in the diff first, then ask.')
    expect((globalThis as any).chrome.runtime.connect).not.toHaveBeenCalled()
  })

  it('Suggest with no selection shows the suggest-specific guard', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    q<HTMLButtonElement>('.btn.suggest').click()

    expect(q('.status-row.error .msg').textContent).toBe('Select the code to replace in the diff first.')
    expect((globalThis as any).chrome.runtime.connect).not.toHaveBeenCalled()
  })

  it('Post with no selection shows the "select a diff line" guard via postFailed', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'looks good'
    q<HTMLButtonElement>('.btn.post').click()

    expect(q('.status-row.error .msg').textContent).toBe('Select a diff line first.')
    expect((globalThis as any).chrome.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('Add-to-review with no selection flashes the tray and adds nothing', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'nit'
    q<HTMLButtonElement>('.btn.addreview').click()

    expect(q('.tray-status').textContent).toContain('Select a diff line first.')
    // The pending-review panel stays hidden (nothing was added).
    expect((q('.review-panel') as HTMLElement).hidden).toBe(true)
  })
})

describe('whole-PR asks need no selection', () => {
  it('Summarize opens a port with mode=summary and no file/selection context', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    q<HTMLButtonElement>('.btn.summarize').click()

    const sent = lastPort().postMessage.mock.calls[0][0]
    expect(sent.request.mode).toBe('summary')
    expect(sent.request.context).toMatchObject({ repo: 'octo/repo', prNumber: 42 })
    expect(sent.request.context.file).toBeUndefined()
  })

  it('Review opens a port with mode=review and the general lens instruction', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    q<HTMLButtonElement>('.btn.review').click()

    const sent = lastPort().postMessage.mock.calls[0][0]
    expect(sent.request.mode).toBe('review')
    expect(sent.request.question).toContain('Review this entire pull request')
  })

  it('Review through the Security lens appends the security scope clause', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    const lens = q<HTMLSelectElement>('select.lens')
    lens.value = 'security'
    q<HTMLButtonElement>('.btn.review').click()

    const sent = lastPort().postMessage.mock.calls[0][0]
    expect(sent.request.question.toLowerCase()).toContain('scope this review specifically to security')
    expect(sent.request.question).toContain('SSRF')
  })
})

describe('deterministic ops via sendMessage (no LLM)', () => {
  it('Test gaps renders the returned report and finishes the answer', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() =>
      Promise.resolve({ ok: true, report: 'No test gaps found.' }),
    )
    q<HTMLButtonElement>('.btn.testgaps').click()
    await flushMicrotasks()

    const sent = (globalThis as any).chrome.runtime.sendMessage.mock.calls[0][0]
    expect(sent).toMatchObject({ type: 'GH_TEST_GAPS', repo: 'octo/repo', prNumber: 42 })
    expect(answerText()).toContain('No test gaps found.')
  })

  it('Test gaps surfaces the background error when ok is false', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() =>
      Promise.resolve({ ok: false, error: 'could not read file list' }),
    )
    q<HTMLButtonElement>('.btn.testgaps').click()
    await flushMicrotasks()

    expect(q('.status-row.error .msg').textContent).toBe('could not read file list')
  })

  it('Overview sends GH_PR_OVERVIEW and shows a thrown error message', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() => Promise.reject(new Error('network down')))
    q<HTMLButtonElement>('.btn.overview').click()
    await flushMicrotasks()

    const sent = (globalThis as any).chrome.runtime.sendMessage.mock.calls[0][0]
    expect(sent.type).toBe('GH_PR_OVERVIEW')
    expect(q('.status-row.error .msg').textContent).toBe('network down')
  })

  it('Help sends an OPEN_HELP message to the background', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() => Promise.resolve(undefined))
    ;(dockRoot().querySelector('.help') as HTMLButtonElement).click()

    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OPEN_HELP' })
  })
})

describe('post comment confirm → write flow', () => {
  it('Post with a valid selection requires confirm, then sends GH_POST_COMMENT and shows the URL', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({
      file: 'src/a.ts',
      lineRange: [5, 5],
      selectedCode: 'const x = 1',
      anchor: { line: 5, side: 'RIGHT' },
    })
    ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() =>
      Promise.resolve({ ok: true, url: 'https://github.com/octo/repo/pull/42#discussion_r1', commentId: 99 }),
    )

    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'Please rename this.'
    q<HTMLButtonElement>('.btn.post').click()

    // Nothing is written until the reviewer confirms the public write.
    expect((globalThis as any).chrome.runtime.sendMessage).not.toHaveBeenCalled()
    const confirmBtn = q<HTMLButtonElement>('.post-status .mini.go')
    expect(q('.post-status .where').textContent).toContain('octo/repo')
    confirmBtn.click()
    await flushMicrotasks()

    const sent = (globalThis as any).chrome.runtime.sendMessage.mock.calls[0][0]
    expect(sent).toMatchObject({
      type: 'GH_POST_COMMENT',
      repo: 'octo/repo',
      prNumber: 42,
      body: 'Please rename this.',
      path: 'src/a.ts',
      line: 5,
      side: 'RIGHT',
    })
    expect(q('.status-row.ok a').getAttribute('href')).toBe(
      'https://github.com/octo/repo/pull/42#discussion_r1',
    )
  })

  it('Cancelling the confirm backs out without writing', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({
      file: 'src/a.ts',
      lineRange: [5, 5],
      selectedCode: 'x',
      anchor: { line: 5, side: 'RIGHT' },
    })
    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'hi'
    q<HTMLButtonElement>('.btn.post').click()

    // Click "Cancel" (the non-go mini button).
    const minis = dockRoot().querySelectorAll('.post-status .mini')
    const cancel = Array.from(minis).find((b) => !b.classList.contains('go')) as HTMLButtonElement
    cancel.click()

    expect((globalThis as any).chrome.runtime.sendMessage).not.toHaveBeenCalled()
    expect(dockRoot().querySelector('.post-status .mini')).toBeNull()
  })

  it('A failed post surfaces the error from the background result', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({
      file: 'src/a.ts',
      lineRange: [5, 5],
      selectedCode: 'x',
      anchor: { line: 5, side: 'RIGHT' },
    })
    ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() =>
      Promise.resolve({ ok: false, error: 'You are not a collaborator.' }),
    )
    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'comment'
    q<HTMLButtonElement>('.btn.post').click()
    q<HTMLButtonElement>('.post-status .mini.go').click()
    await flushMicrotasks()

    expect(q('.status-row.error .msg').textContent).toBe('You are not a collaborator.')
  })
})

describe('submit batch review', () => {
  it('Add-to-review then Submit (Approve) confirms and sends GH_SUBMIT_REVIEW', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({
      file: 'src/a.ts',
      lineRange: [3, 3],
      selectedCode: 'y',
      anchor: { line: 3, side: 'RIGHT' },
    })

    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'consider renaming'
    q<HTMLButtonElement>('.btn.addreview').click()

    // The pending-review panel becomes visible with one comment.
    expect((q('.review-panel') as HTMLElement).hidden).toBe(false)
    expect(q('.review-count').textContent).toBe('1')

    ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() =>
      Promise.resolve({ ok: true, url: 'https://github.com/octo/repo/pull/42#pullrequestreview-1' }),
    )
    // Approve needs no overall body.
    q<HTMLSelectElement>('select.verdict').value = 'APPROVE'
    q<HTMLButtonElement>('.review-submit-btn').click()
    // Confirm the public write.
    q<HTMLButtonElement>('.review-status .mini.go').click()
    await flushMicrotasks()

    const sent = (globalThis as any).chrome.runtime.sendMessage.mock.calls[0][0]
    expect(sent).toMatchObject({
      type: 'GH_SUBMIT_REVIEW',
      repo: 'octo/repo',
      prNumber: 42,
      event: 'APPROVE',
    })
    expect(sent.comments).toHaveLength(1)
    expect(sent.comments[0]).toMatchObject({ path: 'src/a.ts', line: 3, body: 'consider renaming' })
  })

  it('Submit with no pending comments shows the "add at least one comment" guard', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    // Review panel is hidden when empty; the submit button is still in the DOM though hidden.
    q<HTMLButtonElement>('.review-submit-btn').click()

    expect(q('.review-status.error').textContent).toContain('Add at least one comment')
    expect((globalThis as any).chrome.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('A COMMENT verdict with no overall summary is rejected before any write', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({
      file: 'src/a.ts',
      lineRange: [3, 3],
      selectedCode: 'y',
      anchor: { line: 3, side: 'RIGHT' },
    })
    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'a finding'
    q<HTMLButtonElement>('.btn.addreview').click()

    q<HTMLSelectElement>('select.verdict').value = 'COMMENT'
    // No summary typed.
    q<HTMLButtonElement>('.review-submit-btn').click()

    expect(q('.review-status.error').textContent).toMatch(/overall summary/i)
    expect((globalThis as any).chrome.runtime.sendMessage).not.toHaveBeenCalled()
  })
})

describe('selection chip', () => {
  it('a captured diff selection updates the header chip label', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({
      file: 'src/feature.ts',
      lineRange: [8, 12],
      selectedCode: 'block',
      anchor: { line: 12, side: 'RIGHT' },
    })

    const chip = q<HTMLElement>('.chip')
    expect(chip.hidden).toBe(false)
    expect(q('.chip .label').textContent).toBe('src/feature.ts :8-12')
  })
})

// ── ADVERSARIAL: gaps the original suite left open ─────────────────────────────
// The author's 30 tests only exercise single-line posts, never the Undo/delete
// write, and never assert META is cleared between asks. These close those holes.

describe('Suggest with a valid selection (happy-path payload)', () => {
  it('sends the suggestion instruction with the selection context, not the general ask', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [4, 6], selectedCode: 'old()', anchor: { line: 6, side: 'RIGHT' } })

    q<HTMLButtonElement>('.btn.suggest').click()

    const sent = lastPort().postMessage.mock.calls[0][0]
    expect(sent.type).toBe('ASK')
    // It is the dedicated suggestion instruction, not a free-form question.
    expect(sent.request.question).toContain('GitHub suggestion block')
    expect(sent.request.question).toContain('suggestion')
    // Selection context still rides along (file + range), and there is no whole-PR mode.
    expect(sent.request.context).toMatchObject({ repo: 'octo/repo', prNumber: 42, file: 'src/a.ts', lineRange: [4, 6] })
    expect(sent.request.mode).toBeUndefined()
  })
})

describe('multi-line post anchor (startLine/startSide are wired through)', () => {
  it('a 5–8 selection posts startLine=5 line=8 and labels the range in the confirm', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    // Range spans two distinct lines → reviewTarget produces a startLine.
    seedSelection({ file: 'src/a.ts', lineRange: [5, 8], selectedCode: 'block', anchor: { line: 8, side: 'RIGHT' } })
    ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() =>
      Promise.resolve({ ok: true, url: 'https://github.com/octo/repo/pull/42#discussion_r2', commentId: 7 }),
    )

    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'spans the block'
    q<HTMLButtonElement>('.btn.post').click()

    // The confirm shows the multi-line range, not a single line.
    expect(q('.post-status .where').textContent).toContain('src/a.ts:5-8')
    q<HTMLButtonElement>('.post-status .mini.go').click()
    await flushMicrotasks()

    const sent = (globalThis as any).chrome.runtime.sendMessage.mock.calls[0][0]
    expect(sent).toMatchObject({
      type: 'GH_POST_COMMENT',
      path: 'src/a.ts',
      line: 8,
      side: 'RIGHT',
      startLine: 5,
      startSide: 'RIGHT',
    })
  })
})

describe('Undo a just-posted comment (the post-then-Undo window)', () => {
  it('Undo sends GH_DELETE_COMMENT with the returned id, then restores the retracted text', async () => {
    vi.useFakeTimers() // postDone arms a 10s timer; freeze it so the Undo button survives
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [5, 5], selectedCode: 'x', anchor: { line: 5, side: 'RIGHT' } })

    // First call posts (returns commentId 99); second call is the delete.
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, url: 'https://github.com/octo/repo/pull/42#discussion_r1', commentId: 99 })
      .mockResolvedValueOnce({ ok: true })
    ;(globalThis as any).chrome.runtime.sendMessage = send

    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'Please rename this.'
    q<HTMLButtonElement>('.btn.post').click()
    q<HTMLButtonElement>('.post-status .mini.go').click()
    await flushMicrotasks() // settle the post

    // The success row exposes an Undo button (within the 10s window).
    const undoBtn = q<HTMLButtonElement>('.status-row.ok .undo')
    undoBtn.click()
    await flushMicrotasks() // settle the delete

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toMatchObject({ type: 'GH_DELETE_COMMENT', repo: 'octo/repo', commentId: 99 })
    // The retracted text is restored to the composer so the reviewer can fix + re-post.
    expect(q<HTMLTextAreaElement>('.composer textarea').value).toBe('Please rename this.')
    // And the row reflects the retraction (no longer an "ok" posted row).
    expect(dockRoot().querySelector('.status-row.ok')).toBeNull()
  })

  it('a failed Undo surfaces the delete error and does not restore the draft silently', async () => {
    vi.useFakeTimers()
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [5, 5], selectedCode: 'x', anchor: { line: 5, side: 'RIGHT' } })

    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, url: 'https://x', commentId: 5 })
      .mockResolvedValueOnce({ ok: false, error: 'already deleted' })
    ;(globalThis as any).chrome.runtime.sendMessage = send

    const input = q<HTMLTextAreaElement>('.composer textarea')
    input.value = 'oops'
    q<HTMLButtonElement>('.btn.post').click()
    q<HTMLButtonElement>('.post-status .mini.go').click()
    await flushMicrotasks()

    q<HTMLButtonElement>('.status-row.ok .undo').click()
    await flushMicrotasks()

    expect(q('.status-row.error .msg').textContent).toBe('already deleted')
  })
})

describe('redaction notice lifecycle', () => {
  it('META shows the notice, and the NEXT ask clears it (per-turn, not sticky)', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('First')

    const p1 = lastPort()
    const id1 = p1.postMessage.mock.calls[0][0].id
    p1.emit({ type: 'META', id: id1, redactedSecrets: 3 })
    expect(q<HTMLElement>('.redaction-notice').hidden).toBe(false)
    p1.emit({ type: 'CHUNK', id: id1, delta: 'a' })
    p1.emit({ type: 'DONE', id: id1 })

    // A second ask with no META must not carry the previous turn's notice.
    seedSelection({ file: 'src/a.ts', lineRange: [2, 2], selectedCode: 'y', anchor: { line: 2, side: 'RIGHT' } })
    ask('Second')
    expect(q<HTMLElement>('.redaction-notice').hidden).toBe(true)
  })

  it('META with redactedSecrets=0 shows no notice', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    seedSelection({ file: 'src/a.ts', lineRange: [1, 1], selectedCode: 'x', anchor: { line: 1, side: 'RIGHT' } })
    ask('Explain')

    const port = lastPort()
    const id = port.postMessage.mock.calls[0][0].id
    port.emit({ type: 'META', id, redactedSecrets: 0 })

    expect(q<HTMLElement>('.redaction-notice').hidden).toBe(true)
  })
})

describe('Overview/TestGaps null-result fallthrough', () => {
  it('Overview with ok:true but no report shows the generic fallback error', async () => {
    setUrl(PR_URL)
    await bootContentScript()
    ;(globalThis as any).chrome.runtime.sendMessage = vi.fn(() => Promise.resolve({ ok: true }))
    q<HTMLButtonElement>('.btn.overview').click()
    await flushMicrotasks()

    expect(q('.status-row.error .msg').textContent).toBe('Could not read the PR file list.')
  })
})

// ── helpers that depend on the real selection capture path ─────────────────────

/** Microtask flush so awaited sendMessage promises settle before assertions. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Make the content script's document-wide `selectionchange` handler capture a known selection.
 * captureSelection() reads window.getSelection() + walks the DOM, so we build a minimal diff
 * row that matches its selectors, select its text, and fire selectionchange.
 *
 * The module remembers this as `lastSelection`, which Ask/Suggest/Post read.
 */
function seedSelection(opts: {
  file: string
  lineRange: [number, number]
  selectedCode: string
  anchor: { line: number; side: 'LEFT' | 'RIGHT' }
}): void {
  // Build a GitHub "/changes"-style diff grid the selection module understands:
  //  - aria-label="Diff for: <path>"  → file path
  //  - data-line-number + data-diff-side on cells → line/side
  const grid = document.createElement('div')
  grid.setAttribute('aria-label', `Diff for: ${opts.file}`)

  const makeRow = (line: number): HTMLElement => {
    const row = document.createElement('div')
    row.setAttribute('role', 'row')
    const gutter = document.createElement('span')
    gutter.setAttribute('data-line-number', String(line))
    gutter.setAttribute('data-diff-side', opts.anchor.side.toLowerCase())
    const code = document.createElement('span')
    code.className = 'code'
    code.textContent = opts.selectedCode
    row.append(gutter, code)
    return row
  }

  const startRow = makeRow(opts.lineRange[0])
  const endRow = makeRow(opts.lineRange[1])
  grid.append(startRow, endRow)
  document.body.appendChild(grid)

  const startText = startRow.querySelector('.code')!.firstChild!
  const endText = endRow.querySelector('.code')!.firstChild!

  const range = document.createRange()
  range.setStart(startText, 0)
  range.setEnd(endText, (endText.textContent ?? '').length)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)

  document.dispatchEvent(new Event('selectionchange'))
}
