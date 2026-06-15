import { describe, it, expect } from 'vitest'
import { buildUserContent } from './prompt'
import type { AskRequest, AskContext } from './types'

// Minimal valid request: only the required context fields (repo/prNumber) plus a question.
function minimal(overrides: Partial<AskContext> = {}, question = 'Why?'): AskRequest {
  return {
    question,
    context: { repo: 'owner/name', prNumber: 42, ...overrides },
  }
}

describe('buildUserContent', () => {
  describe('required header + question (minimal request)', () => {
    it('always leads with the pull-request header line', () => {
      const out = buildUserContent(minimal())
      expect(out.startsWith('Pull request: owner/name #42')).toBe(true)
    })

    it('always ends with the question line', () => {
      const out = buildUserContent(minimal({}, 'What does this do?'))
      expect(out.endsWith('Question: What does this do?')).toBe(true)
    })

    it('emits ONLY header + question when no optional context is present', () => {
      const out = buildUserContent(minimal())
      expect(out).toBe('Pull request: owner/name #42\n\nQuestion: Why?')
    })

    it('omits every optional section when context has only repo/prNumber', () => {
      const out = buildUserContent(minimal())
      expect(out).not.toContain('PR title:')
      expect(out).not.toContain('PR description:')
      expect(out).not.toContain('File:')
      expect(out).not.toContain('Lines:')
      expect(out).not.toContain('Selected code:')
      expect(out).not.toContain('Surrounding diff:')
      expect(out).not.toContain('Changed files (diffs):')
    })

    it('uses a blank-line (\\n\\n) separator between sections', () => {
      const out = buildUserContent(minimal({ file: 'src/a.ts' }))
      expect(out).toBe('Pull request: owner/name #42\n\nFile: src/a.ts\n\nQuestion: Why?')
    })
  })

  describe('PR intent grounding (title / body)', () => {
    it('includes the PR title when present', () => {
      const out = buildUserContent(minimal({ prTitle: 'Add caching layer' }))
      expect(out).toContain('PR title: Add caching layer')
    })

    it('includes the PR description on its own line after a newline', () => {
      const out = buildUserContent(minimal({ prBody: 'Long description here' }))
      expect(out).toContain('PR description:\nLong description here')
    })

    it('orders PR title before PR description', () => {
      const out = buildUserContent(minimal({ prTitle: 'T', prBody: 'B' }))
      expect(out.indexOf('PR title: T')).toBeLessThan(out.indexOf('PR description:\nB'))
    })

    it('puts PR title/description after the header but before the question', () => {
      const out = buildUserContent(minimal({ prTitle: 'T', prBody: 'B' }))
      expect(out.indexOf('Pull request:')).toBeLessThan(out.indexOf('PR title: T'))
      expect(out.indexOf('PR description:\nB')).toBeLessThan(out.indexOf('Question:'))
    })

    it('omits PR title when absent but keeps the description', () => {
      const out = buildUserContent(minimal({ prBody: 'B only' }))
      expect(out).not.toContain('PR title:')
      expect(out).toContain('PR description:\nB only')
    })
  })

  describe('file / line context', () => {
    it('includes the file path', () => {
      const out = buildUserContent(minimal({ file: 'src/app.ts' }))
      expect(out).toContain('File: src/app.ts')
    })

    it('renders the line range as start-end', () => {
      const out = buildUserContent(minimal({ lineRange: [10, 25] }))
      expect(out).toContain('Lines: 10-25')
    })

    it('renders a single-line range as N-N', () => {
      const out = buildUserContent(minimal({ lineRange: [7, 7] }))
      expect(out).toContain('Lines: 7-7')
    })

    it('orders File before Lines', () => {
      const out = buildUserContent(minimal({ file: 'src/a.ts', lineRange: [1, 2] }))
      expect(out.indexOf('File: src/a.ts')).toBeLessThan(out.indexOf('Lines: 1-2'))
    })
  })

  describe('selected code fencing', () => {
    it('wraps the selected code in a fenced block with the language hint', () => {
      const out = buildUserContent(minimal({ selectedCode: 'const x = 1', language: 'ts' }))
      expect(out).toContain('Selected code:\n```ts\nconst x = 1\n```')
    })

    it('emits an empty language tag when language is absent', () => {
      const out = buildUserContent(minimal({ selectedCode: 'foo()' }))
      expect(out).toContain('Selected code:\n```\nfoo()\n```')
    })

    it('does not emit a Selected code section when selectedCode is absent (even if language is set)', () => {
      // Use a distinctive language token so the leak check isn't a coincidental
      // 2-char-substring match against repo/file names ('ts' appears in '.ts' paths).
      const out = buildUserContent(minimal({ language: 'zzlangzz' }))
      expect(out).not.toContain('Selected code:')
      // language is only ever interpolated inside the selected-code fence
      expect(out).not.toContain('zzlangzz')
      expect(out).not.toContain('```')
      // and the whole prompt collapses to header + question
      expect(out).toBe('Pull request: owner/name #42\n\nQuestion: Why?')
    })

    it('treats an empty-string language the same as an absent one (empty fence tag)', () => {
      // Source uses `context.language ?? ''`, so '' and undefined both yield ```\n.
      const empty = buildUserContent(minimal({ selectedCode: 'x', language: '' }))
      const absent = buildUserContent(minimal({ selectedCode: 'x' }))
      expect(empty).toContain('Selected code:\n```\nx\n```')
      expect(empty).toBe(absent)
    })

    it('does not collapse a real language to empty when only language differs', () => {
      // Guards the `?? ''` fallback: a meaningful hint must survive into the fence.
      const out = buildUserContent(minimal({ selectedCode: 'x', language: 'python' }))
      expect(out).toContain('Selected code:\n```python\nx\n```')
    })

    it('interpolates the language hint raw into the fence info-string (no sanitization)', () => {
      // Characterization of CURRENT behavior: language is not escaped. A hint containing
      // backticks/newlines would corrupt the fence. Not a bug (language is a derived
      // extension hint, never user-controlled) — locked so a silent change is caught.
      const out = buildUserContent(minimal({ selectedCode: 'x', language: 'js\n```' }))
      expect(out).toContain('Selected code:\n```js\n```\nx\n```')
    })

    it('preserves multi-line selected code verbatim', () => {
      const code = 'function f() {\n  return 1\n}'
      const out = buildUserContent(minimal({ selectedCode: code, language: 'js' }))
      expect(out).toContain('Selected code:\n```js\n' + code + '\n```')
    })

    it('orders Selected code after Lines and before Surrounding diff', () => {
      const out = buildUserContent(
        minimal({ lineRange: [1, 2], selectedCode: 'x', diffHunk: '+y' }),
      )
      expect(out.indexOf('Lines: 1-2')).toBeLessThan(out.indexOf('Selected code:'))
      expect(out.indexOf('Selected code:')).toBeLessThan(out.indexOf('Surrounding diff:'))
    })
  })

  describe('diff grounding (diffHunk / prPatches)', () => {
    it('fences the surrounding diff hunk as ```diff', () => {
      const out = buildUserContent(minimal({ diffHunk: '@@ -1 +1 @@\n-old\n+new' }))
      expect(out).toContain('Surrounding diff:\n```diff\n@@ -1 +1 @@\n-old\n+new\n```')
    })

    it('fences the whole-PR patches as ```diff under "Changed files (diffs):"', () => {
      const out = buildUserContent(minimal({ prPatches: 'diff --git a/x b/x' }))
      expect(out).toContain('Changed files (diffs):\n```diff\ndiff --git a/x b/x\n```')
    })

    it('orders Surrounding diff before Changed files', () => {
      const out = buildUserContent(minimal({ diffHunk: '+a', prPatches: '+b' }))
      expect(out.indexOf('Surrounding diff:')).toBeLessThan(out.indexOf('Changed files (diffs):'))
    })

    it('omits diff sections when both diff fields are absent', () => {
      const out = buildUserContent(minimal({ selectedCode: 'x' }))
      expect(out).not.toContain('Surrounding diff:')
      expect(out).not.toContain('Changed files (diffs):')
    })

    it('can include prPatches without diffHunk', () => {
      const out = buildUserContent(minimal({ prPatches: 'whole pr' }))
      expect(out).not.toContain('Surrounding diff:')
      expect(out).toContain('Changed files (diffs):\n```diff\nwhole pr\n```')
    })
  })

  describe('full ordering (all sections present)', () => {
    it('produces a stable, fully-ordered prompt with every section', () => {
      const req: AskRequest = {
        question: 'Is this safe?',
        context: {
          repo: 'acme/widgets',
          prNumber: 7,
          prTitle: 'Refactor parser',
          prBody: 'Cleans up the tokenizer.',
          file: 'src/parser.ts',
          lineRange: [12, 18],
          selectedCode: 'parse(input)',
          language: 'ts',
          diffHunk: '@@ hunk @@',
          prPatches: 'diff --git a/parser b/parser',
        },
      }
      const out = buildUserContent(req)
      expect(out).toBe(
        [
          'Pull request: acme/widgets #7',
          'PR title: Refactor parser',
          'PR description:\nCleans up the tokenizer.',
          'File: src/parser.ts',
          'Lines: 12-18',
          'Selected code:\n```ts\nparse(input)\n```',
          'Surrounding diff:\n```diff\n@@ hunk @@\n```',
          'Changed files (diffs):\n```diff\ndiff --git a/parser b/parser\n```',
          'Question: Is this safe?',
        ].join('\n\n'),
      )
    })

    it('keeps the relative section order regardless of which optional fields are present', () => {
      const out = buildUserContent(
        minimal({
          prTitle: 'T',
          file: 'f',
          selectedCode: 'c',
          prPatches: 'p',
        }),
      )
      const order = ['Pull request:', 'PR title:', 'File:', 'Selected code:', 'Changed files (diffs):', 'Question:']
      const positions = order.map((s) => out.indexOf(s))
      const sorted = [...positions].sort((a, b) => a - b)
      expect(positions).toEqual(sorted)
      expect(positions.every((p) => p >= 0)).toBe(true)
    })
  })

  describe('edge cases / boundaries', () => {
    it('handles an empty question (still emits a trailing Question: line)', () => {
      const out = buildUserContent(minimal({}, ''))
      expect(out.endsWith('Question: ')).toBe(true)
    })

    it('treats empty-string optional fields as absent (falsy guard)', () => {
      const out = buildUserContent(
        minimal({ prTitle: '', prBody: '', file: '', selectedCode: '', diffHunk: '', prPatches: '' }),
      )
      // Empty strings are falsy, so none of these sections should appear.
      expect(out).toBe('Pull request: owner/name #42\n\nQuestion: Why?')
    })

    it('omits the Lines section when lineRange is absent even with a file', () => {
      const out = buildUserContent(minimal({ file: 'a.ts' }))
      expect(out).toContain('File: a.ts')
      expect(out).not.toContain('Lines:')
    })

    it('handles prNumber 0 in the header', () => {
      const out = buildUserContent(minimal({}, 'q'))
      // sanity: default minimal uses 42; build an explicit zero case
      const zero = buildUserContent({ question: 'q', context: { repo: 'r/n', prNumber: 0 } })
      expect(zero.startsWith('Pull request: r/n #0')).toBe(true)
      expect(out).toContain('#42')
    })

    it('handles lineRange [0, 0]', () => {
      const out = buildUserContent(minimal({ lineRange: [0, 0] }))
      expect(out).toContain('Lines: 0-0')
    })

    it('renders the line range verbatim without normalizing a reversed range', () => {
      // Characterization: no min/max — start/end are emitted exactly as given.
      const out = buildUserContent(minimal({ lineRange: [25, 10] }))
      expect(out).toContain('Lines: 25-10')
    })

    it('keeps section ordering even when a body contains label-like substrings', () => {
      // A prBody mentioning "Question:" must not confuse the real trailing question line:
      // the assembled question is always the final section.
      const out = buildUserContent(
        minimal({ prBody: 'See Question: below and File: notes' }, 'real?'),
      )
      expect(out.endsWith('Question: real?')).toBe(true)
      // the body's literal text is preserved inside the PR description section
      expect(out).toContain('PR description:\nSee Question: below and File: notes')
      // exactly one real File: section label exists? none here (no file field) —
      // the body's "File:" is just prose, not a generated section.
      expect(out).not.toContain('\n\nFile:')
    })

    it('preserves special characters / backticks in selected code without escaping', () => {
      const code = 'const s = `a ${b} c`'
      const out = buildUserContent(minimal({ selectedCode: code }))
      expect(out).toContain('Selected code:\n```\n' + code + '\n```')
    })

    it('does not mutate the input request object', () => {
      const req = minimal({ file: 'a.ts', selectedCode: 'x' })
      const snapshot = JSON.stringify(req)
      buildUserContent(req)
      expect(JSON.stringify(req)).toBe(snapshot)
    })

    it('is deterministic — identical input yields identical output', () => {
      const req = minimal({ prTitle: 'T', file: 'f', lineRange: [3, 9], selectedCode: 'c', diffHunk: 'd' })
      expect(buildUserContent(req)).toBe(buildUserContent(req))
    })

    it('ignores history and mode (not part of the assembled user content)', () => {
      const withExtras: AskRequest = {
        ...minimal({ file: 'a.ts' }),
        history: [{ role: 'user', content: 'earlier' }],
        mode: 'review',
      }
      const without = buildUserContent(minimal({ file: 'a.ts' }))
      expect(buildUserContent(withExtras)).toBe(without)
      expect(buildUserContent(withExtras)).not.toContain('earlier')
    })
  })
})
