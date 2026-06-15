// Regression tests for the background service worker (the port router + one-shot GitHub
// message handler). The module registers two chrome listeners at import time:
//   * chrome.runtime.onConnect  -> per-port ASK/ABORT router (streams CHUNK/DONE/ERROR/META)
//   * chrome.runtime.onMessage  -> one-shot GH_* request/response handler
//
// We can't reach those listeners directly, so we capture the functions passed to
// addListener (the test/setup chrome stub makes those vi.fn()s), then drive them with a
// fake port / fake sendResponse. The provider registry and the github/api layer are mocked
// so we control what the router streams and what the GH handlers route to. redact is the
// REAL (pure) module so the secret-masking / META path is exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskRequest, Chunk } from '../shared/types'
import type {
  BackgroundToContent,
  ContentToBackground,
  GithubRequest,
  GithubResult,
  TestGapsResult,
  PrOverviewResult,
} from '../shared/messages'

// ---------------------------------------------------------------------------
// Mocks (hoisted by vitest). The registry mock exports a REAL NoProviderAvailableError
// subclass so the module's `err instanceof NoProviderAvailableError` branch is reachable.
// ---------------------------------------------------------------------------

const resolveMock = vi.fn()
const registerMock = vi.fn()

vi.mock('./providers/registry', () => {
  class NoProviderAvailableError extends Error {
    constructor(public readonly preferredId: string) {
      super('No AI provider is available. Add your Anthropic API key.')
      this.name = 'NoProviderAvailableError'
    }
  }
  return {
    NoProviderAvailableError,
    registry: { register: registerMock, resolve: resolveMock },
  }
})

// The concrete providers are constructed at import time and handed to registry.register;
// stub them so importing the module never touches the SDK / native host.
vi.mock('./providers/anthropic', () => ({
  AnthropicProvider: class {
    id = 'anthropic-api'
  },
}))
vi.mock('./providers/claudeCode', () => ({
  ClaudeCodeProvider: class {
    id = 'claude-code-cli'
  },
}))

// github/api: every function the worker calls. Defaults are set in beforeEach.
const getPullHeadSha = vi.fn()
const createReviewComment = vi.fn()
const deleteReviewComment = vi.fn()
const createReview = vi.fn()
const getDiffHunk = vi.fn()
const getPullMeta = vi.fn()
const getPrPatches = vi.fn()
const listPullFiles = vi.fn()
const testGaps = vi.fn()
const formatTestGapsReport = vi.fn()
const assembleOverview = vi.fn()
const formatOverviewReport = vi.fn()

vi.mock('./github/api', () => ({
  getPullHeadSha: (...a: unknown[]) => getPullHeadSha(...a),
  createReviewComment: (...a: unknown[]) => createReviewComment(...a),
  deleteReviewComment: (...a: unknown[]) => deleteReviewComment(...a),
  createReview: (...a: unknown[]) => createReview(...a),
  getDiffHunk: (...a: unknown[]) => getDiffHunk(...a),
  getPullMeta: (...a: unknown[]) => getPullMeta(...a),
  getPrPatches: (...a: unknown[]) => getPrPatches(...a),
  listPullFiles: (...a: unknown[]) => listPullFiles(...a),
  testGaps: (...a: unknown[]) => testGaps(...a),
  formatTestGapsReport: (...a: unknown[]) => formatTestGapsReport(...a),
  assembleOverview: (...a: unknown[]) => assembleOverview(...a),
  formatOverviewReport: (...a: unknown[]) => formatOverviewReport(...a),
}))

// ---------------------------------------------------------------------------
// Fake port: records everything posted back, lets us fire onMessage / onDisconnect.
// ---------------------------------------------------------------------------

interface FakePort {
  name: string
  posted: BackgroundToContent[]
  postMessage: (m: BackgroundToContent) => void
  onMessage: { addListener: (l: (m: ContentToBackground) => void) => void }
  onDisconnect: { addListener: (l: () => void) => void }
  /** Drive a content->background message into the registered listener. */
  fire: (m: ContentToBackground) => void
  /** Drive a disconnect into the registered listener. */
  disconnect: () => void
  /** When set, postMessage throws (simulates a closed port mid-stream). */
  throwOnPost?: boolean
}

