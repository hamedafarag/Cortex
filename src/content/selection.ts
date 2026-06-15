// Map the current text selection on a GitHub PR page to file/line context.
//
// Strategy (per DESIGN.md): DOM for *capture* only. Selectors are defensive and
// degrade gracefully — GitHub's diff markup changes between UI versions, and the
// authoritative file/diff content comes from the GitHub API in Phase 2.

export type DiffSide = 'LEFT' | 'RIGHT'

export interface SelectionContext {
  selectedCode: string
  file?: string
  lineRange?: [number, number]
  language?: string
  /** Single line to anchor a posted review comment to (the end of the selection). */
  anchor?: { line: number; side: DiffSide }
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  swift: 'swift', css: 'css', scss: 'scss', less: 'less', html: 'html',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown',
  sh: 'bash', bash: 'bash', sql: 'sql', xml: 'xml', vue: 'vue',
}

function languageFor(file: string | undefined): string | undefined {
  const ext = file?.split('.').pop()?.toLowerCase()
  return ext ? EXT_LANG[ext] : undefined
}

function asElement(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement
}

/** Resolve the file path for a node across both GitHub diff layouts. */
function findFilePath(start: Element | null): string | undefined {
  // Classic "Files changed" view: path lives in attributes on/above the row.
  for (let node: Element | null = start; node; node = node.parentElement) {
    const path =
      node.getAttribute('data-tagsearch-path') ?? node.getAttribute('data-path')
    if (path) return path
  }
  // New "/changes" view: the per-file diff grid carries aria-label="Diff for: <path>".
  const grid = start?.closest('[data-diff-anchor], [aria-label^="Diff for:"]')
  const label = grid?.getAttribute('aria-label')
  if (label?.startsWith('Diff for:')) return label.slice('Diff for:'.length).trim()
  return undefined
}

interface LineInfo {
  line: number
  side: DiffSide
}

function lineInfoOf(cell: Element | undefined | null): LineInfo | undefined {
  if (!cell) return undefined
  // GitHub leaves data-line-number present-but-empty on the absent side of added/deleted
  // rows; Number('') is 0, which is a finite-but-invalid line — reject it (1-based, integer).
  const n = Number(cell.getAttribute('data-line-number'))
  if (!Number.isInteger(n) || n <= 0) return undefined
  // Missing data-diff-side is treated as the right (new) side — the common case.
  const side: DiffSide =
    cell.getAttribute('data-diff-side')?.toLowerCase() === 'left' ? 'LEFT' : 'RIGHT'
  return { line: n, side }
}

/** Diff line + side near a node, preferring the right (new) side. */
function lineInfoNear(node: Node | null): LineInfo | undefined {
  const el = asElement(node)
  const row = el?.closest('tr, [role="row"]')
  const cells: Element[] = row
    ? Array.from(row.querySelectorAll('[data-line-number]'))
    : (() => {
        const own = el?.closest('[data-line-number]')
        return own ? [own] : []
      })()
  if (cells.length === 0) return undefined

  const right = cells.find(
    (c) => c.getAttribute('data-diff-side')?.toLowerCase() === 'right',
  )
  const rightInfo = lineInfoOf(right)
  if (rightInfo) return rightInfo

  // Fall back to the highest-numbered cell in the row.
  let best: LineInfo | undefined
  for (const c of cells) {
    const info = lineInfoOf(c)
    if (info && (!best || info.line > best.line)) best = info
  }
  return best
}

function findLineRange(range: Range): [number, number] | undefined {
  const a = lineInfoNear(range.startContainer)?.line
  const b = lineInfoNear(range.endContainer)?.line
  if (a === undefined && b === undefined) return undefined
  const lo = Math.min(a ?? b!, b ?? a!)
  const hi = Math.max(a ?? b!, b ?? a!)
  return [lo, hi]
}

export interface ReviewTarget {
  path: string
  /** Last line of the anchor. */
  line: number
  side: DiffSide
  /** First line of a multi-line anchor (so a `suggestion` replaces the whole range). */
  startLine?: number
  startSide?: DiffSide
}

/**
 * Where a posted review comment / suggestion should anchor. A multi-line selection
 * anchors to the whole range (`startLine`..`line`) so a ```suggestion replaces exactly
 * those lines; a single line anchors to just that line. Null if not postable.
 */
export function reviewTarget(sel: SelectionContext): ReviewTarget | null {
  if (!sel.file || !sel.anchor) return null
  const { side } = sel.anchor
  if (sel.lineRange && sel.lineRange[0] !== sel.lineRange[1]) {
    const lo = Math.min(sel.lineRange[0], sel.lineRange[1])
    const hi = Math.max(sel.lineRange[0], sel.lineRange[1])
    return { path: sel.file, line: hi, side, startLine: lo, startSide: side }
  }
  return { path: sel.file, line: sel.anchor.line, side }
}

/** Capture the active selection, or null if nothing meaningful is selected. */
export function captureSelection(): SelectionContext | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const selectedCode = sel.toString().trim()
  if (!selectedCode) return null

  const range = sel.getRangeAt(0)
  const file = findFilePath(asElement(range.startContainer))
  const anchor = lineInfoNear(range.endContainer) ?? lineInfoNear(range.startContainer)
  return {
    selectedCode,
    file,
    lineRange: findLineRange(range),
    language: languageFor(file),
    anchor,
  }
}
