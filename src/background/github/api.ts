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
  return res.json()
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
