// @@@4865 — 会话页主进程图并入 electron-main 的同一次 rollup 后,留给 vite.config.mts 的几样构建
// 材料。此前它们住在一份独立的 esbuild 配方里,配方在 closeBundle 里另起一次
// esbuild 产出 dist-electron/taskpage/emdash-main-bridge.cjs,主进程运行时 createRequire 它。
// 那道墙只剩代价:
//  · rollup 的 closeBundle 是并行钩子,vite-plugin-electron 拉 Electron 也在 closeBundle ——
//    esbuild 还没写完桥,Electron 已起,首冷启必丢会话页(设计性赛跑);
//  · 桥不在 rollup 模块图里,watch 看不见,改会话页主进程代码不重建;
//  · 桥打坏了 vite build 照样绿,App 起来 require 失败才弹错(#4587 就是这一类)。
// 现在桥是 main.ts 的一个 import(见 loadEmdashBridge),三个 fork worker 是同一次 lib 构建的额外
// 入口;这里只剩 rollup 表达不了、或要跨文件共用的四样东西。
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Native addons + electron are provided at runtime, never inlined into the bundle:
//  - electron/better-sqlite3/node-pty — the established pattern.
//  - @parcel/watcher — native addon the session backend's fs-watch WORKER loads (fs-watch/impl/native-watch.ts).
//  - cpu-features — ssh2's OPTIONAL native accelerator (ssh2 try/catches its absence); rollup can't
//    bundle its prebuilt `.node`, so it must be external (degrades gracefully if unprovisioned).
// @@@2299 exported: verify-packaged-natives.mjs 的 app 锚点 probe 以本清单为单一来源逐个
// 真 require——新增 external 自动纳入生产路径探测(asar 已关,主进程从 Contents/Resources/app/
// 真实路径加载,依赖解析只走真实目录;probe 锚点必须与之同路,见 @@@kill-asar)。
export const EMDASH_EXTERNAL = [
  'electron',
  'better-sqlite3',
  'node-pty',
  '@parcel/watcher',
  'cpu-features',
]

// @@@sessionpage node18 shim: the session runtime (packages/runtime .../cell.ts, agent-ports,
// local-attachment-store) uses the bare Web Crypto global `crypto.randomUUID()`. The forked ACP/
// fs-watch/agent-config workers run under ELECTRON_RUN_AS_NODE = Electron 28's Node 18, where
// `globalThis.crypto` is NOT exposed as a global (unflagged only from Node 20). Without this the ACP
// session fails to start with "crypto is not defined" (codex/claude turns never run). Expose it.
// 作为 rollup 的 output.intro 注入每个产物(主进程 + worker + 共享 chunk),幂等;❌ banner(会排到 'use strict' 之前)。
export const SESSIONPAGE_NODE18_BANNER =
  "if(typeof globalThis.crypto==='undefined'){try{globalThis.crypto=require('node:crypto').webcrypto;}catch(_e){}}"

/**
 * electron-vite 的 `?asset` 后缀:把资源的**源码路径**当默认导出。只有 `@main/app/window.ts`
 * (经 appService 传递拉进来的 [APP]-bootstrap 模块)用了一处 —— 一个开发态 dock 图标,在子系统
 * 托管下永远不会渲染(createMainWindow 在 SKIP 名单里)。值是惰性的,所以返回真实源码路径即可,
 * ❌ 别让 vite 当图片资源处理(lib 构建下会被内联成 base64 或 emit 成带 hash 的文件,两种都是白干)。
 * @returns {import('vite').Plugin}
 */
export function sessionpageAssetPathPlugin() {
  const ASSET_RE = /\?asset$/
  return {
    name: 'gugu-sessionpage-asset-path',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!ASSET_RE.test(source)) return null
      const resolved = await this.resolve(source.replace(ASSET_RE, ''), importer, { skipSelf: true })
      if (!resolved) {
        this.error(`[gugu-sessionpage-asset-path] cannot resolve ${source}`)
      }
      return `\0gugu-asset-path:${resolved.id}`
    },
    load(id) {
      if (!id.startsWith('\0gugu-asset-path:')) return null
      return `export default ${JSON.stringify(id.slice('\0gugu-asset-path:'.length))}`
    },
  }
}

/**
 * formidable@1.x(asana → superagent 拉进会话页主进程图)每个 lib 文件第一行是
 * `if (global.GENTLY) require = GENTLY.hijack(require);` —— gently 是它测试期的 mock 钩子,生产从不设。
 * rollup 的 commonjs 插件把 `require` 改写成一个 import 绑定,对绑定重新赋值是硬错误
 * (「Illegal reassignment of import "commonjsRequire"」),整个 electron-main 构建红;esbuild 从前是
 * 默默放过的。这里在 commonjs 转换之前把这一行摘掉(enforce:'pre'),只对 formidable 的 lib 文件。
 * 实机踩到:MBP 冷启 `pnpm dev`,4003 modules transformed 后在 incoming_form.js:1:19 红(#4865)。
 * @returns {import('vite').Plugin}
 */
