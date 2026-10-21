import type { Plugin } from 'vite'

export interface ChunkGraphEntry {
  type: string
  fileName: string
  imports?: readonly string[]
}

export type ChunkGraph = Record<string, ChunkGraphEntry>

const EDITOR_PACKAGES = ['@codemirror/', '@lezer/', '@emoji-mart/']

export function packageNameFromModuleId(id: string): string | null {
  const normalized = id.replaceAll('\\', '/')
  const marker = 'node_modules/'
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return null

  const parts = normalized.slice(index + marker.length).split('/')
  if (!parts[0]) return null
  return parts[0].startsWith('@') && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0]
}

// @@@exp-single-rollup (#2666) — 多入口下,「这个模块被哪些入口够得到」是分 chunk 的前提。
// rollup 把 { getModuleInfo } 作为第二参传进 manualChunks,原实现只吃 id、把它扔了 —— 于是
// 会话页入口独有的 Monaco/mermaid 也被无差别塞进咕咕的 vendor(实测 5.1MB → 11.9MB),
// 且会话页的 devicon/katex/sonner CSS 漏进 index.html 的 vendor CSS(实测 320KB)。
//
// ⚠️ 不要用「从模块沿 importers 反向递归」求可达 —— 图有环,记忆化必须保守,10715 个模块上会
// 退化到跑不完(实测 >600s 未结束)。正确做法是**正向一次性传播**:模块图完整后从入口沿
// importedIds 走一遍,O(V+E),之后 manualChunks 只查表。
//
// @@@vendor-static-only — 只沿**静态** import 走,❌ 沿 dynamicallyImportedIds。vendor 在 index.html
// 里被 modulepreload,rollup 的 ESM 产物在 chunk 加载时就执行其中每一个模块:把只经 import() 够得到的
// 包塞进 vendor,等于把代码里写好的懒加载在启动时全部提前执行一遍。mac1 2026-09-25 实测(#6484 后续):
// vendor 渲染后 25.2 MB 里 16.6 MB 只经 import() 可达(mermaid、@visactor/vchart、elkjs、pptx 渲染器、
// cytoscape、shiki 语法包…)。这些模块返回 undefined,由 rollup 按各自的 import() 边界切成按需 chunk。
export interface ModuleGraphContext {
  getModuleIds: () => Iterable<string>
  getModuleInfo: (id: string) => {
    isEntry?: boolean
    importedIds?: readonly string[]
  } | null
}

/** 可变持有者:插件在 buildEnd 填好,manualChunks 在分 chunk 时读。 */
export interface EntryReachability {
  guguReachable: Set<string> | null
}

export function computeEntryReachability(
  ctx: ModuleGraphContext,
  isGuguEntry: (id: string) => boolean
): Set<string> {
  const reachable = new Set<string>()
  const stack: string[] = []
  for (const id of ctx.getModuleIds()) {
    if (ctx.getModuleInfo(id)?.isEntry && isGuguEntry(id)) stack.push(id)
  }
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (reachable.has(current)) continue
    reachable.add(current)
    const info = ctx.getModuleInfo(current)
    if (!info) continue
    for (const next of info.importedIds ?? []) {
      if (!reachable.has(next)) stack.push(next)
    }
  }
  return reachable
}

export function rendererManualChunk(id: string): string | undefined {
  const pkg = packageNameFromModuleId(id)
  if (!pkg) return undefined

  if (
    EDITOR_PACKAGES.some((prefix) => pkg.startsWith(prefix)) ||
    pkg === 'emoji-mart'
  ) {
    return undefined
  }
  if (pkg.startsWith('@supabase/')) return 'vendor-supabase'

  // Keep this chunk dependency-free outside the React core. Grouping react-select, framer-motion,
  // or other React consumers here creates vendor -> vendor-react -> vendor cycles whose evaluation
  // order differs by platform and caused the Windows 0.2.29 renderer TDZ crash (#2438).
  if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'vendor-react'
  return 'vendor'
}

/**
 * 多入口版。只有**咕咕入口静态够得到**的模块才走咕咕那套 vendor 分组;会话页入口独有的、以及只经 import() 够得到的模块返回
 * undefined,交给 rollup 按入口自然切分 —— 于是它们不进 index.html 的 vendor(JS 与 CSS 都不进)。
 * 两个入口都够得到的(react 等)仍然走分组 → 共享 chunk,去重照样发生。
 * 可达集尚未算出时保守走原分组,绝不静默改变既有行为。
 */
export function entryAwareRendererManualChunk(
  reachability: EntryReachability
): (id: string) => string | undefined {
  return (id) => {
    if (!packageNameFromModuleId(id)) return undefined
    const reachable = reachability.guguReachable
    if (!reachable) return rendererManualChunk(id)
    if (!reachable.has(id)) return undefined
    return rendererManualChunk(id)
  }
}

/** buildEnd 时(模块图已完整、早于分 chunk)算好可达集。 */
export function guguEntryReachabilityPlugin(
  reachability: EntryReachability,
  isGuguEntry: (id: string) => boolean
): Plugin {
  return {
    name: 'gugu-entry-reachability',
    buildEnd(this: unknown) {
      const ctx = this as ModuleGraphContext
      reachability.guguReachable = computeEntryReachability(ctx, isGuguEntry)
    },
  }
}

