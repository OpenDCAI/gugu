#!/usr/bin/env node
// 重生 packages/session-ui/src/icons.tsx(app 侧经 apps/desktop/src/lib/icons.tsx 转发)。
//
//   node scripts/gen-icons.mjs           # 写文件
//   node scripts/gen-icons.mjs --check   # 只比对,不写(CI 用)
//
// 病根:这个文件头上一直写着「自动生成,改 scripts 重生(gen-icons-module.js)」,
// 但那个脚本从来不在仓库里(2026-08-12 核实)。于是「勿手改」和「没法重生」并存 ——
// 想加一个图标就只能违反注释去手抄,实际结果是 64 个字形里攒出了 20 个对不上 Solar
// 上游的手写货(`Check` 的字形其实是 lucide 的 `M5 13l4 4L19 7`)。这个脚本补上那半。
//
// 清单 scripts/icons/solar-icons.json 分两栏,是刻意的:
//   solar   —— 从 @iconify-json/solar 现取 body。加图标只需在这里加一行。
//   literal —— 上面那 20 个手写货,原样保留。
// 分栏让「让文件可重生」这一步**零像素变化**(重生结果与改动前逐字节相同,有测试钉住),
// 而「把 literal 换成真 Solar」是一次看得见的产品改动,该单独过审,
// ❌ 不该混在工具重建里偷偷发生 —— 那 20 个是 Check/Plus/X 这类全站高频图标。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(repoRoot, 'scripts/icons/solar-icons.json')
const targetPath = path.join(repoRoot, 'packages/session-ui/src/icons.tsx')
// 字形本身单独一份纯数据(不 import React):App 页面的 <gugu-icon>(/_gugu/<ver>/ui.js)与 React 组件读同一份。
const bodiesPath = path.join(repoRoot, 'packages/session-ui/src/icon-bodies.ts')

const BODIES_HEADER = `/**
 * Solar 图标集的字形 —— Icons: Solar Icon Set by 480 Design — CC BY 4.0 (https://github.com/480-Design/Solar-Icon-Set)
 * Lucide 0.564.0 original glyphs: ISC / Feather MIT; full notices in THIRD_PARTY_NOTICES.md.
 * 自动生成, 勿手改 —— 改 scripts/icons/solar-icons.json 后跑 \`node scripts/gen-icons.mjs\`.
 * 纯数据,不 import 任何东西:React 的图标组件(icons.tsx)和 App 页面的 <gugu-icon>(app-runtime/ui)都读这一份。
 */
`

const HEADER = `/**
 * Solar 图标集 (drop-in 替代 lucide-react) —— 设计决策见 README / About 署名.
 * Icons: Solar Icon Set by 480 Design — CC BY 4.0 (https://github.com/480-Design/Solar-Icon-Set)
 * Lucide 0.564.0 original glyphs: ISC / Feather MIT; full notices in THIRD_PARTY_NOTICES.md.
 * 用法不变: import { Settings } from '@/lib/icons';  <Settings size={16} className="..." />
 *
 * 自动生成, 勿手改 —— 改 scripts/icons/solar-icons.json 后跑 \`node scripts/gen-icons.mjs\`.
 * 加图标: 在清单的 "solar" 栏加一行 "导出名": "<solar 图标名>", body 会从 @iconify-json/solar
 * 逐字节取来。❌ 别手写 path —— "literal" 栏那些就是手写攒出来的, 与上游对不上。
 * 同形别名(lucide 的 *Icon 后缀、CircleAlert/AlertCircle 这类历史改名): 写进 \`alias\` 栏,
 * ❌ 别在 \`solar\` 栏写两条指向同一个图标 —— 那会生成两份一模一样的 body。
 * 填充态: 另开一个 \`*Filled\` 导出取 \`-bold\` 字形 (HeartFilled 是样板)。
 * ❌ 别指望外层 \`fill=\` 覆盖 body 里写死的 fill="none", 那会静默保持空心。
 */
import { forwardRef, type SVGProps } from 'react'
import { ICON_BODIES as BODIES, ICON_ATTRIBUTES as ATTRIBUTES } from './icon-bodies'
`

