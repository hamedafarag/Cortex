import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CANNED_COMMENTS,
  CC_DECORATIONS,
  CC_LABELS,
  conventionalPrefix,
  insertComment,
  prependComment,
  trackCommentFields,
} from './comments'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a real (connected, focusable) textarea in the jsdom document. */
function makeTextarea(value = ''): HTMLTextAreaElement {
  const ta = document.createElement('textarea')
  ta.value = value
  document.body.appendChild(ta)
  return ta
}

/**
 * jsdom does not implement document.execCommand. The source calls it and treats
 * a falsy return as "fall back to the native value setter". By default jsdom's
 * execCommand is undefined, so we install a stub that returns false (no-op) so
 * the deterministic fallback path runs. Individual tests can override it.
 */
function stubExecCommand(impl: (cmd: string, ui: boolean, value?: string) => boolean): void {
  ;(document as unknown as { execCommand: typeof document.execCommand }).execCommand =
    impl as unknown as typeof document.execCommand
}

beforeEach(() => {
  document.body.innerHTML = ''
  // Default: execCommand is a no-op that reports failure -> source uses the
  // native value-setter fallback, which is what we assert against.
  stubExecCommand(() => false)
})

// ---------------------------------------------------------------------------
// Canned comment catalog
// ---------------------------------------------------------------------------

describe('CANNED_COMMENTS catalog', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(CANNED_COMMENTS)).toBe(true)
    expect(CANNED_COMMENTS.length).toBeGreaterThan(0)
  })

  it('every entry has a non-empty label and body', () => {
    for (const c of CANNED_COMMENTS) {
      expect(typeof c.label).toBe('string')
      expect(c.label.trim().length).toBeGreaterThan(0)
      expect(typeof c.body).toBe('string')
      expect(c.body.length).toBeGreaterThan(0)
    }
  })

  it('every entry has exactly the expected fields (label, body)', () => {
    for (const c of CANNED_COMMENTS) {
      expect(Object.keys(c).sort()).toEqual(['body', 'label'])
    }
  })

  it('has unique labels', () => {
    const labels = CANNED_COMMENTS.map((c) => c.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('has unique bodies', () => {
    const bodies = CANNED_COMMENTS.map((c) => c.body)
    expect(new Set(bodies).size).toBe(bodies.length)
  })

  it('exposes the known canned labels', () => {
    const labels = CANNED_COMMENTS.map((c) => c.label)
    expect(labels).toContain('Nit')
    expect(labels).toContain('LGTM')
    expect(labels).toContain('Needs test')
  })

  it("the Nit body ends with a separator so the reviewer can keep typing", () => {
    const nit = CANNED_COMMENTS.find((c) => c.label === 'Nit')
    expect(nit?.body).toBe('Nit: ')
  })
})

// ---------------------------------------------------------------------------
// Conventional Comments labels + decorations
// ---------------------------------------------------------------------------

describe('CC_LABELS catalog', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(CC_LABELS)).toBe(true)
    expect(CC_LABELS.length).toBeGreaterThan(0)
  })

  it('every entry has a non-empty label and value', () => {
    for (const l of CC_LABELS) {
      expect(typeof l.label).toBe('string')
      expect(l.label.trim().length).toBeGreaterThan(0)
      expect(typeof l.value).toBe('string')
      expect(l.value.trim().length).toBeGreaterThan(0)
    }
  })

  it('every entry has exactly the expected fields (label, value)', () => {
    for (const l of CC_LABELS) {
      expect(Object.keys(l).sort()).toEqual(['label', 'value'])
    }
  })

  it('has unique labels and unique values', () => {
    const labels = CC_LABELS.map((l) => l.label)
    const values = CC_LABELS.map((l) => l.value)
    expect(new Set(labels).size).toBe(labels.length)
    expect(new Set(values).size).toBe(values.length)
  })

  it('values are lowercase, single-token keywords (no spaces/colons)', () => {
    for (const l of CC_LABELS) {
      expect(l.value).toBe(l.value.toLowerCase())
      expect(l.value).not.toMatch(/[\s:]/)
    }
  })

  it('covers the canonical Conventional Comments keywords', () => {
    const values = CC_LABELS.map((l) => l.value)
    expect(values).toEqual(
      expect.arrayContaining([
        'praise',
        'nitpick',
        'suggestion',
        'issue',
        'question',
        'thought',
        'chore',
      ]),
    )
  })
})

