// Build a Chrome Web Store-ready ZIP from a fresh production build.
//
//   npm run package
//
// Produces web-store/cortex-<version>.zip (gitignored) — upload that to the
// Chrome Web Store dashboard. The ZIP is the contents of dist/ (the manifest
// must sit at the archive root, so we zip from inside dist/).

import { execSync } from 'node:child_process'
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const outDir = 'web-store'
const out = `${outDir}/cortex-${version}.zip`

console.log(`\n▸ Building production bundle (v${version})…`)
execSync('npm run build', { stdio: 'inherit' })

if (!existsSync('dist/manifest.json')) {
  console.error('✗ dist/manifest.json not found — build did not produce a valid extension.')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
rmSync(out, { force: true })

console.log(`\n▸ Zipping dist/ → ${out}`)
// -r recurse, -X strip extra file attributes, exclude macOS cruft. Run from dist/ so
// manifest.json lands at the archive root (the store requires that).
execSync(`cd dist && zip -r -X "../${out}" . -x '*.DS_Store' '__MACOSX/*'`, { stdio: 'inherit' })

console.log(`\n✓ Packaged ${out}`)
console.log('  Upload it at https://chrome.google.com/webstore/devconsole')
