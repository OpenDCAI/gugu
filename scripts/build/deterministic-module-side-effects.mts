// @@@deterministic-mse (#7066) — 让每个模块的 moduleSideEffects 与「谁先把它解析出来」无关。
//
// rollup 只认一个模块**第一次**被解析时带来的 moduleSideEffects(ModuleLoader.fetchModule 只在新建 Module 时取它,
// 同一个 id 之后再被解析,带来的值被丢弃)。本仓同一个文件常有两条解析路径、给出不同的值:经 `@gugu/session-*`
// 别名过来时别名直接指向源码路径,vite 不查那个包的 package.json ⇒ true;从包内相对路径 import 过来,vite:resolve
// 按包的 package.json `sideEffects` 给值(session-core 是 false)。谁先解析完是异步竞态 ⇒ tree-shaking 的依赖顺序跟着翻
// ⇒ 同一个 sha 打两次,chunk 的 require 顺序与 hash 不一样(一次 build:app:ci 里有 188 个模块被解析出相互矛盾的值);
// 机制上还允许同一份源码这次留着、下次摇掉某个只为副作用的 import。
//
// 修法:transform 钩子(rollup 规定 transform 返回的 moduleSideEffects 覆盖 resolveId 给的值)对每个脚本文件按
// 「它所在包的 package.json(离它最近、带 name 的那个)的 sideEffects」重新给值;没有这个字段就是 rollup 的默认 true。
// ⚠️ 只认带 name 的:包里的 dist/esm/package.json 之类只写了 {"type":"module"} 的不是包清单(entities、@turf/*、tslib、
// react-i18next 都这样),认它就把包根上声明的 sideEffects:false 遮掉了 —— vite 自己对包内相对路径也是这么读错的,
// 这正是另一半竞态来源(裸 import 读包根、相对 import 读最近一层)。
// ❌ 例外名单、❌ 按包特判:某个包的声明本身不对(真有顶层副作用却写了 false),改那个包的 package.json。
// 只管真实脚本文件:`\0` 虚拟模块、带查询串的模块(?commonjs-proxy、?inline …)、CSS / JSON 等由各自的插件定。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createFilter, type Plugin } from 'vite'

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/

/** package.json 的 `sideEffects` 字段 → 「这个文件有没有副作用」。规则与 vite 的 packageData.hasSideEffects 相同。 */
export function sideEffectsRule(sideEffects: unknown, packageDir: string): (id: string) => boolean {
  if (typeof sideEffects === 'boolean') return () => sideEffects
  const patterns = typeof sideEffects === 'string' ? [sideEffects] : Array.isArray(sideEffects) ? sideEffects : null
  if (!patterns) return () => true
  if (patterns.length === 0) return () => false
  // webpack 的约定:不带 `/` 的模式匹配任意目录下的同名文件。
  const filter = createFilter(
    patterns.map((pattern: string) => (pattern.includes('/') ? pattern : `**/${pattern}`)),
    null,
    { resolve: packageDir },
  )
  return (id) => filter(id)
}

export function deterministicModuleSideEffects(): Plugin {
  const ruleByDir = new Map<string, (id: string) => boolean>()
  const ruleFor = (dir: string): ((id: string) => boolean) => {
    const cached = ruleByDir.get(dir)
    if (cached) return cached
    const path = join(dir, 'package.json')
    const manifest = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; sideEffects?: unknown }) : null
    const parent = dirname(dir)
    const rule =
      manifest && typeof manifest.name === 'string'
        ? sideEffectsRule(manifest.sideEffects, dir)
        : parent === dir
          ? () => true
          : ruleFor(parent)
    ruleByDir.set(dir, rule)
    return rule
  }
  return {
    name: 'gugu-deterministic-module-side-effects',
    transform: {
      order: 'post',
      handler(_code, id) {
        if (id.startsWith('\0') || id.includes('?') || !SCRIPT_FILE.test(id)) return null
        return { moduleSideEffects: ruleFor(dirname(id))(id) }
      },
    },
  }
}
