import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

// Android's linker supplies these; every other dependency must resolve in the locked packages.
const systemLibraries = new Set(['libc.so', 'libm.so', 'libdl.so'])

export function inspectMobileElf(path, readelf = 'llvm-readelf') {
  const output = execFileSync(readelf, ['--file-header', '--dynamic', '--wide', path], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (!/Class:\s+ELF64/.test(output) || !/Machine:\s+AArch64/.test(output)) throw new Error(`${basename(path)}: expected locked AArch64 ELF`)
  if (!output.includes('Dynamic section')) throw new Error(`${basename(path)}: no ELF dynamic section`)
  const needed = [...output.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map((match) => match[1])
  const sonames = [...output.matchAll(/\(SONAME\).*\[([^\]]+)\]/g)].map((match) => match[1])
  if (sonames.length > 1) throw new Error(`${basename(path)}: ambiguous ELF SONAME`)
  return { needed, soname: sonames[0] ?? null }
}

/** Follow the same filenames and symlinks that LD_LIBRARY_PATH exposes to Android. */
export function mobileRuntimeClosure(node, libraries, aliases) {
  const links = new Map(aliases.map(({ name, target }) => [name, target]))
  if (links.size !== aliases.length) throw new Error('Duplicate mobile library alias')
  const resolve = (name) => {
    const seen = new Set()
    while (links.has(name)) {
      if (seen.has(name)) throw new Error(`Mobile library alias cycle: ${name}`)
      seen.add(name)
      name = links.get(name)
      if (basename(name) !== name) throw new Error(`Mobile library alias escapes lib/: ${name}`)
    }
    if (!libraries.has(name)) throw new Error(`Unresolved mobile native library: ${name}`)
    return name
  }
  const selected = new Set(), pending = [...node.needed], edges = []
  while (pending.length) {
    const requested = pending.shift()
    if (systemLibraries.has(requested)) continue
    const name = resolve(requested), library = libraries.get(name)
    if (library.soname && library.soname !== requested) throw new Error(`${requested}: resolved SONAME is ${library.soname}`)
    edges.push({ requested, file: name, soname: library.soname })
    if (selected.has(name)) continue
    selected.add(name)
    pending.push(...library.needed)
  }
  const retainedAliases = aliases.filter(({ name }) => selected.has(resolve(name)))
  return { files: [...selected].sort(), aliases: retainedAliases, edges }
}
