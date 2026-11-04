import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTreeBlobs, repoRoot, treeFiles } from './git-tree-blobs.mts'

/**
 * @@@theme-color-check (深色巡检 10-27) — 两道主题债务门,与 ui-state-debt-check 同形:读 git ref、按 (规则, 文件)
 * 记数、与 checked-in 基线双向对账(多了 = NEW,少了没登记 = STALE),`--write` 只登记改进。
 *
 *   hard-coded-color  组件样式里写死的颜色:hex、rgb()/hsl()/oklch()/oklab() 字面量、color/background/fill/stroke/border
 *                     直接写 white/black、Tailwind 固定色阶(bg-white、text-black、*-gray-500 …)。写死的颜色不跟主题走,
 *                     深色下就是白底、黑图标、读不出的高亮。颜色从 tokens.css / 主题契约的变量拿。
 *
 * 另有两道**直接拦**的门(不进基线,一处都不许有):
 *   undefined-var     var(--x) 引用了一个哪里都没定义、又没写兜底值的变量 —— 那个属性在所有主题下都是空的
 *                     (--error 让二维码出错的字没有颜色,--r-md 让输入框是直角);或者兜底值写死一个颜色
 *                     (var(--danger-fg, red) 等于写死红,只是绕过了 hard-coded-color)。兜底是另一个 token / 数字 /
 *                     尺寸的 `var(--x, var(--y))` 是「调用方可以设」的插槽,放行。定义处:.css/.ts/.tsx/.mjs 里的 `--x:`、字符串 '--x'、session-ui 的
 *                     nsName('x')(= --em-x);模板里的前缀 `var(--usage-heat-${n})` 有任一 --usage-heat-* 定义就算。
 *   svg-single-color  单色的 svg 图标把颜色写死(fill="#a1a1aa"):不跟主题走。填 currentColor,由用它的地方给色;
 *                     <img> 里的 currentColor 不认外面的字色,要用遮罩画(见 open-in-menu 的 OpenInAppIcon)。
 *                     品牌色的单色标(Claude 橙)进 ALLOWED_SVGS 并写理由。多色的 svg(品牌 logo)不管。
 *
 * 扫 .css / .ts / .tsx(含 vanilla-extract 的 .css.ts),跳过测试与 stories,注释先去掉 —— issue 号 `#7333` 不算颜色:
 * 纯数字 hex 只在颜色语境(`:` `=` `(` `,` 空白或引号之后)里算。
 */

const DEFAULT_ROOTS = ['apps/desktop/src', 'packages/session-ui/src', 'packages/session-chat-ui/src']
const DEFAULT_BASELINE = 'scripts/checks/theme-color-baseline.json'
const EXTENSIONS = new Set(['.css', '.ts', '.tsx'])
// 测试、stories 与它们的脚手架(stories/ 目录、story-layout)、对拍用的假数据(mock-*.ts):不是产品样式。
const SKIPPED = /\.(?:test|spec|stories)\.[^/]+$|\/__tests__\/|\/tests\/|\/stories\/|\/story-layout\.css\.ts$|\/mock-[^/]+\.ts$/

/**
 * 本来就该写死颜色的地方。每条都要写理由;❌ 为了让门变绿把一个组件文件加进来 —— 那是债,进基线。
 */
