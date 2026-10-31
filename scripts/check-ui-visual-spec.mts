#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(repoRoot, 'scripts/ui-visual-spec-baseline.json')
const SOURCE_EXTENSIONS = new Set(['.css', '.js', '.jsx', '.ts', '.tsx'])

// This is the source-text metric adjudicated in #3334. Expanding the utility family would
// redefine the 353/96 baselines, so a broader metric must be introduced as a separate rule.
const HALF_STEP_SPACING_PATTERN =
  /(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_-]+:)*-?(?:p[txy]?|m[txy]?|gap|space-[xy])-[0-9]+\.5(?![A-Za-z0-9_.-])/g

// @@@ui-ruler 主 renderer 几何债务棘轮(2026-09-03 UI 架构统一)。四个计数都是「同一角色各自拍数」的源码痕迹:
//   inlineFontSizeLiterals  inline `fontSize: 12` / Tailwind `text-[12px]` —— 字阶外/绕过 token 的字号
//   inlineRadiusLiterals    inline `borderRadius: 7` / `rounded-[9px]` —— 圆角字面量
//   rawButtons              `<button` —— 未走 ui/Button / ui/IconButton 的手写按钮
//   inlineStyleBlocks       `style={{` —— inline 几何的总量
// 与上面的半步计数同一条纪律:双向棘轮,只减不增;降了必须同步降 baseline。
// ❌ 别把某个文件摘出扫描面来「过关」——摘出去之后改回违规写法不会有任何东西变红。
type GeometryDebtKey = 'inlineFontSizeLiterals' | 'inlineRadiusLiterals' | 'rawButtons' | 'inlineStyleBlocks'
export type GeometryDebtCounts = Record<GeometryDebtKey, number>

export interface MobileShellReference {
  file: string
  line: number
  column: number
  token: string
}

export interface BannedTypeHit {
  file: string
  line: number
  column: number
  id: string
  token: string
}

interface RadiusEntry {
  raw: string
  px: string
}

interface RadiusScaleSource {
  file: string
  pattern: RegExp
  section?: RegExp
  keyOf: (match: RegExpMatchArray) => string
  valueOf: (match: RegExpMatchArray) => string
}

type Output = { log: (message: string) => void; error: (message: string) => void }