export function formidableGentlyStripPlugin() {
  // 只认包内路径 formidable/lib/*.js,不绑 pnpm 的 `formidable@1.x/node_modules/` 目录形状(hoist 方式一变就漏);
  // 版本不限:摘不摘只看那一行在不在(GENTLY_LINE_RE),新版没有这行就原样放过。
  const FILE_RE = /[\\/]node_modules[\\/]formidable[\\/]lib[\\/][^\\/]+\.js$/
  const GENTLY_LINE_RE = /^\s*if \(global\.GENTLY\) require = GENTLY\.hijack\(require\);\s*$/m
  return {
    name: 'gugu-formidable-gently-strip',
    enforce: 'pre',
    transform(code, id) {
      if (!FILE_RE.test(id) || !GENTLY_LINE_RE.test(code)) return null
      return { code: code.replace(GENTLY_LINE_RE, ''), map: null }
    },
  }
}

// @@@4587 打包成功 ≠ 产物能跑:bundler 遇到它解析不了的 require(动态的、或 UMD 工厂参数那种)
// 会**零报错**地原样保留。CJS 产物里任何幸存的、旁边并不存在目标文件的相对 require 都是一颗
// 运行时 ENOENT,所以在这里 fail loud —— 闸挂在真构建的 writeBundle 上,CI 的 build:app 每个 PR
// 都会踩到。rollup 自己拆出的共享 chunk 也是相对 require(`require('./chunk-xxxx.js')`),
// 它们的目标文件与产物同目录、真实存在,按「目标存在」放行,❌ 不按名字白名单。
// 允许清单:vendor 自己 try/catch 的可选原生探测,缺文件时按设计降级,不是缺陷。
const RESIDUAL_REQUIRE_RE = /\brequire\d*\(\s*["'](\.\.?\/[^"']*)["']\s*\)/g
// 允许清单 —— ⚠️ 这是 fail-loud 最容易被蚕食的地方,所以准入条件写死在这里:
// 一条相对 require 只有同时满足三条才允许进清单 ——
//  ① 它是 **vendor 包自己的**可选探测(不是咕咕自己源码里的 import);
//  ② vendor 在**自己的代码里** try/catch 了它,缺席时按 vendor 文档的设计降级(纯 JS 路径);
//  ③ 它探测的是**原生 addon**(bundler 本来就不能内联 .node,external 化也解决不了
//     "包内相对路径"这个形状)。
// 咕咕自己的残留、或 vendor 没兜底的 require,一律不进清单 —— 那是缺陷,修解析(alias 到
// ESM 构建/external),❌ 不是加白名单。加条目时把 ①②③ 的出处(文件+行)写进这条注释旁边。
const RESIDUAL_REQUIRE_ALLOWLIST = new Set([
  // ssh2 lib/protocol/crypto.js:29-30: `try { binding = require('./crypto/build/Release/
  // sshcrypto.node'); … } catch (err) {}` —— vendor 可选原生加速器,缺席即走纯 JS 实现(①②③ 全满足)。
  './crypto/build/Release/sshcrypto.node',
])

/**
 * 导出为函数,伴随单测直接喂合成 fixture(否则「闸没跑」与「闸跑了没发现」在测试里同绿);
 * 生产路径只经 sessionpageResidualRequireGate 在 writeBundle 里调用。
 * @param {string} outFile 产物绝对路径;相对 require 的目标按它所在目录判存在
 */
export function assertNoResidualRelativeRequires(outFile) {
  const text = readFileSync(outFile, 'utf8')
  const dir = dirname(outFile)
  const hits = new Set()
  for (const match of text.matchAll(RESIDUAL_REQUIRE_RE)) {
    const spec = match[1]
    if (RESIDUAL_REQUIRE_ALLOWLIST.has(spec)) continue
    if (existsSync(join(dir, spec))) continue
    hits.add(spec)
  }
  if (hits.size > 0) {
    throw new Error(
      `electron-main bundle ${basename(outFile)} contains unresolved relative require(...) of: ` +
        `${[...hits].join(', ')} — a dependency resolved to a build rollup cannot statically ` +
        'follow (UMD main? dynamic require?). Alias it to its ESM build or make it external; ' +
        'shipping this bundle is a guaranteed runtime ENOENT (#4587).',
    )
  }
}

/**
 * writeBundle 上对这次构建写出的每个 JS 产物跑一遍残留 require 闸。
 * @returns {import('vite').Plugin}
 */
export function sessionpageResidualRequireGate() {
  return {
    name: 'gugu-sessionpage-residual-require-gate',
    writeBundle(options, bundle) {
      const outDir = options.dir ?? (options.file ? dirname(options.file) : null)
      if (!outDir) this.error('[gugu-sessionpage-residual-require-gate] rollup output has neither dir nor file')
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        assertNoResidualRelativeRequires(join(outDir, fileName))
      }
    },
  }
}
