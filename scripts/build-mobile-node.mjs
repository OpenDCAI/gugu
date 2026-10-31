import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyMobileRuntimeNotices } from './mobile-runtime-notices.mjs'
import { inspectMobileElf, mobileRuntimeClosure } from './mobile-runtime-libraries.mjs'
import { trimMobileIcu } from './mobile-runtime-icu.mjs'

// Only the Android Node executable and its shared libraries; no terminal, npm or shell tools.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await readFile(join(root, 'apps/mobile/runtime/android-node.lock.json'), 'utf8'))
const cache = join(root, '.scratch/mobile-node')
const assets = join(root, 'apps/mobile/android/app/src/main/assets/agent-runtime')
const native = join(root, 'apps/mobile/android/app/src/main/jniLibs', lock.architecture)
await mkdir(cache, { recursive: true })
await mkdir(native, { recursive: true })
await mkdir(assets, { recursive: true })
await rm(join(assets, 'licenses/termux'), { recursive: true, force: true })
await rm(join(assets, 'lib'), { recursive: true, force: true })
await mkdir(join(assets, 'lib'), { recursive: true })
const aliases = []
const notices = []
const libraries = new Map()
let node
async function copyNotices(directory, target, base = directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await copyNotices(path, target, base)))
    else if (entry.isFile() && /^(?:licen[cs]e|copying|copyright|notice)(?:[.-].*)?$/i.test(entry.name)) {
      const destination = join(target, relative(base, path))
      await mkdir(dirname(destination), { recursive: true })
      await cp(path, destination)
      files.push(relative(base, path))
    }
  }
  return files
}
for (const pkg of lock.packages) {
  const archive = join(cache, `${pkg.name}.deb`)
  let bytes
  try { bytes = await readFile(archive) } catch { /* first build */ }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== pkg.sha256) {
    // From our mirror, not upstream: Termux deletes a build once it is superseded (see mirror-mobile-node.mjs).
    const response = await fetch(`${lock.mirror}/${pkg.sha256}.deb`)
    if (!response.ok) throw new Error(`${pkg.name}@${pkg.version}: mirror answered HTTP ${response.status}; run node scripts/mirror-mobile-node.mjs`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== pkg.sha256) throw new Error(`${pkg.name}: checksum mismatch`)
    await writeFile(archive, bytes)
  }
  const unpack = join(cache, pkg.name)
  await rm(unpack, { recursive: true, force: true })
  await mkdir(unpack, { recursive: true })
  let data
  let member
  for (let offset = 8; offset + 60 < bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 16).trim().replace(/\/$/, '')
    const size = Number(bytes.toString('ascii', offset + 48, offset + 58).trim())
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${pkg.name}: invalid ar header`)
    if (name.startsWith('data.tar.')) { member = name; data = bytes.subarray(offset + 60, offset + 60 + size); break }
    offset += 60 + size + size % 2
  }
  if (!data) throw new Error(`${pkg.name}: missing data archive`)
  const tar = join(cache, member)
  await writeFile(tar, data)
  execFileSync('tar', ['-xf', tar, '-C', unpack])
  const prefix = join(unpack, 'data/data/com.termux/files/usr')
  const files = (await copyNotices(join(prefix, 'share'), join(assets, 'licenses/termux', pkg.name))).map((path) => `termux/${pkg.name}/${path}`)
  const artifacts = []
  if (pkg.name === 'nodejs-lts') {
    node = inspectMobileElf(join(prefix, 'bin/node'))
    await cp(join(prefix, 'bin/node'), join(native, 'libgugu_node.so'))
    artifacts.push(`lib/${lock.architecture}/libgugu_node.so`)
  }
  const libs = join(prefix, 'lib')
  for (const name of await readdir(libs).catch((error) => { if (error.code === 'ENOENT') return []; throw error })) {
    if (!/\.so(?:\.|$)/.test(name) || !(await stat(join(libs, name))).isFile()) continue
    if ((await lstat(join(libs, name))).isSymbolicLink()) {
      aliases.push({ name, target: await readlink(join(libs, name)) })
      continue
    }
    if (libraries.has(name)) throw new Error(`Duplicate mobile native library: ${name}`)
    libraries.set(name, { path: join(libs, name), artifacts, ...inspectMobileElf(join(libs, name)) })
  }
  if (pkg.name === 'ca-certificates') { await cp(join(prefix, 'etc/tls/cert.pem'), join(assets, 'ca.pem')); artifacts.push('assets/agent-runtime/ca.pem') }
  notices.push({ name: pkg.name, version: pkg.version, source: `${lock.repository}/${pkg.path}`, sourceSha256: pkg.sha256, artifacts, files })
  console.log(`[mobile-node] ${pkg.name}@${pkg.version}: verified`)
}
const closure = mobileRuntimeClosure(node, libraries, aliases)
for (const name of closure.files) {
  const library = libraries.get(name)
  if (library.soname?.startsWith('libicudata.so.')) {
    const version = lock.packages.find((pkg) => pkg.name === 'libicu').version
    const data = await trimMobileIcu({ input: library.path, output: join(assets, 'lib', name), work: join(cache, 'icu-filtered'), languages: ['en', 'zh', 'ja'], version })
    await writeFile(join(assets, 'icu-data.json'), `${JSON.stringify(data, null, 2)}\n`)
  } else await cp(library.path, join(assets, 'lib', name))
  library.artifacts.push(`assets/agent-runtime/lib/${name}`)
}
await writeFile(join(assets, 'native-libraries.json'), `${JSON.stringify({ node, files: closure.files, edges: closure.edges }, null, 2)}\n`)
const supplemental = await copyMobileRuntimeNotices(root, assets, 'native', lock.packages)
for (const pkg of notices) {
  pkg.files.push(...(supplemental.get(`${pkg.name}@${pkg.version}`) ?? []))
  if (pkg.artifacts.length && !pkg.files.length) throw new Error(`${pkg.name}@${pkg.version}: embedded native package has no license/notice body`)
}
await writeFile(join(assets, 'licenses/native-packages.json'), `${JSON.stringify(notices, null, 2)}\n`)
await writeFile(join(assets, 'runtime.json'), JSON.stringify({ node: '24.18.0', architecture: lock.architecture, packages: lock.packages.map(({ name, version }) => ({ name, version })) }))
await writeFile(join(assets, 'library-aliases.json'), JSON.stringify(closure.aliases))
for (const name of ['intl-smoke.mjs', 'intl-smoke-cli.mjs']) await cp(join(root, 'apps/mobile/runtime', name), join(assets, name))
