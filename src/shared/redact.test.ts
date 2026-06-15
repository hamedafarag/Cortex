import { describe, it, expect } from 'vitest'
import { redactSecrets, type Redaction } from './redact'

const PLACEHOLDER = '[REDACTED]'

/** Count occurrences of the placeholder in a string. */
function placeholders(s: string): number {
  return s.split(PLACEHOLDER).length - 1
}

describe('redactSecrets — empty / trivial input', () => {
  it('returns the original empty string with count 0', () => {
    const r = redactSecrets('')
    expect(r).toEqual<Redaction>({ text: '', count: 0 })
  })

  it('treats a single space as ordinary text (no masking)', () => {
    const r = redactSecrets(' ')
    expect(r).toEqual<Redaction>({ text: ' ', count: 0 })
  })

  it('leaves a short, low-entropy string untouched', () => {
    const r = redactSecrets('hello world')
    expect(r).toEqual<Redaction>({ text: 'hello world', count: 0 })
  })

  it('returns a falsy non-string input unchanged via the guard (no throw)', () => {
    // The `if (!text)` guard short-circuits before any regex runs. Callers pass strings,
    // but the guard means undefined/null do not throw — they round-trip with count 0.
    // Cast through unknown because the declared signature is (text: string).
    const u = redactSecrets(undefined as unknown as string)
    expect(u).toEqual({ text: undefined, count: 0 })
    const n = redactSecrets(null as unknown as string)
    expect(n).toEqual({ text: null, count: 0 })
  })
})

