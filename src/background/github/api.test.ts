import { describe, it, expect, vi, beforeEach } from 'vitest'
import { chromeStore } from '../../../test/setup'
import {
  getPullHeadSha,
  getPullMeta,
  listPullFiles,
  getDiffHunk,
  assemblePatches,
  getPrPatches,
  isTestFile,
  testGaps,
  formatTestGapsReport,
  assembleOverview,
  formatOverviewReport,
  createReviewComment,
  deleteReviewComment,
  createReview,
  type PullFile,
} from './api'

// --- fetch stubbing -------------------------------------------------------------
//
// githubFetch reads the PAT from chrome.storage.local via getSettings(), then calls
// the real global fetch. We stub fetch with a Response-like object and assert on the
// request the client built. The chrome stub is reset by test/setup.ts before each test,
// so the PAT is empty unless we set it.

const STORAGE_KEY = 'settings'

/** Build a minimal Response-like object enough for githubFetch's needs. */
function makeRes(opts: {
  status?: number
  ok?: boolean
  body?: unknown
  /** When set, res.text() resolves to exactly this (overrides body serialization). */
  rawText?: string
}): Response {
  const status = opts.status ?? 200
  const ok = opts.ok ?? (status >= 200 && status < 300)
  const text =
    opts.rawText !== undefined
      ? opts.rawText
      : opts.body === undefined
        ? ''
        : typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body)
  return {
    status,
    ok,
    text: vi.fn(() => Promise.resolve(text)),
    json: vi.fn(() => Promise.resolve(JSON.parse(text))),
  } as unknown as Response
}

/** Install a fetch stub that returns `res` for every call; returns the mock. */
function stubFetch(res: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.resolve(res))
  ;(globalThis as { fetch?: unknown }).fetch = fn
  return fn
}

function setPat(pat: string): void {
  chromeStore.set(STORAGE_KEY, { githubPat: pat })
}

/** The init object fetch was called with (2nd arg). */
function lastInit(fn: ReturnType<typeof vi.fn>): RequestInit {
  return fn.mock.calls.at(-1)?.[1] as RequestInit
}

/** The URL fetch was called with (1st arg). */
function lastUrl(fn: ReturnType<typeof vi.fn>): string {
  return fn.mock.calls.at(-1)?.[0] as string
}

// Use a unique repo per test for anything that touches the module-level caches
// (pullMetaCache / filesCache), since those persist across tests in this module.
let repoCounter = 0
function freshRepo(): string {
  repoCounter += 1
  return `owner/repo-${repoCounter}-${Math.random().toString(36).slice(2)}`
}

beforeEach(() => {
  // setup.ts already reset chrome; make sure fetch is a fresh, obviously-failing stub
  // so a forgotten stub surfaces loudly rather than hitting the network.
  ;(globalThis as { fetch?: unknown }).fetch = vi.fn(() => {
    throw new Error('fetch not stubbed in this test')
  })
})

// =================================================================================
// Request shaping: URL, method, headers (PAT auth), version header
// =================================================================================

