// Background service worker — owns all LLM calls.
//
// Content scripts open a long-lived port (PORT_NAME). Each ASK is resolved to a
// provider, streamed, and relayed back as CHUNK/DONE/ERROR. Each request gets an
// AbortController so ABORT (or a port disconnect) cancels it promptly.

import {
  PORT_NAME,
  type ContentToBackground,
  type BackgroundToContent,
} from '../shared/messages'
import type { AskRequest } from '../shared/types'
import { registry, NoProviderAvailableError } from './providers/registry'
import { AnthropicProvider } from './providers/anthropic'
import { ClaudeCodeProvider } from './providers/claudeCode'

console.debug('[YCRA] background service worker loaded')

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
