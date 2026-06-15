// Regression suite for Provider A — the Anthropic API backend.
//
// The whole @anthropic-ai/sdk module is mocked: no real client is constructed and no
// network is touched. We feed a fake async-iterable of SDK stream events into the
// provider and assert it (a) yields text chunks in order, (b) ignores non-text events,
// (c) ends with `done`, (d) surfaces errors (APIError vs plain Error vs non-Error, plus
// abort = silence), and (e) reports availability purely from the stored API key.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AskRequest, Chunk } from '../../shared/types'

// ---- Mock @anthropic-ai/sdk ----------------------------------------------------------
//
// The provider imports the SDK's *default* export and constructs it with `new`, and also
// reads the static `Anthropic.APIError` for `instanceof` checks. So the mock's default
// must be a constructor that also carries an `APIError` class. Errors thrown by the fake
// stream are instances of *this same* class, so the provider's `instanceof` branch fires.

// vi.mock is hoisted above all module-level code, so anything its factory references must
// itself be hoisted. vi.hoisted lets us declare the mock's shared state and the APIError
// class up there too, while still binding them to names we can use in the tests below. We
// expose a single mutable `state` object so test bodies can swap the stream factory with a
// plain assignment (no setter ceremony) and the mocked client always reads the latest one.
const { MockAPIError, calls, state } = vi.hoisted(() => {
  /** Class used for the `instanceof Anthropic.APIError` branch. Mirrors the fields the
   *  provider reads: `.status` and `.message`. */
  class MockAPIError extends Error {
    status?: number
    constructor(status: number | undefined, message: string) {
      super(message)
      this.name = 'APIError'
      this.status = status
    }
  }

  /** Per-test recording of constructor args + stream calls. */
  const calls: {
    ctorOptions: unknown[]
    streamArgs: Array<{ params: any; options: any }>
  } = { ctorOptions: [], streamArgs: [] }

  /** Mutable: what `client.messages.stream(...)` returns this test. Set per-test. */
  const state: { streamFactory: (params: any, options: any) => AsyncIterable<any> } = {
    streamFactory: () => ({ async *[Symbol.asyncIterator]() {} }),
  }

  return { MockAPIError, calls, state }
})

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages: { stream: (params: any, options: any) => AsyncIterable<any> }
    constructor(options: unknown) {
      calls.ctorOptions.push(options)
      this.messages = {
        stream: (params: any, options: any) => {
          calls.streamArgs.push({ params, options })
          return state.streamFactory(params, options)
        },
      }
    }
    static APIError = MockAPIError
  }
  return { default: Anthropic }
})

// Import AFTER the mock is declared. (vi.mock is hoisted, so this is safe, but be explicit.)
import { AnthropicProvider } from './anthropic'

// ---- Helpers -------------------------------------------------------------------------

/** Build an async-iterable from a list of events, optionally throwing after N yields. */
function fakeStream(
  events: any[],
  opts: { throwAfter?: number; error?: unknown } = {},
): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      let i = 0
      for (const ev of events) {
        if (opts.throwAfter !== undefined && i === opts.throwAfter) {
          throw opts.error
        }
        yield ev
        i++
      }
      if (opts.throwAfter !== undefined && i === opts.throwAfter) {
        throw opts.error
      }
    },
  }
}

const textDelta = (text: string) => ({
  type: 'content_block_delta',
  delta: { type: 'text_delta', text },
})

/** Drain the provider's async-iterable into an array of chunks. */
async function collect(iter: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

/** Minimal valid AskRequest. */
function makeReq(overrides: Partial<AskRequest> = {}): AskRequest {
  return {
    question: 'What does this do?',
    context: { repo: 'owner/name', prNumber: 7 },
    ...overrides,
  }
}

/** Seed chrome.storage.local with settings (merged over defaults via getSettings). */
async function seedSettings(patch: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set({ settings: patch })
}

const provider = () => new AnthropicProvider()

beforeEach(() => {
  calls.ctorOptions = []
  calls.streamArgs = []
  // Default: an empty, immediately-completing stream. Tests override as needed.
  state.streamFactory = () => fakeStream([])
})

// ======================================================================================

describe('AnthropicProvider.id', () => {
  it('is the stable "anthropic-api" id', () => {
    expect(provider().id).toBe('anthropic-api')
  })
})

describe('AnthropicProvider.isAvailable', () => {
  it('is false when no key is stored (default settings)', async () => {
    expect(await provider().isAvailable()).toBe(false)
  })

  it('is false for an empty-string key', async () => {
    await seedSettings({ anthropicApiKey: '' })
    expect(await provider().isAvailable()).toBe(false)
  })

  it('is false for a whitespace-only key (trimmed)', async () => {
    await seedSettings({ anthropicApiKey: '   \t\n ' })
    expect(await provider().isAvailable()).toBe(false)
  })

  it('is true once a non-empty key is stored', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-123' })
    expect(await provider().isAvailable()).toBe(true)
  })

  it('treats a key with surrounding whitespace but real content as available', async () => {
    await seedSettings({ anthropicApiKey: '  sk-ant-xyz  ' })
    expect(await provider().isAvailable()).toBe(true)
  })
})