describe('redactSecrets — PATTERNS: provider key shapes', () => {
  it('masks an AWS access key id (AKIA…)', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE' // AKIA + 16 chars
    const r = redactSecrets(`const id = "${key}"`)
    expect(r.text).not.toContain(key)
    expect(r.text).toContain(PLACEHOLDER)
    expect(r.count).toBe(1)
  })

  it('does NOT mask an AKIA prefix that is too short to be a real key', () => {
    // AKIA + only 4 chars -> fails the {16} quantifier and the entropy gate
    const r = redactSecrets('AKIA1234')
    expect(r.text).toBe('AKIA1234')
    expect(r.count).toBe(0)
  })

  it('masks a classic GitHub personal access token (ghp_…)', () => {
    const tok = 'ghp_' + 'A'.repeat(36)
    const r = redactSecrets(`token=${tok}`)
    expect(r.text).not.toContain(tok)
    expect(r.count).toBe(1)
  })

  it('masks other GitHub token prefixes (gho/ghu/ghs/ghr)', () => {
    for (const prefix of ['gho', 'ghu', 'ghs', 'ghr']) {
      const tok = `${prefix}_` + 'b'.repeat(40)
      const r = redactSecrets(`x ${tok} y`)
      expect(r.text).not.toContain(tok)
      expect(r.count).toBe(1)
    }
  })

  it('masks a GitHub fine-grained PAT (github_pat_…)', () => {
    const tok = 'github_pat_' + 'A1b2_'.repeat(13) // 65 chars after prefix, includes _
    const r = redactSecrets(`PAT: ${tok}`)
    expect(r.text).not.toContain(tok)
    expect(r.count).toBe(1)
  })

  it('respects the github_pat_ length floor (59 chars below, 60 at)', () => {
    const under = 'github_pat_' + 'a'.repeat(59) // one short of the {60,} floor
    const at = 'github_pat_' + 'a'.repeat(60) // exactly at the floor
    expect(redactSecrets(under).count).toBe(0)
    expect(redactSecrets(under).text).toBe(under)
    expect(redactSecrets(at).count).toBe(1)
    expect(redactSecrets(at).text).toBe(PLACEHOLDER)
  })

  it('respects the OpenAI sk- length floor (19 chars below, 20 at)', () => {
    const under = 'sk-' + 'A1b2C3d4E5f6G7h8I9j' // 19 chars after sk-, below {20,}
    const at = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0' // 20 chars after sk-
    expect(redactSecrets(under).count).toBe(0)
    expect(redactSecrets(under).text).toBe(under)
    expect(redactSecrets(at).count).toBe(1)
    expect(redactSecrets(at).text).toBe(PLACEHOLDER)
  })

  it('masks an Anthropic API key (sk-ant-…)', () => {
    const key = 'sk-ant-api03-' + 'aZ09_-'.repeat(6) // >= 20 chars after sk-ant-
    const r = redactSecrets(`ANTHROPIC_API_KEY=${key}`)
    expect(r.text).not.toContain(key)
    expect(r.count).toBe(1)
  })

  it('masks an OpenAI API key (sk-…)', () => {
    const key = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0' // 20 alnum chars after sk-
    const r = redactSecrets(`openai=${key}`)
    expect(r.text).not.toContain(key)
    expect(r.count).toBe(1)
  })

  it('masks an OpenAI project key (sk-proj-…)', () => {
    const key = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1' // >=20 alnum after prefix
    const r = redactSecrets(`key: ${key}`)
    expect(r.text).not.toContain(key)
    expect(r.count).toBe(1)
  })

  it('masks a Google API key (AIza…)', () => {
    const key = 'AIza' + 'aB3dE6gH9jK2mN5pQ8sT1vW4xY7zZ0_-abc' // 35 chars after AIza
    expect(key.length).toBe(4 + 35)
    const r = redactSecrets(`google=${key}`)
    expect(r.text).not.toContain(key)
    expect(r.count).toBe(1)
  })

  it('masks Slack tokens for each xox[baprs] variant', () => {
    for (const c of ['b', 'a', 'p', 'r', 's']) {
      const tok = `xox${c}-` + '12345-67890-abcdeXYZ' // >= 10 chars after prefix
      const r = redactSecrets(`slack ${tok}`)
      expect(r.text).not.toContain(tok)
      expect(r.count).toBe(1)
    }
  })

  it('masks a Stripe live secret key (sk_live_…)', () => {
    const key = 'sk_live_' + 'A1b2C3d4E5f6G7h8I9j0K1l2' // 24 alnum chars
    const r = redactSecrets(`stripe = "${key}"`)
    expect(r.text).not.toContain(key)
    expect(r.count).toBe(1)
  })

  it('masks a Stripe restricted live key (rk_live_…)', () => {
    const key = 'rk_live_' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
    const r = redactSecrets(`rk=${key}`)
    expect(r.text).not.toContain(key)
    expect(r.count).toBe(1)
  })

  it('masks a JWT (eyJ….eyJ….signature)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const r = redactSecrets(`Authorization: Bearer ${jwt}`)
    expect(r.text).not.toContain(jwt)
    // Header carries an `=` style? No — but ensure JWT was the masked thing.
    expect(r.text).toContain(PLACEHOLDER)
    expect(r.count).toBe(1)
  })

  it('masks a PRIVATE KEY block (BEGIN/END), spanning multiple lines', () => {
    const block = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA1234567890abcdefghijklmnop',
      'qrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0987654',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const code = `const pem = \`${block}\``
    const r = redactSecrets(code)
    expect(r.text).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(r.text).not.toContain('MIIEpAIBAAK')
    expect(r.count).toBe(1)
    expect(r.text).toContain(PLACEHOLDER)
  })

  it('masks an unlabelled PRIVATE KEY block (no algorithm word)', () => {
    const block =
      '-----BEGIN PRIVATE KEY-----\nAAAABBBBCCCCDDDD\n-----END PRIVATE KEY-----'
    const r = redactSecrets(block)
    expect(r.text).not.toContain('AAAABBBBCCCC')
    expect(r.count).toBe(1)
  })

  it('counts multiple distinct provider secrets independently', () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE'
    const gh = 'ghp_' + 'Z'.repeat(36)
    const r = redactSecrets(`a=${aws}\nb=${gh}`)
    expect(r.text).not.toContain(aws)
    expect(r.text).not.toContain(gh)
    expect(r.count).toBe(2)
    expect(placeholders(r.text)).toBe(2)
  })

  it('masks the same secret appearing twice (global flag) and counts both', () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE'
    const r = redactSecrets(`${aws} and again ${aws}`)
    expect(r.text).not.toContain(aws)
    expect(r.count).toBe(2)
    expect(placeholders(r.text)).toBe(2)
  })
})

