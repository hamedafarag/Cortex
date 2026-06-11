// Wire protocols for the two hops a request makes:
//   1. content script  <->  background worker   (long-lived chrome.runtime port)
//   2. background worker <-> native host         (native-messaging stdio, JSON)
//
// Keeping both protocols here gives one source of truth for message shapes.

import type { AskRequest } from './types'

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

export type BackgroundToContent = ChunkMessage | DoneMessage | ErrorMessage

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
  /** Line number in the file on `side` of the diff. */
  line: number
  side: 'LEFT' | 'RIGHT'
}

export type GithubRequest = PostCommentMessage

/** background -> content: result of a GitHub operation. */
export interface GithubResult {
  ok: boolean
  /** HTML URL of the created comment, on success. */
  url?: string
  error?: string
}