export function findStaticChunkCycle(bundle: ChunkGraph): string[] | null {
  const chunks = new Map(
    Object.values(bundle)
      .filter((item) => item.type === 'chunk')
      .map((chunk) => [chunk.fileName, chunk])
  )
  const visited = new Set<string>()
  const active = new Map<string, number>()
  const stack: string[] = []

  const visit = (fileName: string): string[] | null => {
    const activeIndex = active.get(fileName)
    if (activeIndex !== undefined) return [...stack.slice(activeIndex), fileName]
    if (visited.has(fileName)) return null

    active.set(fileName, stack.length)
    stack.push(fileName)
    for (const imported of chunks.get(fileName)?.imports ?? []) {
      if (!chunks.has(imported)) continue
      const cycle = visit(imported)
      if (cycle) return cycle
    }
    stack.pop()
    active.delete(fileName)
    visited.add(fileName)
    return null
  }

  for (const fileName of chunks.keys()) {
    const cycle = visit(fileName)
    if (cycle) return cycle
  }
  return null
}

export function rendererChunkCycleGuard(): Plugin {
  return {
    name: 'gugu-renderer-chunk-cycle-guard',
    generateBundle(_options, bundle) {
      const cycle = findStaticChunkCycle(bundle)
      if (cycle) {
        throw new Error(`[renderer-chunk-cycle] static chunk cycle: ${cycle.join(' -> ')}`)
      }
    }
  }
}

const NON_ASCII = /[\u0080-￿]/

/**
 * 把一段 JS 里剩下的非 ASCII 字符(按 UTF-16 码元)换成 `\uXXXX`。
 * 前面是奇数个反斜杠的,原本是恒等转义(`\ü` 就是 `ü`),去掉那一个反斜杠,否则转义后语义会变。
 * `\uXXXX` 在字符串、正则(带不带 u 标志)、标识符里都与原字符等价;注释里无所谓。
 * 唯一的例外是带标签模板的 raw 文本(`String.raw` 这类标签拿到的就是源码原文,转了值就变),
 * 由调用方用 `keep`(见 taggedTemplateNonAsciiRanges)把这些区间原样留下。
 */
export function escapeNonAscii(code: string, keep: ReadonlyArray<readonly [number, number]> = []): string {
  const escape = (text: string) =>
    text.replace(/(\\*)([\u0080-￿])/g, (_match, slashes: string, ch: string) => {
      const kept = slashes.length % 2 === 1 ? slashes.slice(1) : slashes
      return `${kept}\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    })
  let out = ''
  let pos = 0
  for (const [start, end] of [...keep].sort((a, b) => a[0] - b[0])) {
    out += escape(code.slice(pos, start)) + code.slice(start, end)
    pos = end
  }
  return out + escape(code.slice(pos))
}

/**
 * 带标签模板里含非 ASCII 的 raw 段(TemplateElement)在源码中的区间。esbuild 的 charset=ascii 也刻意不碰
 * 这些字符(esbuild 0.25.12 实测:`String.raw\`中文\`` 原样输出),转了就会改变标签拿到的 raw。
 * `ast` 是 rollup 的 `this.parse` / `parseAst` 结果(ESTree,区间按 JS 字符串下标)。
 */
export function taggedTemplateNonAsciiRanges(ast: unknown): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const stack: unknown[] = [ast]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
      continue
    }
    const tagged = node as { type?: unknown; quasi?: { quasis?: Array<{ start: number; end: number; value: { raw: string } }> } }
    if (tagged.type === 'TaggedTemplateExpression') {
      for (const quasi of tagged.quasi?.quasis ?? []) {
        if (NON_ASCII.test(quasi.value.raw)) ranges.push([quasi.start, quasi.end])
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  return ranges
}

/**
 * @@@renderer-ascii-output — 渲染层 JS 产物只出 ASCII。Blink 把脚本源码常驻在渲染进程里,只要有一个
 * 非 Latin-1 字符,整份源码就按 UTF-16 存、内存翻倍。`esbuild.charset: 'ascii'`(vite.config.mts)管住了
 * 字符串与标识符,但正则字面量(如 `/离线|not connected/`)与许可证注释里的字符它不转;这些残留让
 * 启动就加载的 vendor / index 整份仍是双字节。这里在所有 renderChunk(含压缩)之后收尾。
 * 带标签模板的 raw 文本原样保留(转了会变值),遇到就 warn:那个 chunk 因此仍按双字节存。
 */
export function rendererAsciiOutput(): Plugin {
  return {
    name: 'gugu-renderer-ascii-output',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk' || !NON_ASCII.test(item.code)) continue
        const keep = taggedTemplateNonAsciiRanges(this.parse(item.code))
        if (keep.length > 0) {
          this.warn(
            `${item.fileName}: ${keep.length} 处带标签模板的 raw 含非 ASCII,按原样保留(转义会改变标签拿到的 raw);这个 chunk 因此仍按双字节存`
          )
        }
        item.code = escapeNonAscii(item.code, keep)
      }
    },
  }
}
