// @@@obfuscate-own-chunks (#7195) — 只混淆「自家代码为主」的块;混淆后行为不变;不破坏 Vite 的预加载依赖表。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import JavaScriptObfuscator from 'javascript-obfuscator'
import { build, parseAst } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  chunkSeed,
  isOwnModule,
  obfuscateOwnChunks,
  OBFUSCATION_PROFILE,
  OWN_CHUNK_THRESHOLD,
  ownByteRatio,
  parseObfuscateFlag,
} from '../../../scripts/build/obfuscate-own-chunks.mts'

const repoRoot = path.resolve(__dirname, '../../..')

type Item = {
  type: 'chunk'
  fileName: string
  code: string
  map?: unknown
  modules: Record<string, { renderedLength: number }>
}
const OWN = '/repo/apps/desktop/src/feature.ts'
const VENDOR = '/repo/node_modules/.pnpm/react@19/node_modules/react/index.js'
const chunk = (fileName: string, code: string, modules: Item['modules']): Item => ({ type: 'chunk', fileName, code, modules })

// 插件的 generateBundle 是 { order: 'post', handler };handler 只用到 this.info / this.error / this.parse
function runPlugin(plugin: unknown, bundle: Record<string, unknown>) {
  const hook = (plugin as { generateBundle: { order: string; handler: (this: unknown, o: unknown, b: unknown) => void } }).generateBundle
  const infos: string[] = []
  hook.handler.call(
    {
      info: (m: string) => infos.push(m),
      error: (m: string) => {
        throw new Error(m)
      },
      warn: () => {},
      parse: parseAst,
    },
    {},
    bundle,
  )
  return infos
}
const evalChunk = (code: string): unknown => {
  const sandbox = vm.createContext({})
  vm.runInContext(code, sandbox)
  return (sandbox as { __r?: unknown }).__r
}

// 自家代码样例:局部标识符 uniqueLocalName 混淆后必须消失;结果 'x:55'
const OWN_CODE = `globalThis.__r = (function () { var uniqueLocalName = 'x'; var sum = 0; for (var i = 1; i <= 10; i++) sum += i; return uniqueLocalName + ':' + sum })()`

describe('parseObfuscateFlag', () => {
  it('未设 / 空串 = 关;1 = 开', () => {
    expect(parseObfuscateFlag(undefined)).toBe(false)
    expect(parseObfuscateFlag('')).toBe(false)
    expect(parseObfuscateFlag('1')).toBe(true)
  })
  it.each(['0', 'true', 'yes', 'on', ' 1'])('拼错了不能静默当成「关」:%j 抛错', (raw) => {
    expect(() => parseObfuscateFlag(raw)).toThrow(/GUGU_OBFUSCATE_RENDERER/)
  })
})

describe('自家 / 第三方的判据', () => {
  it('workspace 包与 apps 源码是自家;node_modules(含 Windows 分隔符)与虚拟模块不是', () => {
    expect(isOwnModule('/repo/apps/desktop/src/App.tsx')).toBe(true)
    expect(isOwnModule('/repo/packages/session-core/src/x.ts')).toBe(true)
    expect(isOwnModule(VENDOR)).toBe(false)
    expect(isOwnModule('C:\\repo\\node_modules\\.pnpm\\react\\index.js')).toBe(false)
    expect(isOwnModule('\0vite/preload-helper.js')).toBe(false)
  })
  it('占比按渲染后字节算;虚拟模块两边都不算(不会把边界块拖到阈值以下)', () => {
    expect(ownByteRatio({ [OWN]: { renderedLength: 30 }, [VENDOR]: { renderedLength: 70 } })).toBeCloseTo(0.3)
    expect(
      ownByteRatio({
        '\0vite/preload-helper.js': { renderedLength: 10_000 },
        '\0commonjsHelpers.js': { renderedLength: 10_000 },
        [OWN]: { renderedLength: 60 },
        [VENDOR]: { renderedLength: 40 },
      }),
    ).toBeCloseTo(0.6)
    expect(ownByteRatio({})).toBe(0)
    expect(ownByteRatio({ '\0only-virtual': { renderedLength: 5 } })).toBe(0)
  })
})