const GEOMETRY_DEBT_PATTERNS: Record<GeometryDebtKey, RegExp> = {
  inlineFontSizeLiterals: /(?:\bfontSize:\s*['"]?\d|(?<![A-Za-z0-9_-])text-\[\d+(?:\.\d+)?px\])/g,
  inlineRadiusLiterals: /(?:\bborderRadius:\s*['"]?\d|(?<![A-Za-z0-9_-])rounded(?:-[trbl]{1,2})?-\[\d+(?:\.\d+)?px\])/g,
  rawButtons: /<button\b/g,
  inlineStyleBlocks: /style=\{\{/g,
}
const GEOMETRY_DEBT_KEYS = Object.keys(GEOMETRY_DEBT_PATTERNS) as GeometryDebtKey[]

// @@@type-ladder-7333 咕咕字阶(用户 2026-10-17 批准视觉规范,#7333):12/18 · 14/20 · 16/24 · 20/28 · 24/32。
// 旧字阶 11/13/15/17 的写死字号是**债**:按范围记账、只减不增(offLadderFontSizeLiterals,见 baseline)。
// 硬闸只剩两条一处都不许有的:
//   · 半个像素的字号(12.5 / 13.5 …):屏幕会把它四舍五入,同一界面在不同缩放/屏幕下会飘,也不在任何字阶上。
//     ⚠️ 必须吃得下三元:实测漏网过 `fontSize: mobile ? 14 : 12.5` 这种写法,`[^,;}\n]*` 在逗号处停住。
//   · `--font-subtitle`:那个 token 已删,留着引用只会静默继承出一个谁也没定过的字号。
const BANNED_TYPE_PATTERNS = [
  { id: 'font-subtitle-token', re: /--font-subtitle/g },
  { id: 'half-pixel-font-size', re: /(?:\bfontSize:[^,;}\n]*?\d+\.5(?![0-9])|(?<![A-Za-z0-9_-])text-\[\d+\.5px\]|font-size:\s*\d+\.5px)/g },
]

// 旧字阶(11/13/15/17)写死在组件里的字号。数字两侧都挡住数字与小数点(130 / 113 / 13.5 不算);
// 三元一样吃得下。
const OFF_LADDER_FONT_SIZE_LITERAL =
  /(?:\bfontSize:[^,;}\n]*?(?<![0-9.])1[1357](?![0-9.])|(?<![A-Za-z0-9_-])text-\[1[1357]px\]|font-size:\s*1[1357]px(?![0-9.]))/g

// @@@type-custom-prop (Refs #6104) — 上面那组正则只看得见**组件里写死的字号**,看不见**自定义属性声明**本身:
// token 才是字号的出处,闸开在消费点、不开在出处,等于只挡得住抄得笨的那一半。
// ⇒ 任何 `--font-*` / `--text-*` 声明成旧字阶的值或半像素,一处都判红。
// 唯一的例外按**名字**:`--text-code`(13)是等宽那一面自己的档(「你会敲进去的东西」),不是正文字阶的一级。
// ❌ 别改成「按文件豁免 tokens.css」:那是全仓最该被盯住的一个文件。
const OFF_LADDER_CUSTOM_PROPERTY = /--(?!text-code:)(?:font|text)[A-Za-z0-9-]*:\s*(?:1[1357]|\d+\.5)px(?![0-9.])/g

function bannedTypeHits(files: string[]): BannedTypeHit[] {
  const hits: BannedTypeHit[] = []
  for (const file of files) {
    const ext = path.extname(file)
    if (!GEOMETRY_DEBT_EXTENSIONS.has(ext) && ext !== '.css') continue
    const source = readFileSync(file, 'utf8')
    for (const { id, re } of BANNED_TYPE_PATTERNS) {
      for (const match of source.matchAll(re)) {
        const { line, column } = lineAndColumn(source, match.index!)
        hits.push({ file: relative(file), line, column, id, token: match[0] })
      }
    }
    for (const match of source.matchAll(OFF_LADDER_CUSTOM_PROPERTY)) {
      const { line, column } = lineAndColumn(source, match.index!)
      hits.push({ file: relative(file), line, column, id: 'custom-property-off-ladder', token: match[0] })
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
}
const GEOMETRY_DEBT_EXTENSIONS = new Set(['.tsx', '.ts'])

// @@@one-loading-state (Refs #6264) — product spec:全产品表达「在等」只有一个样子,
// 即 lib/loading/LoadingIndicator(同一份 Lottie 素材;行内那些地方用它的 `size="inline"` 档)。
// owner 2026-09-24:「这个加载中应该是我们的加载中,而不是一个 icon 手动旋转」。
// 手转图标的源码痕迹就是 Tailwind 的 `animate-spin` —— 按**文件**记账、只减不增:
//   · 新文件出现一处 / 旧文件多一处 ⇒ 红(换成 LoadingIndicator,❌ 别往基线里加);
//   · 某文件少了 ⇒ 也红(STALE),把基线同步降下来,免得腾出的名额被下一个人悄悄用掉。
// 按文件而不是按总数:总数棘轮挡不住「这边删一处、那边新画一处」的对换。
// 确定性进度(安装字节、步骤计数)不归它管 —— 那是真进度,不是「在等」的图形。
const HAND_ROTATED_SPINNER_PATTERN = /(?<![A-Za-z0-9_-])animate-spin(?![A-Za-z0-9_-])/g

function handRotatedSpinners(files: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const file of files) {
    const n = [...readFileSync(file, 'utf8').matchAll(HAND_ROTATED_SPINNER_PATTERN)].length
    if (n > 0) counts[relative(file)] = n
  }
  return counts
}

// @@@shape-table (Refs #6104) — 圆角刻度的三表对拍。
// 主 app 的 Tailwind 表(tailwind.config.cjs)与会话页那张(session/renderer/index.css 的 @theme)
// 进的是**同一个 document**(#2802 拆掉 shadow root 之后),同名 utility 后注入者全文档赢。
// 从前 `rounded-full` 在一边是 50%、在另一边是 v4 默认的 calc(infinity*1px) —— 打开一次会话页,
// 全 app 的 rounded-full 就从椭圆翻成胶囊,而两边源码各看各的都"没错"。
// ⇒ 这条判据读三处源文本、逐档比对;任何一处单独改动都会红。
// ❌ 别把它改成"只看 tailwind.config":那样会话页那张表改回默认不会有任何东西变红。
const RADIUS_SCALE_SOURCES: Record<string, RadiusScaleSource> = {
  'tokens.css': {
    file: 'apps/desktop/src/styles/tokens.css',
    // 语义名 → 期望值,取自 design.md 的 shape 表。
    pattern: /^\s*--radius-(page|xs|document|sm|control|surface|xl|dialog|bubble|thread|capsule|circle):\s*([^;]+);/gm,
    keyOf: (m) => m[1],
    valueOf: (m) => m[2].trim(),
  },
  'tailwind.config.cjs': {
    file: 'tailwind.config.cjs',
    pattern: /^\s*'?(sm|md|lg|surface|xl|2xl|3xl|4xl|full)'?:\s*'([^']+)',\s*$/gm,
    section: /borderRadius:\s*\{([\s\S]*?)\n\s*\},/,
    keyOf: (m) => m[1],
    valueOf: (m) => m[2].trim(),
  },
  'session/renderer/index.css': {
    file: 'apps/desktop/src/session/renderer/index.css',
    pattern: /^\s*--radius-(sm|md|lg|surface|xl|2xl|3xl|4xl|full):\s*([^;]+?)\s*;/gm,
    keyOf: (m) => m[1],
    valueOf: (m) => m[2].trim(),
  },
}

// #7333 视觉规范的圆角表(用户 2026-10-17 裁决):page 0 / xs 4 / document,sm 6 / control 8 /
// surface 12(菜单、分组卡) / xl 12 / dialog 16(较大 Sheet/Dialog 外壳) / bubble 20(IM 气泡) /
// thread 24(composer) / capsule 9999,+ 真正圆的那一个单独的名字。
const RADIUS_SEMANTIC_EXPECTED: Record<string, string> = {
  page: '0',
  xs: '4px',
  document: '6px',
  sm: '6px',
  control: '8px',
  surface: '12px',
  xl: '12px',
  dialog: '16px',
  bubble: '20px',
  thread: '24px',
  capsule: '9999px',
  circle: '50%',
}
// Tailwind 那两张表的数字别名 → 同一张表上的档位值。
const RADIUS_NUMERIC_EXPECTED: Record<string, string> = {
  sm: '6px',
  md: '8px',
  lg: '8px',
  // surface 不是 Tailwind 的数字别名,是语义档自己的名字。两张表都得有它,
  // 否则 `rounded-surface` 只在「会话页也加载了」的时候才成立(主 app 单开时静默落空)。
  surface: '12px',
  xl: '12px',
  '2xl': '16px',
  '3xl': '20px',
  '4xl': '24px',
  full: '9999px',
}

// 判的是**几何**,不是我写的那串字面量:`0.5rem` 与 `8px` 必须读成同一个值,`0` 与 `0px` 同理。
// ⚠️ 这一步是被变异自测逼出来的:第一版按源码文本逐字比,于是「把 8px 改写成等价的 0.5rem」
// 这条**本该绿**的控红了 —— 那台尺子量的是拼写,不是圆角。一条只会因为改写而变红的判据,
// 会教下一个人忽略它。rem 按 CSS 根字号 16px 折算(本仓没有改过 html font-size,
// 全仓 `html { font-size` 命中为 0)。
function normalizeLength(value: string): string {
  const text = String(value).trim()
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem)?$/.exec(text)
  if (!match) return text
  const px = Number(match[1]) * (match[2] === 'rem' ? 16 : 1)
  return `${px}px`
}

function readRadiusScale(root: string, name: string): Record<string, RadiusEntry> | null {
  const spec = RADIUS_SCALE_SOURCES[name]
  let source = readFileSync(path.join(root, spec.file), 'utf8')
  if (spec.section) {
    const section = source.match(spec.section)
    if (!section) return null
    source = section[1]
  }
  const scale: Record<string, RadiusEntry> = {}
  for (const match of source.matchAll(spec.pattern)) {
    scale[spec.keyOf(match)] = { raw: spec.valueOf(match), px: normalizeLength(spec.valueOf(match)) }
  }
  // 同值两名的那几档(sm = document、md = control)只许有**一个定义处**,另一个写成
  // `var(--radius-document)` 这样的别名 —— 留两个数字就早晚会分叉。所以这把尺子得能穿过别名:
  // 它量的是几何,不是我写的那串字面量(同一条理由见 normalizeLength 的抬头)。
  // 只在同一张表内解析,深度有上限:自引用或循环别名会停在原样,由下面的逐档比对判红。
  for (let round = 0; round < 4; round += 1) {
    let changed = false
    for (const entry of Object.values(scale)) {
      const alias = /^var\(\s*--radius-([A-Za-z0-9-]+)\s*\)$/.exec(entry.raw)
      if (!alias) continue
      const target = scale[alias[1]]
      if (!target || target.raw === entry.raw) continue
      entry.raw = target.raw
      entry.px = target.px
      changed = true
    }
    if (!changed) break
  }
  return scale
}

function radiusScaleParity(root: string): string[] {
  const problems: string[] = []
  const semantic = readRadiusScale(root, 'tokens.css')
  if (!semantic) problems.push('tokens.css: shape 表读不到(borderRadius 段消失了?)')
  else {
    for (const [key, want] of Object.entries(RADIUS_SEMANTIC_EXPECTED)) {
      const got = semantic[key]
      if (got === undefined) problems.push(`tokens.css: 缺 --radius-${key}(圆角表的一档)`)
      else if (got.px !== normalizeLength(want)) {
        problems.push(`tokens.css: --radius-${key} = ${got.raw},圆角表是 ${want}`)
      }
    }
  }
  for (const name of ['tailwind.config.cjs', 'session/renderer/index.css']) {
    const scale = readRadiusScale(root, name)
    if (!scale) {
      problems.push(`${name}: borderRadius 表读不到`)
      continue
    }
    for (const [key, want] of Object.entries(RADIUS_NUMERIC_EXPECTED)) {
      const got = scale[key]
      if (got === undefined) {
        problems.push(
          `${name}: 没有显式给出 ${key} —— 不写就落回 Tailwind 默认,而另一张表写了,` +
          '同一个 document 里同名 utility 会打架'
        )
      } else if (got.px !== normalizeLength(want)) {
        problems.push(`${name}: ${key} = ${got.raw},另两张表是 ${want}`)
      }
    }
  }
  return problems
}

const MOBILE_SHELL_PATTERNS = [
  /\b[A-Za-z_$][\w$]*mobileShell[\w$]*\b/gi,
  /\bMOBILE_SHELL_[A-Z0-9_]+\b/g,
  /["'`]mobile-shell["'`]/g,
]

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(absolute))
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute)
  }
  return files.sort()
}

