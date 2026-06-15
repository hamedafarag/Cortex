// Regression net for src/shared/messages.ts.
//
// NOTE ON SCOPE: messages.ts is almost entirely *type-only* — interfaces and discriminated
// unions describing the three wire protocols (content<->background port, background<->native
// host stdio, content<->background one-shot GitHub ops). TypeScript erases all of that at
// runtime, so there are no type guards / builders / parsers to exercise. The only RUNTIME
// surface is two exported string constants:
//   - PORT_NAME           ('ycra')              — chrome.runtime.connect/onConnect handshake
//   - NATIVE_HOST_NAME    ('com.ycra.reviewer') — native-messaging host id
//
// Both are LOAD-BEARING magic strings (per CLAUDE.md: renaming them breaks the connection
// handshake / the installed native host). Pinning their exact values is the meaningful
// regression these tests can offer; the rest is a structural guard that the runtime export
// surface stays exactly those two constants (so an accidental rename or a stray new runtime
// export is caught).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as messages from './messages'
import { NATIVE_HOST_NAME, PORT_NAME } from './messages'

describe('messages.ts — runtime constants', () => {
  describe('PORT_NAME', () => {
    it('is exactly "ycra"', () => {
      // Must match both ends of chrome.runtime.connect({name}) / onConnect (content + bg).
      expect(PORT_NAME).toBe('ycra')
    })

    it('is a non-empty string', () => {
      expect(typeof PORT_NAME).toBe('string')
      expect(PORT_NAME.length).toBeGreaterThan(0)
    })

    it('contains no whitespace (used as a raw port name)', () => {
      expect(PORT_NAME).not.toMatch(/\s/)
    })

    it('matches the namespace prefix used for internal ids (ycra)', () => {
      // Sanity: the port name shares the "ycra" namespace with data-ycra-* / com.ycra.*.
      expect(PORT_NAME).toBe('ycra')
      expect(NATIVE_HOST_NAME.includes(PORT_NAME)).toBe(true)
    })
  })

  describe('NATIVE_HOST_NAME', () => {
    it('is exactly "com.ycra.reviewer"', () => {
      // Must match the native host manifest "name" (baked into native-host/install.sh).
      expect(NATIVE_HOST_NAME).toBe('com.ycra.reviewer')
    })

    it('is a non-empty string', () => {
      expect(typeof NATIVE_HOST_NAME).toBe('string')
      expect(NATIVE_HOST_NAME.length).toBeGreaterThan(0)
    })

    it('is a reverse-DNS style id (dotted, lowercase, no whitespace)', () => {
      // Native-messaging host names are dotted reverse-DNS ids.
      expect(NATIVE_HOST_NAME).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/)
      expect(NATIVE_HOST_NAME).not.toMatch(/\s/)
    })

    it('has the three expected segments', () => {
      expect(NATIVE_HOST_NAME.split('.')).toEqual(['com', 'ycra', 'reviewer'])
    })
  })

  describe('constant identity / immutability', () => {
    it('the two constants are distinct values', () => {
      expect(PORT_NAME).not.toBe(NATIVE_HOST_NAME)
    })

    it('named import and namespace import agree', () => {
      expect(messages.PORT_NAME).toBe(PORT_NAME)
      expect(messages.NATIVE_HOST_NAME).toBe(NATIVE_HOST_NAME)
    })

    it('module re-evaluation yields stable values (idempotent)', async () => {
      // A fresh import of the same module must not change the constants.
      const fresh = await import('./messages')
      expect(fresh.PORT_NAME).toBe('ycra')
      expect(fresh.NATIVE_HOST_NAME).toBe('com.ycra.reviewer')
    })
  })

  describe('runtime export surface', () => {
    it('exports exactly the two known runtime constants (no stray runtime exports)', () => {
      // Interfaces / type aliases are erased, so the runtime namespace object should hold
      // ONLY these two value exports. A new runtime export (or a rename) trips this guard.
      const runtimeKeys = Object.keys(messages).sort()
      expect(runtimeKeys).toEqual(['NATIVE_HOST_NAME', 'PORT_NAME'])
    })

    it('both runtime exports are strings', () => {
      for (const k of Object.keys(messages)) {
        expect(typeof (messages as Record<string, unknown>)[k]).toBe('string')
      }
    })
  })

  // Cross-file invariant: NATIVE_HOST_NAME is the host id the background passes to
  // chrome.runtime.connectNative(). The native-messaging host manifest registered by
  // native-host/install.sh must advertise the SAME "name", or the OS refuses the connection
  // and the local-CLI backend silently fails. install.sh hardcodes this id rather than
  // importing it (it's a bash script), so the two can drift independently — exactly the kind
  // of silent break CLAUDE.md warns about ("Don't rename internal ids … it breaks the
  // installed native host"). Pin them together so a rename on either side is caught here.
  describe('cross-file invariant: native host id stays in sync with install.sh', () => {
    // Vitest runs with cwd = repo root, so resolve install.sh from there.
    const installSh = readFileSync(
      resolve(process.cwd(), 'native-host/install.sh'),
      'utf8',
    )

    it('install.sh declares HOST_NAME equal to NATIVE_HOST_NAME', () => {
      // Grab the literal assigned to HOST_NAME=... (double- or single-quoted, or bare).
      const m = installSh.match(/^\s*HOST_NAME=("([^"]*)"|'([^']*)'|(\S+))/m)
      expect(m, 'install.sh must assign HOST_NAME').not.toBeNull()
      const value = m![2] ?? m![3] ?? m![4]
      expect(value).toBe(NATIVE_HOST_NAME)
    })
  })
})
