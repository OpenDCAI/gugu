// 咕咕 server 包里的 app/node_modules 该装什么、装完怎么验 —— build-gugu-server.mjs 用,单测也用。
//
// 背景(#6264):主进程图里有几个包**不进图**,运行时按路径现解析 —— 插件在 `acp.bridge` 里声明
// `{ kind: 'package', alias, entry }`,宿主从应用根解析 `<alias>/<entry>`(#6394,
// `core/agents/acp-bridge`:`createRequire(<app.getAppPath()>/package.json).resolve(…)`):
//   claude → `@agentclientprotocol/claude-agent-acp/dist/index.js`(别名装的是 @gugu-acp/claude-agent-acp)
//   pi     → `pi-acp/dist/index.js`(别名装的是 @gugu-acp/pi-acp)
//   zcode  → `zcode-acp-server/dist/cli.js`(别名装的是 @gugu-acp/zcode-acp)
//   codex  → 咕咕自建的 app-runtime 桥,随 dist-electron/runtime/ 走,不是 npm 包。
// 桌面包里它们是根 package.json 的生产依赖,随 electron-builder 铺进 app/node_modules。
// server 包的 app/node_modules 以前只装原生模块那四个,这几个一个都没有 —— 远端机器上建通用会话当场
// `Cannot find module …claude-agent-acp…`。
// ⇒ 与桌面同一条路:它们也进 app/node_modules;❌ 不另起「首次使用再下载」的第三条路。
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { join, sep } from 'node:path'

/** 主进程 external 的原生模块:按 Node ABI 装(桌面那份是 Electron ABI,不能混用)。 */
export const NATIVE_EXTERNAL_PACKAGES: readonly string[] = ['better-sqlite3', 'node-pty', '@parcel/watcher', 'ws']

/**
 * 插件 `acp.bridge` 里声明的 `kind: 'package'` 桥,宿主从应用根解析的那个说明符(`<alias>/<entry>`)。
 * 与插件声明逐条对齐由单测守(新接一家 package 桥时漏了这里会红);出包时下面的
 * assertRuntimeSpecifiersResolve 逐条从包的应用根解析,❌ 等到用户机器上才炸。
 */
export const ADAPTER_BRIDGE_ENTRIES: readonly string[] = [
  '@agentclientprotocol/claude-agent-acp/dist/index.js',
  'pi-acp/dist/index.js',
  'zcode-acp-server/dist/cli.js',
]

/** 这些桥所在的包 —— 与桌面同版本(取仓库装好的那份)。 */
export const ADAPTER_PACKAGES: readonly string[] = ADAPTER_BRIDGE_ENTRIES.map((entry) => packageNameOf(entry))

/** Playwright runs installed Apps' background HTML on the server (server/extension-background.ts). */
export const APP_PAGE_PACKAGES: readonly string[] = ['@playwright/mcp']

/**
 * 宿主同样从应用根取、但不是桥的两个包,按 CLI 版本配 Claude 桥(#6394)靠它们,server 包以前都不带:
 *  - `@gugu-acp/compat`:随包的配对表(acp-bridge/claude-bridge-deps.ts 读它的 package.json)。读不到就一律用随包的桥、
 *    也不联网查表 —— 配桥在 server 上从没生效过;
 *  - `npm`:随 App 交付的 npm(engine-downloader.ts 的 resolveBundledNpmInvocation 按路径跑
 *    `node_modules/npm/bin/npm-cli.js`),联网查最新的表、下载配上的桥都用它。缺了,表读得到也只能停在随包那一版。
 *    它的 `exports` 不导出 bin/,闸里按 package.json 认包在。
 */
export const APP_ROOT_PACKAGE_FILES: readonly string[] = ['@gugu-acp/compat/package.json', 'npm/package.json']

export const RUNTIME_PACKAGES: readonly string[] = [
  ...NATIVE_EXTERNAL_PACKAGES,
  ...ADAPTER_PACKAGES,
  ...APP_ROOT_PACKAGE_FILES.map((file) => packageNameOf(file)),
  ...APP_PAGE_PACKAGES,
]

/**
 * 适配器依赖树里的平台原生二进制包:与桌面包同一组排除(electron-builder.cjs 的 @@@thin-claude-native /
 * @@@thin-codex-native)。它们各 200MB+,而运行时从不执行 —— 插件总是把宿主装好的 claude / codex
 * 经 CLAUDE_CODE_EXECUTABLE / CODEX_PATH 递给适配器;宿主没装时由 ensure-agent-installed 先装上。
 */
export const EXCLUDED_NATIVE_PACKAGE_PREFIXES: readonly string[] = ['@anthropic-ai/claude-agent-sdk-', '@openai/codex-']