function relative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/')
}

function countMatches(files: string[], pattern: RegExp): number {
  let count = 0
  for (const file of files) count += [...readFileSync(file, 'utf8').matchAll(pattern)].length
  return count
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validateBaseline(value: ReturnType<typeof JSON.parse>) {
  const counts = value?.halfStepSpacingUtilities
  // assistantUi 是**必填**的:少写一个键 ⇒ baseline.assistantUi 是 undefined ⇒ 那一档的比较
  // 永远比不出问题,闸看着在跑、其实什么都不挡。棘轮的键必须缺一个就报一个。
  if (
    !counts ||
    !isCount(counts.sessionRenderer) ||
    !isCount(counts.mainRenderer) ||
    !isCount(counts.assistantUi)
  ) {
    throw new Error('invalid scripts/ui-visual-spec-baseline.json')
  }
  const geometry = value?.mainRendererGeometryDebt
  if (!geometry || GEOMETRY_DEBT_KEYS.some((key) => !isCount(geometry[key]))) {
    throw new Error('invalid scripts/ui-visual-spec-baseline.json: mainRendererGeometryDebt')
  }
  const assistantUiGeometry = value?.assistantUiGeometryDebt
  if (!assistantUiGeometry || GEOMETRY_DEBT_KEYS.some((key) => !isCount(assistantUiGeometry[key]))) {
    throw new Error('invalid scripts/ui-visual-spec-baseline.json: assistantUiGeometryDebt')
  }
  const offLadder = value?.offLadderFontSizeLiterals
  if (!offLadder || OFF_LADDER_SCOPES.some((key) => !isCount(offLadder[key]))) {
    throw new Error('invalid scripts/ui-visual-spec-baseline.json: offLadderFontSizeLiterals')
  }
  const spinners = value?.handRotatedSpinners
  if (!spinners || typeof spinners !== 'object' || Object.values(spinners).some((n) => !isCount(n) || n === 0)) {
    throw new Error('invalid scripts/ui-visual-spec-baseline.json: handRotatedSpinners')
  }
  return { ...counts, geometry, assistantUiGeometry, offLadder, spinners }
}

// 旧字阶写死字号的债,按范围各记一本(范围名与 baseline 的键一一对应)。
const OFF_LADDER_SCOPES = ['mainRenderer', 'sessionRenderer', 'sessionUi', 'sessionChatUi', 'assistantUi'] as const
function offLadderFontSizeLiterals(files: string[]): number {
  return countMatches(
    files.filter((file) => GEOMETRY_DEBT_EXTENSIONS.has(path.extname(file)) || path.extname(file) === '.css'),
    OFF_LADDER_FONT_SIZE_LITERAL,
  )
}

function geometryDebt(files: string[]): GeometryDebtCounts {
  const scanned = files.filter((file) => GEOMETRY_DEBT_EXTENSIONS.has(path.extname(file)))
  const counts = Object.fromEntries(GEOMETRY_DEBT_KEYS.map((key) => [key, 0])) as GeometryDebtCounts
  for (const file of scanned) {
    const source = readFileSync(file, 'utf8')
    for (const key of GEOMETRY_DEBT_KEYS) counts[key] += [...source.matchAll(GEOMETRY_DEBT_PATTERNS[key])].length
  }
  return counts
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset)
  const lines = before.split(/\r?\n/)
  return { line: lines.length, column: lines.at(-1)!.length + 1 }
}

