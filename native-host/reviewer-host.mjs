#!/usr/bin/env node
// Native messaging host for Your Code Review Assistant (provider B).
//
// Bridges the extension's background worker to the local `claude` CLI so the dock
// can ride the user's Claude subscription. Speaks Chrome native messaging on
// stdin/stdout (4-byte little-endian length prefix + UTF-8 JSON) and shells out to
// `claude -p` in lean mode (no MCP / user settings / file tools) for each ask.
//
// IMPORTANT: stdout carries ONLY native-messaging frames — never console.log here.
// Diagnostics go to stderr (the browser discards or logs it).

import { spawn } from 'node:child_process'
import os from 'node:os'

const CLAUDE_BIN = process.env.YCRA_CLAUDE_BIN || 'claude'

const SYSTEM_PROMPT =
  'You are an expert code reviewer assisting a human reviewer inside a GitHub ' +
  'pull request. The reviewer highlights code in the diff and asks about it. ' +
  'Answer concisely and concretely, grounded in the provided code and diff, in ' +
  'GitHub-flavored markdown. Use any PR title/description to judge whether the ' +
  'change does what it claims, not just whether it is locally correct. Do not use ' +
  'any tools; answer directly from the provided context. If the context is ' +
  'insufficient, say what else you would need.'

// Tools we disallow so the model answers directly (and to trim context).
const DISALLOWED_TOOLS =
  'Bash Read Edit Write MultiEdit Glob Grep WebFetch WebSearch NotebookEdit'

/** id -> child process, so an `abort` can kill the right run. */
const children = new Map()

// ---- native messaging output --------------------------------------------------

function send(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(json.length, 0)
  process.stdout.write(Buffer.concat([header, json]))
}

// ---- prompt assembly (mirrors the Anthropic provider) -------------------------

export function buildPrompt(request) {
  const { context, question, history } = request
  const parts = []
  if (history?.length) {
    parts.push(
      'Conversation so far:\n' +
        history
          .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
          .join('\n\n'),
    )
  }
  parts.push(`Pull request: ${context.repo} #${context.prNumber}`)
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
  if (context.prPatches) {
    parts.push(`Changed files (diffs):\n\`\`\`diff\n${context.prPatches}\n\`\`\``)
  }
  parts.push(`Question: ${question}`)
  return parts.join('\n\n')
}

// ---- ask handling -------------------------------------------------------------

function handleAsk(id, request, model) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disallowedTools', DISALLOWED_TOOLS,
    '--system-prompt', SYSTEM_PROMPT,
  ]
  if (model) args.push('--model', model)

  let child
  try {
    // Run in a neutral cwd so no project CLAUDE.md / .claude config is picked up.
    child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    send({ type: 'error', id, message: `Failed to launch claude: ${err.message}` })
    return
  }
  children.set(id, child)

  child.stdin.on('error', () => {}) // ignore EPIPE if the child dies early
  child.stdin.write(buildPrompt(request))
  child.stdin.end()

  let buffer = ''
  let errorResult = null
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (data) => {
    buffer += data
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        continue // partial/non-JSON line; skip
      }
      if (
        evt.type === 'stream_event' &&
        evt.event?.type === 'content_block_delta' &&
        evt.event.delta?.type === 'text_delta'
      ) {
        send({ type: 'chunk', id, delta: evt.event.delta.text })
      } else if (evt.type === 'result' && evt.is_error) {
        errorResult = evt.result || 'Claude reported an error.'
      }
    }
  })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => {
    stderr += d
  })

  child.on('error', (err) => {
    children.delete(id)
    send({
      type: 'error',
      id,
      message: `Could not run claude (${err.message}). Is the Claude CLI installed and on PATH?`,
    })
  })

  child.on('close', (code) => {
    children.delete(id)
    if (errorResult) {
      send({ type: 'error', id, message: String(errorResult) })
    } else if (code && code !== 0) {
      send({
        type: 'error',
        id,
        message: `claude exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`,
      })
    } else {
      send({ type: 'done', id })
    }
  })
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return
  if (message.type === 'ask' && typeof message.id === 'string' && message.request) {
    handleAsk(message.id, message.request, message.model)
  } else if (message.type === 'abort' && typeof message.id === 'string') {
    const child = children.get(message.id)
    if (child) {
      child.kill('SIGTERM')
      children.delete(message.id)
    }
  }
}

// ---- native messaging input ---------------------------------------------------

let input = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  while (input.length >= 4) {
    const length = input.readUInt32LE(0)
    if (input.length < 4 + length) break
    const payload = input.subarray(4, 4 + length)
    input = input.subarray(4 + length)
    try {
      handleMessage(JSON.parse(payload.toString('utf8')))
    } catch {
      // malformed frame; ignore
    }
  }
})
process.stdin.on('end', () => {
  for (const child of children.values()) child.kill('SIGTERM')
  process.exit(0)
})