const FACTORY = `
export interface IconProps
  extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'children' | 'dangerouslySetInnerHTML'> {
  size?: number | string
  /** Copied stroke glyphs honor this; Solar bodies retain their built-in line widths. */
  strokeWidth?: number | string
  absoluteStrokeWidth?: boolean
  /**
   * 图标是叶子:\`<svg>\` 的内容永远是 \`BODIES[name]\`,没有第二个出处。
   * 声明成 \`never\` 是为了让 \`<Icon>x</Icon>\` 在**编译期**就红 —— 结构上不可达,
   * 比运行时抓到更强(见本包 spec「能靠删掉越界档位让它在类型上不可达的,优先删而不是守」)。
   */
  children?: never
}

// @@@icon-swallows-children - 图标必须自己吃掉 children, 否则 Base UI 的 render 协议会打死整棵子树
//
// \`children\` 不属于图标的合同,但**运行期**照样会有人塞进来:Base UI 的 \`render\` 协议里,
// 带默认字形的 part 会无条件把自己的字形合进 render 元素 —— \`select/icon/SelectIcon\` 合
// \`children: '▼'\`,\`combobox/clear\` 合 \`'x'\`,\`*/item-indicator\` 合 \`'✔️'\`(evaluateRenderProp:
// \`mergeProps(props, render.props)\` + \`cloneElement\`,而 \`render={<Icon />}\` 自己没写 children,
// 那个默认字形就活下来了)。这不是调用方写错:\`render={<ChevronDownIcon />}\` 的语义正是
// 「用这个图标顶掉默认字形」,顶掉就意味着必须丢弃它。
//
// 所以 children 必须在**这里**被吃掉,而不是让每个调用点去绕开:\`{...rest}\` 一旦把它带到
// \`<svg>\` 上,就和 \`dangerouslySetInnerHTML\` 撞成 React 硬约束
// 「Can only set one of \`children\` or \`props.dangerouslySetInnerHTML\`」,
// 而 React 是**整棵子树**一起交给 error boundary —— #3504 里一个下拉框的箭头把整个会话页
// 打成一个 Reload 按钮。⚠️ 别把这条改成「在 select 那个调用点包一层 span」:
// 那只修 6 个 part × 149 个图标里的 1 个组合,下一个 \`render={<Icon />}\` 照样打死子树。
function makeIcon(name: string) {
  // @@@icon-body-identity - 字形对象每个图标只建一次:React 19 按引用比这个属性,换一个新对象就重写 innerHTML,
  // \`<svg>\` 里的 \`<path>\` 整个换新。按下到抬起之间重渲染一次(按下就把那块设成正看着的),按下落在旧 path、
  // 抬起落在新 path,浏览器不发 click —— 没在看的那块,点「关闭这一块」第一下没反应(#7091)。
  const html = { __html: BODIES[name] }
  const defaults = ATTRIBUTES[name]
  const Icon = forwardRef<SVGSVGElement, IconProps>(
    ({ size = 24, strokeWidth = defaults?.strokeWidth, absoluteStrokeWidth, color, className, children: _children, ...rest }, ref) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        {...defaults}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        color={color}
        stroke={defaults ? color ?? defaults.stroke : undefined}
        strokeWidth={defaults ? (absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth) : undefined}
        className={defaults ? [defaults.className, className].filter(Boolean).join(' ').trim() : className}
        aria-hidden={defaults && Object.keys(rest).some((key) => key.startsWith('aria-') || key === 'role' || key === 'title') ? undefined : 'true'}
        {...rest}
        dangerouslySetInnerHTML={html}
      />
    )
  )
  Icon.displayName = name
  return Icon
}

/**
 * 一个图标组件的类型 —— 用来替代 lucide 的 \`LucideIcon\`。
 * 图标当值传递(存进映射表、按状态三元切换、当 prop 传)时标这个,
 * ❌ 别写 \`typeof Folder\` 反推:那会把某一个具体图标的身份焊进类型里。
 */
export type IconComponent = ReturnType<typeof makeIcon>
`

function loadSolar() {
  // 这个包只在生成/校验时用,不进产物 —— body 是内联字符串,运行时不 import 它。
  const require = createRequire(import.meta.url)
  return require('@iconify-json/solar/icons.json')
}