export const ALLOWED_FILES = [
  { re: /(?:^|\/)styles\/tokens\.css$/, why: '主题 token 的定义处:颜色值本来就写在这里' },
  { re: /\/theme\/__generated__\//, why: 'session-ui 由主题源生成的变量表' },
  { re: /\/theme\/themes\/[^/]+\.theme\.ts$/, why: 'session-ui 各主题的取值表' },
  { re: /session-ui\/src\/theme\/core\/generate\//, why: 'session-ui 主题生成器:由主题源算出取值(色域换算、缺档补齐),产物就是上面的 __generated__' },
  { re: /\/loading-indicator\/LoadingIndicator\.css$/, why: '属性选择器 path[fill=\'rgb(…)\'] 匹配的是动画素材里的原始填色字符串,不是在用颜色;实际填色已接到 currentColor' },
  { re: /session-chat-ui\/src\/styles\/theme\.css\.ts$/, why: 'session-chat-ui 主题契约的明暗取值' },
  { re: /\/highlight\/bundled-themes\.ts$/, why: '代码高亮配色(shiki 主题),按主题成对给出' },
  { re: /\/components\/agentAvatar\//, why: 'agent 头像的绘制引擎与服饰调色板:身份色,不随主题变' },
  { re: /\/lib\/agentAvatarPalette\.ts$/, why: 'agent 默认头像(beam)的调色板:身份色,不随主题变' },
  { re: /\/notionistsBlend\.ts$/, why: '头像插画的混色' },
  { re: /\/sharePosterCanvas\.ts$/, why: '分享海报/二维码画在 canvas 上,导出的图必须固定黑白' },
  { re: /\/ChannelBrandIcon\.tsx$/, why: '微信 / 飞书 / 钉钉的品牌色' },
  { re: /\/lib\/vendor\/cua-cursor-motion\//, why: '@trycua/cursor-motion 原样拷贝(见其 README,改动会让升级失真);Cua 蓝是它的光标品牌色,画在 canvas 上、盖在被控页面的截图上,不跟宿主主题' },
]

/** 单色但颜色就是品牌本身的 svg。每条写理由。 */
export const ALLOWED_SVGS = [
  { re: /\/session\/assets\/images\/claude\.svg$/, why: 'Claude 的品牌橙(#d97757):厂商标识,深浅色都是这个色' },
  { re: /\/session\/assets\/images\/kimi\.svg$/, why: 'Kimi 的品牌蓝点(#1783ff);字形本身已是 currentColor' },
]

/** 运行时由组件库 / 第三方提供、源码里看不到定义的变量。--spacing 是 Tailwind v4 的间距单位。 */
const RUNTIME_VARS = /^--(?:available-|anchor-|transform-origin$|accordion-panel-|collapsible-panel-|shiki-|pswp-|tw-|radix-|spacing$)/
/** session-ui 的 token 命名空间(theme/core/contract/namespace.ts 的 TOKEN_NAMESPACE):nsName('x') = --em-x。 */
const TOKEN_NAMESPACE = 'em'
/** 只读定义、不查颜色的文件(运行时把变量写进 style 的调色表)。 */
const DEFINITION_ONLY = new Set(['.mjs'])

const COLOR_PATTERNS = [
  // 带字母的 hex(纯数字的另算,见下一条)。
  /(?<![\w&$-])#(?=[0-9a-fA-F]*[a-fA-F])(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g,
  // 纯数字 hex 只在颜色语境里算:`color: #000` 是颜色,注释外的 `#7333` 一般是 issue 号。
  /(?<=[:=(,\s'"`])#(?:\d{8}|\d{6}|\d{3})(?![\w-])/g,
  /\b(?:rgba?|hsla?|oklch|oklab)\(\s*[0-9.]/g,
  /\b(?:color|background(?:-color)?|fill|stroke|border(?:-color)?|outline-color|caret-color)['"]?\s*[:=]\s*['"]?(?:white|black)\b/gi,
  /(?<![\w-])(?:bg|text|border|ring|divide|outline|fill|stroke|shadow|from|via|to|decoration|placeholder|caret|accent)-(?:white|black|(?:gray|zinc|neutral|slate|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\/\d+)?(?![\w-])/g,
]

const RULES = ['hard-coded-color']

/** 去掉注释:块注释整段换成空格;行注释只在不像 URL(`://`)也不在引号紧后时去。 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

/** 同上,但块注释里的换行留着:报行号用。 */
function stripCommentsKeepLines(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
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
  for (const match of source.matchAll(/\bnsName\(\s*['"`]([A-Za-z0-9_-]+)['"`]\s*\)/g)) names.push(`--${TOKEN_NAMESPACE}-${match[1]}`)
  return names
}

/** 每处 var(--x …):名字、有没有兜底值、在第几行(按去注释前的行号:去注释时保留换行)。 */
function referencedVars(source) {
  return [...source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)(\$\{)?\s*(,)?/g)].map((match) => ({
    name: match[1],
    prefix: match[2] !== undefined,
    fallback: match[3] !== undefined ? fallbackText(source, match.index + match[0].length) : null,
    line: source.slice(0, match.index).split('\n').length,
  }))
}

/** var(--x, …) 里逗号之后到配对右括号为止的兜底值。 */
function fallbackText(source, start) {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      if (depth === 0) return source.slice(start, index).trim()
      depth -= 1
    }
  }
  return source.slice(start).trim()
}

/** 兜底值是一个写死的颜色(而不是另一个 token、数字或尺寸)。 */
const COLOR_LITERAL = /^(?:#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(|(?:white|black|red|green|blue|gray|grey|transparent)\b)/i

/** 单色 svg 写死的那一种颜色;多色 / 没写颜色 = null。 */
export function singleSvgColor(source) {
  const colors = new Set()
  for (const match of source.matchAll(/\b(?:fill|stroke|stop-color|color)\s*(?:=\s*["']|:\s*)(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|white|black)\b/gi)) {
    let color = match[1].toLowerCase()
    if (/^#[0-9a-f]{3}$/.test(color)) color = `#${[...color.slice(1)].map((c) => c + c).join('')}`
    colors.add(color === 'white' ? '#ffffff' : color === 'black' ? '#000000' : color)
  }
  return colors.size === 1 ? [...colors][0] : null
}

export function scanTree(ref, roots, rootDirectory = repoRoot()) {
  const all = treeFiles(ref, roots, rootDirectory).filter((file) => !SKIPPED.test(file))
  const wanted = all.filter((file) => EXTENSIONS.has(path.extname(file).toLowerCase()))
  const definitionOnly = all.filter((file) => DEFINITION_ONLY.has(path.extname(file).toLowerCase()))
  const svgs = all.filter((file) => path.extname(file).toLowerCase() === '.svg')
  const blobs = readTreeBlobs(ref, [...wanted, ...definitionOnly, ...svgs], rootDirectory)
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
    for (const ref of referencedVars(stripCommentsKeepLines(blobs.get(file)))) refs.push({ ...ref, file })
  }
  // `--em-X` 由 session-ui 按 `--X` 生成(app-runtime/ui/ui-entry.ts),定义了 `--X` 就算定义了它。
  for (const file of definitionOnly) for (const name of definedVars(stripComments(blobs.get(file)))) defined.add(name)
  const known = ({ name, prefix }) =>
    (prefix ? [...defined].some((d) => d.startsWith(name)) : defined.has(name)) ||
    RUNTIME_VARS.test(name) || (name.startsWith('--em-') && defined.has(`--${name.slice(5)}`))
  // 没定义:没写兜底 = 属性是空的;兜底写死一个颜色 = 等于把颜色写死、只是绕过了上面那道门。两种都拦。
  // 兜底是另一个 token / 数字 / 尺寸的,是调用方可以设的插槽,放行。
  const undefinedRefs = refs
    .filter((ref) => !known(ref) && (ref.fallback === null || COLOR_LITERAL.test(ref.fallback)))
    .map(({ name, file, line, fallback }) => `${file}:${line} ${name}${fallback === null ? '' : ` (兜底写死颜色:${fallback})`}`)
  const singleColorSvgs = svgs
    .filter((file) => !ALLOWED_SVGS.some(({ re }) => re.test(file)))
    .flatMap((file) => {
      const color = singleSvgColor(blobs.get(file))
      return color ? [`${file} ${color}`] : []
    })
  entries.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))
  return { entries, scanned: wanted.length, allowed, undefinedRefs, singleColorSvgs }
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
      output.log('Usage: node scripts/checks/theme-color-check.mjs [--root <git-path>]… [--ref <git-ref>] [--baseline <file>] [--write]')
      return 0
    }
    const rootDirectory = repoRoot()
    const { entries, scanned, allowed, undefinedRefs, singleColorSvgs } = scanTree(options.ref, options.roots, rootDirectory)
    const baseline = readBaseline(options.baseline, rootDirectory)
    for (const rule of RULES) output.log(`${rule}: baseline=${total(baseline, rule)} actual=${total(entries, rule)}`)
    output.log(`scanned: ${scanned} files; allowlisted colors: ${allowed}`)
    const { added, stale } = compareToBaseline(entries, baseline)
    const line = (kind, entry, actual, expected) => `::error::${kind} ${entry.rule} ${entry.file}: baseline=${expected} actual=${actual}`
    for (const entry of added) output.error(line('NEW', entry, entry.count, entry.baselineCount))
    // 直接拦的两道门:一处都不许有,也不进基线。
    for (const at of undefinedRefs) output.error(`::error::undefined-var ${at} — 没定义:换成定义过的 token;插槽写成 var(--x, 另一个 token),❌ 兜底写死颜色`)
    for (const at of singleColorSvgs) output.error(`::error::svg-single-color ${at} — 单色图标写死了颜色:填 currentColor;品牌色进 ALLOWED_SVGS 并写理由`)
    const hardFailures = undefinedRefs.length + singleColorSvgs.length
    output.log(`undefined-var: ${undefinedRefs.length}; svg-single-color: ${singleColorSvgs.length}`)
    if (options.write) {
      if (added.length > 0 || hardFailures > 0) {
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
      output.error('::error::Theme debt baseline is stale — 债务减少了但没登记:跑 `node scripts/checks/theme-color-check.mjs --write` 把改进写进基线。')
    }
    return added.length > 0 || stale.length > 0 || hardFailures > 0 ? 1 : 0
  } catch (error) {
    output.error(`theme-color-check: ${error.message}`)
    return 2
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = run(process.argv.slice(2))
