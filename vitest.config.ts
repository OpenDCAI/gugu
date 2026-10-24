import { defineConfig } from 'vitest/config'
import { availableParallelism, loadavg } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import solid from 'vite-plugin-solid'
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin'
import { playwright } from '@vitest/browser-playwright'
import { emdashAliasEntries } from './apps/desktop/electron/sessionpage/emdash-aliases.mjs'
import { WorkerAttributionReporter } from './scripts/vitest-worker-attribution-reporter'
import { lockfileScopedModuleCacheDir } from './scripts/vitest-module-cache-dir'
import { LAZY_LANG_MODULES } from './packages/session-chat-ui/src/core/highlight/lazy-langs'

// The Mac Studio CI slots all share one 32-core host, and vitest sizes its worker pool from the
// core count of the *machine*, not of the slot. Eight slots left uncapped therefore ask for roughly
// eight times the cores. Measured on mac1 2026-07-30: eight concurrent full-suite runs took 140 s
// uncapped and three of the eight failed, because timing-sensitive cases (child-process stall
// detection) were starved of scheduling; dividing the cores across the declared slot count returned
// 130 s with eight of eight passing — faster and no longer flaky. Outside a declared slot (local
// dev, other runners) this stays undefined and vitest keeps its own default.
//
// @@@load-aware-workers (#6270) — 上面那条「按 16 个槽全满静态切」把最坏情况当成了常态:机器闲着时
// 每片也只有 2 个 worker(#6270 实测:单测每片 ~90s,真跑用例只占 26–68s)。现在按**启动那一刻的余量**分:
//   余量 = 1.5 × 核数 − max(1 分钟负载, 5 分钟负载)
// 1.5 倍是因为单测 worker 大半时间在等子进程/磁盘,不是满核在转:mac1 实测 16 个 worker 平均只吃 ~11 核。
// 取两档负载里大的那个,是因为 1 分钟负载刚从高峰落下来时会低估(几个 job 同时起跑恰好就是这一刻)。
// 余量是**整个单测 job**(所有分片合计)的 worker 总数,再按 `--shard i/N` 的 N 平分 —— 同一个 PR 的
// 几片同时启动、看到同一个负载,不平分就会一起把余量吃成超卖。
// 边界:每片下限仍是 核数/槽数(16 个槽全在跑单测的最坏情况与从前一致);合计上限 GUGU_CI_WORKER_BUDGET。
// mac1 对照读数(#6270,负载 25–35):合计 16 个 worker 两次全绿;负载 64–89 下合计 16 个红了两条计时类用例
// ——那种负载下余量公式给出的是下限,不会走到 16。
// ⚠️ 按余量分是**显式开启**的:只有设了 GUGU_CI_WORKER_BUDGET(= 这次调用所有分片合计最多几个 worker)
//    的步骤才走它,没设的一律保持上面的静态下限。原因是同一个 job 里可能并发跑好几个 vitest(session-db 那一步
//    四段并发、两个是浏览器 project),它们各自看到同一份余量、又都不带 --shard,放开就是四倍超卖。
//    谁要放宽,就在自己那一步写明预算 —— 单测 job 写 16,tooling 那步写 8。
// ❌ 别用 CLI `--maxWorkers` 去调:各 project `extends: true` 继承了根上的 maxWorkers,而 vitest 按
//    project.config.maxWorkers 优先解析,CLI 值被静默忽略(实测 worker 进程数不变)。

function shardTotal(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = arg === '--shard' ? argv[i + 1] : arg.startsWith('--shard=') ? arg.slice(8) : undefined
    const total = Number(value?.split('/')[1])
    if (Number.isInteger(total) && total >= 1) return total
  }
  return 1
}

