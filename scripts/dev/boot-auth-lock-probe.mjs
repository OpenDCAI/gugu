import { _electron as electron } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const repo = process.env.PROBE_APP_ROOT
if (!repo) throw new Error('PROBE_APP_ROOT is required')
const supabaseUrl = process.env.VITE_SUPABASE_URL
const anonKey = process.env.VITE_SUPABASE_ANON_KEY
if (!supabaseUrl || !anonKey) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required')
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

// @@@electron-bin-resolve (#4394) — 原来把 `node_modules/.pnpm/electron@28.3.3/...` 整条路径写死,
// 一升 electron 这个探针就找不到二进制而失败,且失败信息完全不指向版本。改由 electron 包自报路径
// (它的 index.js 导出的就是二进制绝对路径),与版本和 pnpm 布局都解耦。
const electronBin = createRequire(join(repo, 'package.json'))('electron')
const mainPath = join(repo, 'apps/desktop/dist-electron/main.js')
const viteUrl = process.env.VITE_DEV_SERVER_URL || null
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function makeSession() {
  const email = `lock-probe-${randomUUID()}@nextmind.space`
  const password = 'GuguLockProbe-fixture-pw'
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const signedUp = await client.auth.signUp({ email, password, options: { data: { nickname: 'Lock Probe' } } })
  if (signedUp.error || !signedUp.data.session) {
    throw new Error(`probe signUp failed: ${signedUp.error?.message ?? 'no session'}`)
  }
  return signedUp.data.session
}

async function launchCase(name, session) {
  const root = join('/tmp', `gugu-2700-${name}-${process.pid}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const app = await electron.launch({
    executablePath: electronBin,
    args: [mainPath, '--no-sandbox', '--disable-dev-shm-usage', '--disable-backgrounding-occluded-windows'],
    env: {
      ...process.env,
      ...(viteUrl ? { VITE_DEV_SERVER_URL: viteUrl } : {}),
      GUGU_USER_DATA_DIR: root,
      GUGU_HOME: join(root, 'gugu-home'),
      GUGU_NO_SANDBOX: '1',
      GUGU_SUPABASE_URL: supabaseUrl,
      GUGU_SUPABASE_ANON_KEY: anonKey,
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_ANON_KEY: anonKey,
    },
    // 起 Electron、等第一个窗口都是事实,不计时(#4357)。
    timeout: 0,
  })
  const page = await app.firstWindow({ timeout: 0 })
  const lockDebug = []
  page.on('console', (message) => {
    const text = message.text()
    if (text.includes('GoTrueClient@sb-main') || text.includes('processLock')) lockDebug.push(text)
  })
  await page.addInitScript(({ hangRefresh, hangUser, hangUserMs }) => {
    window.localStorage.setItem('supabase.gotrue-js.locks.debug', 'true')
    const events = []
    const original = window.fetch.bind(window)
    window.__bootAuthProbe = events
    window.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : input?.url ?? String(input)
      let url
      try { url = new URL(raw) } catch { url = null }
      const started = performance.now()
      const entry = { phase: 'start', path: url?.pathname ?? raw, hasSignal: Boolean(init?.signal), aborted: Boolean(init?.signal?.aborted) }
      events.push(entry)
      if ((hangRefresh && entry.path === '/auth/v1/token') || (hangUser && entry.path === '/auth/v1/user')) {
        if (!hangUserMs || entry.path !== '/auth/v1/user') return new Promise(() => {})
        return new Promise((resolve) => setTimeout(resolve, hangUserMs))
          .then(() => original(input, init))
          .then((response) => {
            events.push({ phase: 'settled', path: entry.path, status: response.status, ms: Math.round(performance.now() - started) })
            return response
          }, (error) => {
            events.push({ phase: 'rejected', path: entry.path, name: error?.name ?? String(error), ms: Math.round(performance.now() - started) })
            throw error
          })
      }
      return original(input, init).then((response) => {
        events.push({ phase: 'settled', path: entry.path, status: response.status, ms: Math.round(performance.now() - started) })
        return response
      }, (error) => {
        events.push({ phase: 'rejected', path: entry.path, name: error?.name ?? String(error), ms: Math.round(performance.now() - started) })
        throw error
      })
    }
  }, {
    hangRefresh: process.env.PROBE_HANG_REFRESH === '1' && name === 'expired',
    hangUser: process.env.PROBE_HANG_USER === '1' && name === 'expired',
    hangUserMs: Number(process.env.PROBE_HANG_USER_MS ?? 0),
  })
  await page.waitForTimeout(1_000)
  if (session) {
    await page.evaluate((value) => localStorage.setItem('sb-main', value), JSON.stringify(session))
    await page.reload({ waitUntil: 'domcontentloaded' })
    if (name === 'expired') {
      await page.evaluate(() => {
        void window.electronAPI?.invoke('device:get-self-snapshot').catch(() => undefined)
      }).catch(() => {})
    }
  }
  await wait(Number(process.env.PROBE_WAIT_MS ?? 10_000))
  const observation = await page.evaluate(() => {
    const body = document.body
    const authPage = Boolean(body.querySelector('.gugu-auth-page'))
    const onboardingStart = [...body.querySelectorAll('button')].some((button) => button.textContent?.trim() === '开始')
    let persistedSession = null
    try {
      const raw = localStorage.getItem('sb-main')
      const parsed = raw ? JSON.parse(raw) : null
      persistedSession = {
        present: Boolean(parsed),
        hasAccessToken: Boolean(parsed?.access_token),
        hasRefreshToken: Boolean(parsed?.refresh_token),
      }
    } catch {
      persistedSession = { present: false, hasAccessToken: false, hasRefreshToken: false }
    }
    return {
      events: window.__bootAuthProbe ?? [],
      ui: {
        loginPage: authPage,
        authenticatedSurface: !authPage,
        onboardingStart,
      },
      persistedSession,
    }
  })
  const events = observation.events
  const screenshot = join(root, `${name}.png`)
  await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {})
  let log = ''
  const logPath = join(root, 'logs/gugu-main.log')
  if (existsSync(logPath)) log = await readFile(logPath, 'utf8')
  const summary = {
    name,
    root,
    screenshot,
    ui: observation.ui,
    persistedSession: observation.persistedSession,
    lockTimeouts: (log.match(/Acquiring process lock with name .*lock:sb-main.* timed out/g) ?? []).length,
    authTokenRequests: events.filter((event) => event.path === '/auth/v1/token'),
    authUserRequests: events.filter((event) => event.path === '/auth/v1/user'),
    lockDebug,
    recentLog: log.split('\n').filter((line) => /lock:sb-main|auth:cmd\/getSessionOwner|human-auth-session|hydrateSession|boot OK|re-registered/.test(line)).slice(-40),
  }
  await app.close().catch(() => {})
  return summary
}

const session = await makeSession()
const expired = { ...session, expires_at: 1, expires_in: 0 }
const revoked = { ...expired, refresh_token: randomUUID() }
const valid = { ...session, expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600 }
const results = [
  await launchCase('none', null),
  await launchCase('expired', expired),
  await launchCase('revoked', revoked),
  await launchCase('valid', valid),
]
if (serviceRoleKey) {
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  await admin.auth.admin.deleteUser(session.user.id)
}
console.log(JSON.stringify(results, null, 2))
