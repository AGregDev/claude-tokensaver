// Packs dist/tokensaver/ (see build.mjs) into dist/tokensaver-<version>.tar.gz
// with its SHA-256 beside it. `tar` ships with Linux, macOS and Windows 10+.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

if (!existsSync(join(dist, 'tokensaver', '.claude-plugin', 'plugin.json'))) {
  console.error('package: nothing staged. Run `npm run build` first.')
  process.exit(1)
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const name = `tokensaver-${version}.tar.gz`
const tar = spawnSync('tar', ['-czf', name, 'tokensaver'], { cwd: dist, stdio: 'inherit' })

if (tar.status !== 0) {
  console.error('package: tar failed')
  process.exit(1)
}

const digest = createHash('sha256')
  .update(readFileSync(join(dist, name)))
  .digest('hex')

writeFileSync(join(dist, `${name}.sha256`), `${digest}  ${name}\n`)
console.log(`package: dist/${name}`)
console.log(`package: sha256 ${digest}`)
