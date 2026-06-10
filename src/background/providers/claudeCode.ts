// Provider B — the Claude Code CLI backend, reached through the native-messaging
// host (native-host/reviewer-host.mjs), which shells out to the local `claude`
// CLI on the user's subscription.

import type { AskRequest, Chunk } from '../../shared/types'
import { getSettings } from '../../shared/storage'
import {
  NATIVE_HOST_NAME,
  type BackgroundToHost,
  type HostToBackground,
} from '../../shared/messages'
import type { LlmProvider } from './types'

const HOST_MISSING_MESSAGE =
  'The Claude Code native host is not installed. Run native-host/install.sh, then ' +
  'fully restart the browser.'

export class ClaudeCodeProvider implements LlmProvider {
  readonly id = 'claude-code-cli' as const

  /** Available if connecting to the native host doesn't immediately disconnect. */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      let port: chrome.runtime.Port
      try {
        port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
      } catch {
        resolve(false)
        return
      }
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        try {
          port.disconnect()
        } catch {
          // ignore
        }
        resolve(value)
      }
      port.onDisconnect.addListener(() => finish(false)) // host not found → disconnects
      // If it's still connected after a moment, the host is there.
      setTimeout(() => finish(true), 250)
    })
  }

  async *ask(req: AskRequest, signal: AbortSignal): AsyncIterable<Chunk> {
    const { model } = await getSettings()
    const id = crypto.randomUUID()

    const chunks: Chunk[] = []
    let finished = false
    let wake: (() => void) | null = null

    const emit = (chunk: Chunk): void => {
      chunks.push(chunk)
      if (chunk.type === 'done' || chunk.type === 'error') finished = true
      wake?.()
      wake = null
    }

    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    } catch {
      yield { type: 'error', message: HOST_MISSING_MESSAGE }
      return
    }

    port.onMessage.addListener((msg: HostToBackground) => {
      if (msg.id !== id) return
      if (msg.type === 'chunk') emit({ type: 'text', delta: msg.delta })
      else if (msg.type === 'done') emit({ type: 'done' })
      else if (msg.type === 'error') emit({ type: 'error', message: msg.message })
    })

    port.onDisconnect.addListener(() => {
      const lastError = chrome.runtime.lastError
      if (!finished) {
        emit({
          type: 'error',
          message: lastError?.message
            ? `Native host disconnected: ${lastError.message}`
            : HOST_MISSING_MESSAGE,
        })
      }
    })

    const onAbort = (): void => {
      try {
        port.postMessage({ type: 'abort', id } satisfies BackgroundToHost)
        port.disconnect()
      } catch {
        // ignore
      }
      if (!finished) emit({ type: 'done' })
    }
    signal.addEventListener('abort', onAbort)

    port.postMessage({ type: 'ask', id, request: req, model } satisfies BackgroundToHost)

    try {
      while (true) {
        if (chunks.length) {
          const chunk = chunks.shift()!
          yield chunk
          if (chunk.type === 'done' || chunk.type === 'error') return
        } else if (finished) {
          return
        } else {
          await new Promise<void>((resolve) => (wake = resolve))
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      try {
        port.disconnect()
      } catch {
        // ignore
      }
    }
  }
}
