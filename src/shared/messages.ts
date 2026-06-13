// Wire protocols for the two hops a request makes:
//   1. content script  <->  background worker   (long-lived chrome.runtime port)
//   2. background worker <-> native host         (native-messaging stdio, JSON)
//
// Keeping both protocols here gives one source of truth for message shapes.

import type { AskRequest, DraftComment, ReviewEvent } from './types'

// ---------------------------------------------------------------------------
// 1. Content script <-> background worker (port)
// ---------------------------------------------------------------------------

/** Name used by both ends of chrome.runtime.connect / onConnect. */
export const PORT_NAME = 'ycra'

/** content -> background: start an ask. `id` correlates the streamed reply. */
export interface AskMessage {
  type: 'ASK'
  id: string
  request: AskRequest
}

/** content -> background: cancel an in-flight ask. */
export interface AbortMessage {
  type: 'ABORT'
  id: string
}

export type ContentToBackground = AskMessage | AbortMessage

/** background -> content: one streamed token/segment. */
export interface ChunkMessage {
  type: 'CHUNK'
  id: string
  delta: string
}

/** background -> content: stream finished successfully. */
export interface DoneMessage {
  type: 'DONE'
  id: string
}

/** background -> content: stream failed. */
export interface ErrorMessage {
  type: 'ERROR'
  id: string
  message: string
}

/** background -> content: out-of-band notice that some secrets were masked before the request
 *  was sent to the model. Emitted (if any) before the first CHUNK. */
export interface MetaMessage {
  type: 'META'
  id: string
  /** How many secrets were masked across the request's code fields. */
  redactedSecrets: number
}

export type BackgroundToContent = ChunkMessage | DoneMessage | ErrorMessage | MetaMessage

// ---------------------------------------------------------------------------
// 2. Background worker <-> native host (native messaging)
// ---------------------------------------------------------------------------

/** Native-messaging host id; must match the host manifest's "name". */
export const NATIVE_HOST_NAME = 'com.ycra.reviewer'

/** background -> host: run an ask via the local Claude Code CLI. */
export interface NativeAskMessage {
  type: 'ask'
  id: string
  request: AskRequest
  /** Model alias/id passed to `claude --model` (from settings). */
  model: string
}

/** background -> host: cancel an in-flight ask. */
export interface NativeAbortMessage {
  type: 'abort'
  id: string
}

export type BackgroundToHost = NativeAskMessage | NativeAbortMessage

/** host -> background: one streamed segment. */
export interface NativeChunkMessage {
  type: 'chunk'
  id: string
  delta: string
}

/** host -> background: stream finished. */
export interface NativeDoneMessage {
  type: 'done'
  id: string
}

/** host -> background: stream failed. */
export interface NativeErrorMessage {
  type: 'error'
  id: string
  message: string
}

export type HostToBackground =
  | NativeChunkMessage
  | NativeDoneMessage
  | NativeErrorMessage

// ---------------------------------------------------------------------------
// 3. Content script <-> background: one-shot GitHub operations (request/response)
// ---------------------------------------------------------------------------

/** content -> background: post a line-anchored review comment via the GitHub API. */
export interface PostCommentMessage {
  type: 'GH_POST_COMMENT'
  repo: string
  prNumber: number
  body: string
  path: string
  /** Last line of the comment, in the file on `side` of the diff. */
  line: number
  side: 'LEFT' | 'RIGHT'
  /** First line of a multi-line comment/suggestion (spans `startLine`..`line`).
   *  Omitted for a single-line anchor. */
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
}

/** content -> background: run the deterministic test-gap heuristic over the PR's file list.
 *  No LLM call — pure path analysis in the background (which holds the cached file list). */
export interface TestGapsMessage {
  type: 'GH_TEST_GAPS'
  repo: string
  prNumber: number
}

/** content -> background: delete a review comment (the post-then-Undo window). */
export interface DeleteCommentMessage {
  type: 'GH_DELETE_COMMENT'
  repo: string
  /** The `id` returned when the comment was created. */
  commentId: number
}

/** content -> background: submit a batch review (the dock's pending comments) with a verdict. */
export interface SubmitReviewMessage {
  type: 'GH_SUBMIT_REVIEW'
  repo: string
  prNumber: number
  event: ReviewEvent
  /** Overall review body. Required by GitHub for COMMENT / REQUEST_CHANGES. */
  body: string
  comments: DraftComment[]
}

/** content -> background: open the bundled features/help page in a new tab. The background
 *  owns `chrome.tabs`, which content scripts can't call. */
export interface OpenHelpMessage {
  type: 'OPEN_HELP'
}

export type GithubRequest =
  | PostCommentMessage
  | DeleteCommentMessage
  | SubmitReviewMessage
  | TestGapsMessage
  | OpenHelpMessage

/** background -> content: result of a GitHub operation. */
export interface GithubResult {
  ok: boolean
  /** HTML URL of the created comment, on success. */
  url?: string
  /** Numeric id of the created comment, so the dock can offer an Undo (delete). */
  commentId?: number
  error?: string
}

/** background -> content: the rendered test-gap report (markdown), or an error. */
export interface TestGapsResult {
  ok: boolean
  /** Markdown report, on success. */
  report?: string
  error?: string
}
