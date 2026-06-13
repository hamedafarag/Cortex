import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      // Extra extension page (not referenced in the manifest) — opened at runtime via the
      // dock's "?" button. Listing it here makes CRXJS emit dist/src/help/help.html.
      input: {
        help: 'src/help/help.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
})
