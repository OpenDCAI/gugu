import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTreeBlobs, repoRoot, treeFiles } from './git-tree-blobs.mjs'

/**
 * @@@theme-color-check (深色巡检 10-27) — 两道主题债务门,与 ui-state-debt-check 同形:读 git ref、按 (规则, 文件)
 * 记数、与 checked-in 基线双向对账(多了 = NEW,少了没登记 = STALE),`--write` 只登记改进。
 *
 *   hard-coded-color  组件样式里写死的颜色:hex、rgb()/hsl()/oklch()/oklab() 字面量、color/background/fill/stroke/border
 *                     直接写 white/black、Tailwind 固定色阶(bg-white、text-black、*-gray-500 …)。写死的颜色不跟主题走,
 *                     深色下就是白底、黑图标、读不出的高亮。颜色从 tokens.css / 主题契约的变量拿。
 *   undefined-var     var(--x) 引用了一个哪里都没定义的变量。它要么永远走兜底值(等于写死),要么什么都没有;
 *                     --danger-fg / --text-danger 就是这样带着一个系统外的红活了很久。
 *
 * 扫 .css / .ts / .tsx(含 vanilla-extract 的 .css.ts),跳过测试与 stories,注释先去掉 —— issue 号 `#7333` 不算颜色:
 * 纯数字 hex 只在颜色语境(`:` `=` `(` `,` 空白或引号之后)里算。svg 图片不扫(品牌 logo 本来就多色)。
 */

const DEFAULT_ROOTS = ['apps/desktop/src', 'packages/session-ui/src', 'packages/session-chat-ui/src']
const DEFAULT_BASELINE = 'scripts/theme-color-baseline.json'
const EXTENSIONS = new Set(['.css', '.ts', '.tsx'])
const SKIPPED = /\.(?:test|spec|stories)\.[^/]+$|\/__tests__\/|\/tests\//

/**
 * 本来就该写死颜色的地方。每条都要写理由;❌ 为了让门变绿把一个组件文件加进来 —— 那是债,进基线。
 */
