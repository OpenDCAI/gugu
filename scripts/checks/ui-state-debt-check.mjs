import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import postcss from 'postcss'
import { readTreeBlobs, repoRoot, treeFiles } from './git-tree-blobs.mts'

const COUNTER_LABELS = [
  ['imperative-style-hover', 'styleWrites'],
  ['inline-magic-transition', 'objectTransitionDurations'],
  ['css-magic-transition', 'cssTransitionDurations'],
  ['tailwind-magic-duration', 'tailwindDurations'],
  ['tailwind-magic-animation', 'tailwindAnimations']
]

const TYPESCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])
const CSS_EXTENSIONS = new Set(['.css'])
const NUMERIC_DURATION = /(?:^|[\s,(])(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)(?=$|[\s,)])/i
const TAILWIND_DURATION = /(?:^|[^A-Za-z0-9_-])duration-\[(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)?\]/g
// @@@4323 `animate-[名字_300ms_cubic-bezier(...)]` 把时长与缓动藏进 Tailwind 的任意值简写里。
// 上面那条 duration-[…] 的扫描看不见它 —— 于是「没有告警」曾经并不等于「没有散写」:
// Sheet 的 180/200/300ms 三条抽屉动画就是这样在基线全绿的情况下待着的。
const TAILWIND_ANIMATION = /(?:^|[^A-Za-z0-9_-])animate-\[[^\]]*\]/g
const ANIMATION_MAGIC = /(?:^|[_\s(,])(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)(?=$|[_\s),\]])|cubic-bezier\(/i
// 无限循环的环境动画(spinner、呼吸点、脉冲环)不在这条计数里:它们不是状态之间的**转场**,
// 而是一段节律,周期是 0.9s~2s 这一档,与 --dur-* 的 120/180/260ms 不同量纲,套上去就是频闪。
// 这不是把某几个文件摘出扫描面 —— 判据只看被扫的那个值自己是不是 `infinite`:
// 同一个文件里写一条 `animate-[x_200ms_ease]` 照样会红。
const ANIMATION_LOOP = /(?:^|[_\s(,])infinite(?=$|[_\s),\]])/i

function emptyCounts() {
  return {
    styleWrites: 0,
    objectTransitionDurations: 0,
    cssTransitionDurations: 0,
    tailwindDurations: 0,
    tailwindAnimations: 0
  }
}

function normalizeRoot(rootArg, rootDirectory) {
  if (!rootArg) throw new Error('missing required --root path')
  const absolute = path.resolve(rootDirectory, rootArg)
  const relative = path.relative(rootDirectory, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`--root must be inside the repository: ${rootArg}`)
  }
  return relative.split(path.sep).join('/')
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

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) {
    const argument = unwrap(node.argumentExpression)
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      return argument.text
    }
  }
  return undefined
}

function isCurrentTarget(node) {
  const current = unwrap(node)
  return Boolean(
    current &&
      ((ts.isIdentifier(current) && current.text === 'currentTarget') || memberName(current) === 'currentTarget')
  )
}

function isStyleWriteTarget(node) {
  let current = unwrap(node)
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) {
    if (memberName(current) === 'style') return isCurrentTarget(current.expression)
    current = unwrap(current.expression)
  }
  return false
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  return undefined
}

function staticTemplateParts(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (!ts.isTemplateExpression(node)) return []
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
}

function hasNumericDuration(value) {
  return NUMERIC_DURATION.test(value)
}

function countTailwindDurations(value) {
  return [...value.matchAll(TAILWIND_DURATION)].length
}

function countTailwindAnimations(value) {
  return [...value.matchAll(TAILWIND_ANIMATION)].filter(
    (match) => ANIMATION_MAGIC.test(match[0]) && !ANIMATION_LOOP.test(match[0]),
  ).length
}