describe('redactSecrets — ASSIGNMENT: mask value, keep key + quotes', () => {
  it('masks a quoted password value but preserves the key and quotes', () => {
    const r = redactSecrets('password = "hunter2value"')
    expect(r.text).toBe(`password = "${PLACEHOLDER}"`)
    expect(r.count).toBe(1)
  })

  it('preserves single quotes around the masked value', () => {
    const r = redactSecrets("secret: 'mysupersecret'")
    expect(r.text).toBe(`secret: '${PLACEHOLDER}'`)
    expect(r.count).toBe(1)
  })

  it('preserves backtick quotes around the masked value', () => {
    const r = redactSecrets('token = `abcdefgh`')
    expect(r.text).toBe(`token = \`${PLACEHOLDER}\``)
    expect(r.count).toBe(1)
  })

  it('handles the colon assignment form (token: "…")', () => {
    const r = redactSecrets('api_key: "supersecretvalue"')
    expect(r.text).toBe(`api_key: "${PLACEHOLDER}"`)
    expect(r.count).toBe(1)
  })

  it('matches assignment keys case-insensitively', () => {
    const r = redactSecrets('API_KEY = "supersecretvalue"')
    expect(r.text).toBe(`API_KEY = "${PLACEHOLDER}"`)
    expect(r.count).toBe(1)
  })

  it('matches api-key and access-key hyphen variants (unquoted key)', () => {
    const r1 = redactSecrets('api-key = "secretvalue123"')
    expect(r1.text).toBe(`api-key = "${PLACEHOLDER}"`)
    expect(r1.count).toBe(1)

    const r2 = redactSecrets('access-key = "anothersecret1"')
    expect(r2.text).toBe(`access-key = "${PLACEHOLDER}"`)
    expect(r2.count).toBe(1)
  })

  it('masks a quoted JSON-style key value (double quotes)', () => {
    // `"api-key": "..."` — the canonical JSON/YAML secret shape. The optional closing quote
    // after the keyword lets the assignment shape match; the value is masked, key + quotes kept.
    const r = redactSecrets('"api-key": "secretvalue123"')
    expect(r.text).toBe(`"api-key": "${PLACEHOLDER}"`)
    expect(r.count).toBe(1)
  })

  it('masks a single-quoted JSON-style key value too', () => {
    // Same shape with single quotes — the fix is not specific to double quotes.
    const r = redactSecrets("'api-key': 'secretvalue123'")
    expect(r.text).toBe(`'api-key': '${PLACEHOLDER}'`)
    expect(r.count).toBe(1)
  })

  it('masks two distinct assignments on the same line and counts both', () => {
    const r = redactSecrets('a password="secretone1" b token="secrettwo2"')
    expect(r.text).toBe(`a password="${PLACEHOLDER}" b token="${PLACEHOLDER}"`)
    expect(r.count).toBe(2)
    expect(placeholders(r.text)).toBe(2)
  })

  it('masks an all-whitespace value once it clears the 6-char floor', () => {
    // The value class [^'"`\n] permits spaces, so six spaces satisfy {6,}. Documents that
    // the floor is purely length-based, not content-based.
    const r = redactSecrets('password = "      "') // six spaces
    expect(r.text).toBe(`password = "${PLACEHOLDER}"`)
    expect(r.count).toBe(1)
  })

  it('matches bearer / client_secret / auth_token keywords', () => {
    const r1 = redactSecrets('bearer = "abcdef123456"')
    expect(r1.text).toBe(`bearer = "${PLACEHOLDER}"`)
    const r2 = redactSecrets('client_secret = "abcdef123456"')
    expect(r2.text).toBe(`client_secret = "${PLACEHOLDER}"`)
    const r3 = redactSecrets('auth_token = "abcdef123456"')
    expect(r3.text).toBe(`auth_token = "${PLACEHOLDER}"`)
  })

  it('does NOT mask a value shorter than 6 chars (below the {6,} floor)', () => {
    const r = redactSecrets('password = "short"') // 5 chars
    expect(r.text).toBe('password = "short"')
    expect(r.count).toBe(0)
  })

  it('masks a value exactly at the 6-char floor', () => {
    const r = redactSecrets('password = "abcdef"') // exactly 6 chars
    expect(r.text).toBe(`password = "${PLACEHOLDER}"`)
    expect(r.count).toBe(1)
  })

  it('does NOT mask a key that is not in the secret keyword list', () => {
    const r = redactSecrets('username = "johndoe123"')
    expect(r.text).toBe('username = "johndoe123"')
    expect(r.count).toBe(0)
  })

  it('does not span across a newline inside the quoted value', () => {
    // [^\'"`\n] excludes newlines, so a value containing a newline before the
    // closing quote should not match the assignment shape.
    const r = redactSecrets('password = "abc\ndef"')
    expect(r.count).toBe(0)
    expect(r.text).toBe('password = "abc\ndef"')
  })
})