export const ALLOWED_FILES = [
  { re: /(?:^|\/)styles\/tokens\.css$/, why: '主题 token 的定义处:颜色值本来就写在这里' },
  { re: /\/theme\/__generated__\//, why: 'session-ui 由主题源生成的变量表' },
  { re: /\/theme\/themes\/[^/]+\.theme\.ts$/, why: 'session-ui 各主题的取值表' },
  { re: /session-chat-ui\/src\/styles\/theme\.css\.ts$/, why: 'session-chat-ui 主题契约的明暗取值' },
  { re: /\/highlight\/bundled-themes\.ts$/, why: '代码高亮配色(shiki 主题),按主题成对给出' },
  { re: /\/components\/agentAvatar\//, why: 'agent 头像的绘制引擎与服饰调色板:身份色,不随主题变' },
  { re: /\/BoringAgentAvatar\.tsx$/, why: '头像调色板:身份色' },
  { re: /\/notionistsBlend\.ts$/, why: '头像插画的混色' },
  { re: /\/sharePosterCanvas\.ts$/, why: '分享海报/二维码画在 canvas 上,导出的图必须固定黑白' },
  { re: /\/ChannelBrandIcon\.tsx$/, why: '微信 / 飞书 / 钉钉的品牌色' },
]

/** 运行时由组件库 / 第三方提供、源码里看不到定义的变量。 */
const RUNTIME_VARS = /^--(?:available-|anchor-|transform-origin$|accordion-panel-|collapsible-panel-|shiki-|pswp-|tw-|radix-)/

const COLOR_PATTERNS = [
  // 带字母的 hex(纯数字的另算,见下一条)。
  /(?<![\w&$-])#(?=[0-9a-fA-F]*[a-fA-F])(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g,
  // 纯数字 hex 只在颜色语境里算:`color: #000` 是颜色,注释外的 `#7333` 一般是 issue 号。
  /(?<=[:=(,\s'"`])#(?:\d{8}|\d{6}|\d{3})(?![\w-])/g,
  /\b(?:rgba?|hsla?|oklch|oklab)\(\s*[0-9.]/g,
  /\b(?:color|background(?:-color)?|fill|stroke|border(?:-color)?|outline-color|caret-color)['"]?\s*[:=]\s*['"]?(?:white|black)\b/gi,
  /(?<![\w-])(?:bg|text|border|ring|divide|outline|fill|stroke|shadow|from|via|to|decoration|placeholder|caret|accent)-(?:white|black|(?:gray|zinc|neutral|slate|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\/\d+)?(?![\w-])/g,
]

const RULES = ['hard-coded-color', 'undefined-var']

/** 去掉注释:块注释整段换成空格;行注释只在不像 URL(`://`)也不在引号紧后时去。 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

export function countColors(source) {
  let count = 0
  for (const pattern of COLOR_PATTERNS) count += source.match(pattern)?.length ?? 0
  return count
}

function definedVars(source) {
  const names = []
  for (const match of source.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) names.push(match[1])
  // TS 里的 style 对象 key、setProperty('--x')、createVar 之外手写的名字:都以字符串出现。
  for (const match of source.matchAll(/['"`](--[A-Za-z0-9_-]+)['"`]/g)) names.push(match[1])
  return names
}

function referencedVars(source) {
  return [...source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => match[1])
}

export function scanTree(ref, roots, rootDirectory = repoRoot()) {
  const wanted = treeFiles(ref, roots, rootDirectory).filter(
    (file) => EXTENSIONS.has(path.extname(file).toLowerCase()) && !SKIPPED.test(file),
  )
  const blobs = readTreeBlobs(ref, wanted, rootDirectory)
  const defined = new Set()
  const refs = []
  const entries = []
  let allowed = 0
  for (const file of wanted) {
    const source = stripComments(blobs.get(file))
    for (const name of definedVars(source)) defined.add(name)
    const colors = countColors(source)
    if (ALLOWED_FILES.some(({ re }) => re.test(file))) allowed += colors
    else if (colors > 0) entries.push({ rule: 'hard-coded-color', file, count: colors })
    for (const name of referencedVars(source)) refs.push({ name, file })
  }
  // `--em-X` 由 session-ui 按 `--X` 生成(app-runtime/ui/ui-entry.ts),定义了 `--X` 就算定义了它。
  const known = (name) => defined.has(name) || RUNTIME_VARS.test(name) || (name.startsWith('--em-') && defined.has(`--${name.slice(5)}`))
  const undefinedByFile = new Map()
  for (const { name, file } of refs) {
    if (known(name)) continue
    undefinedByFile.set(file, (undefinedByFile.get(file) ?? 0) + 1)
  }
  for (const [file, count] of undefinedByFile) entries.push({ rule: 'undefined-var', file, count })
  entries.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))
  const undefinedNames = [...new Set(refs.filter(({ name }) => !known(name)).map(({ name, file }) => `${name} (${file})`))].sort()
  return { entries, scanned: wanted.length, allowed, undefinedNames }
}

const entryKey = (entry) => `${entry.rule}\0${entry.file}`

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

function readBaseline(baselineFile, rootDirectory) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path.resolve(rootDirectory, baselineFile), 'utf8'))
  } catch (error) {
    throw new Error(`${baselineFile}: ${error.code === 'ENOENT' ? 'baseline not found' : `invalid JSON: ${error.message}`}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${baselineFile}: baseline must be a JSON array`)
  const seen = new Set()
  for (const [index, entry] of parsed.entries()) {
    const at = `${baselineFile}[${index}]`
    if (!entry || !RULES.includes(entry.rule)) throw new Error(`${at}: unknown rule ${JSON.stringify(entry?.rule)}`)
    if (typeof entry.file !== 'string' || !entry.file) throw new Error(`${at}: file must be a non-empty string`)
    if (!Number.isInteger(entry.count) || entry.count < 1) throw new Error(`${at}: count must be a positive integer`)
    if (seen.has(entryKey(entry))) throw new Error(`${at}: duplicate entry`)
    seen.add(entryKey(entry))
  }
  return parsed
}

function parseArgs(argv) {
  const options = { ref: 'HEAD', baseline: DEFAULT_BASELINE, roots: [], write: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help') return { help: true }
    if (flag === '--write') { options.write = true; continue }
    if (!['--ref', '--root', '--baseline'].includes(flag)) throw new Error(`unknown option: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (flag === '--root') options.roots.push(value)
    else options[flag.slice(2)] = value
    index += 1
  }
  if (options.roots.length === 0) options.roots = DEFAULT_ROOTS
  return options
}

const total = (entries, rule) => entries.filter((entry) => entry.rule === rule).reduce((sum, entry) => sum + entry.count, 0)

export function run(argv, output = console) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      output.log('Usage: node scripts/theme-color-check.mjs [--root <git-path>]… [--ref <git-ref>] [--baseline <file>] [--write]')
      return 0
    }
    const rootDirectory = repoRoot()
    const { entries, scanned, allowed, undefinedNames } = scanTree(options.ref, options.roots, rootDirectory)
    const baseline = readBaseline(options.baseline, rootDirectory)
    for (const rule of RULES) output.log(`${rule}: baseline=${total(baseline, rule)} actual=${total(entries, rule)}`)
    output.log(`scanned: ${scanned} files; allowlisted colors: ${allowed}`)
    const { added, stale } = compareToBaseline(entries, baseline)
    const line = (kind, entry, actual, expected) => `::error::${kind} ${entry.rule} ${entry.file}: baseline=${expected} actual=${actual}`
    for (const entry of added) output.error(line('NEW', entry, entry.count, entry.baselineCount))
    if (added.some((entry) => entry.rule === 'undefined-var')) {
      const files = new Set(added.filter((entry) => entry.rule === 'undefined-var').map((entry) => entry.file))
      for (const name of undefinedNames) if ([...files].some((file) => name.endsWith(`(${file})`))) output.error(`::error::  undefined: ${name}`)
    }
    if (options.write) {
      if (added.length > 0) {
        output.error('::error::--write refuses to record NEW debt — 用 token / 已定义的变量,不是改基线。')
        return 1
      }
      writeFileSync(path.resolve(rootDirectory, options.baseline), `${JSON.stringify(entries, null, 2)}\n`)
      output.log(`baseline updated: ${options.baseline} (${entries.length} entries)`)
      return 0
    }
    for (const entry of stale) output.error(line('STALE', entry, entry.actualCount, entry.count))
    if (added.length > 0) {
      output.error('::error::Theme debt increased — 颜色从 tokens.css / 主题契约的变量拿;var() 只引用定义过的变量。真该写死的(品牌色、二维码…)加进 ALLOWED_FILES 并写理由。')
    }
    if (stale.length > 0) {
      output.error('::error::Theme debt baseline is stale — 债务减少了但没登记:跑 `node scripts/theme-color-check.mjs --write` 把改进写进基线。')
    }
    return added.length > 0 || stale.length > 0 ? 1 : 0
  } catch (error) {
    output.error(`theme-color-check: ${error.message}`)
    return 2
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = run(process.argv.slice(2))