function mobileShellReferences(files: string[]): MobileShellReference[] {
  const references: MobileShellReference[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of MOBILE_SHELL_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const { line, column } = lineAndColumn(source, match.index!)
        references.push({ file: relative(file), line, column, token: match[0] })
      }
    }
  }
  return references.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column
  )
}

function compareCount(label: string, actual: number, baseline: number, output: Output, what = 'half-step spacing utilities'): boolean {
  if (actual > baseline) {
    output.error(
      `NEW ${label} ${what} in source text (actual=${actual}, baseline=${baseline}); ` +
      'remove the additions instead of raising the ratchet'
    )
    return false
  }
  if (actual < baseline) {
    output.error(
      `STALE ${label} ${what} baseline (actual=${actual}, baseline=${baseline}); ` +
      'lower scripts/ui-visual-spec-baseline.json to keep the ratchet honest'
    )
    return false
  }
  return true
}

export function inspect(root: string = repoRoot) {
  const absoluteRendererRoot = path.join(root, 'apps/desktop/src')
  const absoluteSessionRoot = path.join(absoluteRendererRoot, 'session/renderer')
  // @@@task-ui-type-ladder 会话页组件库原来整个不在扫描面里 —— 主 app 消灭掉的 12px/14px
  // 在 packages/session-ui 里原样活着(28 处),正是因为守卫够不到它。
  // 字阶本体那道闸是 token 契约(删了键,tsc 直接编不过);这里补的是**字面量**那一路:
  // 绕开 token 直接写 `fontSize: '12px'` 不动契约,tsc 照样过。两道闸挡的不是同一件事。
  const absoluteSessionUiRoot = path.join(root, 'packages/session-ui/src')
  // @@@6104 转录那一包(session-chat-ui)同样不在扫描面里 —— 与 session-ui 一模一样的处境:
  // 主 app 消灭掉的 12px 在这里原样活着(2026-09-22 普查:mermaid 占位 / 附件名 / 结局动作键共 4 处),
  // 就因为守卫够不到它。行族的装饰口径有 markdown-rows.contract 钉着,**字阶没有**。
  // ❌ 别只加 session-ui 不加它:转录是用户盯得最久的那块面,漏掉它等于把闸开在最不重要的半边。
  const absoluteSessionChatUiRoot = path.join(root, 'packages/session-chat-ui/src')
  // @@@5013 assistant-ui 官方 registry 的源码,原样拷进来的(手机看管页整份用它的 Thread)。
  // 与 session/renderer 同一处境、同一处置:**单开一档自己的棘轮**,❌ 不混进 mainRenderer。
  //   · 混进去 = 拿别人的排版惯例顶掉咕咕自己的尺子,主 app 再飘就看不出来了;
  //   · 直接豁免 = 这份拷贝之后长成什么样都没人管。
  // 单开一档两头都占:它的数字只减不增,而主 app 的 77 仍然是主 app 自己的 77。
  const absoluteAssistantUiRoot = path.join(absoluteRendererRoot, 'components/assistant-ui')
  if (!statSync(absoluteSessionRoot).isDirectory()) throw new Error('task renderer source root is missing')
  if (!statSync(absoluteSessionUiRoot).isDirectory()) throw new Error('session-ui package source root is missing')
  if (!statSync(absoluteSessionChatUiRoot).isDirectory()) throw new Error('session-chat-ui package source root is missing')
  if (!statSync(absoluteAssistantUiRoot).isDirectory()) throw new Error('assistant-ui vendored root is missing')

  const under = (file: string, root_: string) => file === root_ || file.startsWith(`${root_}${path.sep}`)
  const sessionFiles = sourceFiles(absoluteSessionRoot)
  const sessionUiFiles = sourceFiles(absoluteSessionUiRoot)
  const sessionChatUiFiles = sourceFiles(absoluteSessionChatUiRoot)
  const assistantUiFiles = sourceFiles(absoluteRendererRoot).filter((file) =>
    under(file, absoluteAssistantUiRoot)
  )
  const mainFiles = sourceFiles(absoluteRendererRoot).filter(
    (file) => !under(file, absoluteSessionRoot) && !under(file, absoluteAssistantUiRoot)
  )
  return {
    counts: {
      sessionRenderer: countMatches(sessionFiles, HALF_STEP_SPACING_PATTERN),
      mainRenderer: countMatches(mainFiles, HALF_STEP_SPACING_PATTERN),
      assistantUi: countMatches(assistantUiFiles, HALF_STEP_SPACING_PATTERN),
    },
    assistantUiGeometryDebt: geometryDebt(assistantUiFiles),
    geometryDebt: geometryDebt(mainFiles),
    // ❌ stories 不豁免:摘出去之后在 story 里写回 12px 不会有任何东西变红,
    // 而 story 正是别人照抄的样板。
    bannedTypeHits: bannedTypeHits([...mainFiles, ...sessionFiles, ...sessionUiFiles, ...sessionChatUiFiles]),
    offLadderFontSizeLiterals: {
      mainRenderer: offLadderFontSizeLiterals(mainFiles),
      sessionRenderer: offLadderFontSizeLiterals(sessionFiles),
      sessionUi: offLadderFontSizeLiterals(sessionUiFiles),
      sessionChatUi: offLadderFontSizeLiterals(sessionChatUiFiles),
      assistantUi: offLadderFontSizeLiterals(assistantUiFiles),
    },
    mobileShellReferences: mobileShellReferences(sessionFiles),
    handRotatedSpinners: handRotatedSpinners([
      ...sourceFiles(absoluteRendererRoot),
      ...sessionUiFiles,
      ...sessionChatUiFiles,
    ]),
    radiusScaleProblems: radiusScaleParity(root),
    scannedFiles: {
      sessionRenderer: sessionFiles.length,
      mainRenderer: mainFiles.length,
      sessionUi: sessionUiFiles.length,
      sessionChatUi: sessionChatUiFiles.length,
      assistantUi: assistantUiFiles.length,
    },
  }
}