describe('redactSecrets — TOKEN entropy gate', () => {
  it('masks a random mixed-charset 32+ token', () => {
    // Mixed lower+upper+digit, length 40, deliberately high-entropy.
    const tok = 'aZ3kQ9wL2pE7rT1yU5iO0sD4fG8hJ6bN3mXcVbA'
    expect(tok.length).toBeGreaterThanOrEqual(32)
    const r = redactSecrets(`const x = ${tok}`)
    expect(r.text).not.toContain(tok)
    expect(r.count).toBe(1)
  })

  it('does NOT mask a hex SHA (no uppercase letters -> fails charset gate)', () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' // 40 hex chars, all lowercase
    expect(sha.length).toBeGreaterThanOrEqual(32)
    const r = redactSecrets(`commit ${sha}`)
    expect(r.text).toContain(sha)
    expect(r.count).toBe(0)
  })

  it('does NOT mask a lowercase UUID (hyphens break the token + no uppercase)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const r = redactSecrets(`id: ${uuid}`)
    expect(r.text).toContain(uuid)
    expect(r.count).toBe(0)
  })

  it('does NOT mask an all-lowercase identifier of 32+ chars', () => {
    const ident = 'thisisaverylongallloweridentifierxyz' // all lowercase, length >= 32
    expect(ident.length).toBeGreaterThanOrEqual(32)
    const r = redactSecrets(`let ${ident} = 1`)
    expect(r.text).toContain(ident)
    expect(r.count).toBe(0)
  })

  it('does NOT mask a camelCase identifier of 32+ chars (entropy below 4.5)', () => {
    const ident = 'getUserAccountSettingsFromRemoteServerNow' // camelCase, no digits
    expect(ident.length).toBeGreaterThanOrEqual(32)
    const r = redactSecrets(`const ${ident} = fn`)
    expect(r.text).toContain(ident)
    expect(r.count).toBe(0)
  })

  it('does NOT mask a mixed-charset token shorter than 32 chars', () => {
    const tok = 'aZ3kQ9wL2pE7rT1yU5' // 18 chars, mixed but under the {32,} floor
    expect(tok.length).toBeLessThan(32)
    const r = redactSecrets(`x = ${tok}`)
    expect(r.text).toContain(tok)
    expect(r.count).toBe(0)
  })

  it('does NOT mask a token missing a digit even if mixed case & long', () => {
    // looksRandom requires a digit; a long mixed-case-but-no-digit token is left alone.
    const tok = 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj' // no digits, length >= 32
    expect(tok.length).toBeGreaterThanOrEqual(32)
    const r = redactSecrets(`v = ${tok}`)
    expect(r.text).toContain(tok)
    expect(r.count).toBe(0)
  })

  it('does NOT mask a long all-digit number (fails letter gates)', () => {
    const digits = '1234567890123456789012345678901234567890'
    const r = redactSecrets(`n = ${digits}`)
    expect(r.text).toContain(digits)
    expect(r.count).toBe(0)
  })

  it('masks at the exact 32-char boundary for a high-entropy mixed token', () => {
    const tok = 'aZ3kQ9wL2pE7rT1yU5iO0sD4fG8hJ6bN' // exactly 32 chars, mixed
    expect(tok.length).toBe(32)
    const r = redactSecrets(`x=${tok}`)
    expect(r.text).not.toContain(tok)
    expect(r.count).toBe(1)
  })
})