function makePort(name: string): FakePort {
  let msgListener: ((m: ContentToBackground) => void) | undefined
  let disconnectListener: (() => void) | undefined
  const port: FakePort = {
    name,
    posted: [],
    postMessage(m) {
      if (port.throwOnPost) throw new Error('port closed')
      port.posted.push(m)
    },
    onMessage: {
      addListener(l) {
        msgListener = l
      },
    },
    onDisconnect: {
      addListener(l) {
        disconnectListener = l
      },
    },
    fire(m) {
      msgListener?.(m)
    },
    disconnect() {
      disconnectListener?.()
    },
  }
  return port
}

/** A provider whose ask() yields the given chunks, recording the signal it was handed. */
function fakeProvider(chunks: Chunk[] | (() => AsyncIterable<Chunk>)) {
  const seen: { req?: AskRequest; signal?: AbortSignal } = {}
  const provider = {
    id: 'anthropic-api',
    isAvailable: vi.fn(() => Promise.resolve(true)),
    ask: vi.fn((req: AskRequest, signal: AbortSignal) => {
      seen.req = req
      seen.signal = signal
      if (typeof chunks === 'function') return chunks()
      return (async function* () {
        for (const c of chunks) yield c
      })()
    }),
  }
  return { provider, seen }
}

/** Pull the listener captured by chrome.runtime.{onConnect|onMessage}.addListener. */
function connectListener(): (port: FakePort) => void {
  const calls = (chrome.runtime.onConnect.addListener as ReturnType<typeof vi.fn>).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as (port: FakePort) => void
}
function messageListener(): (
  m: GithubRequest,
  sender: unknown,
  sendResponse: (r: unknown) => void,
) => boolean | undefined {
  const calls = (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as never
}

/** Build an AskRequest with sensible defaults; override per-test. */
function askReq(over: Partial<AskRequest> = {}): AskRequest {
  const { context, ...rest } = over
  return {
    question: 'why?',
    ...rest,
    context: { repo: 'o/r', prNumber: 7, ...context },
  }
}

// flush microtasks so the async handleAsk / GH handlers settle.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

// ---------------------------------------------------------------------------

beforeEach(async () => {
  resolveMock.mockReset()
  registerMock.mockReset()
  getPullHeadSha.mockReset().mockResolvedValue('headsha123')
  createReviewComment.mockReset().mockResolvedValue({ id: 99, html_url: 'https://gh/c/99' })
  deleteReviewComment.mockReset().mockResolvedValue(undefined)
  createReview.mockReset().mockResolvedValue({ id: 5, html_url: 'https://gh/r/5' })
  getDiffHunk.mockReset().mockResolvedValue('@@ hunk @@')
  getPullMeta.mockReset().mockResolvedValue({ title: 'T', body: 'B' })
  getPrPatches
    .mockReset()
    .mockResolvedValue({ text: 'PATCH', included: 2, total: 2, additions: 4, deletions: 1 })
  listPullFiles.mockReset().mockResolvedValue([{ filename: 'a.ts' }])
  testGaps.mockReset().mockReturnValue({ gaps: [] })
  formatTestGapsReport.mockReset().mockReturnValue('GAPS-REPORT')
  assembleOverview.mockReset().mockReturnValue({ modules: [] })
  formatOverviewReport.mockReset().mockReturnValue('OVERVIEW-REPORT')

  // Import the module fresh each test so onConnect/onMessage register against THIS test's
  // chrome stub (test/setup re-creates chrome in its own beforeEach, which runs first).
  vi.resetModules()
  await import('./index')
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ===========================================================================
// Module wiring
// ===========================================================================

describe('module wiring', () => {
  it('registers both registered providers and both chrome listeners on import', () => {
    expect(registerMock).toHaveBeenCalledTimes(2)
    expect(chrome.runtime.onConnect.addListener).toHaveBeenCalledTimes(1)
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// ASK router (onConnect)
// ===========================================================================

describe('ASK router', () => {
  it('ignores ports whose name is not PORT_NAME', () => {
    const port = makePort('not-ycra')
    connectListener()(port)
    // No onMessage listener was attached, so firing an ASK does nothing.
    port.fire({ type: 'ASK', id: '1', request: askReq() })
    expect(port.posted).toEqual([])
  })

  it('streams text chunks as CHUNK and ends with DONE', async () => {
    const { provider } = fakeProvider([
      { type: 'text', delta: 'Hello ' },
      { type: 'text', delta: 'world' },
      { type: 'done' },
    ])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })

    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'req1', request: askReq({ context: { repo: 'o/r', prNumber: 7 } }) })
    await flush()

    expect(port.posted).toEqual([
      { type: 'CHUNK', id: 'req1', delta: 'Hello ' },
      { type: 'CHUNK', id: 'req1', delta: 'world' },
      { type: 'DONE', id: 'req1' },
    ])
  })

  it('relays a provider error chunk as ERROR (does not throw)', async () => {
    const { provider } = fakeProvider([{ type: 'error', message: 'rate limited' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })

    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'e1', request: askReq() })
    await flush()

    expect(port.posted).toContainEqual({ type: 'ERROR', id: 'e1', message: 'rate limited' })
  })

  it('reports registry.resolve() rejection (Error) as a single ERROR', async () => {
    resolveMock.mockRejectedValue(new Error('no key configured'))
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'x', request: askReq() })
    await flush()
    expect(port.posted).toEqual([{ type: 'ERROR', id: 'x', message: 'no key configured' }])
  })

  it('reports a thrown non-Error value via String()', async () => {
    resolveMock.mockRejectedValue('plain string boom')
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'x2', request: askReq() })
    await flush()
    expect(port.posted).toEqual([{ type: 'ERROR', id: 'x2', message: 'plain string boom' }])
  })

  it('passes the AbortController signal to the provider and forwards the request', async () => {
    const { provider, seen } = fakeProvider([{ type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    const port = makePort('ycra')
    connectListener()(port)
    const req = askReq({ question: 'explain', context: { repo: 'o/r', prNumber: 7 } })
    port.fire({ type: 'ASK', id: 's', request: req })
    await flush()
    expect(seen.signal).toBeInstanceOf(AbortSignal)
    expect(seen.signal!.aborted).toBe(false)
    expect(seen.req!.question).toBe('explain')
  })

  // --- secret masking / META ------------------------------------------------

  it('masks secrets in selectedCode and emits META with the count before chunks', async () => {
    const { provider, seen } = fakeProvider([{ type: 'text', delta: 'ok' }, { type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    const port = makePort('ycra')
    connectListener()(port)
    // A GitHub token (high-confidence pattern) inside the highlighted code.
    const secret = 'ghp_' + 'a'.repeat(40)
    port.fire({
      type: 'ASK',
      id: 'm',
      request: askReq({
        context: { repo: 'o/r', prNumber: 7, diffHunk: 'existing', selectedCode: `const t = "${secret}"` },
      }),
    })
    await flush()

    const meta = port.posted.find((m) => m.type === 'META')
    expect(meta).toEqual({ type: 'META', id: 'm', redactedSecrets: 1 })
    // META precedes the first CHUNK.
    const metaIdx = port.posted.findIndex((m) => m.type === 'META')
    const chunkIdx = port.posted.findIndex((m) => m.type === 'CHUNK')
    expect(metaIdx).toBeLessThan(chunkIdx)
    // The provider saw the masked text, not the raw secret.
    expect(seen.req!.context.selectedCode).not.toContain(secret)
    expect(seen.req!.context.selectedCode).toContain('[REDACTED]')
  })

  it('aggregates the masked count across selectedCode, diffHunk and prPatches', async () => {
    // One secret in each of the three code-bearing fields the worker scrubs (lines 113-123).
    // A regression that only counted one field would still pass the single-field test above,
    // so assert the SUM here. diffHunk is pre-set so enrichment leaves it untouched.
    const { provider, seen } = fakeProvider([{ type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    // Bare token literals (no `key =`/`token =` prefix) so each field yields exactly ONE
    // redact match — the point here is that index.ts SUMS across fields, not the redact arithmetic.
    const gh = 'ghp_' + 'a'.repeat(40)
    const ak = 'AKIA' + 'B'.repeat(16)
    const ant = 'sk-ant-' + 'c'.repeat(30)
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({
      type: 'ASK',
      id: 'agg',
      request: askReq({
        mode: 'summary',
        context: {
          repo: 'o/r',
          prNumber: 7,
          selectedCode: `usToken(${gh})`,
          diffHunk: `+ awsId ${ak}`,
        },
      }),
    })
    // summary mode packs getPrPatches().text (default 'PATCH') into prPatches; override to
    // carry the third secret so all three fields contribute to the count.
    getPrPatches.mockResolvedValueOnce({
      text: `anthropic ${ant}`,
      included: 1,
      total: 1,
      additions: 1,
      deletions: 0,
    })
    await flush()
    const meta = port.posted.find((m) => m.type === 'META') as
      | { type: 'META'; id: string; redactedSecrets: number }
      | undefined
    expect(meta).toBeDefined()
    expect(meta!.redactedSecrets).toBe(3)
    // And every field actually reached the provider masked, not just the count being right.
    expect(seen.req!.context.selectedCode).not.toContain(gh)
    expect(seen.req!.context.diffHunk).not.toContain(ak)
    expect(seen.req!.context.prPatches).not.toContain(ant)
    expect(seen.req!.context.diffHunk).toContain('[REDACTED]')
    expect(seen.req!.context.prPatches).toContain('[REDACTED]')
  })

  it('does not emit META when nothing was masked', async () => {
    const { provider } = fakeProvider([{ type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({
      type: 'ASK',
      id: 'n',
      request: askReq({ context: { repo: 'o/r', prNumber: 7, diffHunk: 'h', selectedCode: 'let x = 1' } }),
    })
    await flush()
    expect(port.posted.some((m) => m.type === 'META')).toBe(false)
  })

  // --- enrichment -----------------------------------------------------------

  it('ask mode enriches with diff hunk + PR meta when missing', async () => {
    const { provider, seen } = fakeProvider([{ type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    getDiffHunk.mockResolvedValue('@@ -1 +1 @@ real')
    getPullMeta.mockResolvedValue({ title: 'My PR', body: 'Body text' })
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({
      type: 'ASK',
      id: 'a',
      request: askReq({ context: { repo: 'o/r', prNumber: 7, file: 'a.ts', lineRange: [3, 5] } }),
    })
    await flush()
    expect(getDiffHunk).toHaveBeenCalledWith('o/r', 7, 'a.ts', 3)
    expect(getPullMeta).toHaveBeenCalledWith('o/r', 7)
    expect(seen.req!.context.diffHunk).toBe('@@ -1 +1 @@ real')
    expect(seen.req!.context.prTitle).toBe('My PR')
    expect(seen.req!.context.prBody).toBe('Body text')
  })

  it('ask mode swallows enrichment failures and still streams', async () => {
    const { provider } = fakeProvider([{ type: 'text', delta: 'still here' }, { type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    getDiffHunk.mockRejectedValue(new Error('rate limit'))
    getPullMeta.mockRejectedValue(new Error('private repo'))
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({
      type: 'ASK',
      id: 'a2',
      request: askReq({ context: { repo: 'o/r', prNumber: 7, file: 'a.ts', lineRange: [1, 1] } }),
    })
    await flush()
    expect(port.posted).toContainEqual({ type: 'CHUNK', id: 'a2', delta: 'still here' })
    expect(port.posted).toContainEqual({ type: 'DONE', id: 'a2' })
  })

  it('does not re-fetch diff hunk / meta when already present', async () => {
    const { provider } = fakeProvider([{ type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({
      type: 'ASK',
      id: 'a3',
      request: askReq({
        context: {
          repo: 'o/r',
          prNumber: 7,
          file: 'a.ts',
          lineRange: [1, 1],
          diffHunk: 'already',
          prTitle: 'set',
          prBody: 'set',
        },
      }),
    })
    await flush()
    expect(getDiffHunk).not.toHaveBeenCalled()
    expect(getPullMeta).not.toHaveBeenCalled()
  })

  // --- summary / review modes ----------------------------------------------

  it('summary mode fetches whole-PR patches and packs prPatches', async () => {
    const { provider, seen } = fakeProvider([{ type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    getPrPatches.mockResolvedValue({
      text: 'diff --git a b',
      included: 3,
      total: 3,
      additions: 10,
      deletions: 2,
    })
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'sum', request: askReq({ mode: 'summary' }) })
    await flush()
    expect(getPrPatches).toHaveBeenCalledWith('o/r', 7)
    // No diff-hunk enrichment in whole-PR mode.
    expect(getDiffHunk).not.toHaveBeenCalled()
    const patches = seen.req!.context.prPatches!
    expect(patches).toContain('3 changed files (+10 −2)')
    expect(patches).toContain('diff --git a b')
    // All files included -> no "omitted" tail.
    expect(patches).not.toContain('omitted for length')
  })

  it('summary mode appends an omission note when not all files fit', async () => {
    const { provider, seen } = fakeProvider([{ type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    getPrPatches.mockResolvedValue({
      text: 'partial diff',
      included: 2,
      total: 9,
      additions: 1,
      deletions: 0,
    })
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'sum2', request: askReq({ mode: 'review' }) })
    await flush()
    expect(seen.req!.context.prPatches).toContain('(2 of 9 changed files shown; the rest omitted for length.)')
  })

  it('summary mode with no changed files posts ERROR and never resolves a provider', async () => {
    getPrPatches.mockResolvedValue({ text: '', included: 0, total: 0, additions: 0, deletions: 0 })
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'empty', request: askReq({ mode: 'summary' }) })
    await flush()
    expect(port.posted).toEqual([
      { type: 'ERROR', id: 'empty', message: 'No changed files to review in this PR.' },
    ])
    expect(resolveMock).not.toHaveBeenCalled()
  })

  // --- abort ----------------------------------------------------------------

  it('ABORT before resolve cancels: provider is never invoked, nothing streamed', async () => {
    // resolve() stays pending across a macrotask so the ABORT lands while handleAsk is
    // suspended at `await registry.resolve()`. The post-resolve guard then short-circuits.
    const { provider } = fakeProvider([{ type: 'text', delta: 'never' }, { type: 'done' }])
    resolveMock.mockImplementation(
      () =>
        new Promise((res) =>
          setTimeout(() => res({ provider, preferredId: 'anthropic-api', usedFallback: false }), 5),
        ),
    )
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'ab', request: askReq() })
    // Abort while resolve() is still pending.
    port.fire({ type: 'ABORT', id: 'ab' })
    await new Promise((r) => setTimeout(r, 10))
    await flush()
    // Guard tripped: provider.ask never ran, nothing was streamed back.
    expect(provider.ask).not.toHaveBeenCalled()
    expect(port.posted).toEqual([])
  })

  it('ABORT for an unknown / already-finished id is a harmless no-op', async () => {
    // After a stream finishes, handleAsk's finally clears the controller from inFlight, so a
    // late ABORT hits the `?.` guard (inFlight.get(id) is undefined) and must not throw or post.
    const { provider } = fakeProvider([{ type: 'text', delta: 'done-stream' }, { type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'fin', request: askReq() })
    await flush()
    expect(port.posted).toContainEqual({ type: 'DONE', id: 'fin' })
    const before = port.posted.length
    // ABORT for the finished id and for one that never existed — both no-ops.
    expect(() => port.fire({ type: 'ABORT', id: 'fin' })).not.toThrow()
    expect(() => port.fire({ type: 'ABORT', id: 'never-seen' })).not.toThrow()
    await flush()
    expect(port.posted.length).toBe(before) // nothing new posted
  })

  it('ABORT mid-stream stops further chunks via the loop signal guard', async () => {
    // ask() captures the signal and pauses (await) between chunks so we can abort it.
    let captured: AbortSignal | undefined
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const provider = {
      id: 'anthropic-api',
      isAvailable: vi.fn(() => Promise.resolve(true)),
      ask: vi.fn((_req: AskRequest, signal: AbortSignal) => {
        captured = signal
        return (async function* () {
          yield { type: 'text', delta: 'first' } as Chunk
          await gate // suspend here until the test aborts + releases
          yield { type: 'text', delta: 'second' } as Chunk
          yield { type: 'done' } as Chunk
        })()
      }),
    }
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'mid', request: askReq() })
    await flush() // let the first chunk through
    expect(port.posted).toContainEqual({ type: 'CHUNK', id: 'mid', delta: 'first' })
    // Abort, then release the generator; the loop's `if (signal.aborted) break` should fire.
    port.fire({ type: 'ABORT', id: 'mid' })
    release!()
    await flush()
    await flush()
    expect(captured?.aborted).toBe(true)
    expect(port.posted.some((m) => m.delta === 'second')).toBe(false)
    expect(port.posted.some((m) => m.type === 'DONE')).toBe(false)
  })

  it('onDisconnect aborts in-flight requests (signal seen by the provider flips aborted)', async () => {
    let captured: AbortSignal | undefined
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const provider = {
      id: 'anthropic-api',
      isAvailable: vi.fn(() => Promise.resolve(true)),
      ask: vi.fn((_req: AskRequest, signal: AbortSignal) => {
        captured = signal
        return (async function* () {
          yield { type: 'text', delta: 'x' } as Chunk
          await gate
          yield { type: 'done' } as Chunk
        })()
      }),
    }
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    const port = makePort('ycra')
    connectListener()(port)
    port.fire({ type: 'ASK', id: 'd', request: askReq() })
    await flush() // provider.ask invoked, signal captured, first chunk streamed
    expect(captured).toBeInstanceOf(AbortSignal)
    expect(captured!.aborted).toBe(false)
    port.disconnect()
    release!()
    await flush()
    expect(captured!.aborted).toBe(true)
    expect(port.posted.some((m) => m.type === 'DONE')).toBe(false)
  })

  it('a postMessage that throws (closed port) does not crash the router', async () => {
    const { provider } = fakeProvider([{ type: 'text', delta: 'a' }, { type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    const port = makePort('ycra')
    port.throwOnPost = true
    connectListener()(port)
    // Should not throw out of fire().
    expect(() => port.fire({ type: 'ASK', id: 'p', request: askReq() })).not.toThrow()
    await flush()
    expect(port.posted).toEqual([]) // every post swallowed
  })

  it('two ports are isolated (one ASK does not post to the other)', async () => {
    const { provider } = fakeProvider([{ type: 'text', delta: 'hi' }, { type: 'done' }])
    resolveMock.mockResolvedValue({ provider, preferredId: 'anthropic-api', usedFallback: false })
    const listener = connectListener()
    const p1 = makePort('ycra')
    const p2 = makePort('ycra')
    listener(p1)
    listener(p2)
    p1.fire({ type: 'ASK', id: 'only1', request: askReq() })
    await flush()
    expect(p1.posted.length).toBeGreaterThan(0)
    expect(p2.posted).toEqual([])
  })
})

// ===========================================================================
// One-shot GitHub message handler (onMessage)
// ===========================================================================

describe('GitHub one-shot handler', () => {
  /** Invoke the message listener and capture the (async) sendResponse payload. */
  async function call(msg: GithubRequest): Promise<{ ret: unknown; response: unknown }> {
    const listener = messageListener()
    let response: unknown
    const sendResponse = (r: unknown) => {
      response = r
    }
    const ret = listener(msg, {}, sendResponse)
    await flush()
    return { ret, response }
  }

  it('GH_POST_COMMENT: fetches head sha, creates comment, returns url + id', async () => {
    const { ret, response } = await call({
      type: 'GH_POST_COMMENT',
      repo: 'o/r',
      prNumber: 7,
      body: 'nit',
      path: 'a.ts',
      line: 12,
      side: 'RIGHT',
    })
    expect(ret).toBe(true) // keeps the channel open
    expect(getPullHeadSha).toHaveBeenCalledWith('o/r', 7)
    expect(createReviewComment).toHaveBeenCalledWith('o/r', 7, {
      body: 'nit',
      commit_id: 'headsha123',
      path: 'a.ts',
      line: 12,
      side: 'RIGHT',
      start_line: undefined,
      start_side: undefined,
    })
    expect(response).toEqual({ ok: true, url: 'https://gh/c/99', commentId: 99 } satisfies GithubResult)
  })

  it('GH_POST_COMMENT: forwards multi-line anchor fields', async () => {
    await call({
      type: 'GH_POST_COMMENT',
      repo: 'o/r',
      prNumber: 7,
      body: 'span',
      path: 'a.ts',
      line: 20,
      side: 'RIGHT',
      startLine: 15,
      startSide: 'RIGHT',
    })
    expect(createReviewComment).toHaveBeenCalledWith(
      'o/r',
      7,
      expect.objectContaining({ start_line: 15, start_side: 'RIGHT', line: 20 }),
    )
  })

  it('GH_POST_COMMENT: surfaces an Error as { ok:false, error }', async () => {
    createReviewComment.mockRejectedValue(new Error('422 unprocessable'))
    const { response } = await call({
      type: 'GH_POST_COMMENT',
      repo: 'o/r',
      prNumber: 7,
      body: 'x',
      path: 'a.ts',
      line: 1,
      side: 'RIGHT',
    })
    expect(response).toEqual({ ok: false, error: '422 unprocessable' } satisfies GithubResult)
  })

  it('GH_POST_COMMENT: stringifies a non-Error rejection', async () => {
    getPullHeadSha.mockRejectedValue('sha boom')
    const { response } = await call({
      type: 'GH_POST_COMMENT',
      repo: 'o/r',
      prNumber: 7,
      body: 'x',
      path: 'a.ts',
      line: 1,
      side: 'RIGHT',
    })
    expect(response).toEqual({ ok: false, error: 'sha boom' })
    expect(createReviewComment).not.toHaveBeenCalled()
  })

  it('GH_DELETE_COMMENT: deletes and returns ok', async () => {
    const { ret, response } = await call({ type: 'GH_DELETE_COMMENT', repo: 'o/r', commentId: 99 })
    expect(ret).toBe(true)
    expect(deleteReviewComment).toHaveBeenCalledWith('o/r', 99)
    expect(response).toEqual({ ok: true } satisfies GithubResult)
  })

  it('GH_DELETE_COMMENT: surfaces failure', async () => {
    deleteReviewComment.mockRejectedValue(new Error('404'))
    const { response } = await call({ type: 'GH_DELETE_COMMENT', repo: 'o/r', commentId: 1 })
    expect(response).toEqual({ ok: false, error: '404' })
  })

  it('GH_SUBMIT_REVIEW: maps draft comments to Reviews API shape with head sha', async () => {
    const { ret, response } = await call({
      type: 'GH_SUBMIT_REVIEW',
      repo: 'o/r',
      prNumber: 7,
      event: 'REQUEST_CHANGES',
      body: 'overall',
      comments: [
        { path: 'a.ts', body: 'fix', line: 3, side: 'RIGHT' },
        { path: 'b.ts', body: 'span', line: 9, side: 'RIGHT', startLine: 7, startSide: 'RIGHT' },
      ],
    })
    expect(ret).toBe(true)
    expect(createReview).toHaveBeenCalledWith('o/r', 7, {
      commit_id: 'headsha123',
      event: 'REQUEST_CHANGES',
      body: 'overall',
      comments: [
        { path: 'a.ts', body: 'fix', line: 3, side: 'RIGHT', start_line: undefined, start_side: undefined },
        { path: 'b.ts', body: 'span', line: 9, side: 'RIGHT', start_line: 7, start_side: 'RIGHT' },
      ],
    })
    expect(response).toEqual({ ok: true, url: 'https://gh/r/5' } satisfies GithubResult)
  })

  it('GH_SUBMIT_REVIEW: surfaces failure', async () => {
    createReview.mockRejectedValue(new Error('review failed'))
    const { response } = await call({
      type: 'GH_SUBMIT_REVIEW',
      repo: 'o/r',
      prNumber: 7,
      event: 'APPROVE',
      body: '',
      comments: [],
    })
    expect(response).toEqual({ ok: false, error: 'review failed' })
  })

  it('GH_TEST_GAPS: lists files, runs heuristic, returns formatted report', async () => {
    const files = [{ filename: 'src/x.ts' }]
    listPullFiles.mockResolvedValue(files)
    testGaps.mockReturnValue({ gaps: ['src/x.ts'] })
    formatTestGapsReport.mockReturnValue('# Gaps')
    const { ret, response } = await call({ type: 'GH_TEST_GAPS', repo: 'o/r', prNumber: 7 })
    expect(ret).toBe(true)
    expect(listPullFiles).toHaveBeenCalledWith('o/r', 7)
    expect(testGaps).toHaveBeenCalledWith(files)
    expect(formatTestGapsReport).toHaveBeenCalledWith({ gaps: ['src/x.ts'] })
    expect(response).toEqual({ ok: true, report: '# Gaps' } satisfies TestGapsResult)
  })

  it('GH_TEST_GAPS: surfaces failure', async () => {
    listPullFiles.mockRejectedValue(new Error('no PAT'))
    const { response } = await call({ type: 'GH_TEST_GAPS', repo: 'o/r', prNumber: 7 })
    expect(response).toEqual({ ok: false, error: 'no PAT' } satisfies TestGapsResult)
  })

  it('GH_PR_OVERVIEW: lists files, assembles + formats overview', async () => {
    const files = [{ filename: 'src/x.ts' }]
    listPullFiles.mockResolvedValue(files)
    assembleOverview.mockReturnValue({ modules: ['src'] })
    formatOverviewReport.mockReturnValue('# Overview')
    const { ret, response } = await call({ type: 'GH_PR_OVERVIEW', repo: 'o/r', prNumber: 7 })
    expect(ret).toBe(true)
    expect(assembleOverview).toHaveBeenCalledWith(files)
    expect(formatOverviewReport).toHaveBeenCalledWith({ modules: ['src'] })
    expect(response).toEqual({ ok: true, report: '# Overview' } satisfies PrOverviewResult)
  })

  it('GH_PR_OVERVIEW: surfaces failure', async () => {
    listPullFiles.mockRejectedValue(new Error('boom'))
    const { response } = await call({ type: 'GH_PR_OVERVIEW', repo: 'o/r', prNumber: 7 })
    expect(response).toEqual({ ok: false, error: 'boom' })
  })

  it('OPEN_HELP: opens the bundled help page and returns false (fire-and-forget)', async () => {
    const { ret } = await call({ type: 'OPEN_HELP' })
    expect(ret).toBe(false)
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-ext-id/src/help/help.html',
    })
  })

  it('ignores an unknown message type (no response, returns undefined)', async () => {
    const { ret, response } = await call({ type: 'NOPE' } as unknown as GithubRequest)
    expect(ret).toBeUndefined()
    expect(response).toBeUndefined()
    expect(getPullHeadSha).not.toHaveBeenCalled()
  })

  it('tolerates a null/undefined message (optional-chained type check)', async () => {
    const listener = messageListener()
    expect(() => listener(null as unknown as GithubRequest, {}, () => {})).not.toThrow()
    expect(() => listener(undefined as unknown as GithubRequest, {}, () => {})).not.toThrow()
  })
})