function slotWorkerCap(): number | undefined {
  const slots = Number(process.env.GUGU_CI_SLOT_COUNT)
  if (!process.env.GUGU_CI_SLOT_ID || !Number.isInteger(slots) || slots < 1) return undefined
  const cores = availableParallelism()
  const shards = shardTotal(process.argv)
  const floor = Math.max(1, Math.floor(cores / slots))
  const budget = Number(process.env.GUGU_CI_WORKER_BUDGET)
  if (!Number.isInteger(budget) || budget < 1) return floor
  const [load1, load5] = loadavg()
  const headroom = Math.floor(1.5 * cores - Math.max(load1, load5))
  const ceiling = Math.max(floor, Math.floor(budget / shards))
  // 忙时保底 = 预算的一半,按片平分(预算 16、2 片 ⇒ 每片 4、合计 8)。#6270 首版忙时退回 cores/slots=2,
  // 2 片合计只剩 4 个,比改之前「4 片 × 2 = 8」的最坏情况还差一半 —— CI 实测负载 50–77 时单测一片
  // 146–182s。保底对齐到 8,最坏情况与旧配置相同,闲时照样放到 16。
  const busyFloor = Math.max(floor, Math.floor(budget / shards / 2))
  return Math.min(ceiling, Math.max(busyFloor, Math.floor(headroom / shards)))
}

// 同一进程只算一次,所有 project 共用(#6721)。
const maxWorkers = ((globalThis as typeof globalThis & { __guguVitestMaxWorkers?: number }).__guguVitestMaxWorkers ??= slotWorkerCap())

// @@@fs-module-cache (#6270) — 单测分片的时间大头不是跑用例,是**每个文件重新 transform + import**
// (隔离模式下每个测试文件一个新 worker,vite 在主进程里把 TS 逐个转一遍)。vitest 4.1 的
// `experimental.fsModuleCache` 把转好的模块按「文件内容 + 配置」的哈希落盘,下一次直接读。
// CI 槽跨 job 保留 node_modules(#2570),缓存就放在 node_modules/.experimental-vitest-cache 里,
// 所以同一个槽的下一个 PR 只需要重转它改过的文件。
// 缓存按锁文件分格(#6517):转好的模块里写死了依赖的绝对路径,而 vitest 4.1 自己的「锁文件变了就清」
// 每隔一次漏判一次,换了依赖的 PR 会读到按旧锁文件转的模块、vi.mock 静默落空。详见 lockfileScopedModuleCacheDir。
// mac1 实测(4 片 × 2 worker,同一窗口对照):transform 累计 18s → 5s,整片 CPU 400s → ~310s。
// 只开给下面四个纯 node 的单测 project:浏览器那两个 project 走 vite 自己的中间件,没测过,不碰。
// Hosted CI opts in independently of slot worker allocation; local runs keep the default off.
const unitModuleCache = process.env.GUGU_CI_SLOT_ID || process.env.GUGU_VITEST_MODULE_CACHE === '1'
  ? { experimental: { fsModuleCache: true, fsModuleCachePath: lockfileScopedModuleCacheDir(__dirname) } }
  : {}

// Tests must not depend on a gitignored .env.local. Provide dummy Supabase
// config so env-driven client creation (no hardcoded fallback) does not throw
// at import time. Tests do not make real network calls.
const guguTestEnv = {
  VITE_SUPABASE_URL: 'http://supabase.test.local',
  VITE_SUPABASE_ANON_KEY: 'test-anon-key',
  GUGU_SUPABASE_URL: 'http://supabase.test.local',
  GUGU_SUPABASE_ANON_KEY: 'test-anon-key',
}
// Nor on the shell's build config: a VITE_* var exported by the shell (CI build env, a sourced
// .env) lands in import.meta.env and outranks both guguTestEnv and a test's vi.stubEnv of the
// GUGU_* name. Drop them before Vite resolves env so every run sees the same dummy config.
for (const key of Object.keys(guguTestEnv)) delete process.env[key]

// @@@task-fusion (#2802) — 会话页的别名与构建共用同一张表(emdash-aliases.mjs),别在这里另抄一份:
// 从前 app 配置、每个包的 vitest 配置、构建配置各抄一份,漂移就是这么来的。
const sessionAliases = emdashAliasEntries.map(([find, replacement]) => ({ find, replacement }))

