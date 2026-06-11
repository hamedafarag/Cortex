// Background service worker — owns all LLM calls.
//
// Content scripts open a long-lived port (PORT_NAME). Each ASK is resolved to a
// provider, streamed, and relayed back as CHUNK/DONE/ERROR. Each request gets an
// AbortController so ABORT (or a port disconnect) cancels it promptly.

import {
  PORT_NAME,
  type ContentToBackground,
  type BackgroundToContent,
  type GithubRequest,
  type GithubResult,
} from '../shared/messages'
import type { AskRequest } from '../shared/types'
import { registry, NoProviderAvailableError } from './providers/registry'
import { AnthropicProvider } from './providers/anthropic'
import { ClaudeCodeProvider } from './providers/claudeCode'
import { getPullHeadSha, createReviewComment, getDiffHunk, getPullMeta } from './github/api'

console.debug('[YCRA] background service worker loaded')

/** Best-effort: attach the authoritative diff hunk from the GitHub API so the model
 *  sees the real surrounding change. Silently skipped if unavailable (no PAT, private
 *  repo, rate limit, file not in the diff). */
async function enrichWithDiffHunk(request: AskRequest): Promise<void> {
  const { context } = request
  if (context.diffHunk || !context.file || !context.lineRange) return
  try {
    const hunk = await getDiffHunk(
      context.repo,
      context.prNumber,
      context.file,
      context.lineRange[0],
    )
    if (hunk) context.diffHunk = hunk
  } catch {
    // grounding is optional — never fail the ask over it
  }
}

/** Best-effort: attach the PR title + description so the model can judge whether the
 *  change does what it claims, not just whether it's locally correct. Silently skipped
 *  if unavailable (no PAT, private repo, rate limit). */
async function enrichWithPrMeta(request: AskRequest): Promise<void> {
  const { context } = request
  if (context.prTitle !== undefined || context.prBody !== undefined) return
  try {
    const meta = await getPullMeta(context.repo, context.prNumber)
    if (meta.title) context.prTitle = meta.title
    if (meta.body) context.prBody = meta.body
  } catch {
    // grounding is optional — never fail the ask over it
  }
}

// Register available providers; the registry picks one per request from settings.
registry.register(new AnthropicProvider())
registry.register(new ClaudeCodeProvider())

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return

  // Requests in flight for THIS port, so we can cancel on ABORT / disconnect.
  const inFlight = new Map<string, AbortController>()

  const post = (msg: BackgroundToContent): void => {
    try {
      port.postMessage(msg)
    } catch {
      // Port closed mid-stream; nothing to do.
    }
  }

  const handleAsk = async (id: string, request: AskRequest): Promise<void> => {
    const controller = new AbortController()
    inFlight.set(id, controller)
    try {
      await Promise.all([enrichWithDiffHunk(request), enrichWithPrMeta(request)])
      if (controller.signal.aborted) return
      const { provider } = await registry.resolve()
      for await (const chunk of provider.ask(request, controller.signal)) {
        if (controller.signal.aborted) break
        switch (chunk.type) {
          case 'text':
            post({ type: 'CHUNK', id, delta: chunk.delta })
            break
          case 'done':
            post({ type: 'DONE', id })
            break
          case 'error':
            post({ type: 'ERROR', id, message: chunk.message })
            break
        }
      }
    } catch (err) {
      const message =
        err instanceof NoProviderAvailableError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      post({ type: 'ERROR', id, message })
    } finally {
      inFlight.delete(id)
    }
  }

  port.onMessage.addListener((msg: ContentToBackground) => {
    switch (msg.type) {
      case 'ASK':
        void handleAsk(msg.id, msg.request)
        break
      case 'ABORT':
        inFlight.get(msg.id)?.abort()
        inFlight.delete(msg.id)
        break
    }
  })

  port.onDisconnect.addListener(() => {
    for (const controller of inFlight.values()) controller.abort()
    inFlight.clear()
  })
})

// One-shot GitHub operations (request/response, not streamed).
chrome.runtime.onMessage.addListener((message: GithubRequest, _sender, sendResponse) => {
  if (message?.type !== 'GH_POST_COMMENT') return
  void (async () => {
    try {
      const commitId = await getPullHeadSha(message.repo, message.prNumber)
      const comment = await createReviewComment(message.repo, message.prNumber, {
        body: message.body,
        commit_id: commitId,
        path: message.path,
        line: message.line,
        side: message.side,
        start_line: message.startLine,
        start_side: message.startSide,
      })
      sendResponse({ ok: true, url: comment.html_url } satisfies GithubResult)
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies GithubResult)
    }
  })()
  return true // keep the channel open for the async sendResponse
})