/** 导出名 → 字形 body(solar 栏现取 + literal 栏原样),带全部一致性检查。 */
function iconBodies(manifest, solar) {
  const bodies = {}
  for (const [exportName, solarName] of Object.entries(manifest.solar)) {
    const def = solar.icons[solarName]
    if (!def) throw new Error(`Solar 里没有 ${solarName}(导出 ${exportName})`)
    // 非 24×24 的图标塞进固定 viewBox 会被静默缩放错位 —— 宁可报错。
    if (def.width || def.height) {
      throw new Error(`${solarName} 尺寸非 24×24(${def.width}×${def.height}),不能直接用`)
    }
    bodies[exportName] = def.body
  }
  for (const [exportName, body] of Object.entries(manifest.literal)) {
    if (exportName in bodies) throw new Error(`${exportName} 同时出现在 solar 与 literal 栏`)
    bodies[exportName] = body
  }

  // 两个导出名指向同一个 Solar 图标 = 生成两份一模一样的 body。
  // 该走 alias 栏。这条检查是照着我自己犯过的错加的(Ellipsis 与 MoreHorizontal 都指
  // menu-dots-linear),不加就会一路重复下去,而且改一个忘改另一个。
  const seen = new Map()
  for (const [exportName, solarName] of Object.entries(manifest.solar)) {
    if (seen.has(solarName)) {
      throw new Error(
        `${exportName} 与 ${seen.get(solarName)} 都指向 ${solarName} —— ` +
        `同形应走 alias 栏("${exportName}": "${seen.get(solarName)}"),❌ 别生成两份相同 body`
      )
    }
    seen.set(solarName, exportName)
  }
  // 同形别名指向的必须是真有字形的导出。
  for (const [from, to] of Object.entries(manifest.alias ?? {})) {
    if (!(to in bodies)) throw new Error(`别名 ${from} 指向不存在的导出 ${to}`)
    if (from in bodies) throw new Error(`${from} 既在字形栏又在 alias 栏`)
  }
  return bodies
}

const sortedAliases = (manifest) => Object.entries(manifest.alias ?? {}).sort(([a], [b]) => a.localeCompare(b))

/** packages/session-ui/src/icon-bodies.ts:字形与同形别名,纯数据。 */
export function renderBodies(manifest, solar) {
  const bodies = iconBodies(manifest, solar)
  const lines = [BODIES_HEADER, 'export const ICON_BODIES: Record<string, string> = {']
  for (const name of Object.keys(bodies).sort()) {
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(bodies[name])},`)
  }
  lines.push('}', '', '/** 同形别名 → 它复用的那个导出名。 */', 'export const ICON_ALIASES: Record<string, string> = {')
  for (const [from, to] of sortedAliases(manifest)) lines.push(`  ${JSON.stringify(from)}: ${JSON.stringify(to)},`)
  lines.push('}', '', '/** SVG defaults retained with the copied stroke glyphs; shared by React and App elements. */', 'export const ICON_ATTRIBUTES: Record<string, { fill: string; stroke: string; strokeWidth: number; strokeLinecap: "round"; strokeLinejoin: "round"; className: string }> = {')
  for (const name of Object.keys(manifest.svg ?? {}).sort()) {
    if (!(name in bodies)) throw new Error(`SVG defaults reference missing glyph ${name}`)
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(manifest.svg[name])},`)
  }
  lines.push('}', '')
  return lines.join('\n')
}

/** packages/session-ui/src/icons.tsx:每个字形一个 React 组件,字形从 icon-bodies.ts 读。 */
export function renderModule(manifest, solar) {
  const names = Object.keys(iconBodies(manifest, solar)).sort()
  const lines = [HEADER, FACTORY]
  for (const name of names) lines.push(`export const ${name} = makeIcon(${JSON.stringify(name)})`)
  // 同形别名:直接复用那个组件,❌ 不再 makeIcon 一次(那会多一份 body 和一个组件实例)。
  for (const [from, to] of sortedAliases(manifest)) lines.push(`export const ${from} = ${to}`)
  lines.push('')
  return lines.join('\n')
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const solar = loadSolar()
const outputs = [
  [targetPath, renderModule(manifest, solar)],
  [bodiesPath, renderBodies(manifest, solar)],
]

if (process.argv.includes('--check')) {
  for (const [file, rendered] of outputs) {
    const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    if (actual !== rendered) {
      console.error(
        `❌ ${path.relative(repoRoot, file)} 与清单不一致。\n` +
        '   改图标要改 scripts/icons/solar-icons.json 再跑 `node scripts/gen-icons.mjs`,\n' +
        '   ❌ 别直接手改生成物 —— 下次重生就会把手改冲掉。'
      )
      process.exit(1)
    }
  }
  const n = Object.keys(manifest.solar).length + Object.keys(manifest.literal).length
  console.log(`icons module up to date: ${n} icons (${Object.keys(manifest.literal).length} non-Solar literals)`)
} else {
  for (const [file, rendered] of outputs) {
    fs.writeFileSync(file, rendered)
    console.log(`wrote ${path.relative(repoRoot, file)}`)
  }
}