describe('chunkSeed:同版本同文件 = 同产物;换版本 / 换文件 = 变', () => {
  it('确定且有区分度', () => {
    expect(chunkSeed('1.0.0', 'a.js')).toBe(chunkSeed('1.0.0', 'a.js'))
    expect(chunkSeed('1.0.0', 'a.js')).not.toBe(chunkSeed('1.0.1', 'a.js'))
    expect(chunkSeed('1.0.0', 'a.js')).not.toBe(chunkSeed('1.0.0', 'b.js'))
  })
})

describe('obfuscateOwnChunks 插件', () => {
  it('generateBundle 是 order:post —— 必须排在 Vite 的 import-analysis 之后(见插件头注释)', () => {
    const hook = (obfuscateOwnChunks({ version: '1.0.0' }) as { generateBundle: { order?: string } }).generateBundle
    expect(hook.order).toBe('post')
  })

  it('自家为主的块被混淆且行为不变;第三方为主的块与非 chunk 原样不动', () => {
    const own = chunk('own.js', OWN_CODE, { [OWN]: { renderedLength: 90 }, [VENDOR]: { renderedLength: 10 } })
    const vendor = chunk('vendor.js', OWN_CODE, { [OWN]: { renderedLength: 10 }, [VENDOR]: { renderedLength: 90 } })
    const asset = { type: 'asset', fileName: 'a.css', source: 'body{}' }
    const bundle = { 'own.js': own, 'vendor.js': vendor, 'a.css': asset }
    const infos = runPlugin(obfuscateOwnChunks({ version: '1.0.0' }), bundle)

    expect(own.code).not.toBe(OWN_CODE)
    expect(own.code).not.toContain('uniqueLocalName') // 局部标识符真的被改名了(控:没混淆就会含它)
    expect(evalChunk(own.code)).toBe('x:55')
    expect(vendor.code).toBe(OWN_CODE)
    expect(asset.source).toBe('body{}')
    expect(infos.join('\n')).toMatch(/混淆 1 块、跳过 1 块/)
  })

  it(`恰好 ${OWN_CHUNK_THRESHOLD} 算自家(含边界)`, () => {
    const edge = chunk('edge.js', OWN_CODE, { [OWN]: { renderedLength: 50 }, [VENDOR]: { renderedLength: 50 } })
    runPlugin(obfuscateOwnChunks({ version: '1.0.0' }), { 'edge.js': edge })
    expect(edge.code).not.toBe(OWN_CODE)
  })

  it('同版本两次构建逐字节相同;换版本产物不同(每个版本一张新面孔)', () => {
    const build = (version: string) => {
      const c = chunk('own.js', OWN_CODE, { [OWN]: { renderedLength: 100 } })
      runPlugin(obfuscateOwnChunks({ version }), { 'own.js': c })
      return c.code
    }
    expect(build('1.0.0')).toBe(build('1.0.0'))
    expect(build('1.0.0')).not.toBe(build('1.0.1'))
  })

  it('混淆器对某块抛错 = 整个构建失败并点出文件名,❌ 不回退成不混淆', () => {
    const broken = chunk('broken.js', 'var = ;', { [OWN]: { renderedLength: 100 } })
    expect(() => runPlugin(obfuscateOwnChunks({ version: '1.0.0' }), { 'broken.js': broken })).toThrow(/broken\.js: 混淆失败/)
  })

  it('构建开了 sourcemap 就报错:混淆会让 map 作废,❌ 带着失效的 map 出包', () => {
    const withMap = { ...chunk('own.js', OWN_CODE, { [OWN]: { renderedLength: 100 } }), map: { version: 3 } }
    expect(() => runPlugin(obfuscateOwnChunks({ version: '1.0.0' }), { 'own.js': withMap })).toThrow(/sourcemap/)
  })

  it('保守档:不带 selfDefending / debugProtection(会冻结 DevTools、依赖 Function.toString)', () => {
    const c = chunk('own.js', OWN_CODE, { [OWN]: { renderedLength: 100 } })
    runPlugin(obfuscateOwnChunks({ version: '1.0.0' }), { 'own.js': c })
    expect(c.code).not.toMatch(/debugger|constructor\("debugger"\)/)
  })
})