describe('AnthropicProvider.ask — missing key guard', () => {
  it('yields a single error chunk and never constructs a client when no key', async () => {
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([
      { type: 'error', message: 'No Anthropic API key set. Add one in the extension options.' },
    ])
    // Guard must short-circuit before touching the SDK.
    expect(calls.ctorOptions).toHaveLength(0)
    expect(calls.streamArgs).toHaveLength(0)
  })

  it('treats a whitespace-only key as missing', async () => {
    await seedSettings({ anthropicApiKey: '   ' })
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([
      { type: 'error', message: 'No Anthropic API key set. Add one in the extension options.' },
    ])
    expect(calls.ctorOptions).toHaveLength(0)
  })
})

describe('AnthropicProvider.ask — happy path streaming', () => {
  beforeEach(async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-key', model: 'claude-opus-4-8' })
  })

  it('yields text chunks in order, then a done chunk', async () => {
    state.streamFactory = () => fakeStream([textDelta('Hello'), textDelta(', '), textDelta('world')])
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ', ' },
      { type: 'text', delta: 'world' },
      { type: 'done' },
    ])
  })

  it('yields just done for an empty stream', async () => {
    state.streamFactory = () => fakeStream([])
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([{ type: 'done' }])
  })

  it('preserves empty-string text deltas (does not drop falsy text)', async () => {
    state.streamFactory = () => fakeStream([textDelta('a'), textDelta(''), textDelta('b')])
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: '' },
      { type: 'text', delta: 'b' },
      { type: 'done' },
    ])
  })
})

describe('AnthropicProvider.ask — ignores non-text events', () => {
  beforeEach(async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-key' })
  })

  it('ignores message_start / content_block_start / content_block_stop / message_stop', async () => {
    state.streamFactory = () =>
      fakeStream([
        { type: 'message_start', message: {} },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        textDelta('keep'),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([{ type: 'text', delta: 'keep' }, { type: 'done' }])
  })

  it('ignores thinking_delta and signature_delta on a content_block_delta', async () => {
    state.streamFactory = () =>
      fakeStream([
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
        textDelta('answer'),
      ])
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([{ type: 'text', delta: 'answer' }, { type: 'done' }])
  })

  it('ignores an input_json_delta (tool-use style) content_block_delta', async () => {
    state.streamFactory = () =>
      fakeStream([
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
        textDelta('text'),
      ])
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([{ type: 'text', delta: 'text' }, { type: 'done' }])
  })

  it('does not emit done-then-text — interleaved non-text never reorders output', async () => {
    state.streamFactory = () =>
      fakeStream([
        textDelta('1'),
        { type: 'message_delta', delta: {} },
        textDelta('2'),
        { type: 'ping' },
        textDelta('3'),
      ])
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([
      { type: 'text', delta: '1' },
      { type: 'text', delta: '2' },
      { type: 'text', delta: '3' },
      { type: 'done' },
    ])
  })
})

describe('AnthropicProvider.ask — error surfacing', () => {
  beforeEach(async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-key' })
  })

  it('formats an Anthropic.APIError with its status code', async () => {
    state.streamFactory = () =>
      fakeStream([textDelta('partial')], {
        throwAfter: 1,
        error: new MockAPIError(429, 'rate limited'),
      })
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    // The partial text streamed before the throw is preserved; then an error chunk (no done).
    expect(chunks).toEqual([
      { type: 'text', delta: 'partial' },
      { type: 'error', message: 'Anthropic API error 429: rate limited' },
    ])
  })

  it('omits the status segment when an APIError has no status', async () => {
    state.streamFactory = () =>
      fakeStream([], { throwAfter: 0, error: new MockAPIError(undefined, 'network glitch') })
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([
      { type: 'error', message: 'Anthropic API error: network glitch' },
    ])
  })

  it('treats status 0 as falsy and omits the status segment', async () => {
    state.streamFactory = () =>
      fakeStream([], { throwAfter: 0, error: new MockAPIError(0, 'zero status') })
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([{ type: 'error', message: 'Anthropic API error: zero status' }])
  })

  it('surfaces a plain Error by its message (no API-error prefix)', async () => {
    state.streamFactory = () =>
      fakeStream([], { throwAfter: 0, error: new Error('boom') })
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([{ type: 'error', message: 'boom' }])
  })

  it('stringifies a non-Error throw value', async () => {
    state.streamFactory = () =>
      fakeStream([], { throwAfter: 0, error: 'just a string' })
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([{ type: 'error', message: 'just a string' }])
  })

  it('surfaces an error thrown synchronously by messages.stream()', async () => {
    state.streamFactory = () => {
      throw new MockAPIError(500, 'server exploded')
    }
    const ac = new AbortController()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([
      { type: 'error', message: 'Anthropic API error 500: server exploded' },
    ])
  })
})

