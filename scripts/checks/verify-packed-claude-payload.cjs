const fs = require('node:fs')
const path = require('node:path')

// Thin desktop packages run the selected host CLI. The SDK JavaScript and ACP
// bridge stay in the app; the SDK's native fallback must never be shipped.
function verifyPackedClaudePayload(resourcesDir) {
  const root = fs.realpathSync(resourcesDir)
  const appModules = path.join(root, 'app', 'node_modules')
  if (!fs.statSync(appModules).isDirectory()) {
    throw new Error('[thin-claude-payload] app/node_modules is not a directory')
  }
  const visited = new Set()
  const forbidden = new Set()
  let checkedDirectories = 0

  function checkName(file) {
    if (path.basename(path.dirname(file)) === '@anthropic-ai'
        && path.basename(file).startsWith('claude-agent-sdk-')) {
      forbidden.add(path.relative(root, file))
    }
  }

  function boundedRealpath(file) {
    const actual = fs.realpathSync(file)
    const relative = path.relative(root, actual)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`[thin-claude-payload] cannot verify dependency outside resources: ${path.relative(root, file)}`)
    }
    return actual
  }

  function visit(file) {
    checkName(file)
    const actual = boundedRealpath(file)
    checkName(actual)
    if (!fs.statSync(actual).isDirectory() || visited.has(actual)) return
    visited.add(actual)
    checkedDirectories++
    const manifest = path.join(actual, 'package.json')
    if (fs.existsSync(manifest)) {
      const source = boundedRealpath(manifest)
      let name
      try {
        name = JSON.parse(fs.readFileSync(source, 'utf8')).name
      } catch {
        throw new Error(`[thin-claude-payload] cannot verify package metadata: ${path.relative(root, manifest)}`)
      }
      if (typeof name === 'string' && name.startsWith('@anthropic-ai/claude-agent-sdk-')) {
        forbidden.add(path.relative(root, actual))
      }
    }
    for (const entry of fs.readdirSync(actual, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) visit(path.join(actual, entry.name))
    }
  }

  visit(appModules)
  const acp = path.join(root, 'acp')
  if (fs.existsSync(acp)) visit(acp)
  if (forbidden.size) {
    throw new Error(`[thin-claude-payload] bundled Claude native packages: ${[...forbidden].sort().join(', ')}`)
  }
  return { checkedDirectories, nativePackages: 0 }
}

module.exports = { verifyPackedClaudePayload }