// #6484:渲染层产物必须纯 ASCII。混淆器会把一部分字符串字面量留在原处(中文原样),所以混淆完要自己再转义。
describe('混淆后仍是纯 ASCII(#6484)', () => {
  const CJK = Array.from({ length: 60 }, (_, i) => `'文案${String.fromCharCode(0x4e00 + i)}${i}'`)
  const CODE = `globalThis.__r = [${CJK.join(',')}].join('|')`
  const expected = evalChunk(CODE)

  it('控:混淆器本身会把非 ASCII 带回来(所以插件必须自己转义)', () => {
    const raw = JavaScriptObfuscator.obfuscate(CODE, { ...OBFUSCATION_PROFILE, seed: 1 }).getObfuscatedCode()
    expect(raw).toMatch(/[\u0080-\uffff]/)
  })

  it('插件产物纯 ASCII,行为不变', () => {
    const c = chunk('own.js', CODE, { [OWN]: { renderedLength: 100 } })
    runPlugin(obfuscateOwnChunks({ version: '1.0.0' }), { 'own.js': c })
    expect(c.code).not.toMatch(/[\u0080-\uffff]/)
    expect(evalChunk(c.code)).toBe(expected)
  })

  it('插件确实接进了 vite.config.mts', () => {
    expect(fs.readFileSync(path.join(repoRoot, 'vite.config.mts'), 'utf8')).toContain('obfuscateOwnChunks({')
  })
})

// 真跑一次小型 Vite 构建:Vite 的 import-analysis 靠 `import("./x.js")` 的字面量说明符算出懒加载块的依赖表
// (JS + 它的 CSS)。混淆器会把说明符挪进字符串数组;先混淆、后分析,依赖表就被换成 `[]`,懒加载块的 CSS 不再注入。
// 合成块测不到这个交互,只有真构建能测。
describe('与 Vite 的预加载依赖表联用(真构建)', () => {
  const LAZY = Array.from({ length: 10 }, (_, i) => `lazy${i}`)

  async function bundleMain(withPlugin: boolean): Promise<string> {
    // macOS 的 tmp 是符号链接(/var -> /private/var),不 realpath 的话 Vite 算 HTML 入口的相对路径会对不上
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obf7195-')))
    try {
      for (const [i, n] of LAZY.entries()) {
        fs.writeFileSync(path.join(root, `${n}.css`), `.${n}{color:#${String(i).repeat(3)}}`)
        fs.writeFileSync(path.join(root, `${n}.js`), `import './${n}.css'\nexport default 'value-of-${n}:' + ${i}`)
      }
      fs.writeFileSync(
        path.join(root, 'main.js'),
        `window.__loaders = [${LAZY.map((n) => `() => import('./${n}.js')`).join(',')}]\n`,
      )
      fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="./main.js"></script>')
      const result = (await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: withPlugin ? [obfuscateOwnChunks({ version: '1.0.0' })] : [],
        build: { write: false },
      })) as { output: Array<{ type: string; fileName: string; code?: string; isEntry?: boolean }> }
      const main = result.output.find((o) => o.type === 'chunk' && o.isEntry)
      expect(main?.code, '没找到入口块').toBeTruthy()
      return main!.code!
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  const depsCalls = (code: string) => (code.match(/__vite__mapDeps\(\[\d/g) ?? []).length

  it('开了混淆,每个懒加载点仍带着自己的依赖表(含 CSS),且没有残留占位符', async () => {
    const plain = await bundleMain(false)
    const obfuscated = await bundleMain(true)
    expect(depsCalls(plain), '控:未混淆的构建里每个懒加载点都应带依赖表').toBe(LAZY.length)
    expect(obfuscated, '控:混淆确实发生了').not.toBe(plain)
    expect(obfuscated).not.toContain('__VITE_PRELOAD__')
    expect(depsCalls(obfuscated)).toBe(LAZY.length)
  }, 60_000)
})
