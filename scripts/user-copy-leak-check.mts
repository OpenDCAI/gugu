import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { readTreeBlobs, repoRoot, treeFiles } from './git-tree-blobs.mts'

/**
 * 泄漏有**两条路**,只闸一条等于把债引流到另一条:开发者撞红后顺手把 `{{error}}`
 * 从词条挪进调用点的 `description:` 就绿了。实测两条一样宽(词条 163 / 副标题槽 78),
 * 所以两条一起冻。
 */
export type UserCopyLeakRule = 'copy-leaks-internal-detail' | 'copy-leaks-raw-error-slot' | 'copy-leaks-raw-error-field'

export interface UserCopyLeakEntry {
  rule: UserCopyLeakRule
  file: string
  count: number
}

export interface UserCopyLeakCount {
  entries: UserCopyLeakEntry[]
  total: number
  scanned: number
  roots: string[]
}

/** 一个文件里三条规则各自的条数。 */
export interface UserCopyLeakSourceCount {
  catalog: number
  slot: number
  field: number
}

type ParsedSource = ts.SourceFile & { parseDiagnostics: ts.DiagnosticWithLocation[] }

const RULE_CATALOG: UserCopyLeakRule = 'copy-leaks-internal-detail'
const RULE_SLOT: UserCopyLeakRule = 'copy-leaks-raw-error-slot'
const RULE_FIELD: UserCopyLeakRule = 'copy-leaks-raw-error-field'
const KNOWN_RULES = new Set<string>([RULE_CATALOG, RULE_SLOT, RULE_FIELD])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const DEFAULT_BASELINE = 'scripts/user-copy-leak-baseline.json'

/**
 * 只收「除了内部失败描述以外装不了别的东西」的占位符名。
 *
 * ❌ 故意不收 message / output / status / code —— 实测它们也装用户该看的值
 * （`{{name}} is {{status}}` 是在线/运行中，`exit {code}` 是用户主动要看的退出码，
 * 而这是个聊天 app，`新消息：{{message}}` 完全正当）。一个会数假阳的闸会被训练成忽略。
 *
 * 两种插值方言都要认：i18next 用 `{{error}}`，translateSessionMessage 用 `{error}`。
 * 末尾 `[,}]` 是为了放过 i18next 的格式化后缀 `{{error, uppercase}}`。
 */
const LEAK_PLACEHOLDER =
  /\{\{?\s*(?:error|err|errorMessage|errMsg|reason|detail|details|cause|stderr)\s*[,}]/

/** toast 的副标题槽 —— 用户看得见的第二行。 */
const SLOT_NAMES = new Set(['description', 'detail', 'subtitle'])
/** 槽里塞的东西一提到这些名字，就是把内部失败描述端给用户了。 */
const RAW_ERROR_EXPRESSION = /\b(?:err|error|errors|reason|detail|details|message|msg|stderr|cause)\b/i
/** 提示出口。这里不认 `sonner` 的具名导入别名，认不出的那几处会漏数——基线只会偏小，不会误红。 */
const TOAST_CALLEES = new Set(['toast', 'showToast', 'notify', 'pushToast'])
/** Translated copy and the existing redacted failure formatters are not raw error text.
 * 纯粹的翻译调用不算泄漏：`description: t('x.errorHint')` 的文本会撞上 /error/，但它是本地化文案。 */
const TRANSLATE_CALLEES = /^(?:t|translate|translateRef\.current|translateSessionMessage|i18n\.t|messageForUser|safeFailureLine)$/

/**
 * 第三条路(#6264 d22 真机漏网):宿主把 `error.message` 装进一格「原因」字段,经 IPC / 设备 RPC 送到界面,
 * 界面 `{notice}` 原样画出来。前两条规则都看不见它 —— 词条里没有 `{{error}}`,也没有 toast;而界面那一侧
 * 画的只是个变量,跟正经文案长得一样。所以在**装进去**的那一刻认:目标名是一格给人看的原因
 * (`catalogError` / `guguReason` / `reason` / `platformNotice` …,或它的 setter `setCatalogError(…)`),
 * 值是异常原文(`e.message`、`String(err)`)。
 *
 * ❌ 故意不收裸 `error` / `message`:`{ ok: false, error: e.message }` 是遍地的 IPC 结果形状,多数只进日志;
 * 一个会数假阳的闸会被训练成忽略。加了「…Error / …Reason / …Notice」后缀的名字才是专门留给界面说原因的格子。
 */
const REASON_FIELD_NAME = /^(?:reason|notice|[a-z][A-Za-z0-9]*(?:Error|Reason|Notice))$/
const REASON_SETTER_NAME = /^set[A-Z][A-Za-z0-9]*(?:Error|Reason|Notice)$/
const ERROR_IDENTIFIER = /^(?:e|err|error|cause|reason|failure|exception)$/i

function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression?.(current))) {
    current = current.expression
  }
  return current
}

