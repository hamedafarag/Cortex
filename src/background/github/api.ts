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

export interface PullFile {
  filename: string
  status: string
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
  },
): Promise<CreatedComment> {
  return (await githubFetch(`/repos/${repo}/pulls/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify(params),
  })) as CreatedComment
}
