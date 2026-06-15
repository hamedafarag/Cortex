// Regression tests for the GitHub diff selection -> {file,line,side,code} parser.
//
// We build jsdom fixtures mirroring BOTH GitHub diff DOMs:
//   * Legacy "/files" view  : <table> rows, line-number cells, data-path / data-tagsearch-path
//   * New "/changes" view    : aria-label="Diff for: <path>", data-line-number + data-diff-side
// and drive window.getSelection() with real Ranges over the fixtures.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureSelection, reviewTarget, type SelectionContext } from './selection'

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

/** Drive window.getSelection() to span from `start` to `end` (text or element nodes). */
function selectRange(start: Node, end: Node): void {
  const sel = window.getSelection()!
  sel.removeAllRanges()
  const range = document.createRange()
  // selectNodeContents picks the right offsets whether it's a text or element node.
  range.setStart(start, 0)
  if (end.nodeType === Node.TEXT_NODE) {
    range.setEnd(end, (end as Text).data.length)
  } else {
    range.setEnd(end, end.childNodes.length)
  }
  sel.addRange(range)
}

/** Collapse / clear the selection entirely. */
function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Legacy "Files changed" table. Each row:
 *   - left gutter cell (old line no)   : data-line-number, data-diff-side="left", user-select:none
 *   - right gutter cell (new line no)  : data-line-number, data-diff-side="right", user-select:none
 *   - code cell                        : the selectable diff text
 * The file path lives on an ancestor as data-tagsearch-path / data-path.
 */
function legacyDiff(opts: {
  path?: string
  rows: Array<{ leftNo?: number; rightNo?: number; code: string }>
}): HTMLElement {
  const path = opts.path ?? 'src/app.ts'
  const rowsHtml = opts.rows
    .map((r) => {
      const left =
        r.leftNo === undefined
          ? `<td class="blob-num" style="user-select:none"></td>`
          : `<td class="blob-num" style="user-select:none" data-line-number="${r.leftNo}" data-diff-side="left"></td>`
      const right =
        r.rightNo === undefined
          ? `<td class="blob-num" style="user-select:none"></td>`
          : `<td class="blob-num" style="user-select:none" data-line-number="${r.rightNo}" data-diff-side="right"></td>`
      return `<tr>${left}${right}<td class="blob-code"><span class="code">${r.code}</span></td></tr>`
    })
    .join('')
  return mount(
    `<div data-tagsearch-path="${path}" data-path="${path}">` +
      `<table class="diff-table"><tbody>${rowsHtml}</tbody></table>` +
      `</div>`,
  )
}

/**
 * New "/changes" diff grid. File path comes ONLY from aria-label="Diff for: <path>";
 * there is no data-path. Line numbers in data-line-number + data-diff-side on role="gridcell".
 */
function changesDiff(opts: {
  path?: string
  rows: Array<{ leftNo?: number; rightNo?: number; code: string }>
}): HTMLElement {
  const path = opts.path ?? 'lib/util.py'
  const rowsHtml = opts.rows
    .map((r) => {
      const left =
        r.leftNo === undefined
          ? `<div role="gridcell" style="user-select:none"></div>`
          : `<div role="gridcell" style="user-select:none" data-line-number="${r.leftNo}" data-diff-side="left"></div>`
      const right =
        r.rightNo === undefined
          ? `<div role="gridcell" style="user-select:none"></div>`
          : `<div role="gridcell" style="user-select:none" data-line-number="${r.rightNo}" data-diff-side="right"></div>`
      return `<div role="row">${left}${right}<div role="gridcell" class="code"><span>${r.code}</span></div></div>`
    })
    .join('')
  return mount(
    `<div data-diff-anchor aria-label="Diff for: ${path}">${rowsHtml}</div>`,
  )
}

/** Grab the text node inside the code <span> of a given row index. */
function codeText(host: HTMLElement, rowIndex: number): Text {
  const codeCells = host.querySelectorAll('.code')
  const span = codeCells[rowIndex] as HTMLElement
  // span may itself be the .code element or contain one; descend to its text.
  const textHost = span.querySelector('span') ?? span
  return textHost.firstChild as Text
}

