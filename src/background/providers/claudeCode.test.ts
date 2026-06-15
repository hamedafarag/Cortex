// Regression suite for Provider B — the Claude Code CLI backend (claudeCode.ts).
//
// The provider sits on the *background* side of a `chrome.runtime.connectNative` port. The
// native host (native-host/reviewer-host.mjs) parses the raw `claude --output-format
// stream-json` events and translates them into the `HostToBackground` wire messages
// (`chunk` / `done` / `error`) that the provider consumes. To exercise the protocol the
// FOCUS describes end-to-end, the fake port here embeds a tiny faithful copy of that host
// translation (stream_event -> content_block_delta -> text_delta -> chunk; thinking_delta
// ignored; result.is_error -> error/done) AND can also push raw port messages directly.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ClaudeCodeProvider } from './claudeCode'
import { NATIVE_HOST_NAME, type HostToBackground } from '../../shared/messages'
import type { AskRequest, Chunk } from '../../shared/types'
import { chromeStore } from '../../../test/setup'

type Listener<T> = (arg: T) => void

/** A fake chrome.runtime.Port that records both ends of the native-messaging channel and lets
 *  tests drive the host -> background direction. */
class FakePort {
  readonly name = NATIVE_HOST_NAME
  readonly posted: unknown[] = []
  private msgListeners = new Set<Listener<HostToBackground>>()
  private disconnectListeners = new Set<Listener<chrome.runtime.Port>>()
  disconnected = false

  onMessage = {
    addListener: (l: Listener<HostToBackground>) => this.msgListeners.add(l),
    removeListener: (l: Listener<HostToBackground>) => this.msgListeners.delete(l),
  }
  onDisconnect = {
    addListener: (l: Listener<chrome.runtime.Port>) => this.disconnectListeners.add(l),
    removeListener: (l: Listener<chrome.runtime.Port>) => this.disconnectListeners.delete(l),
  }

  postMessage = vi.fn((msg: unknown) => {
    this.posted.push(msg)
  })

  disconnect = vi.fn(() => {
    this.disconnected = true
  })

  /** The `id` the provider correlated this ask with (from its `{ type: 'ask', id, ... }`). */
  get askId(): string {
    const ask = this.posted.find(
      (m): m is { type: string; id: string } =>
        !!m && typeof m === 'object' && (m as { type?: string }).type === 'ask',
    )
    return ask?.id ?? ''
  }

  /** Push an already-translated host->background message to every registered listener. */
  emit(msg: HostToBackground): void {
    for (const l of this.msgListeners) l(msg)
  }

  /** Simulate the host disconnecting. */
  fireDisconnect(): void {
    for (const l of this.disconnectListeners) l(this as unknown as chrome.runtime.Port)
  }

  // --- raw stream-json -> wire translation, mirroring reviewer-host.mjs ---

  /** Feed one raw `claude` stream-json event, translated exactly as the native host does. */
  feedRaw(evt: Record<string, unknown>): void {
    const id = this.askId
    const e = evt as {
      type?: string
      event?: { type?: string; delta?: { type?: string; text?: string } }
      is_error?: boolean
      result?: string
    }
    if (
      e.type === 'stream_event' &&
      e.event?.type === 'content_block_delta' &&
      e.event.delta?.type === 'text_delta'
    ) {
      this.emit({ type: 'chunk', id, delta: e.event.delta.text ?? '' })
    } else if (e.type === 'result' && e.is_error) {
      this.emit({ type: 'error', id, message: e.result || 'Claude reported an error.' })
    } else if (e.type === 'result') {
      this.emit({ type: 'done', id })
    }
    // any other event (e.g. thinking_delta, system init) is dropped — no port traffic
  }
}

/** Grant / deny the opt-in nativeMessaging permission the provider checks. The shared setup
 *  stub does NOT model chrome.permissions, so we install it here. */
function setNativeMessaging(granted: boolean | (() => Promise<boolean>)): void {
  const contains =
    typeof granted === 'function'
      ? vi.fn(granted)
      : vi.fn(async () => granted)
  ;(chrome as unknown as { permissions: { contains: typeof contains } }).permissions = {
    contains,
  }
}

const REQ: AskRequest = {
  question: 'What does this do?',
  context: { repo: 'octo/cat', prNumber: 7, file: 'src/a.ts', selectedCode: 'const x = 1' },
}

/** Drain an async iterable to an array. */
async function drain(it: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const c of it) out.push(c)
  return out
}

