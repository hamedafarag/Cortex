// Minimal GitHub REST client, run from the background worker so the PAT never
// touches page context. Uses the user's own token against api.github.com (their
// GitHub — no third party). Reads work unauthenticated on public repos but are
// rate-limited; private repos and posting require a PAT.

import { getSettings } from '../../shared/storage'

const BASE = 'https://api.github.com'

async function githubFetch(path: string, init?: RequestInit): Promise<unknown> {
  const { githubPat } = await getSettings()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (githubPat) headers.Authorization = `Bearer ${githubPat}`

  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = `GitHub API ${res.status}`
    try {
      const json = JSON.parse(text) as { message?: string }
      if (json.message) message += `: ${json.message}`
    } catch {
      if (text) message += `: ${text.slice(0, 200)}`
    }
    // Make the common access errors actionable.
    if (res.status === 401) {
      message += ' — no/invalid token. Add a PAT in Options.'
    } else if (res.status === 403) {
      message += ' — token lacks permission (needs Pull requests: write).'
    } else if (res.status === 404) {
      message +=
        ' — repo/PR not found, or your token can’t access it. For org repos the' +
        ' token must have that repo selected, Pull requests: Read and write, and the' +
        ' org must approve it (or, for a classic token, be SSO-authorized).'
    }
    throw new Error(message)
  }
  // DELETE returns 204 No Content; tolerate any empty body so callers don't choke on res.json().
  if (res.status === 204) return null
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** The PR's head commit SHA — required as `commit_id` when posting a comment. */
export async function getPullHeadSha(repo: string, prNumber: number): Promise<string> {
  const pr = (await githubFetch(`/repos/${repo}/pulls/${prNumber}`)) as {
    head?: { sha?: string }
  }
  if (!pr.head?.sha) throw new Error('Could not read the PR head commit.')
  return pr.head.sha
}

export interface PullMeta {
  title: string
  body: string
}

const pullMetaCache = new Map<string, { at: number; meta: PullMeta }>()
const PULL_META_TTL_MS = 60_000

/** PR title + description, for grounding asks in the change's stated intent. Cached
 *  briefly; the body is truncated so a long description can't dominate the prompt. */
export async function getPullMeta(repo: string, prNumber: number): Promise<PullMeta> {
  const key = `${repo}#${prNumber}`
  const cached = pullMetaCache.get(key)
  if (cached && Date.now() - cached.at < PULL_META_TTL_MS) return cached.meta
  const pr = (await githubFetch(`/repos/${repo}/pulls/${prNumber}`)) as {
    title?: string
    body?: string | null
  }
  const body = pr.body ?? ''
  const meta: PullMeta = {
    title: pr.title ?? '',
    body: body.length > 4000 ? `${body.slice(0, 4000)}\n… (description truncated)` : body,
  }
  pullMetaCache.set(key, { at: Date.now(), meta })
  return meta
}

export interface PullFile {
  filename: string
  status: string
  additions?: number
  deletions?: number
  /** Unified-diff hunk(s) for this file; absent for binary/too-large files. */
  patch?: string
}

/** Changed files in the PR, each with its unified-diff `patch` (authoritative). */
export async function listPullFiles(repo: string, prNumber: number): Promise<PullFile[]> {
  return (await githubFetch(
    `/repos/${repo}/pulls/${prNumber}/files?per_page=100`,
  )) as PullFile[]
}

export interface CreatedComment {
  id: number
  html_url: string
}

// --- Authoritative diff-hunk grounding -----------------------------------------

const filesCache = new Map<string, { at: number; files: PullFile[] }>()
const FILES_TTL_MS = 60_000

async function getPullFilesCached(repo: string, prNumber: number): Promise<PullFile[]> {
  const key = `${repo}#${prNumber}`
  const cached = filesCache.get(key)
  if (cached && Date.now() - cached.at < FILES_TTL_MS) return cached.files
  const files = await listPullFiles(repo, prNumber)
  filesCache.set(key, { at: Date.now(), files })
  return files
}

