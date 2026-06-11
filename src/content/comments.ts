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

/**
 * Insert `text` into the focused (or last-focused) comment field. Returns false if
 * there's none. Tries execCommand (fires the input events GitHub's React editor
 * listens for); falls back to the native value setter + input event.
 */
export function insertComment(text: string): boolean {
  const active = document.activeElement
  const field = isCommentTextarea(active) ? active : lastField
  if (!field || !field.isConnected) return false

  field.focus()
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? start
  const before = field.value

  if (document.execCommand('insertText', false, text) && field.value !== before) {
    return true
  }

  // Fallback: set the value via the native prototype setter (bypasses React's
  // instance-level value tracker), then fire input so React picks up the change.
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field) as object,
    'value',
  )?.set
  const next = field.value.slice(0, start) + text + field.value.slice(end)
  if (setter) setter.call(field, next)
  else field.value = next
  field.selectionStart = field.selectionEnd = start + text.length
  field.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
