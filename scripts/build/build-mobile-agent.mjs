import { build } from 'esbuild'
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyMobileRuntimeNotices } from './mobile-runtime-notices.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const piRoot = await realpath(join(root, 'apps/mobile/node_modules/@earendil-works/pi-coding-agent'))
const out = join(root, 'apps/mobile/android/app/src/main/assets/agent-runtime')
await mkdir(out, { recursive: true })
const built = await build({
  entryPoints: [join(root, 'apps/mobile/runtime/agent.mjs')], outfile: join(out, 'agent.mjs'), bundle: true,
  platform: 'node', target: 'node24', format: 'esm', minify: true,
  banner: { js: "import { createRequire as __guguCreateRequire } from 'node:module'; const require = __guguCreateRequire(import.meta.url);" },
  external: ['@earendil-works/clipboard', 'quickjs-wasi', '@silvia-odwyer/photon-node'],
  alias: { '@capacitor/core': join(root, 'apps/mobile/runtime/phone-capacitor.mjs') }, metafile: true,
})
// Keep the license and notice files of every npm package actually included in the embedded bundle.
const packages = new Map()
for (const input of Object.keys(built.metafile.inputs).filter((path) => path.includes('node_modules/'))) {
  let directory = dirname(resolve(root, input))
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (metadata.name && metadata.version) { packages.set(directory, metadata); break }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    directory = dirname(directory)
  }
}
// These external WASM packages are copied whole below, so esbuild cannot inventory them.
const externalPackages = new Map()
for (const name of ['quickjs-wasi', '@silvia-odwyer/photon-node']) {
  const directory = await realpath(join(piRoot, '..', '..', name))
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (metadata.name !== name || !metadata.version) throw new Error(`${name}: invalid copied runtime package metadata`)
  externalPackages.set(name, directory)
  packages.set(directory, metadata)
}
const notices = []
await rm(join(out, 'licenses/npm'), { recursive: true, force: true })
for (const [directory, metadata] of packages) {
  const names = (await readdir(directory)).filter((name) => /^(?:licen[cs]e|copying|copyright|notice)(?:[.-].*)?$/i.test(name))
  const target = join(out, 'licenses/npm', `${metadata.name.replaceAll('/', '__')}-${metadata.version}`)
  await mkdir(target, { recursive: true })
  for (const name of names) await cp(join(directory, name), join(target, name), { recursive: true })
  // Paths in the inventory are relative to licenses/, including shared monorepo notices.
  const files = names.map((name) => `npm/${metadata.name.replaceAll('/', '__')}-${metadata.version}/${name}`)
  notices.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? null, files })
}
const supplemental = await copyMobileRuntimeNotices(root, out, 'npm', [...packages].map(([directory, metadata]) => ({ ...metadata, directory })))
for (const pkg of notices) {
  pkg.files = [...new Set([...pkg.files, ...(supplemental.get(`${pkg.name}@${pkg.version}`) ?? [])])]
  if (!pkg.files.length) throw new Error(`${pkg.name}@${pkg.version}: embedded npm package has no license/notice body`)
}
await writeFile(join(out, 'licenses/npm-packages.json'), JSON.stringify(notices, null, 2))
await cp(join(piRoot, 'package.json'), join(out, 'package.json'))
// Pi's model catalogs and built-in themes are runtime resources, not JS imports.
const aiRoot = await realpath(join(piRoot, '../pi-ai'))
await cp(join(aiRoot, 'dist/providers/data'), join(out, 'data'), { recursive: true })
for (const [name, source] of externalPackages) {
  await cp(source, join(out, 'node_modules', name), { recursive: true, filter: (path) => !path.endsWith('.map') })
}
await cp(join(piRoot, 'dist/modes/interactive/theme'), join(out, 'dist/modes/interactive/theme'), { recursive: true })
const pkg = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8'))
await writeFile(join(out, 'pi-version.json'), JSON.stringify({ version: pkg.version }))
console.log(`[mobile-agent] Pi ${pkg.version}, SDK bundled`)