/** Extract the unified-diff hunk that contains `line` (new side first, then old). */
function findHunk(patch: string, line: number): string | undefined {
  const headerRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  interface Hunk {
    header: string
    body: string[]
    oldStart: number
    oldCount: number
    newStart: number
    newCount: number
  }
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  for (const l of patch.split('\n')) {
    const m = headerRe.exec(l)
    if (m) {
      if (cur) hunks.push(cur)
      cur = {
        header: l,
        body: [],
        oldStart: +m[1],
        oldCount: m[2] ? +m[2] : 1,
        newStart: +m[3],
        newCount: m[4] ? +m[4] : 1,
      }
    } else if (cur) {
      cur.body.push(l)
    }
  }
  if (cur) hunks.push(cur)

  const within = (start: number, count: number): boolean =>
    line >= start && line <= start + Math.max(count, 1) - 1
  const hunk =
    hunks.find((h) => within(h.newStart, h.newCount)) ??
    hunks.find((h) => within(h.oldStart, h.oldCount))
  if (!hunk) return undefined

  const text = [hunk.header, ...hunk.body].join('\n')
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (hunk truncated)` : text
}

/** The diff hunk containing `line` in `file`, for grounding an ask (or undefined). */
export async function getDiffHunk(
  repo: string,
  prNumber: number,
  file: string,
  line: number,
): Promise<string | undefined> {
  const patch = (await getPullFilesCached(repo, prNumber)).find(
    (f) => f.filename === file,
  )?.patch
  return patch ? findHunk(patch, line) : undefined
}

// --- Whole-PR patch view (for the summary) -------------------------------------

export interface PrPatches {
  /** Budgeted, diff-annotated view of the changed files. */
  text: string
  /** Files that made it into `text` vs the total (the rest were dropped for length). */
  included: number
  total: number
  additions: number
  deletions: number
}

const PATCH_TOTAL_BUDGET = 16000
const PATCH_PER_FILE_CAP = 2500

/** Assemble a budgeted view of all changed files' diffs for whole-PR tasks. Pure, so the
 *  budgeting is unit-testable. Big files are capped; once the total budget is hit the
 *  remaining files are dropped (reported via `included`/`total`). */
export function assemblePatches(files: PullFile[]): PrPatches {
  let additions = 0
  let deletions = 0
  for (const f of files) {
    additions += f.additions ?? 0
    deletions += f.deletions ?? 0
  }
  const blocks: string[] = []
  let used = 0
  let included = 0
  for (const f of files) {
    let patch = f.patch ?? '(no textual diff — binary or too large)'
    if (patch.length > PATCH_PER_FILE_CAP) {
      patch = `${patch.slice(0, PATCH_PER_FILE_CAP)}\n… (file diff truncated)`
    }
    const block = `--- ${f.filename} (${f.status}, +${f.additions ?? 0} −${f.deletions ?? 0})\n${patch}`
    if (included > 0 && used + block.length > PATCH_TOTAL_BUDGET) break
    blocks.push(block)
    used += block.length
    included += 1
  }
  return { text: blocks.join('\n\n'), included, total: files.length, additions, deletions }
}

/** All changed files' diffs for the PR, budgeted for a whole-PR summary. */
export async function getPrPatches(repo: string, prNumber: number): Promise<PrPatches> {
  return assemblePatches(await getPullFilesCached(repo, prNumber))
}

// --- Test-gap heuristic (path-based; an approximation, not coverage) ------------

/** Source-code file extensions we consider "should probably have a test". */
const SOURCE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|kts|cs|swift|rs|php|scala|c|cc|cpp|cxx|h|hpp|m|mm)$/i

/** A changed file is a test if its path matches any common test convention. */
export function isTestFile(path: string): boolean {
  const lower = path.toLowerCase()
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower) || // foo.test.ts / foo.spec.jsx
    /\.(test|spec)-d\.ts$/.test(lower) || // foo.test-d.ts (tsd type tests)
    /(^|\/)(tests?|specs?)\.[cm]?[jt]sx?$/.test(lower) || // whole-file test.js / tests.ts / spec.mjs
    /(^|\/)(tests?|specs?|__tests__|__mocks__|e2e|cypress)\//.test(lower) || // tests/ __tests__/ …
    /_test\.(go|py|rb)$/.test(lower) || // foo_test.go / foo_test.py
    /(^|\/)test_[^/]*\.py$/.test(lower) || // test_foo.py
    /_spec\.rb$/.test(lower) || // foo_spec.rb
    /tests?\.(java|kt|cs|swift)$/.test(lower) // FooTest.java / FooTests.cs
  )
}

/** A changed file is "source" if it has a code extension and isn't itself a test. */
function isSourceFile(path: string): boolean {
  return SOURCE_EXT_RE.test(path) && !isTestFile(path)
}

/** Strip directory + extension + common test affixes to a bare basename token. */
function baseToken(path: string): string {
  const name = path.split('/').pop() ?? path
  return name
    .replace(/\.[^.]+$/, '') // drop extension
    .replace(/[._-](test|spec)$/i, '') // drop trailing .test / -spec
    .replace(/^test[._-]/i, '') // drop leading test_
    .toLowerCase()
}

export interface TestGaps {
  /** Changed, non-deleted source files with no matching test change. */
  uncovered: string[]
  /** How many source files changed in total (non-deleted). */
  sourceCount: number
  /** How many test files changed. */
  testCount: number
}

/** Which changed source files have no matching test change? Tests are matched to sources by
 *  basename token (`foo.ts` ↔ `foo.test.ts` / `test_foo.py`). Deleted files are ignored.
 *  A coarse approximation — it answers "did tests move with the code?", not real coverage. */
export function testGaps(files: PullFile[]): TestGaps {
  const live = files.filter((f) => f.status !== 'removed')
  const tests = live.filter((f) => isTestFile(f.filename))
  const sources = live.filter((f) => isSourceFile(f.filename))
  const testTokens = tests.map((f) => baseToken(f.filename))
  const uncovered = sources
    .filter((s) => {
      const token = baseToken(s.filename)
      // Covered if a changed test matches by basename: an exact token match always counts
      // (`a.ts`↔`a.test.ts`); a substring match (`foo`↔`foo.integration`) counts only when the
      // shorter token is specific enough that the overlap isn't coincidental.
      const covered = testTokens.some((t) => {
        if (t === token) return true
        return Math.min(t.length, token.length) >= 3 && (t.includes(token) || token.includes(t))
      })
      return !covered
    })
    .map((s) => s.filename)
  return { uncovered, sourceCount: sources.length, testCount: tests.length }
}

/** Render the test-gap heuristic as a dock-ready markdown report. */
export function formatTestGapsReport(gaps: TestGaps): string {
  const head =
    `**Test-gap check** — heuristic, by file path (an approximation, not coverage).\n\n` +
    `${gaps.sourceCount} changed source file(s); ${gaps.testCount} test file(s) changed.`
  if (gaps.sourceCount === 0) {
    return `${head}\n\nNo source files changed — nothing to flag.`
  }
  if (gaps.uncovered.length === 0) {
    return `${head}\n\n✅ **No gaps found** — every changed source file has a matching test change.`
  }
  const list = gaps.uncovered.map((f) => `- \`${f}\``).join('\n')
  return (
    `${head}\n\n⚠️ **${gaps.uncovered.length} source file(s) changed with no matching test change:**\n\n` +
    `${list}\n\n_Heuristic match by file name — confirm before asking the author for tests._`
  )
}

