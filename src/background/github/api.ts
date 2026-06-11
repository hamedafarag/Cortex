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