describe('redactSecrets — no false positives on ordinary code', () => {
  it('leaves a normal function definition untouched', () => {
    const code = [
      'function add(a, b) {',
      '  return a + b // simple sum',
      '}',
      'const result = add(1, 2)',
    ].join('\n')
    const r = redactSecrets(code)
    expect(r.text).toBe(code)
    expect(r.count).toBe(0)
  })

  it('leaves typical import / URL lines untouched', () => {
    const code = [
      "import { foo } from './bar'",
      'const url = "https://example.com/api/v1/users?page=2"',
      'const items = data.map((x) => x.id)',
    ].join('\n')
    const r = redactSecrets(code)
    expect(r.text).toBe(code)
    expect(r.count).toBe(0)
  })

  it('does not mask short hex color or numeric literals', () => {
    const code = 'const color = "#ff8800"; const n = 42; const big = 1_000_000'
    const r = redactSecrets(code)
    expect(r.text).toBe(code)
    expect(r.count).toBe(0)
  })

  it('does not treat ordinary prose as a secret', () => {
    const prose =
      'The quick brown fox jumps over the lazy dog repeatedly every single morning.'
    const r = redactSecrets(prose)
    expect(r.text).toBe(prose)
    expect(r.count).toBe(0)
  })
})

describe('redactSecrets — count accuracy across mixed inputs', () => {
  it('sums PATTERN + ASSIGNMENT + TOKEN masks into one count', () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE' // pattern
    const randomTok = 'aZ3kQ9wL2pE7rT1yU5iO0sD4fG8hJ6bN3mXcVbA' // token entropy
    const code = [
      `const k = "${aws}"`,
      'password = "supersecret1"', // assignment
      `const raw = ${randomTok}`,
    ].join('\n')
    const r = redactSecrets(code)
    expect(r.count).toBe(3)
    expect(r.text).not.toContain(aws)
    expect(r.text).not.toContain('supersecret1')
    expect(r.text).not.toContain(randomTok)
    expect(placeholders(r.text)).toBe(3)
  })

  it('returns a count equal to the number of placeholders inserted', () => {
    const r = redactSecrets(
      `AKIAIOSFODNN7EXAMPLE AKIAIOSFODNN7EXAMPLE AKIAIOSFODNN7EXAMPLE`,
    )
    expect(r.count).toBe(3)
    expect(placeholders(r.text)).toBe(3)
  })

  it('does not double-count a provider key that the TOKEN regex might also see', () => {
    // ghp_ token is masked by PATTERNS first; the resulting [REDACTED] should not be
    // re-masked by the TOKEN stage. Count must be exactly 1.
    const tok = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' // 36 chars after ghp_
    const r = redactSecrets(`token = ${tok}`)
    expect(r.count).toBe(1)
    expect(placeholders(r.text)).toBe(1)
  })

  it('is idempotent on re-redaction — stable text AND a zero count on a no-op pass', () => {
    // The ASSIGNMENT replacer skips a value that is already the placeholder, so a second pass
    // over already-redacted text leaves it unchanged and reports count 0 (nothing newly masked).
    const once = redactSecrets('password = "supersecret1"')
    expect(once.text).toBe(`password = "${PLACEHOLDER}"`)
    const twice = redactSecrets(once.text)
    expect(twice.text).toBe(once.text) // text is stable
    expect(twice.count).toBe(0) // no new secret masked → honest count
  })

  it('counts each occurrence of a repeated JWT exactly once (no token double-count)', () => {
    // A JWT is caught by PATTERNS; the resulting [REDACTED] must not be re-counted by the
    // TOKEN stage. Asserts placeholders === count, which the JWT happy-path test omitted.
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const r = redactSecrets(`${jwt} ${jwt}`)
    expect(r.count).toBe(2)
    expect(placeholders(r.text)).toBe(2)
    expect(r.text).not.toContain('eyJ')
  })

  it('does not re-mask a placeholder that stands alone (no surrounding key/quotes)', () => {
    // A bare [REDACTED] from a PATTERN/TOKEN replacement is not re-masked: it is short, has
    // no digit, and is not in an assignment, so a second pass leaves it and reports count 0.
    const r = redactSecrets(`${PLACEHOLDER} ${PLACEHOLDER}`)
    expect(r.text).toBe(`${PLACEHOLDER} ${PLACEHOLDER}`)
    expect(r.count).toBe(0)
  })
})

describe('redactSecrets — purity & return shape', () => {
  it('returns the same string reference semantics: original input is not mutated', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE'
    const copy = String(input)
    redactSecrets(input)
    expect(input).toBe(copy)
  })

  it('always returns an object with text:string and count:number', () => {
    const r = redactSecrets('nothing secret here')
    expect(typeof r.text).toBe('string')
    expect(typeof r.count).toBe('number')
    expect(Number.isInteger(r.count)).toBe(true)
  })
})
