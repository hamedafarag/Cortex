// Out-of-the-box review comments the reviewer can drop into GitHub's comment box,
// plus the logic to insert one into whichever comment field was last focused.

export interface CannedComment {
  /** Short button label shown in the dock tray. */
  label: string
  /** Text inserted into the focused comment field. */
  body: string
}

export const CANNED_COMMENTS: CannedComment[] = [
  { label: 'Nit', body: 'Nit: ' },
  { label: 'Needs test', body: 'Could you add a test covering this case?' },
  { label: 'Naming', body: 'Consider a more descriptive name here.' },
  { label: 'Error handling', body: 'What should happen if this fails or returns null/undefined?' },
  { label: 'Magic value', body: 'Consider extracting this into a named constant.' },
  { label: 'Duplication', body: 'This looks similar to existing code — could it be shared?' },
  { label: 'Why?', body: 'Can you explain why this approach was chosen over the alternative?' },
  { label: 'Docs', body: 'A brief comment explaining the intent here would help future readers.' },
  { label: 'Simplify', body: 'This could likely be simplified — is there a cleaner approach?' },
  { label: 'LGTM', body: 'LGTM 👍' },
]

/** A Conventional Comments label (conventionalcomments.org). */
export interface ConventionalLabel {
  /** Chip text shown in the dock. */
  label: string
  /** The keyword used in the composed prefix. */
  value: string
}

export const CC_LABELS: ConventionalLabel[] = [
  { label: 'Praise', value: 'praise' },
  { label: 'Nit', value: 'nitpick' },
  { label: 'Suggestion', value: 'suggestion' },
  { label: 'Issue', value: 'issue' },
  { label: 'Question', value: 'question' },
  { label: 'Thought', value: 'thought' },
  { label: 'Chore', value: 'chore' },
]

/** Optional decorations; `''` = none. */
export const CC_DECORATIONS = ['', 'non-blocking', 'blocking', 'if-minor'] as const

/** Compose a Conventional Comments prefix: `label: ` or `label (decoration): `. */
export function conventionalPrefix(value: string, decoration: string): string {
  return decoration ? `${value} (${decoration}): ` : `${value}: `
}

/** The last GitHub comment textarea the user focused (so we can insert into it). */
let lastField: HTMLTextAreaElement | null = null

function isCommentTextarea(node: EventTarget | null): node is HTMLTextAreaElement {
  // tagName check rather than `instanceof` — robust across the content script's
  // isolated world vs the page world. The dock's own textarea retargets focus to
  // the shadow host (a <div>), so it never matches here.
  return !!node && (node as HTMLElement).tagName === 'TEXTAREA'
}

/** Remember the last-focused GitHub comment textarea. Call once. */
export function trackCommentFields(): void {
  document.addEventListener('focusin', (event) => {
    if (isCommentTextarea(event.target)) lastField = event.target as HTMLTextAreaElement
  })
}

/** The focused (or last-focused) GitHub comment field, or null if none is connected. */
function focusedField(): HTMLTextAreaElement | null {
  const active = document.activeElement
  const field = isCommentTextarea(active) ? active : lastField
  return field && field.isConnected ? field : null
}

/** Set `field`'s value via the native prototype setter (bypassing React's instance-level
 *  value tracker), place the caret, and fire input so React's editor picks up the change. */
function setFieldValue(field: HTMLTextAreaElement, next: string, caret: number): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field) as object,
    'value',
  )?.set
  if (setter) setter.call(field, next)
  else field.value = next
  field.selectionStart = field.selectionEnd = caret
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Insert `text` at the cursor in the focused (or last-focused) comment field. Returns false
 * if there's none. Tries execCommand (fires the input events GitHub's React editor listens
 * for); falls back to the native value setter + input event.
 */
export function insertComment(text: string): boolean {
  const field = focusedField()
  if (!field) return false
  field.focus()
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? start
  const before = field.value
  if (document.execCommand('insertText', false, text) && field.value !== before) return true
  setFieldValue(field, field.value.slice(0, start) + text + field.value.slice(end), start + text.length)
  return true
}

/**
 * Prepend `prefix` at the START of the focused comment field — Conventional Comments labels
 * go first, ahead of whatever the reviewer has typed. Returns false if there's no field.
 */
export function prependComment(prefix: string): boolean {
  const field = focusedField()
  if (!field) return false
  field.focus()
  field.selectionStart = field.selectionEnd = 0
  const before = field.value
  if (document.execCommand('insertText', false, prefix) && field.value !== before) return true
  setFieldValue(field, prefix + before, prefix.length)
  return true
}
