import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { readTreeBlobs, repoRoot, treeFiles } from './git-tree-blobs.mjs'

const RULE = 'console-member'
const TYPESCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])
const DEFAULT_BASELINE = 'scripts/console-usage-baseline.json'

function normalizeRoots(rootArgs, rootDirectory) {
  const values = Array.isArray(rootArgs) ? rootArgs : [rootArgs]
  if (values.length === 0 || values.some((value) => !value)) throw new Error('missing required --root path')
  const roots = values.map((value) => {
    const absolute = path.resolve(rootDirectory, value)
    const relative = path.relative(rootDirectory, absolute)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`--root must be inside the repository: ${value}`)
    }
    return relative.split(path.sep).join('/')
  })
  const unique = [...new Set(roots)].sort()
  for (let index = 0; index < unique.length; index += 1) {
    for (let other = index + 1; other < unique.length; other += 1) {
      if (unique[other].startsWith(`${unique[index]}/`)) {
        throw new Error(`--root paths overlap: ${unique[index]} and ${unique[other]}`)
      }
    }
  }
  return unique
}

function scriptKindFor(file) {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.tsx' || extension === '.jsx') return ts.ScriptKind.TSX
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function unwrap(node) {
  let current = node
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function isConsoleMember(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false
  const receiver = unwrap(node.expression)
  return Boolean(receiver && ts.isIdentifier(receiver) && receiver.text === 'console')
}

function countSource(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file))
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0]
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    throw new Error(`${file}: TypeScript parse error at ${diagnostic.start ?? 0}: ${message}`)
  }
  let count = 0
  function visit(node) {
    if (isConsoleMember(node)) count += 1
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return count
}

/** Count committed source, not the caller's dirty working tree. */
export function countTree(ref, rootArgs, rootDirectory = repoRoot()) {
  const roots = normalizeRoots(rootArgs, rootDirectory)
  const entries = []
  let total = 0
  let scanned = 0
  const wanted = treeFiles(ref, roots, rootDirectory)
    .filter((file) => TYPESCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase()))
  const blobs = readTreeBlobs(ref, wanted, rootDirectory)
  for (const file of wanted) {
    scanned += 1
    const count = countSource(blobs.get(file), file)
    total += count
    if (count > 0) entries.push({ rule: RULE, file, count })
  }
  return { entries, total, scanned, roots }
}

const entryKey = (entry) => `${entry.rule}\0${entry.file}`

/** NEW catches growth; STALE forces every reduction to be registered in the generated baseline. */
export function compareToBaseline(actualEntries, baselineEntries) {
  const actualByKey = new Map(actualEntries.map((entry) => [entryKey(entry), entry]))
  const baselineByKey = new Map(baselineEntries.map((entry) => [entryKey(entry), entry]))
  const added = []
  const stale = []
  for (const [key, entry] of actualByKey) {
    const expected = baselineByKey.get(key)
    if (!expected || entry.count > expected.count) added.push({ ...entry, baselineCount: expected?.count ?? 0 })
  }
  for (const [key, entry] of baselineByKey) {
    const observed = actualByKey.get(key)
    if (!observed || observed.count < entry.count) stale.push({ ...entry, actualCount: observed?.count ?? 0 })
  }
  return { added, stale }
}

function validateBaseline(parsed, baselineFile) {
  if (!Array.isArray(parsed)) throw new Error(`${baselineFile}: baseline must be a JSON array`)
  const seen = new Set()
  return parsed.map((entry, index) => {
    const at = `${baselineFile}[${index}]`
    if (!entry || typeof entry !== 'object') throw new Error(`${at}: entry must be an object`)
    if (entry.rule !== RULE) throw new Error(`${at}: unknown rule ${JSON.stringify(entry.rule)}`)
    if (typeof entry.file !== 'string' || entry.file.length === 0) throw new Error(`${at}: missing file`)
    if (!Number.isInteger(entry.count) || entry.count <= 0) throw new Error(`${at}: count must be a positive integer`)
    const key = entryKey(entry)
    if (seen.has(key)) throw new Error(`${at}: duplicate entry for ${entry.rule} ${entry.file}`)
    seen.add(key)
    return { rule: entry.rule, file: entry.file, count: entry.count }
  })
}

function readBaseline(baselineFile, rootDirectory) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path.resolve(rootDirectory, baselineFile), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`baseline not found: ${baselineFile}`)
    throw new Error(`${baselineFile}: invalid JSON: ${error.message}`)
  }
  return validateBaseline(parsed, baselineFile)
}

function parseArgs(argv) {
  const options = { ref: 'HEAD', baseline: DEFAULT_BASELINE, roots: [], write: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help') return { help: true }
    if (flag === '--write') {
      options.write = true
      continue
    }
    if (!['--ref', '--root', '--baseline'].includes(flag)) throw new Error(`unknown option: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (flag === '--root') options.roots.push(value)
    else options[flag.slice(2)] = value
    index += 1
  }
  if (options.roots.length === 0) throw new Error('missing required --root')
  return options
}

function usage() {
  return [
    'Usage: node scripts/console-usage-check.mjs --root <git-path> [--root <git-path> ...] [--ref <git-ref>] [--baseline <file>] [--write]',
    '',
    '  TypeScript AST scan of direct console member usage, reconciled per (rule,file).',
    '  --write records reductions only; it refuses NEW debt.',
  ].join('\n')
}

function formatEntry(prefix, entry, actual, expected) {
  return `${prefix} ${entry.rule} ${entry.file}: baseline=${expected} actual=${actual}`
}

export function run(argv, output = console) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      output.log(usage())
      return 0
    }
    const rootDirectory = repoRoot()
    const actual = countTree(options.ref, options.roots, rootDirectory)
    const baseline = readBaseline(options.baseline, rootDirectory)
    const baselineTotal = baseline.reduce((sum, entry) => sum + entry.count, 0)
    output.log(`console-member: baseline=${baselineTotal} actual=${actual.total}`)
    output.log(`scanned: code=${actual.scanned} roots=${actual.roots.join(',')} (denominator for the count above)`)
    const { added, stale } = compareToBaseline(actual.entries, baseline)

    if (options.write) {
      if (added.length > 0) {
        for (const entry of added) output.error(formatEntry('::error::NEW', entry, entry.count, entry.baselineCount))
        output.error('::error::--write refuses to record NEW console debt; migrate the call to the structured logger.')
        return 1
      }
      writeFileSync(path.resolve(rootDirectory, options.baseline), `${JSON.stringify(actual.entries, null, 2)}\n`)
      output.log(`baseline updated: ${options.baseline} (${actual.entries.length} entries)`)
      return 0
    }

    for (const entry of added) output.error(formatEntry('::error::NEW', entry, entry.count, entry.baselineCount))
    for (const entry of stale) output.error(formatEntry('::error::STALE', entry, entry.actualCount, entry.count))
    if (added.length > 0) output.error('::error::console debt increased; use createLogger, rendererLogger, or coreLogger.')
    if (stale.length > 0) {
      output.error(
        '::error::console baseline is stale after a reduction; run this command with --write and review the generated diff.',
      )
    }
    return added.length > 0 || stale.length > 0 ? 1 : 0
  } catch (error) {
    output.error(`console-usage-check: ${error.message}`)
    return 2
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = run(process.argv.slice(2))
