import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'
import { loadDotEnvLocal } from './scripts/env-file'

// 只剩 PR CI 的 ci-local 一个 project(e2e/ci/local):web 目标的 renderer 打本机 auth fixture
// (LOCAL_FIXTURE_PORT),不碰共享测试库。❌ 不再新增 e2e 用例;验收证据写成单元测试(#6270)。
loadDotEnvLocal()

const loopbackNoProxy = new Set(
  [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost', '::1']
    .flatMap((value) => value?.split(',') ?? [])
    .map((value) => value.trim())
    .filter(Boolean),
)
process.env.NO_PROXY = Array.from(loopbackNoProxy).join(',')
process.env.no_proxy = process.env.NO_PROXY

// #1897: default port is a deterministic hash of the worktree path, NOT a fixed 5173.
// Fleet machines run many agents in parallel worktrees; a fixed port + reuseExistingServer
// means a leftover vite from ANOTHER worktree gets reused and serves stale code (false
// red/green — burned real debugging time ≥3 times). Hashing cwd keeps the port stable per
// worktree, isolates worktrees from each other, and never lands on 5173 (permanently
// squatted by the spexcode dashboard's vite on fleet machines). GUGU_E2E_PORT still wins
// when set explicitly; CI's single checkout is unaffected either way.
function defaultPort(): number {
  let hash = 0
  for (const ch of process.cwd()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return 5273 + (hash % 700)
}
// `||` (not `??`): an exported-but-empty GUGU_E2E_PORT must fall back too — Number('') is 0.
const PORT = Number(process.env.GUGU_E2E_PORT || defaultPort())
const BASE_URL = process.env.GUGU_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`

// Version stamp on every report — which build was actually tested. Read from the running
// package.json + commit, never a hand-typed label (owner requirement: reports must tag the
// real version/tier/commit). Surfaces in the HTML report's metadata panel.
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync('package.json', 'utf8')).version as string } catch { return 'unknown' }
})()
const COMMIT = (() => {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch { return 'unknown' }
})()
const TIER = process.env.GUGU_TIER || 'production'

// #6270:只剩 PR CI 真跑的 ci-local 一个 project(e2e/ci/local 三条);其余 project 与它们的 spec 已删。
// CI 仍会导出 GUGU_E2E_CI_PROJECT=local,未设时同样按 local 走。
const CI_WEB_PROJECT = process.env.GUGU_E2E_CI_PROJECT
const LOCAL_FIXTURE_PORT = PORT + 1

/**
 * #4672 —— 端口起不来时,把**占用者是谁**直接打进日志,别让下一个人上机去查。
 *
 * 这个红的样子有欺骗性:失败发生在 webServer 起不来的阶段,Playwright 只说
 * `http://127.0.0.1:<port> is already used`,而聚合 job 会跟着一起红 ⇒ 看起来像两个独立故障。
 * 真正要知道的那一句(「谁占着」)只有上机 `lsof` 才有。
 *
 * ⚠️ 这是**诊断**,与治根正交:根因是两个咕咕分配器的值域重叠(见
 * `tests/unit/scripts/ciPortSpacePartition.test.ts`)。但 lima 的 catch-all 转发意味着
 * **任何**容器都能占任何宿主端口,所以"占用者未知"这件事本身还得有人管。
 *
 * ⚠️ 「lsof 没输出」与「lsof 不存在」必须分开报 —— 前者是阴性读数,后者是仪器缺席,
 *    把后者当成前者就是这一晚反复出现的那个错。`execSync` 两种情况都抛,靠 `status`/`code` 分辨。
 */
function reportPortOccupants(): void {
  // 复用既有 server 是正常路径(本机开发),端口被占不是错 ⇒ 不报。
  if (!process.env.CI) return
  const ports = [PORT, LOCAL_FIXTURE_PORT]
  for (const port of ports) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (out) {
        console.error(`[e2e-port] 127.0.0.1:${port} 已被占用 —— 占用者:\n${out}`)
      }
    } catch (error) {
      const status = (error as { status?: number }).status
      const code = (error as { code?: string }).code
      if (status === 1) continue // lsof 正常退出且无匹配 ⇒ 端口空闲,这是真阴性读数
      console.error(
        `[e2e-port] 无法判定 127.0.0.1:${port} 的占用者:lsof ${code ?? `exit ${status}`} `
        + '⇒ 这是**仪器缺席**,不是「端口空闲」。',
      )
    }
  }
}

if (CI_WEB_PROJECT !== undefined && CI_WEB_PROJECT !== 'local') {
  throw new Error(`[playwright.config] unknown GUGU_E2E_CI_PROJECT=${CI_WEB_PROJECT}`)
}
process.env.CLOCK_SKEW_AUTH_PORT = String(LOCAL_FIXTURE_PORT)

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.GUGU_E2E_OUTPUT_DIR ?? 'test-results',
  // Stamped onto the HTML report so every run records the build under test.
  metadata: { appVersion: APP_VERSION, tier: TIER, commit: COMMIT },
  timeout: 90_000,
  // Remote self-hosted Supabase auth can be slow on cold start; give observable
  // assertions room and allow one retry to absorb network/cold-start flake.
  expect: { timeout: 30_000 },
  fullyParallel: true,
  retries: 1,
  reporter: [
    ['./scripts/playwright-deadline-reporter.mjs'],
    ['./scripts/playwright-collection-guard.mjs'],
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Always record video so multi-actor flows can be reviewed.
    video: 'on',
    launchOptions: { args: ['--no-sandbox'] }
  },
  // Auto-start the web renderer (against the local auth fixture) so the run is self-contained;
  // reuse an already-running dev server locally, always fresh in CI.
  webServer: (reportPortOccupants(), {
    command: `GUGU_TASK_HOST=0 GUGU_TARGET=web VITE_SUPABASE_URL=http://127.0.0.1:${LOCAL_FIXTURE_PORT} VITE_SUPABASE_ANON_KEY=local-fixture-anon pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // #1231: the agent 对外分享 pane only renders the share link + 「开启对外分享」 button when a
    // public web base is configured (VITE_GUGU_WEB_URL); point it at the test server so the
    // share link resolves to /join/agent/<id> on this same renderer (visited cross-context).
    env: { ...process.env, VITE_GUGU_WEB_URL: BASE_URL },
  }),
  projects: [{
    name: 'ci-local',
    testMatch: /ci\/local\/.*\.spec\.ts/,
    use: { ...devices['Desktop Chrome'], locale: 'zh-CN', video: 'retain-on-failure' },
  }],
})
