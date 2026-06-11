// Rasterize public/icons/icon.svg → PNG icons at the manifest sizes.
// Run via `npm run icons` whenever icon.svg changes.
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const svg = readFileSync(join(iconsDir, 'icon.svg'), 'utf8')

for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  writeFileSync(join(iconsDir, `icon-${size}.png`), png)
  console.log(`wrote icon-${size}.png (${png.length} bytes)`)
}