// --- PR change map / churn overview (path + diffstat; no LLM) -------------------

/** Short, human label for a GitHub file `status`. */
const STATUS_LABEL: Record<string, string> = {
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
}

export interface OverviewFile {
  filename: string
  status: string
  additions: number
  deletions: number
  /** additions + deletions — the file's total churn. */
  churn: number
}

export interface PrOverview {
  /** Changed files, sorted by churn (largest first). */
  files: OverviewFile[]
  total: number
  additions: number
  deletions: number
  /** How many files of each status (e.g. `{ modified: 3, added: 2 }`). */
  byStatus: Record<string, number>
}

/** Build a deterministic per-file churn map from the PR's file list. Pure, so the shaping is
 *  unit-testable. No LLM — just the additions/deletions GitHub already returns per file. */
export function assembleOverview(files: PullFile[]): PrOverview {
  let additions = 0
  let deletions = 0
  const byStatus: Record<string, number> = {}
  const mapped: OverviewFile[] = files.map((f) => {
    const a = f.additions ?? 0
    const d = f.deletions ?? 0
    additions += a
    deletions += d
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1
    return { filename: f.filename, status: f.status, additions: a, deletions: d, churn: a + d }
  })
  // Largest churn first; stable tiebreak on path so the output is deterministic.
  mapped.sort((x, y) => y.churn - x.churn || (x.filename < y.filename ? -1 : 1))
  return { files: mapped, total: files.length, additions, deletions, byStatus }
}

