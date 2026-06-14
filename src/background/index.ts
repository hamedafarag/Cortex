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
  type TestGapsResult,
  type PrOverviewResult,
} from '../shared/messages'
import type { AskRequest } from '../shared/types'
import { redactSecrets } from '../shared/redact'
import { registry, NoProviderAvailableError } from './providers/registry'
import { AnthropicProvider } from './providers/anthropic'
import { ClaudeCodeProvider } from './providers/claudeCode'
import {
  getPullHeadSha,
  createReviewComment,
  deleteReviewComment,
  createReview,
  getDiffHunk,
  getPullMeta,
  getPrPatches,
  listPullFiles,
  testGaps,
  formatTestGapsReport,
  assembleOverview,
  formatOverviewReport,
} from './github/api'

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
      if (request.mode === 'summary' || request.mode === 'review') {
        await enrichWithPrMeta(request)
        const patches = await getPrPatches(request.context.repo, request.context.prNumber)
        if (!patches.text) {
          post({ type: 'ERROR', id, message: 'No changed files to review in this PR.' })
          return
        }
        const omitted =
          patches.included < patches.total
            ? `\n\n(${patches.included} of ${patches.total} changed files shown; the rest omitted for length.)`
            : ''
        request.context.prPatches =
          `${patches.total} changed files (+${patches.additions} −${patches.deletions})\n\n` +
          `${patches.text}${omitted}`
      } else {
        await Promise.all([enrichWithDiffHunk(request), enrichWithPrMeta(request)])
      }
      if (controller.signal.aborted) return
      // Mask obvious secrets in every code-bearing field before the request leaves the browser.
      let redactedSecrets = 0
      for (const field of ['selectedCode', 'diffHunk', 'prPatches'] as const) {
        const value = request.context[field]
        if (!value) continue
        const { text, count } = redactSecrets(value)
        if (count) {
          request.context[field] = text
          redactedSecrets += count
        }
      }
      if (redactedSecrets > 0) post({ type: 'META', id, redactedSecrets })
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
  if (message?.type === 'GH_POST_COMMENT') {
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
        sendResponse({
          ok: true,
          url: comment.html_url,
          commentId: comment.id,
        } satisfies GithubResult)
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies GithubResult)
      }
    })()
    return true // keep the channel open for the async sendResponse
  }

  if (message?.type === 'GH_DELETE_COMMENT') {
    void (async () => {
      try {
        await deleteReviewComment(message.repo, message.commentId)
        sendResponse({ ok: true } satisfies GithubResult)
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies GithubResult)
      }
    })()
    return true // keep the channel open for the async sendResponse
  }

  if (message?.type === 'GH_SUBMIT_REVIEW') {
    void (async () => {
      try {
        const commitId = await getPullHeadSha(message.repo, message.prNumber)
        const review = await createReview(message.repo, message.prNumber, {
          commit_id: commitId,
          event: message.event,
          body: message.body,
          comments: message.comments.map((c) => ({
            path: c.path,
            body: c.body,
            line: c.line,
            side: c.side,
            start_line: c.startLine,
            start_side: c.startSide,
          })),
        })
        sendResponse({ ok: true, url: review.html_url } satisfies GithubResult)
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies GithubResult)
      }
    })()
    return true // keep the channel open for the async sendResponse
  }

  if (message?.type === 'OPEN_HELP') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/help/help.html') })
    return false // fire-and-forget; no response
  }

  if (message?.type === 'GH_TEST_GAPS') {
    void (async () => {
      try {
        const files = await listPullFiles(message.repo, message.prNumber)
        sendResponse({
          ok: true,
          report: formatTestGapsReport(testGaps(files)),
        } satisfies TestGapsResult)
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies TestGapsResult)
      }
    })()
    return true // keep the channel open for the async sendResponse
  }

  if (message?.type === 'GH_PR_OVERVIEW') {
    void (async () => {
      try {
        const files = await listPullFiles(message.repo, message.prNumber)
        sendResponse({
          ok: true,
          report: formatOverviewReport(assembleOverview(files)),
        } satisfies PrOverviewResult)
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies PrOverviewResult)
      }
    })()
    return true // keep the channel open for the async sendResponse
  }
})