const alias = [
  ...sessionAliases,
  {
    find: '@gugu/core',
    replacement: fileURLToPath(new URL('./packages/core/src', import.meta.url)),
  },
  { find: '@', replacement: fileURLToPath(new URL('./apps/desktop/src', import.meta.url)) },
  // lottie 只声明在 apps/desktop/package.json ⇒ 从 `tests/**` 用裸说明符**解析不到**它
  // (实撞:Cannot find package 'lottie-web/build/player/lottie_light')。而 vitest 是按
  // **解析后的模块 id** 匹配 mock 的 ⇒ 写在仓根 setup 里的 `vi.mock('lottie-web/…')` 会注册在
  // 一个谁也命中不了的 id 上,**静默空转**:桩没生效,判据却照样绿(#5241 就是这么过的门)。
  // 把这个名字在别名表里定死成绝对路径,桩(setup 的 vi.mock)、出口(用例的 vi.unmock)、
  // 产品那条 import 才落在同一个 id 上。替身与「为什么」见 tests/support/lottie-player-stub.ts。
  {
    find: 'lottie-web/build/player/lottie_light',
    replacement: createRequire(resolve(__dirname, 'apps/desktop/package.json')).resolve(
      'lottie-web/build/player/lottie_light'
    ),
  },
]

// 会话页的 DB 用例要的是**系统 Node 编译**的 better-sqlite3;仓库根那份始终是 electron 编译的,
// 于是这几个 project 单独把它指到 session-tooling/node-deps(`pnpm session:db:setup` 装),
// 免去在 app 开发与 DB 测试之间来回 rebuild。
const dbAlias = [
  {
    find: 'better-sqlite3',
    replacement: resolve(
      __dirname,
      'apps/desktop/session-tooling/node-deps/node_modules/better-sqlite3'
    ),
  },
  ...alias,
]

const SESSION_CHAT_UI = '**/packages/session-chat-ui/**'

// 只给 chat-ui 那几个 project 用(见上面 plugins 的说明)。
const solidPlugin = () =>
  solid({ include: [SESSION_CHAT_UI], extensions: ['.tsx', '.ts', '.jsx', '.js'] })

// @@@browser-case-cap (#6331) — 浏览器用例**每条**一个上限,是这类用例唯一的时间上限。
// 与下面 defineConfig 里 @@@no-case-budget 不矛盾:那条禁止的是「速度预算」—— 一个与被测步骤同阶的数,负载一高就误红。
// 这里的等待全走 tests/support/awaitCondition 的 `until`,**自己不设时限**;事实永远不来(真回归)时,
// 由这条用例的上限判红,失败原因里点名「卡在哪一步、最后读到什么」。不设这一条的话,回归要等到
// CI job 的 timeout-minutes(25 分钟)才停,而那只显示成一次 cancelled,说不出是哪条用例、哪一步。
// 取值 60s = 正常用例(1–3s)的二三十倍;#6331 的并发加重负载下没有一条合法等待超过几秒。❌ 调小它去抓「慢」—— 慢不是这里要判的。
// 从前 5 分钟:#6325 那次 7 条同卡一步 = 35 分钟,超过 job 的 25 分钟 ⇒ cancelled,判定里没点名。
// 整片卡死(上百条)仍会超 job 上限 ⇒ 另有「同一步骤连续 3 条卡死即当场红」的保护,见 awaitCondition.ts 的 STREAK_LIMIT。
const BROWSER_CASE_CAP_MS = 60_000

// 每个 project 要一份**新的**对象:共用同一个引用时 vitest 会按 instance 注册,三个 project
// 拿到同一个 instances 数组,于是第二个就报 `The project name "session-browser (chromium)" was
// already defined`(实测)。instance 的 name 还会**整个取代**派生出来的 project 名,所以它必须
// 既彼此唯一、又不能和外层 project 同名 —— 统一加 `-chromium` 后缀。
const browserOptions = (name: string) => ({
  enabled: true as const,
  provider: playwright(),
  headless: true,
  instances: [{ browser: 'chromium' as const, name: `${name}-chromium` }],
})