export function run(output: Output = console): number {
  try {
    const baseline = validateBaseline(JSON.parse(readFileSync(baselinePath, 'utf8')))
    const result = inspect()
    let passed = true

    passed = compareCount('task renderer', result.counts.sessionRenderer, baseline.sessionRenderer, output) && passed
    passed = compareCount('main renderer', result.counts.mainRenderer, baseline.mainRenderer, output) && passed
    passed = compareCount('assistant-ui (vendored)', result.counts.assistantUi, baseline.assistantUi, output) && passed
    for (const key of GEOMETRY_DEBT_KEYS) {
      passed = compareCount('main renderer', result.geometryDebt[key], baseline.geometry[key], output, key) && passed
      passed =
        compareCount(
          'assistant-ui (vendored)',
          result.assistantUiGeometryDebt[key],
          baseline.assistantUiGeometry[key],
          output,
          key
        ) && passed
    }

    for (const scope of OFF_LADDER_SCOPES) {
      passed =
        compareCount(
          scope,
          result.offLadderFontSizeLiterals[scope],
          baseline.offLadder[scope],
          output,
          'off-ladder (11/13/15/17) font-size literals —— 换成 --font-caption/--font-body/--font-title/--font-prose',
        ) && passed
    }

    for (const file of new Set([...Object.keys(result.handRotatedSpinners), ...Object.keys(baseline.spinners)])) {
      const actual = result.handRotatedSpinners[file] ?? 0
      const allowed = baseline.spinners[file] ?? 0
      if (actual > allowed) {
        output.error(
          `${file}: NEW hand-rotated spinner (animate-spin ${actual}, baseline ${allowed}) —— ` +
          '全产品只有一个加载态(product spec):换成 @/lib/loading/LoadingIndicator ' +
          '(行内用 size="inline"),❌ 别往基线里加'
        )
        passed = false
      } else if (actual < allowed) {
        output.error(
          `${file}: STALE handRotatedSpinners baseline (actual=${actual}, baseline=${allowed}); ` +
          'lower scripts/ui-visual-spec-baseline.json to keep the ratchet honest'
        )
        passed = false
      }
    }

    for (const hit of result.bannedTypeHits) {
      output.error(
        `${hit.file}:${hit.line}:${hit.column}: ${JSON.stringify(hit.token)} —— 不在咕咕字阶(12/14/16/20/24)上` +
        `${hit.id === 'half-pixel-font-size' ? '（半个像素会被屏幕四舍五入，同一界面在不同缩放下会飘）' : ''}。` +
        '紧凑界面用 var(--font-body)，消息与长段正文用 var(--font-prose)，时间戳/计数/徽标等标记用 var(--font-caption)。'
      )
    }
    if (result.bannedTypeHits.length > 0) passed = false

    for (const problem of result.radiusScaleProblems) {
      output.error(`radius scale parity: ${problem}(见 docs/ui-visual-spec.md §5)`)
    }
    if (result.radiusScaleProblems.length > 0) passed = false

    for (const reference of result.mobileShellReferences) {
      output.error(
        `${reference.file}:${reference.line}:${reference.column}: task renderer desktop-only premise violated by ` +
        `${JSON.stringify(reference.token)}; --text-micro is 10px, below the mobile-shell 14px body minimum. ` +
        'Re-adjudicate docs/ui-visual-spec.md section 2 before introducing a mobile-shell branch.'
      )
    }
    if (result.mobileShellReferences.length > 0) passed = false

    if (!passed) return 1
    output.log(
      'UI visual spec guard passed: source-text half-step spacing ' +
      `task=${result.counts.sessionRenderer}, main=${result.counts.mainRenderer}, ` +
      `assistant-ui=${result.counts.assistantUi}; ` +
      `task mobile-shell references=${result.mobileShellReferences.length}; ` +
      `radius scale parity problems=${result.radiusScaleProblems.length}; ` +
      `main geometry debt ${GEOMETRY_DEBT_KEYS.map((key) => `${key}=${result.geometryDebt[key]}`).join(' ')}; ` +
      `banned type hits=${result.bannedTypeHits.length}; ` +
      `off-ladder literals ${OFF_LADDER_SCOPES.map((key) => `${key}=${result.offLadderFontSizeLiterals[key]}`).join(' ')}; ` +
      `hand-rotated spinners=${Object.values(result.handRotatedSpinners).reduce((sum, n) => sum + n, 0)}; ` +
      `${result.scannedFiles.sessionRenderer + result.scannedFiles.mainRenderer + result.scannedFiles.sessionUi + result.scannedFiles.sessionChatUi} files scanned ` +
      `(main=${result.scannedFiles.mainRenderer} session=${result.scannedFiles.sessionRenderer} ` +
      `session-ui=${result.scannedFiles.sessionUi} session-chat-ui=${result.scannedFiles.sessionChatUi})`
    )
    return 0
  } catch (error) {
    output.error(`UI visual spec guard error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run()
}
