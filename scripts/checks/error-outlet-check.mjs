import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { readTreeBlobs, repoRoot, treeFiles } from './git-tree-blobs.mts'

// @@@unhandled-error-event (#4942) — 拦「新建了长命的错误发射器,却没人订阅它的 'error'」。
//
// 为什么值得一道机械检查:Node 对**零监听者**的 'error' 事件一视同仁地抛成未捕获异常。在 Electron 主进程
// 或会话页宿主里,一条子进程管道断掉 = 整个宿主连同它承载的所有会话一起死。这类失败异步发生,调用点的
// try/catch 接不住,四门全绿也照不出来 —— 只有真跑到那条极端路径才显形。#4942 一次扫出 19 处同形状,
// 其中 10 处**整份文件一个 'error' 订阅都没有**,这道检查钉的就是那一档。
//
// 判据是**按文件**的粗判:这份文件起了子进程/服务端/套接字,却通篇没有任何 'error' 出口。粗,但几乎不误报,
// 而且正好覆盖最危险的那一档。同一文件内「本体挂了、stdin 没挂」这种细缝它判不出 —— 那属于 review 的活,
// 别为了显得严格把判据写成一堆猜测,那只会换来一片噪声和一条被人随手加宽的白名单。
//
// 测试文件不在扫描面内:测试进程崩掉是响亮的、就地的,不会带走用户的会话。这是有意的取舍,不是漏。

const RULE = 'error-outlet'
const TYPESCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])
const DEFAULT_BASELINE = 'scripts/checks/error-outlet-baseline.json'

/**
 * 认定「起了一个长命发射器」的判据 —— **必须能追溯到 node 的 child_process / net / http / tls,或 ws**。
 *
 * 光看函数名叫 spawn 是不够的:仓里 `host.spawn(spec)` 是我们自己的进程抽象,`connect(transport)` 是
 * wire 层的连线,它们都不产生任何 node 发射器。只按名字判会把这些一并算进来 —— 那不是「严格」,那是把
 * 基线撑成噪声,真债务反而藏在里面看不见。
 */
const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process'])
const SOCKET_MODULES = new Set(['node:net', 'net', 'node:tls', 'tls', 'node:http', 'http', 'node:https', 'https'])
const WS_MODULES = new Set(['ws'])
/**
 * 从上面那些模块 import 进来后,调用即产生长命发射器的名字。
 *
 * 名单里**没有 execFile / exec**,这是刻意的:回调式的那两个把失败交给回调,node 自己在内部挂了 'error',
 * 不存在「零监听者」的窗口。实测把它们算进来,全仓多出 8 处,一处真的都不是 —— 判据写宽不等于写严,
 * 它只会让基线里塞满永远不该被修的东西,真债务反而藏在中间。
 */
const EMITTER_FACTORY_NAMES = new Set([
  'spawn',
  'fork',
  'createServer',
  'createConnection',
  'connect',
  'WebSocket',
  'Server',
  'Socket',
])
/** `<对象>.<方法>()`:对象名必须是这些模块的命名空间导入,或 electron 的 utilityProcess。 */
const NAMESPACE_OBJECTS = new Set([
  'childProcess',
  'child_process',
  'cp',
  'net',
  'tls',
  'http',
  'https',
  'utilityProcess',
])
const NAMESPACE_METHODS = new Set(['spawn', 'fork', 'createServer', 'createConnection', 'connect'])
/** 认得出的错误出口。 */
const OUTLET_HELPERS = new Set(['onErrorEvent', 'onErrorEvents'])
const LISTENER_METHODS = new Set(['on', 'once', 'addListener', 'prependListener'])

