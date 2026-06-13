// Core data contracts shared across background, content script, and native host.
// This module has NO dependencies so any layer can import it freely.

/** Which AI backend handles a request. */
export type ProviderId = 'anthropic-api' | 'claude-code-cli'

/** Where in the PR the question is anchored. All fields optional except repo/prNumber. */
export interface AskContext {
  /** "owner/name" */
  repo: string
  prNumber: number
  /** Path of the file the selection is in, e.g. "src/app.ts". */
  file?: string
  /** Inclusive [start, end] line range of the selection. */
  lineRange?: [number, number]
  /** PR title, for grounding the model in the change's stated intent. */
  prTitle?: string
  /** PR description/body (truncated), for intent grounding. */
  prBody?: string
  /** The exact text the user highlighted. */
  selectedCode?: string
  /** Surrounding diff hunk, for grounding the model. */
  diffHunk?: string
  /** All changed-file diffs (budgeted), for whole-PR tasks like the summary. */
  prPatches?: string
  /** Best-effort language hint derived from the file extension. */
  language?: string
}

/** One turn in a follow-up conversation. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** A single "ask about this code" request from the dock. */
export interface AskRequest {
  question: string
  context: AskContext
  /** Prior turns, oldest first, for multi-turn follow-ups. */
  history?: ChatMessage[]
  /** Whole-PR modes make the background fetch all file patches first: 'summary' asks for an
   *  overview, 'review' asks for a findings list. 'ask' (default) is selection-scoped. */
  mode?: 'ask' | 'summary' | 'review'
}

/** A streamed unit of a provider's response. */
export type Chunk =
  | { type: 'text'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