/** `e.message` / `(error as Error).message` / `String(err)` / `err?.message ?? …` —— 一个异常对象的原文。 */
function isRawErrorText(node: ts.Expression): boolean {
  const value = unwrap(node)
  if (!value) return false
  if (ts.isPropertyAccessExpression(value) && value.name.text === 'message') {
    const target = unwrap(value.expression)
    return Boolean(target && ts.isIdentifier(target) && ERROR_IDENTIFIER.test(target.text))
  }
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'String') {
    const argument = unwrap(value.arguments[0])
    return Boolean(argument && ts.isIdentifier(argument) && ERROR_IDENTIFIER.test(argument.text))
  }
  if (ts.isConditionalExpression(value)) return isRawErrorText(value.whenTrue) || isRawErrorText(value.whenFalse)
  if (ts.isBinaryExpression(value) && (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || value.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return isRawErrorText(value.left) || isRawErrorText(value.right)
  }
  return false
}

function targetName(node: ts.Node): string {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return ''
}

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

/** `log.warn({ reason: e.message }, '…')` —— 这格进的是日志,正是原文该去的地方。 */
function isLoggerField(node: ts.Node): boolean {
  const literal = node.parent
  const call = literal?.parent
  return Boolean(
    literal && ts.isObjectLiteralExpression(literal)
    && call && ts.isCallExpression(call) && call.arguments.includes(literal)
    && ts.isPropertyAccessExpression(call.expression) && LOG_METHODS.has(call.expression.name.text),
  )
}

/** 这一个节点是不是「把异常原文装进一格给人看的原因」。 */
function isRawErrorIntoReasonField(node: ts.Node): boolean {
  if (ts.isPropertyAssignment(node)) {
    return REASON_FIELD_NAME.test(slotName(node)) && isRawErrorText(node.initializer) && !isLoggerField(node)
  }
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
    return REASON_FIELD_NAME.test(node.name.text) && isRawErrorText(node.initializer)
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return REASON_FIELD_NAME.test(targetName(node.left)) && isRawErrorText(node.right)
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && REASON_SETTER_NAME.test(node.expression.text)) {
    return node.arguments.length > 0 && isRawErrorText(node.arguments[0])
  }
  return false
}

function normalizeRoots(rootArgs: string | string[], rootDirectory: string): string[] {
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

function scriptKindFor(file: string): ts.ScriptKind {
  return path.extname(file).toLowerCase() === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/** 词条表里，用户可见的那一面永远是属性的**值**;键名不是文案。 */
function isCatalogCopy(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return false
  const parent = node.parent
  return Boolean(parent && ts.isPropertyAssignment(parent) && parent.initializer === node)
}

function calleeText(node: ts.CallExpression): string {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.getText()
  return ''
}

function isToastCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const text = calleeText(node)
  return TOAST_CALLEES.has(text) || TOAST_CALLEES.has(text.split('.')[0])
}

function slotName(node: ts.Node): string {
  if (!ts.isPropertyAssignment(node)) return ''
  const name = node.name
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name)) return name.text
  return ''
}