function scriptKindFor(file) {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.tsx' || extension === '.jsx') return ts.ScriptKind.TSX
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * 判定核心。**独立于 git 和文件系统**,收一段源码文本就给结论 —— 这样阳性/阴性对照可以直接喂合成输入,
 * 而不必在真仓库里造一个违规出来(要证的是「判据能不能识别」,不是「系统能不能产生」)。
 */
export function analyzeSource(file, sourceText) {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  )
  // 先收集「从相关模块 import 进来的本地名字」,再据此判调用点 —— 名字相同但来路不同的一概不算。
  const emitterNames = new Set()
  const namespaceNames = new Set()
  const collectImports = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text
      const relevant = CHILD_PROCESS_MODULES.has(from) || SOCKET_MODULES.has(from) || WS_MODULES.has(from)
      const bindings = node.importClause?.namedBindings
      if (relevant && node.importClause?.name) emitterNames.add(node.importClause.name.text)
      if (relevant && bindings && ts.isNamespaceImport(bindings)) namespaceNames.add(bindings.name.text)
      if (relevant && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text
          if (EMITTER_FACTORY_NAMES.has(imported)) emitterNames.add(element.name.text)
        }
      }
    }
    // `const { spawn } = require('node:child_process')` 与 electron 的 utilityProcess 走对象名那条。
    ts.forEachChild(node, collectImports)
  }
  collectImports(source)

  const emitterSites = []
  let outlets = 0
  const record = (name, node) => {
    emitterSites.push({
      name,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    })
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee)) {
        if (OUTLET_HELPERS.has(callee.text)) outlets += 1
        if (emitterNames.has(callee.text)) record(callee.text, node)
      } else if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text
        if (OUTLET_HELPERS.has(method)) outlets += 1
        if (
          LISTENER_METHODS.has(method) &&
          node.arguments.length > 0 &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          node.arguments[0].text === 'error'
        ) {
          outlets += 1
        }
        const objectIsNamespace =
          ts.isIdentifier(callee.expression) &&
          (namespaceNames.has(callee.expression.text) || NAMESPACE_OBJECTS.has(callee.expression.text))
        if (objectIsNamespace && NAMESPACE_METHODS.has(method)) {
          record(`${callee.expression.text}.${method}`, node)
        }
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && emitterNames.has(node.expression.text)) {
      record(`new ${node.expression.text}`, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  return { emitterSites, outlets, violation: emitterSites.length > 0 && outlets === 0 }
}

export function isScannedFile(file) {
  if (!TYPESCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase())) return false
  const base = path.basename(file)
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return false
  return !file.includes('/__fixtures__/') && !file.includes('/fixtures/')
}

function scanTree(ref, roots, rootDirectory) {
  const files = treeFiles(ref, roots, rootDirectory).filter(isScannedFile)
  const blobs = readTreeBlobs(ref, files, rootDirectory)
  const entries = []
  for (const file of files) {
    const text = blobs.get(file)
    if (typeof text !== 'string') continue
    const result = analyzeSource(file, text)
    if (result.violation) entries.push({ rule: RULE, file, count: result.emitterSites.length })
  }
  entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return { entries, scanned: files.length, roots }
}

function entryKey(entry) {
  return `${entry.rule} ${entry.file}`
}

function compareToBaseline(actual, baseline) {
  const expected = new Map(baseline.map((entry) => [entryKey(entry), entry]))
  const added = []
  for (const entry of actual) {
    const previous = expected.get(entryKey(entry))
    if (!previous) added.push({ ...entry, baselineCount: 0 })
  }
  const seen = new Set(actual.map(entryKey))
  const stale = baseline.filter((entry) => !seen.has(entryKey(entry)))
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
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      throw new Error(`${at}: count must be a positive integer`)
    }
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
    'Usage: node scripts/checks/error-outlet-check.mjs --root <git-path> [--root <git-path> ...] [--ref <git-ref>] [--baseline <file>] [--write]',
    '',
    '  Flags files that create a long-lived error emitter (child process, server, socket) but never',
    "  subscribe to any 'error' event. An unhandled 'error' is thrown by Node and kills the host.",
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
    const actual = scanTree(options.ref, options.roots, rootDirectory)
    const baseline = readBaseline(options.baseline, rootDirectory)
    output.log(`${RULE}: baseline=${baseline.length} actual=${actual.entries.length}`)
    output.log(
      `scanned: code=${actual.scanned} roots=${actual.roots.join(',')} (denominator for the count above)`,
    )
    const { added, stale } = compareToBaseline(actual.entries, baseline)

    if (options.write) {
      if (added.length > 0) {
        for (const entry of added) {
          output.error(formatEntry('::error::NEW', entry, entry.count, entry.baselineCount))
        }
        output.error(
          "::error::--write refuses to record NEW debt; subscribe to 'error' (see onErrorEvents).",
        )
        return 1
      }
      writeFileSync(
        path.resolve(rootDirectory, options.baseline),
        `${JSON.stringify(actual.entries, null, 2)}\n`,
      )
      output.log(`baseline updated: ${options.baseline} (${actual.entries.length} entries)`)
      return 0
    }

    for (const entry of added) {
      output.error(formatEntry('::error::NEW', entry, entry.count, entry.baselineCount))
    }
    for (const entry of stale) output.error(formatEntry('::error::STALE', entry, 0, entry.count))
    if (added.length > 0) {
      output.error(
        "::error::a new file creates a child process, server, or socket without any 'error' subscription; " +
          'an unhandled error event is thrown by Node and takes the whole host down. Use onErrorEvents from @gugu/session-shared.',
      )
    }
    if (stale.length > 0) {
      output.error(
        '::error::baseline is stale after a reduction; run this command with --write and review the diff.',
      )
    }
    return added.length > 0 || stale.length > 0 ? 1 : 0
  } catch (error) {
    output.error(`error-outlet-check: ${error.message}`)
    return 2
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = run(process.argv.slice(2))