describe('githubFetch request shaping (via getPullHeadSha)', () => {
  it('hits api.github.com with the right path and default GET', async () => {
    const fetchMock = stubFetch(makeRes({ body: { head: { sha: 'abc123' } } }))
    const repo = freshRepo()
    await getPullHeadSha(repo, 42)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastUrl(fetchMock)).toBe(`https://api.github.com/repos/${repo}/pulls/42`)
    // No method passed -> fetch default GET (init has no method key).
    expect(lastInit(fetchMock).method).toBeUndefined()
  })

  it('always sends the GitHub Accept + API-version headers', async () => {
    const fetchMock = stubFetch(makeRes({ body: { head: { sha: 'x' } } }))
    await getPullHeadSha(freshRepo(), 1)
    const headers = lastInit(fetchMock).headers as Record<string, string>
    expect(headers.Accept).toBe('application/vnd.github+json')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
  })

  it('adds a Bearer Authorization header when a PAT is stored', async () => {
    setPat('ghp_secrettoken')
    const fetchMock = stubFetch(makeRes({ body: { head: { sha: 'x' } } }))
    await getPullHeadSha(freshRepo(), 1)
    const headers = lastInit(fetchMock).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer ghp_secrettoken')
  })

  it('omits the Authorization header entirely when no PAT is stored', async () => {
    const fetchMock = stubFetch(makeRes({ body: { head: { sha: 'x' } } }))
    await getPullHeadSha(freshRepo(), 1)
    const headers = lastInit(fetchMock).headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  it('merges caller-supplied headers but the base headers still apply', async () => {
    // createReviewComment passes a body but no custom headers; use it to confirm the
    // base headers are present on a POST too.
    setPat('ghp_x')
    const fetchMock = stubFetch(makeRes({ body: { id: 1, html_url: 'u' } }))
    await createReviewComment(freshRepo(), 7, {
      body: 'hi',
      commit_id: 'sha',
      path: 'a.ts',
      line: 3,
      side: 'RIGHT',
    })
    const headers = lastInit(fetchMock).headers as Record<string, string>
    expect(headers.Accept).toBe('application/vnd.github+json')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(headers.Authorization).toBe('Bearer ghp_x')
  })
})

// =================================================================================
// Error handling on non-2xx
// =================================================================================

describe('githubFetch error handling', () => {
  it('throws with status + GitHub json message', async () => {
    stubFetch(makeRes({ status: 422, body: { message: 'Validation Failed' } }))
    await expect(getPullHeadSha(freshRepo(), 1)).rejects.toThrow(
      'GitHub API 422: Validation Failed',
    )
  })

  it('falls back to raw text (truncated to 200 chars) when the body is not JSON', async () => {
    const long = 'E'.repeat(500)
    stubFetch(makeRes({ status: 500, rawText: long }))
    let err: Error | undefined
    try {
      await getPullHeadSha(freshRepo(), 1)
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message.startsWith('GitHub API 500: ')).toBe(true)
    // 'GitHub API 500: ' + 200 chars
    expect(err!.message).toBe(`GitHub API 500: ${'E'.repeat(200)}`)
  })

  it('appends an actionable hint on 401', async () => {
    stubFetch(makeRes({ status: 401, body: { message: 'Bad credentials' } }))
    await expect(getPullHeadSha(freshRepo(), 1)).rejects.toThrow(
      /no\/invalid token\. Add a PAT in Options\./,
    )
  })

  it('appends a permission hint on 403', async () => {
    stubFetch(makeRes({ status: 403, body: { message: 'Forbidden' } }))
    await expect(getPullHeadSha(freshRepo(), 1)).rejects.toThrow(
      /token lacks permission \(needs Pull requests: write\)\./,
    )
  })

  it('appends a not-found hint on 404', async () => {
    stubFetch(makeRes({ status: 404, body: { message: 'Not Found' } }))
    await expect(getPullHeadSha(freshRepo(), 1)).rejects.toThrow(/repo\/PR not found/)
  })

  it('uses a plain status message when there is no body at all', async () => {
    stubFetch(makeRes({ status: 500, rawText: '' }))
    await expect(getPullHeadSha(freshRepo(), 1)).rejects.toThrow(/^GitHub API 500$/)
  })

  // Gap (adversarial): the json-parses-but-has-no-`message` branch. JSON.parse succeeds,
  // so the raw-text fallback is bypassed; `json.message` is falsy, so nothing is appended.
  // Net: a plain `GitHub API <status>`, NOT the raw JSON text. (Branch at api.ts:22-28.)
  it('emits a plain status when the body is valid JSON without a message field', async () => {
    stubFetch(makeRes({ status: 500, body: { documentation_url: 'http://x', errors: [] } }))
    await expect(getPullHeadSha(freshRepo(), 1)).rejects.toThrow(/^GitHub API 500$/)
  })

  it('treats an empty-string json message as no message (plain status, no trailing colon)', async () => {
    stubFetch(makeRes({ status: 422, body: { message: '' } }))
    let err: Error | undefined
    try {
      await getPullHeadSha(freshRepo(), 1)
    } catch (e) {
      err = e as Error
    }
    // The empty message is falsy -> not appended. Must be exactly the status, no "422: ".
    expect(err!.message).toBe('GitHub API 422')
  })

  it('does not append actionable hints for ordinary statuses (e.g. 500)', async () => {
    stubFetch(makeRes({ status: 500, body: { message: 'Server Error' } }))
    let err: Error | undefined
    try {
      await getPullHeadSha(freshRepo(), 1)
    } catch (e) {
      err = e as Error
    }
    expect(err!.message).toBe('GitHub API 500: Server Error')
    expect(err!.message).not.toMatch(/Options|permission|not found/)
  })

  it('tolerates res.text() rejecting (catch -> empty string)', async () => {
    const res = {
      status: 500,
      ok: false,
      text: vi.fn(() => Promise.reject(new Error('boom'))),
      json: vi.fn(),
    } as unknown as Response
    stubFetch(res)
    await expect(getPullHeadSha(freshRepo(), 1)).rejects.toThrow(/^GitHub API 500$/)
  })
})

// =================================================================================
// getPullHeadSha
// =================================================================================

describe('getPullHeadSha', () => {
  it('returns the head sha from the PR payload', async () => {
    stubFetch(makeRes({ body: { head: { sha: 'deadbeef' } } }))
    await expect(getPullHeadSha(freshRepo(), 99)).resolves.toBe('deadbeef')
  })

  it('throws a friendly error when head.sha is missing', async () => {
    stubFetch(makeRes({ body: { head: {} } }))
    await expect(getPullHeadSha(freshRepo(), 99)).rejects.toThrow(
      'Could not read the PR head commit.',
    )
  })

  it('throws when there is no head object at all', async () => {
    stubFetch(makeRes({ body: {} }))
    await expect(getPullHeadSha(freshRepo(), 99)).rejects.toThrow(
      'Could not read the PR head commit.',
    )
  })
})

// =================================================================================
// getPullMeta (title/body, truncation, caching)
// =================================================================================

describe('getPullMeta', () => {
  it('returns title and body verbatim when short', async () => {
    stubFetch(makeRes({ body: { title: 'My PR', body: 'Short body' } }))
    const meta = await getPullMeta(freshRepo(), 1)
    expect(meta).toEqual({ title: 'My PR', body: 'Short body' })
  })

  it('coerces a null body to an empty string', async () => {
    stubFetch(makeRes({ body: { title: 'T', body: null } }))
    const meta = await getPullMeta(freshRepo(), 1)
    expect(meta.body).toBe('')
  })

  it('coerces a missing title to an empty string', async () => {
    stubFetch(makeRes({ body: { body: 'b' } }))
    const meta = await getPullMeta(freshRepo(), 1)
    expect(meta.title).toBe('')
  })

  it('truncates a body longer than 4000 chars and appends the marker', async () => {
    const body = 'x'.repeat(5000)
    stubFetch(makeRes({ body: { title: 'T', body } }))
    const meta = await getPullMeta(freshRepo(), 1)
    expect(meta.body).toBe(`${'x'.repeat(4000)}\n… (description truncated)`)
  })

  it('does not truncate a body of exactly 4000 chars', async () => {
    const body = 'y'.repeat(4000)
    stubFetch(makeRes({ body: { title: 'T', body } }))
    const meta = await getPullMeta(freshRepo(), 1)
    expect(meta.body).toBe(body)
  })

  it('caches within the TTL: a second call does not re-fetch', async () => {
    const repo = freshRepo()
    const fetchMock = stubFetch(makeRes({ body: { title: 'First', body: 'b' } }))
    const first = await getPullMeta(repo, 5)
    // Swap the stub so a re-fetch would be observable.
    stubFetch(makeRes({ body: { title: 'Second', body: 'b2' } }))
    const second = await getPullMeta(repo, 5)
    expect(second).toEqual(first)
    expect(second.title).toBe('First')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches per repo#prNumber key (different PR re-fetches)', async () => {
    const repo = freshRepo()
    stubFetch(makeRes({ body: { title: 'PR-A', body: 'a' } }))
    const a = await getPullMeta(repo, 10)
    stubFetch(makeRes({ body: { title: 'PR-B', body: 'b' } }))
    const b = await getPullMeta(repo, 11)
    expect(a.title).toBe('PR-A')
    expect(b.title).toBe('PR-B')
  })

  // Gap (adversarial): the existing suite only proves the cache HIT (TTL not yet elapsed).
  // It never proves the entry EXPIRES — a cache that never invalidates would also pass the
  // hit test. Cross the 60s TTL boundary with fake timers and assert a re-fetch + fresh data.
  it('re-fetches after the 60s TTL elapses (cache expiry)', async () => {
    vi.useFakeTimers()
    try {
      const repo = freshRepo()
      const firstMock = stubFetch(makeRes({ body: { title: 'Stale', body: 'old' } }))
      const first = await getPullMeta(repo, 5)
      expect(first.title).toBe('Stale')
      // Just before the TTL: still served from cache (no new fetch).
      vi.setSystemTime(Date.now() + 59_999)
      stubFetch(makeRes({ body: { title: 'Fresh', body: 'new' } }))
      const stillCached = await getPullMeta(repo, 5)
      expect(stillCached.title).toBe('Stale')
      expect(firstMock).toHaveBeenCalledTimes(1)
      // Past the TTL: re-fetches and returns the fresh payload.
      vi.setSystemTime(Date.now() + 2)
      const refreshed = await getPullMeta(repo, 5)
      expect(refreshed.title).toBe('Fresh')
    } finally {
      vi.useRealTimers()
    }
  })
})

// =================================================================================
// listPullFiles
// =================================================================================

describe('listPullFiles', () => {
  it('requests the files endpoint with per_page=100 and returns the array', async () => {
    const files: PullFile[] = [
      { filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@' },
    ]
    const fetchMock = stubFetch(makeRes({ body: files }))
    const repo = freshRepo()
    const result = await listPullFiles(repo, 8)
    expect(lastUrl(fetchMock)).toBe(
      `https://api.github.com/repos/${repo}/pulls/8/files?per_page=100`,
    )
    expect(result).toEqual(files)
  })
})

// =================================================================================
// getDiffHunk (findHunk + cached file fetch)
// =================================================================================

describe('getDiffHunk', () => {
  const patch = [
    '@@ -1,3 +1,4 @@',
    ' context-a',
    '+added-1',
    ' context-b',
    '@@ -20,2 +21,3 @@',
    ' context-c',
    '+added-2',
    ' context-d',
  ].join('\n')

  it('returns the hunk whose new-side range contains the line', async () => {
    stubFetch(makeRes({ body: [{ filename: 'a.ts', status: 'modified', patch }] }))
    const hunk = await getDiffHunk(freshRepo(), 1, 'a.ts', 2)
    expect(hunk).toContain('@@ -1,3 +1,4 @@')
    expect(hunk).toContain('added-1')
    expect(hunk).not.toContain('added-2')
  })

  it('selects the second hunk when the line falls in its new-side range', async () => {
    stubFetch(makeRes({ body: [{ filename: 'a.ts', status: 'modified', patch }] }))
    const hunk = await getDiffHunk(freshRepo(), 1, 'a.ts', 22)
    expect(hunk).toContain('@@ -20,2 +21,3 @@')
    expect(hunk).toContain('added-2')
    expect(hunk).not.toContain('added-1')
  })

  it('falls back to old-side range when no new-side range matches', async () => {
    // new sides cover 1..4 and 21..23; line 20 only matches the old side of hunk 2 (20..21).
    stubFetch(makeRes({ body: [{ filename: 'a.ts', status: 'modified', patch }] }))
    const hunk = await getDiffHunk(freshRepo(), 1, 'a.ts', 20)
    expect(hunk).toContain('@@ -20,2 +21,3 @@')
  })

  it('returns undefined when the line is outside every hunk', async () => {
    stubFetch(makeRes({ body: [{ filename: 'a.ts', status: 'modified', patch }] }))
    const hunk = await getDiffHunk(freshRepo(), 1, 'a.ts', 999)
    expect(hunk).toBeUndefined()
  })

  it('returns undefined when the file is not in the PR', async () => {
    stubFetch(makeRes({ body: [{ filename: 'a.ts', status: 'modified', patch }] }))
    const hunk = await getDiffHunk(freshRepo(), 1, 'other.ts', 2)
    expect(hunk).toBeUndefined()
  })

  it('returns undefined when the matching file has no patch', async () => {
    stubFetch(makeRes({ body: [{ filename: 'bin.png', status: 'added' }] }))
    const hunk = await getDiffHunk(freshRepo(), 1, 'bin.png', 1)
    expect(hunk).toBeUndefined()
  })

  it('handles a hunk header with no count (defaults to 1 line)', async () => {
    // "@@ -5 +5 @@" -> newStart 5, newCount 1 -> only line 5 matches.
    const single = ['@@ -5 +5 @@', ' ctx', '+new'].join('\n')
    stubFetch(makeRes({ body: [{ filename: 'a.ts', status: 'modified', patch: single }] }))
    const repo = freshRepo()
    await expect(getDiffHunk(repo, 1, 'a.ts', 5)).resolves.toContain('@@ -5 +5 @@')
    // file list is cached for this repo#pr, so re-querying line 6 uses the same patch
    await expect(getDiffHunk(repo, 1, 'a.ts', 6)).resolves.toBeUndefined()
  })

  it('truncates a hunk longer than 4000 chars', async () => {
    const bigBody = Array.from({ length: 1000 }, (_, i) => `+line-${i}`).join('\n')
    const big = `@@ -1,1 +1,2000 @@\n${bigBody}`
    stubFetch(makeRes({ body: [{ filename: 'a.ts', status: 'modified', patch: big }] }))
    const hunk = await getDiffHunk(freshRepo(), 1, 'a.ts', 2)
    expect(hunk!.length).toBeLessThanOrEqual(4000 + '\n… (hunk truncated)'.length)
    expect(hunk!.endsWith('\n… (hunk truncated)')).toBe(true)
  })
})

// =================================================================================
// assemblePatches (pure budgeting)
// =================================================================================

describe('assemblePatches', () => {
  it('sums additions and deletions across all files', () => {
    const files: PullFile[] = [
      { filename: 'a.ts', status: 'modified', additions: 3, deletions: 1, patch: 'p' },
      { filename: 'b.ts', status: 'added', additions: 10, deletions: 0, patch: 'q' },
    ]
    const out = assemblePatches(files)
    expect(out.additions).toBe(13)
    expect(out.deletions).toBe(1)
    expect(out.total).toBe(2)
    expect(out.included).toBe(2)
  })

  it('builds an annotated block per file with status and diffstat', () => {
    const files: PullFile[] = [
      { filename: 'src/x.ts', status: 'modified', additions: 2, deletions: 1, patch: 'DIFF' },
    ]
    const out = assemblePatches(files)
    expect(out.text).toBe('--- src/x.ts (modified, +2 −1)\nDIFF')
  })

  it('substitutes a placeholder when a file has no patch', () => {
    const files: PullFile[] = [{ filename: 'bin.png', status: 'added', additions: 0, deletions: 0 }]
    const out = assemblePatches(files)
    expect(out.text).toContain('(no textual diff — binary or too large)')
  })

  it('treats missing additions/deletions as 0', () => {
    const files: PullFile[] = [{ filename: 'a.ts', status: 'modified', patch: 'p' }]
    const out = assemblePatches(files)
    expect(out.additions).toBe(0)
    expect(out.deletions).toBe(0)
    expect(out.text).toContain('+0 −0')
  })

  it('caps a single file diff at 2500 chars and appends the truncation marker', () => {
    const patch = 'z'.repeat(3000)
    const files: PullFile[] = [{ filename: 'a.ts', status: 'modified', patch }]
    const out = assemblePatches(files)
    expect(out.text).toContain(`${'z'.repeat(2500)}\n… (file diff truncated)`)
    expect(out.text).not.toContain('z'.repeat(2501))
  })

  it('drops files once the total budget is exceeded but always keeps the first', () => {
    // Each block is ~2500+ chars after the per-file cap; the 16000 budget admits ~6.
    const files: PullFile[] = Array.from({ length: 12 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: 'q'.repeat(2500),
    }))
    const out = assemblePatches(files)
    expect(out.total).toBe(12)
    expect(out.included).toBeGreaterThan(0)
    expect(out.included).toBeLessThan(12)
    // The included blocks fit roughly within the budget (the first is always kept).
    expect(out.text).toContain('--- f0.ts')
  })

  it('always includes at least the first file even when it alone exceeds the budget', () => {
    const files: PullFile[] = [
      { filename: 'huge.ts', status: 'modified', additions: 1, deletions: 0, patch: 'h'.repeat(2500) },
      { filename: 'next.ts', status: 'modified', additions: 1, deletions: 0, patch: 'n'.repeat(2500) },
    ]
    const out = assemblePatches(files)
    expect(out.included).toBeGreaterThanOrEqual(1)
    expect(out.text).toContain('--- huge.ts')
  })

  it('handles an empty file list', () => {
    const out = assemblePatches([])
    expect(out).toEqual({ text: '', included: 0, total: 0, additions: 0, deletions: 0 })
  })

  // Gap (adversarial): the existing "always keeps first even when it alone exceeds the budget"
  // test is mislabeled — a single block is capped at PATCH_PER_FILE_CAP (2500) + header, so it
  // can NEVER alone exceed the 16000 total budget. That test's premise is structurally
  // impossible; it only ever asserts `included >= 1`. Here we pin the EXACT cutoff instead:
  // each capped block is 2500 + a fixed header, and the budget admits a deterministic count.
  it('includes a deterministic number of files at the budget boundary, keeping order', () => {
    // Header "--- fNN.ts (modified, +1 −0)\n" + 2500 'q' + "\n… (file diff truncated)".
    const files: PullFile[] = Array.from({ length: 30 }, (_, i) => ({
      filename: `f${String(i).padStart(2, '0')}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: 'q'.repeat(3000), // > cap, so each block is capped to a known, uniform size
    }))
    const out = assemblePatches(files)
    const blockLen = out.text.split('\n\n')[0].length // uniform per block
    // The budget admits the running sum until used + next > 16000 (first always kept).
    // Recompute the expected count from the actual block size to stay robust to header tweaks.
    let used = 0
    let expected = 0
    for (let i = 0; i < 30; i++) {
      if (expected > 0 && used + blockLen > 16000) break
      used += blockLen
      expected += 1
    }
    expect(out.included).toBe(expected)
    expect(out.total).toBe(30)
    // Order preserved: the included slice is the leading run f00…, and the first survives.
    expect(out.text.startsWith('--- f00.ts')).toBe(true)
    expect(out.text).toContain(`--- f${String(expected - 1).padStart(2, '0')}.ts`)
    expect(out.text).not.toContain(`--- f${String(expected).padStart(2, '0')}.ts`)
  })
})

describe('getPrPatches', () => {
  it('fetches the file list and assembles patches', async () => {
    const files: PullFile[] = [
      { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'DIFF' },
    ]
    stubFetch(makeRes({ body: files }))
    const out = await getPrPatches(freshRepo(), 3)
    expect(out.total).toBe(1)
    expect(out.text).toContain('--- a.ts (modified, +1 −0)')
  })
})

// =================================================================================
// isTestFile (path conventions)
// =================================================================================

describe('isTestFile', () => {
  const tests = [
    'foo.test.ts',
    'foo.spec.jsx',
    'Foo.Test.TS', // case-insensitive
    'foo.test.mjs',
    'foo.spec.cts',
    'foo.test-d.ts', // tsd type test
    'src/test.ts', // whole-file test.ts
    'tests.js',
    'spec.mjs',
    'src/tests/helper.ts', // tests/ directory
    'src/__tests__/a.ts',
    'src/__mocks__/a.ts',
    'e2e/login.ts',
    'cypress/integration/a.ts',
    'foo_test.go',
    'foo_test.py',
    'tests/test_foo.py',
    'test_foo.py',
    'foo_spec.rb',
    'FooTest.java',
    'FooTests.cs',
    'FooTest.kt',
    'FooTest.swift',
  ]
  for (const p of tests) {
    it(`treats ${p} as a test file`, () => {
      expect(isTestFile(p)).toBe(true)
    })
  }

  const nonTests = [
    'foo.ts',
    'src/index.ts',
    'README.md',
    'attestation.ts', // contains "test" but not as a convention
    'contest.py',
    'latest.go',
    'foo.tsx',
    'package.json',
  ]
  for (const p of nonTests) {
    it(`treats ${p} as NOT a test file`, () => {
      expect(isTestFile(p)).toBe(false)
    })
  }
})

// =================================================================================
// testGaps (the headline pure heuristic)
// =================================================================================

function f(filename: string, status = 'modified'): PullFile {
  return { filename, status, additions: 1, deletions: 0 }
}

describe('testGaps', () => {
  it('flags a changed source file with no matching test', () => {
    const gaps = testGaps([f('src/foo.ts')])
    expect(gaps.uncovered).toEqual(['src/foo.ts'])
    expect(gaps.sourceCount).toBe(1)
    expect(gaps.testCount).toBe(0)
  })

  it('clears a source when a matching test changed (exact basename token)', () => {
    const gaps = testGaps([f('src/foo.ts'), f('src/foo.test.ts')])
    expect(gaps.uncovered).toEqual([])
    expect(gaps.sourceCount).toBe(1)
    expect(gaps.testCount).toBe(1)
  })

  it('matches a Python source to a test_ prefixed test', () => {
    const gaps = testGaps([f('pkg/foo.py'), f('pkg/test_foo.py')])
    expect(gaps.uncovered).toEqual([])
  })

  it('matches a Go source to a _test.go file', () => {
    const gaps = testGaps([f('foo.go'), f('foo_test.go')])
    expect(gaps.uncovered).toEqual([])
  })

  it('matches a test in a different directory by basename token', () => {
    // src/foo.ts ↔ tests/foo.test.ts — matched purely by basename token.
    const gaps = testGaps([f('src/foo.ts'), f('tests/foo.test.ts')])
    expect(gaps.uncovered).toEqual([])
  })

  it('ignores deleted (removed) source files', () => {
    const gaps = testGaps([f('src/gone.ts', 'removed')])
    expect(gaps.uncovered).toEqual([])
    expect(gaps.sourceCount).toBe(0)
  })

  it('ignores deleted test files when matching', () => {
    const gaps = testGaps([f('src/foo.ts'), f('src/foo.test.ts', 'removed')])
    // The only test that would cover foo.ts was removed -> source is uncovered.
    expect(gaps.uncovered).toEqual(['src/foo.ts'])
    expect(gaps.testCount).toBe(0)
  })

  it('does not count non-source extensions as source', () => {
    const gaps = testGaps([f('README.md'), f('config.yml'), f('data.json')])
    expect(gaps.sourceCount).toBe(0)
    expect(gaps.uncovered).toEqual([])
  })

  it('counts multiple uncovered sources and a covered one together', () => {
    const gaps = testGaps([
      f('src/a.ts'),
      f('src/b.ts'),
      f('src/c.ts'),
      f('src/b.test.ts'), // covers b
    ])
    expect(gaps.uncovered.sort()).toEqual(['src/a.ts', 'src/c.ts'])
    expect(gaps.sourceCount).toBe(3)
    expect(gaps.testCount).toBe(1)
  })

  it('matches via substring when both tokens are >=3 chars (foo ↔ foo.integration)', () => {
    // baseToken('foo.ts')='foo'; baseToken('foo.integration.test.ts')='foo.integration'
    // -> includes('foo') with min length 3 -> covered.
    const gaps = testGaps([f('src/foo.ts'), f('src/foo.integration.test.ts')])
    expect(gaps.uncovered).toEqual([])
  })

  it('does NOT match on a coincidental <3-char overlap', () => {
    // baseToken('ab.ts')='ab' (len 2) -> substring rule requires min length >= 3,
    // and tokens differ, so no match.
    const gaps = testGaps([f('src/ab.ts'), f('src/abcdef.test.ts')])
    expect(gaps.uncovered).toEqual(['src/ab.ts'])
  })

  it('does not double-count a file that is both source-shaped and a test (test wins)', () => {
    const gaps = testGaps([f('src/foo.test.ts')])
    // foo.test.ts is a test, not a source -> no source to flag.
    expect(gaps.sourceCount).toBe(0)
    expect(gaps.testCount).toBe(1)
    expect(gaps.uncovered).toEqual([])
  })

  it('handles an empty file list', () => {
    expect(testGaps([])).toEqual({ uncovered: [], sourceCount: 0, testCount: 0 })
  })

  // Gap (adversarial): the suite covers the test-token-INCLUDES-source direction
  // (foo ↔ foo.integration) but never the reverse — a source whose token CONTAINS a shorter
  // test token. This documents the heuristic's (intended, documented) looseness: an unrelated
  // `foobar.ts` is treated as covered by `foo.test.ts` because 'foo' (len 3) ⊂ 'foobar'.
  it('treats a source as covered when its token contains a >=3-char test token (loose by design)', () => {
    const gaps = testGaps([f('src/foobar.ts'), f('src/foo.test.ts')])
    expect(gaps.uncovered).toEqual([]) // foobar.ts considered covered by foo.test.ts
    expect(gaps.sourceCount).toBe(1)
    expect(gaps.testCount).toBe(1)
  })

  // Gap: a renamed source (status 'renamed', not 'removed') is still live and must be flagged.
  it('flags a renamed (non-removed) source with no matching test', () => {
    const gaps = testGaps([f('src/renamed.ts', 'renamed')])
    expect(gaps.uncovered).toEqual(['src/renamed.ts'])
    expect(gaps.sourceCount).toBe(1)
  })

  // Gap: an added source paired with an added test should clear (status other than modified).
  it('clears an added source covered by an added test', () => {
    const gaps = testGaps([f('src/new.ts', 'added'), f('src/new.test.ts', 'added')])
    expect(gaps.uncovered).toEqual([])
  })
})

// =================================================================================
// formatTestGapsReport
// =================================================================================

describe('formatTestGapsReport', () => {
  it('reports "nothing to flag" when no source files changed', () => {
    const out = formatTestGapsReport({ uncovered: [], sourceCount: 0, testCount: 0 })
    expect(out).toContain('No source files changed')
  })

  it('reports no gaps when every source is covered', () => {
    const out = formatTestGapsReport({ uncovered: [], sourceCount: 2, testCount: 2 })
    expect(out).toContain('No gaps found')
    expect(out).toContain('2 changed source file(s); 2 test file(s) changed.')
  })

  it('lists each uncovered file with a count and warning', () => {
    const out = formatTestGapsReport({
      uncovered: ['src/a.ts', 'src/b.ts'],
      sourceCount: 2,
      testCount: 0,
    })
    expect(out).toContain('2 source file(s) changed with no matching test change')
    expect(out).toContain('- `src/a.ts`')
    expect(out).toContain('- `src/b.ts`')
  })
})

// =================================================================================
// assembleOverview (pure churn map)
// =================================================================================

describe('assembleOverview', () => {
  it('totals additions/deletions and counts by status', () => {
    const files: PullFile[] = [
      { filename: 'a.ts', status: 'modified', additions: 5, deletions: 2 },
      { filename: 'b.ts', status: 'added', additions: 10, deletions: 0 },
      { filename: 'c.ts', status: 'removed', additions: 0, deletions: 7 },
    ]
    const out = assembleOverview(files)
    expect(out.total).toBe(3)
    expect(out.additions).toBe(15)
    expect(out.deletions).toBe(9)
    expect(out.byStatus).toEqual({ modified: 1, added: 1, removed: 1 })
  })

  it('computes churn per file and sorts by churn descending', () => {
    const files: PullFile[] = [
      { filename: 'small.ts', status: 'modified', additions: 1, deletions: 0 },
      { filename: 'big.ts', status: 'modified', additions: 50, deletions: 50 },
      { filename: 'mid.ts', status: 'modified', additions: 5, deletions: 5 },
    ]
    const out = assembleOverview(files)
    expect(out.files.map((x) => x.filename)).toEqual(['big.ts', 'mid.ts', 'small.ts'])
    expect(out.files[0].churn).toBe(100)
  })

  it('breaks churn ties deterministically by path (lexicographic)', () => {
    const files: PullFile[] = [
      { filename: 'zeta.ts', status: 'modified', additions: 1, deletions: 0 },
      { filename: 'alpha.ts', status: 'modified', additions: 1, deletions: 0 },
    ]
    const out = assembleOverview(files)
    expect(out.files.map((x) => x.filename)).toEqual(['alpha.ts', 'zeta.ts'])
  })

  it('rolls files up to a module key from the first 2 path segments', () => {
    const files: PullFile[] = [
      { filename: 'src/content/a.ts', status: 'modified', additions: 1, deletions: 0 },
      { filename: 'src/content/dock/b.ts', status: 'modified', additions: 2, deletions: 0 },
      { filename: 'src/background/c.ts', status: 'modified', additions: 3, deletions: 0 },
    ]
    const out = assembleOverview(files)
    const keys = out.modules.map((m) => m.module)
    expect(keys).toContain('src/content')
    expect(keys).toContain('src/background')
    const content = out.modules.find((m) => m.module === 'src/content')!
    expect(content.files).toBe(2)
    expect(content.additions).toBe(3)
    expect(content.churn).toBe(3)
  })

  it('groups root-level files under "(root)"', () => {
    const files: PullFile[] = [
      { filename: 'README.md', status: 'modified', additions: 1, deletions: 0 },
    ]
    const out = assembleOverview(files)
    expect(out.modules[0].module).toBe('(root)')
  })

  it('treats a single-directory path as its own module (first segment only)', () => {
    const files: PullFile[] = [
      { filename: 'src/index.ts', status: 'modified', additions: 1, deletions: 0 },
    ]
    const out = assembleOverview(files)
    // segments=['src','index.ts'], slice(0, min(2,1))=['src']
    expect(out.modules[0].module).toBe('src')
  })

  it('sorts modules by churn descending', () => {
    const files: PullFile[] = [
      { filename: 'a/x.ts', status: 'modified', additions: 1, deletions: 0 },
      { filename: 'b/y.ts', status: 'modified', additions: 100, deletions: 0 },
    ]
    const out = assembleOverview(files)
    expect(out.modules.map((m) => m.module)).toEqual(['b', 'a'])
  })

  it('handles an empty list', () => {
    const out = assembleOverview([])
    expect(out).toEqual({
      files: [],
      modules: [],
      total: 0,
      additions: 0,
      deletions: 0,
      byStatus: {},
    })
  })
})

// =================================================================================
// formatOverviewReport
// =================================================================================

describe('formatOverviewReport', () => {
  it('reports "no changed files" for an empty overview', () => {
    const out = formatOverviewReport(assembleOverview([]))
    expect(out).toBe('**PR overview** — no changed files in this PR.')
  })

  it('renders a single-module PR without the "By module" section', () => {
    const files: PullFile[] = [
      { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
      { filename: 'src/b.ts', status: 'added', additions: 2, deletions: 0 },
    ]
    const out = formatOverviewReport(assembleOverview(files))
    expect(out).not.toContain('**By module**')
    expect(out).toContain('+5 −1')
    expect(out).toContain('net +4')
    expect(out).toContain('`src/a.ts`')
  })

  it('renders a multi-module PR with a By module rollup and module count', () => {
    const files: PullFile[] = [
      { filename: 'src/content/a.ts', status: 'modified', additions: 3, deletions: 1 },
      { filename: 'src/background/b.ts', status: 'added', additions: 2, deletions: 0 },
    ]
    const out = formatOverviewReport(assembleOverview(files))
    expect(out).toContain('**By module**')
    expect(out).toContain('across 2 modules')
    expect(out).toContain('**By file**')
  })

  it('renders a negative net total with a leading minus', () => {
    const files: PullFile[] = [
      { filename: 'a.ts', status: 'modified', additions: 1, deletions: 10 },
    ]
    const out = formatOverviewReport(assembleOverview(files))
    expect(out).toContain('net -9')
  })

  it('collapses the long tail past the 20-file cap', () => {
    const files: PullFile[] = Array.from({ length: 25 }, (_, i) => ({
      filename: `src/f${String(i).padStart(2, '0')}.ts`,
      status: 'modified',
      additions: 25 - i, // decreasing churn so order is stable
      deletions: 0,
    }))
    const out = formatOverviewReport(assembleOverview(files))
    expect(out).toContain('and 5 more changed file(s)')
  })

  it('uses singular "file" when exactly one file changed', () => {
    const files: PullFile[] = [
      { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 },
    ]
    const out = formatOverviewReport(assembleOverview(files))
    expect(out).toContain('**1 file**')
  })
})

// =================================================================================
// createReviewComment (single-line + multi-line)
// =================================================================================

describe('createReviewComment', () => {
  it('POSTs a single-line comment with the exact body, side and line', async () => {
    setPat('ghp_post')
    const fetchMock = stubFetch(makeRes({ body: { id: 123, html_url: 'https://x/c/123' } }))
    const repo = freshRepo()
    const result = await createReviewComment(repo, 7, {
      body: 'Nit: rename this',
      commit_id: 'sha123',
      path: 'src/a.ts',
      line: 42,
      side: 'RIGHT',
    })

    expect(lastUrl(fetchMock)).toBe(`https://api.github.com/repos/${repo}/pulls/7/comments`)
    const init = lastInit(fetchMock)
    expect(init.method).toBe('POST')
    const sent = JSON.parse(init.body as string)
    expect(sent).toEqual({
      body: 'Nit: rename this',
      commit_id: 'sha123',
      path: 'src/a.ts',
      line: 42,
      side: 'RIGHT',
    })
    // single-line: no multi-line anchor keys serialized
    expect('start_line' in sent).toBe(false)
    expect('start_side' in sent).toBe(false)
    expect(result).toEqual({ id: 123, html_url: 'https://x/c/123' })
  })

  it('POSTs a multi-line comment carrying start_line and start_side', async () => {
    const fetchMock = stubFetch(makeRes({ body: { id: 1, html_url: 'u' } }))
    await createReviewComment(freshRepo(), 7, {
      body: 'block comment',
      commit_id: 'sha',
      path: 'src/a.ts',
      line: 50,
      side: 'RIGHT',
      start_line: 45,
      start_side: 'RIGHT',
    })
    const sent = JSON.parse(lastInit(fetchMock).body as string)
    expect(sent.start_line).toBe(45)
    expect(sent.start_side).toBe('RIGHT')
    expect(sent.line).toBe(50)
  })

  it('propagates a 422 error from GitHub (e.g. line not in diff)', async () => {
    stubFetch(makeRes({ status: 422, body: { message: 'line must be part of the diff' } }))
    await expect(
      createReviewComment(freshRepo(), 7, {
        body: 'x',
        commit_id: 'sha',
        path: 'a.ts',
        line: 1,
        side: 'RIGHT',
      }),
    ).rejects.toThrow('GitHub API 422: line must be part of the diff')
  })
})

// =================================================================================
// deleteReviewComment
// =================================================================================

describe('deleteReviewComment', () => {
  it('issues a DELETE to the comment endpoint and resolves on 204', async () => {
    setPat('ghp_del')
    const fetchMock = stubFetch(makeRes({ status: 204, rawText: '' }))
    const repo = freshRepo()
    await expect(deleteReviewComment(repo, 555)).resolves.toBeUndefined()
    expect(lastUrl(fetchMock)).toBe(
      `https://api.github.com/repos/${repo}/pulls/comments/555`,
    )
    expect(lastInit(fetchMock).method).toBe('DELETE')
  })

  it('throws when the delete fails (e.g. 404 already gone)', async () => {
    stubFetch(makeRes({ status: 404, body: { message: 'Not Found' } }))
    await expect(deleteReviewComment(freshRepo(), 1)).rejects.toThrow('GitHub API 404')
  })
})

// =================================================================================
// createReview (batch comments + verdict)
// =================================================================================

describe('createReview', () => {
  it('POSTs the review with event, body and the comment batch', async () => {
    setPat('ghp_rev')
    const fetchMock = stubFetch(makeRes({ body: { id: 900, html_url: 'https://x/r/900' } }))
    const repo = freshRepo()
    const comments = [
      { path: 'a.ts', body: 'c1', line: 10, side: 'RIGHT' as const },
      {
        path: 'b.ts',
        body: 'c2',
        line: 20,
        side: 'RIGHT' as const,
        start_line: 15,
        start_side: 'RIGHT' as const,
      },
    ]
    const result = await createReview(repo, 3, {
      commit_id: 'sha9',
      event: 'REQUEST_CHANGES',
      body: 'Please address these',
      comments,
    })

    expect(lastUrl(fetchMock)).toBe(`https://api.github.com/repos/${repo}/pulls/3/reviews`)
    const init = lastInit(fetchMock)
    expect(init.method).toBe('POST')
    const sent = JSON.parse(init.body as string)
    expect(sent.commit_id).toBe('sha9')
    expect(sent.event).toBe('REQUEST_CHANGES')
    expect(sent.body).toBe('Please address these')
    expect(sent.comments).toHaveLength(2)
    expect(sent.comments[0]).toEqual({ path: 'a.ts', body: 'c1', line: 10, side: 'RIGHT' })
    expect(sent.comments[1].start_line).toBe(15)
    expect(result).toEqual({ id: 900, html_url: 'https://x/r/900' })
  })

  it('serializes an APPROVE review with an empty body and no comments', async () => {
    const fetchMock = stubFetch(makeRes({ body: { id: 1, html_url: 'u' } }))
    await createReview(freshRepo(), 3, {
      commit_id: 'sha',
      event: 'APPROVE',
      body: '',
      comments: [],
    })
    const sent = JSON.parse(lastInit(fetchMock).body as string)
    expect(sent.event).toBe('APPROVE')
    expect(sent.body).toBe('')
    expect(sent.comments).toEqual([])
  })

  it('surfaces a GitHub validation error on a bad review', async () => {
    stubFetch(makeRes({ status: 422, body: { message: 'Unprocessable' } }))
    await expect(
      createReview(freshRepo(), 3, {
        commit_id: 'sha',
        event: 'COMMENT',
        body: 'x',
        comments: [],
      }),
    ).rejects.toThrow('GitHub API 422: Unprocessable')
  })
})