/** Flush microtasks until `cond` holds (or we give up). The provider's generator does several
 *  awaits (permission check, getSettings) before it connects + posts the 'ask' and parks on its
 *  `wake` promise, so we can't count hops — we spin until the side effect we need is visible. */
async function flushUntil(cond: () => boolean, max = 50): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) await Promise.resolve()
}

/** Install a FakePort as the value returned by connectNative and hand it to `driver` so the
 *  test can drive the host side while the provider's generator is consumed. Returns the
 *  collected chunks. */
async function runAsk(
  provider: ClaudeCodeProvider,
  driver: (port: FakePort) => void | Promise<void>,
  req: AskRequest = REQ,
): Promise<{ chunks: Chunk[]; port: FakePort }> {
  const port = new FakePort()
  ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(
    port as unknown as chrome.runtime.Port,
  )
  const ctrl = new AbortController()
  const iter = provider.ask(req, ctrl.signal)[Symbol.asyncIterator]()

  const chunks: Chunk[] = []
  // Pull the first value: the provider runs up to its first `await wake` (no chunks yet),
  // priming the port (connectNative + listeners + postMessage 'ask') and parking.
  const firstP = iter.next()
  // Wait until the 'ask' has actually been posted before driving the host side, so the
  // host's reply carries the correct correlation id.
  await flushUntil(() => port.askId !== '')

  await driver(port)

  let res = await firstP
  while (!res.done) {
    chunks.push(res.value)
    res = await iter.next()
  }
  return { chunks, port }
}

describe('ClaudeCodeProvider: identity', () => {
  it('reports the stable provider id', () => {
    expect(new ClaudeCodeProvider().id).toBe('claude-code-cli')
  })
})