beforeEach(() => {
  document.body.innerHTML = ''
  clearSelection()
})

afterEach(() => {
  document.body.innerHTML = ''
  clearSelection()
})

// ---------------------------------------------------------------------------
// captureSelection — nothing meaningful selected
// ---------------------------------------------------------------------------

describe('captureSelection: empty / collapsed selections', () => {
  it('returns null when there is no selection at all', () => {
    clearSelection()
    expect(captureSelection()).toBeNull()
  })

  it('returns null when the selection is collapsed (caret only)', () => {
    const host = legacyDiff({ rows: [{ rightNo: 1, code: 'const x = 1' }] })
    const text = codeText(host, 0)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 2) // collapsed
    sel.addRange(range)
    expect(captureSelection()).toBeNull()
  })

  it('returns null when the selection is only whitespace', () => {
    const host = mount(`<div data-path="src/a.ts"><span class="code">   </span></div>`)
    const text = host.querySelector('.code')!.firstChild as Text
    selectRange(text, text)
    expect(captureSelection()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// captureSelection — legacy /files single line
// ---------------------------------------------------------------------------

describe('captureSelection: legacy /files view, single line', () => {
  it('extracts file, code, single-line range and a RIGHT-side anchor', () => {
    const host = legacyDiff({
      path: 'src/main.ts',
      rows: [{ leftNo: 40, rightNo: 42, code: 'const total = sum(items)' }],
    })
    const text = codeText(host, 0)
    selectRange(text, text)

    const ctx = captureSelection()!
    expect(ctx).not.toBeNull()
    expect(ctx.file).toBe('src/main.ts')
    expect(ctx.selectedCode).toBe('const total = sum(items)')
    expect(ctx.lineRange).toEqual([42, 42])
    // Right (new) side is preferred over the left gutter cell.
    expect(ctx.anchor).toEqual({ line: 42, side: 'RIGHT' })
    expect(ctx.language).toBe('typescript')
  })

  it('resolves the path from data-path when data-tagsearch-path is absent', () => {
    const host = mount(
      `<div data-path="docs/readme.md">` +
        `<table><tbody><tr>` +
        `<td data-line-number="3" data-diff-side="right"></td>` +
        `<td class="code"><span>hello world</span></td>` +
        `</tr></tbody></table></div>`,
    )
    const text = (host.querySelector('.code span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    const ctx = captureSelection()!
    expect(ctx.file).toBe('docs/readme.md')
    expect(ctx.language).toBe('markdown')
  })

  it('falls back to the LEFT (old) side when the row has only a left line number', () => {
    // A pure deletion row: no right-side line number exists.
    const host = mount(
      `<div data-path="src/del.ts"><table><tbody><tr>` +
        `<td data-line-number="7" data-diff-side="left"></td>` +
        `<td data-diff-side="right"></td>` +
        `<td class="code"><span>const removed = true</span></td>` +
        `</tr></tbody></table></div>`,
    )
    const text = (host.querySelector('.code span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    const ctx = captureSelection()!
    expect(ctx.anchor).toEqual({ line: 7, side: 'LEFT' })
    expect(ctx.lineRange).toEqual([7, 7])
  })
})

// ---------------------------------------------------------------------------
// captureSelection — new /changes single line
// ---------------------------------------------------------------------------

describe('captureSelection: new /changes view, single line', () => {
  it('extracts the path from aria-label="Diff for: <path>"', () => {
    const host = changesDiff({
      path: 'lib/util.py',
      rows: [{ leftNo: 10, rightNo: 11, code: 'return value * 2' }],
    })
    const text = codeText(host, 0)
    selectRange(text, text)

    const ctx = captureSelection()!
    expect(ctx.file).toBe('lib/util.py')
    expect(ctx.selectedCode).toBe('return value * 2')
    expect(ctx.anchor).toEqual({ line: 11, side: 'RIGHT' })
    expect(ctx.lineRange).toEqual([11, 11])
    expect(ctx.language).toBe('python')
  })

  it('treats a missing data-diff-side as RIGHT (the common case)', () => {
    const host = mount(
      `<div aria-label="Diff for: a/b/c.js">` +
        `<div role="row">` +
        `<div role="gridcell" data-line-number="5"></div>` +
        `<div role="gridcell" class="code"><span>let n = 0</span></div>` +
        `</div></div>`,
    )
    const text = (host.querySelector('.code span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    const ctx = captureSelection()!
    expect(ctx.anchor).toEqual({ line: 5, side: 'RIGHT' })
    expect(ctx.file).toBe('a/b/c.js')
  })
})

// ---------------------------------------------------------------------------
// captureSelection — multi-line selections / reviewTarget
// ---------------------------------------------------------------------------

describe('captureSelection: multi-line selections', () => {
  it('spans multiple rows and reports the full line range (legacy)', () => {
    const host = legacyDiff({
      path: 'src/multi.ts',
      rows: [
        { leftNo: 10, rightNo: 12, code: 'function a() {' },
        { leftNo: 11, rightNo: 13, code: '  return 1' },
        { leftNo: 12, rightNo: 14, code: '}' },
      ],
    })
    const first = codeText(host, 0)
    const last = codeText(host, 2)
    selectRange(first, last)

    const ctx = captureSelection()!
    expect(ctx.file).toBe('src/multi.ts')
    expect(ctx.lineRange).toEqual([12, 14])
    // Anchor is the END of the selection (last line), right side.
    expect(ctx.anchor).toEqual({ line: 14, side: 'RIGHT' })
  })

  it('normalises a backwards (low..high) range regardless of selection direction', () => {
    // findLineRange does Math.min/Math.max, so even if start>end the range is sorted.
    const host = changesDiff({
      path: 'src/order.ts',
      rows: [
        { leftNo: 1, rightNo: 100, code: 'a' },
        { leftNo: 2, rightNo: 101, code: 'b' },
      ],
    })
    const r0 = codeText(host, 0)
    const r1 = codeText(host, 1)
    selectRange(r0, r1)
    const ctx = captureSelection()!
    expect(ctx.lineRange).toEqual([100, 101])
  })
})

describe('reviewTarget', () => {
  it('returns null when the context has no file', () => {
    const ctx: SelectionContext = {
      selectedCode: 'x',
      anchor: { line: 5, side: 'RIGHT' },
    }
    expect(reviewTarget(ctx)).toBeNull()
  })

  it('returns null when the context has no anchor', () => {
    const ctx: SelectionContext = {
      selectedCode: 'x',
      file: 'src/a.ts',
      lineRange: [5, 5],
    }
    expect(reviewTarget(ctx)).toBeNull()
  })

  it('anchors a single line to just that line (no startLine)', () => {
    const ctx: SelectionContext = {
      selectedCode: 'x',
      file: 'src/a.ts',
      lineRange: [42, 42],
      anchor: { line: 42, side: 'RIGHT' },
    }
    expect(reviewTarget(ctx)).toEqual({ path: 'src/a.ts', line: 42, side: 'RIGHT' })
  })

  it('anchors a multi-line selection to the whole range, side-aware', () => {
    const ctx: SelectionContext = {
      selectedCode: 'x',
      file: 'src/a.ts',
      lineRange: [12, 14],
      anchor: { line: 14, side: 'RIGHT' },
    }
    expect(reviewTarget(ctx)).toEqual({
      path: 'src/a.ts',
      line: 14,
      side: 'RIGHT',
      startLine: 12,
      startSide: 'RIGHT',
    })
  })

  it('carries a LEFT-side anchor through to both start and end side', () => {
    const ctx: SelectionContext = {
      selectedCode: 'x',
      file: 'src/del.ts',
      lineRange: [7, 9],
      anchor: { line: 9, side: 'LEFT' },
    }
    expect(reviewTarget(ctx)).toEqual({
      path: 'src/del.ts',
      line: 9,
      side: 'LEFT',
      startLine: 7,
      startSide: 'LEFT',
    })
  })

  it('sorts an out-of-order lineRange before anchoring (lo=startLine, hi=line)', () => {
    const ctx: SelectionContext = {
      selectedCode: 'x',
      file: 'src/a.ts',
      lineRange: [20, 15], // deliberately reversed
      anchor: { line: 15, side: 'RIGHT' },
    }
    const target = reviewTarget(ctx)!
    expect(target.startLine).toBe(15)
    expect(target.line).toBe(20)
  })

  it('integrates with captureSelection output end to end (multi-line)', () => {
    const host = legacyDiff({
      path: 'src/e2e.ts',
      rows: [
        { leftNo: 5, rightNo: 8, code: 'const a = 1' },
        { leftNo: 6, rightNo: 9, code: 'const b = 2' },
      ],
    })
    selectRange(codeText(host, 0), codeText(host, 1))
    const ctx = captureSelection()!
    expect(reviewTarget(ctx)).toEqual({
      path: 'src/e2e.ts',
      line: 9,
      side: 'RIGHT',
      startLine: 8,
      startSide: 'RIGHT',
    })
  })
})

// ---------------------------------------------------------------------------
// captureSelection — gutter / hunk-header cells are ignored
// ---------------------------------------------------------------------------

describe('captureSelection: ignores non-code-line content', () => {
  it('returns no line info when only a hunk-header row is selected (no data-line-number)', () => {
    // Hunk header: "@@ -1,3 +1,4 @@" — its cells carry NO data-line-number.
    const host = mount(
      `<div data-path="src/hunk.ts"><table><tbody>` +
        `<tr class="hunk-header">` +
        `<td class="blob-num-hunk" style="user-select:none"></td>` +
        `<td class="blob-num-hunk" style="user-select:none"></td>` +
        `<td class="hunk-text"><span>@@ -1,3 +1,4 @@ function f()</span></td>` +
        `</tr></tbody></table></div>`,
    )
    const text = (host.querySelector('.hunk-text span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    const ctx = captureSelection()!
    // File still resolves (data-path on ancestor), but there is no line anchor.
    expect(ctx.file).toBe('src/hunk.ts')
    expect(ctx.lineRange).toBeUndefined()
    expect(ctx.anchor).toBeUndefined()
  })

  it('selecting a gutter number cell alone yields that cell line (own data-line-number)', () => {
    // If the user manages to select inside a numbered gutter cell, lineInfoNear
    // resolves via the row's data-line-number cells, preferring the right side.
    const host = legacyDiff({
      path: 'src/g.ts',
      rows: [{ leftNo: 3, rightNo: 4, code: 'noop()' }],
    })
    const rightGutter = host.querySelector('[data-diff-side="right"]') as HTMLElement
    rightGutter.textContent = '4'
    const text = rightGutter.firstChild as Text
    selectRange(text, text)
    const ctx = captureSelection()!
    expect(ctx.selectedCode).toBe('4')
    expect(ctx.anchor).toEqual({ line: 4, side: 'RIGHT' })
  })
})

// ---------------------------------------------------------------------------
// captureSelection — file resolution edge cases
// ---------------------------------------------------------------------------

describe('captureSelection: file & language resolution edge cases', () => {
  it('returns undefined file when no path attribute or aria-label is present', () => {
    const host = mount(
      `<div><table><tbody><tr>` +
        `<td data-line-number="1" data-diff-side="right"></td>` +
        `<td class="code"><span>orphan line</span></td>` +
        `</tr></tbody></table></div>`,
    )
    const text = (host.querySelector('.code span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    const ctx = captureSelection()!
    expect(ctx.file).toBeUndefined()
    expect(ctx.language).toBeUndefined()
    // Line anchor still works without a file.
    expect(ctx.anchor).toEqual({ line: 1, side: 'RIGHT' })
  })

  it('leaves language undefined for an unknown extension', () => {
    const host = legacyDiff({
      path: 'data/blob.xyz',
      rows: [{ rightNo: 1, code: 'binary?' }],
    })
    selectRange(codeText(host, 0), codeText(host, 0))
    const ctx = captureSelection()!
    expect(ctx.file).toBe('data/blob.xyz')
    expect(ctx.language).toBeUndefined()
  })

  it('maps a variety of extensions to languages', () => {
    const cases: Array<[string, string]> = [
      ['a.tsx', 'tsx'],
      ['a.py', 'python'],
      ['a.go', 'go'],
      ['a.yml', 'yaml'],
      ['a.rs', 'rust'],
    ]
    for (const [path, lang] of cases) {
      document.body.innerHTML = ''
      clearSelection()
      const host = legacyDiff({ path, rows: [{ rightNo: 1, code: 'z' }] })
      selectRange(codeText(host, 0), codeText(host, 0))
      expect(captureSelection()!.language).toBe(lang)
    }
  })

  it('prefers data-tagsearch-path resolved on the nearest ancestor row', () => {
    // Nested paths: inner row carries the authoritative path, outer is a wrapper.
    const host = mount(
      `<div data-path="WRONG/outer.ts">` +
        `<table><tbody>` +
        `<tr data-tagsearch-path="src/inner.ts">` +
        `<td data-line-number="2" data-diff-side="right"></td>` +
        `<td class="code"><span>inner</span></td>` +
        `</tr></tbody></table></div>`,
    )
    const text = (host.querySelector('.code span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    expect(captureSelection()!.file).toBe('src/inner.ts')
  })

  it('takes data-path on a CLOSER ancestor over data-tagsearch-path on a farther one', () => {
    // The ancestor walk returns the first attribute it finds going outward, and on
    // each node prefers data-tagsearch-path over data-path. Here the closer node only
    // has data-path, so it wins over the outer data-tagsearch-path — the loop never
    // reaches the outer node.
    const host = mount(
      `<div data-tagsearch-path="OUTER/tag.ts">` +
        `<div data-path="inner/path.ts">` +
        `<table><tbody><tr>` +
        `<td data-line-number="1" data-diff-side="right"></td>` +
        `<td class="code"><span>x</span></td>` +
        `</tr></tbody></table></div></div>`,
    )
    const text = (host.querySelector('.code span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    expect(captureSelection()!.file).toBe('inner/path.ts')
  })

  it('leaves language undefined for an extensionless path (Dockerfile, LICENSE)', () => {
    const host = legacyDiff({ path: 'Dockerfile', rows: [{ rightNo: 1, code: 'FROM node' }] })
    selectRange(codeText(host, 0), codeText(host, 0))
    const ctx = captureSelection()!
    expect(ctx.file).toBe('Dockerfile')
    expect(ctx.language).toBeUndefined()
  })

  it('leaves language undefined for a dotfile (.gitignore) — ext is the whole tail', () => {
    const host = legacyDiff({ path: '.gitignore', rows: [{ rightNo: 1, code: 'node_modules' }] })
    selectRange(codeText(host, 0), codeText(host, 0))
    expect(captureSelection()!.language).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// reviewTarget — anchor vs lineRange interplay (the two are not cross-checked)
// ---------------------------------------------------------------------------

describe('reviewTarget: anchor / lineRange interplay', () => {
  it('uses anchor.line (not lineRange) for a single-line target', () => {
    // For a collapsed range, the function returns anchor.line verbatim and ignores
    // lineRange entirely. captureSelection keeps them in sync, but the contract is:
    // single line -> anchor.line wins.
    const ctx: SelectionContext = {
      selectedCode: 'x',
      file: 'a.ts',
      lineRange: [3, 3],
      anchor: { line: 99, side: 'RIGHT' },
    }
    expect(reviewTarget(ctx)).toEqual({ path: 'a.ts', line: 99, side: 'RIGHT' })
  })

  it('uses lineRange (not anchor.line) for a multi-line target', () => {
    // For a multi-line range, line=hi and startLine=lo come from lineRange; anchor.line
    // is dropped — only anchor.side is carried through.
    const ctx: SelectionContext = {
      selectedCode: 'x',
      file: 'a.ts',
      lineRange: [3, 7],
      anchor: { line: 99, side: 'RIGHT' },
    }
    expect(reviewTarget(ctx)).toEqual({
      path: 'a.ts',
      line: 7,
      side: 'RIGHT',
      startLine: 3,
      startSide: 'RIGHT',
    })
  })

  it('anchors single line when lineRange is absent but anchor present', () => {
    const ctx: SelectionContext = {
      selectedCode: 'x',
      file: 'a.ts',
      anchor: { line: 9, side: 'LEFT' },
    }
    expect(reviewTarget(ctx)).toEqual({ path: 'a.ts', line: 9, side: 'LEFT' })
  })
})

// ---------------------------------------------------------------------------
// captureSelection — empty data-line-number attributes (real GitHub markup)
// ---------------------------------------------------------------------------

describe('captureSelection: empty data-line-number cells', () => {
  it('a numbered right cell still anchors correctly when the left cell is EMPTY', () => {
    // Real added-line row: the absent (old) side often has data-line-number=""
    // (attribute present but empty), not absent. The right side carries the number.
    const host = mount(
      `<div data-path="x.ts"><table><tbody><tr>` +
        `<td data-line-number="" data-diff-side="left"></td>` +
        `<td data-line-number="42" data-diff-side="right"></td>` +
        `<td class="code"><span>added line</span></td>` +
        `</tr></tbody></table></div>`,
    )
    const text = (host.querySelector('.code span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    const ctx = captureSelection()!
    // The right cell is preferred, so the empty left cell does not interfere.
    expect(ctx.anchor).toEqual({ line: 42, side: 'RIGHT' })
    expect(ctx.lineRange).toEqual([42, 42])
  })

  // Regression guard (selection.ts:61-62): an empty data-line-number ("") parses to
  // Number("") === 0, which is finite. lineInfoOf must reject non-positive / non-integer
  // line numbers (Number.isInteger(n) && n > 0) so an empty cell yields no line info.
  it('empty data-line-number does NOT resolve to line 0', () => {
    const host = mount(
      `<div data-path="x.ts"><table><tbody><tr>` +
        `<td data-line-number="" data-diff-side="right"></td>` +
        `<td class="code"><span>weird</span></td>` +
        `</tr></tbody></table></div>`,
    )
    const text = (host.querySelector('.code span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    const ctx = captureSelection()!
    // CORRECT behavior: an empty line-number is no line info at all.
    expect(ctx.anchor).toBeUndefined()
    expect(ctx.lineRange).toBeUndefined()
  })

  // Regression guard (selection.ts:61-62): a multi-line selection whose first row has an
  // empty data-line-number must not yield lineRange [0, N] — that would post a review anchored
  // at start_line: 0, which the GitHub Reviews API rejects/mis-anchors.
  it('multi-line range does not start at 0 from an empty line-number row', () => {
    const host = mount(
      `<div data-path="x.ts"><table><tbody>` +
        `<tr><td data-line-number="" data-diff-side="right"></td><td class="code"><span>aaa</span></td></tr>` +
        `<tr><td data-line-number="10" data-diff-side="right"></td><td class="code"><span>bbb</span></td></tr>` +
        `</tbody></table></div>`,
    )
    const cells = host.querySelectorAll('.code span')
    const a = (cells[0] as HTMLElement).firstChild as Text
    const b = (cells[1] as HTMLElement).firstChild as Text
    const sel = window.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.setStart(a, 0)
    range.setEnd(b, b.data.length)
    sel.addRange(range)
    const ctx = captureSelection()!
    // CORRECT: the empty row contributes nothing; the range collapses to the real line.
    expect(ctx.lineRange).toEqual([10, 10])
  })

  it('rejects a non-numeric data-line-number (NaN is not finite)', () => {
    // Contrast with the empty-string case: "abc" -> NaN -> correctly rejected.
    const host = mount(
      `<div data-path="x.ts"><table><tbody><tr>` +
        `<td data-line-number="abc" data-diff-side="right"></td>` +
        `<td class="code"><span>z</span></td>` +
        `</tr></tbody></table></div>`,
    )
    const text = (host.querySelector('.code span') as HTMLElement).firstChild as Text
    selectRange(text, text)
    const ctx = captureSelection()!
    expect(ctx.anchor).toBeUndefined()
    expect(ctx.lineRange).toBeUndefined()
  })
})
