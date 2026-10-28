import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron, { type ElectronOptions } from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { fileURLToPath } from 'node:url'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import {
  rendererChunkCycleGuard,
  rendererAsciiOutput,
  entryAwareRendererManualChunk,
  guguEntryReachabilityPlugin,
  type EntryReachability,
} from './scripts/renderer-chunking.mjs'
import { obfuscateOwnChunks, parseObfuscateFlag } from './scripts/obfuscate-own-chunks.mjs'
import { monacoWorkerSingleBundlePlugin } from './scripts/monaco-worker-bundle.mjs'
import { deterministicModuleSideEffects } from './scripts/deterministic-module-side-effects.mjs'
import { announceActiveDb, applyActiveDbEnv } from './scripts/build-env-preflight.mjs'
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin'
import solid from 'vite-plugin-solid'
import { emdashAliasEntries } from './apps/desktop/electron/sessionpage/emdash-aliases.mjs'
import {
  rendererHtmlEntries,
  desktopMainEntries,
  webHostEntries,
  desktopPreloadEntry,
  extensionPreloadEntry,
} from './scripts/product-build-entries.mjs'
import {
  EMDASH_EXTERNAL,
  SESSIONPAGE_NODE18_BANNER,
  formidableGentlyStripPlugin,
  sessionpageAssetPathPlugin,
  sessionpageResidualRequireGate,
} from './apps/desktop/electron/sessionpage/sessionpage-main-build.mjs'
import { LAZY_LANG_MODULES } from './packages/session-chat-ui/src/core/highlight/lazy-langs'
import { appPaletteCss } from './apps/desktop/src/session/app-runtime/ui/app-palette.mjs'

const require = createRequire(import.meta.url)

// @@@task-fusion (#2802) — Solid 与 React 在同一次 rollup 里共存的分界线。只有这一个包是 Solid,
// 两个 JSX 插件都按它做包含/排除,写成常量免得两处漂移。
const SESSION_CHAT_UI_GLOB = '**/packages/session-chat-ui/**'