export default defineConfig({
  resolve: { alias },
  // React 的 JSX 由 vite 内建的 esbuild 按 tsconfig(`jsx: react-jsx`)转,**不要**在这里挂
  // @vitejs/plugin-react:测试跑在 dev-server 模式下,它会注入 React Refresh 运行时,
  // 那段代码上来就读 document —— node 环境的 project 于是在收集期就 `document is not defined`。
  // vite-plugin-solid 同样**不能**挂在根上:它会把 vitest 的 transformMode 设成 web,
  // 于是每个 project 都按浏览器条件解析依赖(实测 decode-named-character-reference 被解析成
  // index.dom.js,10 个 node 环境的渲染层测试整片 `document is not defined`)。
  // 它只在下面 chat-ui 那三个 project 里挂 —— Solid 的 JSX 是编译期展开,没插件编不出来。
  plugins: [vanillaExtractPlugin()],
  test: {
    reporters: ['default', new WorkerAttributionReporter(), ...(process.env.GUGU_VITEST_JSON_REPORT ? ['json' as const] : [])],
    outputFile: process.env.GUGU_VITEST_JSON_REPORT ? { json: process.env.GUGU_VITEST_JSON_REPORT } : undefined,
    // Direct `vitest`/IDE launches must enforce the same exact Node pin as the package scripts.
    // The setup only validates the process; it never switches toolchains or changes PATH.
    // 第二项:每次运行一个专属临时根,结束删净(#6272),原因见文件头。
    globalSetup: [
      resolve(__dirname, 'scripts/vitest-node-version-guard.ts'),
      resolve(__dirname, 'scripts/vitest-run-tmp-root.ts'),
    ],
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    // @@@no-case-budget (#4357 / #5955) — 用例与钩子**不设**墙钟上限(0 = 不限)。
    // 用例断言的是「行为对不对」,不是「多快」。从前的 30s 是一道对所有用例生效的速度预算:
    // mac1 并发车道一多,起子进程、首次执行新文件、全仓扫描这类**按事实等待**的用例会合法地超过它,
    // 同步用例甚至在结果正确之后被事后判成 `Test timed out`(runner 在返回时比墙钟)。
    // 真挂住的唯一上限是 CI job 的 `timeout-minutes`;那时「卡在哪」由 WorkerAttributionReporter
    // 的在飞心跳与 tests/support/awaitFact 的 `[awaiting-fact]` 行报出来。
    // ❌ 别改回一个数:那等于把同一条曲线往右推,下一次负载更高时它照样制造红。
    testTimeout: 0,
    hookTimeout: 0,
    projects: [
      {
        // 咕咕自身的单测。
        // 环境默认 node,不是 jsdom:实测这 463 个文件里只有 28% 碰 DOM,而 jsdom 每个文件要多付
        // ~335ms 建环境(全量 environment 阶段 161s)。真正要 DOM 的文件在自己第一行写
        // `// @vitest-environment jsdom` 单独开 —— 这个约定仓库里本来就在用。
        // ❌ 别为了省事把默认改回 jsdom:那等于让 72% 的用例替另外 28% 交税。
        extends: true,
        test: {
          name: 'gugu',
          ...unitModuleCache,
          environment: 'node',
          setupFiles: ['tests/support/setup.ts'],
          // 收 .tsx:只收 .ts 会把每个 React 用例逼成 createElement 写法,而
          // `createElement(C, props, children)` 的三参重载绕过 props 类型 ——
          // vitest 跑得过、tsgo 报 children is missing(#3201 实际踩到)。写成
          // JSX 的话这个错误根本表达不出来。当前无 .test.tsx,放宽是纯增量。
          include: ['tests/**/*.test.{ts,tsx}'],
          // tests/unit/scripts 归 `tooling`(见下),不进产品单测分片。
          // tests/contract 要一份 gugu-supabase 检出(与迁移完的库),归 `supabase-contract`(见下)。
          exclude: ['tests/integration/**/*.test.ts', 'tests/unit/scripts/**', 'tests/contract/**'],
          env: guguTestEnv,
        },
      },
      {
        // Client ↔ installed community database. Requires disposable loopback PostgreSQL.
        extends: true,
        test: {
          name: 'supabase-contract',
          environment: 'jsdom',
          setupFiles: ['tests/support/setup.ts'],
          include: ['tests/contract/**/*.test.ts'],
          env: guguTestEnv,
        },
      },
      {
        // 咕咕的集成测试(`pnpm test`),要连真东西,不进默认单测门。
        extends: true,
        test: {
          name: 'gugu-integration',
          environment: 'jsdom',
          setupFiles: ['tests/support/setup.ts'],
          include: ['tests/integration/**/*.test.ts'],
          env: guguTestEnv,
        },
      },
      {
        // 工具链自身的测试:被测对象是 CI 治理脚本(scripts/*),不是产品代码(e2e 脚手架的测试已随 #6270 删除)。
        // 它们 spawn 真子进程、cpSync 拷整个仓库、起真 HTTP server、跑真 wall-clock 等待 ——
        // 是集成测试的成本,顶着单测的名分。留在 `gugu` 里的代价实测过(run 31404888851,
        // Unit tests (1/2)):36 个这样的文件吃掉该分片 102.4s 测试时间里的 49.8s(49%),
        // 而这些文件只占 523 个文件里的 7%;`tests/unit/e2e` 均值 2229ms/文件,是 session-main 的 60 倍。
        // 单测分片又占 CI 关键路径的 94%(500 个 run 的统计),所以这 49% 是直接压在墙钟上的。
        // 拆成独立 project + 独立并行 job:**一个测试都不删**,只是从关键路径上挪开。
        //
        // environment 用 node 而不是继承 jsdom:这 77 个文件里唯一碰 window 的
        // agentRuntimeCacheCleanup 是自己 defineProperty 造的假 window,finally 里本来就处理了
        // 「原本没有 window」的分支 —— 它为 node 写的。其余全是 node fs/child_process。
        // 不挂 tests/support/setup.ts:这批测试没有一个用到它提供的 i18n / ResizeObserver /
        // localStorage,而它每个用例都要重新 import 八个 i18n catalog —— 白付。
        // (它本身在 node 下是安全的:同一个 PR 里已给那两段浏览器桩加了 typeof window 判断。)
        extends: true,
        test: {
          name: 'tooling',
          environment: 'node',
          include: ['tests/unit/scripts/**/*.test.{ts,tsx}'],
          env: guguTestEnv,
        },
      },
      {
        // 会话页的 6 个包(chat-ui 除外:它是 Solid 且有浏览器用例,单列在下面)。
        // setupFiles 是 session-core 那条 immer patches 注册:生产路径由 @gugu/session-wire 的
        // immer-setup 在 import 时完成,单测里被测模块常先于那条链路加载,必须先注册。
        extends: true,
        test: {
          name: 'session-packages',
          ...unitModuleCache,
          environment: 'node',
          include: ['packages/session-*/src/**/*.test.ts', 'packages/session-*/tooling/**/*.test.ts'],
          exclude: ['packages/session-chat-ui/**'],
          setupFiles: ['packages/session-core/vitest.setup.ts'],
        },
      },
      {
        // 会话页主进程 + 渲染层的 node 用例。
        // 排除项与 vendor 时期逐条一致(#2633),不是 continue-on-error:具名、有限、随修复缩小。
        extends: true,
        test: {
          name: 'session-main',
          ...unitModuleCache,
          environment: 'node',
          // @@@2633 兜底 GUGU_SESSION_DB_FILE —— 见 session-tooling/vitest-node-setup.ts 里的完整说明。
          // 少了它,import 期就打开数据库的模块会在收集期崩(electron 的 app 在这里是 undefined)。
          setupFiles: [resolve(__dirname, 'apps/desktop/session-tooling/vitest-node-setup.ts')],
          include: [
            'apps/desktop/electron/session/**/*.test.ts',
            // ACP 适配器(dist-electron/runtime 里跑的那几个 .mjs)从前没有任何 project 收它们,
            // 于是那一层一条判据都放不下 —— 图片附件被适配器丢掉这件事因此没有闸拦住(#5269)。
            'apps/desktop/electron/runtime/**/*.test.ts',
            // .tsx 同收:渲染层的 node 用例也有写 JSX 的(agent-icon.test.tsx 从前因为后缀没被任何 project 收)。
            'apps/desktop/src/session/**/*.test.{ts,tsx}',
          ],
          exclude: [
            '**/_*/**',
            'apps/desktop/src/session/renderer/tests/browser/**',
            'apps/desktop/electron/session/main/db/tests/migrations/**',
            'apps/desktop/electron/session/main/core/**/*.db.test.ts',
            'apps/desktop/electron/session/main/db/*.db.test.ts',
            // 要真起 node-pty 进程 → `posix_spawnp failed`,macOS 真机同样复现。根因(2026-09-29 mac1):pnpm install
            // 出来的 node-pty prebuilds/<平台>/spawn-helper 是 0644(打包走 rebuild:native 从源码编,build-gugu-server
            // 显式 chmod,都绕开了它);给它 x 之后这个文件 3/3 绿。要收进来得先让测试环境有可执行的 helper。
            'apps/desktop/electron/session/main/core/pty/local-pty.integration.test.ts',
          ],
        },
      },
      {
        // 要真 SQLite 连接的主进程集成用例。
        extends: true,
        resolve: { alias: dbAlias },
        test: {
          name: 'session-main-db',
          environment: 'node',
          include: [
            'apps/desktop/electron/session/main/core/**/*.db.test.ts',
            'apps/desktop/electron/session/main/db/*.db.test.ts',
          ],
        },
      },
      {
        // 迁移测试 —— `pnpm session:test:migrations` 显式跑。
        extends: true,
        resolve: { alias: dbAlias },
        test: {
          name: 'session-migrations',
          environment: 'node',
          include: [
            'apps/desktop/electron/session/main/db/tests/migrations/**/*.test.ts',
            // task → session 段 2(库外那一半),读的是 0032 留下的交接表,与迁移测试同一个 project。
            'apps/desktop/electron/migrations/**/*.test.ts',
          ],
        },
      },
      {
        // fixture 生成器 —— `pnpm session:db:fixtures` 显式跑,**会写文件**,别进默认门。
        extends: true,
        resolve: { alias: dbAlias },
        test: {
          name: 'session-fixtures',
          environment: 'node',
          include: ['apps/desktop/session-tooling/generate-fixtures.ts'],
        },
      },
      {
        // 要真浏览器环境的渲染层用例(真 CSS 布局、ResizeObserver、rAF、WebGL)。
        // vendor 时期这里要显式挂 @tailwindcss/vite;咕咕的 tailwind 走 postcss.config.mjs,
        // vitest 同样会应用 postcss,所以不再需要那个插件。
        extends: true,
        // 这个 project 的用例会引到 chat-ui(终端/会话视图),所以同样要 Solid 的编译。
        // 它本来就跑在浏览器里,不受「solid 插件把 transformMode 设成 web」的影响。
        plugins: [solidPlugin()],
        // 这些依赖必须预先声明。Vite 只在启动时扫一遍依赖,跑到一半才第一次遇见的
        // 会触发重新预构建 + **整页重载** —— 页面一刷,正在跑的测试连同已挂载的 React 树
        // 一起没了,报出来的却是「找不到元素」这类离根因十万八千里的错。
        optimizeDeps: {
          include: [
            'react/jsx-dev-runtime',
            'react/jsx-runtime',
            '@tanstack/react-query',
            // vanilla-extract 的运行时助手是注入进编译后的 .css.ts 的,vite 的首轮依赖扫描
            // 看不见它们 —— 不预声明就会跑到一半才发现、触发重新预构建 + 整页重载。
            '@vanilla-extract/recipes/createRuntimeFn',
            '@vanilla-extract/sprinkles/createRuntimeSprinkles',
            // Base UI 的每个子路径都是**独立**的预打包入口。首轮扫描在冷启时能看见它,靠不住的
            // 是 CI:runner slot 跨 run 留着 node_modules(#2570),而 .vite 缓存只比对
            // configHash + lockfileHash —— 换个分支两者都没变 ⇒ 缓存判定有效、**不再扫描**,
            // 上一条分支没引过的子路径就要等用例真渲染到它才被发现。PR#5766 连红两把,原文:
            //   ✨ new dependencies optimized: @base-ui/react/slider
            //   ✨ optimized dependencies changed. reloading
            // 页面一刷,该文件 17 条全红在「面板没打开」上,真因半个字不提。
            // ⇒ 在这个 project 里新引一个 Base UI 子路径,就往这儿补一行(补了 configHash 就变,
            //   陈旧缓存自动作废,不会留下这种半新半旧的状态)。
            '@base-ui/react/slider',
            // #6264 浏览器页里的 SSH 提问卡(SshPromptCard)经 ui/Field 引了它:PR#6504 CI 原文同上
            //   ✨ new dependencies optimized: @base-ui/react/field → reloading → 5818 / 5846 整个文件挂不上行。
            '@base-ui/react/field',
            // #6325 会话页投递卡的头像投影经 @/lib/dicebearAvatar 引了 DiceBear(没上传头像时的生成脸)。
            // CI 冷缓存上它跑到一半才被发现 ⇒ 预构建 + 整页重载 ⇒ 两份 React,5818 整个文件 Invalid hook call、行永远挂不上。
            '@dicebear/core',
            '@dicebear/collection',
            // Group mention matching uses pinyin; prebundle it before mounting the shared composer.
            'pinyin-pro',
            // #6544 确认框几何判据挂真 Dialog + Checkbox(ConfirmActionDialog 的页脚)。
            '@base-ui/react/dialog',
            '@base-ui/react/checkbox',
            // #6699 表格全屏浮层 × 窗口 chrome 的几何判据:Streamdown 本身 + 真 WindowControls(标题栏行的菜单栏 / 菜单 / 图标钮)。
            'streamdown',
            '@base-ui/react/menubar',
            '@base-ui/react/menu',
            '@base-ui/react/button',
            // #6908 手机弹层几何判据挂真 MemberProfileCard,它引了分享海报(SharePosterDialog → qrcode)。CI 原文:
            //   ✨ new dependencies optimized: qrcode → reloading → mobile-sheet-scroll-6908 两格停在「挂上了没」。
            'qrcode',
            // #6923 手机工具卡几何判据挂真 assistant-ui 运行时(useExternalStoreRuntime + ToolFallback)。CI 原文:
            //   ✨ new dependencies optimized: @assistant-ui/react → reloading → 两份 React,useMemoCache 读到 null、卡画不出来。
            '@assistant-ui/react',
            // #7475 侧栏行尾的定时标记经 session-schedule-format 引了 cronstrue(重复规则说成人话)。PR#7483 CI 原文:
            //   ✨ new dependencies optimized: cronstrue, cronstrue/locales/zh_CN → reloading → 5818 / 5846 Invalid hook call、行挂不上。
            'cronstrue',
            'cronstrue/locales/zh_CN',
            // #6563 聊天代码块按需 import 的 shiki 语法。PR#6568 CI 原文:
            //   ✨ new dependencies optimized: @shikijs/langs/c, … → reloading → tab-strip-narrow-6264 挂在不相干的断言上。
            ...LAZY_LANG_MODULES,
          ],
        },
        test: {
          name: 'session-browser',
          env: guguTestEnv,
          testTimeout: BROWSER_CASE_CAP_MS,
          hookTimeout: BROWSER_CASE_CAP_MS,
          // 串行跑。默认并行时多个测试文件共用同一个浏览器同时跑,终端那几个文件测的是
          // 字元格尺寸与 resize 时序 —— 旁边只要有个吃 CPU 的组件测试文件,它们就整片超时。
          fileParallelism: false,
          browser: browserOptions('session-browser'),
          include: ['apps/desktop/src/session/renderer/tests/browser/**/*.test.{ts,tsx}'],
        },
      },
      {
        // chat-ui 的纯算术/对拍用例 —— node,不碰 DOM。
        extends: true,
        plugins: [solidPlugin()],
        test: {
          name: 'session-chat-ui',
          ...unitModuleCache,
          environment: 'node',
          include: ['packages/session-chat-ui/src/**/*.test.ts'],
          // 显式给一项含 jest-dom 的 setupFiles,vite-plugin-solid 就不会再注入一个 /@fs/
          // 绝对路径(那个路径在 jsdom 环境的用例里加载不了)。
          setupFiles: ['packages/session-chat-ui/src/tests/jest-dom-setup.ts'],
          css: false,
          benchmark: { include: [] },
        },
      },
      {
        // chat-ui 的测量契约用例 + benchmark —— 要真浏览器布局。
        extends: true,
        plugins: [solidPlugin()],
        optimizeDeps: {
          include: [
            '@vanilla-extract/recipes/createRuntimeFn',
            '@vanilla-extract/sprinkles/createRuntimeSprinkles',
            // #6563 代码块按需 import 的 shiki 语法;不预声明,PR#6568 CI 在这里同样半路重载。
            ...LAZY_LANG_MODULES,
          ],
        },
        test: {
          name: 'session-chat-ui-browser',
          testTimeout: BROWSER_CASE_CAP_MS,
          hookTimeout: BROWSER_CASE_CAP_MS,
          browser: browserOptions('session-chat-ui-browser'),
          include: ['packages/session-chat-ui/src/**/*.contract.test.tsx'],
          setupFiles: ['packages/session-chat-ui/src/tests/contract-setup.ts'],
          benchmark: {
            include: ['packages/session-chat-ui/src/**/*.bench.ts'],
          },
        },
      },
    ],
  },
})