function scriptKindFor(file) {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.tsx' || extension === '.jsx') return ts.ScriptKind.TSX
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function parseTypeScript(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file))
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0]
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    throw new Error(`${file}: TypeScript parse error at ${diagnostic.start ?? 0}: ${message}`)
  }

  const counts = emptyCounts()
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      ts.isAssignmentOperator(node.operatorToken.kind) &&
      isStyleWriteTarget(node.left)
    ) {
      counts.styleWrites += 1
    }

    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'transition') {
      for (const part of staticTemplateParts(node.initializer)) {
        if (hasNumericDuration(part)) counts.objectTransitionDurations += 1
      }
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      counts.tailwindDurations += countTailwindDurations(node.text)
      counts.tailwindAnimations += countTailwindAnimations(node.text)
    } else if (ts.isTemplateExpression(node)) {
      for (const part of staticTemplateParts(node)) {
        counts.tailwindDurations += countTailwindDurations(part)
        counts.tailwindAnimations += countTailwindAnimations(part)
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return counts
}

function parseCss(source, file) {
  let stylesheet
  try {
    stylesheet = postcss.parse(source, { from: file })
  } catch (error) {
    throw new Error(`${file}: CSS parse error: ${error.message}`)
  }

  let cssTransitionDurations = 0
  stylesheet.walkDecls((declaration) => {
    if (declaration.prop.toLowerCase() === 'transition' && hasNumericDuration(declaration.value)) {
      cssTransitionDurations += 1
    }
  })
  return cssTransitionDurations
}

/**
 * @@@keyed-scan (#3079) - 逐文件计数,不是四个总数。
 *
 * 只报总数的基线看不见**等量对换**:改好 3 处、别处又新长 3 处,总数 17→17 恒绿。
 * 按 (counter, file) 记条目后,前者报 STALE、后者报 NEW,两条同时亮。
 * 这与仓里另一道债务门同形(#2987 的裸 button baseline)。
 *
 * `scanned` 是**分母**:只报分子的判据分不清「0 是真干净」还是「根本没扫到」——
 * 实测 `css-magic-transition: 0` 就是后者(apps/desktop/src 下 CSS 只有 8 个文件)。
 */
export function countTree(ref, rootArg, rootDirectory = repoRoot()) {
  const root = normalizeRoot(rootArg, rootDirectory)
  const counts = emptyCounts()
  const entries = []
  const scanned = { code: 0, css: 0 }
  const wanted = treeFiles(ref, root, rootDirectory).filter((file) => {
    const extension = path.extname(file).toLowerCase()
    return TYPESCRIPT_EXTENSIONS.has(extension) || CSS_EXTENSIONS.has(extension)
  })
  const blobs = readTreeBlobs(ref, wanted, rootDirectory)
  for (const file of wanted) {
    const extension = path.extname(file).toLowerCase()
    const source = blobs.get(file)
    const perFile = emptyCounts()
    if (TYPESCRIPT_EXTENSIONS.has(extension)) {
      scanned.code += 1
      const parsed = parseTypeScript(source, file)
      perFile.styleWrites = parsed.styleWrites
      perFile.objectTransitionDurations = parsed.objectTransitionDurations
      perFile.tailwindDurations = parsed.tailwindDurations
      perFile.tailwindAnimations = parsed.tailwindAnimations
    } else {
      scanned.css += 1
      perFile.cssTransitionDurations = parseCss(source, file)
    }
    for (const [label, key] of COUNTER_LABELS) {
      counts[key] += perFile[key]
      // 只记非零项 —— 归零的文件直接从基线里消失,债清干净时基线收敛成 []。
      if (perFile[key] > 0) entries.push({ counter: label, file, count: perFile[key] })
    }
  }
  entries.sort((a, b) => a.counter.localeCompare(b.counter) || a.file.localeCompare(b.file))
  return { counts, entries, scanned }
}

const entryKey = (entry) => `${entry.counter}\0${entry.file}`

/** 双向对账:actual 多出来的是 NEW(必须修),baseline 里已消失/变少的是 STALE(必须登记)。 */
export function compareToBaseline(actualEntries, baselineEntries) {
  const actualByKey = new Map(actualEntries.map((entry) => [entryKey(entry), entry]))
  const baselineByKey = new Map(baselineEntries.map((entry) => [entryKey(entry), entry]))
  const added = []
  const stale = []
  for (const [key, entry] of actualByKey) {
    const expected = baselineByKey.get(key)
    if (!expected || entry.count > expected.count) {
      added.push({ ...entry, baselineCount: expected?.count ?? 0 })
    }
  }
  for (const [key, entry] of baselineByKey) {
    const observed = actualByKey.get(key)
    if (!observed || observed.count < entry.count) {
      stale.push({ ...entry, actualCount: observed?.count ?? 0 })
    }
  }
  return { added, stale }
}

function validateBaseline(parsed, baselineFile) {
  if (!Array.isArray(parsed)) throw new Error(`${baselineFile}: baseline must be a JSON array`)
  const labels = new Set(COUNTER_LABELS.map(([label]) => label))
  const seen = new Set()
  return parsed.map((entry, index) => {
    const at = `${baselineFile}[${index}]`
    if (!entry || typeof entry !== 'object') throw new Error(`${at}: entry must be an object`)
    if (!labels.has(entry.counter)) throw new Error(`${at}: unknown counter ${JSON.stringify(entry.counter)}`)
    if (typeof entry.file !== 'string' || entry.file.length === 0) throw new Error(`${at}: missing file`)
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      throw new Error(`${at}: count must be a positive integer (归零的条目应当从基线中删除)`)
    }
    const key = entryKey(entry)
    if (seen.has(key)) throw new Error(`${at}: duplicate entry for ${entry.counter} ${entry.file}`)
    seen.add(key)
    return { counter: entry.counter, file: entry.file, count: entry.count }
  })
}

