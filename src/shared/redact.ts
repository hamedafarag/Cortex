// Mask obvious secrets in code before it leaves the browser for the model. Pure and
// dependency-free so it runs anywhere and is easy to unit-test. Deliberately conservative —
// a few high-confidence shapes plus a strict high-entropy check — so it doesn't mangle
// ordinary code. Reports how many secrets it masked so the dock can tell the reviewer.

const PLACEHOLDER = '[REDACTED]'

/** High-confidence secret shapes: provider key prefixes, private-key blocks, JWTs. */
const PATTERNS: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, // GitHub fine-grained PAT
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic API key
  /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g, // OpenAI API key
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack token
  /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}\b/g, // Stripe live key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
]

/** `secret = "value"` / `token: "value"` style — mask just the value, keep the key + quotes. */
const ASSIGNMENT =
  /(\b(?:passwd|password|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token|bearer)\b['"`]?\s*[:=]\s*['"`])([^'"`\n]{6,})(['"`])/gi

/** A standalone long token; the entropy + charset checks below decide if it's secret-like. */
const TOKEN = /\b[A-Za-z0-9+/_=-]{32,}\b/g

export interface Redaction {
  text: string
  count: number
}

/** Shannon entropy in bits/char — random tokens score high, words and hex score lower. */
function entropy(s: string): number {
  const freq = new Map<string, number>()
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** True if `s` looks like a random secret: mixed charset (excludes hex SHAs, UUIDs,
 *  all-one-case identifiers) and high entropy. The 4.5 bits/char threshold sits in the gap
 *  between camelCase identifiers (~4.2, measured) and random tokens (~4.6+), so it's a backstop
 *  for *unnamed* secrets without mangling ordinary code (named secrets are caught above). */
function looksRandom(s: string): boolean {
  return (
    /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s) && entropy(s) >= 4.5
  )
}

/** Replace obvious secrets with a placeholder; returns the masked text + how many were masked. */
export function redactSecrets(text: string): Redaction {
  if (!text) return { text, count: 0 }
  let count = 0
  let out = text
  for (const re of PATTERNS) {
    out = out.replace(re, () => {
      count++
      return PLACEHOLDER
    })
  }
  out = out.replace(ASSIGNMENT, (m, key: string, val: string, quote: string) => {
    if (val === PLACEHOLDER) return m // already masked — keep the count idempotent
    count++
    return `${key}${PLACEHOLDER}${quote}`
  })
  out = out.replace(TOKEN, (m) => {
    if (!looksRandom(m)) return m
    count++
    return PLACEHOLDER
  })
  return { text: out, count }
}
