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
  | 'copy'
  | 'wand'
  | 'tag'
  | 'list'
  | 'search'
  | 'beaker'
  | 'info'
  | 'dot'
  | 'help'
  | 'undo'
  | 'refresh'
  | 'shield'

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
  copy:
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  // A magic wand with a sparkle — "suggest a fix".
  wand:
    '<path d="m21.6 3.6-1.2-1.2a1.2 1.2 0 0 0-1.7 0L2.4 18.6a1.2 1.2 0 0 0 0 1.8l1.2 1.2a1.2 1.2 0 0 0 1.8 0L21.6 5.4a1.2 1.2 0 0 0 0-1.8Z"/>' +
    '<path d="m14 7 3 3"/><path d="M5 6v4M3 8h4"/>',
  tag:
    '<path d="M12.6 2.6 21 11a2 2 0 0 1 0 2.8l-7.2 7.2a2 2 0 0 1-2.8 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6Z"/>' +
    '<circle cx="7.5" cy="7.5" r="1.1"/>',
  // Bulleted list — "summarize the PR".
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  // Magnifier — "review the whole PR".
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  // Beaker / flask — "test-gap check".
  beaker:
    '<path d="M9 3h6M10 3v6.5L4.6 18a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 9.5V3"/>' +
    '<path d="M7 15h10"/>',
  // Circled "i" — Minor severity.
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  // Small filled dot — Nit severity.
  dot: '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
  // Question mark in a circle — "what can Cortex do?" help.
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2-2.4 3.3"/><path d="M12 17h.01"/>',
  // Curved arrow back — "undo the post".
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  // Circular arrows — "refresh the page to show the comment".
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/>',
  // Shield — "secrets masked before sending".
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
}

export function icon(name: IconName, size = 16): string {
  return (
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`
  )
}
