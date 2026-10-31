import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { inspectMobileElf } from './mobile-runtime-libraries.mjs'

/** ICU's derb/genrb own the binary format. Only replace the flat InstalledLocales table. */
export function filterIcuLocaleIndex(source, languages) {
  const start = /\bInstalledLocales\s*(?::table)?\s*\{/.exec(source)
  if (!start) throw new Error('ICU resource index has no InstalledLocales table')
  const first = start.index + start[0].length
  let end = first, depth = 1
  for (; end < source.length && depth; end++) {
    if (source[end] === '{') depth++
    if (source[end] === '}') depth--
  }
  if (depth) throw new Error('Unterminated ICU InstalledLocales table')
  const body = source.slice(first, end - 1)
  const entry = /"?([A-Za-z0-9_]+)"?\s*\{\s*""\s*\}/g
  if (body.replace(entry, '').trim()) throw new Error('Unexpected ICU InstalledLocales entry')
  const locales = [...body.matchAll(entry)].map((match) => match[1])
  const keep = locales.filter((locale) => locale === 'root' || languages.includes(locale.split('_')[0]))
  return { source: source.slice(0, first) + '\n' + keep.map((locale) => `        ${locale} { "" }`).join('\n') + '\n    ' + source.slice(end - 1), locales: keep }
}

/** Repackage the verified ICU data object using ICU tools and LLVM; Node itself is unchanged. */
export async function trimMobileIcu({ input, output, work, languages, version }) {
  await mkdir(work, { recursive: true })
  const icu = (name) => process.env.GUGU_MOBILE_ICU_PREFIX ? join(process.env.GUGU_MOBILE_ICU_PREFIX, name === 'icupkg' ? 'sbin' : 'bin', name) : name
  const llvm = (name) => process.env.GUGU_MOBILE_LLVM_PREFIX ? join(process.env.GUGU_MOBILE_LLVM_PREFIX, 'bin', name) : name
  let sequence = 0
  const run = (tool, args) => {
    const result = spawnSync(tool, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 })
    const log = join(work, `tool-${++sequence}`)
    writeFileSync(log + '.stdout.log', result.stdout ?? '')
    writeFileSync(log + '.stderr.log', result.stderr ?? '')
    writeFileSync(log + '.json', JSON.stringify({ tool, args, rc: result.status, signal: result.signal, error: result.error?.message }) + '\n')
    console.log(`[mobile-icu] ${basename(tool)} rc=${result.status}`)
    console.log((result.stdout ?? '').split('\n').slice(-8).join('\n'))
    console.log((result.stderr ?? '').split('\n').slice(-8).join('\n'))
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${basename(tool)} failed with exit ${result.status}; raw output: ${log}`)
    return result.stdout
  }
  const readelf = llvm('llvm-readelf')
  const original = inspectMobileElf(input, readelf)
  const major = version.split('.')[0]
  if (original.soname !== `libicudata.so.${major}` || original.needed.length) throw new Error('Unexpected ICU data library linkage')
  const symbols = run(readelf, ['--dyn-syms', '--wide', input])
  if (!new RegExp(`\\bOBJECT\\s+GLOBAL\\s+DEFAULT\\s+\\d+\\s+icudt${major}_dat\\b`).test(symbols)) throw new Error('ICU data symbol differs from locked version')
  const datName = `icudt${major}l.dat`, dat = join(work, datName)
  run(llvm('llvm-objcopy'), ['--dump-section', `.rodata=${dat}`, input, join(work, 'original-data.so')])
  const items = run(icu('icupkg'), ['--list', dat]).trim().split(/\r?\n/)
  const indexes = items.filter((name) => name === 'res_index.res' || name.endsWith('/res_index.res'))
  if (!indexes.length) throw new Error('ICU package has no locale indexes')
  const indexRoot = join(work, 'indexes'), filtered = join(work, 'filtered')
  await mkdir(indexRoot, { recursive: true }); await mkdir(filtered, { recursive: true })
  const indexList = join(work, 'indexes.lst')
  await writeFile(indexList, indexes.join('\n') + '\n')
  run(icu('icupkg'), ['--extract', indexList, '--destdir', indexRoot, dat])
  for (const index of indexes) {
    const directory = dirname(join(indexRoot, index))
    const source = run(icu('derb'), ['--to-stdout', '--sourcedir', directory, 'res_index'])
    const result = filterIcuLocaleIndex(source, languages)
    const text = join(directory, 'res_index.txt')
    await writeFile(text, result.source)
    run(icu('genrb'), ['--quiet', '--encoding', 'UTF-8', '--destdir', directory, text])
  }
  // Locale resource trees are declared by their res_index, not guessed from arbitrary data names.
  const trees = new Set(indexes.map((index) => index.slice(0, -'res_index.res'.length)))
  const removed = items.filter((name) => {
    if (indexes.includes(name)) return false
    const prefix = name.slice(0, name.length - basename(name).length)
    const locale = /^([a-z]{2,3})(?:_[A-Za-z0-9]*)*\.res$/.exec(basename(name))
    return trees.has(prefix) && locale && !languages.includes(locale[1])
  })
  if (!removed.length) throw new Error('ICU locale filter removed no data')
  const removeList = join(work, 'remove.lst'), smallDat = join(filtered, datName)
  await writeFile(removeList, removed.join('\n') + '\n')
  // Leave dependency validation enabled: a missing parent, pool, dictionary or alias is a build error.
  run(icu('icupkg'), ['--remove', removeList, '--add', indexList, '--sourcedir', indexRoot, dat, smallDat])
  const retained = run(icu('icupkg'), ['--list', smallDat]).trim().split(/\r?\n/)
  for (const locale of ['root', ...languages]) if (!retained.includes(`${locale}.res`)) throw new Error(`ICU lost required locale ${locale}`)
  if (removed.some((name) => retained.includes(name))) throw new Error('ICU filter left removed resources')
  const symbol = `icudt${major}_dat`, assembly = join(work, 'icudata.S')
  await writeFile(assembly, `.section .rodata,"a",%progbits\n.balign 16\n.global ${symbol}\n.type ${symbol}, %object\n${symbol}:\n.incbin ${JSON.stringify(smallDat)}\n.size ${symbol}, .-${symbol}\n.section .note.GNU-stack,"",%progbits\n`)
  run(llvm('clang'), ['--target=aarch64-linux-android26', `-fuse-ld=${process.env.GUGU_MOBILE_LLVM_PREFIX ? llvm('ld.lld') : 'lld'}`, '-nostdlib', '-shared', '-Wl,-z,max-page-size=16384', `-Wl,-soname,${original.soname}`, assembly, '-o', output])
  const linked = inspectMobileElf(output, readelf)
  const before = await readFile(input), after = await readFile(output)
  if (linked.soname !== original.soname || linked.needed.length || after.length >= before.length) throw new Error('Invalid filtered ICU data library')
  return { version, languages: ['root', ...languages], soname: linked.soname, symbol, originalBytes: before.length, bytes: after.length,
    originalSha256: createHash('sha256').update(before).digest('hex'), dataSha256: createHash('sha256').update(await readFile(smallDat)).digest('hex'),
    sha256: createHash('sha256').update(after).digest('hex'), retained, removed }
}