function readBaseline(baselineFile, rootDirectory) {
  const absolute = path.resolve(rootDirectory, baselineFile)
  let raw
  try {
    raw = readFileSync(absolute, 'utf8')
  } catch {
    throw new Error(`baseline not found: ${baselineFile}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${baselineFile}: invalid JSON: ${error.message}`)
  }
  return validateBaseline(parsed, baselineFile)
}

const DEFAULT_BASELINE = 'scripts/checks/ui-state-debt-baseline.json'

function parseArgs(argv) {
  const options = { ref: 'HEAD', baseline: DEFAULT_BASELINE, write: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help') return { help: true }
    if (flag === '--write') {
      options.write = true
      continue
    }
    if (!['--ref', '--root', '--baseline'].includes(flag)) throw new Error(`unknown option: ${flag}`)
    const name = flag.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (options[`${name}Seen`]) throw new Error(`${flag} provided more than once`)
    options[`${name}Seen`] = true
    options[name] = value
    index += 1
  }
  if (!options.root) throw new Error('missing required --root')
  return options
}

function usage() {
  return [
    'Usage: node scripts/checks/ui-state-debt-check.mjs --root <git-path> [--ref <git-ref>] [--baseline <file>] [--write]',
    '',
    '  逐文件统计 UI-state 债务并与 checked-in 基线双向对账。',
    '  --write 只用来登记**改进**:它拒绝写入新增债务,新增必须改代码而不是改基线。'
  ].join('\n')
}

function formatEntry(prefix, entry, actual, expected) {
  return `${prefix} ${entry.counter} ${entry.file}: baseline=${expected} actual=${actual}`
}

export function run(argv, output = console) {
  let options
  try {
    options = parseArgs(argv)
    if (options.help) {
      output.log(usage())
      return 0
    }
    const rootDirectory = repoRoot()
    const { counts, entries, scanned } = countTree(options.ref, options.root, rootDirectory)
    const baseline = readBaseline(options.baseline, rootDirectory)
    const baselineTotals = emptyCounts()
    for (const entry of baseline) {
      const pair = COUNTER_LABELS.find(([label]) => label === entry.counter)
      if (pair) baselineTotals[pair[1]] += entry.count
    }

    // 分子:四个计数全部报,不挑。分母:扫描面规模 —— 计数下降但扫描面缩小,是删文件不是改好。
    for (const [label, key] of COUNTER_LABELS) {
      output.log(`${label}: baseline=${baselineTotals[key]} actual=${counts[key]}`)
    }
    output.log(`scanned: code=${scanned.code} css=${scanned.css} (denominator for the counts above)`)

    const { added, stale } = compareToBaseline(entries, baseline)

    if (options.write) {
      // @@@no-new-debt (#2987 同款约束) - 基线只能记改进,不能用来接受新债。
      // 少了这条,`--write` 就是这道门的万能钥匙:新增债务只要重跑一次就"合法"了。
      if (added.length > 0) {
        for (const entry of added) {
          output.error(formatEntry('::error::NEW', entry, entry.count, entry.baselineCount))
        }
        output.error(
          '::error::--write refuses to record NEW debt — 修代码,不是改基线。' +
            '基线只能因为债务减少而变化。'
        )
        return 1
      }
      writeFileSync(path.resolve(rootDirectory, options.baseline), `${JSON.stringify(entries, null, 2)}\n`)
      output.log(`baseline updated: ${options.baseline} (${entries.length} entries)`)
      return 0
    }

    for (const entry of added) {
      output.error(formatEntry('::error::NEW', entry, entry.count, entry.baselineCount))
    }
    for (const entry of stale) {
      output.error(formatEntry('::error::STALE', entry, entry.actualCount, entry.count))
    }
    if (added.length > 0) {
      output.error(
        '::error::UI-state debt increased — keep interaction state styling in tokens and reusable ' +
          'primitives (design-system rule).'
      )
    }
    if (stale.length > 0) {
      output.error(
        '::error::UI-state debt baseline is stale — 债务减少了但没登记。' +
          '跑 `node scripts/checks/ui-state-debt-check.mjs --root ' +
          `${options.root} --write` +
          '` 把改进写进基线,让它出现在 diff 里可被评审。'
      )
    }
    return added.length > 0 || stale.length > 0 ? 1 : 0
  } catch (error) {
    output.error(`ui-state-debt-check: ${error.message}`)
    return 2
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = run(process.argv.slice(2))