/** A fixed-width unicode bar sized to `total` relative to `max` (filled `█`, padded `░`). Plain
 *  text so it rides the markdown render path and stays color-blind-safe (length, not colour). */
function churnBar(total: number, max: number, width = 20): string {
  if (max <= 0) return '░'.repeat(width)
  const filled = total > 0 ? Math.max(1, Math.round((total / max) * width)) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** How many top files to list before collapsing the long tail (keeps big PRs readable). */
const OVERVIEW_FILE_CAP = 20

/** Render the churn overview as a dock-ready markdown report (bars in backticks → monospace). */
export function formatOverviewReport(o: PrOverview): string {
  if (o.total === 0) return '**PR overview** — no changed files in this PR.'
  const net = o.additions - o.deletions
  const netStr = net >= 0 ? `+${net}` : `${net}`
  const statusLine = Object.entries(o.byStatus)
    .map(([s, n]) => `${n} ${STATUS_LABEL[s] ?? s}`)
    .join(' · ')
  const head =
    `**PR overview** — change map by file (no LLM, from the GitHub file list).\n\n` +
    `**${o.total} file${o.total === 1 ? '' : 's'}** · +${o.additions} −${o.deletions} · net ${netStr}\n\n` +
    `${statusLine}`
  const max = o.files[0]?.churn ?? 0
  const shown = o.files.slice(0, OVERVIEW_FILE_CAP)
  const list = shown
    .map(
      (f) =>
        `- \`${f.filename}\` · ${STATUS_LABEL[f.status] ?? f.status} · ` +
        `\`+${f.additions} −${f.deletions}\` \`${churnBar(f.churn, max)}\``,
    )
    .join('\n')
  const omitted =
    o.files.length > shown.length
      ? `\n\n_…and ${o.files.length - shown.length} more changed file(s), smaller churn._`
      : ''
  return `${head}\n\n${list}${omitted}`
}

/** Post a line-anchored review comment on the PR diff. */
export async function createReviewComment(
  repo: string,
  prNumber: number,
  params: {
    body: string
    commit_id: string
    path: string
    line: number
    side: 'LEFT' | 'RIGHT'
    /** Multi-line anchor: first line + side. `JSON.stringify` drops them when undefined. */
    start_line?: number
    start_side?: 'LEFT' | 'RIGHT'
  },
): Promise<CreatedComment> {
  return (await githubFetch(`/repos/${repo}/pulls/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify(params),
  })) as CreatedComment
}

/** Delete a review comment by id — backs the dock's post-then-Undo window. */
export async function deleteReviewComment(repo: string, commentId: number): Promise<void> {
  await githubFetch(`/repos/${repo}/pulls/comments/${commentId}`, { method: 'DELETE' })
}

/** One line comment in a submitted review (Reviews API `comments[]` shape). */
export interface ReviewCommentInput {
  path: string
  body: string
  line: number
  side: 'LEFT' | 'RIGHT'
  /** `JSON.stringify` drops these when undefined (single-line anchors). */
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
}

/** Submit a review (a batch of line comments + a verdict) in one call. `body` is required by
 *  GitHub for COMMENT / REQUEST_CHANGES; APPROVE may have an empty body. */
export async function createReview(
  repo: string,
  prNumber: number,
  params: {
    commit_id: string
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
    body: string
    comments: ReviewCommentInput[]
  },
): Promise<CreatedComment> {
  return (await githubFetch(`/repos/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    body: JSON.stringify(params),
  })) as CreatedComment
}
