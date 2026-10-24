// @@@4865 `build:app` 的两阶段 vite 构建(替代裸 `vite build`),理由见 vite.config.mts 里 electronBuildEntries 的注释。
//  阶段 1:渲染层 + 会话页渲染层 —— 子进程跑 `vite build`,GUGU_ELECTRON_BUILD=separate 让配置不挂 electron 插件。
//  阶段 2:主进程 / 会话页主进程图 / 三个 worker / 两个 preload —— 本进程里按 electronBuildEntries 逐个
//         调 vite-plugin-electron 导出的 build()(它内部 = 同一套 resolveViteConfig + withExternalBuiltins,与 dev 路径同源)。
// @@@6340 两阶段**并发**:各自独占一个进程的堆(拆进程的原因),输入输出互不相交 —— 阶段 1 只写 dist/,
// 阶段 2 只写 apps/desktop/dist-electron/,谁也不读对方的产物。串行时阶段 2 的 ~10s 整段压在墙钟上。
// 任一阶段失败即整体非零;两边都等到落定再报,两处失败同时可见(❌ 吞错)。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite-plugin-electron'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
// vite 的 exports 表不暴露 bin/,`require.resolve('vite/bin/vite.js')` 会 ERR_PACKAGE_PATH_NOT_EXPORTED;经 package.json 定位包根。
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')
const t0 = performance.now()
const elapsed = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`

const rendererStage = new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, [viteBin, 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, GUGU_ELECTRON_BUILD: 'separate' },
  })
  child.on('error', reject)
  child.on('exit', (code, signal) => {
    if (code === 0) {
      console.log(`[build-electron-app] renderer stage done at ${elapsed()}`)
      resolve()
    } else reject(new Error(`renderer stage failed (exit ${code ?? signal})`))
  })
})

// 与 vite-plugin-electron build 模式的 closeBundle 完全相同的四项补全(mode/root/envDir/envPrefix),
// 只是这里没有 userConfig 可抄,按根配置的字面值给。
// 网页版(GUGU_TARGET=web)的阶段 2 是无头会话页宿主(task-host.js + worker),吃同一份 sessionHostBuildEntries。
async function mainStage() {
  const { electronBuildEntries, sessionHostBuildEntries } = await import('../vite.config.mjs')
  const isWebTarget = (process.env.GUGU_TARGET ?? 'electron') === 'web'
  const stageTwoEntries = isWebTarget ? sessionHostBuildEntries : electronBuildEntries
  for (const entry of stageTwoEntries) {
    const entryStarted = performance.now()
    const label = typeof entry.entry === 'string' ? entry.entry : Object.keys(entry.entry ?? {}).join(',')
    console.log(`[build-electron-app] main stage: ${label}`)
    await build({
      ...entry,
      vite: {
        ...entry.vite,
        mode: entry.vite?.mode ?? 'production',
        root: entry.vite?.root ?? fileURLToPath(new URL('../apps/desktop', import.meta.url)),
        envDir: entry.vite?.envDir ?? repoRoot,
      },
    })
    console.log(`[build-electron-app] main entry done in ${((performance.now() - entryStarted) / 1000).toFixed(1)}s: ${label}`)
  }
  console.log(`[build-electron-app] main stage done at ${elapsed()}`)
}

const results = await Promise.allSettled([rendererStage, mainStage()])
const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
for (const failure of failures) console.error('[build-electron-app]', failure.reason)
// exitCode 而非 exit():macOS 上 stdout 接管道时是异步写,exit() 会截掉尾部日志。
process.exitCode = failures.length > 0 ? 1 : 0