describe('AnthropicProvider.ask — abort handling', () => {
  beforeEach(async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-key' })
  })

  it('stays silent (no error chunk) when the error arrives and the signal is aborted', async () => {
    const ac = new AbortController()
    state.streamFactory = () =>
      fakeStream([textDelta('streamed')], {
        throwAfter: 1,
        // Simulate the SDK aborting: flag the signal, then throw an abort-ish error.
        error: (() => {
          ac.abort()
          return new Error('The operation was aborted')
        })(),
      })
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    // Partial text is delivered; the abort is swallowed (no error, no done).
    expect(chunks).toEqual([{ type: 'text', delta: 'streamed' }])
  })

  it('swallows even an APIError once the signal is aborted', async () => {
    const ac = new AbortController()
    state.streamFactory = () =>
      fakeStream([], {
        throwAfter: 0,
        error: (() => {
          ac.abort()
          return new MockAPIError(499, 'client closed request')
        })(),
      })
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([])
  })
})

describe('AnthropicProvider.ask — request wiring', () => {
  it('constructs the client with the stored key, browser flag, and direct-access header', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-wire', model: 'claude-opus-4-8' })
    const ac = new AbortController()
    await collect(provider().ask(makeReq(), ac.signal))
    expect(calls.ctorOptions).toHaveLength(1)
    expect(calls.ctorOptions[0]).toEqual({
      apiKey: 'sk-ant-wire',
      dangerouslyAllowBrowser: true,
      defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' },
    })
  })

  it('passes the stored model, max_tokens, adaptive thinking, system prompt, and the abort signal', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-wire', model: 'claude-sonnet-4-5' })
    const ac = new AbortController()
    await collect(provider().ask(makeReq(), ac.signal))
    expect(calls.streamArgs).toHaveLength(1)
    const { params, options } = calls.streamArgs[0]
    expect(params.model).toBe('claude-sonnet-4-5')
    expect(params.max_tokens).toBe(16000)
    expect(params.thinking).toEqual({ type: 'adaptive' })
    expect(typeof params.system).toBe('string')
    expect(params.system).toContain('expert code reviewer')
    expect(options).toEqual({ signal: ac.signal })
  })

  it('falls back to claude-opus-4-8 when the stored model is empty', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-wire', model: '' })
    const ac = new AbortController()
    await collect(provider().ask(makeReq(), ac.signal))
    expect(calls.streamArgs[0].params.model).toBe('claude-opus-4-8')
  })

  it('builds messages: prior history first, then the current user turn with built content', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-wire' })
    const ac = new AbortController()
    const req = makeReq({
      question: 'Is this safe?',
      context: { repo: 'octo/repo', prNumber: 42, file: 'src/x.ts', selectedCode: 'const a = 1' },
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    })
    await collect(provider().ask(req, ac.signal))
    const { params } = calls.streamArgs[0]
    expect(params.messages).toHaveLength(3)
    expect(params.messages[0]).toEqual({ role: 'user', content: 'first question' })
    expect(params.messages[1]).toEqual({ role: 'assistant', content: 'first answer' })
    // Last message is the live user turn; content is the assembled prompt (buildUserContent).
    expect(params.messages[2].role).toBe('user')
    expect(params.messages[2].content).toContain('Pull request: octo/repo #42')
    expect(params.messages[2].content).toContain('Question: Is this safe?')
    expect(params.messages[2].content).toContain('const a = 1')
  })

  it('builds a single user message when there is no history', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-wire' })
    const ac = new AbortController()
    await collect(provider().ask(makeReq(), ac.signal))
    const { params } = calls.streamArgs[0]
    expect(params.messages).toHaveLength(1)
    expect(params.messages[0].role).toBe('user')
  })

  it('does not include the raw API key anywhere in the stream params', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-SECRET', model: 'claude-opus-4-8' })
    const ac = new AbortController()
    await collect(provider().ask(makeReq(), ac.signal))
    expect(JSON.stringify(calls.streamArgs[0].params)).not.toContain('sk-ant-SECRET')
  })

  // --- tightening: gaps in the original suite -----------------------------------------

  it('threads every populated context field through buildUserContent into the user turn', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-wire' })
    const ac = new AbortController()
    const req = makeReq({
      question: 'Anything wrong here?',
      context: {
        repo: 'octo/repo',
        prNumber: 99,
        prTitle: 'Add caching layer',
        prBody: 'Speeds up reads.',
        file: 'src/cache.ts',
        lineRange: [10, 14],
        selectedCode: 'cache.set(k, v)',
        diffHunk: '@@ -1 +1 @@\n+cache.set(k, v)',
        language: 'ts',
      },
    })
    await collect(provider().ask(req, ac.signal))
    const content = calls.streamArgs[0].params.messages[0].content as string
    // Each field surfaces in the assembled prompt, in the labelled form buildUserContent emits.
    expect(content).toContain('Pull request: octo/repo #99')
    expect(content).toContain('PR title: Add caching layer')
    expect(content).toContain('PR description:\nSpeeds up reads.')
    expect(content).toContain('File: src/cache.ts')
    expect(content).toContain('Lines: 10-14')
    expect(content).toContain('```ts\ncache.set(k, v)\n```')
    expect(content).toContain('```diff\n@@ -1 +1 @@\n+cache.set(k, v)\n```')
    expect(content).toContain('Question: Anything wrong here?')
  })

  it('sends the exact system prompt (full text, not a substring), unaffected by the request', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-wire' })
    const ac = new AbortController()
    await collect(provider().ask(makeReq(), ac.signal))
    const system = calls.streamArgs[0].params.system as string
    // Single space-joined string; spot-check both ends and a mid clause to pin the whole text.
    expect(system.startsWith('You are an expert code reviewer assisting a human reviewer')).toBe(true)
    expect(system).toContain('grounded in the provided code and diff')
    expect(system.endsWith('rather than guessing.')).toBe(true)
    // It is one flat string with no embedded newlines (the lines are joined with spaces).
    expect(system).not.toContain('\n')
  })

  it('passes history turns through verbatim, including assistant content, before the live turn', async () => {
    await seedSettings({ anthropicApiKey: 'sk-ant-wire' })
    const ac = new AbortController()
    const req = makeReq({
      history: [
        { role: 'assistant', content: 'earlier note' },
        { role: 'user', content: 'follow up' },
      ],
    })
    await collect(provider().ask(req, ac.signal))
    const messages = calls.streamArgs[0].params.messages
    expect(messages).toHaveLength(3)
    // History is a fresh array (mapped), not the caller's reference.
    expect(messages[0]).toEqual({ role: 'assistant', content: 'earlier note' })
    expect(messages[0]).not.toBe(req.history![0])
    expect(messages[1]).toEqual({ role: 'user', content: 'follow up' })
    expect(messages[2].role).toBe('user')
  })

  it('still completes normally (stream called, done yielded) when the signal is pre-aborted', async () => {
    // The provider has no early-abort guard before constructing the client; it only checks
    // signal.aborted in the catch. A pre-aborted signal with a clean stream therefore runs
    // to completion. This documents that behavior so a future early-return is a deliberate change.
    await seedSettings({ anthropicApiKey: 'sk-ant-key' })
    state.streamFactory = () => fakeStream([textDelta('hi')])
    const ac = new AbortController()
    ac.abort()
    const chunks = await collect(provider().ask(makeReq(), ac.signal))
    expect(chunks).toEqual([{ type: 'text', delta: 'hi' }, { type: 'done' }])
    expect(calls.streamArgs).toHaveLength(1)
  })
})
