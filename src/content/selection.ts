// Map the current text selection on a GitHub PR page to file/line context.
//
// Strategy (per DESIGN.md): DOM for *capture* only. Selectors are defensive and
// degrade gracefully — GitHub's diff markup changes between UI versions, and the
// authoritative file/diff content comes from the GitHub API in Phase 2.

export interface SelectionContext {
  selectedCode: string
  file?: string
  lineRange?: [number, number]
  language?: string
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

function lineNumberOf(cell: Element | undefined | null): number | undefined {
  const n = Number(cell?.getAttribute('data-line-number'))
  return Number.isFinite(n) ? n : undefined
}

/** Find the diff line number for a node, preferring the right (new) side of the diff. */
function lineNumberNear(node: Node | null): number | undefined {
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
  const rightNum = lineNumberOf(right)
  if (rightNum !== undefined) return rightNum

  // Fall back to the highest line number present in the row.
  let best: number | undefined
  for (const c of cells) {
    const n = lineNumberOf(c)
    if (n !== undefined) best = best === undefined ? n : Math.max(best, n)
  }
  return best
}

function findLineRange(range: Range): [number, number] | undefined {
  const a = lineNumberNear(range.startContainer)
  const b = lineNumberNear(range.endContainer)
  if (a === undefined && b === undefined) return undefined
  const lo = Math.min(a ?? b!, b ?? a!)
  const hi = Math.max(a ?? b!, b ?? a!)
  return [lo, hi]
}

/** Capture the active selection, or null if nothing meaningful is selected. */
export function captureSelection(): SelectionContext | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const selectedCode = sel.toString().trim()
  if (!selectedCode) return null

  const range = sel.getRangeAt(0)
  const file = findFilePath(asElement(range.startContainer))
  return {
    selectedCode,
    file,
    lineRange: findLineRange(range),
    language: languageFor(file),
  }
}
