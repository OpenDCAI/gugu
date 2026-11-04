const fs = require('node:fs')
const { createRequire } = require('node:module')

// @electron/osx-sign treats every binary resource (fonts/images/wasm/archives)
// as executable code. Those files are sealed by their enclosing bundle. Only
// Mach-O code and nested bundles need individual Developer ID signatures.
const MACH_O = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca])
function isCode(file) {
  const stat = fs.statSync(file)
  if (stat.isDirectory()) return true
  const header = Buffer.alloc(4)
  const fd = fs.openSync(file, 'r')
  try {
    return fs.readSync(fd, header, 0, 4, 0) === 4 && MACH_O.has(header.readUInt32BE(0))
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = async function sign(options) {
  const electronRequire = createRequire(require.resolve('electron-builder/package.json'))
  const builderRequire = createRequire(electronRequire.resolve('app-builder-lib/package.json'))
  const { signAsync } = builderRequire('@electron/osx-sign')
  const previousIgnore = options.ignore
  let code = 0
  let resources = 0
  const started = Date.now()
  await signAsync({
    ...options,
    ignore(file) {
      if (previousIgnore?.(file)) return true
      if (isCode(file)) { code++; return false }
      resources++
      return true
    },
  })
  process.stdout.write(`[mac-signing] signed ${code} code paths; sealed ${resources} resources in bundle; ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
}

module.exports.isCode = isCode
