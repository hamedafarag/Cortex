// Assemble the per-turn user message from the ask context. Pure + dependency-free so
// any layer can import it and it can be unit-tested in isolation. The native host
// (native-host/reviewer-host.mjs) keeps a hand-mirrored copy because it runs in a
// separate plain-JS runtime that can't import this module — keep the two in sync.

import type { AskRequest } from './types'

/** PR intent + file/line context, the selected code and diff, then the question. */
export function buildUserContent(req: AskRequest): string {
  const { context, question } = req
  const parts: string[] = [`Pull request: ${context.repo} #${context.prNumber}`]

  if (context.prTitle) parts.push(`PR title: ${context.prTitle}`)
  if (context.prBody) parts.push(`PR description:\n${context.prBody}`)
  if (context.file) parts.push(`File: ${context.file}`)
  if (context.lineRange) parts.push(`Lines: ${context.lineRange[0]}-${context.lineRange[1]}`)
  if (context.selectedCode) {
    parts.push(`Selected code:\n\`\`\`${context.language ?? ''}\n${context.selectedCode}\n\`\`\``)
  }
  if (context.diffHunk) {
    parts.push(`Surrounding diff:\n\`\`\`diff\n${context.diffHunk}\n\`\`\``)
  }
  parts.push(`Question: ${question}`)

  return parts.join('\n\n')
}
