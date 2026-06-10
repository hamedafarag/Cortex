// Content script — entry point.
// Dock mounting (#10/#11) and selection mapping (#12) land in later tasks.

// A presence marker on the shared DOM: readable from the page context (useful for
// load verification) and a guard against double-injection on GitHub's SPA navigations.
function markPresence(): void {
  if (document.documentElement.dataset.ycraLoaded) return
  document.documentElement.dataset.ycraLoaded = '0.0.0'
  console.log('[YCRA] content script loaded on', location.href)
}

markPresence()

export {}