describe('CC_DECORATIONS', () => {
  it('starts with the empty (no-decoration) option', () => {
    expect(CC_DECORATIONS[0]).toBe('')
  })

  it('contains the expected decoration keywords', () => {
    expect(CC_DECORATIONS).toContain('non-blocking')
    expect(CC_DECORATIONS).toContain('blocking')
    expect(CC_DECORATIONS).toContain('if-minor')
  })

  it('has unique entries', () => {
    expect(new Set(CC_DECORATIONS).size).toBe(CC_DECORATIONS.length)
  })
})

describe('conventionalPrefix', () => {
  it('renders "value: " when there is no decoration', () => {
    expect(conventionalPrefix('issue', '')).toBe('issue: ')
  })

  it('renders "value (decoration): " when a decoration is present', () => {
    expect(conventionalPrefix('suggestion', 'non-blocking')).toBe('suggestion (non-blocking): ')
  })

  it('matches the Conventional Comments grammar for every label/decoration combo', () => {
    for (const { value } of CC_LABELS) {
      for (const dec of CC_DECORATIONS) {
        const out = conventionalPrefix(value, dec)
        expect(out.endsWith(': ')).toBe(true)
        if (dec) expect(out).toBe(`${value} (${dec}): `)
        else expect(out).toBe(`${value}: `)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// insertComment — fallback (native value setter) path
// ---------------------------------------------------------------------------

describe('insertComment (fallback path, execCommand no-op)', () => {
  it('returns false when no comment field is focused or remembered', () => {
    // Nothing focused, nothing tracked.
    expect(insertComment('hello')).toBe(false)
  })

  it('returns false when the active element is not a textarea', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)
    expect(insertComment('x')).toBe(false)
  })

  it('inserts text at the caret in a focused empty textarea', () => {
    const ta = makeTextarea('')
    ta.focus()
    expect(insertComment('Nit: ')).toBe(true)
    expect(ta.value).toBe('Nit: ')
    // caret placed after inserted text
    expect(ta.selectionStart).toBe('Nit: '.length)
    expect(ta.selectionEnd).toBe('Nit: '.length)
  })

  it('inserts at the caret, preserving text on both sides', () => {
    const ta = makeTextarea('AABB')
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 2 // between AA and BB
    expect(insertComment('XX')).toBe(true)
    expect(ta.value).toBe('AAXXBB')
    expect(ta.selectionStart).toBe(4) // 2 + 'XX'.length
  })

  it('replaces the current selection range with the inserted text', () => {
    const ta = makeTextarea('hello world')
    ta.focus()
    ta.selectionStart = 6 // 'world'
    ta.selectionEnd = 11
    expect(insertComment('there')).toBe(true)
    expect(ta.value).toBe('hello there')
    expect(ta.selectionStart).toBe('hello there'.length)
  })

  it('keeps focus on the field after inserting', () => {
    const ta = makeTextarea('')
    ta.focus()
    insertComment('hi')
    expect(document.activeElement).toBe(ta)
  })

  it('fires an input event so the host React editor picks up the change', () => {
    const ta = makeTextarea('')
    ta.focus()
    const onInput = vi.fn()
    ta.addEventListener('input', onInput)
    insertComment('z')
    expect(onInput).toHaveBeenCalledTimes(1)
    const evt = onInput.mock.calls[0][0] as Event
    expect(evt.bubbles).toBe(true)
  })

  it('appends at the end when caret is at the end', () => {
    const ta = makeTextarea('done')
    ta.focus()
    ta.selectionStart = ta.selectionEnd = ta.value.length
    expect(insertComment('!')).toBe(true)
    expect(ta.value).toBe('done!')
    expect(ta.selectionStart).toBe('done!'.length)
  })
})

// ---------------------------------------------------------------------------
// insertComment — execCommand success path
// ---------------------------------------------------------------------------

describe('insertComment (execCommand success path)', () => {
  it('uses execCommand and returns true when it mutates the field value', () => {
    const ta = makeTextarea('seed')
    ta.focus()
    const exec = vi.fn((_cmd: string, _ui: boolean, value?: string) => {
      // Simulate the browser editor performing the insert.
      ta.value = ta.value + (value ?? '')
      return true
    })
    stubExecCommand(exec)
    const setter = vi.fn()
    ta.addEventListener('input', setter)

    expect(insertComment('+more')).toBe(true)
    expect(exec).toHaveBeenCalledWith('insertText', false, '+more')
    expect(ta.value).toBe('seed+more')
    // The fallback's input event should NOT fire when execCommand succeeded.
    expect(setter).not.toHaveBeenCalled()
  })

  it('falls back to the native setter when execCommand returns true but does not change the value', () => {
    // GitHub edge case: execCommand "succeeds" but leaves value unchanged.
    const ta = makeTextarea('abc')
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 3
    stubExecCommand(() => true) // returns true but never mutates value
    expect(insertComment('Z')).toBe(true)
    expect(ta.value).toBe('abcZ') // fallback ran
  })
})

// ---------------------------------------------------------------------------
// prependComment
// ---------------------------------------------------------------------------

describe('prependComment (fallback path, execCommand no-op)', () => {
  it('returns false when there is no comment field', () => {
    expect(prependComment('issue: ')).toBe(false)
  })

  it('prepends the prefix to existing text without losing it', () => {
    const ta = makeTextarea('the bug is here')
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 5 // caret somewhere in the middle
    expect(prependComment('issue: ')).toBe(true)
    expect(ta.value).toBe('issue: the bug is here')
  })

  it('places the caret right after the prepended prefix', () => {
    const ta = makeTextarea('body')
    ta.focus()
    expect(prependComment('praise: ')).toBe(true)
    expect(ta.selectionStart).toBe('praise: '.length)
    expect(ta.selectionEnd).toBe('praise: '.length)
  })

  it('works on an empty field (prefix becomes the whole value)', () => {
    const ta = makeTextarea('')
    ta.focus()
    expect(prependComment('chore: ')).toBe(true)
    expect(ta.value).toBe('chore: ')
  })

  it('keeps focus on the field', () => {
    const ta = makeTextarea('x')
    ta.focus()
    prependComment('nitpick: ')
    expect(document.activeElement).toBe(ta)
  })

  it('fires a bubbling input event', () => {
    const ta = makeTextarea('x')
    ta.focus()
    const onInput = vi.fn()
    ta.addEventListener('input', onInput)
    prependComment('issue: ')
    expect(onInput).toHaveBeenCalledTimes(1)
    expect((onInput.mock.calls[0][0] as Event).bubbles).toBe(true)
  })

  it('composes correctly with conventionalPrefix output', () => {
    const ta = makeTextarea('needs a guard clause')
    ta.focus()
    const prefix = conventionalPrefix('suggestion', 'non-blocking')
    expect(prependComment(prefix)).toBe(true)
    expect(ta.value).toBe('suggestion (non-blocking): needs a guard clause')
  })
})

describe('prependComment (execCommand success path)', () => {
  it('uses execCommand at offset 0 and returns true when it mutates', () => {
    const ta = makeTextarea('rest')
    ta.focus()
    const exec = vi.fn((_cmd: string, _ui: boolean, value?: string) => {
      ta.value = (value ?? '') + ta.value
      return true
    })
    stubExecCommand(exec)
    expect(prependComment('issue: ')).toBe(true)
    expect(exec).toHaveBeenCalledWith('insertText', false, 'issue: ')
    expect(ta.value).toBe('issue: rest')
    // caret was moved to start before the insert
  })
})

// ---------------------------------------------------------------------------
// focusedField behaviour via tracking + connectedness
// ---------------------------------------------------------------------------

describe('field tracking (trackCommentFields) and last-focused fallback', () => {
  it('falls back to the last-tracked textarea when nothing is currently focused', () => {
    trackCommentFields()
    const ta = makeTextarea('seed')
    // Dispatch a real focusin so the tracker records it.
    ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    // Blur away so activeElement is no longer the textarea.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    document.body.focus?.()
    expect(document.activeElement).not.toBe(ta)

    // insertComment should still target the remembered field.
    expect(insertComment('!')).toBe(true)
    expect(ta.value.endsWith('!')).toBe(true)
  })

  it('does not track non-textarea focus (e.g. an input)', () => {
    trackCommentFields()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    // Nothing else focused / tracked -> no field to insert into.
    expect(insertComment('x')).toBe(false)
  })

  it('ignores a remembered field once it is detached from the document', () => {
    trackCommentFields()
    const ta = makeTextarea('seed')
    ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    // Remove it from the DOM -> isConnected becomes false.
    ta.remove()
    expect(ta.isConnected).toBe(false)
    expect(insertComment('x')).toBe(false)
  })

  it('prefers the currently-focused textarea over the remembered one', () => {
    trackCommentFields()
    const first = makeTextarea('first')
    first.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    const second = makeTextarea('second')
    second.focus() // becomes document.activeElement
    expect(document.activeElement).toBe(second)

    insertComment('-edited')
    expect(second.value).toBe('second-edited')
    expect(first.value).toBe('first') // untouched
  })

  it('re-focuses a remembered-but-blurred field before inserting', () => {
    trackCommentFields()
    const ta = makeTextarea('seed')
    ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    // Blur away: nothing focused now.
    ta.blur()
    document.body.focus?.()
    expect(document.activeElement).not.toBe(ta)

    expect(insertComment('!')).toBe(true)
    // The source calls field.focus() before mutating, so focus is restored.
    expect(document.activeElement).toBe(ta)
  })
})

// ---------------------------------------------------------------------------
// Tightening: native value-setter fallback internals + boundary cases.
// These close gaps the original suite glossed over (the GitHub-React bypass,
// empty-text inserts, the execCommand-attempted contract, and ?? caret defaults).
// ---------------------------------------------------------------------------

describe('insertComment — native value-setter fallback internals', () => {
  it('writes through the prototype value setter (React tracker bypass), not the instance', () => {
    const ta = makeTextarea('')
    ta.focus()
    // Spy on the PROTOTYPE setter the source reaches for via getOwnPropertyDescriptor.
    const proto = Object.getPrototypeOf(ta) as object
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    expect(desc?.set).toBeTypeOf('function') // jsdom exposes it; the source depends on this
    const protoSetter = vi.spyOn(desc!, 'set' as never)
    Object.defineProperty(proto, 'value', desc!) // re-install with the spy wrapper

    expect(insertComment('PROTO')).toBe(true)
    expect(protoSetter).toHaveBeenCalled()
    expect(ta.value).toBe('PROTO')

    // Restore so we don't pollute other tests sharing the prototype.
    Object.defineProperty(proto, 'value', desc!)
  })

  it('attempts execCommand("insertText") before falling back', () => {
    const ta = makeTextarea('a')
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 1
    const exec = vi.fn(() => false) // report failure -> force fallback
    stubExecCommand(exec)
    insertComment('b')
    expect(exec).toHaveBeenCalledWith('insertText', false, 'b')
    expect(ta.value).toBe('ab') // fallback still produced the result
  })

  it('inserting an empty string is a no-op on value but still returns true and fires input', () => {
    const ta = makeTextarea('keep')
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 2
    const onInput = vi.fn()
    ta.addEventListener('input', onInput)
    expect(insertComment('')).toBe(true)
    expect(ta.value).toBe('keep') // unchanged
    expect(ta.selectionStart).toBe(2) // caret at start + 0
    expect(onInput).toHaveBeenCalledTimes(1) // fallback fires regardless (value !== before is false)
  })

  it('handles multi-line inserted text without mangling existing newlines', () => {
    const ta = makeTextarea('line1\nline2')
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 5 // end of "line1"
    expect(insertComment('\nINSERTED')).toBe(true)
    expect(ta.value).toBe('line1\nINSERTED\nline2')
    expect(ta.selectionStart).toBe(5 + '\nINSERTED'.length)
  })

  it('execCommand-true-but-unchanged still fires exactly one input event (the fallback)', () => {
    const ta = makeTextarea('abc')
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 3
    stubExecCommand(() => true) // claims success, never mutates
    const onInput = vi.fn()
    ta.addEventListener('input', onInput)
    expect(insertComment('Z')).toBe(true)
    expect(ta.value).toBe('abcZ')
    expect(onInput).toHaveBeenCalledTimes(1)
  })
})

describe('prependComment — fallback internals + idempotent stacking', () => {
  it('attempts execCommand before falling back and moves caret to 0 first', () => {
    const ta = makeTextarea('tail')
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 4 // caret at end
    const exec = vi.fn(() => false)
    stubExecCommand(exec)
    expect(prependComment('issue: ')).toBe(true)
    expect(exec).toHaveBeenCalledWith('insertText', false, 'issue: ')
    expect(ta.value).toBe('issue: tail')
    expect(ta.selectionStart).toBe('issue: '.length) // caret after prefix, not at old offset 4
  })

  it('prepending twice stacks prefixes most-recent-first', () => {
    const ta = makeTextarea('body')
    ta.focus()
    prependComment('issue: ')
    prependComment('blocking: ')
    expect(ta.value).toBe('blocking: issue: body')
  })

  it('prepend execCommand-true-but-unchanged falls back to the native setter', () => {
    const ta = makeTextarea('rest')
    ta.focus()
    stubExecCommand(() => true)
    expect(prependComment('chore: ')).toBe(true)
    expect(ta.value).toBe('chore: rest')
    expect(ta.selectionStart).toBe('chore: '.length)
  })
})
