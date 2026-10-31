import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const normalized = (bytes) => bytes.toString('utf8').split(/\s+/u).filter(Boolean).join(' ')
const inside = (root, path) => {
  const full = resolve(root, path), part = relative(root, full)
  if (!part || isAbsolute(part) || part.startsWith('..')) throw new Error(`invalid mobile notice path: ${path}`)
  return full
}

/** Offline, version-bound supplements for upstream packages which omit their license text.
 * Repository/package metadata is provenance, not a replacement for the actual notice body. */
export async function copyMobileRuntimeNotices(root, out, kind, packages) {
  if (!['npm', 'native'].includes(kind)) throw new Error('invalid mobile notice kind')
  const sourceRoot = join(root, 'apps/mobile/runtime/licenses')
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'manifest.json'), 'utf8'))
  if (manifest.version !== 1) throw new Error('unsupported mobile notice manifest')
  const actual = new Map(packages.map((pkg) => [pkg.name, pkg.version]))
  const licenses = join(out, 'licenses')
  await rm(join(licenses, 'supplemental', kind), { recursive: true, force: true })
  const covered = new Map(), records = []
  for (const entry of manifest.entries.filter((item) => item.kind === kind)) {
    const matching = entry.packages.filter((pkg) => actual.has(pkg.name))
    if (!matching.length) continue
    for (const pkg of matching) if (actual.get(pkg.name) !== pkg.version) throw new Error(`${pkg.name}: mobile notice version must be reviewed for ${actual.get(pkg.name)}`)
    if (!/^[a-z0-9-]+$/.test(entry.id) || !entry.files.length) throw new Error('invalid mobile notice entry')
    for (const artifact of entry.artifacts ?? []) {
      if (sha256(await readFile(inside(out, artifact.path))) !== artifact.sha256) throw new Error(`${entry.id}: embedded artifact does not match its notice provenance`)
    }
    const files = []
    for (const file of entry.files) {
      const installed = file.installedPath ? packages.find((pkg) => pkg.name === matching[0].name && pkg.version === matching[0].version)?.directory : null
      if (file.installedPath && !installed) throw new Error(`${entry.id}: copied package directory is missing`)
      const source = file.installedPath ? inside(installed, file.installedPath) : inside(sourceRoot, file.path)
      const bytes = await readFile(source)
      if (sha256(bytes) !== file.sha256) throw new Error(`${file.path}: mobile notice checksum mismatch`)
      const path = file.coveredBy ?? `supplemental/${kind}/${file.path}`
      const target = inside(licenses, path)
      if (file.coveredBy) {
        if (!normalized(await readFile(target)).includes(normalized(bytes))) throw new Error(`${entry.id}: existing notice no longer contains the complete upstream license`)
      } else {
        await mkdir(dirname(target), { recursive: true })
        await cp(source, target)
      }
      files.push({ ...file, path, sourceTextSha256: file.sha256, sha256: sha256(await readFile(target)) })
    }
    for (const pkg of matching) covered.set(`${pkg.name}@${pkg.version}`, files.map((file) => file.path))
    records.push({ ...entry, packages: matching, files })
  }
  await mkdir(licenses, { recursive: true })
  await writeFile(join(licenses, `${kind}-sources.json`), `${JSON.stringify({ version: 1, entries: records }, null, 2)}\n`)
  return covered
}