/** 一条文案算一处，哪怕它拼了两个占位符 —— 清理的工作量单位是「改这句话」。 */
export function countSource(source: string, file: string): UserCopyLeakSourceCount {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file)) as ParsedSource
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0]
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    throw new Error(`${file}: TypeScript parse error at ${diagnostic.start ?? 0}: ${message}`)
  }
  let catalog = 0
  let field = 0
  const slots = new Set<ts.Node>()

  function collectSlots(node: ts.Node): void {
    const name = slotName(node)
    if (SLOT_NAMES.has(name)) {
      const initializer = (node as ts.PropertyAssignment).initializer
      const pureTranslation = ts.isCallExpression(initializer) && TRANSLATE_CALLEES.test(calleeText(initializer))
      if (!pureTranslation && RAW_ERROR_EXPRESSION.test(initializer.getText())) slots.add(node)
    }
    ts.forEachChild(node, collectSlots)
  }

  function visit(node: ts.Node): void {
    if (isCatalogCopy(node) && LEAK_PLACEHOLDER.test(node.text)) catalog += 1
    if (isRawErrorIntoReasonField(node)) field += 1
    // 嵌套的 toast 调用会被外层重复走一遍,用节点集合去重而不是累加计数。
    if (isToastCall(node)) for (const argument of node.arguments) collectSlots(argument)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { catalog, slot: slots.size, field }
}

/** Count committed copy, not the caller's dirty working tree. */
export function countTree(ref: string, rootArgs: string | string[], rootDirectory: string = repoRoot()): UserCopyLeakCount {
  const roots = normalizeRoots(rootArgs, rootDirectory)
  const entries: UserCopyLeakEntry[] = []
  let total = 0
  let scanned = 0
  const wanted = treeFiles(ref, roots, rootDirectory).filter(
    (file) =>
      SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()) &&
      !file.endsWith('.test.ts') &&
      !file.endsWith('.test.tsx'),
  )
  const blobs = readTreeBlobs(ref, wanted, rootDirectory)
  for (const file of wanted) {
    scanned += 1
    const counts = countSource(blobs.get(file)!, file)
    total += counts.catalog + counts.slot + counts.field
    if (counts.catalog > 0) entries.push({ rule: RULE_CATALOG, file, count: counts.catalog })
    if (counts.slot > 0) entries.push({ rule: RULE_SLOT, file, count: counts.slot })
    if (counts.field > 0) entries.push({ rule: RULE_FIELD, file, count: counts.field })
  }
  entries.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))
  return { entries, total, scanned, roots }
}

const entryKey = (entry: { rule: string; file: string }): string => `${entry.rule}\0${entry.file}`

/** NEW catches growth; STALE forces every reduction to be registered in the generated baseline. */
export function compareToBaseline(
  actualEntries: UserCopyLeakEntry[],
  baselineEntries: UserCopyLeakEntry[],
): {
  added: Array<UserCopyLeakEntry & { baselineCount: number }>
  stale: Array<UserCopyLeakEntry & { actualCount: number }>
} {
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

function validateBaseline(parsed: unknown, baselineFile: string): UserCopyLeakEntry[] {
  if (!Array.isArray(parsed)) throw new Error(`${baselineFile}: baseline must be a JSON array`)
  const seen = new Set<string>()
  return parsed.map((entry, index): UserCopyLeakEntry => {
    const at = `${baselineFile}[${index}]`
    if (!entry || typeof entry !== 'object') throw new Error(`${at}: entry must be an object`)
    if (!KNOWN_RULES.has(entry.rule)) throw new Error(`${at}: unknown rule ${JSON.stringify(entry.rule)}`)
    if (typeof entry.file !== 'string' || entry.file.length === 0) throw new Error(`${at}: missing file`)
    if (!Number.isInteger(entry.count) || entry.count <= 0) throw new Error(`${at}: count must be a positive integer`)
    const key = entryKey(entry)
    if (seen.has(key)) throw new Error(`${at}: duplicate entry for ${entry.rule} ${entry.file}`)
    seen.add(key)
    return { rule: entry.rule, file: entry.file, count: entry.count }
  })
}

function readBaseline(baselineFile: string, rootDirectory: string): UserCopyLeakEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path.resolve(rootDirectory, baselineFile), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`baseline not found: ${baselineFile}`)
    throw new Error(`${baselineFile}: invalid JSON: ${(error as Error).message}`)
  }
  return validateBaseline(parsed, baselineFile)
}

