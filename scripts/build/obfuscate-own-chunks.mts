// @@@obfuscate-own-chunks (#7195) — 渲染层产物里「自家代码为主」的块过一遍 JS 混淆。抬成本,不是安全边界。
//
// 为什么只碰自家块:第三方包(react / mermaid / katex …)本来就公开,混淆它们只涨体积、涨启动耗时、增风险。
// 判据 = 块里渲染后字节的一半以上来自 node_modules 之外(自家源码 + workspace 包);虚拟模块(\0 开头:
// preload-helper、commonjs 包装)不算自家也不算第三方,不进分子分母。
//
// ⚠️ 必须在 Vite 的 vite:build-import-analysis 之后跑 —— 它在 generateBundle 里把 `__VITE_PRELOAD__` 占位符换成
// 懒加载块的依赖表(JS + 它的 CSS),靠的是读 `import("./x.js")` 的字面量说明符。混淆器会把说明符挪进字符串数组
// (`import(_0x48c9d4(0x1337))`),先混淆的话分析找不到字面量,依赖表就被换成 `[]`:懒加载的块丢掉预加载,
// **它的 CSS 也不再被注入**。2026-10-15 实测:不加 order:'post' 时 12 处依赖表只剩 5 处。
// 所以这里用 generateBundle 的 order:'post'(Vite 把 import-analysis 放在 build post 段,普通顺序跑不到它后面)。
// 为什么不是 renderChunk:那时哈希占位串还在,字符串数组一编码占位符就替换不了。
//
// 因为它现在跑在 rendererAsciiOutput() 之后,所以混淆完由这里自己再做一次 ASCII 转义(#6484:混淆器会把中文
// 原字面量带回来,不转义的话渲染进程里脚本源码按双字节存、内存翻倍)。
//
// 默认关闭(GUGU_OBFUSCATE_RENDERER=1 才开)。❌ 失败不回退成不混淆:混淆器对某块抛错就整个构建失败,
// 静默产出一个「以为混淆了」的包比构建失败更糟。
import { createHash } from 'node:crypto'
import JavaScriptObfuscator, { type ObfuscatorOptions } from 'javascript-obfuscator'
import type { Plugin } from 'vite'
import { escapeNonAscii, taggedTemplateNonAsciiRanges } from './renderer-chunking.mjs'

/** 自家字节占比达到它才混淆。 */
export const OWN_CHUNK_THRESHOLD = 0.5

/**
 * 保守档:不开 controlFlowFlattening / deadCodeInjection / selfDefending / debugProtection / transformObjectKeys。
 * 前两项体积与耗时代价大,后两项依赖 Function.prototype.toString / 会冻结 DevTools(devtools-lock 另有安排),
 * transformObjectKeys 有已知的默认参数对象共享缺陷(5.8.1 才修)。renameGlobals:false 保证跨块的导出名不变。
 */
export const OBFUSCATION_PROFILE: ObfuscatorOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
}

/** 环境变量严格解析:只认 '1' / 未设 / 空串;其余一律抛(拼错了不能静默当成「关」)。 */
export function parseObfuscateFlag(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false
  if (raw === '1') return true
  throw new Error(`GUGU_OBFUSCATE_RENDERER='${raw}' 不认识 —— 只接受 1(开)或不设(关)`)
}

export function isVirtualModule(id: string): boolean {
  return id.startsWith('\0')
}

export function isOwnModule(id: string): boolean {
  return !isVirtualModule(id) && !/[\\/]node_modules[\\/]/.test(id)
}

/** 自家字节 / (自家 + 第三方)字节;虚拟模块两边都不算。全是虚拟模块 = 0(不混淆)。 */
export function ownByteRatio(modules: Record<string, { renderedLength: number }>): number {
  let own = 0
  let total = 0
  for (const [id, m] of Object.entries(modules)) {
    if (isVirtualModule(id)) continue
    total += m.renderedLength
    if (isOwnModule(id)) own += m.renderedLength
  }
  return total === 0 ? 0 : own / total
}

/** 同一版本同一文件名 => 同一份产物(构建可复现);换版本 => 字符串数组与标识符映射全变。 */
export function chunkSeed(version: string, fileName: string): number {
  return parseInt(createHash('sha256').update(`${version}\0${fileName}`).digest('hex').slice(0, 8), 16)
}

export function obfuscateOwnChunks(opts: { version: string }): Plugin {
  return {
    name: 'gugu-obfuscate-own-chunks',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        let hit = 0
        let skipped = 0
        let before = 0
        let after = 0
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk') continue
          if (item.map) {
            // 混淆会让已生成的 sourcemap 作废;静默带着失效的 map 出包比构建失败更糟。
            this.error(`${item.fileName}: 构建开了 sourcemap,混淆会使它失效 —— 先关 sourcemap,或让本插件接管 map`)
          }
          if (ownByteRatio(item.modules) < OWN_CHUNK_THRESHOLD) {
            skipped++
            continue
          }
          const code = item.code
          let obfuscated: string
          try {
            obfuscated = JavaScriptObfuscator.obfuscate(code, {
              ...OBFUSCATION_PROFILE,
              seed: chunkSeed(opts.version, item.fileName),
            }).getObfuscatedCode()
          } catch (error) {
            this.error(`${item.fileName}: 混淆失败 —— ${error instanceof Error ? error.message : String(error)}`)
          }
          // 与 rendererAsciiOutput 同一条路径:rollup 的解析器给区间,区间外全部转义
          item.code = escapeNonAscii(obfuscated, taggedTemplateNonAsciiRanges(this.parse(obfuscated)))
          hit++
          before += code.length
          after += item.code.length
        }
        this.info(
          `obfuscate-own-chunks: 混淆 ${hit} 块、跳过 ${skipped} 块(第三方为主);` +
            `${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB`,
        )
      },
    },
  }
}