// @@@app-version - inject root package.json version as a renderer-wide build-time constant so the
// About page can show vX.Y.Z on every target. Electron also has app.getVersion() over IPC, but the
// web build (GUGU_TARGET=web, used by e2e/QA) has no such bridge — this define is the single source
// that works everywhere.
// GUGU_BUILD_VERSION (#4703) is the dogfood build's stamped prerelease version — the same variable
// electron-builder.cjs bakes into the app bundle — so About shows exactly what the dmg name says
// without anyone editing package.json in the checkout.
const appVersion =
  process.env.GUGU_BUILD_VERSION ??
  (JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8')).version as string)
const buildTag = process.env.GUGU_BUILD_TAG ?? ''
// @@@obfuscate-own-chunks (#7195) — 默认关。只作用于本次渲染层 rollup 构建,不碰主进程 / preload / worker 那些单独的构建。
const obfuscateRenderer = parseObfuscateFlag(process.env.GUGU_OBFUSCATE_RENDERER)

// @@@5813 更新说明的取件地址 —— 官网帮助中心里这个端的那一份。内容的家在官网,应用只是读者。
//
// ⚠️ 这个常量**只给 web / 手机壳用**:它们的 origin 是普通 https,站点对这一支发了
// Access-Control-Allow-Origin(nginx snippet gugu-landing-body.conf),渲染层自己取得到。
// Electron 那条路一律走主进程,按 process.platform 现算地址 —— 见 updateFeeds.ts。
// 所以这里烘的是 android:web 构建就是手机端那份产物。
// 单点仍在 apps/desktop/electron/updateFeeds.json,与 electron 侧读同一个值,改域名不会漂。
const changelogUrl = new URL(
  'help/release-notes/android/changelog.json',
  JSON.parse(
    readFileSync(fileURLToPath(new URL('./apps/desktop/electron/updateFeeds.json', import.meta.url)), 'utf-8'),
  ).site as string,
).toString()
const buildTestNotes = process.env.GUGU_TEST_NOTES ?? ''

// @@@env-registry (#2782) - 必须在下面读 process.env 之前跑：GUGU_DB_TARGET 选中的那套整体写进
// process.env，于是 renderer inline（vite loadEnv 末尾的 shell 覆盖循环）与烘焙 define（本文件
// 顶层直读 process.env）拿到的是同一组值 —— 两条通路由构造同源，而不是事后比对才发现分叉。
// 这也让裸 `vite` 起的 `pnpm dev` 认得登记处，无需任何 wrapper。
applyActiveDbEnv(process.cwd(), process.env)
// @@@db-announce `pnpm dev` 是裸 vite，此前整条路上没有任何一层说过「这次连的是哪个库」。
// product spec 要求未声明时也必须把库显示出来，不允许悄悄连上。
announceActiveDb(process.cwd(), process.env)

const guguTarget = process.env.GUGU_TARGET ?? 'electron'
const isElectronTarget = guguTarget === 'electron'
const viteOwnsElectronProcess =
  process.env.GUGU_VITE_NO_ELECTRON !== '1'
// @@@gugu-tier - build-time deployment tier; `pnpm build:beta` sets GUGU_TIER=beta. Inlined into the
// main and renderer bundles as __GUGU_TIER__: the home and external link scheme share this tier.
const guguTier = process.env.GUGU_TIER ?? 'production'
const guguBuildDistribution = process.env.GUGU_BUILD_DISTRIBUTION ?? 'local'
if (guguBuildDistribution !== 'local' && guguBuildDistribution !== 'published') {
  throw new Error(
    `Unknown GUGU_BUILD_DISTRIBUTION '${guguBuildDistribution}' — expected local or published`,
  )
}
const bakedSupabaseUrl = process.env.GUGU_SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
const bakedSupabaseAnonKey = process.env.GUGU_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
// @@@shipped-supabase-config - config.ts only falls back to these build-time defines in shipped
// bundles. Source/dev builds with no env still fail loudly, but packaged desktop/CLI can cold-start.
const bakedSupabaseDefine = {
  __GUGU_CLOUD_COMPUTER_ENABLED__: JSON.stringify(process.env.GUGU_CLOUD_COMPUTER_ENABLED ?? ''),
  __GUGU_PLATFORM_MODELS_ENABLED__: JSON.stringify(process.env.GUGU_PLATFORM_MODELS_ENABLED ?? ''),
  ...(bakedSupabaseUrl ? { __GUGU_DEFAULT_SUPABASE_URL__: JSON.stringify(bakedSupabaseUrl) } : {}),
  ...(bakedSupabaseAnonKey ? { __GUGU_DEFAULT_SUPABASE_ANON_KEY__: JSON.stringify(bakedSupabaseAnonKey) } : {}),
  // 远程隧道的中转(一库一中转,packages/core/src/cloud/remoteTunnel.ts):与库地址一起按目标烘进去。
  ...(process.env.GUGU_RELAY_URL ? { __GUGU_RELAY_URL__: JSON.stringify(process.env.GUGU_RELAY_URL) } : {}),
}
const workspaceAliases = {
  '@gugu/core': fileURLToPath(new URL('./packages/core/src', import.meta.url)),
  '@': fileURLToPath(new URL('./apps/desktop/src', import.meta.url)),
}

// @@@task-fusion (#2802) — 会话页与咕咕同一次 rollup 出产物。
// 别名表 `emdash-aliases.mjs` 是全仓**唯一**一份「子路径 → 源码文件」映射:主进程的 esbuild、
// 这里的 renderer 构建、vitest、tsc 全都读它,于是四条路解析到完全相同的文件,不可能漂。
// 顺序有意义(@rollup/plugin-alias 语义:精确子路径必须排在基路径之前),故用数组而非对象。
const sessionAliases = emdashAliasEntries.map(([find, replacement]) => ({ find, replacement }))
const reachability: EntryReachability = { guguReachable: null }
const isGuguEntry = (id: string) => id.endsWith('apps/desktop/index.html')

// @@@4865 三个 electron 入口(主进程+会话页主进程图+三个 worker / preload / extension-bridge preload)。
// 抽成导出常量,两处消费:
//  · dev(`vite`):下方按常规挂 vite-plugin-electron,在 vite 进程内 watch 构建 + 拉起 Electron;
//  · build(`build:app` → scripts/build-electron-app.mts):渲染层 rollup(~1 万模块,本就贴着 V8 默认堆顶)
//    与主进程 rollup(并入会话页图后 4000 模块)若共用一个 node 进程,渲染层的图还在堆上时主进程构建就
//    OOM(CI 实测 4GB 顶爆)。脚本在子进程跑渲染层(GUGU_ELECTRON_BUILD=separate → 这里不挂插件),
//    同时在自己进程里用同一份 entries 调 vite-plugin-electron 导出的 build() —— 两条路吃同一份配置,不会漂。
const separateElectronBuild = process.env.GUGU_ELECTRON_BUILD === 'separate'
// @@@task-web-host — 会话页主进程图的 vite 配置,Electron 主进程入口与无头宿主入口共用一份
// (两条路只差入口文件与启动方式,构建规则必须一字不差)。
const sessionMainVite: ElectronOptions['vite'] = {
  resolve: {
    // The Electron main bundle now reaches session-page delivery modules directly. Use the
    // same task alias table as the renderer path so transitive @main imports resolve.
    alias: [
      ...sessionAliases,
      ...Object.entries(workspaceAliases).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  define: {
    ...bakedSupabaseDefine,
    __GUGU_TIER__: JSON.stringify(guguTier),
    __GUGU_BUILD_DISTRIBUTION__: JSON.stringify(guguBuildDistribution),
  },
  // 与渲染层同一条(@@@renderer-ascii-output,#6484):V8 把每个模块的源码常驻堆里,一个非 Latin-1 字符
  // 就让整份按双字节存。主进程与几个 helper 各自常驻一份(10-27 Linux 2 实测主进程堆 125 MB 里源码串 38.6 MB)。
  // 不压缩,只去掉注释、非 ASCII 转义;esbuild 不经手的依赖代码由 rendererAsciiOutput() 收尾。
  esbuild: { charset: 'ascii', legalComments: 'none' },
  build: {
    // ❌ 不压缩主进程图。并图前这张图由 esbuild 单独打、从不压缩;并图后 vite lib 构建默认用 esbuild 压缩,
    // 而 esbuild 压缩会把 xterm(TUI 屏幕解析)里 TypeScript 枚举 `var V;(fn)(V||(V={}))` 的声明丢掉、
    // 只剩 `void 0||(t={})` —— 严格模式下终端一发 DECRQM 就 ReferenceError。verify-emdash-bundle-no-undef
    // 守卫在 build:app 里抓到(mac1 实测:minify=false 即过)。主进程在 Node 里跑,压缩只省磁盘、还毁日志栈。
    minify: false,
    rollupOptions: {
      // 原生 addon(better-sqlite3 / node-pty / @parcel/watcher / cpu-features)运行时提供,
      // 绝不内联;清单是 verify-packaged-natives 探针的单一来源。
      // #7191 浏览器工具(@playwright/mcp + 它锁定的 playwright-core)运行时从 app/node_modules 加载:它们靠 __dirname
      // 找自己的文件,打进主进程包会断;根 dependencies 声明两者,electron-builder 原样带进包。
      external: ['ws', '@playwright/mcp', 'playwright-core', ...EMDASH_EXTERNAL],
      output: {
        // Electron 28 = Node 18:`globalThis.crypto` 不是全局,会话页 runtime 裸用
        // crypto.randomUUID()。注入到每个产物(主进程、worker、共享 chunk),幂等。
        // 用 intro ❌ banner:banner 排在 rollup 写的 `'use strict';` **前面**,把指令序言变成
        // 一条普通字符串语句,整个 chunk 静默退出严格模式(review 抓到);intro 在指令之后。
        intro: SESSIONPAGE_NODE18_BANNER,
      },
    },
  },
  plugins: [
    // @@@deterministic-mse (#7066) — 渲染层、主进程、两个 preload 共用这一个插件:同一个 sha 打几次产物逐字节相同。
    deterministicModuleSideEffects(),
    {
      // @@@4865 清掉旧布局的产物目录:dist-electron/taskpage/ 是 gitignore 的,CI 槽位与开发
      // 检出都会留着上一版的 emdash-main-bridge.cjs;electron-builder 按 dist-electron/**
      // 通配打包,不清就把一份没人 require 的旧桥装进每个包。
      name: 'gugu-taskpage-legacy-artifact-sweep',
      buildStart() {
        rmSync(fileURLToPath(new URL('./apps/desktop/dist-electron/taskpage/', import.meta.url)), {
          recursive: true,
          force: true,
        })
      },
    },
    sessionpageAssetPathPlugin(),
    formidableGentlyStripPlugin(),
    {
      // The App runtime (`/_gugu/<ver>/…`, served on every App origin by extension-protocol.ts).
      // Page-side code, so its own esbuild pass: browser target, minified (every App page
      // parses it). `gugu.js` is the classic script the host puts first in an App document;
      // files.js and codemirror.js are ES modules it imports on first use, split so they
      // share ONE copy of Yjs — a second copy breaks Yjs' own type checks, and the editor
      // binding must speak to the same Y.Text the file object holds.
      name: 'gugu-bundle-app-runtime',
      async closeBundle() {
        await buildAppRuntime(fileURLToPath(new URL(`./apps/desktop/dist-electron/app-runtime/${appRuntimeVersion()}/`, import.meta.url)))
      },
    },
    // @@@4587 打包成功 ≠ 产物能跑:产物里残留、旁边又不存在目标的相对 require = 运行时 ENOENT。
    sessionpageResidualRequireGate(),
    {
      // Local harnesses must not install anything on first use. These bundles contain protocol
      // glue only: Codex app-server -> ACP, plus claude-agent-acp without optional native Claude.
      name: 'gugu-bundle-local-harness-adapters',
      async closeBundle() {
        const esbuild = await import('esbuild')
        const outDir = fileURLToPath(
          new URL('./apps/desktop/dist-electron/runtime/', import.meta.url),
        )
        mkdirSync(outDir, { recursive: true })
        await esbuild.build({
          entryPoints: [fileURLToPath(new URL(
            './apps/desktop/electron/runtime/codex-app-server-acp.mjs',
            import.meta.url,
          ))],
          outfile: resolve(outDir, 'codex-app-server-acp.mjs'),
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node18',
        })
        // Hermes over `hermes serve` (Hermes Desktop's backend): ACP to Gugu, the serve gateway's JSON-RPC to the
        // user's own hermes. WebSocket is the runtime's global (Electron's Node), so nothing extra is bundled for it.
        await esbuild.build({
          entryPoints: [fileURLToPath(new URL(
            './apps/desktop/electron/runtime/hermes-serve-acp.ts',
            import.meta.url,
          ))],
          outfile: resolve(outDir, 'hermes-serve-acp.mjs'),
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node18',
          // `yaml` resolves to its CommonJS build under the node condition and calls `require('process')`;
          // an ESM bundle has no `require`, so the bridge died before its first line (mac1 A/B 10-04).
          banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
        })
        // #6335 咕咕 MCP 的 stdio ⇄ HTTP 中继:Antigravity 终端腿的 `agy` 按托管 mcp_config.json 起它
        // (理由见文件抬头)。SDK 一并打进单文件 —— 它由 agy 在用户机器上起,旁边没有 node_modules。
        await esbuild.build({
          entryPoints: [fileURLToPath(new URL(
            './apps/desktop/electron/runtime/gugu-mcp-stdio-relay.mjs',
            import.meta.url,
          ))],
          outfile: resolve(outDir, 'gugu-mcp-stdio-relay.mjs'),
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node18',
        })
        await esbuild.build({
          entryPoints: [require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')],
          outfile: resolve(outDir, 'claude-agent-acp.mjs'),
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node18',
          external: [
            '@anthropic-ai/claude-agent-sdk-darwin-arm64',
            '@anthropic-ai/claude-agent-sdk-darwin-x64',
            '@anthropic-ai/claude-agent-sdk-linux-arm64',
            '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
            '@anthropic-ai/claude-agent-sdk-linux-x64',
            '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
            '@anthropic-ai/claude-agent-sdk-win32-arm64',
            '@anthropic-ai/claude-agent-sdk-win32-x64',
          ],
        })
      },
    },
    rendererAsciiOutput(),
  ],
}

// @@@task-web-host — 网页版的宿主:pnpm dev:web 时随 vite 一起构建并拉起(热重启),用 Electron 二进制当
// node 跑(ELECTRON_RUN_AS_NODE=1)。owner 原则「网页版起得来就得有会话页」:默认开;只有
// GUGU_TASK_HOST=0 才不起(测试基建的显式退路,不是默认)。token 每个 vite 进程生成一次,经 define
// 交给渲染层(只在 dev serve;web 生产构建不含 token,由宿主启动日志给出)。
const sessionHostEnabled = process.env.GUGU_TASK_HOST !== '0'
const sessionHostDevToken =
  process.env.GUGU_TASK_HOST_TOKEN ?? randomBytes(18).toString('base64url')
// 端口与数据目录默认按 worktree 路径哈希(与 playwright.config.ts #1897 的 e2e 端口同一套办法):
// fleet 机器上几十个 worktree / 16 个 CI 槽并行起 dev:web,固定端口 + 共享 ~/.gugu-task-host
// 会互相撞死(第二个宿主绑不上口 → 退出 → vite 跟着退)。显式 env 仍然优先。
const sessionHostWorktreeHash = (() => {
  let hash = 0
  for (const ch of process.cwd()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash
})()
const sessionHostDevPort = Number(process.env.GUGU_TASK_HOST_PORT || 40000 + (sessionHostWorktreeHash % 5000))
const sessionHostDevBind = process.env.GUGU_TASK_HOST_BIND ?? '127.0.0.1'
const sessionHostDevUserData =
  process.env.GUGU_TASK_HOST_USER_DATA ??
  resolve(homedir(), '.gugu-task-host', `dev-${basename(process.cwd())}-${sessionHostWorktreeHash.toString(16).slice(0, 6)}`)
export const sessionHostBuildEntries: ElectronOptions[] = [
  {
    entry: webHostEntries,
    vite: sessionMainVite,
    onstart(options) {
      if (!sessionHostEnabled) {
        console.log('[task-host] GUGU_TASK_HOST=0 — web app will run WITHOUT a task page host')
        return
      }
      void options.startup(
        [fileURLToPath(new URL('./apps/desktop/dist-electron/task-host.js', import.meta.url))],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            GUGU_TASK_HOST_TOKEN: sessionHostDevToken,
            GUGU_TASK_HOST_PORT: String(sessionHostDevPort),
            GUGU_TASK_HOST_BIND: sessionHostDevBind,
            GUGU_TASK_HOST_USER_DATA: sessionHostDevUserData,
          },
        },
      )
    },
  },
]

export const electronBuildEntries: ElectronOptions[] = [
  {
    // @@@4865 — 主进程 + 会话页主进程图 + 三个 fork worker 是**同一次** lib 构建的四个入口:
    //  · main             ← electron/main.ts(咕咕宿主)
    //  · emdash-main-bridge ← 会话页主进程图的唯一 re-export 入口;main.ts 在 whenReady 里
    //                       动态 import 它,rollup 据此切成独立 chunk,名字钉死给 provenance /
    //                       verify-packaged-natives / e2e 认
    //  · <worker>.js       ← child_process.fork 的目标必须是磁盘上的独立文件,所以是入口;
    //                       文件名 = worker-manifest.ts 的 desktopWorkers[].file(减 .js),
    //                       desktopWorkerPath 按 import.meta.url 同目录解析,故全部平铺在
    //                       dist-electron/(❌ 子目录:共享 chunk 落哪层由 rollup 定,子目录会漂)
    // 从前会话页主进程是 closeBundle 里另起 esbuild 的外部产物、运行时 createRequire ——
    // 那是 #2274 接 vendor 时的过渡墙,#2804 融合后只剩代价(首冷启赛跑丢桥、watch 看不见、
    // 构建绿运行炸),见 sessionpage-main-build.mjs 头注。
    entry: desktopMainEntries,
    vite: sessionMainVite,
    onstart(options) {
      // Playwright/external drivers own the whole Electron lifecycle; Vite only builds both entries.
      // Starting another app or reloading the controlled renderer would create a second lifecycle.
      if (!viteOwnsElectronProcess) return
      // @@@root-headless - root/CI/headless 下 Electron 需 --no-sandbox（opt-in via GUGU_NO_SANDBOX，
      // 生产/普通用户不设即原行为）。配合 GUGU_DEBUG_PORT 走 Playwright CDP 驱动真实 UI。
      // --disable-gpu 同属 headless 场景:Xvfb 下没有可用 GPU,Chromium 尝试拉起 GPU 进程
      // 失败 5 次后直接 FATAL「GPU process isn't usable. Goodbye.」整个 app 退出。
      options.startup([
        '.',
        ...(process.env.GUGU_NO_SANDBOX
          ? ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer']
          : []),
      ])
    },
  },
  {
    entry: desktopPreloadEntry,
    vite: {
      resolve: {
        alias: workspaceAliases,
      },
      plugins: [deterministicModuleSideEffects()],
    },
    onstart(options) {
      if (!viteOwnsElectronProcess) return
      options.reload()
    },
  },
  {
    // The extension bridge, built separately from the app's own
    // preload on purpose: `electron/preload.ts` exposes the host API
    // an extension must never see. Two files is what keeps「凡经安装
    // 通路进来的一律隔离」from depending on anyone remembering to
    // branch inside one. Refs #2374.
    entry: extensionPreloadEntry,
    vite: {
      resolve: {
        alias: workspaceAliases,
      },
      plugins: [deterministicModuleSideEffects()],
    },
    onstart(options) {
      if (!viteOwnsElectronProcess) return
      options.reload()
    },
  },
]

/** The version directory `/_gugu/<ver>/` maps to (app-runtime-protocol.ts reads the same file). */
function appRuntimeVersion(): string {
  return (
    JSON.parse(
      readFileSync(fileURLToPath(new URL('./apps/desktop/src/session/shared/extensions/app-runtime-version.json', import.meta.url)), 'utf-8'),
    ) as { version: string }
  ).version
}

/**
 * The App runtime's bytes into `outDir`: `gugu.js`, the classic script the host puts first in an
 * App document, and files.js / codemirror.js / markdown.js, ES modules it imports on first use — split so they
 * share ONE copy of Yjs (a second copy breaks Yjs' own type checks, and the editor binding must
 * speak to the same Y.Text the file object holds) — and glue.js, which an App's own app.js imports.
 * Page-side code: browser target, minified.
 */
async function buildAppRuntime(outDir: string): Promise<void> {
  const esbuild = await import('esbuild')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const src = (file: string) => fileURLToPath(new URL(`./apps/desktop/src/session/app-runtime/${file}`, import.meta.url))
  const common = {
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    // Served by the host, never bundled: the entry imports the modules by URL.
    external: ['/_gugu/*'] as string[],
    logLevel: 'warning',
  } as const
  await esbuild.build({ ...common, entryPoints: [src('gugu-entry.ts')], outfile: resolve(outDir, 'gugu.js'), format: 'iife' })
  // The host's look, which gugu.js writes into every App page right after itself (app-runtime/ui): ui.js, and ui.css
  // = the palette app-palette.mjs resolves from this build's tokens.css, then ui/ui.css with its fonts beside it.
  await esbuild.build({ ...common, entryPoints: [src('ui/ui-entry.ts')], outfile: resolve(outDir, 'ui.js'), format: 'iife' })
  await esbuild.build({
    ...common,
    entryPoints: [src('ui/ui.css')],
    outfile: resolve(outDir, 'ui.css'),
    loader: { '.woff2': 'file' },
    assetNames: 'fonts/[name]-[hash]',
  })
  const tokens = readFileSync(fileURLToPath(new URL('./apps/desktop/src/styles/tokens.css', import.meta.url)), 'utf-8')
  const look = readFileSync(resolve(outDir, 'ui.css'), 'utf-8')
  const charset = /^@charset "[^"]*";/.exec(look)?.[0] ?? ''
  writeFileSync(resolve(outDir, 'ui.css'), charset + appPaletteCss(tokens) + look.slice(charset.length))
  cpSync(src('ui/gallery.html'), resolve(outDir, 'gallery.html'))
  // gugu.markdown()'s look, linked by markdown.js on first use: KaTeX's sheet and the host's `.gg-md`, in `@layer gugu`.
  // KaTeX names each of its 20 faces three times (woff2, woff, ttf); every engine an App page runs in (Electron, Android
  // WebView 113+) takes woff2, so the sheet is read with the other two cut and only woff2 files are emitted.
  const katexWoff2Only: import('esbuild').Plugin = {
    name: 'gugu-katex-woff2-only',
    setup(build) {
      build.onLoad({ filter: /[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/ }, (args) => {
        const sheet = readFileSync(args.path, 'utf-8')
        const cut = sheet.replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '')
        // Loud when KaTeX changes how it lists its fonts: the cut would silently become a no-op.
        if (cut === sheet || /\.(?:woff|ttf)\)/.test(cut)) throw new Error('gugu-katex-woff2-only: KaTeX no longer lists its fonts as woff2, woff, ttf')
        return { contents: cut, loader: 'css', resolveDir: dirname(args.path) }
      })
    },
  }
  await esbuild.build({
    ...common,
    entryPoints: [src('markdown.css')],
    outfile: resolve(outDir, 'markdown.css'),
    loader: { '.woff2': 'file' },
    assetNames: 'fonts/[name]-[hash]',
    plugins: [katexWoff2Only],
  })
  await esbuild.build({
    ...common,
    entryPoints: { files: src('files-entry.ts'), codemirror: src('codemirror-entry.ts'), markdown: src('markdown-entry.ts'), glue: src('glue-entry.ts') },
    outdir: outDir,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunk-[hash]',
  })
  // An App's MCP program gets the same `gugu` (F16): one Node module, started with `node --import` before the
  // App's own code — its own copy of Yjs, in its own process.
  await esbuild.build({
    ...common,
    platform: 'node',
    target: 'node22',
    external: [],
    entryPoints: [src('program-entry.ts')],
    outfile: resolve(outDir, 'gugu-program.mjs'),
    format: 'esm',
  })
  // F77 An App's tools module served as its MCP program: MCP itself, once here, never copied into Apps.
  await esbuild.build({
    ...common,
    platform: 'node',
    target: 'node22',
    external: [],
    entryPoints: [src('tools-entry.ts')],
    outfile: resolve(outDir, 'gugu-tools.mjs'),
    format: 'esm',
  })
}

/**
 * `injectAppRuntime` (app-runtime-protocol.ts), which this config cannot import (its loader does
 * not take that module): the same tag, right after the doctype, once. app-runtime-protocol.test.ts
 * pins the tag's form, so a change there fails a test instead of drifting from here.
 */
function injectAppRuntimeTag(html: string): string {
  const tag = `<script src="/_gugu/${appRuntimeVersion()}/gugu.js"></script>`
  if (html.includes(tag)) return html
  const doctype = /^(\uFEFF?\s*<!doctype[^>]*>)/i.exec(html)
  return doctype ? doctype[1] + tag + html.slice(doctype[1]!.length) : tag + html
}

/**
 * The phone (真源 §2.2): the App runtime and the preinstalled Apps ship in this bundle — `_gugu/<ver>/`
 * and `apps/<id>/`. The Android shell serves each App from an origin of its own, with the runtime under
 * that origin's `/_gugu/` (AppOrigins.java, L9), as the desktop does. Each App's index.html gets the
 * runtime's line here, at build time: the same line the desktop's protocol handler puts in (injectAppRuntime);
 * an App installed from a chat gets it from the phone's App store (phoneApps.ts).
 */
function phoneAppsPlugin(outDir: string) {
  return {
    name: 'gugu-phone-apps',
    async closeBundle() {
      const runtimeDir = resolve(outDir, `_gugu/${appRuntimeVersion()}`)
      await buildAppRuntime(runtimeDir)
      // The phone's own page in every App origin, which forgets the App's storage when it is uninstalled
      // (forget-entry.ts; APP_RUNTIME_FORGET_PAGE names it). A classic script of its own: the App's CSP is `script-src 'self'`.
      const esbuild = await import('esbuild')
      await esbuild.build({
        entryPoints: [fileURLToPath(new URL('./apps/desktop/src/session/app-runtime/forget-entry.ts', import.meta.url))],
        outfile: resolve(runtimeDir, 'forget.js'),
        bundle: true,
        platform: 'browser',
        target: 'es2022',
        minify: true,
        legalComments: 'none',
        format: 'iife',
        logLevel: 'warning',
      })
      writeFileSync(resolve(runtimeDir, 'forget.html'), '<!doctype html><meta charset="utf-8"><title>gugu</title><script src="forget.js"></script>\n')
      const shipped = fileURLToPath(new URL('./apps/desktop/preinstalled-apps/', import.meta.url))
      const appsDir = resolve(outDir, 'apps')
      rmSync(appsDir, { recursive: true, force: true })
      mkdirSync(appsDir, { recursive: true })
      const shippedManifests: unknown[] = []
      for (const entry of readdirSync(shipped, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const target = resolve(appsDir, entry.name)
        // The whole bundle, README.md included: the App's details read it from the installed package.
        cpSync(resolve(shipped, entry.name), target, { recursive: true })
        const manifest = JSON.parse(readFileSync(resolve(target, 'manifest.json'), 'utf-8')) as { entry?: string }
        const page = resolve(target, manifest.entry ?? 'index.html')
        writeFileSync(page, injectAppRuntimeTag(readFileSync(page, 'utf-8')))
        shippedManifests.push(manifest)
      }
      // What the phone has installed: the outer page reads it for each App's grants and for 「用 X 打开」.
      writeFileSync(resolve(appsDir, 'index.json'), JSON.stringify(shippedManifests))
    },
  }
}

export default defineConfig(({ command }) => ({
  root: 'apps/desktop',
  envDir: '../..',
  publicDir: '../../public',
  // vite-plugin-electron 在 build 模式的 config 钩子里把 base 钉成 './'(file:// 加载要相对路径);
  // 分进程构建时它不在插件表里,这里显式给,dev 不动(dev 下相对 base 无意义,vite 会告警)。
  ...(isElectronTarget && command === 'build' ? { base: './' } : {}),
  // Electron sub-builds write here while the renderer server is live. Generated output must not
  // feed back into the renderer watcher; source changes are already handled by the Electron plugin.
  server: {
    watch: { ignored: ['**/dist-electron/**'] },
  },
  optimizeDeps: {
    // @@@4865 冷启第一次打开会话页必退出的根因(owner 2026-09-03 实机撞到,MBP 复现):vite 开门前
    // 用 esbuild 扫入口找要预打包的依赖,而这两项是 vanilla-extract 插件在**转换 .css.ts 时注入**的
    // import,扫描器没有该插件、看不见 → 会话页一挂载才「new dependencies optimized」→ 重预打包让
    // 在途请求作废并整页 reload → EmdashSessionFrame 取资源 Failed to fetch → 按 fail-loud 规则整 App
    // 退出。开门前声明它们,冷启与热启走同一条路。❌ noDiscovery:它不是 fail-loud,漏声明的依赖会被
    // 静默按未优化形态服务(CJS 包直接坏),比现在更难查。
    include: [
      '@vanilla-extract/sprinkles/createRuntimeSprinkles',
      '@vanilla-extract/recipes/createRuntimeFn',
      // 同一条机制的另一半。.vite 缓存只比对 configHash + lockfileHash:开发机上换个分支两者
      // 都没变 ⇒ 缓存判定有效、不再扫描,composer 新引的这个 Base UI 子路径要等会话页真渲染到
      // 才被发现 → 「new dependencies optimized → reloading」→ 就是上面那条退出路径。
      // 同因在 CI 上已经真实发作过(vitest.config.ts 的 session-browser project,PR#5766)。
      '@base-ui/react/slider',
      // 聊天代码块按需 import 的 shiki 语法(#6563)。扫描器看得见 import(),但开发机缓存有效时
      // 不再扫描 ⇒ 第一次渲染到 go/rust… 代码块才被发现,又是上面那条退出路径。
      ...LAZY_LANG_MODULES,
    ],
    // Excel 预览(#7191)的解析器是 `new URL('xlsx_parser_bg.wasm', import.meta.url)` 取的 .wasm。预打包把它搬进
    // .vite/deps,那里没有 .wasm → 开发服务器回 index.html → 「expected magic word 00 61 73 6d, found 3c 21 64 6f」
    // (本机开发版实撞)。库的 README 原话:Vite ≤7 开发服务器要排除它,生产构建不受影响。它零依赖,排除后原样服务。
    exclude: ['@silurus/ooxml'],
  },
  // @@@renderer-ascii-output — 渲染层产物只出 ASCII(非 ASCII 字符转义成 \uXXXX,语义不变)。Blink 把每个
  // 脚本的源码常驻在渲染进程里,只要源码里有一个非 Latin-1 字符(中文文案就是),整份就按 UTF-16 存、
  // 内存翻倍。mac1 2026-09-25:登录后渲染进程里脚本源码串 27 MB,全部是双字节(#6484)。
  // 压缩这一步(vite 的 esbuild renderChunk)与 CSS 压缩都读这里的 charset;esbuild 不转的正则字面量等残留
  // 由 rendererAsciiOutput()(scripts/renderer-chunking.mts)收尾。
  esbuild: { charset: 'ascii' },
  // Resolve .tsx/.ts before .js so any future stray .js (build artefact, etc.)
  // can never shadow the actual TypeScript source again. Vite's default order
  // is .mjs > .js > .mts > .ts > .jsx > .tsx > .json; under that order, stale
  // generated JavaScript next to TypeScript source can silently win resolution.
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.mjs', '.js', '.mts', '.json'],
    // 数组形式:顺序有意义。会话页的精确子路径别名必须排在咕咕的 '@' 之前。
    alias: [
      ...sessionAliases,
      { find: '@gugu/core', replacement: workspaceAliases['@gugu/core'] },
      { find: '@', replacement: workspaceAliases['@'] },
    ],
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      // @@@task-fusion (#2802) — 会话页是本次 rollup 的第二个入口。
      // ⚠️ HTML 入口必须落在 root(apps/desktop)之内:vite:build-html 拒收路径逃出 root 的 HTML。
      // @@@task-web-host — 会话页在两个目标下都是入口:web 目标由无头宿主(session/headless)供后端,
      // 渲染层经 WebSocket 连它(src/lib/session-host-ws-client.ts)。从前「web 不产出会话页」的理由
      // (会话页只能靠 preload 的桌面 API)已不成立。
      input: rendererHtmlEntries,
      output: {
        // #1163 keeps editor/emoji dependencies behind their dynamic import. #2438 narrows the
        // React chunk to the dependency-free core and rejects static cross-chunk cycles at build time.
        // 两个入口后按可达性分 chunk:只被会话页用到的模块不该压进咕咕首屏。
        manualChunks: entryAwareRendererManualChunk(reachability),
      },
    },
  },
  // 依赖预构建缓存**按目标分开**。默认是 node_modules/.vite,electron 与 web 两个目标会共用它 ——
  // 而两者的 define(__GUGU_TARGET__ 等)与插件集并不相同,同时跑两个 dev server 时后启动的那个
  // 会把前一个的预构建产物覆盖掉。症状不是报错,是渲染层抛
  // `Invalid hook call` / `useSyncExternalStore of null` —— 一副「装了两份 React」的面孔,
  // 会让人去查依赖树,而真因在这里。
  // ⚠️ 这个功能天然需要同时开两个:被看管的那台机器(electron)+ 手机端(web)。
  cacheDir: `node_modules/.vite-${guguTarget}`,
  define: {
    ...bakedSupabaseDefine,
    __GUGU_TIER__: JSON.stringify(guguTier),
    __APP_VERSION__: JSON.stringify(appVersion),
    __GUGU_CHANGELOG_URL__: JSON.stringify(changelogUrl),
    __GUGU_BUILD_TAG__: JSON.stringify(buildTag),
    __GUGU_TEST_NOTES__: JSON.stringify(buildTestNotes),
    // #7199 云电脑管家的地址:开发实例用它指到本机假服务 / 隧道;不设 = 这套库的 /functions/v1/cloud-computer。
    __GUGU_CLOUD_COMPUTER_URL__: JSON.stringify(process.env.GUGU_CLOUD_COMPUTER_URL ?? ''),
    // @@@web-target-gate - renderer-wide target constant; lib/target.ts is the sole reader.
    __GUGU_TARGET__: JSON.stringify(guguTarget),
    // @@@task-web-host — dev serve 下把无头宿主的地址与 token 直接交给渲染层;生产 web 构建为 null,
    // 浏览器改从地址栏 hash(宿主启动日志打印)取。
    __GUGU_SESSION_HOST_DEV__: JSON.stringify(
      command === 'serve' && !isElectronTarget && sessionHostEnabled
        ? { url: `ws://${sessionHostDevBind}:${sessionHostDevPort}/`, token: sessionHostDevToken }
        : null,
    ),
  },
  plugins: [
    deterministicModuleSideEffects(),
    guguEntryReachabilityPlugin(reachability, isGuguEntry),
    monacoWorkerSingleBundlePlugin(),
    // @@@task-fusion (#2802) — 会话页的 @gugu/session-ui / session-chat-ui 用 vanilla-extract 写样式。
    // 并入本体后它们不再各自 tsdown 出 dist,而是由这一次构建直接编 .css.ts —— 少一套构建。
    vanillaExtractPlugin(),
    rendererChunkCycleGuard(),
    // ⚠️ 必须在 rendererAsciiOutput() 之前:ASCII 转义要最后收尾(#6484),顺序由 obfuscateOwnChunks7195 测试钉住。
    ...(obfuscateRenderer ? [obfuscateOwnChunks({ version: appVersion })] : []),
    rendererAsciiOutput(),
    // @@@task-fusion (#2802) — @gugu/session-chat-ui 是 Solid 写的,其余全仓是 React。Solid 的 JSX 不是
    // 通用 automatic runtime,而是编译期就展开成 DOM 操作,必须由 babel-preset-solid 转 —— 从前它靠
    // 自己那次 lib 构建转好再以 dist 交付,按源码消费后就得在这一次 rollup 里转。两个插件按路径互斥:
    // solid 只吃 session-chat-ui,react 明确排除它,否则同一个 .tsx 会被转两遍。
    solid({ include: [SESSION_CHAT_UI_GLOB], extensions: ['.tsx', '.ts', '.jsx', '.js'] }),
    react({ exclude: [SESSION_CHAT_UI_GLOB] }),
    // The phone serves the App runtime and the preinstalled Apps from this bundle (phoneAppsPlugin).
    ...(isElectronTarget || command !== 'build' ? [] : [phoneAppsPlugin(fileURLToPath(new URL('./dist/', import.meta.url)))]),
    ...(isElectronTarget
      ? [
          ...(separateElectronBuild ? [] : [electron(electronBuildEntries)]),
          renderer(),
        ]
      : // 网页版:同一套主进程图以无头宿主入口构建;dev 下由插件拉起并热重启(见 sessionHostBuildEntries)。
        // build 走 scripts/build-electron-app.mts 的两阶段(理由同 electronBuildEntries 的注释:渲染层
        // 与会话页主进程图共用一个 node 进程会 OOM,CI 的 build:renderer 实撞 4GB 顶爆)。
        separateElectronBuild ? [] : [electron(sessionHostBuildEntries)]),
  ],
}))