interface CliOptions {
  help?: false
  ref: string
  baseline: string
  roots: string[]
  write: boolean
}

function parseArgs(argv: string[]): CliOptions | { help: true } {
  const options: CliOptions = { ref: 'HEAD', baseline: DEFAULT_BASELINE, roots: [], write: false }
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
    else options[flag.slice(2) as 'ref' | 'baseline'] = value
    index += 1
  }
  if (options.roots.length === 0) throw new Error('missing required --root')
  return options
}

function usage() {
  return [
    'Usage: node scripts/user-copy-leak-check.mts --root <git-path> [--root <git-path> ...] [--ref <git-ref>] [--baseline <file>] [--write]',
    '',
    '',
    '  三条规则,按 (rule,file) 对账:',
    `    ${RULE_CATALOG}  文案里直接拼内部失败描述:'Could not join: {{error}}'`,
    `    ${RULE_SLOT}   toast 副标题槽直接塞异常:toast({ description: String(err) })`,
    `    ${RULE_FIELD}  异常原文装进一格给人看的原因:catalogError = (error as Error).message`,
    '  --write records reductions only; it refuses NEW debt.',
  ].join('\n')
}

function formatEntry(prefix: string, entry: UserCopyLeakEntry, actual: number, expected: number): string {
  return `${prefix} ${entry.rule} ${entry.file}: baseline=${expected} actual=${actual}`
}

export function run(argv: string[], output: Pick<Console, 'log' | 'error'> = console): number {
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
    const perRule = (rule: UserCopyLeakRule, list: UserCopyLeakEntry[]) => list.filter((entry) => entry.rule === rule).reduce((sum, e) => sum + e.count, 0)
    output.log(`user-copy-leak: baseline=${baselineTotal} actual=${actual.total}`)
    output.log(
      `  ${RULE_CATALOG}: baseline=${perRule(RULE_CATALOG, baseline)} actual=${perRule(RULE_CATALOG, actual.entries)}`,
    )
    output.log(`  ${RULE_SLOT}: baseline=${perRule(RULE_SLOT, baseline)} actual=${perRule(RULE_SLOT, actual.entries)}`)
    output.log(`  ${RULE_FIELD}: baseline=${perRule(RULE_FIELD, baseline)} actual=${perRule(RULE_FIELD, actual.entries)}`)
    output.log(`scanned: sources=${actual.scanned} roots=${actual.roots.join(',')} (denominator for the counts above)`)
    const { added, stale } = compareToBaseline(actual.entries, baseline)

    if (options.write) {
      if (added.length > 0) {
        for (const entry of added) output.error(formatEntry('::error::NEW', entry, entry.count, entry.baselineCount))
        output.error(
          '::error::--write refuses to record NEW copy leaks; 把原因写进日志,给用户一句他能照做的话。',
        )
        return 1
      }
      writeFileSync(path.resolve(rootDirectory, options.baseline), `${JSON.stringify(actual.entries, null, 2)}\n`)
      output.log(`baseline updated: ${options.baseline} (${actual.entries.length} entries)`)
      return 0
    }

    for (const entry of added) output.error(formatEntry('::error::NEW', entry, entry.count, entry.baselineCount))
    for (const entry of stale) output.error(formatEntry('::error::STALE', entry, entry.actualCount, entry.count))
    if (added.length > 0) {
      output.error(
        '::error::用户可见文案又多了一条直接拼内部失败描述的。原因进日志(rendererLogger/createLogger),文案只留用户能照做的下一步。',
      )
    }
    if (stale.length > 0) {
      output.error(
        '::error::copy-leak baseline is stale after a reduction; run this command with --write and review the generated diff.',
      )
    }
    return added.length > 0 || stale.length > 0 ? 1 : 0
  } catch (error) {
    output.error(`user-copy-leak-check: ${(error as Error).message}`)
    return 2
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = run(process.argv.slice(2))
