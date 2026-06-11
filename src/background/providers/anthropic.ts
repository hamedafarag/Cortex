// Provider A — the Anthropic API backend.
//
// Uses the official @anthropic-ai/sdk. Two browser-context notes:
//  - `dangerouslyAllowBrowser: true` disables the SDK's "don't run in a browser"
//    guard (harmless in a service worker, where there's no `window`).
//  - the `anthropic-dangerous-direct-browser-access` header is required for the
//    API to accept a request that carries an extension Origin; we set it
//    explicitly so it's present regardless of how the SDK detects the runtime.

import Anthropic from '@anthropic-ai/sdk'
import type { AskRequest, Chunk } from '../../shared/types'
import { getSettings } from '../../shared/storage'
import { buildUserContent } from '../../shared/prompt'
import type { LlmProvider } from './types'

const SYSTEM_PROMPT = [
  'You are an expert code reviewer assisting a human reviewer inside a GitHub pull request.',
  'The reviewer highlights code in the diff and asks questions about it. Answer concisely',
  'and concretely, grounded in the provided code and diff. Use any PR title/description to',
  'judge whether the change does what it claims, not just whether it is locally correct.',
  'When you spot bugs, risks, or clearly better approaches, say so plainly. Use',
  'GitHub-flavored markdown. If the provided context is insufficient to answer confidently,',
  'say what else you would need rather than guessing.',
].join(' ')

function buildMessages(req: AskRequest): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = (req.history ?? []).map((turn) => ({
    role: turn.role,
    content: turn.content,
  }))
  messages.push({ role: 'user', content: buildUserContent(req) })
  return messages
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic-api' as const

  async isAvailable(): Promise<boolean> {
    const { anthropicApiKey } = await getSettings()
    return anthropicApiKey.trim().length > 0
  }

  async *ask(req: AskRequest, signal: AbortSignal): AsyncIterable<Chunk> {
    const { anthropicApiKey, model } = await getSettings()
    if (!anthropicApiKey.trim()) {
      yield { type: 'error', message: 'No Anthropic API key set. Add one in the extension options.' }
      return
    }

    const client = new Anthropic({
      apiKey: anthropicApiKey,
      dangerouslyAllowBrowser: true,
      defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' },
    })

    try {
      const stream = client.messages.stream(
        {
          model: model || 'claude-opus-4-8',
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          system: SYSTEM_PROMPT,
          messages: buildMessages(req),
        },
        { signal },
      )

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', delta: event.delta.text }
        }
      }
      yield { type: 'done' }
    } catch (err) {
      if (signal.aborted) return // caller cancelled; not an error to surface
      const message =
        err instanceof Anthropic.APIError
          ? `Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      yield { type: 'error', message }
    }
  }
}