describe('ClaudeCodeProvider.isAvailable', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('returns false immediately when nativeMessaging is not granted (never connects)', async () => {
    setNativeMessaging(false)
    const provider = new ClaudeCodeProvider()
    await expect(provider.isAvailable()).resolves.toBe(false)
    expect(chrome.runtime.connectNative).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('returns false if chrome.permissions.contains rejects', async () => {
    setNativeMessaging(async () => {
      throw new Error('boom')
    })
    const provider = new ClaudeCodeProvider()
    await expect(provider.isAvailable()).resolves.toBe(false)
    vi.useRealTimers()
  })

  it('returns false when connectNative throws synchronously (host binary absent)', async () => {
    setNativeMessaging(true)
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('no host')
    })
    const provider = new ClaudeCodeProvider()
    await expect(provider.isAvailable()).resolves.toBe(false)
    vi.useRealTimers()
  })

  it('returns false when the port disconnects before the probe timer (host not found)', async () => {
    setNativeMessaging(true)
    const port = new FakePort()
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(
      port as unknown as chrome.runtime.Port,
    )
    const provider = new ClaudeCodeProvider()
    const p = provider.isAvailable()
    // Drain the permission-check microtask so connect + listener registration have run.
    await flushUntil(() => (chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    port.fireDisconnect()
    await expect(p).resolves.toBe(false)
    // a disconnect resolves the probe; the timer never makes it "available"
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
  })

  it('returns true when the port survives the 250ms probe window', async () => {
    setNativeMessaging(true)
    const port = new FakePort()
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(
      port as unknown as chrome.runtime.Port,
    )
    const provider = new ClaudeCodeProvider()
    const p = provider.isAvailable()
    await flushUntil(() => (chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    await vi.advanceTimersByTimeAsync(250)
    await expect(p).resolves.toBe(true)
    expect(chrome.runtime.connectNative).toHaveBeenCalledWith(NATIVE_HOST_NAME)
    vi.useRealTimers()
  })

  it('does NOT resolve true before the 250ms window elapses', async () => {
    setNativeMessaging(true)
    const port = new FakePort()
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(
      port as unknown as chrome.runtime.Port,
    )
    const provider = new ClaudeCodeProvider()
    let settled: boolean | 'pending' = 'pending'
    const p = provider.isAvailable().then((v) => (settled = v))
    await flushUntil(() => (chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    await vi.advanceTimersByTimeAsync(249)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(settled).toBe(true)
    vi.useRealTimers()
  })

  it('disconnects the probe port once it decides the host is present', async () => {
    setNativeMessaging(true)
    const port = new FakePort()
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(
      port as unknown as chrome.runtime.Port,
    )
    const provider = new ClaudeCodeProvider()
    const p = provider.isAvailable()
    await flushUntil(() => (chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(port.disconnect).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('a disconnect after the probe already resolved true does not flip the result', async () => {
    setNativeMessaging(true)
    const port = new FakePort()
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(
      port as unknown as chrome.runtime.Port,
    )
    const provider = new ClaudeCodeProvider()
    const p = provider.isAvailable()
    await flushUntil(() => (chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    await vi.advanceTimersByTimeAsync(250)
    expect(await p).toBe(true)
    // late disconnect — settled guard must swallow it
    expect(() => port.fireDisconnect()).not.toThrow()
    vi.useRealTimers()
  })
})

describe('ClaudeCodeProvider.ask — permission gate', () => {
  it('yields a single permission error and never connects when nativeMessaging is absent', async () => {
    setNativeMessaging(false)
    const provider = new ClaudeCodeProvider()
    const chunks = await drain(provider.ask(REQ, new AbortController().signal))
    expect(chunks).toEqual([
      {
        type: 'error',
        message:
          'The Claude Code CLI backend is off. Enable it in the extension options — it needs ' +
          'the native-messaging permission, requested there.',
      },
    ])
    expect(chrome.runtime.connectNative).not.toHaveBeenCalled()
  })
})

describe('ClaudeCodeProvider.ask — connection', () => {
  beforeEach(() => setNativeMessaging(true))

  it('yields a host-missing error when connectNative throws', async () => {
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('no native host registered')
    })
    const provider = new ClaudeCodeProvider()
    const chunks = await drain(provider.ask(REQ, new AbortController().signal))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].type).toBe('error')
    expect((chunks[0] as { message: string }).message).toContain('native host is not installed')
  })

  it('posts an "ask" with a fresh uuid id, the request, and the configured model', async () => {
    chromeStore.set('settings', { provider: 'claude-code-cli', model: 'claude-sonnet-test' })
    const provider = new ClaudeCodeProvider()
    const { port } = await runAsk(provider, (p) => {
      p.feedRaw({ type: 'result', is_error: false })
    })
    const ask = port.posted[0] as { type: string; id: string; request: AskRequest; model: string }
    expect(ask.type).toBe('ask')
    expect(ask.request).toEqual(REQ)
    expect(ask.model).toBe('claude-sonnet-test')
    expect(ask.id).toMatch(/^[0-9a-f-]{36}$/i)
  })
})

describe('ClaudeCodeProvider.ask — stream-json protocol', () => {
  beforeEach(() => setNativeMessaging(true))

  it('translates text_delta events into text chunks in order, then done', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      p.feedRaw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      })
      p.feedRaw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ', world' } },
      })
      p.feedRaw({ type: 'result', is_error: false })
    })
    expect(chunks).toEqual([
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ', world' },
      { type: 'done' },
    ])
  })

  it('ignores thinking_delta events (no chunk emitted for them)', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      // a reasoning delta — must NOT surface as text
      p.feedRaw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', text: 'hmm…' } },
      })
      p.feedRaw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
      })
      p.feedRaw({ type: 'result', is_error: false })
    })
    expect(chunks).toEqual([{ type: 'text', delta: 'answer' }, { type: 'done' }])
  })

  it('ignores non-delta / non-result stream events (e.g. system init)', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      p.feedRaw({ type: 'system', subtype: 'init' } as unknown as Record<string, unknown>)
      p.feedRaw({
        type: 'stream_event',
        event: { type: 'message_start' },
      } as unknown as Record<string, unknown>)
      p.feedRaw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      })
      p.feedRaw({ type: 'result', is_error: false })
    })
    expect(chunks).toEqual([{ type: 'text', delta: 'ok' }, { type: 'done' }])
  })

  it('ends cleanly with just a successful result (empty answer)', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      p.feedRaw({ type: 'result', is_error: false })
    })
    expect(chunks).toEqual([{ type: 'done' }])
  })

  it('preserves empty-string text deltas as chunks', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      p.feedRaw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
      })
      p.feedRaw({ type: 'result', is_error: false })
    })
    expect(chunks).toEqual([{ type: 'text', delta: '' }, { type: 'done' }])
  })
})

