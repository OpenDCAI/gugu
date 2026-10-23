import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Termux keeps only the newest build of each package, so a pinned archive disappears upstream as soon as Termux
// rebuilds it. Builds therefore read only from our mirror (`lock.mirror`, one release asset per archive, named by
// its SHA-256 so an asset never changes once uploaded). Run this after changing android-node.lock.json, while
// upstream still serves the new archives; it uploads whatever the mirror is missing. Needs `gh` signed in with
// write access to the mirror's repository.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await readFile(join(root, 'apps/mobile/runtime/android-node.lock.json'), 'utf8'))
const mirror = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)$/.exec(lock.mirror)
if (!mirror) throw new Error(`mirror must be a GitHub release download URL: ${lock.mirror}`)
const [, repo, tag] = mirror
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' })

const present = new Set(JSON.parse(gh('release', 'view', tag, '-R', repo, '--json', 'assets')).assets.map((asset) => asset.name))
const scratch = await mkdtemp(join(tmpdir(), 'mobile-node-mirror-'))
try {
  for (const pkg of lock.packages) {
    const asset = `${pkg.sha256}.deb`
    if (present.has(asset)) {
      console.log(`[mobile-node-mirror] ${pkg.name}@${pkg.version}: already mirrored`)
      continue
    }
    const response = await fetch(`${lock.repository}/${pkg.path}`)
    if (!response.ok) throw new Error(`${pkg.name}@${pkg.version}: upstream answered HTTP ${response.status}; it no longer serves this build, so pin the current one instead`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== pkg.size || createHash('sha256').update(bytes).digest('hex') !== pkg.sha256) throw new Error(`${pkg.name}@${pkg.version}: upstream archive does not match the lock`)
    const file = join(scratch, asset)
    await writeFile(file, bytes)
    gh('release', 'upload', tag, file, '-R', repo)
    console.log(`[mobile-node-mirror] ${pkg.name}@${pkg.version}: uploaded ${asset}`)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