/** `@scope/name/sub/path` → `@scope/name`;`name/sub` → `name`。 */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const builtins = new Set(builtinModules)
// rollup 把插件里的 `createRequire(import.meta.url)` 改名成 `_require` / `_require$1` / `_require$2` …
const RESOLVE_CALL = /\b_?require(?:\$\d+)?\.resolve\(\s*(["'])([^"'\s]+)\1\s*\)/g

/** 一段构建产物里「按路径现解析」的裸包说明符(不含相对路径、绝对路径与 Node 内置模块)。 */
export function runtimeResolvedSpecifiers(source: string): Set<string> {
  const found = new Set<string>()
  for (const match of source.matchAll(RESOLVE_CALL)) {
    const specifier = match[2]
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue
    if (builtins.has(packageNameOf(specifier))) continue
    found.add(specifier)
  }
  return found
}

/**
 * 两类运行时现解析的模块都必须解析到**包自己的** app/node_modules 里:
 *  - 声明的 package 桥(ADAPTER_BRIDGE_ENTRIES)与配对表(APP_ROOT_PACKAGE_FILES),从应用根解析 —— 与宿主同一种解析法;
 *  - dist-electron 里其余字面量的 `.resolve("<包>/…")`,从所在 chunk 解析。
 * ⚠️ 只看 chunk 里的字面量不够:#6394 起桥的说明符是宿主按声明拼出来的,chunk 里不再有字面量,
 *    只扫 chunk 的闸会一个都查不到、静默放行。
 * ⚠️ 只看「能不能解析」也不够:构建时 stage 在仓库目录下面,Node 会一路往上找到仓库根的 node_modules,
 *    于是构建机上一切正常、装到用户机器上照样找不到。所以还要求解析结果落在 appDir/node_modules 内。
 */
export function assertRuntimeSpecifiersResolve(appDir: string): string[] {
  const distDir = join(appDir, 'dist-electron')
  const ownModules = realpathSync(join(appDir, 'node_modules')) + sep
  const failures: string[] = []
  const checked: string[] = []
  const check = (require: NodeJS.Require, specifier: string, where: string) => {
    let resolved: string
    try {
      resolved = realpathSync(require.resolve(specifier))
    } catch {
      failures.push(`${specifier}(${where}):包里没有`)
      return
    }
    if (!resolved.startsWith(ownModules)) {
      failures.push(`${specifier}(${where}):解析到包外 ${resolved}`)
      return
    }
    checked.push(specifier)
  }
  const fromAppRoot = createRequire(join(appDir, 'package.json'))
  for (const specifier of ADAPTER_BRIDGE_ENTRIES) check(fromAppRoot, specifier, 'acp.bridge')
  for (const specifier of APP_ROOT_PACKAGE_FILES) check(fromAppRoot, specifier, 'app root')
  for (const file of readdirSync(distDir)) {
    if (!/\.(c|m)?js$/.test(file)) continue
    const path = join(distDir, file)
    const specifiers = runtimeResolvedSpecifiers(readFileSync(path, 'utf8'))
    if (specifiers.size === 0) continue
    const require = createRequire(path)
    for (const specifier of specifiers) check(require, specifier, file)
  }
  if (failures.length > 0) {
    throw new Error(`咕咕 server 包缺运行时要解析的模块:\n  ${failures.join('\n  ')}`)
  }
  return [...new Set(checked)].sort()
}

/**
 * pnpm-workspace.yaml 的 `patchedDependencies:` 段 → [{ name, version, patch }]。
 * 桌面包的依赖由 pnpm 装、补丁自动打上;server 包用 npm 装,补丁得自己打,否则同一个版本号下
 * 桌面和 server 跑的是两份不同的适配器(claude 的 fork 会话、pi 的启动诊断都靠补丁)。
 */
export interface PatchedDependency {
  name: string
  version: string
  patch: string
}

export function parsePatchedDependencies(yamlText: string): PatchedDependency[] {
  const lines = yamlText.split('\n')
  const start = lines.findIndex((line) => /^patchedDependencies:\s*$/.test(line))
  if (start < 0) return []
  const entries: PatchedDependency[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const match = line.match(/^\s+['"]?(.+?)@([^@'"\s]+)['"]?\s*:\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/)
    if (match) entries.push({ name: match[1], version: match[2], patch: match[3] })
  }
  return entries
}

/**
 * server 包 package.json 里这个依赖写什么:根 package.json 里是 `npm:` 别名(#6449 把 claude 适配器换成
 * `npm:@gugu-acp/claude-agent-acp@…`)就原样用别名 —— 只写装上的版本号,npm 会去**原包名**下找那个版本(ETARGET)。
 * 其余照旧取仓库装好的那份版本号。
 */
export function externalDependencySpec(
  name: string,
  rootDependencies: Record<string, string> | undefined,
  installedVersion: string,
): string {
  const declared = rootDependencies?.[name]
  return typeof declared === 'string' && declared.startsWith('npm:') ? declared : installedVersion
}

/** 包目录名是否属于要剔掉的平台原生二进制包。 */
export function isExcludedNativePackage(name: string): boolean {
  return EXCLUDED_NATIVE_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix))
}
