// Inline SVG line icons (Feather/Lucide-style, stroke = currentColor). Authored for
// Cortex — no external requests, no attribution, fully offline.

export type IconName =
  | 'logo'
  | 'sparkles'
  | 'comment'
  | 'plus'
  | 'chevronDown'
  | 'chevronUp'
  | 'externalLink'
  | 'check'
  | 'alert'
  | 'spinner'
  | 'code'

const PATHS: Record<IconName, string> = {
  // A small synapse / node cluster — the Cortex mark.
  logo:
    '<circle cx="12" cy="12" r="2.3"/><circle cx="5" cy="6" r="1.4"/>' +
    '<circle cx="19" cy="7" r="1.4"/><circle cx="6.5" cy="18.5" r="1.4"/>' +
    '<circle cx="18" cy="17" r="1.4"/>' +
    '<path d="M12 12 5.9 6.7M12 12l5.4-3.9M12 12l-4.7 5.5M12 12l4.7 4.2"/>',
  sparkles:
    '<path d="M12 3.5l1.6 4.3L18 9.5l-4.4 1.7L12 15.5l-1.6-4.3L6 9.5l4.4-1.7z"/>' +
    '<path d="M18.6 14.3l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z"/>',
  comment: '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  externalLink:
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
}

export function icon(name: IconName, size = 16): string {
  return (
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`
  )
}