describe('ClaudeCodeProvider.ask — error paths', () => {
  beforeEach(() => setNativeMessaging(true))

  it('surfaces an is_error result as an error chunk and stops', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      p.feedRaw({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } })
      p.feedRaw({ type: 'result', is_error: true, result: 'rate limit exceeded' })
    })
    expect(chunks).toEqual([
      { type: 'text', delta: 'partial' },
      { type: 'error', message: 'rate limit exceeded' },
    ])
  })

  it('passes a host "error" wire message straight through', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      p.emit({ type: 'error', id: p.askId, message: 'claude exited with code 1' })
    })
    expect(chunks).toEqual([{ type: 'error', message: 'claude exited with code 1' }])
  })

  it('stops consuming after the first terminal chunk (text after error is dropped)', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      p.emit({ type: 'error', id: p.askId, message: 'fatal' })
      // late traffic on the same id — generator has already returned
      p.feedRaw({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late' } } })
    })
    expect(chunks).toEqual([{ type: 'error', message: 'fatal' }])
  })
})

describe('ClaudeCodeProvider.ask — id correlation', () => {
  beforeEach(() => setNativeMessaging(true))

  it('ignores messages whose id does not match this ask', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      // wrong id — must be filtered out by the provider
      p.emit({ type: 'chunk', id: 'some-other-id', delta: 'leak' })
      p.emit({ type: 'error', id: 'some-other-id', message: 'not mine' })
      // correct id closes the stream
      p.feedRaw({ type: 'result', is_error: false })
    })
    expect(chunks).toEqual([{ type: 'done' }])
  })
})

describe('ClaudeCodeProvider.ask — disconnect', () => {
  beforeEach(() => setNativeMessaging(true))

  it('surfaces an error when the host disconnects before finishing (no lastError)', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      ;(chrome.runtime as { lastError?: { message: string } }).lastError = undefined
      p.fireDisconnect()
    })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].type).toBe('error')
    expect((chunks[0] as { message: string }).message).toContain('native host is not installed')
  })

  it('includes chrome.runtime.lastError detail in the disconnect error', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      ;(chrome.runtime as { lastError?: { message: string } }).lastError = {
        message: 'Native host has exited.',
      }
      p.fireDisconnect()
    })
    expect(chunks).toEqual([
      { type: 'error', message: 'Native host disconnected: Native host has exited.' },
    ])
    ;(chrome.runtime as { lastError?: { message: string } }).lastError = undefined
  })

  it('a disconnect AFTER a clean done does not emit a spurious error', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      p.feedRaw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done text' } },
      })
      p.feedRaw({ type: 'result', is_error: false })
      // host closes the pipe after finishing — `finished` is already true
      p.fireDisconnect()
    })
    expect(chunks).toEqual([{ type: 'text', delta: 'done text' }, { type: 'done' }])
  })
})

describe('ClaudeCodeProvider.ask — abort', () => {
  beforeEach(() => setNativeMessaging(true))

  it('on abort: posts an abort to the host, disconnects, and ends the stream with done', async () => {
    const provider = new ClaudeCodeProvider()
    const port = new FakePort()
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(
      port as unknown as chrome.runtime.Port,
    )
    const ctrl = new AbortController()
    const iter = provider.ask(REQ, ctrl.signal)[Symbol.asyncIterator]()
    const firstP = iter.next()
    await flushUntil(() => port.askId !== '')

    const askId = port.askId
    ctrl.abort()

    const chunks: Chunk[] = []
    let res = await firstP
    while (!res.done) {
      chunks.push(res.value)
      res = await iter.next()
    }

    expect(chunks).toEqual([{ type: 'done' }])
    // an abort message was posted to the host with the correlating id
    expect(port.posted).toContainEqual({ type: 'abort', id: askId })
    expect(port.disconnect).toHaveBeenCalled()
  })
})

describe('ClaudeCodeProvider.ask — cleanup', () => {
  beforeEach(() => setNativeMessaging(true))

  it('disconnects the port after a normal completion (finally block runs)', async () => {
    const provider = new ClaudeCodeProvider()
    const { port } = await runAsk(provider, (p) => {
      p.feedRaw({ type: 'result', is_error: false })
    })
    expect(port.disconnect).toHaveBeenCalled()
  })
})

// --- Tests added by the adversarial reviewer to close gaps in the original suite. ---
//
// Rationale: the original suite drives most of its protocol assertions through the
// FakePort.feedRaw() helper, which is a re-implementation of the NATIVE HOST's
// stream-json -> wire translation. The provider (claudeCode.ts) never sees a
// `stream_event`; it only handles already-translated `chunk` / `done` / `error` wire
// messages (lines 91-96). The tests below exercise the PROVIDER's own mapping and its
// buffer/abort/settings interactions directly, without leaning on the host-logic copy.

describe('ClaudeCodeProvider.ask — provider wire mapping (no host-translation copy)', () => {
  beforeEach(() => setNativeMessaging(true))

  it("maps host `chunk` wire messages straight to text chunks (the provider's own switch)", async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      // Drive the RAW wire protocol the provider actually consumes, not feedRaw().
      p.emit({ type: 'chunk', id: p.askId, delta: 'a' })
      p.emit({ type: 'chunk', id: p.askId, delta: 'b' })
      p.emit({ type: 'done', id: p.askId })
    })
    expect(chunks).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'b' },
      { type: 'done' },
    ])
  })

  it('drops a host `done` carrying a foreign id but honors the matching one', async () => {
    const provider = new ClaudeCodeProvider()
    const { chunks } = await runAsk(provider, (p) => {
      p.emit({ type: 'done', id: 'not-this-ask' })
      p.emit({ type: 'chunk', id: p.askId, delta: 'real' })
      p.emit({ type: 'done', id: p.askId })
    })
    expect(chunks).toEqual([{ type: 'text', delta: 'real' }, { type: 'done' }])
  })
})

describe('ClaudeCodeProvider.ask — settings model default', () => {
  beforeEach(() => setNativeMessaging(true))

  it('falls back to the DEFAULT_SETTINGS model when nothing is stored', async () => {
    // chromeStore is cleared before each test, so no 'settings' key exists.
    const provider = new ClaudeCodeProvider()
    const { port } = await runAsk(provider, (p) => {
      p.feedRaw({ type: 'result', is_error: false })
    })
    const ask = port.posted[0] as { type: string; model: string }
    expect(ask.type).toBe('ask')
    // getSettings() merges over DEFAULT_SETTINGS -> 'claude-opus-4-8'.
    expect(ask.model).toBe('claude-opus-4-8')
  })

  it('uses a partially-stored settings object, still defaulting the model if absent', async () => {
    // A settings blob that omits `model` entirely — the merge must supply the default.
    chromeStore.set('settings', { provider: 'claude-code-cli', anthropicApiKey: '' })
    const provider = new ClaudeCodeProvider()
    const { port } = await runAsk(provider, (p) => {
      p.feedRaw({ type: 'result', is_error: false })
    })
    expect((port.posted[0] as { model: string }).model).toBe('claude-opus-4-8')
  })
})

describe('ClaudeCodeProvider.ask — abort interactions', () => {
  beforeEach(() => setNativeMessaging(true))

  it('flushes already-buffered text chunks, THEN ends with a single done on abort', async () => {
    const provider = new ClaudeCodeProvider()
    const port = new FakePort()
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(
      port as unknown as chrome.runtime.Port,
    )
    const ctrl = new AbortController()
    const iter = provider.ask(REQ, ctrl.signal)[Symbol.asyncIterator]()
    const firstP = iter.next()
    await flushUntil(() => port.askId !== '')

    // Two text chunks land in the provider's buffer while it is parked, then we abort
    // before consuming them. The abort handler appends a `done`; the buffer-drain loop
    // must still surface the buffered text first.
    port.emit({ type: 'chunk', id: port.askId, delta: 'one' })
    port.emit({ type: 'chunk', id: port.askId, delta: 'two' })
    ctrl.abort()

    const chunks: Chunk[] = []
    let res = await firstP
    while (!res.done) {
      chunks.push(res.value)
      res = await iter.next()
    }

    expect(chunks).toEqual([
      { type: 'text', delta: 'one' },
      { type: 'text', delta: 'two' },
      { type: 'done' },
    ])
    expect(port.posted).toContainEqual({ type: 'abort', id: port.askId })
  })

  it('abort AFTER the stream already finished does not append a second done', async () => {
    const provider = new ClaudeCodeProvider()
    const port = new FakePort()
    ;(chrome.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(
      port as unknown as chrome.runtime.Port,
    )
    const ctrl = new AbortController()
    const iter = provider.ask(REQ, ctrl.signal)[Symbol.asyncIterator]()
    const firstP = iter.next()
    await flushUntil(() => port.askId !== '')

    port.emit({ type: 'done', id: port.askId })

    const chunks: Chunk[] = []
    let res = await firstP
    while (!res.done) {
      chunks.push(res.value)
      res = await iter.next()
    }
    // Generator has returned and removed its abort listener; a late abort is inert.
    expect(() => ctrl.abort()).not.toThrow()
    expect(chunks).toEqual([{ type: 'done' }])
    // No spurious 'abort' was posted after completion (listener already detached).
    expect(port.posted.filter((m) => (m as { type?: string }).type === 'abort')).toEqual([])
  })
})
